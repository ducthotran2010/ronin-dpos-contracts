import { BigNumber } from 'ethers';
import fs from 'fs';

export const logWrappedUpEpoch = (
  res: {
    blockNumber: number;
    tx: string;
    periodNumber: any;
    epochNumber: any;
    periodEnding: any;
  }[]
) => {
  const csvString = [
    ['blockNumber', 'tx', 'periodNumber', 'epochNumber', 'periodEnding'],
    ...res.map((item) => [item.blockNumber, item.tx, item.periodNumber, item.epochNumber, item.periodEnding]),
  ]
    .map((e) => e.join(','))
    .join('\n');
  fs.writeFileSync('periods.csv', csvString);
};

export const logBlockSubmitReward = (
  period: any,
  res: {
    blockNumber: number;
    tx: string;
    coinbaseAddr: any;
    submittedAmount: any;
    bonusAmount: any;
    sum: any;
  }[]
) => {
  const csvString = [
    ['period', 'blockNumber', 'tx', 'coinbaseAddr', 'submittedAmount', 'bonusAmount', 'sum'],
    ...res.map((item) => [
      period,
      item.blockNumber,
      item.tx,
      item.coinbaseAddr,
      item.submittedAmount,
      item.bonusAmount,
      item.sum,
    ]),
  ]
    .map((e) => e.join('\t'))
    .join('\n');
  fs.writeFileSync('period-' + BigNumber.from(period).toString() + '.csv', csvString);
};
