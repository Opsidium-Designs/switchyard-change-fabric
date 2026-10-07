/**
 * graph-interactions: the pure pan/zoom math behind the living graph view.
 *
 * This is deliberately free of React and the DOM so it can be unit-tested
 * offline with no jsdom/browser: the GraphView component wires these helpers to
 * a native wheel listener, but the DECISIONS (whether a wheel event should zoom
 * the graph and block the page scroll, and where the view lands after a zoom)
 * live here as plain functions.
 */

/** The pan/zoom view transform: a scale `k` and a translation in SVG units. */
export interface ViewTransform {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

/** The identity view: no zoom, no pan (the deterministic layout at 1:1). */
export const IDENTITY_VIEW: ViewTransform = { k: 1, tx: 0, ty: 0 };
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 4;

/** Clamp a zoom scale into the allowed range. */
export function clampScale(k: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, k));
}

/**
 * Whether a wheel event should zoom the graph (and therefore block the page
 * scroll via preventDefault). Zoom is gated behind the ALT key: a plain wheel
 * scrolls the page as normal (no preventDefault), and alt + wheel zooms the
 * graph. This is the single source of truth the native wheel listener consults
 * so page scrolling is intercepted ONLY while alt is held.
 */
export function shouldZoomOnWheel(event: { readonly altKey: boolean }): boolean {
  return event.altKey === true;
}

/**
 * Compute the next view transform for an alt + wheel zoom centered on the cursor:
 * solve for the translation that keeps the SVG-space point (x, y) under the
 * pointer fixed as the scale changes. Returns the previous view unchanged when
 * the clamped scale did not move (already at a zoom limit), so a caller can skip
 * a no-op state update.
 */
export function zoomAt(
  prev: ViewTransform,
  x: number,
  y: number,
  deltaY: number,
): ViewTransform {
  const factor = Math.exp(-deltaY * 0.0015);
  const k = clampScale(prev.k * factor);
  if (k === prev.k) {
    return prev;
  }
  // Keep (x,y) fixed: x = tx + k * sx  =>  sx = (x - tx)/k ; after zoom,
  // tx' = x - k' * sx.
  const sx = (x - prev.tx) / prev.k;
  const sy = (y - prev.ty) / prev.k;
  return { k, tx: x - k * sx, ty: y - k * sy };
}
