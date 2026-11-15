// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Aevum} from "./Aevum.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {SessionKeyRegistry} from "./SessionKeyRegistry.sol";

/// @title SubscriptionManager
/// @notice tUSD8 subscription plans, session-key caps, and permissionless renewal on QDay Aevum.
/// @dev The plan amount is copied onto the subscription. There is no admin setter, so a merchant
///      cannot change the price of an existing subscription. The contract never calls approve.
///      An allowance of type(uint256).max is rejected. Failed renewals emit RenewalFailed and revert.
///      On the EVM a reverted transaction drops logs, so indexers should read the custom error.
contract SubscriptionManager {
    struct Plan {
        address merchant;
        uint256 amount;
        uint256 periodSeconds;
        uint256 trialSeconds;
        string metadataURI;
    }

    struct Subscription {
        address subscriber;
        address merchant;
        bytes32 planId;
        address sessionKey;
        uint256 spendingCapPerPeriod;
        uint256 expiry;
        uint256 amount;
        uint256 periodSeconds;
        uint256 paidUntil;
        bool cancelled;
        bool exists;
    }

    uint256 private constant _UNLOCKED = 1;
    uint256 private constant _LOCKED = 2;

    IERC20Minimal public immutable token;
    SessionKeyRegistry public immutable registry;

    uint256 private _status = _UNLOCKED;
    mapping(bytes32 planId => Plan plan) private _plans;
    mapping(bytes32 subscriptionId => Subscription subscription) private _subscriptions;

    error ZeroAddress();
    error ZeroAmount();
    error ZeroPeriod();
    error ZeroCap();
    error PlanExists();
    error PlanNotFound();
    error SubscriptionExists();
    error SubscriptionNotFound();
    error NotSubscriber();
    error AlreadyCancelled();
    error SubscriptionIsCancelled();
    error SessionKeyInactive();
    error SessionKeyExpired();
    error InvalidSessionKey();
    error ExpiryInPast();
    error CapExceeded(uint256 amount, uint256 cap);
    error PeriodNotDue(uint256 paidUntil, uint256 nowTs);
    error InsufficientBalance(uint256 balance, uint256 amount);
    error InsufficientAllowance(uint256 allowance, uint256 amount);
    error UnlimitedAllowance();
    error TransferFailed();
    error WrongSettlementToken();
    error TokenNotContract();
    error UnexpectedDecimals(uint8 got);
    error RegistryNotContract();
    error Reentrancy();

    event PlanCreated(
        bytes32 indexed planId,
        address indexed merchant,
        uint256 amount,
        uint256 periodSeconds,
        uint256 trialSeconds,
        string metadataURI
    );
    event Subscribed(
        bytes32 indexed subscriptionId,
        bytes32 indexed planId,
        address indexed subscriber,
        address sessionKey,
        uint256 spendingCapPerPeriod,
        uint256 expiry,
        uint256 charged,
        uint256 paidUntil
    );
    event SubscriptionRenewed(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed merchant,
        uint256 amount,
        uint256 paidUntil
    );
    event SubscriptionCancelled(bytes32 indexed subscriptionId, address indexed subscriber);
    event RenewalFailed(bytes32 indexed subscriptionId, bytes4 indexed errorSelector);

    modifier nonReentrant() {
        if (_status == _LOCKED) revert Reentrancy();
        _status = _LOCKED;
        _;
        _status = _UNLOCKED;
    }

    constructor(address token_, address registry_) {
        if (token_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        if (block.chainid == Aevum.CHAIN_ID && token_ != Aevum.TUSD8) revert WrongSettlementToken();
        if (token_.code.length == 0) revert TokenNotContract();
        if (registry_.code.length == 0) revert RegistryNotContract();

        (bool ok, bytes memory data) = token_.staticcall(abi.encodeWithSelector(IERC20Minimal.decimals.selector));
        if (!ok || data.length < 32) revert UnexpectedDecimals(0);
        uint8 decimals = abi.decode(data, (uint8));
        if (decimals != Aevum.TUSD8_DECIMALS) revert UnexpectedDecimals(decimals);

        token = IERC20Minimal(token_);
        registry = SessionKeyRegistry(registry_);
    }

    /// @notice Deterministic plan id. Identical merchant, price, period, trial, and metadata collide.
    function computePlanId(
        address merchant,
        uint256 amount,
        uint256 periodSeconds,
        uint256 trialSeconds,
        string calldata metadataURI
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(merchant, amount, periodSeconds, trialSeconds, keccak256(bytes(metadataURI))));
    }

    function computeSubscriptionId(address subscriber, bytes32 planId, address sessionKey)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(subscriber, planId, sessionKey));
    }

    /// @param trialSeconds Zero skips the trial and charges the first period inside subscribe.
    function createPlan(uint256 amount, uint256 periodSeconds, uint256 trialSeconds, string calldata metadataURI)
        external
        returns (bytes32 planId)
    {
        if (amount == 0) revert ZeroAmount();
        if (periodSeconds == 0) revert ZeroPeriod();

        planId = computePlanId(msg.sender, amount, periodSeconds, trialSeconds, metadataURI);
        if (_plans[planId].merchant != address(0)) revert PlanExists();

        _plans[planId] = Plan({
            merchant: msg.sender,
            amount: amount,
            periodSeconds: periodSeconds,
            trialSeconds: trialSeconds,
            metadataURI: metadataURI
        });

        emit PlanCreated(planId, msg.sender, amount, periodSeconds, trialSeconds, metadataURI);
    }

    function subscribe(bytes32 planId, address sessionKey, uint256 spendingCapPerPeriod, uint256 expiry)
        external
        nonReentrant
        returns (bytes32 subscriptionId)
    {
        Plan storage plan = _plans[planId];
        if (plan.merchant == address(0)) revert PlanNotFound();
        if (sessionKey == address(0)) revert InvalidSessionKey();
        if (spendingCapPerPeriod == 0) revert ZeroCap();
        if (expiry <= block.timestamp) revert ExpiryInPast();

        subscriptionId = computeSubscriptionId(msg.sender, planId, sessionKey);
        Subscription storage existing = _subscriptions[subscriptionId];
        if (existing.exists && !existing.cancelled) revert SubscriptionExists();

        uint256 amount = plan.amount;
        address merchant = plan.merchant;
        uint256 periodSeconds = plan.periodSeconds;
        uint256 trialSeconds = plan.trialSeconds;

        _subscriptions[subscriptionId] = Subscription({
            subscriber: msg.sender,
            merchant: merchant,
            planId: planId,
            sessionKey: sessionKey,
            spendingCapPerPeriod: spendingCapPerPeriod,
            expiry: expiry,
            amount: amount,
            periodSeconds: periodSeconds,
            paidUntil: block.timestamp + trialSeconds,
            cancelled: false,
            exists: true
        });

        registry.register(subscriptionId, msg.sender, sessionKey, spendingCapPerPeriod, expiry);

        uint256 charged;
        if (trialSeconds == 0) {
            _collect(subscriptionId, false);
            charged = amount;
        }

        emit Subscribed(
            subscriptionId,
            planId,
            msg.sender,
            sessionKey,
            spendingCapPerPeriod,
            expiry,
            charged,
            _subscriptions[subscriptionId].paidUntil
        );
    }

    /// @notice Permissionless. A keeper, the merchant, or the subscriber may call it.
    function renewSubscription(bytes32 subscriptionId) external nonReentrant {
        if (!_subscriptions[subscriptionId].exists) revert SubscriptionNotFound();
        _collect(subscriptionId, true);
    }

    /// @notice Subscriber only. Revokes the session key so a later renewal cannot collect.
    function cancelSubscription(bytes32 subscriptionId) external nonReentrant {
        Subscription storage sub = _subscriptions[subscriptionId];
        if (!sub.exists) revert SubscriptionNotFound();
        if (msg.sender != sub.subscriber) revert NotSubscriber();
        if (sub.cancelled) revert AlreadyCancelled();

        sub.cancelled = true;
        registry.revoke(subscriptionId);
        emit SubscriptionCancelled(subscriptionId, msg.sender);
    }

    function getPlan(bytes32 planId) external view returns (Plan memory plan) {
        plan = _plans[planId];
        if (plan.merchant == address(0)) revert PlanNotFound();
    }

    function getSubscription(bytes32 subscriptionId) external view returns (Subscription memory sub) {
        sub = _subscriptions[subscriptionId];
        if (!sub.exists) revert SubscriptionNotFound();
    }

    function _collect(bytes32 subscriptionId, bool renewal) internal {
        Subscription storage sub = _subscriptions[subscriptionId];

        if (sub.cancelled) {
            _reject(subscriptionId, renewal, SubscriptionIsCancelled.selector);
            revert SubscriptionIsCancelled();
        }

        SessionKeyRegistry.Authorization memory auth = registry.authorization(subscriptionId);
        if (!auth.exists || auth.revoked || auth.key != sub.sessionKey || auth.subscriber != sub.subscriber) {
            _reject(subscriptionId, renewal, SessionKeyInactive.selector);
            revert SessionKeyInactive();
        }
        if (block.timestamp >= auth.expiry) {
            _reject(subscriptionId, renewal, SessionKeyExpired.selector);
            revert SessionKeyExpired();
        }
        if (renewal && block.timestamp < sub.paidUntil) {
            _reject(subscriptionId, renewal, PeriodNotDue.selector);
            revert PeriodNotDue(sub.paidUntil, block.timestamp);
        }

        uint256 amount = sub.amount;
        if (amount > auth.spendingCapPerPeriod) {
            _reject(subscriptionId, renewal, CapExceeded.selector);
            revert CapExceeded(amount, auth.spendingCapPerPeriod);
        }

        uint256 balance = token.balanceOf(sub.subscriber);
        if (balance < amount) {
            _reject(subscriptionId, renewal, InsufficientBalance.selector);
            revert InsufficientBalance(balance, amount);
        }

        uint256 allowance = token.allowance(sub.subscriber, address(this));
        if (allowance == type(uint256).max) {
            _reject(subscriptionId, renewal, UnlimitedAllowance.selector);
            revert UnlimitedAllowance();
        }
        if (allowance < amount) {
            _reject(subscriptionId, renewal, InsufficientAllowance.selector);
            revert InsufficientAllowance(allowance, amount);
        }

        if (renewal) sub.paidUntil += sub.periodSeconds;
        else sub.paidUntil = block.timestamp + sub.periodSeconds;

        _transferFrom(sub.subscriber, sub.merchant, amount);

        if (renewal) {
            emit SubscriptionRenewed(subscriptionId, sub.subscriber, sub.merchant, amount, sub.paidUntil);
        }
    }

    function _reject(bytes32 subscriptionId, bool renewal, bytes4 selector) internal {
        if (renewal) emit RenewalFailed(subscriptionId, selector);
    }

    function _transferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
