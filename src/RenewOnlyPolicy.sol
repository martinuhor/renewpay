// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CallGuard} from "./CallGuard.sol";

/// @notice Kernel v3.1 call policy. The session key may renew, and may refresh a finite
/// manager allowance in that same operation. It cannot transfer tokens or cancel.
contract RenewOnlyPolicy {
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    function onInstall(bytes calldata) external payable {}

    function onUninstall(bytes calldata) external payable {}

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 5;
    }

    function isInitialized(address) external pure returns (bool) {
        return false;
    }

    function checkUserOpPolicy(bytes32, PackedUserOperation calldata userOp) external pure returns (uint256) {
        return _renewOnly(userOp.callData) ? 0 : SIG_VALIDATION_FAILED;
    }

    function checkSignaturePolicy(bytes32, address, bytes32, bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function _renewOnly(bytes calldata callData) internal pure returns (bool) {
        CallGuard.Call[] memory calls = CallGuard.callsOf(callData);
        if (calls.length == 0) return false;
        bool renewed = false;
        for (uint256 i = 0; i < calls.length; i++) {
            CallGuard.Kind kind = CallGuard.kind(calls[i].target, calls[i].value, calls[i].data, address(0));
            if (kind == CallGuard.Kind.Renew) renewed = true;
            else if (kind != CallGuard.Kind.ApproveManager) return false;
        }
        return renewed;
    }
}
