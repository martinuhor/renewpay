// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Classifies one Kernel inner call. Used by the paymaster and the renew policy.
library CallGuard {
    address internal constant MANAGER = 0x51202A87aFdc07085e9586bc5E30a81a8cC4ff13;
    address internal constant TOKEN = 0x456569838f1d43009A91ebA4263147Afd7233483;

    /// @dev Two periods at a 10 tUSD8 cap. Finite, and enough for the demo form.
    uint256 internal constant MAX_MANAGER_APPROVAL = 20_000_000;
    uint256 internal constant MAX_PAYMASTER_APPROVAL = 100_000;

    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant SUBSCRIBE = 0x6ce07b7a;
    bytes4 internal constant RENEW = 0x391a20a7;
    bytes4 internal constant CANCEL = 0xd21f1ffc;
    bytes4 internal constant EXECUTE = 0xe9ae5c53;

    enum Kind {
        Reject,
        ApproveManager,
        ApprovePaymaster,
        Subscribe,
        Renew,
        Cancel,
        ClearAllowance
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function kind(address target, uint256 value, bytes memory data, address paymaster) internal pure returns (Kind) {
        if (value != 0 || data.length < 4) return Kind.Reject;
        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        if (target == TOKEN && selector == APPROVE && data.length == 68) {
            address spender;
            uint256 amount;
            assembly {
                spender := mload(add(data, 36))
                amount := mload(add(data, 68))
            }
            if (amount == 0 && (spender == MANAGER || (spender == paymaster && paymaster != address(0)))) {
                return Kind.ClearAllowance;
            }
            if (spender == MANAGER && amount > 0 && amount <= MAX_MANAGER_APPROVAL) return Kind.ApproveManager;
            if (spender == paymaster && paymaster != address(0) && amount > 0 && amount <= MAX_PAYMASTER_APPROVAL) {
                return Kind.ApprovePaymaster;
            }
            return Kind.Reject;
        }
        if (target != MANAGER) return Kind.Reject;
        if (selector == RENEW && data.length == 36) return Kind.Renew;
        if (selector == SUBSCRIBE && data.length == 132) return Kind.Subscribe;
        if (selector == CANCEL && data.length == 36) return Kind.Cancel;
        return Kind.Reject;
    }

    /// @dev Kernel v3.1 `execute(bytes32,bytes)`. Single call or a batch. Malformed payloads revert.
    function callsOf(bytes memory callData) internal pure returns (Call[] memory calls) {
        if (callData.length < 4) return calls;
        bytes4 selector;
        assembly {
            selector := mload(add(callData, 32))
        }
        if (selector != EXECUTE) return calls;
        bytes memory args = new bytes(callData.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = callData[i + 4];
        }
        (bytes32 mode, bytes memory execData) = abi.decode(args, (bytes32, bytes));
        bytes1 callType = bytes1(mode);
        if (callType == 0x00) {
            if (execData.length < 52) return calls;
            calls = new Call[](1);
            address target;
            uint256 value;
            assembly {
                target := shr(96, mload(add(execData, 32)))
                value := mload(add(execData, 52))
            }
            bytes memory data = new bytes(execData.length - 52);
            for (uint256 i = 0; i < data.length; i++) {
                data[i] = execData[i + 52];
            }
            calls[0] = Call(target, value, data);
            return calls;
        }
        if (callType == 0x01) {
            return abi.decode(execData, (Call[]));
        }
        return calls;
    }
}
