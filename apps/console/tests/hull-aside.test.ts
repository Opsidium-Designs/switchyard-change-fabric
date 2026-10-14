/**
 * Every hull says the same things whatever its width: the status pill moves
 * under the title bar when it does not fit beside the title (never dropped),
 * and a claimed hull whose owner's dot is drawn in another hull names that
 * owner instead of looking empty.
 */
import { describe, expect, it } from "vitest";

import { hullAside } from "../src/mission-control.tsx";

const rect = { x: 100, y: 200, w: 180, h: 196 };

describe("hullAside", () => {
  it("moves the status pill under the title bar when it is not beside the title", () => {
    const below = hullAside({ rect, status: "claimed", besideTitle: false, item: "invoices", agentsHere: 1, compact: false });
    expect(below.badge?.text).toBe("claimed");
    expect(below.badge!.y).toBeGreaterThan(rect.y);
    expect(below.badge!.x + below.badge!.w).toBeLessThanOrEqual(rect.x + rect.w);
    expect(hullAside({ rect, status: "claimed", besideTitle: true, item: "tax", agentsHere: 1, compact: false }).badge).toBeUndefined();
  });

  it("names the owner when its dot is drawn in another hull, and only then", () => {
    const held = hullAside({ rect, status: "claimed", besideTitle: true, owner: "agent-6", ownerHull: "history", ownerHullLabel: "history", item: "checkout", agentsHere: 0, compact: false });
    expect(held.held?.label).toBe("agent-6");
    expect(held.held?.sub).toBe("also on history");
    expect(held.held?.title).toContain("agent-6 holds this item too");
    // Its own dot is here, or nobody holds it, or the owner's dot is in this hull: nothing extra.
    expect(hullAside({ rect, status: "claimed", besideTitle: true, owner: "agent-6", ownerHull: "history", item: "checkout", agentsHere: 1, compact: false }).held).toBeUndefined();
    expect(hullAside({ rect, status: "open", besideTitle: true, item: "categories", agentsHere: 0, compact: false }).held).toBeUndefined();
    expect(hullAside({ rect, status: "claimed", besideTitle: true, owner: "agent-1", ownerHull: "tax", item: "tax", agentsHere: 0, compact: false }).held).toBeUndefined();
  });
});
