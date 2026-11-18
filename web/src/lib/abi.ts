export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/**
 * Public surface of SubscriptionManager on main.
 * Selectors match the bytecode at the live manager. There is no extra
 * `_emitSubscribed` entry point to call.
 */
export const managerAbi = [
  {
    type: "function",
    name: "createPlan",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "periodSeconds", type: "uint256" },
      { name: "trialSeconds", type: "uint256" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "planId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "subscribe",
    stateMutability: "nonpayable",
    inputs: [
      { name: "planId", type: "bytes32" },
      { name: "sessionKey", type: "address" },
      { name: "spendingCapPerPeriod", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
    outputs: [{ name: "subscriptionId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "renewSubscription",
    stateMutability: "nonpayable",
    inputs: [{ name: "subscriptionId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelSubscription",
    stateMutability: "nonpayable",
    inputs: [{ name: "subscriptionId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getPlan",
    stateMutability: "view",
    inputs: [{ name: "planId", type: "bytes32" }],
    outputs: [
      {
        name: "plan",
        type: "tuple",
        components: [
          { name: "merchant", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "periodSeconds", type: "uint256" },
          { name: "trialSeconds", type: "uint256" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getSubscription",
    stateMutability: "view",
    inputs: [{ name: "subscriptionId", type: "bytes32" }],
    outputs: [
      {
        name: "sub",
        type: "tuple",
        components: [
          { name: "subscriber", type: "address" },
          { name: "merchant", type: "address" },
          { name: "planId", type: "bytes32" },
          { name: "sessionKey", type: "address" },
          { name: "spendingCapPerPeriod", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "amount", type: "uint256" },
          { name: "periodSeconds", type: "uint256" },
          { name: "paidUntil", type: "uint256" },
          { name: "cancelled", type: "bool" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "computePlanId",
    stateMutability: "pure",
    inputs: [
      { name: "merchant", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "periodSeconds", type: "uint256" },
      { name: "trialSeconds", type: "uint256" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "computeSubscriptionId",
    stateMutability: "pure",
    inputs: [
      { name: "subscriber", type: "address" },
      { name: "planId", type: "bytes32" },
      { name: "sessionKey", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "registry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "PlanCreated",
    inputs: [
      { name: "planId", type: "bytes32", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "periodSeconds", type: "uint256", indexed: false },
      { name: "trialSeconds", type: "uint256", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Subscribed",
    inputs: [
      { name: "subscriptionId", type: "bytes32", indexed: true },
      { name: "planId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "sessionKey", type: "address", indexed: false },
      { name: "spendingCapPerPeriod", type: "uint256", indexed: false },
      { name: "expiry", type: "uint256", indexed: false },
      { name: "charged", type: "uint256", indexed: false },
      { name: "paidUntil", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubscriptionRenewed",
    inputs: [
      { name: "subscriptionId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "paidUntil", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubscriptionCancelled",
    inputs: [
      { name: "subscriptionId", type: "bytes32", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
    ],
  },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroPeriod", inputs: [] },
  { type: "error", name: "ZeroCap", inputs: [] },
  { type: "error", name: "PlanExists", inputs: [] },
  { type: "error", name: "PlanNotFound", inputs: [] },
  { type: "error", name: "SubscriptionExists", inputs: [] },
  { type: "error", name: "SubscriptionNotFound", inputs: [] },
  { type: "error", name: "NotSubscriber", inputs: [] },
  { type: "error", name: "AlreadyCancelled", inputs: [] },
  { type: "error", name: "SubscriptionIsCancelled", inputs: [] },
  { type: "error", name: "SessionKeyInactive", inputs: [] },
  { type: "error", name: "SessionKeyExpired", inputs: [] },
  { type: "error", name: "InvalidSessionKey", inputs: [] },
  { type: "error", name: "ExpiryInPast", inputs: [] },
  {
    type: "error",
    name: "CapExceeded",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "PeriodNotDue",
    inputs: [
      { name: "paidUntil", type: "uint256" },
      { name: "nowTs", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      { name: "balance", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientAllowance",
    inputs: [
      { name: "allowance", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
  },
  { type: "error", name: "UnlimitedAllowance", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "Reentrancy", inputs: [] },
] as const;
