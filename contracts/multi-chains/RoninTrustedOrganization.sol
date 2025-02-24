// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "../interfaces/IRoninTrustedOrganization.sol";
import "../extensions/collections/HasProxyAdmin.sol";

contract RoninTrustedOrganization is IRoninTrustedOrganization, HasProxyAdmin, Initializable {
  uint256 internal _num;
  uint256 internal _denom;
  uint256 internal _totalWeight;
  uint256 internal _nonce;

  /// @dev Mapping from consensus address => weight
  mapping(address => uint256) internal _consensusWeight;
  /// @dev Mapping from governor address => weight
  mapping(address => uint256) internal _governorWeight;
  /// @dev Mapping from bridge voter address => weight
  mapping(address => uint256) internal _bridgeVoterWeight;

  /// @dev Mapping from consensus address => added block
  mapping(address => uint256) internal _addedBlock;

  /// @dev Consensus array
  address[] internal _consensusList;
  /// @dev Governors array
  address[] internal _governorList;
  /// @dev Bridge voters array
  address[] internal _bridgeVoterList;

  /**
   * @dev Initializes the contract storage.
   */
  function initialize(
    TrustedOrganization[] calldata _trustedOrgs,
    uint256 __num,
    uint256 __denom
  ) external initializer {
    if (_trustedOrgs.length > 0) {
      _addTrustedOrganizations(_trustedOrgs);
    }
    _setThreshold(__num, __denom);
  }

  /**
   * @inheritdoc IQuorum
   */
  function getThreshold() external view virtual returns (uint256, uint256) {
    return (_num, _denom);
  }

  /**
   * @inheritdoc IQuorum
   */
  function checkThreshold(uint256 _voteWeight) external view virtual returns (bool) {
    return _voteWeight * _denom >= _num * _totalWeight;
  }

  /**
   * @inheritdoc IQuorum
   */
  function minimumVoteWeight() external view virtual returns (uint256) {
    return (_num * _totalWeight + _denom - 1) / _denom;
  }

  /**
   * @inheritdoc IQuorum
   */
  function setThreshold(uint256 _numerator, uint256 _denominator)
    external
    override
    onlyAdmin
    returns (uint256, uint256)
  {
    return _setThreshold(_numerator, _denominator);
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function addTrustedOrganizations(TrustedOrganization[] calldata _list) external override onlyAdmin {
    _addTrustedOrganizations(_list);
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function updateTrustedOrganizations(TrustedOrganization[] calldata _list) external override onlyAdmin {
    require(_list.length > 0, "RoninTrustedOrganization: invalid array length");
    for (uint256 _i; _i < _list.length; _i++) {
      _updateTrustedOrganization(_list[_i]);
    }
    emit TrustedOrganizationsUpdated(_list);
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function removeTrustedOrganizations(address[] calldata _list) external override onlyAdmin {
    require(_list.length > 0, "RoninTrustedOrganization: invalid array length");
    for (uint _i = 0; _i < _list.length; _i++) {
      _removeTrustedOrganization(_list[_i]);
    }
    emit TrustedOrganizationsRemoved(_list);
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function totalWeights() external view virtual returns (uint256) {
    return _totalWeight;
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getConsensusWeight(address _consensusAddr) external view returns (uint256) {
    return _consensusWeight[_consensusAddr];
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getGovernorWeight(address _governor) external view returns (uint256) {
    return _governorWeight[_governor];
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getBridgeVoterWeight(address _addr) external view returns (uint256) {
    return _bridgeVoterWeight[_addr];
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getConsensusWeights(address[] calldata _list) external view returns (uint256[] memory _res) {
    _res = new uint256[](_list.length);
    for (uint _i = 0; _i < _res.length; _i++) {
      _res[_i] = _consensusWeight[_list[_i]];
    }
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getGovernorWeights(address[] calldata _list) external view returns (uint256[] memory _res) {
    _res = new uint256[](_list.length);
    for (uint _i = 0; _i < _res.length; _i++) {
      _res[_i] = _governorWeight[_list[_i]];
    }
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getBridgeVoterWeights(address[] calldata _list) external view returns (uint256[] memory _res) {
    _res = new uint256[](_list.length);
    for (uint _i = 0; _i < _res.length; _i++) {
      _res[_i] = _bridgeVoterWeight[_list[_i]];
    }
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function sumConsensusWeights(address[] calldata _list) external view returns (uint256 _res) {
    for (uint _i = 0; _i < _list.length; _i++) {
      _res += _consensusWeight[_list[_i]];
    }
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function sumGovernorWeights(address[] calldata _list) external view returns (uint256 _res) {
    for (uint _i = 0; _i < _list.length; _i++) {
      _res += _governorWeight[_list[_i]];
    }
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function sumBridgeVoterWeights(address[] calldata _list) external view returns (uint256 _res) {
    for (uint _i = 0; _i < _list.length; _i++) {
      _res += _bridgeVoterWeight[_list[_i]];
    }
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function countTrustedOrganizations() external view override returns (uint256) {
    return _consensusList.length;
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getAllTrustedOrganizations() external view override returns (TrustedOrganization[] memory _list) {
    _list = new TrustedOrganization[](_consensusList.length);
    address _addr;
    for (uint256 _i; _i < _list.length; _i++) {
      _addr = _consensusList[_i];
      _list[_i].consensusAddr = _addr;
      _list[_i].governor = _governorList[_i];
      _list[_i].bridgeVoter = _bridgeVoterList[_i];
      _list[_i].weight = _consensusWeight[_addr];
    }
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getTrustedOrganization(address _consensusAddr) external view returns (TrustedOrganization memory) {
    for (uint _i = 0; _i < _consensusList.length; _i++) {
      if (_consensusList[_i] == _consensusAddr) {
        return getTrustedOrganizationAt(_i);
      }
    }
    revert("RoninTrustedOrganization: query for non-existent consensus address");
  }

  /**
   * @inheritdoc IRoninTrustedOrganization
   */
  function getTrustedOrganizationAt(uint256 _idx) public view override returns (TrustedOrganization memory) {
    address _addr = _consensusList[_idx];
    return
      TrustedOrganization(
        _addr,
        _governorList[_idx],
        _bridgeVoterList[_idx],
        _consensusWeight[_addr],
        _addedBlock[_addr]
      );
  }

  /**
   * @dev Adds a list of trusted organizations.
   */
  function _addTrustedOrganizations(TrustedOrganization[] calldata _list) internal virtual {
    for (uint256 _i; _i < _list.length; _i++) {
      _addTrustedOrganization(_list[_i]);
    }
    emit TrustedOrganizationsAdded(_list);
  }

  /**
   * @dev Adds a trusted organization.
   *
   * Requirements:
   * - The weight is larger than 0.
   * - The consensus address is not added.
   * - The govenor address is not added.
   * - The bridge voter address is not added.
   *
   */
  function _addTrustedOrganization(TrustedOrganization memory _v) internal virtual {
    require(_v.addedBlock == 0, "RoninTrustedOrganization: invalid request");
    require(_v.weight > 0, "RoninTrustedOrganization: invalid weight");

    if (_consensusWeight[_v.consensusAddr] > 0) {
      revert(
        string(
          abi.encodePacked(
            "RoninTrustedOrganization: consensus address ",
            Strings.toHexString(uint160(_v.consensusAddr), 20),
            " is added already"
          )
        )
      );
    }

    if (_governorWeight[_v.governor] > 0) {
      revert(
        string(
          abi.encodePacked(
            "RoninTrustedOrganization: govenor address ",
            Strings.toHexString(uint160(_v.governor), 20),
            " is added already"
          )
        )
      );
    }

    if (_bridgeVoterWeight[_v.bridgeVoter] > 0) {
      revert(
        string(
          abi.encodePacked(
            "RoninTrustedOrganization: bridge voter address ",
            Strings.toHexString(uint160(_v.bridgeVoter), 20),
            " is added already"
          )
        )
      );
    }

    _consensusList.push(_v.consensusAddr);
    _consensusWeight[_v.consensusAddr] = _v.weight;

    _governorList.push(_v.governor);
    _governorWeight[_v.governor] = _v.weight;

    _bridgeVoterList.push(_v.bridgeVoter);
    _bridgeVoterWeight[_v.bridgeVoter] = _v.weight;

    _addedBlock[_v.consensusAddr] = block.number;

    _totalWeight += _v.weight;
  }

  /**
   * @dev Updates a trusted organization.
   *
   * Requirements:
   * - The weight is larger than 0.
   * - The consensus address is already added.
   *
   */
  function _updateTrustedOrganization(TrustedOrganization memory _v) internal virtual {
    require(_v.weight > 0, "RoninTrustedOrganization: invalid weight");

    uint256 _weight = _consensusWeight[_v.consensusAddr];
    if (_weight == 0) {
      revert(
        string(
          abi.encodePacked(
            "RoninTrustedOrganization: consensus address ",
            Strings.toHexString(uint160(_v.consensusAddr), 20),
            " is not added"
          )
        )
      );
    }

    uint256 _count = _consensusList.length;
    for (uint256 _i = 0; _i < _count; _i++) {
      if (_consensusList[_i] == _v.consensusAddr) {
        _totalWeight -= _weight;
        _totalWeight += _v.weight;

        if (_governorList[_i] != _v.governor) {
          require(_governorWeight[_v.governor] == 0, "RoninTrustedOrganization: query for duplicated governor");
          delete _governorWeight[_governorList[_i]];
          _governorList[_i] = _v.governor;
        }

        if (_bridgeVoterList[_i] != _v.bridgeVoter) {
          require(
            _bridgeVoterWeight[_v.bridgeVoter] == 0,
            "RoninTrustedOrganization: query for duplicated bridge voter"
          );
          delete _bridgeVoterWeight[_bridgeVoterList[_i]];
          _bridgeVoterList[_i] = _v.governor;
        }

        _consensusWeight[_v.consensusAddr] = _v.weight;
        _governorWeight[_v.governor] = _v.weight;
        _bridgeVoterWeight[_v.bridgeVoter] = _v.weight;
        return;
      }
    }
  }

  /**
   * @dev Removes a trusted organization.
   *
   * Requirements:
   * - The consensus address is added.
   *
   */
  function _removeTrustedOrganization(address _addr) internal virtual {
    uint256 _weight = _consensusWeight[_addr];
    if (_weight == 0) {
      revert(
        string(
          abi.encodePacked(
            "RoninTrustedOrganization: consensus address ",
            Strings.toHexString(uint160(_addr), 20),
            " is not added"
          )
        )
      );
    }

    uint256 _index;
    uint256 _count = _consensusList.length;
    for (uint256 _i = 0; _i < _count; _i++) {
      if (_consensusList[_i] == _addr) {
        _index = _i;
        break;
      }
    }

    _totalWeight -= _weight;

    delete _addedBlock[_addr];
    delete _consensusWeight[_addr];
    _consensusList[_index] = _consensusList[_count - 1];
    _consensusList.pop();

    delete _governorWeight[_governorList[_index]];
    _governorList[_index] = _governorList[_count - 1];
    _governorList.pop();

    delete _bridgeVoterWeight[_bridgeVoterList[_index]];
    _bridgeVoterList[_index] = _bridgeVoterList[_count - 1];
    _bridgeVoterList.pop();
  }

  /**
   * @dev Sets threshold and returns the old one.
   *
   * Emits the `ThresholdUpdated` event.
   *
   */
  function _setThreshold(uint256 _numerator, uint256 _denominator)
    internal
    virtual
    returns (uint256 _previousNum, uint256 _previousDenom)
  {
    require(_numerator <= _denominator, "RoninTrustedOrganization: invalid threshold");
    _previousNum = _num;
    _previousDenom = _denom;
    _num = _numerator;
    _denom = _denominator;
    emit ThresholdUpdated(_nonce++, _numerator, _denominator, _previousNum, _previousDenom);
  }
}
