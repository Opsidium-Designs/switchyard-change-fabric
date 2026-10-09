// Acceptance: authentication, input validation, and pagination bounds.
//
// The catalog's reads are public. Every write and everything a customer owns
// (cart, checkout, orders, invoices, payments, refunds) needs the bearer token:
// without it the response is 401 and nothing changes. Every write rejects
// invalid input with 400, and every list endpoint rejects an out-of-range or
// malformed `limit` (an integer 1 to 100, default 20) or `offset` (an integer 0
// or more, default 0) with 400.

import { describe, expect, it } from "vitest";

import { authed, buy, call, freshApp, type App } from "./harness.ts";

describe("public catalog reads need no token", () => {
  for (const path of ["/products", "/products/p1", "/categories", "/search?q=mug"]) {
    it(`GET ${path} is 200 without a token`, async () => {
      expect((await call(freshApp(), "GET", path)).status).toBe(200);
    });
  }
});

describe("everything else needs the bearer token", () => {
  const cases: [string, string, unknown?][] = [
    ["POST", "/products", { name: "Saucer", categoryId: "c1", priceCents: 800 }],
    ["POST", "/categories", { name: "Gifts" }],
    ["GET", "/cart"],
    ["POST", "/cart/items", { productId: "p1", qty: 1 }],
    ["DELETE", "/cart/items/p1"],
    ["POST", "/checkout", { region: "CA" }],
    ["GET", "/orders"],
    ["GET", "/invoices"],
    ["GET", "/payments"],
    ["POST", "/payments", { invoiceId: "inv-1", amountCents: 100 }],
    ["GET", "/refunds"],
    ["POST", "/refunds", { paymentId: "pay-1", amountCents: 100 }],
  ];
  for (const [method, path, body] of cases) {
    it(`${method} ${path} is 401 without a token`, async () => {
      const app = freshApp();
      expect((await call(app, method, path, body !== undefined ? { body } : {})).status).toBe(401);
    });
  }

  it("a wrong token is 401 too", async () => {
    expect((await call(freshApp(), "GET", "/orders", { token: "not-the-token" })).status).toBe(401);
  });

  it("an unauthenticated write changes nothing", async () => {
    const app = freshApp();
    await call(app, "POST", "/products", { body: { name: "Saucer", categoryId: "c1", priceCents: 800 } });
    await call(app, "POST", "/cart/items", { body: { productId: "p1", qty: 1 } });
    expect((await call(app, "GET", "/products")).body.total).toBe(6);
    expect((await authed(app, "GET", "/cart")).body.lines).toEqual([]);
  });
});

describe("writes validate their input", () => {
  const invalid: [string, string, unknown][] = [
    ["POST", "/products", {}],
    ["POST", "/products", { name: "  ", categoryId: "c1", priceCents: 800 }],
    ["POST", "/products", { name: "Saucer", categoryId: "c1", priceCents: -5 }],
    ["POST", "/products", { name: "Saucer", categoryId: "c1", priceCents: 0 }],
    ["POST", "/products", { name: "Saucer", categoryId: "c1", priceCents: 12.5 }],
    ["POST", "/products", { name: "Saucer", categoryId: "c1", priceCents: "800" }],
    ["POST", "/products", { name: "Saucer", categoryId: "no-such-category", priceCents: 800 }],
    ["POST", "/categories", {}],
    ["POST", "/categories", { name: "" }],
    ["POST", "/cart/items", { qty: 1 }],
    ["POST", "/cart/items", { productId: "p1", qty: 0 }],
    ["POST", "/cart/items", { productId: "p1", qty: 1.5 }],
    ["POST", "/cart/items", { productId: "p1", qty: 100 }],
    ["POST", "/cart/items", { productId: "p1", qty: "2" }],
  ];
  for (const [method, path, body] of invalid) {
    it(`${method} ${path} ${JSON.stringify(body)} is 400`, async () => {
      expect((await authed(freshApp(), method, path, body)).status).toBe(400);
    });
  }

  it("adding a product that does not exist is rejected (400 or 404) and leaves the cart empty", async () => {
    const app = freshApp();
    expect([400, 404]).toContain((await authed(app, "POST", "/cart/items", { productId: "p999", qty: 1 })).status);
    expect((await authed(app, "GET", "/cart")).body.lines).toEqual([]);
  });

  it("checkout to a region the store does not ship to is 400", async () => {
    const app = freshApp();
    await authed(app, "POST", "/cart/items", { productId: "p1", qty: 1 });
    expect((await authed(app, "POST", "/checkout", { region: "ZZ" })).status).toBe(400);
    expect((await authed(app, "POST", "/checkout", {})).status).toBe(400);
  });

  it("checkout with an empty cart is rejected and creates no order", async () => {
    const app = freshApp();
    expect([400, 409, 422]).toContain((await authed(app, "POST", "/checkout", { region: "CA" })).status);
    expect((await authed(app, "GET", "/orders")).body.total).toBe(0);
  });

  it("payments need a positive whole number of cents and an existing invoice", async () => {
    const app = freshApp();
    const order = await buy(app, [["p3", 1]], "OR");
    for (const amountCents of [0, -100, 12.5, "100", undefined]) {
      expect((await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents })).status).toBe(400);
    }
    expect([400, 404]).toContain((await authed(app, "POST", "/payments", { invoiceId: "inv-999", amountCents: 100 })).status);
    expect((await authed(app, "GET", "/payments")).body.total).toBe(0);
  });

  it("refunds need a positive whole number of cents and an existing payment", async () => {
    const app = freshApp();
    const order = await buy(app, [["p3", 1]], "OR");
    const payment = (await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 4500 })).body;
    for (const amountCents of [0, -100, 12.5, "100", undefined]) {
      expect((await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents })).status).toBe(400);
    }
    expect([400, 404]).toContain((await authed(app, "POST", "/refunds", { paymentId: "pay-999", amountCents: 100 })).status);
    expect((await authed(app, "GET", "/refunds")).body.total).toBe(0);
  });

  it("valid writes still succeed", async () => {
    const app = freshApp();
    expect((await authed(app, "POST", "/categories", { name: "Gifts" })).status).toBe(201);
    expect((await authed(app, "POST", "/products", { name: "Saucer", categoryId: "c1", priceCents: 800 })).status).toBe(201);
    expect((await authed(app, "POST", "/cart/items", { productId: "p1", qty: 2 })).status).toBe(201);
    const order = await authed(app, "POST", "/checkout", { region: "CA" });
    expect(order.status).toBe(201);
    const payment = await authed(app, "POST", "/payments", { invoiceId: order.body.invoiceId, amountCents: 100 });
    expect(payment.status).toBe(201);
    expect((await authed(app, "POST", "/refunds", { paymentId: payment.body.id, amountCents: 50 })).status).toBe(201);
  });
});

describe("search validates its query", () => {
  for (const query of ["", "?q=", "?q=%20%20", `?q=${"a".repeat(101)}`]) {
    it(`GET /search${query.slice(0, 20)} is 400`, async () => {
      expect((await call(freshApp(), "GET", `/search${query}`)).status).toBe(400);
    });
  }
});

/** Every list endpoint, the key its page is under, and how to give it at least three records. */
const LISTS: { path: string; key: string; auth: boolean; fill(app: App): Promise<void> }[] = [
  { path: "/products", key: "products", auth: false, fill: async () => {} },
  { path: "/categories", key: "categories", auth: false, fill: async () => {} },
  { path: "/search?q=e", key: "results", auth: false, fill: async () => {} },
  { path: "/orders", key: "orders", auth: true, fill: fillBilling },
  { path: "/invoices", key: "invoices", auth: true, fill: fillBilling },
  { path: "/payments", key: "payments", auth: true, fill: fillBilling },
  { path: "/refunds", key: "refunds", auth: true, fill: fillBilling },
];

async function fillBilling(app: App): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    const order = await buy(app, [["p3", 1]], "OR");
    const payment = (await authed(app, "POST", "/payments", { invoiceId: order.invoiceId, amountCents: 4500 })).body;
    await authed(app, "POST", "/refunds", { paymentId: payment.id, amountCents: 100 });
  }
}

function withQuery(path: string, query: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

describe("list endpoints bound their pagination", () => {
  for (const list of LISTS) {
    for (const query of ["limit=0", "limit=101", "limit=-1", "limit=abc", "limit=1.5", "offset=-1", "offset=abc", "offset=2.5"]) {
      it(`GET ${withQuery(list.path, query)} is 400`, async () => {
        const app = freshApp();
        expect((await call(app, "GET", withQuery(list.path, query), { auth: list.auth })).status).toBe(400);
      });
    }

    it(`GET ${list.path} pages with limit and offset`, async () => {
      const app = freshApp();
      await list.fill(app);
      const all = await call(app, "GET", list.path, { auth: list.auth });
      expect(all.status).toBe(200);
      expect(all.body.limit).toBe(20);
      expect(all.body.offset).toBe(0);
      expect(all.body.total).toBeGreaterThanOrEqual(3);
      const page = await call(app, "GET", withQuery(list.path, "limit=2&offset=1"), { auth: list.auth });
      expect(page.status).toBe(200);
      expect(page.body.limit).toBe(2);
      expect(page.body.offset).toBe(1);
      expect(page.body[list.key]).toEqual(all.body[list.key].slice(1, 3));
      const widest = await call(app, "GET", withQuery(list.path, "limit=100"), { auth: list.auth });
      expect(widest.status).toBe(200);
    });
  }
});
