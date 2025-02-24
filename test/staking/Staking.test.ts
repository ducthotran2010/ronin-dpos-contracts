import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, BigNumberish, ContractTransaction } from 'ethers';
import { ethers, network } from 'hardhat';

import { Staking, Staking__factory, TransparentUpgradeableProxyV2__factory } from '../../src/types';
import { MockValidatorSet__factory } from '../../src/types/factories/MockValidatorSet__factory';
import { StakingVesting__factory } from '../../src/types/factories/StakingVesting__factory';
import { MockValidatorSet } from '../../src/types/MockValidatorSet';

let poolAddr: SignerWithAddress;
let otherPoolAddr: SignerWithAddress;
let deployer: SignerWithAddress;
let proxyAdmin: SignerWithAddress;
let userA: SignerWithAddress;
let userB: SignerWithAddress;
let validatorContract: MockValidatorSet;
let stakingContract: Staking;
let validatorCandidates: SignerWithAddress[];

const minValidatorStakingAmount = BigNumber.from(20);
const maxValidatorCandidate = 50;
const numberOfBlocksInEpoch = 2;
const cooldownSecsToUndelegate = 3 * 86400;
const waitingSecsToRevoke = 7 * 86400;

describe('Staking test', () => {
  before(async () => {
    [deployer, proxyAdmin, userA, userB, ...validatorCandidates] = await ethers.getSigners();
    validatorCandidates = validatorCandidates.slice(0, 3);
    const stakingVestingContract = await new StakingVesting__factory(deployer).deploy();
    const nonce = await deployer.getTransactionCount();
    const stakingContractAddr = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonce + 2 });
    validatorContract = await new MockValidatorSet__factory(deployer).deploy(
      stakingContractAddr,
      ethers.constants.AddressZero,
      stakingVestingContract.address,
      maxValidatorCandidate,
      numberOfBlocksInEpoch
    );
    await validatorContract.deployed();
    const logicContract = await new Staking__factory(deployer).deploy();
    await logicContract.deployed();
    const proxyContract = await new TransparentUpgradeableProxyV2__factory(deployer).deploy(
      logicContract.address,
      proxyAdmin.address,
      logicContract.interface.encodeFunctionData('initialize', [
        validatorContract.address,
        minValidatorStakingAmount,
        cooldownSecsToUndelegate,
        waitingSecsToRevoke,
      ])
    );
    await proxyContract.deployed();
    stakingContract = Staking__factory.connect(proxyContract.address, deployer);
    expect(stakingContractAddr.toLowerCase()).eq(stakingContract.address.toLowerCase());
  });

  describe('Validator candidate test', () => {
    it('Should not be able to propose validator with insufficient amount', async () => {
      await expect(
        stakingContract.applyValidatorCandidate(userA.address, userA.address, userA.address, userA.address, 1)
      ).revertedWith('CandidateStaking: insufficient amount');
    });

    it('Should be able to propose validator with sufficient amount', async () => {
      for (let i = 1; i < validatorCandidates.length; i++) {
        const candidate = validatorCandidates[i];
        const tx = await stakingContract
          .connect(candidate)
          .applyValidatorCandidate(
            candidate.address,
            candidate.address,
            candidate.address,
            candidate.address,
            1,
            /* 0.01% */ { value: minValidatorStakingAmount.mul(2) }
          );
        await expect(tx).emit(stakingContract, 'PoolApproved').withArgs(candidate.address, candidate.address);
      }

      poolAddr = validatorCandidates[1];
      expect(await stakingContract.stakingTotal(poolAddr.address)).eq(minValidatorStakingAmount.mul(2));
    });

    it('Should not be able to propose validator again', async () => {
      await expect(
        stakingContract
          .connect(poolAddr)
          .applyValidatorCandidate(poolAddr.address, poolAddr.address, poolAddr.address, poolAddr.address, 0, {
            value: minValidatorStakingAmount,
          })
      ).revertedWith('CandidateManager: query for already existent candidate');
    });

    it('Should not be able to stake with empty value', async () => {
      await expect(stakingContract.stake(poolAddr.address, { value: 0 })).revertedWith(
        'BaseStaking: query with empty value'
      );
    });

    it('Should not be able to call stake/unstake when the method is not the pool admin', async () => {
      await expect(stakingContract.stake(poolAddr.address, { value: 1 })).revertedWith(
        'BaseStaking: requester must be the pool admin'
      );

      await expect(stakingContract.unstake(poolAddr.address, 1)).revertedWith(
        'BaseStaking: requester must be the pool admin'
      );
    });

    it('Should be able to stake as a validator candidate', async () => {
      const tx = await stakingContract.connect(poolAddr).stake(poolAddr.address, { value: 1 });
      await expect(tx!).emit(stakingContract, 'Staked').withArgs(poolAddr.address, 1);
      expect(await stakingContract.stakingTotal(poolAddr.address)).eq(minValidatorStakingAmount.mul(2).add(1));
    });

    it('Should not be able to unstake due to cooldown restriction', async () => {
      await expect(stakingContract.connect(poolAddr).unstake(poolAddr.address, 1)).revertedWith(
        'CandidateStaking: unstake too early'
      );
    });

    it('Should not be able to unstake after cooldown', async () => {
      await network.provider.send('evm_increaseTime', [cooldownSecsToUndelegate + 1]);
      const tx = await stakingContract.connect(poolAddr).unstake(poolAddr.address, 1);
      await expect(tx!).emit(stakingContract, 'Unstaked').withArgs(poolAddr.address, 1);
      expect(await stakingContract.stakingTotal(poolAddr.address)).eq(minValidatorStakingAmount.mul(2));
      expect(await stakingContract.stakingAmountOf(poolAddr.address, poolAddr.address)).eq(
        minValidatorStakingAmount.mul(2)
      );
    });

    it('[Delegator] Should be able to delegate/undelegate to a validator candidate', async () => {
      await stakingContract.delegate(poolAddr.address, { value: 10 });
      expect(await stakingContract.stakingAmountOf(poolAddr.address, deployer.address)).eq(10);
      await network.provider.send('evm_increaseTime', [cooldownSecsToUndelegate + 1]);
      await stakingContract.undelegate(poolAddr.address, 1);
      expect(await stakingContract.stakingAmountOf(poolAddr.address, deployer.address)).eq(9);
    });

    it('Should be not able to unstake with the balance left is not larger than the minimum balance threshold', async () => {
      await expect(
        stakingContract.connect(poolAddr).unstake(poolAddr.address, minValidatorStakingAmount.add(1))
      ).revertedWith('CandidateStaking: invalid staking amount left');
    });

    it('Should not be able to request renounce using unauthorized account', async () => {
      await expect(stakingContract.connect(deployer).requestRenounce(poolAddr.address)).revertedWith(
        'BaseStaking: requester must be the pool admin'
      );
    });

    it('Should be able to request renounce using pool admin', async () => {
      await stakingContract.connect(poolAddr).requestRenounce(poolAddr.address);
    });

    it('Should not be able to request renounce again', async () => {
      await expect(stakingContract.connect(poolAddr).requestRenounce(poolAddr.address)).revertedWith(
        'CandidateManager: invalid revoked timestamp'
      );
    });

    it('Should the consensus account is no longer be a candidate', async () => {
      await network.provider.send('evm_increaseTime', [waitingSecsToRevoke]);
      const stakingAmount = minValidatorStakingAmount.mul(2);
      expect(await stakingContract.getStakingPool(poolAddr.address)).eql([
        poolAddr.address,
        stakingAmount,
        stakingAmount.add(9),
      ]);

      await expect(() => validatorContract.wrapUpEpoch()).changeEtherBalance(poolAddr, stakingAmount);
      await expect(stakingContract.getStakingPool(poolAddr.address)).revertedWith(
        'BaseStaking: query for non-existent pool'
      );
    });
  });

  describe('Delegator test', () => {
    before(() => {
      otherPoolAddr = validatorCandidates[2];
    });

    it('Should be able to undelegate from a deprecated validator candidate', async () => {
      await stakingContract.undelegate(poolAddr.address, 1);
      expect(await stakingContract.stakingAmountOf(poolAddr.address, deployer.address)).eq(8);
    });

    it('Should not be able to delegate to a deprecated pool', async () => {
      await expect(stakingContract.delegate(poolAddr.address, { value: 1 })).revertedWith(
        'BaseStaking: query for non-existent pool'
      );
    });

    it('Should not be able to delegate with empty value', async () => {
      await expect(stakingContract.delegate(otherPoolAddr.address)).revertedWith('BaseStaking: query with empty value');
    });

    it('Should not be able to delegate/undelegate when the method caller is the pool admin', async () => {
      await expect(stakingContract.connect(otherPoolAddr).delegate(otherPoolAddr.address, { value: 1 })).revertedWith(
        'BaseStaking: delegator must not be the pool admin'
      );
      await expect(stakingContract.connect(otherPoolAddr).undelegate(otherPoolAddr.address, 1)).revertedWith(
        'BaseStaking: delegator must not be the pool admin'
      );
    });

    it('Should multiple accounts be able to delegate to one pool', async () => {
      let tx: ContractTransaction;
      tx = await stakingContract.connect(userA).delegate(otherPoolAddr.address, { value: 1 });
      await expect(tx!).emit(stakingContract, 'Delegated').withArgs(userA.address, otherPoolAddr.address, 1);

      tx = await stakingContract.connect(userB).delegate(otherPoolAddr.address, { value: 1 });
      await expect(tx!).emit(stakingContract, 'Delegated').withArgs(userB.address, otherPoolAddr.address, 1);

      expect(await stakingContract.stakingTotal(otherPoolAddr.address)).eq(minValidatorStakingAmount.mul(2).add(2));
    });

    it('Should not be able to undelegate due to cooldown restriction', async () => {
      await expect(stakingContract.connect(userA).undelegate(otherPoolAddr.address, 1)).revertedWith(
        'DelegatorStaking: undelegate too early'
      );
    });

    it('Should be able to undelegate after cooldown', async () => {
      await network.provider.send('evm_increaseTime', [cooldownSecsToUndelegate + 1]);
      const tx = await stakingContract.connect(userA).undelegate(otherPoolAddr.address, 1);
      await expect(tx!).emit(stakingContract, 'Undelegated').withArgs(userA.address, otherPoolAddr.address, 1);
      expect(await stakingContract.stakingTotal(otherPoolAddr.address)).eq(minValidatorStakingAmount.mul(2).add(1));
    });

    it('Should not be able to undelegate with empty amount', async () => {
      await expect(stakingContract.undelegate(otherPoolAddr.address, 0)).revertedWith(
        'DelegatorStaking: invalid amount'
      );
    });

    it('Should not be able to undelegate more than the delegating amount', async () => {
      await expect(stakingContract.undelegate(otherPoolAddr.address, 1000)).revertedWith(
        'DelegatorStaking: insufficient amount to undelegate'
      );
    });

    it('[Validator Candidate] Should an ex-candidate to rejoin Staking contract', async () => {
      await stakingContract
        .connect(poolAddr)
        .applyValidatorCandidate(
          poolAddr.address,
          poolAddr.address,
          poolAddr.address,
          poolAddr.address,
          2,
          /* 0.02% */ { value: minValidatorStakingAmount }
        );
      expect(await stakingContract.getStakingPool(poolAddr.address)).eql([
        poolAddr.address,
        minValidatorStakingAmount,
        minValidatorStakingAmount.add(8),
      ]);
      expect(await stakingContract.stakingAmountOf(poolAddr.address, deployer.address)).eq(8);
    });

    it('Should be able to delegate/undelegate for the rejoined candidate', async () => {
      await stakingContract.delegate(poolAddr.address, { value: 2 });
      expect(await stakingContract.stakingAmountOf(poolAddr.address, deployer.address)).eq(10);

      await stakingContract.connect(userA).delegate(poolAddr.address, { value: 2 });
      await stakingContract.connect(userB).delegate(poolAddr.address, { value: 2 });
      expect(
        await stakingContract.bulkStakingAmountOf([poolAddr.address, poolAddr.address], [userA.address, userB.address])
      ).eql([2, 2].map(BigNumber.from));

      await network.provider.send('evm_increaseTime', [cooldownSecsToUndelegate + 1]);
      await stakingContract.connect(userA).undelegate(poolAddr.address, 2);
      await stakingContract.connect(userB).undelegate(poolAddr.address, 1);
      expect(
        await stakingContract.bulkStakingAmountOf([poolAddr.address, poolAddr.address], [userA.address, userB.address])
      ).eql([0, 1].map(BigNumber.from));
    });
  });
});
