// storefront in-memory store: the records every domain reads and writes, and
// the request context handed to each domain handler.
//
// One Store backs one storefront instance (createStorefront in src/index.ts), so
// a test can start from a fresh, seeded catalog. The deployed Worker keeps one
// instance per isolate (demo data, not durable).

import type { Money } from "./contracts/money.ts";

export interface Category {
  id: string;
  name: string;
}

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  price: Money;
}

export interface CartLine {
  productId: string;
  qty: number;
}

export interface OrderLine {
  productId: string;
  name: string;
  qty: number;
  unitPrice: Money;
}

export interface Order {
  id: string;
  region: string;
  lines: OrderLine[];
  subtotal: Money;
  tax: Money;
  total: Money;
  invoiceId: string;
}

export interface Invoice {
  id: string;
  orderId: string;
  region: string;
  lines: OrderLine[];
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: Money;
}

export interface Refund {
  id: string;
  paymentId: string;
  amount: Money;
}

export interface Store {
  categories: Category[];
  products: Product[];
  cart: CartLine[];
  orders: Order[];
  invoices: Invoice[];
  payments: Payment[];
  refunds: Refund[];
  /** The next id for a record kind, for example nextId("ord") is "ord-1". */
  nextId(prefix: string): string;
}

/** What a domain handler receives besides the request. */
export interface Ctx {
  store: Store;
  url: URL;
  /** The path segments, for example ["products", "p1"]. */
  parts: string[];
}

/** A fresh store with the seeded catalog. */
export function createStore(): Store {
  const counters = new Map<string, number>();
  return {
    categories: [
      { id: "c1", name: "Drinkware" },
      { id: "c2", name: "Brewing" },
      { id: "c3", name: "Coffee and tea" },
    ],
    products: [
      { id: "p1", name: "Espresso mug", categoryId: "c1", price: 19.99 },
      { id: "p2", name: "Travel tumbler", categoryId: "c1", price: 24.5 },
      { id: "p3", name: "Pour-over kettle", categoryId: "c2", price: 45 },
      { id: "p4", name: "Paper filters", categoryId: "c2", price: 1.15 },
      { id: "p5", name: "Tea sampler", categoryId: "c3", price: 5 },
      { id: "p6", name: "House blend beans", categoryId: "c3", price: 16.29 },
    ],
    cart: [],
    orders: [],
    invoices: [],
    payments: [],
    refunds: [],
    nextId(prefix: string): string {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-${next}`;
    },
  };
}
