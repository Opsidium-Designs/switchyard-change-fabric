/**
 * Revision previews on the real Worker handler + ChangeState DO (offline):
 *   - POST /changes/:id/previews records an integrated revision's preview (a
 *     Worker version under a preview alias), one per n (a later write
 *     replaces), sorted by n, on the snapshot as `previews` (absent when none);
 *   - the body is validated (n, commit, alias, an https workers.dev url, at,
 *     backfilled), an unknown Change is 404, and the route needs the bearer;
 *   - re-creating the Change id resets the previews, like the deployment.
 */
import { describe, expect, it } from "vitest";

import { createHarness, specYaml } from "./harness.ts";

const ID = "change-previews";
const COMMIT = "0d560720ecfdcf1214bbef4151ce91556ba931bc";

function preview(n: number, extra: Record<string, unknown> = {}) {
  return {
    n,
    commit: COMMIT,
    url: `https://sf21-r${n}-switchyard-change-fabric-storefront.example.workers.dev`,
    alias: `sf21-r${n}`,
    at: "2026-10-13T00:00:00.000Z",
    ...extra,
  };
}

type Snapshot = { previews?: { n: number; url: string; alias: string; commit: string; at: string; backfilled?: true }[]; deployment?: unknown };

describe("POST /changes/:id/previews", () => {
  it("records previews one per revision, sorted by n, a later write replacing, on the snapshot", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    expect((await h.json<Snapshot>("GET", `/changes/${ID}`)).body.previews).toBeUndefined();

    expect((await h.json("POST", `/changes/${ID}/previews`, preview(3))).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/previews`, preview(1))).status).toBe(201);
    const replaced = await h.json<{ preview: { n: number; url: string } }>("POST", `/changes/${ID}/previews`, {
      ...preview(3),
      url: "https://sf21-r3-switchyard-change-fabric-storefront.other.workers.dev",
      backfilled: true,
    });
    expect(replaced.status).toBe(201);
    expect(replaced.body.preview).toMatchObject({ n: 3, backfilled: true });

    const after = await h.json<Snapshot>("GET", `/changes/${ID}`);
    expect(after.body.previews?.map((p) => p.n)).toEqual([1, 3]);
    expect(after.body.previews?.[1]).toEqual({ ...preview(3), url: "https://sf21-r3-switchyard-change-fabric-storefront.other.workers.dev", backfilled: true });
    expect(after.body.previews?.[0]).toEqual(preview(1));
  });

  it("sets at when it is absent", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    const { at: _at, ...withoutAt } = preview(2);
    const posted = await h.json<{ preview: { at: string } }>("POST", `/changes/${ID}/previews`, withoutAt);
    expect(posted.status).toBe(201);
    expect(Number.isNaN(Date.parse(posted.body.preview.at))).toBe(false);
  });

  it("rejects an invalid body and an unknown Change", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    const bad: Record<string, unknown>[] = [
      { ...preview(1), n: 0 },
      { ...preview(1), n: 1.5 },
      { ...preview(1), n: "1" },
      { ...preview(1), commit: "xyz" },
      { ...preview(1), commit: "abc12" },
      { ...preview(1), commit: "A".repeat(40) },
      { ...preview(1), alias: "Bad_Alias" },
      { ...preview(1), alias: "a".repeat(41) },
      { ...preview(1), url: "http://sf21-r1-x.example.workers.dev" },
      { ...preview(1), url: "https://sf21-r1.example.com" },
      { ...preview(1), url: "https://workers.dev.evil.example/" },
      { ...preview(1), url: "not a url" },
      { ...preview(1), url: "https://user:secret@sf21-r1-x.example.workers.dev/" },
      { ...preview(1), url: "https://.workers.dev" },
      { ...preview(1), at: "yesterday" },
      { ...preview(1), backfilled: false },
    ];
    for (const body of bad) {
      expect((await h.json("POST", `/changes/${ID}/previews`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.request("POST", `/changes/${ID}/previews`, "{not json")).status).toBe(400);
    expect((await h.json<Snapshot>("GET", `/changes/${ID}`)).body.previews).toBeUndefined();
    expect((await h.json("POST", "/changes/no-such-change/previews", preview(1))).status).toBe(404);
  });

  it("requires the bearer when the Worker has a token", async () => {
    const auth = { authorization: "Bearer preview-test-token" };
    const h = createHarness({ apiToken: "preview-test-token" });
    expect((await h.json("POST", "/changes", specYaml(ID), auth)).status).toBe(201);
    expect((await h.json("POST", `/changes/${ID}/previews`, preview(1))).status).toBe(401);
    expect((await h.json("POST", `/changes/${ID}/previews`, preview(1), auth)).status).toBe(201);
  });

  it("is reset when the Change id is re-created, like the deployment", async () => {
    const h = createHarness();
    await h.json("POST", "/changes", specYaml(ID));
    await h.json("POST", `/changes/${ID}/previews`, preview(1));
    await h.json("POST", `/changes/${ID}/deployment`, { url: "https://x.example.workers.dev", app: "storefront" });
    expect((await h.json<Snapshot>("GET", `/changes/${ID}`)).body.previews).toHaveLength(1);
    await h.json("POST", "/changes", specYaml(ID));
    const after = await h.json<Snapshot>("GET", `/changes/${ID}`);
    expect(after.body.previews).toBeUndefined();
    expect(after.body.deployment).toBeUndefined();
  });
});
