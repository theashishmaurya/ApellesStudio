/**
 * visibility.ts - keep the harness's targets inside what a person can see (H11).
 *
 * What it is: pure geometry over the timeline view readout. At 1470x923 with
 * Sources and the Inspector open the edit area is only ~660 px wide, so a
 * hard-coded "focus the timeline at frame 400", a marquee start at frame 220, or
 * a clip whose centre sits under the Inspector, resolved to a point outside the
 * edit area: the press landed on the Inspector and the scenario "failed" for a
 * reason that was the harness's. Now such a target is either brought into view
 * (zoom out for a frame, clamp the press onto the visible part of a clip) or
 * refused by name.
 *
 * What it does NOT do: talk to the app. The runner reads the view, asks for a
 * zoom through `editor_set_timeline_view` and re-reads it; this only decides.
 */

import { DEFAULT_PX_PER_SEC, MIN_PX_PER_SEC } from '@apelles/editor/src/ruler.ts';

import type { ViewSnap } from './snapshot.ts';

/** Inset from the edit area's edges: its scrollbars and the clip-edge trim zones. */
export const VISIBLE_MARGIN_PX = 16;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Band {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The part of the edit area a press can safely land on. */
export function visibleBand(view: Pick<ViewSnap, 'rect'>, margin = VISIBLE_MARGIN_PX): Band {
  const r = view.rect;
  return { left: r.x + margin, right: r.x + r.width - margin, top: r.y, bottom: r.y + r.height - margin };
}

export class OutsideVisibleArea extends Error {
  /** Set for a frame-addressed target, which the runner can bring into view by zooming. */
  readonly frame: number | null;
  constructor(message: string, frame: number | null) {
    super(message);
    this.frame = frame;
  }
}

const inside = (p: { x: number; y: number }, b: Band) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

/** Throw {@link OutsideVisibleArea} when `p` is not in the visible edit area. */
export function assertVisible(p: { x: number; y: number }, view: Pick<ViewSnap, 'rect'>, what: string, frame: number | null = null): void {
  const b = visibleBand(view);
  if (inside(p, b)) return;
  throw new OutsideVisibleArea(
    `${what} resolves to (${p.x}, ${p.y}), outside the timeline's visible area (x ${Math.round(b.left)}-${Math.round(b.right)}, y ${Math.round(b.top)}-${Math.round(b.bottom)})`,
    frame,
  );
}

/**
 * The zoom multiplier (1 = the default 90 px/s) at which `frame` fits inside the
 * visible area with the view scrolled to its start, or `null` when even the
 * lowest zoom cannot show it.
 */
export function zoomToShowFrame(view: ViewSnap, frame: number): number | null {
  const seconds = frame / view.fps;
  if (seconds <= 0) return null;
  const b = visibleBand(view);
  // x(frame) = rect.x + startLeft + seconds * pxPerSec (scrollLeft 0 once zoomed out)
  const room = b.right - view.rect.x - view.startLeft - VISIBLE_MARGIN_PX;
  const pxPerSec = Math.floor(room / seconds);
  if (pxPerSec < MIN_PX_PER_SEC) return null;
  return Math.min(pxPerSec, view.pxPerSec) / DEFAULT_PX_PER_SEC;
}

export interface At {
  fx?: number;
  fy?: number;
  dx?: number;
  dy?: number;
}

export type Clamped = { at: At; clamped: boolean } | { error: string };

/**
 * Where on an element (its live `rect`) to press so the press lands in the
 * visible area: the requested point if it already does, otherwise the nearest
 * point of the element that is. An element with no visible part is an error.
 */
export function clampAtToVisible(rect: Rect, at: At | undefined, view: Pick<ViewSnap, 'rect'>): Clamped {
  const b = visibleBand(view);
  const x = rect.x + (at?.fx ?? 0.5) * rect.width + (at?.dx ?? 0);
  if (x >= b.left && x <= b.right) return { at: at ?? {}, clamped: false };
  const lo = Math.max(rect.x, b.left);
  const hi = Math.min(rect.x + rect.width, b.right);
  if (lo > hi) {
    return { error: `the element (x ${Math.round(rect.x)}-${Math.round(rect.x + rect.width)}) has no part inside the timeline's visible area (x ${Math.round(b.left)}-${Math.round(b.right)})` };
  }
  const px = Math.min(Math.max(x, lo), hi);
  return { at: { ...(at?.fy !== undefined ? { fy: at.fy } : {}), ...(at?.dy !== undefined ? { dy: at.dy } : {}), fx: rect.width > 0 ? (px - rect.x) / rect.width : 0, dx: 0 }, clamped: true };
}
