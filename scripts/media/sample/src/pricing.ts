const COUPONS: Record<string, number> = {
  WELCOME10: 0.1,
  SPRING25: 0.25,
};

const TAX_RATES: Record<string, number> = {
  "us-ca": 0.0725,
  "us-ny": 0.04,
  default: 0.05,
};

/** Unknown or missing coupons leave the amount unchanged. */
export function applyDiscount(amount: number, code?: string) {
  if (!code) return amount;
  const rate = COUPONS[code.toUpperCase()] ?? 0;
  return amount * (1 - rate);
}

/** Tax is computed on the amount it receives, so call it last. */
export function addTax(amount: number, region: string) {
  const rate = TAX_RATES[region] ?? TAX_RATES.default;
  return amount * (1 + rate);
}

export function roundToCents(amount: number) {
  return Math.round(amount * 100) / 100;
}
