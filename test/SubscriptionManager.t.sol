// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {SessionKeyRegistry} from "../src/SessionKeyRegistry.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";
import {Aevum} from "../src/Aevum.sol";

contract SubscriptionManagerTest is Test {
    uint256 internal constant AMOUNT = 9_990_000;
    uint256 internal constant CAP = 10_000_000;
    uint256 internal constant PERIOD = 30 days;
    uint256 internal constant START = 1_000_000;
    string internal constant METADATA = "ipfs://renewpay/pro";

    MockTUSD8 internal token;
    SessionKeyRegistry internal registry;
    SubscriptionManager internal manager;

    address internal merchant = makeAddr("merchant");
    address internal subscriber = makeAddr("subscriber");
    address internal sessionKey = makeAddr("sessionKey");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(START);
        token = new MockTUSD8(Aevum.TUSD8_DECIMALS);
        registry = new SessionKeyRegistry();
        manager = new SubscriptionManager(address(token), address(registry));
        registry.setManager(address(manager));

        token.mint(subscriber, 2_000_000_000);
        vm.prank(subscriber);
        token.approve(address(manager), 500_000_000);
    }

    function test_createPlan() public {
        bytes32 expected = manager.computePlanId(merchant, AMOUNT, PERIOD, 0, METADATA);

        vm.prank(merchant);
        bytes32 planId = manager.createPlan(AMOUNT, PERIOD, 0, METADATA);

        assertEq(planId, expected);
        SubscriptionManager.Plan memory plan = manager.getPlan(planId);
        assertEq(plan.merchant, merchant);
        assertEq(plan.amount, AMOUNT);
        assertEq(plan.periodSeconds, PERIOD);
        assertEq(plan.trialSeconds, 0);
        assertEq(plan.metadataURI, METADATA);

        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.PlanExists.selector);
        manager.createPlan(AMOUNT, PERIOD, 0, METADATA);

        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.ZeroAmount.selector);
        manager.createPlan(0, PERIOD, 0, METADATA);

        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.ZeroPeriod.selector);
        manager.createPlan(AMOUNT, 0, 0, METADATA);

        address otherMerchant = makeAddr("otherMerchant");
        vm.prank(otherMerchant);
        bytes32 otherId = manager.createPlan(AMOUNT, PERIOD, 0, METADATA);
        assertTrue(otherId != planId);
    }

    function test_subscribe() public {
        bytes32 planId = _createPlan(0);
        uint256 expiry = block.timestamp + 365 days;
        uint256 merchantBefore = token.balanceOf(merchant);
        uint256 subscriberBefore = token.balanceOf(subscriber);

        bytes32 subId = _subscribe(planId, CAP, expiry);

        assertEq(subId, manager.computeSubscriptionId(subscriber, planId, sessionKey));
        SubscriptionManager.Subscription memory sub = manager.getSubscription(subId);
        assertEq(sub.subscriber, subscriber);
        assertEq(sub.merchant, merchant);
        assertEq(sub.planId, planId);
        assertEq(sub.sessionKey, sessionKey);
        assertEq(sub.spendingCapPerPeriod, CAP);
        assertEq(sub.expiry, expiry);
        assertEq(sub.amount, AMOUNT);
        assertEq(sub.periodSeconds, PERIOD);
        assertEq(sub.paidUntil, START + PERIOD);
        assertFalse(sub.cancelled);
        assertEq(token.balanceOf(merchant), merchantBefore + AMOUNT);
        assertEq(token.balanceOf(subscriber), subscriberBefore - AMOUNT);

        SessionKeyRegistry.Authorization memory auth = registry.authorization(subId);
        assertTrue(auth.exists);
        assertFalse(auth.revoked);
        assertFalse(auth.expired);
        assertEq(auth.key, sessionKey);
        assertEq(auth.subscriber, subscriber);
        assertEq(auth.spendingCapPerPeriod, CAP);
    }

    function test_renewWithinCap() public {
        bytes32 planId = _createPlan(0);
        bytes32 subId = _subscribe(planId, CAP, block.timestamp + 365 days);
        uint256 openedAt = START;
        uint256 merchantBefore = token.balanceOf(merchant);

        vm.warp(openedAt + PERIOD);
        vm.prank(keeper);
        manager.renewSubscription(subId);

        assertEq(token.balanceOf(merchant), merchantBefore + AMOUNT);
        assertEq(manager.getSubscription(subId).paidUntil, openedAt + (PERIOD * 2));
        assertEq(manager.getSubscription(subId).amount, AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(
                SubscriptionManager.PeriodNotDue.selector, openedAt + (PERIOD * 2), openedAt + PERIOD
            )
        );
        vm.prank(keeper);
        manager.renewSubscription(subId);
    }

    function test_renewOverCap() public {
        bytes32 planId = _createPlan(1 days);
        uint256 balanceBefore = token.balanceOf(subscriber);
        uint256 lowCap = AMOUNT - 1;
        bytes32 subId = _subscribe(planId, lowCap, block.timestamp + 365 days);

        assertEq(token.balanceOf(subscriber), balanceBefore);
        assertEq(manager.getSubscription(subId).paidUntil, START + 1 days);

        vm.warp(START + 1 days);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionManager.CapExceeded.selector, AMOUNT, lowCap));
        vm.prank(keeper);
        manager.renewSubscription(subId);
        assertEq(token.balanceOf(subscriber), balanceBefore);
    }

    function test_cancelThenRenewReverts() public {
        bytes32 planId = _createPlan(0);
        bytes32 subId = _subscribe(planId, CAP, block.timestamp + 365 days);

        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.NotSubscriber.selector);
        manager.cancelSubscription(subId);

        vm.prank(subscriber);
        manager.cancelSubscription(subId);
        assertTrue(manager.getSubscription(subId).cancelled);
        assertTrue(registry.authorization(subId).revoked);

        vm.warp(START + PERIOD);
        vm.expectRevert(SubscriptionManager.SubscriptionIsCancelled.selector);
        vm.prank(keeper);
        manager.renewSubscription(subId);
    }

    function test_renewAfterExpiryReverts() public {
        uint256 period = 7 days;
        uint256 expiry = block.timestamp + 8 days;

        vm.prank(merchant);
        bytes32 planId = manager.createPlan(AMOUNT, period, 0, "expiry-plan");
        vm.prank(subscriber);
        bytes32 subId = manager.subscribe(planId, sessionKey, CAP, expiry);

        vm.warp(expiry);
        vm.expectRevert(SubscriptionManager.SessionKeyExpired.selector);
        vm.prank(keeper);
        manager.renewSubscription(subId);
    }

    function test_rejectsUnlimitedAllowance() public {
        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        bytes32 planId = _createPlan(0);

        vm.expectRevert(SubscriptionManager.UnlimitedAllowance.selector);
        vm.prank(subscriber);
        manager.subscribe(planId, sessionKey, CAP, block.timestamp + 365 days);
    }

    function test_priceDoesNotChangeMidSubscription() public {
        bytes32 planId = _createPlan(0);
        bytes32 subId = _subscribe(planId, CAP, block.timestamp + 365 days);
        assertEq(manager.getPlan(planId).amount, AMOUNT);
        assertEq(manager.getSubscription(subId).amount, AMOUNT);

        vm.warp(START + PERIOD);
        uint256 before = token.balanceOf(merchant);
        vm.prank(keeper);
        manager.renewSubscription(subId);

        assertEq(token.balanceOf(merchant) - before, AMOUNT);
        assertEq(manager.getPlan(planId).amount, AMOUNT);
        assertEq(manager.getSubscription(subId).amount, AMOUNT);
    }

    function test_renewInsufficientBalance() public {
        bytes32 planId = _createPlan(0);
        bytes32 subId = _subscribe(planId, CAP, block.timestamp + 365 days);

        uint256 leftover = token.balanceOf(subscriber);
        vm.prank(subscriber);
        token.transfer(address(1), leftover);

        vm.warp(START + PERIOD);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionManager.InsufficientBalance.selector, 0, AMOUNT));
        vm.prank(keeper);
        manager.renewSubscription(subId);
    }

    function test_renewInsufficientAllowance() public {
        vm.prank(subscriber);
        token.approve(address(manager), AMOUNT);
        bytes32 planId = _createPlan(0);
        bytes32 subId = _subscribe(planId, CAP, block.timestamp + 365 days);

        vm.warp(START + PERIOD);
        vm.expectRevert(abi.encodeWithSelector(SubscriptionManager.InsufficientAllowance.selector, 0, AMOUNT));
        vm.prank(keeper);
        manager.renewSubscription(subId);
    }

    function test_aevumRejectsOtherToken() public {
        vm.chainId(Aevum.CHAIN_ID);
        vm.expectRevert(SubscriptionManager.WrongSettlementToken.selector);
        new SubscriptionManager(address(token), address(registry));
    }

    function test_registryOnlyManagerWrites() public {
        vm.expectRevert(SessionKeyRegistry.NotManager.selector);
        registry.register(bytes32("sub"), subscriber, sessionKey, CAP, block.timestamp + 1 days);
    }

    function _createPlan(uint256 trialSeconds) internal returns (bytes32 planId) {
        vm.prank(merchant);
        planId = manager.createPlan(AMOUNT, PERIOD, trialSeconds, METADATA);
    }

    function _subscribe(bytes32 planId, uint256 cap, uint256 expiry) internal returns (bytes32 subId) {
        vm.prank(subscriber);
        subId = manager.subscribe(planId, sessionKey, cap, expiry);
    }
}
