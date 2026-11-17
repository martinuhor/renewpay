export const DEMO_PLAN_KEY = "renewpay.planId";
export const DEMO_FUNDED_KEY = "renewpay.funded";
export const DEMO_SUBSCRIPTION_KEY = "renewpay.subscriptionId";
export const DEMO_RENEWED_KEY = "renewpay.renewed";
export const DEMO_CANCELLED_KEY = "renewpay.cancelled";

export function markDemo(key: string, value: string): void {
  localStorage.setItem(key, value);
  window.dispatchEvent(new Event("renewpay-demo"));
}

export function readDemo(key: string): string {
  return localStorage.getItem(key) ?? "";
}
