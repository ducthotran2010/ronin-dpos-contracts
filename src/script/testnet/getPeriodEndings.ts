import { ethers } from 'hardhat';

import { RoninValidatorSet__factory, Staking__factory } from '../../types';
import { logBlockSubmitReward, logWrappedUpEpoch } from './utils';

const POOL_ADDRESS = '0xE9bf2A788C27dADc6B169d52408b710d267b9bff';
const VALIDATOR_CONTRACT_ADDRESS = '0x54B3AC74a90E64E8dDE60671b6fE8F8DDf18eC9d';
const STAKING_CONTRACT_ADDRESS = '0x9C245671791834daf3885533D24dce516B763B28';
const FROM_BLOCK = 13590199;

(async () => {
  const validatorContract = RoninValidatorSet__factory.connect(VALIDATOR_CONTRACT_ADDRESS, ethers.provider);
  const stakingContract = Staking__factory.connect(STAKING_CONTRACT_ADDRESS, ethers.provider);

  const logs = await ethers.provider.getLogs({
    ...validatorContract.filters.WrappedUpEpoch(),
    fromBlock: FROM_BLOCK,
    toBlock: 'latest',
  });

  const res = logs
    .map((log) => {
      const v = validatorContract.interface.parseLog(log);
      return {
        blockNumber: log.blockNumber,
        tx: log.transactionHash,
        periodNumber: v.args['periodNumber'],
        epochNumber: v.args['epochNumber'],
        periodEnding: v.args['periodEnding'],
      };
    })
    .filter((v) => v.periodEnding);

  logWrappedUpEpoch(res);

  for (let i = 1; i < res.length; i++) {
    const fromBlock = res[i - 1].blockNumber + 1;
    const toBlock = res[i].blockNumber;
    const logs = await ethers.provider.getLogs({
      ...validatorContract.filters.BlockRewardSubmitted(POOL_ADDRESS),
      fromBlock,
      toBlock,
    });
    // const result = logs.map(log => {
    //   const v = validatorContract.interface.parseLog(log)
    //   return {
    //     blockNumber: log.blockNumber,
    //     tx: log.transactionHash,
    //     coinbaseAddr: v.args['coinbaseAddr'],
    //     submittedAmount: v.args['submittedAmount'],
    //     bonusAmount: v.args['bonusAmount'],
    //     sum: v.args['submittedAmount'].add(v.args['bonusAmount'])
    //   }
    // });
    console.log('\n=================\n');
    console.log(res[i].periodNumber, fromBlock, toBlock);

    // logBlockSubmitReward(res[i].periodNumber, result)
  }
})();
