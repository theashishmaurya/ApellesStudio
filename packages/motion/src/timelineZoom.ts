/**
 * @apelles/motion — Phase 5b part 2 ("per-row lanes", D-162 —
 * `docs/notes/motion-keyframe-timeline-research.md` §4: "a shared time axis
 * and independent zoom").
 *
 * A genuinely NEW, small zoom mechanism for `KeyframeTimeline.tsx` — the
 * research doc's own task framing explicitly frees this from having to match
 * the Edit tab's own zoom system (`packages/editor/src/ruler.ts`'s
 * `MIN_PX_PER_SEC`/`MAX_PX_PER_SEC`/`DEFAULT_PX_PER_SEC`, D-134): that
 * system's bounds are sized around `chroma::filmstrip`'s Rust-side
 * level-of-detail ladder for VIDEO THUMBNAIL TILES — a storage-level
 * decimation concern this package has no equivalent of at all (confirmed by
 * the parent research doc's own D-134 reuse-verdict row: "not applicable at
 * all… a completely different medium and cost profile"). This timeline has
 * no tiles to request and no backend ladder to bracket, so its own bounds
 * are chosen purely for what looks usable on screen: wide enough to zoom
 * from "the whole composition fits" to "a single second is wide enough to
 * see two nearby keys clearly," and no wider than that.
 *
 * `pxPerSecond` is the ONE zoom value shared by every lane and the ruler —
 * "shared time axis" (§4's own phrase) means one axis all rows agree on, not
 * a per-row independent zoom level; see `KeyframeTimeline.tsx`'s own module
 * doc comment for why a per-ROW zoom was considered and rejected.
 */

/** Chosen for THIS timeline's own screen real estate (a resizable panel a
 *  few hundred px tall, not a full-width video editor) — not derived from
 *  `ruler.ts`'s bounds, deliberately (see module doc comment). At
 *  `MIN_PX_PER_SEC`, a 60s composition renders at 600px (fits most panel
 *  widths without horizontal scroll); at `MAX_PX_PER_SEC`, one second is
 *  400px wide — comfortably wide enough to drag two keys a few frames apart
 *  without them overlapping under a pointer. */
export const MIN_PX_PER_SEC = 10;
export const MAX_PX_PER_SEC = 400;
export const DEFAULT_PX_PER_SEC = 70;

/** Clamp a zoom value into `[MIN_PX_PER_SEC, MAX_PX_PER_SEC]` — every
 *  setter in `KeyframeTimeline.tsx` (buttons, a future slider/wheel-zoom)
 *  routes through this rather than each clamping its own way, so the bounds
 *  live in exactly one place. */
export function clampPxPerSecond(pxPerSecond: number): number {
  if (!(pxPerSecond > 0)) return MIN_PX_PER_SEC;
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSecond));
}

/** One zoom-in/zoom-out step, geometric (not additive) so the SAME button
 *  press feels similarly significant whether zoomed far in or far out — a
 *  fixed `+20px/sec` step would be a huge jump near `MIN_PX_PER_SEC` and an
 *  imperceptible one near `MAX_PX_PER_SEC`. `direction: 1` zooms in
 *  (larger `pxPerSecond`), `-1` zooms out; always clamped. */
export function zoomStep(pxPerSecond: number, direction: 1 | -1): number {
  const factor = 1.4;
  return clampPxPerSecond(direction > 0 ? pxPerSecond * factor : pxPerSecond / factor);
}

/**
 * The whole track's own pixel width at the current zoom — the "how many
 * composition-frames map to how many horizontal pixels" math the task's own
 * §4 asked for as REAL, not a stub. Every lane's track div and the ruler's
 * own track div render at exactly this width (a shared time axis: one
 * width, so a frame's `left: N%` position — computed via
 * `keyframeVisibility.ts`'s `frameToPercent`, unchanged by zoom — lands at
 * the identical PIXEL offset in every row, since percent-of-this-width is
 * the same calculation everywhere it's used). `0` for a non-positive input
 * (nothing to size), the same "don't divide/multiply by a value the schema
 * merely makes unlikely" defensive floor `keyframeVisibility.ts`'s own
 * frame/percent functions already hold.
 */
export function trackWidthPx(totalFrames: number, fps: number, pxPerSecond: number): number {
  if (!(totalFrames > 0) || !(fps > 0) || !(pxPerSecond > 0)) return 0;
  return (totalFrames / fps) * pxPerSecond;
}

/**
 * Phase 5b, "box-select + nudge multiple keys" — a screen-pixel drag
 * distance -> a frame-aligned TIME delta (seconds). Because `pxPerSecond`
 * is the ONE shared axis every lane and the ruler already agree on (this
 * module's own doc comment), a pixel distance moved directly measures time
 * regardless of which row the pointer started in — `KeyframeTimeline.tsx`'s
 * nudge gesture needs no per-lane frame lookup (`frameFromClientX`) at all
 * to compute its shared `deltaSeconds`, unlike D-161's single-key drag
 * (which resolves an ABSOLUTE new position, not a delta, and so does need
 * to know which scene the pointer landed over).
 *
 * Frame-aligned via `fps`: rounds the raw seconds delta to the nearest
 * whole-frame equivalent, so every nudged key's `at` shifts by an INTEGER
 * number of frames from its own exact starting value — the same
 * frame-boundary precision `percentToFrame` already guarantees for the
 * single-key drag, rather than an arbitrary sub-frame float that would
 * make a nudge's result depend on exactly which pixel the drag ended on
 * in a way the rest of this timeline doesn't otherwise expose. `fps <= 0`
 * or `pxPerSecond <= 0` (both schema-/zoom-impossible today, defended
 * anyway per this file's own "don't divide by a value that's merely
 * unlikely" discipline) returns `0` rather than `NaN`/`Infinity`.
 */
export function pxDeltaToSeconds(pxDelta: number, pxPerSecond: number, fps: number): number {
  if (!(pxPerSecond > 0) || !(fps > 0)) return 0;
  const rawSeconds = pxDelta / pxPerSecond;
  return Math.round(rawSeconds * fps) / fps;
}
