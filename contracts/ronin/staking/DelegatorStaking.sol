// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import "../../interfaces/staking/IDelegatorStaking.sol";
import "./BaseStaking.sol";

abstract contract DelegatorStaking is BaseStaking, IDelegatorStaking {
  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   */
  uint256[50] private ______gap;

  /**
   * @inheritdoc IDelegatorStaking
   */
  function delegate(address _consensusAddr) external payable noEmptyValue poolExists(_consensusAddr) {
    _delegate(_stakingPool[_consensusAddr], msg.sender, msg.value);
  }

  /**
   * @inheritdoc IDelegatorStaking
   */
  function undelegate(address _consensusAddr, uint256 _amount) external nonReentrant {
    address payable _delegator = payable(msg.sender);
    _undelegate(_stakingPool[_consensusAddr], _delegator, _amount);
    require(_sendRON(_delegator, _amount), "DelegatorStaking: could not transfer RON");
  }

  /**
   * @inheritdoc IDelegatorStaking
   */
  function bulkUndelegate(address[] calldata _consensusAddrs, uint256[] calldata _amounts) external nonReentrant {
    require(
      _consensusAddrs.length > 0 && _consensusAddrs.length == _amounts.length,
      "DelegatorStaking: invalid array length"
    );

    address payable _delegator = payable(msg.sender);
    uint256 _total;

    for (uint _i = 0; _i < _consensusAddrs.length; _i++) {
      _total += _amounts[_i];
      _undelegate(_stakingPool[_consensusAddrs[_i]], _delegator, _amounts[_i]);
    }

    require(_sendRON(_delegator, _total), "DelegatorStaking: could not transfer RON");
  }

  /**
   * @inheritdoc IDelegatorStaking
   */
  function redelegate(
    address _consensusAddrSrc,
    address _consensusAddrDst,
    uint256 _amount
  ) external nonReentrant poolExists(_consensusAddrDst) {
    address _delegator = msg.sender;
    _undelegate(_stakingPool[_consensusAddrSrc], _delegator, _amount);
    _delegate(_stakingPool[_consensusAddrDst], _delegator, _amount);
  }

  /**
   * @inheritdoc IDelegatorStaking
   */
  function claimRewards(address[] calldata _consensusAddrList)
    external
    override
    nonReentrant
    returns (uint256 _amount)
  {
    _amount = _claimRewards(msg.sender, _consensusAddrList);
    _transferRON(payable(msg.sender), _amount);
  }

  /**
   * @inheritdoc IDelegatorStaking
   */
  function delegateRewards(address[] calldata _consensusAddrList, address _consensusAddrDst)
    external
    override
    nonReentrant
    poolExists(_consensusAddrDst)
    returns (uint256 _amount)
  {
    return _delegateRewards(msg.sender, _consensusAddrList, _consensusAddrDst);
  }

  /**
   * @inheritdoc IDelegatorStaking
   */
  function getRewards(address _user, address[] calldata _poolAddrList)
    external
    view
    returns (uint256[] memory _rewards)
  {
    address _consensusAddr;
    uint256 _period = _validatorContract.currentPeriod();
    _rewards = new uint256[](_poolAddrList.length);

    for (uint256 _i = 0; _i < _poolAddrList.length; _i++) {
      _consensusAddr = _poolAddrList[_i];
      _rewards[_i] = _getReward(_consensusAddr, _user, _period, stakingAmountOf(_consensusAddr, _user));
    }
  }

  /**
   * @dev Delegates from a validator address.
   *
   * Requirements:
   * - The delegator is not the pool admin.
   *
   * Emits the `Delegated` event.
   *
   * Note: This function does not verify the `msg.value` with the amount.
   *
   */
  function _delegate(
    PoolDetail storage _pool,
    address _delegator,
    uint256 _amount
  ) internal notPoolAdmin(_pool, _delegator) {
    _changeDelegatingAmount(
      _pool,
      _delegator,
      _pool.delegatingAmount[_delegator] + _amount,
      _pool.stakingTotal + _amount
    );
    _pool.lastDelegatingTimestamp[_delegator] = block.timestamp;
    emit Delegated(_delegator, _pool.addr, _amount);
  }

  /**
   * @dev Undelegates from a validator address.
   *
   * Requirements:
   * - The delegator is not the pool admin.
   * - The amount is larger than 0.
   * - The delegating amount is larger than or equal to the undelegating amount.
   *
   * Emits the `Undelegated` event.
   *
   * Note: Consider transferring back the amount of RON after calling this function.
   *
   */
  function _undelegate(
    PoolDetail storage _pool,
    address _delegator,
    uint256 _amount
  ) private notPoolAdmin(_pool, _delegator) {
    require(_amount > 0, "DelegatorStaking: invalid amount");
    require(_pool.delegatingAmount[_delegator] >= _amount, "DelegatorStaking: insufficient amount to undelegate");
    require(
      _pool.lastDelegatingTimestamp[_delegator] + _cooldownSecsToUndelegate < block.timestamp,
      "DelegatorStaking: undelegate too early"
    );
    _changeDelegatingAmount(
      _pool,
      _delegator,
      _pool.delegatingAmount[_delegator] - _amount,
      _pool.stakingTotal - _amount
    );
    emit Undelegated(_delegator, _pool.addr, _amount);
  }

  /**
   * @dev Claims rewards from the pools `_poolAddrList`.
   * Note: This function does not transfer reward to user.
   */
  function _claimRewards(address _user, address[] calldata _poolAddrList) internal returns (uint256 _amount) {
    for (uint256 _i = 0; _i < _poolAddrList.length; _i++) {
      _amount += _claimReward(_poolAddrList[_i], _user);
    }
  }

  /**
   * @dev Claims the rewards and delegates them to the consensus address.
   */
  function _delegateRewards(
    address _user,
    address[] calldata _poolAddrList,
    address _poolAddrDst
  ) internal returns (uint256 _amount) {
    _amount = _claimRewards(_user, _poolAddrList);
    _delegate(_stakingPool[_poolAddrDst], _user, _amount);
  }
}
