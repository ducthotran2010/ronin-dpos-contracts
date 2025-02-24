// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../../extensions/RONTransferHelper.sol";
import "../../extensions/collections/HasValidatorContract.sol";
import "../../interfaces/staking/IBaseStaking.sol";
import "../../libraries/Math.sol";
import "./RewardCalculation.sol";

abstract contract BaseStaking is
  RONTransferHelper,
  ReentrancyGuard,
  RewardCalculation,
  HasValidatorContract,
  IBaseStaking
{
  /// @dev Mapping from pool address => staking pool detail
  mapping(address => PoolDetail) internal _stakingPool;

  /// @dev The cooldown time in seconds to undelegate from the last timestamp (s)he delegated.
  uint256 internal _cooldownSecsToUndelegate;
  /// @dev The number of seconds that a candidate must wait to be revoked and take the self-staking amount back.
  uint256 internal _waitingSecsToRevoke;

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   */
  uint256[50] private ______gap;

  modifier noEmptyValue() {
    require(msg.value > 0, "BaseStaking: query with empty value");
    _;
  }

  modifier notPoolAdmin(PoolDetail storage _pool, address _delegator) {
    require(_pool.admin != _delegator, "BaseStaking: delegator must not be the pool admin");
    _;
  }

  modifier onlyPoolAdmin(PoolDetail storage _pool, address _requester) {
    require(_pool.admin == _requester, "BaseStaking: requester must be the pool admin");
    _;
  }

  modifier poolExists(address _poolAddr) {
    require(_validatorContract.isValidatorCandidate(_poolAddr), "BaseStaking: query for non-existent pool");
    _;
  }

  /**
   * @inheritdoc IRewardPool
   */
  function stakingTotal(address _poolAddr) public view override returns (uint256) {
    return _stakingPool[_poolAddr].stakingTotal;
  }

  /**
   * @inheritdoc IRewardPool
   */
  function bulkStakingTotal(address[] calldata _poolList)
    public
    view
    override
    returns (uint256[] memory _stakingAmounts)
  {
    _stakingAmounts = new uint256[](_poolList.length);
    for (uint _i = 0; _i < _poolList.length; _i++) {
      _stakingAmounts[_i] = stakingTotal(_poolList[_i]);
    }
  }

  /**
   * @inheritdoc IRewardPool
   */
  function stakingAmountOf(address _poolAddr, address _user) public view override returns (uint256) {
    return _stakingPool[_poolAddr].delegatingAmount[_user];
  }

  /**
   * @inheritdoc IRewardPool
   */
  function bulkStakingAmountOf(address[] calldata _poolAddrs, address[] calldata _userList)
    external
    view
    override
    returns (uint256[] memory _stakingAmounts)
  {
    require(_poolAddrs.length == _userList.length, "BaseStaking: invalid input array");
    _stakingAmounts = new uint256[](_poolAddrs.length);
    for (uint _i = 0; _i < _stakingAmounts.length; _i++) {
      _stakingAmounts[_i] = _stakingPool[_poolAddrs[_i]].delegatingAmount[_userList[_i]];
    }
  }

  /**
   * @inheritdoc IBaseStaking
   */
  function cooldownSecsToUndelegate() external view returns (uint256) {
    return _cooldownSecsToUndelegate;
  }

  /**
   * @inheritdoc IBaseStaking
   */
  function waitingSecsToRevoke() external view returns (uint256) {
    return _waitingSecsToRevoke;
  }

  /**
   * @inheritdoc IBaseStaking
   */
  function setCooldownSecsToUndelegate(uint256 _cooldownSecs) external override onlyAdmin {
    _setCooldownSecsToUndelegate(_cooldownSecs);
  }

  /**
   * @inheritdoc IBaseStaking
   */
  function setWaitingSecsToRevoke(uint256 _secs) external override onlyAdmin {
    _setWaitingSecsToRevoke(_secs);
  }

  /**
   * @dev Sets the minium number of seconds to undelegate.
   *
   * Emits the event `CooldownSecsToUndelegateUpdated`.
   *
   */
  function _setCooldownSecsToUndelegate(uint256 _cooldownSecs) internal {
    _cooldownSecsToUndelegate = _cooldownSecs;
    emit CooldownSecsToUndelegateUpdated(_cooldownSecs);
  }

  /**
   * @dev Sets the number of seconds that a candidate must wait to be revoked.
   *
   * Emits the event `WaitingSecsToRevokeUpdated`.
   *
   */
  function _setWaitingSecsToRevoke(uint256 _secs) internal {
    _waitingSecsToRevoke = _secs;
    emit WaitingSecsToRevokeUpdated(_secs);
  }

  /**
   * @dev Changes the delegate amount.
   */
  function _changeDelegatingAmount(
    PoolDetail storage _pool,
    address _delegator,
    uint256 _newDelegatingAmount,
    uint256 _newStakingTotal
  ) internal {
    _syncUserReward(_pool.addr, _delegator, _newDelegatingAmount);
    _pool.stakingTotal = _newStakingTotal;
    _pool.delegatingAmount[_delegator] = _newDelegatingAmount;
  }
}
