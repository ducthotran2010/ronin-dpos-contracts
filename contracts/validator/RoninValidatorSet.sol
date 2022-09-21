// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "../extensions/RONTransferHelper.sol";
import "../extensions/HasStakingVestingContract.sol";
import "../extensions/HasStakingContract.sol";
import "../extensions/HasSlashIndicatorContract.sol";
import "../interfaces/IRoninValidatorSet.sol";
import "../libraries/Sorting.sol";
import "../libraries/Math.sol";
import "./CandidateManager.sol";

contract RoninValidatorSet is
  IRoninValidatorSet,
  RONTransferHelper,
  HasStakingContract,
  HasStakingVestingContract,
  HasSlashIndicatorContract,
  CandidateManager,
  Initializable
{
  /// @dev The maximum number of validator.
  uint256 internal _maxValidatorNumber;
  /// @dev The number of blocks in a epoch
  uint256 internal _numberOfBlocksInEpoch;
  /// @dev Returns the number of epochs in a period
  uint256 internal _numberOfEpochsInPeriod;
  /// @dev The last updated block
  uint256 internal _lastUpdatedBlock;

  /// @dev The total of validators
  uint256 public validatorCount;
  /// @dev Mapping from validator index => validator address
  mapping(uint256 => address) internal _validator;
  /// @dev Mapping from validator address => bool
  mapping(address => bool) internal _validatorMap;

  /// @dev Mapping from validator address => the last period that the validator has no pending reward
  mapping(address => mapping(uint256 => bool)) internal _rewardDeprecatedAtPeriod;
  /// @dev Mapping from validator address => the last block that the validator is jailed
  mapping(address => uint256) internal _jailedUntil;

  /// @dev Mapping from validator address => pending reward from producing block
  mapping(address => uint256) internal _miningReward;
  /// @dev Mapping from validator address => pending reward from delegating
  mapping(address => uint256) internal _delegatingReward;

  modifier onlyCoinbase() {
    require(msg.sender == block.coinbase, "RoninValidatorSet: method caller must be coinbase");
    _;
  }

  modifier whenEpochEnding() {
    require(epochEndingAt(block.number), "RoninValidatorSet: only allowed at the end of epoch");
    _;
  }

  constructor() {
    _disableInitializers();
  }

  fallback() external payable {
    _fallback();
  }

  receive() external payable {
    _fallback();
  }

  /**
   * @dev Initializes the contract storage.
   */
  function initialize(
    address __slashIndicatorContract,
    address __stakingContract,
    address __stakingVestingContract,
    uint256 __maxValidatorNumber,
    uint256 __maxValidatorCandidate,
    uint256 __numberOfBlocksInEpoch,
    uint256 __numberOfEpochsInPeriod
  ) external initializer {
    _setSlashIndicatorContract(__slashIndicatorContract);
    _setStakingContract(__stakingContract);
    _setStakingVestingContract(__stakingVestingContract);
    _setMaxValidatorNumber(__maxValidatorNumber);
    _setMaxValidatorCandidate(__maxValidatorCandidate);
    _setNumberOfBlocksInEpoch(__numberOfBlocksInEpoch);
    _setNumberOfEpochsInPeriod(__numberOfEpochsInPeriod);
  }

  ///////////////////////////////////////////////////////////////////////////////////////
  //                              FUNCTIONS FOR COINBASE                               //
  ///////////////////////////////////////////////////////////////////////////////////////

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function submitBlockReward() external payable override onlyCoinbase {
    uint256 _submittedReward = msg.value;
    if (_submittedReward == 0) {
      return;
    }

    address _coinbaseAddr = msg.sender;
    // Deprecates reward for non-validator or slashed validator
    if (
      !_isValidator(_coinbaseAddr) || _jailed(_coinbaseAddr) || _rewardDeprecated(_coinbaseAddr, periodOf(block.number))
    ) {
      emit RewardDeprecated(_coinbaseAddr, _submittedReward);
      return;
    }

    uint256 _bonusReward = _stakingVestingContract.requestBlockBonus();
    uint256 _reward = _submittedReward + _bonusReward;

    IStaking _staking = IStaking(_stakingContract);
    uint256 _rate = _candidateInfo[_coinbaseAddr].commissionRate;
    uint256 _miningAmount = (_rate * _reward) / 100_00;
    uint256 _delegatingAmount = _reward - _miningAmount;

    _miningReward[_coinbaseAddr] += _miningAmount;
    _delegatingReward[_coinbaseAddr] += _delegatingAmount;
    _staking.recordReward(_coinbaseAddr, _delegatingAmount);
    emit BlockRewardSubmitted(_coinbaseAddr, _submittedReward, _bonusReward);
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function wrapUpEpoch() external payable virtual override onlyCoinbase whenEpochEnding {
    require(
      epochOf(_lastUpdatedBlock) < epochOf(block.number),
      "RoninValidatorSet: query for already wrapped up epoch"
    );
    _lastUpdatedBlock = block.number;

    IStaking _staking = IStaking(_stakingContract);
    address _validatorAddr;
    uint256 _delegatingAmount;
    uint256 _period = periodOf(block.number);
    bool _periodEnding = periodEndingAt(block.number);

    address[] memory _validators = getValidators();
    for (uint _i = 0; _i < _validators.length; _i++) {
      _validatorAddr = _validators[_i];

      if (_jailed(_validatorAddr) || _rewardDeprecated(_validatorAddr, _period)) {
        continue;
      }

      if (_periodEnding) {
        uint256 _miningAmount = _miningReward[_validatorAddr];
        delete _miningReward[_validatorAddr];
        if (_miningAmount > 0) {
          address payable _treasury = _candidateInfo[_validatorAddr].treasuryAddr;
          require(_sendRON(_treasury, _miningAmount), "RoninValidatorSet: could not transfer RON treasury address");
          emit MiningRewardDistributed(_validatorAddr, _miningAmount);
        }
      }

      _delegatingAmount += _delegatingReward[_validatorAddr];
      delete _delegatingReward[_validatorAddr];
    }

    if (_periodEnding) {
      ISlashIndicator(_slashIndicatorContract).resetCounters(_validators);

      _staking.settleRewardPools(_validators);
      if (_delegatingAmount > 0) {
        require(
          _sendRON(payable(address(_staking)), 0),
          "RoninValidatorSet: could not transfer RON to staking contract"
        );
        emit StakingRewardDistributed(_delegatingAmount);
      }
    }

    _updateValidatorSet();
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function getLastUpdatedBlock() external view returns (uint256) {
    return _lastUpdatedBlock;
  }

  ///////////////////////////////////////////////////////////////////////////////////////
  //                            FUNCTIONS FOR SLASH INDICATOR                          //
  ///////////////////////////////////////////////////////////////////////////////////////

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function slash(
    address _validatorAddr,
    uint256 _newJailedUntil,
    uint256 _slashAmount
  ) external onlySlashIndicatorContract {
    _rewardDeprecatedAtPeriod[_validatorAddr][periodOf(block.number)] = true;
    delete _miningReward[_validatorAddr];
    delete _delegatingReward[_validatorAddr];
    IStaking(_stakingContract).sinkPendingReward(_validatorAddr);

    if (_newJailedUntil > 0) {
      _jailedUntil[_validatorAddr] = Math.max(_newJailedUntil, _jailedUntil[_validatorAddr]);
    }

    if (_slashAmount > 0) {
      IStaking(_stakingContract).deductStakingAmount(_validatorAddr, _slashAmount);
    }

    emit ValidatorSlashed(_validatorAddr, _jailedUntil[_validatorAddr], _slashAmount);
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function jailed(address[] memory _addrList) external view override returns (bool[] memory _result) {
    for (uint256 _i; _i < _addrList.length; _i++) {
      _result[_i] = _jailed(_addrList[_i]);
    }
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function rewardDeprecated(address[] memory _addrList, uint256 _period)
    external
    view
    override
    returns (bool[] memory _result)
  {
    for (uint256 _i; _i < _addrList.length; _i++) {
      _result[_i] = _rewardDeprecated(_addrList[_i], _period);
    }
  }

  ///////////////////////////////////////////////////////////////////////////////////////
  //                             FUNCTIONS FOR NORMAL USER                             //
  ///////////////////////////////////////////////////////////////////////////////////////

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function epochOf(uint256 _block) public view virtual override returns (uint256) {
    return _block / _numberOfBlocksInEpoch + 1;
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function periodOf(uint256 _block) public view virtual override returns (uint256) {
    return _block / (_numberOfBlocksInEpoch * _numberOfEpochsInPeriod) + 1;
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function getValidators() public view override returns (address[] memory _validatorList) {
    _validatorList = new address[](validatorCount);
    for (uint _i = 0; _i < _validatorList.length; _i++) {
      _validatorList[_i] = _validator[_i];
    }
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function epochEndingAt(uint256 _block) public view virtual returns (bool) {
    return _block % _numberOfBlocksInEpoch == _numberOfBlocksInEpoch - 1;
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function periodEndingAt(uint256 _block) public view virtual returns (bool) {
    uint256 _blockLength = _numberOfBlocksInEpoch * _numberOfEpochsInPeriod;
    return _block % _blockLength == _blockLength - 1;
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function numberOfEpochsInPeriod() external view override returns (uint256 _numberOfEpochs) {
    return _numberOfEpochsInPeriod;
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function numberOfBlocksInEpoch() external view override returns (uint256 _numberOfBlocks) {
    return _numberOfBlocksInEpoch;
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function maxValidatorNumber() external view override returns (uint256 _maximumValidatorNumber) {
    return _maxValidatorNumber;
  }

  ///////////////////////////////////////////////////////////////////////////////////////
  //                         FUNCTIONS FOR GOVERNANCE ADMIN                            //
  ///////////////////////////////////////////////////////////////////////////////////////

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function setMaxValidatorNumber(uint256 __maxValidatorNumber) external override onlyAdmin {
    _setMaxValidatorNumber(__maxValidatorNumber);
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function setNumberOfBlocksInEpoch(uint256 __numberOfBlocksInEpoch) external override onlyAdmin {
    _setNumberOfBlocksInEpoch(__numberOfBlocksInEpoch);
  }

  /**
   * @inheritdoc IRoninValidatorSet
   */
  function setNumberOfEpochsInPeriod(uint256 __numberOfEpochsInPeriod) external override onlyAdmin {
    _setNumberOfEpochsInPeriod(__numberOfEpochsInPeriod);
  }

  ///////////////////////////////////////////////////////////////////////////////////////
  //                                  HELPER FUNCTIONS                                 //
  ///////////////////////////////////////////////////////////////////////////////////////

  /**
   * @dev Returns validator candidates list.
   */
  function _syncNewValidatorSet() internal returns (address[] memory _candidateList) {
    uint256[] memory _weights = syncCandidates();
    _candidateList = _candidates;

    uint256 _length = _candidateList.length;
    for (uint256 _i; _i < _candidateList.length; _i++) {
      if (_jailed(_candidateList[_i])) {
        _length--;
        _candidateList[_i] = _candidateList[_length];
        _weights[_i] = _weights[_length];
      }
    }

    assembly {
      mstore(_candidateList, _length)
      mstore(_weights, _length)
    }

    _candidateList = Sorting.sort(_candidateList, _weights);
    // TODO: pick at least M governers as validators
  }

  /**
   * @dev Updates the validator set based on the validator candidates from the Staking contract.
   *
   * Emits the `ValidatorSetUpdated` event.
   *
   */
  function _updateValidatorSet() internal virtual {
    address[] memory _candidates = _syncNewValidatorSet();
    uint256 _newValidatorCount = Math.min(_maxValidatorNumber, _candidates.length);

    assembly {
      mstore(_candidates, _newValidatorCount)
    }

    for (uint256 _i = _newValidatorCount; _i < validatorCount; _i++) {
      delete _validator[_i];
      delete _validatorMap[_validator[_i]];
    }

    for (uint256 _i = 0; _i < _newValidatorCount; _i++) {
      address _newValidator = _candidates[_i];
      if (_newValidator == _validator[_i]) {
        continue;
      }
      delete _validatorMap[_validator[_i]];
      _validatorMap[_newValidator] = true;
      _validator[_i] = _newValidator;
    }

    validatorCount = _newValidatorCount;
    emit ValidatorSetUpdated(_candidates);
  }

  /**
   * @dev Returns whether the reward of the validator is put in jail (cannot join the set of validators) during the current period.
   */
  function _jailed(address _validatorAddr) internal view returns (bool) {
    return block.number <= _jailedUntil[_validatorAddr];
  }

  /**
   * @dev Returns whether the validator has no pending reward in that period.
   */
  function _rewardDeprecated(address _validatorAddr, uint256 _period) internal view returns (bool) {
    return _rewardDeprecatedAtPeriod[_validatorAddr][_period];
  }

  /**
   * @dev Returns whether the address `_addr` is validator or not.
   */
  function _isValidator(address _addr) internal view returns (bool) {
    return _validatorMap[_addr];
  }

  /**
   * @dev Updates the max validator number
   *
   * Emits the event `MaxValidatorNumberUpdated`
   *
   */
  function _setMaxValidatorNumber(uint256 _number) internal {
    _maxValidatorNumber = _number;
    emit MaxValidatorNumberUpdated(_number);
  }

  /**
   * @dev Updates the number of blocks in epoch
   *
   * Emits the event `NumberOfBlocksInEpochUpdated`
   *
   */
  function _setNumberOfBlocksInEpoch(uint256 _number) internal {
    _numberOfBlocksInEpoch = _number;
    emit NumberOfBlocksInEpochUpdated(_number);
  }

  /**
   * @dev Updates the number of epochs in period
   *
   * Emits the event `NumberOfEpochsInPeriodUpdated`
   *
   */
  function _setNumberOfEpochsInPeriod(uint256 _number) internal {
    _numberOfEpochsInPeriod = _number;
    emit NumberOfEpochsInPeriodUpdated(_number);
  }

  /**
   * @dev Only receives RON from staking vesting contract.
   */
  function _fallback() internal view {
    require(
      msg.sender == stakingVestingContract(),
      "RoninValidatorSet: only receives RON from staking vesting contract"
    );
  }
}