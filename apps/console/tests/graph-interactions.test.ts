/**
 * Offline tests for the graph wheel-zoom interaction (item 4): alt + wheel zooms
 * the graph and MUST block the page scroll (preventDefault), while a plain wheel
 * leaves the page to scroll normally. The decision lives in a pure helper so it
 * is tested with no DOM, and a tiny stand-in for the native listener proves the
 * handler calls preventDefault exactly on an alt + wheel.
 *
 * The real component attaches this handler as a NATIVE, NON-PASSIVE wheel
 * listener (addEventListener('wheel', handler, { passive: false })) so that
 * preventDefault is not the silent no-op it would be inside React's passive
 * onWheel prop. This test pins the decision the native handler consults.
 */

import { describe, expect, it } from "vitest";

import {
  IDENTITY_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  shouldZoomOnWheel,
  zoomAt,
} from "../src/graph-interactions.ts";

/**
 * The exact native-listener body the component installs, inlined here so the
 * test exercises the real preventDefault-gating logic without React or a DOM:
 * zoom (and preventDefault) only when shouldZoomOnWheel is true.
 */
function wheelHandler(event: { altKey: boolean; preventDefault: () => void }): void {
  if (!shouldZoomOnWheel(event)) {
    return;
  }
  event.preventDefault();
}

describe("item 4: alt + wheel zoom blocks page scroll, plain wheel does not", () => {
  it("calls preventDefault on an alt + wheel (so the page does not scroll while zooming)", () => {
    let prevented = false;
    wheelHandler({ altKey: true, preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
  });

  it("does NOT call preventDefault on a plain wheel (the page scrolls normally)", () => {
    let prevented = false;
    wheelHandler({ altKey: false, preventDefault: () => (prevented = true) });
    expect(prevented).toBe(false);
  });

  it("shouldZoomOnWheel is true only when alt is held", () => {
    expect(shouldZoomOnWheel({ altKey: true })).toBe(true);
    expect(shouldZoomOnWheel({ altKey: false })).toBe(false);
  });

  it("zoomAt keeps the cursor point fixed and clamps the scale into range", () => {
    // Zooming in at the origin keeps (0,0) fixed and increases the scale.
    const zoomedIn = zoomAt(IDENTITY_VIEW, 0, 0, -120);
    expect(zoomedIn.k).toBeGreaterThan(IDENTITY_VIEW.k);
    expect(zoomedIn.tx).toBeCloseTo(0, 6);
    expect(zoomedIn.ty).toBeCloseTo(0, 6);

    // The scale never exceeds MAX_SCALE however hard we zoom in, nor drops below
    // MIN_SCALE however hard we zoom out.
    let view = IDENTITY_VIEW;
    for (let i = 0; i < 50; i++) {
      view = zoomAt(view, 100, 100, -1000);
    }
    expect(view.k).toBeLessThanOrEqual(MAX_SCALE);
    view = IDENTITY_VIEW;
    for (let i = 0; i < 50; i++) {
      view = zoomAt(view, 100, 100, 1000);
    }
    expect(view.k).toBeGreaterThanOrEqual(MIN_SCALE);
  });
});
