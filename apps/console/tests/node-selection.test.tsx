/**
 * Offline test for the node selection styling (item 3): a selected node keeps
 * the white selection RING (the bright shape stroke) but shows NO square box.
 *
 * The square box was the browser's default rectangular FOCUS OUTLINE on the node
 * group (it carries tabIndex/role=button), NOT an SVG element. So this proves two
 * things with no browser:
 *   1. the rendered node markup contains the ring stroke on the selected shape
 *      and NO <rect>/outline element (the shape is a polygon/circle, never a box);
 *   2. the stylesheet suppresses the UA focus outline on the node group
 *      (`.node:focus { outline: none }`), which is what removes the box on select.
 *
 * The markup is produced with react-dom/server (renderToStaticMarkup), so no
 * jsdom or browser is needed and `make check` stays offline and deterministic.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GraphView } from "../src/graph-view.tsx";
import type { WorkGraphModel } from "@switchyard-change/orchestration/graph-model";

const here = dirname(fileURLToPath(import.meta.url));

/** A minimal model: a goal and one agent node, enough to render a selection. */
function model(): WorkGraphModel {
  return {
    nodes: [
      {
        id: "goal:c",
        kind: "goal",
        label: "the change",
        status: "running",
        verified: false,
        escalated: false,
        backing: { kind: "change", changeId: "c" },
      },
      {
        id: "unit:users",
        kind: "agent",
        label: "users",
        status: "running",
        verified: false,
        escalated: false,
        workspace: {
          workspaceId: "ws-users",
          workspaceName: "c--users",
          gitUrl: "file:///tmp/c--users",
          defaultBranch: "main",
          backend: "local-filesystem",
          fallback: true,
          tokenId: "tok",
          tokenExpiresAt: "2026-10-06T12:00:00.000Z",
          leasedAt: "2026-10-06T10:00:00.000Z",
        },
        backing: {
          kind: "workspace",
          unitId: "users",
          workspace: {
            workspaceId: "ws-users",
            workspaceName: "c--users",
            gitUrl: "file:///tmp/c--users",
            defaultBranch: "main",
            backend: "local-filesystem",
            fallback: true,
            tokenId: "tok",
            tokenExpiresAt: "2026-10-06T12:00:00.000Z",
            leasedAt: "2026-10-06T10:00:00.000Z",
          },
        },
      },
    ],
    edges: [
      {
        id: "goal->users",
        kind: "dependency",
        from: "goal:c",
        to: "unit:users",
        backing: { kind: "dependency", from: "c", to: "users" },
      },
    ],
    dial: { minConcurrency: 1, maxConcurrency: 3 },
  } as unknown as WorkGraphModel;
}

describe("item 3: a selected node keeps the ring but shows no square box", () => {
  it("renders the white selection ring on the selected shape and NO rect/outline element", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { model: model(), selectedId: "unit:users", onSelect: () => {} }),
    );

    // The white selection ring is the bright shape stroke applied when selected.
    expect(markup).toContain("#e6edf3");
    expect(markup).toMatch(/stroke-width="3"/);

    // There is NO <rect> element anywhere: the node shapes are polygons/circles,
    // never a box. The square box was the UA focus outline, not an element.
    expect(markup).not.toContain("<rect");

    // No inline SVG focus-outline attribute is emitted on the node group either.
    expect(markup).not.toMatch(/outline="/);
  });

  it("the stylesheet suppresses the UA focus outline on the node group (removes the box)", async () => {
    const css = await readFile(join(here, "..", "src", "styles.css"), "utf8");
    // The rule that removes the rectangular focus box on select/focus, while the
    // shape-stroke ring (set inline in graph-view) is untouched. Normalize
    // whitespace so the assertion is not sensitive to formatting.
    const normalized = css.replace(/\s+/g, " ");
    expect(normalized).toContain(".node:focus");
    expect(normalized).toMatch(/\.node:focus[^{]*\{[^}]*outline: none/);
  });
});
