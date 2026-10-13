import { describe, expect, it } from "vitest";

import { freshApp, send } from "../helpers.ts";

// Pet license fees, pinned from the amounts the API produces today.
describe("pet licenses", () => {
  it("charges a spayed cat 763 cents", async () => {
    const reply = await send(freshApp(), "POST", "/licensing/pets", { name: "Miso", species: "cat", spayed: true });
    expect(reply.status).toBe(201);
    expect(reply.body.feeCents).toBe(763);
  });

  it("charges an unaltered dog the full 2025 cents", async () => {
    const reply = await send(freshApp(), "POST", "/licensing/pets", { name: "Rex", species: "dog", spayed: false });
    expect(reply.body.feeCents).toBe(2025);
  });
});
