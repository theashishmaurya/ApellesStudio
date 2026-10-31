/**
 * trackHeight.ts — per-track height in the Edit timeline (D-432 P3,
 * `docs/notes/ui-redesign.md` §4.8, §4.3).
 *
 * What it is: the pure geometry of a timeline whose tracks are not all the same
 * height. A track's height is its own `Track.height` when a person has dragged
 * it (or `editor_set_track_height` set it), otherwise the timeline view's
 * default clip height (the Clip Appearance S/M/L/XL, `timelineView.ts`). From
 * the list of heights it derives where each row starts (`trackTops`) and which
 * row a y position falls in (`trackAtY`) — the two questions every overlay,
 * drop target and click handler in `TimelinePane` used to answer with
 * `index * ROW_HEIGHT`.
 *
 * What it does NOT do: store anything (the height lives on the track, the
 * default in the view store), touch the DOM, or decide the clip anatomy at a
 * height (`clipAnatomy.ts` does that for any height).
 */

import type { Track } from './timeline';

/** The Clip Appearance presets (spec §4.3): FCP's four clip heights. M is the
 *  default and the height every track had before P3 (`ROW_HEIGHT` 52). */
export const TRACK_HEIGHT_PRESETS = { S: 32, M: 52, L: 76, XL: 108 } as const;
export type TrackHeightPreset = keyof typeof TRACK_HEIGHT_PRESETS;
export const TRACK_HEIGHT_PRESET_NAMES = Object.keys(TRACK_HEIGHT_PRESETS) as TrackHeightPreset[];
export const DEFAULT_TRACK_HEIGHT = TRACK_HEIGHT_PRESETS.M;

/** Whether a string names a preset (`"S"`, `"M"`, `"L"`, `"XL"`). */
export function isTrackHeightPreset(name: string): name is TrackHeightPreset {
  return Object.prototype.hasOwnProperty.call(TRACK_HEIGHT_PRESETS, name);
}

/** The drag range of a track's bottom edge (spec §4.8: 32 to 200). */
export const TRACK_HEIGHT_MIN = 32;
export const TRACK_HEIGHT_MAX = 200;

/** A height clamped into the drag range and rounded to a whole CSS px. */
export function clampTrackHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_TRACK_HEIGHT;
  return Math.min(TRACK_HEIGHT_MAX, Math.max(TRACK_HEIGHT_MIN, Math.round(height)));
}

/** The preset a height is exactly, or `null` for a custom (dragged) height. */
export function presetOfHeight(height: number): TrackHeightPreset | null {
  return TRACK_HEIGHT_PRESET_NAMES.find((p) => TRACK_HEIGHT_PRESETS[p] === height) ?? null;
}

/** One track's drawn height: its own, else the view default. */
export function trackHeightOf(track: Pick<Track, 'height'>, viewDefault: number): number {
  return track.height != null ? clampTrackHeight(track.height) : viewDefault;
}

/** Every track's drawn height, in track order. */
export function trackHeights(tracks: ReadonlyArray<Pick<Track, 'height'>>, viewDefault: number): number[] {
  return tracks.map((t) => trackHeightOf(t, viewDefault));
}

/** Where each row starts, px below row 0's top, plus one entry past the last
 *  row (its bottom), so `tops[i + 1] - tops[i]` is row i's height and
 *  `tops[tracks.length]` is the stack's total height. */
export function trackTops(heights: readonly number[]): number[] {
  const tops = [0];
  for (const h of heights) tops.push(tops[tops.length - 1] + h);
  return tops;
}

/** The row a y (px below row 0's top) falls in. Above the first row is -1 and
 *  below the last is `heights.length`, so a caller can tell "on a track" from
 *  "off the stack" the way `Math.floor(y / ROW_HEIGHT)` used to let it. */
export function trackAtY(tops: readonly number[], y: number): number {
  if (y < 0) return -1;
  const n = tops.length - 1;
  if (y >= tops[n]) return n;
  // Few tracks (a dozen is a big timeline): a linear walk beats a bisection's
  // bookkeeping and reads plainly.
  for (let i = 0; i < n; i++) if (y < tops[i + 1]) return i;
  return n;
}

/** A y (px below row 0's top) as a FRACTIONAL row index: 1.5 is halfway down
 *  row 1, whatever its height. Above the stack and below it, rows are taken to
 *  be `outsideHeight` tall, so the mapping stays continuous and invertible
 *  (`yAtRow`). This is what lets the marquee (D-137) keep working in rows. */
export function rowAtY(tops: readonly number[], y: number, outsideHeight: number): number {
  const n = tops.length - 1;
  if (y < 0) return y / outsideHeight;
  if (y >= tops[n]) return n + (y - tops[n]) / outsideHeight;
  const i = trackAtY(tops, y);
  return i + (y - tops[i]) / (tops[i + 1] - tops[i]);
}

/** The inverse of `rowAtY`: a fractional row index back to px. */
export function yAtRow(tops: readonly number[], row: number, outsideHeight: number): number {
  const n = tops.length - 1;
  if (row < 0) return row * outsideHeight;
  if (row >= n) return tops[n] + (row - n) * outsideHeight;
  const i = Math.floor(row);
  return tops[i] + (row - i) * (tops[i + 1] - tops[i]);
}

/** Row i's height from its tops (`tops[i + 1] - tops[i]`), or `fallback` for
 *  an index off the stack (a ghost row below the last track). */
export function rowHeightAt(tops: readonly number[], i: number, fallback: number): number {
  return i >= 0 && i + 1 < tops.length ? tops[i + 1] - tops[i] : fallback;
}

/** Row i's top, extrapolating below the stack with `fallback`-tall rows (the
 *  "drop here makes a new track" ghost row sits one past the last). */
export function rowTopAt(tops: readonly number[], i: number, fallback: number): number {
  const n = tops.length - 1;
  if (i <= n) return tops[Math.max(0, i)];
  return tops[n] + (i - n) * fallback;
}

/** The track boundary (0 = above the first row, n = below the last) whose line
 *  is within `band` px of y, or `null` — the "insert a new track here" zone
 *  (D-097) at any mix of heights. */
export function trackBoundaryNear(tops: readonly number[], y: number, band: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  tops.forEach((top, b) => {
    const d = Math.abs(y - top);
    if (d <= band && d < bestDist) {
      best = b;
      bestDist = d;
    }
  });
  return best;
}
