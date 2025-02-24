// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

interface IHasRoninGovernanceAdminContract {
  /// @dev Emitted when the ronin governance admin contract is updated.
  event RoninGovernanceAdminContractUpdated(address);

  /**
   * @dev Returns the ronin governance admin contract.
   */
  function roninGovernanceAdminContract() external view returns (address);

  /**
   * @dev Sets the ronin governance admin contract.
   *
   * Requirements:
   * - The method caller is admin.
   * - The new address is a contract.
   *
   * Emits the event `RoninGovernanceAdminContractUpdated`.
   *
   */
  function setRoninGovernanceAdminContract(address) external;
}
