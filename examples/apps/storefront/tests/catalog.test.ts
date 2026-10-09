import { describe, expect, it } from "vitest";

import { freshApp, send } from "./helpers.ts";

describe("catalog", () => {
  it("lists the seeded products", async () => {
    const page = await send(freshApp(), "GET", "/products");
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(6);
    expect(page.body.products.map((p: { id: string }) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
  });

  it("filters products by category", async () => {
    const page = await send(freshApp(), "GET", "/products?category=c2");
    expect(page.body.products.map((p: { name: string }) => p.name)).toEqual(["Pour-over kettle", "Paper filters"]);
  });

  it("reads one product and 404s an unknown one", async () => {
    const app = freshApp();
    expect((await send(app, "GET", "/products/p3")).body.name).toBe("Pour-over kettle");
    expect((await send(app, "GET", "/products/p404")).status).toBe(404);
  });

  it("lists categories", async () => {
    const page = await send(freshApp(), "GET", "/categories");
    expect(page.body.categories.map((c: { name: string }) => c.name)).toEqual(["Drinkware", "Brewing", "Coffee and tea"]);
  });

  it("searches product names case insensitively", async () => {
    const page = await send(freshApp(), "GET", "/search?q=MUG");
    expect(page.body.results.map((p: { id: string }) => p.id)).toEqual(["p1"]);
  });
});
