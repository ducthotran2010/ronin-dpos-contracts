import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { GovernanceAdminInterface, mapByteSigToSigStruct } from '../../src/script/governance-admin-interface';
import { BOsBallot, BridgeOperatorsBallotTypes, VoteType } from '../../src/script/proposal';
import {
  IBridge,
  MainchainGovernanceAdmin,
  MainchainGovernanceAdmin__factory,
  RoninGovernanceAdmin,
  RoninGovernanceAdmin__factory,
  Staking,
  Staking__factory,
  TransparentUpgradeableProxyV2__factory,
} from '../../src/types';
import { MockBridge__factory } from '../../src/types/factories/MockBridge__factory';
import { ProposalDetailStruct } from '../../src/types/GovernanceAdmin';
import { SignatureStruct } from '../../src/types/RoninGovernanceAdmin';
import { randomAddress } from '../../src/utils';
import { initTest } from '../helpers/fixture';

let deployer: SignerWithAddress;
let relayer: SignerWithAddress;
let governors: SignerWithAddress[];

let bridgeContract: IBridge;
let stakingContract: Staking;
let mainchainGovernanceAdmin: MainchainGovernanceAdmin;
let governanceAdmin: RoninGovernanceAdmin;
let governanceAdminInterface: GovernanceAdminInterface;

let proposal: ProposalDetailStruct;
let supports: VoteType[];
let signatures: SignatureStruct[];
let ballot: BOsBallot;

describe('Governance Admin test', () => {
  before(async () => {
    [deployer, relayer, ...governors] = await ethers.getSigners();
    governors = governors.slice(0, 21);
    governors = governors.sort((v1, v2) => v1.address.toLowerCase().localeCompare(v2.address.toLowerCase()));

    const logic = await new MockBridge__factory(deployer).deploy();
    const proxy = await new TransparentUpgradeableProxyV2__factory(deployer).deploy(
      logic.address,
      deployer.address,
      []
    );
    bridgeContract = MockBridge__factory.connect(proxy.address, deployer);

    const { roninGovernanceAdminAddress, mainchainGovernanceAdminAddress, stakingContractAddress } = await initTest(
      'RoninGovernanceAdmin.test'
    )({
      bridgeContract: bridgeContract.address,
      roninTrustedOrganizationArguments: {
        trustedOrganizations: governors.map((v) => ({
          consensusAddr: v.address,
          governor: v.address,
          bridgeVoter: v.address,
          weight: 100,
          addedBlock: 0,
        })),

        numerator: 1,
        denominator: 2,
      },
      mainchainGovernanceAdminArguments: {
        relayers: [relayer.address],
      },
    });

    stakingContract = Staking__factory.connect(stakingContractAddress, deployer);
    governanceAdmin = RoninGovernanceAdmin__factory.connect(roninGovernanceAdminAddress, deployer);
    governanceAdminInterface = new GovernanceAdminInterface(governanceAdmin, ...governors);
    mainchainGovernanceAdmin = MainchainGovernanceAdmin__factory.connect(mainchainGovernanceAdminAddress, deployer);
    await TransparentUpgradeableProxyV2__factory.connect(proxy.address, deployer).changeAdmin(
      mainchainGovernanceAdmin.address
    );
  });

  it('Should be able to propose to change staking config', async () => {
    const newMinValidatorStakingAmount = 555;
    proposal = await governanceAdminInterface.createProposal(
      stakingContract.address,
      0,
      governanceAdminInterface.interface.encodeFunctionData('functionDelegateCall', [
        stakingContract.interface.encodeFunctionData('setMinValidatorStakingAmount', [newMinValidatorStakingAmount]),
      ]),
      500_000
    );
    signatures = await governanceAdminInterface.generateSignatures(proposal);
    supports = signatures.map(() => VoteType.For);

    expect(await governanceAdmin.proposalVoted(proposal.chainId, proposal.nonce, governors[0].address)).to.false;
    await governanceAdmin.connect(governors[0]).proposeProposalStructAndCastVotes(proposal, supports, signatures);
    expect(await governanceAdmin.proposalVoted(proposal.chainId, proposal.nonce, governors[0].address)).to.true;
    expect(await stakingContract.minValidatorStakingAmount()).eq(newMinValidatorStakingAmount);
  });

  it('Should not be able to reuse already voted signatures or proposals', async () => {
    await expect(
      governanceAdmin.connect(governors[0]).proposeProposalStructAndCastVotes(proposal, supports, signatures)
    ).revertedWith('CoreGovernance: invalid proposal nonce');
  });

  it('Should be able to relay to mainchain governance admin contract', async () => {
    expect(await mainchainGovernanceAdmin.proposalRelayed(proposal.chainId, proposal.nonce)).to.false;
    await mainchainGovernanceAdmin.connect(relayer).relayProposal(proposal, supports, signatures);
    expect(await mainchainGovernanceAdmin.proposalRelayed(proposal.chainId, proposal.nonce)).to.true;
  });

  it('Should not be able to relay again', async () => {
    await expect(mainchainGovernanceAdmin.connect(relayer).relayProposal(proposal, supports, signatures)).revertedWith(
      'CoreGovernance: invalid proposal nonce'
    );
  });

  it('Should be able to vote bridge operators', async () => {
    ballot = {
      period: 10,
      operators: governors.map((v) => v.address),
    };
    signatures = await Promise.all(
      governors.map((g) =>
        g
          ._signTypedData(governanceAdminInterface.domain, BridgeOperatorsBallotTypes, ballot)
          .then(mapByteSigToSigStruct)
      )
    );
    expect(await governanceAdmin.bridgeOperatorsVoted(ballot.period, governors[0].address)).to.false;
    await governanceAdmin.voteBridgeOperatorsBySignatures(ballot.period, ballot.operators, signatures);
    expect(await governanceAdmin.bridgeOperatorsVoted(ballot.period, governors[0].address)).to.true;
  });

  it('Should be able relay vote bridge operators', async () => {
    expect(await mainchainGovernanceAdmin.bridgeOperatorsRelayed(ballot.period)).to.false;
    await mainchainGovernanceAdmin.connect(relayer).relayBridgeOperators(ballot.period, ballot.operators, signatures);
    expect(await mainchainGovernanceAdmin.bridgeOperatorsRelayed(ballot.period)).to.true;
    expect(await bridgeContract.getBridgeOperators()).eql(governors.map((v) => v.address));
  });

  it('Should not able to relay again', async () => {
    await expect(
      mainchainGovernanceAdmin.connect(relayer).relayBridgeOperators(ballot.period, ballot.operators, signatures)
    ).revertedWith('BOsGovernanceRelay: query for outdated period');
  });

  it('Should not be able to use the signatures for another period', async () => {
    ballot = {
      period: 100,
      operators: governors.map((v) => v.address),
    };
    await expect(
      governanceAdmin.voteBridgeOperatorsBySignatures(ballot.period, ballot.operators, signatures)
    ).revertedWith('BOsGovernanceProposal: invalid order');
  });

  it('Should not be able to vote bridge operators with a smaller period', async () => {
    ballot = {
      period: 5,
      operators: governors.map((v) => v.address),
    };
    signatures = await Promise.all(
      governors.map((g) =>
        g
          ._signTypedData(governanceAdminInterface.domain, BridgeOperatorsBallotTypes, ballot)
          .then(mapByteSigToSigStruct)
      )
    );
    await expect(
      governanceAdmin.voteBridgeOperatorsBySignatures(ballot.period, ballot.operators, signatures)
    ).revertedWith('BOsGovernanceProposal: query for outdated period');
  });

  it('Should be able to vote bridge operators with a larger period', async () => {
    const duplicatedNumber = 11;
    ballot = {
      period: 100,
      operators: governors.map((v, i) => (i < duplicatedNumber ? v.address : randomAddress())),
    };
    signatures = await Promise.all(
      governors.map((g) =>
        g
          ._signTypedData(governanceAdminInterface.domain, BridgeOperatorsBallotTypes, ballot)
          .then(mapByteSigToSigStruct)
      )
    );
    await governanceAdmin.voteBridgeOperatorsBySignatures(ballot.period, ballot.operators, signatures);
  });

  it('Should be able relay vote bridge operators', async () => {
    await mainchainGovernanceAdmin.connect(relayer).relayBridgeOperators(ballot.period, ballot.operators, signatures);
    expect(await bridgeContract.getBridgeOperators()).have.same.members(ballot.operators);
  });
});
