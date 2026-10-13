import { describe, expect, it } from "vitest";

import { DEMO_TOKENS } from "../../src/contracts/auth.ts";
import { freshApp, send } from "../helpers.ts";

describe("permit applications", () => {
  it("files an application and a clerk approves it", async () => {
    const app = freshApp();
    const created = await send(app, "POST", "/permits/applications", { kind: "deck", address: "88 Pier Ave", valuationCents: 900_000 });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("submitted");
    const decided = await send(app, "POST", `/permits/applications/${created.body.id}/decision`, { decision: "approved", decidedOn: "2026-02-10" }, DEMO_TOKENS.clerk);
    expect(decided.body).toMatchObject({ status: "approved", expiresOn: "2027-02-10" });
  });

  it("needs a token", async () => {
    const response = await freshApp().fetch(new Request("http://cityhall.local/permits/applications"));
    expect(response.status).toBe(401);
  });
});
