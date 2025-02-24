// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "../../interfaces/staking/IStaking.sol";
import "../../interfaces/validator/IRoninValidatorSet.sol";
import "./CandidateStaking.sol";
import "./DelegatorStaking.sol";

contract Staking is IStaking, CandidateStaking, DelegatorStaking, Initializable {
  constructor() {
    _disableInitializers();
  }

  receive() external payable onlyValidatorContract {}

  fallback() external payable onlyValidatorContract {}

  /**
   * @dev Initializes the contract storage.
   */
  function initialize(
    address __validatorContract,
    uint256 __minValidatorStakingAmount,
    uint256 __cooldownSecsToUndelegate,
    uint256 __waitingSecsToRevoke
  ) external initializer {
    _setValidatorContract(__validatorContract);
    _setMinValidatorStakingAmount(__minValidatorStakingAmount);
    _setCooldownSecsToUndelegate(__cooldownSecsToUndelegate);
    _setWaitingSecsToRevoke(__waitingSecsToRevoke);
  }

  /**
   * @inheritdoc IStaking
   */
  function getStakingPool(address _poolAddr)
    external
    view
    poolExists(_poolAddr)
    returns (
      address _admin,
      uint256 _stakingAmount,
      uint256 _stakingTotal
    )
  {
    PoolDetail storage _pool = _stakingPool[_poolAddr];
    return (_pool.admin, _pool.stakingAmount, _pool.stakingTotal);
  }

  /**
   * @inheritdoc IStaking
   */
  function bulkSelfStaking(address[] calldata _pools) external view returns (uint256[] memory _selfStakings) {
    _selfStakings = new uint256[](_pools.length);
    for (uint _i = 0; _i < _pools.length; _i++) {
      _selfStakings[_i] = _stakingPool[_pools[_i]].stakingAmount;
    }
  }

  /**
   * @inheritdoc IStaking
   */
  function recordRewards(
    address[] calldata _consensusAddrs,
    uint256[] calldata _rewards,
    uint256 _period
  ) external payable onlyValidatorContract {
    _recordRewards(_consensusAddrs, _rewards, _period);
  }

  /**
   * @inheritdoc IStaking
   */
  function deductStakingAmount(address _consensusAddr, uint256 _amount) external onlyValidatorContract {
    return _deductStakingAmount(_stakingPool[_consensusAddr], _amount);
  }

  /**
   * @inheritdoc RewardCalculation
   */
  function _currentPeriod() internal view virtual override returns (uint256) {
    return _validatorContract.currentPeriod();
  }

  /**
   * @inheritdoc CandidateStaking
   */
  function _deductStakingAmount(PoolDetail storage _pool, uint256 _amount) internal override {
    _amount = Math.min(_pool.stakingAmount, _amount);

    _pool.stakingAmount -= _amount;
    _changeDelegatingAmount(_pool, _pool.admin, _pool.stakingAmount, _pool.stakingTotal - _amount);
    emit Unstaked(_pool.addr, _amount);
  }
}
