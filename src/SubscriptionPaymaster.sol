// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CallGuard} from "./CallGuard.sol";

interface IEntryPointBalance {
    function depositTo(address account) external payable;
    function addStake(uint32 unstakeDelaySec) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

interface IFeeToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Sponsors subscribe, renew, and cancel, then pulls a flat tUSD8 fee.
/// The EntryPoint still spends tQDAY. This contract's deposit is that float.
contract SubscriptionPaymaster {
    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

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

    address public constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    uint256 public constant FEE = 10_000;

    address public owner;

    error NotEntryPoint();
    error NotOwner();
    error CallNotSponsored();
    error FeeTransferFailed();

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function fund(uint32 unstakeDelaySec) external payable {
        if (msg.sender != owner) revert NotOwner();
        uint256 forStake = msg.value / 4;
        if (forStake > 0) {
            IEntryPointBalance(ENTRY_POINT).addStake{value: forStake}(unstakeDelaySec);
        }
        IEntryPointBalance(ENTRY_POINT).depositTo{value: msg.value - forStake}(address(this));
    }

    function withdrawDeposit(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        IEntryPointBalance(ENTRY_POINT).withdrawTo(to, amount);
    }

    function withdrawFees(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (!IFeeToken(CallGuard.TOKEN).transfer(to, amount)) revert FeeTransferFailed();
    }

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        external
        view
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        if (!_sponsored(userOp.callData)) revert CallNotSponsored();
        return (abi.encode(userOp.sender), 0);
    }

    function postOp(PostOpMode mode, bytes calldata context, uint256, uint256) external {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        if (mode == PostOpMode.postOpReverted) return;
        address sender = abi.decode(context, (address));
        bool moved = _pull(sender);
        if (!moved && mode == PostOpMode.opSucceeded) revert FeeTransferFailed();
    }

    function _pull(address sender) internal returns (bool) {
        try IFeeToken(CallGuard.TOKEN).transferFrom(sender, owner, FEE) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _sponsored(bytes calldata callData) internal view returns (bool) {
        CallGuard.Call[] memory calls = CallGuard.callsOf(callData);
        if (calls.length == 0) return false;
        bool action = false;
        for (uint256 i = 0; i < calls.length; i++) {
            CallGuard.Kind kind = CallGuard.kind(calls[i].target, calls[i].value, calls[i].data, address(this));
            if (kind == CallGuard.Kind.Reject) return false;
            if (kind == CallGuard.Kind.Subscribe || kind == CallGuard.Kind.Renew || kind == CallGuard.Kind.Cancel) {
                action = true;
            }
        }
        return action;
    }
}
