// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SessionKeyRegistry
/// @notice Stores the session key bound to a subscription: cap, expiry, and revocation.
///         SubscriptionManager is the only writer. Week 1 records the key address.
///         It does not verify ERC-4337 signatures.
contract SessionKeyRegistry {
    struct SessionKey {
        address subscriber;
        address key;
        uint256 spendingCapPerPeriod;
        uint256 expiry;
        bool revoked;
        bool exists;
    }

    struct Authorization {
        bool exists;
        bool revoked;
        bool expired;
        address subscriber;
        address key;
        uint256 spendingCapPerPeriod;
        uint256 expiry;
    }

    address public deployer;
    address public manager;

    mapping(bytes32 subscriptionId => SessionKey key) private _keys;

    error ZeroAddress();
    error ManagerAlreadySet();
    error NotDeployer();
    error NotManager();
    error AlreadyRegistered();
    error NotRegistered();
    error ManagerNotContract();

    event ManagerSet(address indexed manager);
    event SessionKeyRegistered(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed sessionKey,
        uint256 spendingCapPerPeriod,
        uint256 expiry
    );
    event SessionKeyRevoked(bytes32 indexed subscriptionId, address indexed subscriber, address indexed sessionKey);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-shot. The deploying account points the registry at SubscriptionManager.
    function setManager(address manager_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (manager != address(0)) revert ManagerAlreadySet();
        if (manager_ == address(0)) revert ZeroAddress();
        if (manager_.code.length == 0) revert ManagerNotContract();
        manager = manager_;
        emit ManagerSet(manager_);
    }

    function register(
        bytes32 subscriptionId,
        address subscriber,
        address sessionKey,
        uint256 spendingCapPerPeriod,
        uint256 expiry
    ) external onlyManager {
        SessionKey storage existing = _keys[subscriptionId];
        if (existing.exists && !existing.revoked) revert AlreadyRegistered();
        if (subscriber == address(0) || sessionKey == address(0)) revert ZeroAddress();

        _keys[subscriptionId] = SessionKey({
            subscriber: subscriber,
            key: sessionKey,
            spendingCapPerPeriod: spendingCapPerPeriod,
            expiry: expiry,
            revoked: false,
            exists: true
        });

        emit SessionKeyRegistered(subscriptionId, subscriber, sessionKey, spendingCapPerPeriod, expiry);
    }

    function revoke(bytes32 subscriptionId) external onlyManager {
        SessionKey storage existing = _keys[subscriptionId];
        if (!existing.exists || existing.revoked) revert NotRegistered();
        existing.revoked = true;
        emit SessionKeyRevoked(subscriptionId, existing.subscriber, existing.key);
    }

    function authorization(bytes32 subscriptionId) external view returns (Authorization memory auth) {
        SessionKey storage existing = _keys[subscriptionId];
        auth.exists = existing.exists;
        auth.revoked = existing.revoked;
        auth.expired = existing.exists && block.timestamp >= existing.expiry;
        auth.subscriber = existing.subscriber;
        auth.key = existing.key;
        auth.spendingCapPerPeriod = existing.spendingCapPerPeriod;
        auth.expiry = existing.expiry;
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }
}
