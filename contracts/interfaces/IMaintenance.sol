// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

interface IMaintenance {
  struct Schedule {
    uint256 from;
    uint256 to;
    uint256 lastUpdatedBlock;
  }

  /// @dev Emitted when a maintenance is scheduled.
  event MaintenanceScheduled(address indexed consensusAddr, Schedule);
  /// @dev Emitted when the maintenance config is updated.
  event MaintenanceConfigUpdated(
    uint256 minMaintenanceDurationInBlock,
    uint256 maxMaintenanceDurationInBlock,
    uint256 minOffsetToStartSchedule,
    uint256 maxOffsetToStartSchedule,
    uint256 maxSchedules
  );

  /**
   * @dev Returns whether the validator `_consensusAddr` is maintaining at the block number `_block`.
   */
  function maintaining(address _consensusAddr, uint256 _block) external view returns (bool);

  /**
   * @dev Returns whether the validator `_consensusAddr` was maintaining in the inclusive range [`_fromBlock`, `_toBlock`] of blocks.
   */
  function maintainingInBlockRange(
    address _consensusAddr,
    uint256 _fromBlock,
    uint256 _toBlock
  ) external view returns (bool);

  /**
   * @dev Returns the bool array indicating the validator is maintaining or not.
   */
  function bulkMaintaining(address[] calldata _addrList, uint256 _block) external view returns (bool[] memory);

  /**
   * @dev Returns a bool array indicating the validator was maintaining in the inclusive range [`_fromBlock`, `_toBlock`] of blocks or not.
   */
  function bulkMaintainingInBlockRange(
    address[] calldata _addrList,
    uint256 _fromBlock,
    uint256 _toBlock
  ) external view returns (bool[] memory);

  /**
   * @dev Returns whether the validator `_consensusAddr` has scheduled.
   */
  function scheduled(address _consensusAddr) external view returns (bool);

  /**
   * @dev Returns the detailed schedule of the validator `_consensusAddr`.
   */
  function getSchedule(address _consensusAddr) external view returns (Schedule memory);

  /**
   * @dev Returns the min duration for maintenance in block.
   */
  function minMaintenanceDurationInBlock() external view returns (uint256);

  /**
   * @dev Returns the max duration for maintenance in block.
   */
  function maxMaintenanceDurationInBlock() external view returns (uint256);

  /**
   * @dev Sets the duration restriction, start time restriction, and max allowed for maintenance.
   *
   * Requirements:
   * - The method caller is admin.
   * - The max duration is larger than the min duration.
   * - The max offset is larger than the min offset.
   *
   * Emits the event `MaintenanceConfigUpdated`.
   *
   */
  function setMaintenanceConfig(
    uint256 _minMaintenanceDurationInBlock,
    uint256 _maxMaintenanceDurationInBlock,
    uint256 _minOffsetToStartSchedule,
    uint256 _maxOffsetToStartSchedule,
    uint256 _maxSchedules
  ) external;

  /**
   * @dev The offset to the min block number that the schedule can start
   */
  function minOffsetToStartSchedule() external view returns (uint256);

  /**
   * @dev The offset to the max block number that the schedule can start
   */
  function maxOffsetToStartSchedule() external view returns (uint256);

  /**
   * @dev Returns the max number of scheduled maintenances.
   */
  function maxSchedules() external view returns (uint256);

  /**
   * @dev Returns the total of current schedules.
   */
  function totalSchedules() external view returns (uint256 _count);

  /**
   * @dev Schedules for maintenance from `_startedAtBlock` to `_startedAtBlock`.
   *
   * Requirements:
   * - The candidate `_consensusAddr` is the block producer.
   * - The method caller is candidate admin of the candidate `_consensusAddr`.
   * - The candidate `_consensusAddr` has no schedule yet or the previous is done.
   * - The total number of schedules is not larger than `maxSchedules()`.
   * - The start block must be at least `minOffsetToStartSchedule()` and at most `maxOffsetToStartSchedule()` blocks from the current block.
   * - The end block is larger than the start block.
   * - The scheduled duration is larger than the `minMaintenanceDurationInBlock()` and less than the `maxMaintenanceDurationInBlock()`.
   * - The start block is at the start of an epoch.
   * - The end block is at the end of an epoch.
   *
   * Emits the event `MaintenanceScheduled`.
   *
   */
  function schedule(
    address _consensusAddr,
    uint256 _startedAtBlock,
    uint256 _endedAtBlock
  ) external;
}
