import { BigNumber, BytesLike, ContractTransaction, Transaction } from 'ethers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

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
import { initTest } from '../helpers/fixture';
import { EpochController, expects as RoninValidatorSetExpects } from '../helpers/ronin-validator-set';
import { IndicatorController, ScoreController } from '../helpers/slash';
import { GovernanceAdminInterface } from '../../src/script/governance-admin-interface';
import { SlashType } from '../../src/script/slash-indicator';
import { BlockRewardDeprecatedType } from '../../src/script/ronin-validator-set';

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
let candidateAdmins: SignerWithAddress[];
let validatorCandidates: SignerWithAddress[];

let localIndicatorController: IndicatorController;
let localScoreController: ScoreController;
let localEpochController: EpochController;

const gainCreditScore = 50;
const maxCreditScore = 600;
const bailOutCostMultiplier = 5;

const unavailabilityTier1Threshold = 5;
const unavailabilityTier2Threshold = 15;
const slashAmountForUnavailabilityTier2Threshold = 2;

const minValidatorStakingAmount = BigNumber.from(100);
const maxValidatorCandidate = 3;
const maxValidatorNumber = 2;
const numberOfBlocksInEpoch = 600;
const minOffsetToStartSchedule = 200;

const blockProducerBonusPerBlock = BigNumber.from(5000);
const submittedRewardEachBlock = BigNumber.from(60);

const wrapUpEpoch = async () => {
  await localEpochController.mineToBeforeEndOfEpoch();
  await network.provider.send('hardhat_setCoinbase', [coinbase.address]);
  await validatorContract.connect(coinbase).wrapUpEpoch();
};

const endPeriodAndWrapUpAndResetIndicators = async (includingEpochsNum?: number) => {
  if (includingEpochsNum) {
    expect(includingEpochsNum).gt(0);
  }

  await localEpochController.mineToBeforeEndOfEpoch(includingEpochsNum);
  await EpochController.setTimestampToPeriodEnding();
  let wrapUpTx = await wrapUpEpoch();

  validatorCandidates.map((_, i) => localIndicatorController.resetAt(i));

  return wrapUpTx;
};

const slashUntilValidatorTier = async (slasherIdx: number, slasheeIdx: number, tier: number) => {
  if (tier != 1 && tier != 2) {
    return;
  }

  let _threshold = tier == 1 ? unavailabilityTier1Threshold : unavailabilityTier2Threshold;
  let _slashType = tier == 1 ? SlashType.UNAVAILABILITY_TIER_1 : SlashType.UNAVAILABILITY_TIER_2;

  let tx;
  let slasher = validatorCandidates[slasherIdx];
  let slashee = validatorCandidates[slasheeIdx];

  await network.provider.send('hardhat_setCoinbase', [slasher.address]);

  let _toSlashTimes = _threshold - localIndicatorController.getAt(slasheeIdx);

  for (let i = 0; i < _toSlashTimes; i++) {
    tx = await slashContract.connect(slasher).slashUnavailability(slashee.address);
  }

  let period = await validatorContract.currentPeriod();
  await expect(tx).to.emit(slashContract, 'Slashed').withArgs(slashee.address, _slashType, period);
  localIndicatorController.setAt(slasheeIdx, _threshold);
};

const validateScoreAt = async (idx: number) => {
  expect(await slashContract.getCreditScore(validatorCandidates[idx].address)).to.eq(localScoreController.getAt(idx));
};

const validateIndicatorAt = async (idx: number) => {
  expect(await slashContract.currentUnavailabilityIndicator(validatorCandidates[idx].address)).to.eq(
    localIndicatorController.getAt(idx)
  );
};

describe('Credit score and bail out test', () => {
  before(async () => {
    [deployer, coinbase, governor, vagabond, ...validatorCandidates] = await ethers.getSigners();

    candidateAdmins = validatorCandidates.slice(0, maxValidatorCandidate);
    validatorCandidates = validatorCandidates.slice(maxValidatorCandidate, maxValidatorCandidate * 2);

    const { slashContractAddress, stakingContractAddress, validatorContractAddress, roninGovernanceAdminAddress } =
      await initTest('CreditScore')({
        slashIndicatorArguments: {
          unavailabilitySlashing: {
            unavailabilityTier1Threshold,
            unavailabilityTier2Threshold,
            slashAmountForUnavailabilityTier2Threshold,
          },
          creditScore: {
            gainCreditScore,
            maxCreditScore,
            bailOutCostMultiplier,
          },
        },
        stakingArguments: {
          minValidatorStakingAmount,
        },
        stakingVestingArguments: {
          blockProducerBonusPerBlock,
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

    for (let i = 0; i < maxValidatorNumber; i++) {
      await stakingContract
        .connect(validatorCandidates[i])
        .applyValidatorCandidate(
          candidateAdmins[i].address,
          validatorCandidates[i].address,
          validatorCandidates[i].address,
          validatorCandidates[i].address,
          100_00,
          { value: minValidatorStakingAmount.mul(2).sub(i) }
        );
    }

    await network.provider.send('hardhat_setCoinbase', [coinbase.address]);

    localEpochController = new EpochController(minOffsetToStartSchedule, numberOfBlocksInEpoch);
    await localEpochController.mineToBeforeEndOfEpoch();
    await validatorContract.connect(coinbase).wrapUpEpoch();
    expect(await validatorContract.getValidators()).eql(
      validatorCandidates.slice(0, maxValidatorNumber).map((_) => _.address)
    );
    expect(await validatorContract.getBlockProducers()).eql(
      validatorCandidates.slice(0, maxValidatorNumber).map((_) => _.address)
    );

    localIndicatorController = new IndicatorController(validatorCandidates.length);
    localScoreController = new ScoreController(validatorCandidates.length);
  });

  describe('Counting credit score after each period', async () => {
    it('Should the score updated correctly, case: max score (N), in jail (N), unavailability (N)', async () => {
      await endPeriodAndWrapUpAndResetIndicators();
      localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore);
      await validateScoreAt(0);
    });
    it('Should the score updated correctly, case: max score (N), in jail (N), unavailability (y)', async () => {
      await network.provider.send('hardhat_setCoinbase', [validatorCandidates[1].address]);
      await slashContract.connect(validatorCandidates[1]).slashUnavailability(validatorCandidates[0].address);
      localIndicatorController.increaseAt(1);
      await endPeriodAndWrapUpAndResetIndicators();
      localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore - 1);
      await validateScoreAt(0);
    });
    it('Should the score updated correctly, case: max score (N), in jail (y), unavailability (N)', async () => {
      await slashUntilValidatorTier(1, 0, 2);
      await wrapUpEpoch();
      await endPeriodAndWrapUpAndResetIndicators();
      localScoreController.increaseAtWithUpperbound(0, maxCreditScore, 0);
      await validateScoreAt(0);

      let _jailLeft = await validatorContract.jailedTimeLeft(validatorCandidates[0].address);
      await network.provider.send('hardhat_mine', [_jailLeft.blockLeft_.toHexString(), '0x0']);
    });
    it('Should the score updated correctly, case: max score (y), in jail (N), unavailability (N)', async () => {
      for (let i = 0; i < maxCreditScore / gainCreditScore + 1; i++) {
        await endPeriodAndWrapUpAndResetIndicators();
        localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore);
        await validateScoreAt(0);
      }
    });
  });

  describe('Bail out test', async () => {
    describe('Sanity check', async () => {
      it('Should the non admin candidate cannot call the bail out function', async () => {
        await expect(
          slashContract.connect(validatorCandidates[0]).bailOut(validatorCandidates[0].address)
        ).revertedWith('SlashIndicator: method caller must be a candidate admin');
      });
      it('Should not be able to call the bail out function with param of non-candidate consensus address ', async () => {
        await expect(slashContract.connect(candidateAdmins[0]).bailOut(validatorCandidates[2].address)).revertedWith(
          'SlashIndicator: consensus address must be a validator candidate'
        );
      });
    });

    describe('Bailing out from a validator but non-block-producer', async () => {
      before(async () => {
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[0].address]);

        let submitRewardTx = await validatorContract
          .connect(validatorCandidates[0])
          .submitBlockReward({ value: submittedRewardEachBlock });
        await RoninValidatorSetExpects.emitBlockRewardSubmittedEvent(
          submitRewardTx,
          validatorCandidates[0].address,
          submittedRewardEachBlock,
          blockProducerBonusPerBlock
        );

        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);

        await network.provider.send('hardhat_setCoinbase', [coinbase.address]);

        await slashUntilValidatorTier(1, 0, 2);
        let wrapUpTx = await wrapUpEpoch();
        expect(wrapUpTx).emit(validatorContract, 'WrappedUpEpoch').withArgs([anyValue, anyValue, false]);

        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(false);
      });

      let tx: ContractTransaction;

      it('Should the bailing out cost subtracted correctly', async () => {
        let _latestBlockNum = BigNumber.from(await network.provider.send('eth_blockNumber'));
        let _jailLeft = await validatorContract.jailedTimeLeftAtBlock(
          validatorCandidates[0].address,
          _latestBlockNum.add(1)
        );

        tx = await slashContract.connect(candidateAdmins[0]).bailOut(validatorCandidates[0].address);
        let _period = validatorContract.currentPeriod();

        expect(tx).emit(slashContract, 'BailedOut').withArgs([validatorCandidates[0].address, _period]);
        expect(tx).emit(validatorContract, 'ValidatorUnjailed').withArgs([validatorCandidates[0].address]);

        localScoreController.subAtNonNegative(0, bailOutCostMultiplier * _jailLeft.epochLeft_.toNumber());
        await validateScoreAt(0);
      });

      it('Should the indicator get reset', async () => {
        localIndicatorController.resetAt(0);
        await validateIndicatorAt(0);
      });

      it.skip('Should the rewards of the validator before the bailout get removed', async () => {
        /// Rewards have been removed in `slash` function
      });

      it('Should the bailed out validator becomes block producer in the next epoch', async () => {
        await wrapUpEpoch();
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
      });

      it('Should the rewards of the validator after the bailout get cut in half', async () => {
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[0].address]);

        let submitRewardTx = await validatorContract
          .connect(validatorCandidates[0])
          .submitBlockReward({ value: submittedRewardEachBlock });

        await RoninValidatorSetExpects.emitBlockRewardSubmittedEvent(
          submitRewardTx,
          validatorCandidates[0].address,
          submittedRewardEachBlock,
          blockProducerBonusPerBlock
        );

        await RoninValidatorSetExpects.emitBlockRewardDeprecatedEvent(
          submitRewardTx,
          validatorCandidates[0].address,
          submittedRewardEachBlock.add(blockProducerBonusPerBlock).div(2),
          BlockRewardDeprecatedType.AFTER_BAILOUT
        );

        await network.provider.send('hardhat_setCoinbase', [coinbase.address]);
      });

      it('Should the wrapping up period tx distribute correct reward amount', async () => {
        let tx = await endPeriodAndWrapUpAndResetIndicators();
        await localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore);

        expect(tx)
          .emit(validatorContract, 'MiningRewardDistributed')
          .withArgs(
            validatorCandidates[0].address,
            validatorCandidates[0].address,
            submittedRewardEachBlock.add(blockProducerBonusPerBlock).div(2)
          );
      });
    });

    describe('Insufficient credit score to bail out', async () => {
      before(async () => {
        await endPeriodAndWrapUpAndResetIndicators();
        localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore);
        await validateScoreAt(0);
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);

        await slashUntilValidatorTier(1, 0, 2);
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
      });

      it('Should not be able to bail out due to insufficient credit score', async () => {
        await expect(slashContract.connect(candidateAdmins[0]).bailOut(validatorCandidates[0].address)).revertedWith(
          'SlashIndicator: insufficient credit score to bail out'
        );
      });

      it('Should the slashed validator become block producer when jailed time over', async () => {
        let _jailEpochLeft = (await validatorContract.jailedTimeLeft(validatorCandidates[0].address)).epochLeft_;
        await endPeriodAndWrapUpAndResetIndicators(_jailEpochLeft.toNumber());
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
      });
    });

    describe('Bailing out from a to-be-in-jail validator', async () => {
      before(async () => {
        for (let i = 0; i < maxCreditScore / gainCreditScore + 1; i++) {
          await endPeriodAndWrapUpAndResetIndicators();
          await localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore);
        }

        expect(await validatorContract.isValidator(validatorCandidates[0].address)).eq(true);
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
        await slashUntilValidatorTier(1, 0, 2);
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
      });

      it('Should the bailing out cost subtracted correctly', async () => {
        let _jailLeft = await validatorContract.jailedTimeLeft(validatorCandidates[0].address);
        let tx = await slashContract.connect(candidateAdmins[0]).bailOut(validatorCandidates[0].address);
        let _period = validatorContract.currentPeriod();

        expect(tx).emit(slashContract, 'BailedOut').withArgs([validatorCandidates[0].address, _period]);
        expect(tx).emit(validatorContract, 'ValidatorUnjailed').withArgs([validatorCandidates[0].address]);

        localScoreController.subAtNonNegative(0, bailOutCostMultiplier * _jailLeft.epochLeft_.toNumber());
        await validateScoreAt(0);
      });

      it('Should the indicator get reset', async () => {
        localIndicatorController.resetAt(0);
        await validateIndicatorAt(0);
      });

      it.skip('Should the rewards of the validator before the bailout get removed', async () => {
        /// Rewards have been removed in `slash` function
      });

      it('Should the rewards of the validator after the bailout get cut in half', async () => {
        await network.provider.send('hardhat_setCoinbase', [validatorCandidates[0].address]);

        let submitRewardTx = await validatorContract
          .connect(validatorCandidates[0])
          .submitBlockReward({ value: submittedRewardEachBlock });

        await RoninValidatorSetExpects.emitBlockRewardSubmittedEvent(
          submitRewardTx,
          validatorCandidates[0].address,
          submittedRewardEachBlock,
          blockProducerBonusPerBlock
        );

        await RoninValidatorSetExpects.emitBlockRewardDeprecatedEvent(
          submitRewardTx,
          validatorCandidates[0].address,
          submittedRewardEachBlock.add(blockProducerBonusPerBlock).div(2),
          BlockRewardDeprecatedType.AFTER_BAILOUT
        );

        await network.provider.send('hardhat_setCoinbase', [coinbase.address]);
      });

      it('Should the bailed out validator still is block producer in the next epoch', async () => {
        await wrapUpEpoch();
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
      });

      it('Should the wrapping up period tx distribute correct reward amount', async () => {
        let tx = await endPeriodAndWrapUpAndResetIndicators();
        await localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore);

        expect(tx)
          .emit(validatorContract, 'MiningRewardDistributed')
          .withArgs(
            validatorCandidates[0].address,
            validatorCandidates[0].address,
            submittedRewardEachBlock.add(blockProducerBonusPerBlock).div(2)
          );
      });
    });

    describe('Bailing out from a validator that has been bailed out previously', async () => {
      before(async () => {
        for (let i = 0; i < maxCreditScore / gainCreditScore + 1; i++) {
          await endPeriodAndWrapUpAndResetIndicators();
          await localScoreController.increaseAtWithUpperbound(0, maxCreditScore, gainCreditScore);
        }

        expect(await validatorContract.isValidator(validatorCandidates[0].address)).eq(true);
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
        await slashUntilValidatorTier(1, 0, 2);
        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);

        let _latestBlockNum = BigNumber.from(await network.provider.send('eth_blockNumber'));
        let _jailLeft = await validatorContract.jailedTimeLeftAtBlock(
          validatorCandidates[0].address,
          _latestBlockNum.add(1)
        );

        let _jailEpochLeft = _jailLeft.epochLeft_;
        await localEpochController.mineToBeforeEndOfEpoch(_jailEpochLeft.sub(1));
        await wrapUpEpoch();

        let tx = await slashContract.connect(candidateAdmins[0]).bailOut(validatorCandidates[0].address);
        let _period = validatorContract.currentPeriod();

        expect(tx).emit(slashContract, 'BailedOut').withArgs([validatorCandidates[0].address, _period]);
        expect(tx).emit(validatorContract, 'ValidatorUnjailed').withArgs([validatorCandidates[0].address]);

        localIndicatorController.resetAt(0);
        await validateIndicatorAt(0);

        localScoreController.subAtNonNegative(0, bailOutCostMultiplier * 1);
        await validateScoreAt(0);

        await localEpochController.mineToBeforeEndOfEpoch();
        await wrapUpEpoch();

        expect(await validatorContract.isBlockProducer(validatorCandidates[0].address)).eq(true);
      });

      it('Should the bailed-out-validator not be able to bail out second time in the same period', async () => {
        await slashUntilValidatorTier(1, 0, 2);
        await expect(slashContract.connect(candidateAdmins[0]).bailOut(validatorCandidates[0].address)).revertedWith(
          'SlashIndicator: validator has bailed out previously'
        );
      });

      it('Should the bailed-out-validator be able to bail out in the next periods', async () => {
        await endPeriodAndWrapUpAndResetIndicators();

        let _latestBlockNum = BigNumber.from(await network.provider.send('eth_blockNumber'));
        let _jailLeft = await validatorContract.jailedTimeLeftAtBlock(
          validatorCandidates[0].address,
          _latestBlockNum.add(1)
        );

        let _jailEpochLeft = _jailLeft.epochLeft_;
        let tx = await slashContract.connect(candidateAdmins[0]).bailOut(validatorCandidates[0].address);
        let _period = validatorContract.currentPeriod();

        expect(tx).emit(slashContract, 'BailedOut').withArgs([validatorCandidates[0].address, _period]);
        expect(tx).emit(validatorContract, 'ValidatorUnjailed').withArgs([validatorCandidates[0].address]);

        localScoreController.subAtNonNegative(0, bailOutCostMultiplier * _jailEpochLeft.toNumber());
        await validateScoreAt(0);
      });
    });
  });
});
