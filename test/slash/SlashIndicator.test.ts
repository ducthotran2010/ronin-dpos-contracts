import { BigNumber, BytesLike } from 'ethers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import {
  MockRoninValidatorSetOverridePrecompile__factory,
  MockSlashIndicatorExtended,
  MockSlashIndicatorExtended__factory,
  RoninGovernanceAdmin,
  RoninGovernanceAdmin__factory,
  RoninValidatorSet,
  Staking,
  Staking__factory,
} from '../../src/types';
import { SlashType } from '../../src/script/slash-indicator';
import { initTest } from '../helpers/fixture';
import { EpochController } from '../helpers/ronin-validator-set';
import { IndicatorController } from '../helpers/slash';
import { GovernanceAdminInterface } from '../../src/script/governance-admin-interface';

let slashContract: MockSlashIndicatorExtended;
let mockSlashLogic: MockSlashIndicatorExtended;
let stakingContract: Staking;
let governanceAdmin: RoninGovernanceAdmin;
let governanceAdminInterface: GovernanceAdminInterface;

let coinbase: SignerWithAddress;
let deployer: SignerWithAddress;
let governor: SignerWithAddress;
let validatorContract: RoninValidatorSet;
let vagabond: SignerWithAddress;
let validatorCandidates: SignerWithAddress[];
let localIndicators: IndicatorController;
let localEpochController: EpochController;

const unavailabilityTier1Threshold = 5;
const unavailabilityTier2Threshold = 10;
const maxValidatorNumber = 21;
const maxValidatorCandidate = 50;
const numberOfBlocksInEpoch = 600;
const minValidatorStakingAmount = BigNumber.from(100);

const slashAmountForUnavailabilityTier2Threshold = BigNumber.from(2);
const slashDoubleSignAmount = BigNumber.from(5);

const minOffsetToStartSchedule = 200;

const validateIndicatorAt = async (idx: number) => {
  expect(await slashContract.currentUnavailabilityIndicator(validatorCandidates[idx].address)).to.eq(
    localIndicators.getAt(idx)
  );
};

describe('Slash indicator test', () => {
  before(async () => {
    [deployer, coinbase, governor, vagabond, ...validatorCandidates] = await ethers.getSigners();

    const { slashContractAddress, stakingContractAddress, validatorContractAddress, roninGovernanceAdminAddress } =
      await initTest('SlashIndicator')({
        slashIndicatorArguments: {
          unavailabilitySlashing: {
            unavailabilityTier1Threshold,
            unavailabilityTier2Threshold,
            slashAmountForUnavailabilityTier2Threshold,
          },
          doubleSignSlashing: {
            slashDoubleSignAmount,
          },
        },
        stakingArguments: {
          minValidatorStakingAmount,
        },
        roninValidatorSetArguments: {
          maxValidatorNumber,
          numberOfBlocksInEpoch,
          maxValidatorCandidate,
        },
        maintenanceArguments: {
          minOffsetToStartSchedule,
        },
        roninTrustedOrganizationArguments: {
          trustedOrganizations: [governor].map((v) => ({
            consensusAddr: v.address,
            governor: v.address,
            bridgeVoter: v.address,
            weight: 100,
            addedBlock: 0,
          })),
        },
      });

    stakingContract = Staking__factory.connect(stakingContractAddress, deployer);
    validatorContract = MockRoninValidatorSetOverridePrecompile__factory.connect(validatorContractAddress, deployer);
    slashContract = MockSlashIndicatorExtended__factory.connect(slashContractAddress, deployer);
    governanceAdmin = RoninGovernanceAdmin__factory.connect(roninGovernanceAdminAddress, deployer);
    governanceAdminInterface = new GovernanceAdminInterface(governanceAdmin, governor);

    const mockValidatorLogic = await new MockRoninValidatorSetOverridePrecompile__factory(deployer).deploy();
    await mockValidatorLogic.deployed();
    await governanceAdminInterface.upgrade(validatorContract.address, mockValidatorLogic.address);

    mockSlashLogic = await new MockSlashIndicatorExtended__factory(deployer).deploy();
    await mockSlashLogic.deployed();
    await governanceAdminInterface.upgrade(slashContractAddress, mockSlashLogic.address);

    validatorCandidates = validatorCandidates.slice(0, maxValidatorNumber);
    for (let i = 0; i < maxValidatorNumber; i++) {
      await stakingContract
        .connect(validatorCandidates[i])
        .applyValidatorCandidate(
          validatorCandidates[i].address,
          validatorCandidates[i].address,
          validatorCandidates[i].address,
          validatorCandidates[i].address,
          1,
          { value: minValidatorStakingAmount.mul(2).add(maxValidatorNumber).sub(i) }
        );
    }

    await network.provider.send('hardhat_setCoinbase', [coinbase.address]);

    localEpochController = new EpochController(minOffsetToStartSchedule, numberOfBlocksInEpoch);
    await localEpochController.mineToBeforeEndOfEpoch();
    await validatorContract.connect(coinbase).wrapUpEpoch();
    expect(await validatorContract.getValidators()).eql(validatorCandidates.map((_) => _.address));

    localIndicators = new IndicatorController(validatorCandidates.length);
  });

  after(async () => {
    await network.provider.send('hardhat_setCoinbase', [ethers.constants.AddressZero]);
  });

  describe('Single flow test', async () => {
    describe('Unauthorized test', async () => {
      it('Should non-coinbase cannot call slash', async () => {
        await expect(
          slashContract.connect(vagabond).slashUnavailability(validatorCandidates[0].address)
        ).to.revertedWith('SlashUnavailability: method caller must be coinbase');
      });
    });

    describe('Slash method: recording', async () => {
      it('Should slash a validator successfully', async () => {
        const slasherIdx = 0;
        const slasheeIdx = 1;

        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        let tx = await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasheeIdx].address);
        await expect(tx).to.not.emit(slashContract, 'Slashed');
        localIndicators.setAt(slasheeIdx, 1);
        await validateIndicatorAt(slasheeIdx);
      });

      it('Should validator not be able to slash themselves', async () => {
        const slasherIdx = 0;
        await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasherIdx].address);

        localIndicators.resetAt(slasherIdx);
        await validateIndicatorAt(slasherIdx);
      });

      it('Should not able to slash twice in one block', async () => {
        const slasherIdx = 0;
        const slasheeIdx = 2;
        await network.provider.send('evm_setAutomine', [false]);
        await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasheeIdx].address);
        let tx = slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasheeIdx].address);
        await expect(tx).to.be.revertedWith(
          'SlashIndicator: cannot slash a validator twice or slash more than one validator in one block'
        );
        await network.provider.send('evm_mine');
        await network.provider.send('evm_setAutomine', [true]);

        localIndicators.increaseAt(slasheeIdx);
        await validateIndicatorAt(slasheeIdx);
      });

      it('Should not able to slash more than one validator in one block', async () => {
        const slasherIdx = 0;
        const slasheeIdx1 = 1;
        const slasheeIdx2 = 2;
        await network.provider.send('evm_setAutomine', [false]);
        await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasheeIdx1].address);
        let tx = slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasheeIdx2].address);
        await expect(tx).to.be.revertedWith(
          'SlashIndicator: cannot slash a validator twice or slash more than one validator in one block'
        );
        await network.provider.send('evm_mine');
        await network.provider.send('evm_setAutomine', [true]);

        localIndicators.increaseAt(slasheeIdx1);
        await validateIndicatorAt(slasheeIdx1);
        localIndicators.setAt(slasheeIdx2, 1);
        await validateIndicatorAt(slasheeIdx1);
      });
    });

    describe('Slash method: recording and call to validator set', async () => {
      it('Should sync with validator set for misdemeanor (slash tier-1)', async () => {
        let tx;
        const slasherIdx = 1;
        const slasheeIdx = 3;
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        for (let i = 0; i < unavailabilityTier1Threshold; i++) {
          tx = await slashContract
            .connect(validatorCandidates[slasherIdx])
            .slashUnavailability(validatorCandidates[slasheeIdx].address);
        }

        let period = await validatorContract.currentPeriod();
        await expect(tx)
          .to.emit(slashContract, 'Slashed')
          .withArgs(validatorCandidates[slasheeIdx].address, SlashType.UNAVAILABILITY_TIER_1, period);
        localIndicators.setAt(slasheeIdx, unavailabilityTier1Threshold);
        await validateIndicatorAt(slasheeIdx);
      });

      it('Should not sync with validator set when the indicator counter is in between misdemeanor (tier-1) and felony (tier-2) thresholds', async () => {
        let tx;
        const slasherIdx = 1;
        const slasheeIdx = 3;
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        tx = await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasheeIdx].address);
        localIndicators.increaseAt(slasheeIdx);
        await validateIndicatorAt(slasheeIdx);

        await expect(tx).not.to.emit(slashContract, 'Slashed');
      });

      it('Should sync with validator set for felony (slash tier-2)', async () => {
        let tx;
        const slasherIdx = 0;
        const slasheeIdx = 4;

        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        let period = await validatorContract.currentPeriod();

        for (let i = 0; i < unavailabilityTier2Threshold; i++) {
          tx = await slashContract
            .connect(validatorCandidates[slasherIdx])
            .slashUnavailability(validatorCandidates[slasheeIdx].address);

          if (i == unavailabilityTier1Threshold - 1) {
            await expect(tx)
              .to.emit(slashContract, 'Slashed')
              .withArgs(validatorCandidates[slasheeIdx].address, SlashType.UNAVAILABILITY_TIER_1, period);
          }
        }

        await expect(tx)
          .to.emit(slashContract, 'Slashed')
          .withArgs(validatorCandidates[slasheeIdx].address, SlashType.UNAVAILABILITY_TIER_2, period);
        localIndicators.setAt(slasheeIdx, unavailabilityTier2Threshold);
        await validateIndicatorAt(slasheeIdx);
      });

      it('Should not sync with validator set when the indicator counter exceeds felony threshold (tier-2) ', async () => {
        let tx;
        const slasherIdx = 1;
        const slasheeIdx = 4;
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        tx = await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashUnavailability(validatorCandidates[slasheeIdx].address);
        localIndicators.increaseAt(slasheeIdx);
        await validateIndicatorAt(slasheeIdx);

        await expect(tx).not.to.emit(slashContract, 'Slashed');
      });
    });

    describe('Resetting counter', async () => {
      it('Should the counter reset for one validator when the period ended', async () => {
        const slasherIdx = 0;
        const slasheeIdx = 5;
        let numberOfSlashing = unavailabilityTier2Threshold - 1;
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        for (let i = 0; i < numberOfSlashing; i++) {
          await slashContract
            .connect(validatorCandidates[slasherIdx])
            .slashUnavailability(validatorCandidates[slasheeIdx].address);
        }

        localIndicators.setAt(slasheeIdx, numberOfSlashing);
        await validateIndicatorAt(slasheeIdx);

        await EpochController.setTimestampToPeriodEnding();
        await localEpochController.mineToBeforeEndOfEpoch();
        await validatorContract.connect(validatorCandidates[slasherIdx]).wrapUpEpoch();

        localIndicators.resetAt(slasheeIdx);
        await validateIndicatorAt(slasheeIdx);
      });

      it('Should the counter reset for multiple validators when the period ended', async () => {
        const slasherIdx = 0;
        const slasheeIdxs = [6, 7, 8, 9, 10];
        let numberOfSlashing = unavailabilityTier2Threshold - 1;
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        for (let i = 0; i < numberOfSlashing; i++) {
          for (let j = 0; j < slasheeIdxs.length; j++) {
            await slashContract
              .connect(validatorCandidates[slasherIdx])
              .slashUnavailability(validatorCandidates[slasheeIdxs[j]].address);
          }
        }

        for (let j = 0; j < slasheeIdxs.length; j++) {
          localIndicators.setAt(slasheeIdxs[j], numberOfSlashing);
          await validateIndicatorAt(slasheeIdxs[j]);
        }

        await EpochController.setTimestampToPeriodEnding();
        await localEpochController.mineToBeforeEndOfEpoch();
        await validatorContract.connect(validatorCandidates[slasherIdx]).wrapUpEpoch();

        for (let j = 0; j < slasheeIdxs.length; j++) {
          localIndicators.resetAt(slasheeIdxs[j]);
          await validateIndicatorAt(slasheeIdxs[j]);
        }
      });
    });

    describe('Double signing slash', async () => {
      let header1: BytesLike;
      let header2: BytesLike;

      it('Should not be able to slash themselves', async () => {
        const slasherIdx = 0;
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[slasherIdx].address]);

        header1 = ethers.utils.toUtf8Bytes('sampleHeader1');
        header2 = ethers.utils.toUtf8Bytes('sampleHeader2');

        let tx = await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashDoubleSign(validatorCandidates[slasherIdx].address, header1, header2);

        await expect(tx).to.not.emit(slashContract, 'Slashed');
      });

      it('Should be able to slash validator with double signing', async () => {
        const slasherIdx = 0;
        const slasheeIdx = 1;

        header1 = ethers.utils.toUtf8Bytes('sampleHeader1');
        header2 = ethers.utils.toUtf8Bytes('sampleHeader2');

        let tx = await slashContract
          .connect(validatorCandidates[slasherIdx])
          .slashDoubleSign(validatorCandidates[slasheeIdx].address, header1, header2);

        let period = await validatorContract.currentPeriod();

        await expect(tx)
          .to.emit(slashContract, 'Slashed')
          .withArgs(validatorCandidates[slasheeIdx].address, SlashType.DOUBLE_SIGNING, period);
      });
    });
  });
});
