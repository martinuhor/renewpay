// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of ERC-20 SubscriptionManager needs. There is no approve.
interface IERC20Minimal {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
