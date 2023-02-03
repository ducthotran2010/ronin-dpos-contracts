import { ethers } from 'hardhat';
import { RoninValidatorSet__factory, Staking__factory } from '../../types';

(async () => {
  const validatorContract = RoninValidatorSet__factory.connect(
    '0x54B3AC74a90E64E8dDE60671b6fE8F8DDf18eC9d',
    ethers.provider
  );
  const stakingContract = Staking__factory.connect('0x9C245671791834daf3885533D24dce516B763B28', ethers.provider);

  const logs = await ethers.provider.getLogs({
    ...validatorContract.filters.BlockRewardSubmitted('0xE9bf2A788C27dADc6B169d52408b710d267b9bff'),
    fromBlock: 13541999,
    toBlock: 13542999,
  });

  const res = logs.map((log) => {
    const v = validatorContract.interface.parseLog(log);
    return {
      blockNumber: log.blockNumber,
      blockNumber_: v.args['blockNumber'],
      tx: log.transactionHash,
      tx_: v.args['tx'],
      coinbaseAddr: v.args['coinbaseAddr'],
      submittedAmount: v.args['submittedAmount'],
      bonusAmount: v.args['bonusAmount'],
      sum: v.args['submittedAmount'].add(v.args['bonusAmount']),
      // periodNumber: v.args['periodNumber'],
      // epochNumber: v.args['epochNumber'],
      // periodEnding: v.args['periodEnding'],
    };
  });

  console.log(res);
})();
