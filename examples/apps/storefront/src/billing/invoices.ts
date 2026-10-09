// storefront billing: invoices.
//
// Checkout opens one invoice per order (createInvoice). An invoice restates the
// order's lines and tax, and tracks what has been paid against it: payments add
// to it and refunds take back from it.
//
// Routes:
//   GET /invoices?limit=&offset=  a page of invoices, newest first
//   GET /invoices/:id             one invoice with its totals and balance
//   GET /invoices/:id/receipt     a plain-text receipt

import { format } from "../contracts/money.ts";
import { json, problem } from "../contracts/http.ts";
import type { Ctx, Invoice, Order, Store } from "../store.ts";
import { taxRate } from "./tax.ts";

/** Open the invoice for a new order. */
export function createInvoice(store: Store, order: Order): Invoice {
  const invoice: Invoice = {
    id: store.nextId("inv"),
    orderId: order.id,
    region: order.region,
    lines: order.lines.map((l) => ({ ...l })),
  };
  store.invoices.push(invoice);
  return invoice;
}

/** An invoice's totals, in dollars. */
export interface InvoiceTotals {
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  refunded: number;
  balance: number;
}

/** Compute an invoice's totals from its lines and the payments against it. */
export function invoiceTotals(store: Store, invoice: Invoice): InvoiceTotals {
  let subtotal = 0;
  for (const line of invoice.lines) {
    subtotal += line.unitPrice * line.qty;
  }
  const tax = Math.round(subtotal * taxRate(invoice.region) * 100) / 100;
  const total = subtotal + tax;
  const payments = store.payments.filter((p) => p.invoiceId === invoice.id);
  let paid = 0;
  for (const payment of payments) {
    paid += payment.amount;
  }
  let refunded = 0;
  for (const refund of store.refunds) {
    if (payments.some((p) => p.id === refund.paymentId)) {
      refunded += refund.amount;
    }
  }
  return { subtotal, tax, total, paid, refunded, balance: total - (paid - refunded) };
}

/** The public JSON shape of an invoice (amounts in integer cents). */
export function invoiceView(store: Store, invoice: Invoice) {
  const totals = invoiceTotals(store, invoice);
  return {
    id: invoice.id,
    orderId: invoice.orderId,
    region: invoice.region,
    lines: invoice.lines.map((l) => ({
      productId: l.productId,
      qty: l.qty,
      unitPriceCents: Math.round(l.unitPrice * 100),
    })),
    subtotalCents: Math.round(totals.subtotal * 100),
    taxCents: Math.round(totals.tax * 100),
    totalCents: Math.round(totals.total * 100),
    paidCents: Math.round(totals.paid * 100),
    refundedCents: Math.round(totals.refunded * 100),
    balanceCents: Math.round(totals.balance * 100),
  };
}

function receipt(store: Store, invoice: Invoice): string {
  const totals = invoiceTotals(store, invoice);
  const rows = invoice.lines.map((l) => `${l.qty} x ${l.name} @ ${format(l.unitPrice)}`);
  return [
    `Invoice ${invoice.id} (order ${invoice.orderId}, ships to ${invoice.region})`,
    ...rows,
    `Subtotal ${format(totals.subtotal)}`,
    `Tax ${format(totals.tax)}`,
    `Total ${format(totals.total)}`,
    `Paid ${format(totals.paid - totals.refunded)}`,
    `Balance due ${format(totals.balance)}`,
  ].join("\n");
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, parts } = ctx;
  if (request.method !== "GET") {
    return problem(404, "not found");
  }
  if (parts.length === 1) {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const newestFirst = [...store.invoices].reverse();
    return json({
      invoices: newestFirst.slice(offset, offset + limit).map((i) => invoiceView(store, i)),
      total: store.invoices.length,
      limit,
      offset,
    });
  }
  const invoice = store.invoices.find((i) => i.id === parts[1]);
  if (!invoice) {
    return problem(404, "invoice not found");
  }
  if (parts.length === 2) {
    return json(invoiceView(store, invoice));
  }
  if (parts.length === 3 && parts[2] === "receipt") {
    return new Response(receipt(store, invoice), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return problem(404, "not found");
}
