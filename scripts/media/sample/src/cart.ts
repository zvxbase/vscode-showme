import { applyDiscount, addTax, roundToCents } from "./pricing";

export interface LineItem {
  sku: string;
  unitPrice: number; // in dollars
  quantity: number;
}

export interface Cart {
  items: LineItem[];
  couponCode?: string;
  region: string;
}

/** Sum of unit price x quantity, before any discount or tax. */
export function subtotal(cart: Cart): number {
  return cart.items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
}

/**
 * The amount the customer pays at checkout.
 * The coupon is applied first, then tax.
 */
export function cartTotal(cart: Cart): number {
  const base = subtotal(cart);
  const discounted = applyDiscount(base, cart.couponCode);
  const taxed = addTax(discounted, cart.region);
  return roundToCents(taxed);
}

export function isEmpty(cart: Cart): boolean {
  return cart.items.length === 0;
}
