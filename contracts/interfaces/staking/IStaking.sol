// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import "./IBaseStaking.sol";
import "./ICandidateStaking.sol";
import "./IDelegatorStaking.sol";

interface IStaking is IRewardPool, IBaseStaking, ICandidateStaking, IDelegatorStaking {
  /**
   * @dev Records the amount of rewards `_rewards` for the pools `_consensusAddrs`.
   *
   * Requirements:
   * - The method caller is validator contract.
   *
   * Emits the event `PoolsUpdated` once the contract recorded the rewards successfully.
   * Emits the event `PoolsUpdateFailed` once the input array lengths are not equal.
   * Emits the event `PoolsUpdateConflicted` when there are some pools which already updated in the period.
   *
   * Note: This method should be called once at the period ending.
   *
   */
  function recordRewards(
    address[] calldata _consensusAddrs,
    uint256[] calldata _rewards,
    uint256 _period
  ) external payable;

  /**
   * @dev Deducts from staking amount of the validator `_consensusAddr` for `_amount`.
   *
   * Requirements:
   * - The method caller is validator contract.
   *
   * Emits the event `Unstaked`.
   *
   */
  function deductStakingAmount(address _consensusAddr, uint256 _amount) external;

  /**
   * @dev Returns the staking pool detail.
   */
  function getStakingPool(address)
    external
    view
    returns (
      address _admin,
      uint256 _stakingAmount,
      uint256 _stakingTotal
    );

  /**
   * @dev Returns the self-staking amounts of the pools.
   */
  function bulkSelfStaking(address[] calldata) external view returns (uint256[] memory);
}
