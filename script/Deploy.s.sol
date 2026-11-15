// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Aevum} from "../src/Aevum.sol";
import {SessionKeyRegistry} from "../src/SessionKeyRegistry.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";

/// @notice Deploys SessionKeyRegistry and SubscriptionManager.
///         On Aevum (chain id 44005) the token must be tUSD8.
///
///         forge script script/Deploy.s.sol \
///           --rpc-url https://rpc-test.qday.info \
///           --private-key $DEPLOYER_PRIVATE_KEY \
///           --broadcast
contract Deploy is Script {
    function run() external {
        address token = vm.envOr("TUSD8_ADDRESS", Aevum.TUSD8);
        if (block.chainid == Aevum.CHAIN_ID && token != Aevum.TUSD8) {
            revert("Aevum deployments must use tUSD8 0x456569838f1d43009A91ebA4263147Afd7233483");
        }

        vm.startBroadcast();
        SessionKeyRegistry registry = new SessionKeyRegistry();
        SubscriptionManager manager = new SubscriptionManager(token, address(registry));
        registry.setManager(address(manager));
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("tUSD8", token);
        console2.log("SessionKeyRegistry", address(registry));
        console2.log("SubscriptionManager", address(manager));
    }
}
