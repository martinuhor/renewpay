// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Published QDay Aevum testnet parameters. Week 1 does not store a paymaster address.
library Aevum {
    uint256 internal constant CHAIN_ID = 44005;
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    uint8 internal constant TUSD8_DECIMALS = 6;
}
