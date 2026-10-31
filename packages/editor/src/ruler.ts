/**
 * @apelles/editor — the timeline ruler's tick-interval + label logic
 * (D-058, item 4 of the 2026-09-03 timeline-fixes pass).
 *
 * Two pure, unit-tested functions, deliberately kept out of `TimelinePane.tsx`
 * so the "nice numbers" tick-interval choice and the timecode formatting have
 * real inputs/outputs a test can assert on, not just a screenshot to eyeball.
 *
 * `@xzdarcy/react-timeline-editor`'s `TimeArea` renders one labeled tick every
 * `scale` seconds (`getScaleRender(item)`, `item` in seconds) — it has no
 * adaptive-density concept of its own (checked in its bundled source: `scale`
 * is a single fixed prop, not a function of zoom). `TimelinePane` previously
 * passed a hardcoded `scale={1}` — one labeled tick per second regardless of
 * zoom, which is exactly the "1, 2, 3…49" clutter at low zoom the owner hit.
 */

/**
 * Timeline zoom, in px per second of source. Lives here rather than in
 * `TimelinePane.tsx` (D-124) because it is no longer only the pane's own
 * business — and after D-128 it is load-bearing for something else again.
 * `Filmstrip.tsx` requests tiles at a spacing derived from the current zoom,
 * and the backend's level-of-detail ladder
 * (`chroma::filmstrip::LEVEL_STEPS`) is sized to bracket exactly the range
 * these two bounds allow: a tile is drawn ~50px wide, so the real span of
 * requested spacings is `50 / MAX_PX_PER_SEC` to `50 / MIN_PX_PER_SEC`
 * seconds. Widen either bound past what that ladder covers and requests
 * start clamping to its end rungs — which at the top end is the stretched-
 * tile defect D-128 removed. Two copies of these numbers drifting apart
 * would reintroduce it quietly, so there is exactly one.
 */
/** The ruler bar's height, in px. D-432 P3: 24 (spec §4.6), down from the
 *  timeline library's 32 px, which D-437 removed. Since D-437 S4 the playhead (`lanes/Playhead.tsx`, its
 *  `rulerHeightPx`) and the lanes' scroller top (`RULER_AND_MARGIN_PX`) take it
 *  straight from here, so the playhead and the overlay maths read one definition.
 *
 *  A constant here rather than a literal at each site (D-222) because two
 *  unrelated files now need the same number and must not disagree about it:
 *  `TimelinePane.tsx` adds it to the marker strip's height to get
 *  `RULER_AND_MARGIN_PX`, the origin every absolutely-positioned overlay and
 *  the drop-target row math measure from, and `TimelineMarkers.tsx` uses it as
 *  the strip's own `top`. It lives in this module, with the ruler's other
 *  layout constants, rather than in either consumer — neither one owns it. */
export const RULER_HEIGHT_PX = 24;

export const MIN_PX_PER_SEC = 1;
export const MAX_PX_PER_SEC = 480;
export const DEFAULT_PX_PER_SEC = 90;

/** Candidate labeled-tick intervals, in seconds, on a 1-2-5 progression from
 *  a tenth of a second (finer than that is visually indistinguishable at any
 *  zoom this UI allows) up to an hour. `niceTickIntervalSeconds` never
 *  returns a value outside this list — the classic "nice numbers" ruler
 *  technique (pick the roundest interval that satisfies a minimum spacing),
 *  not a single hardcoded ratio. */
export const NICE_TICK_STEPS_SECONDS: readonly number[] = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/**
 * Pick a labeled-tick interval (seconds) so adjacent labels land at least
 * `targetPx` apart at the current zoom (`pxPerSecond`). As `pxPerSecond`
 * shrinks (zoomed out), the chosen interval grows so labels stop colliding;
 * as it grows (zoomed in), the interval shrinks so the ruler isn't wastefully
 * sparse. `minSeconds` (pass `1 / fps`, one frame) floors the result — an
 * interval finer than a single frame doesn't mean anything.
 */
export function niceTickIntervalSeconds(pxPerSecond: number, targetPx = 70, minSeconds = 0): number {
  const floor = NICE_TICK_STEPS_SECONDS[0];
  if (!(pxPerSecond > 0)) return NICE_TICK_STEPS_SECONDS.find((s) => s >= 1) ?? floor;
  const need = Math.max(targetPx / pxPerSecond, minSeconds, floor);
  for (const step of NICE_TICK_STEPS_SECONDS) {
    if (step >= need) return step;
  }
  return NICE_TICK_STEPS_SECONDS[NICE_TICK_STEPS_SECONDS.length - 1];
}

/**
 * Format `seconds` as broadcast timecode at `fps` — `HH:MM:SS`, or
 * `HH:MM:SS:FF` when the ruler's current tick interval (`tickIntervalSeconds`
 * — pass whatever `niceTickIntervalSeconds` returned for the same zoom) is
 * sub-second. Frames are shown only then: at a whole-second-or-coarser tick
 * spacing every label would show a redundant `:00`/constant frame count,
 * noise rather than information — the ruler's own current density decides
 * the format, not a fixed rule.
 */
export function formatTimecode(seconds: number, fps: number, tickIntervalSeconds: number): string {
  const safeFps = fps > 0 ? fps : 24;
  const wholeFps = Math.max(1, Math.round(safeFps));
  const totalFrames = Math.max(0, Math.round(seconds * safeFps));
  const ff = totalFrames % wholeFps;
  const totalSeconds = Math.floor(totalFrames / wholeFps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return tickIntervalSeconds < 1 ? `${base}:${pad(ff)}` : base;
}

/** D-432 P3 — the spacing a minor ruler tick must keep, px: closer than this
 *  and the ticks read as a grey bar rather than as marks. */
export const MIN_MINOR_TICK_PX = 8;

/** The subdivisions a labelled interval may be split into, coarsest last. */
const SPLIT_CANDIDATES = [10, 5, 2, 1] as const;

/**
 * D-432 P3 — how many minor ticks to draw per labelled interval (the
 * library's `scaleSplitCount`): the finest of 10 / 5 / 2 / 1 that keeps the
 * minor ticks at least `MIN_MINOR_TICK_PX` apart at this zoom, so the
 * density follows the zoom the way the labels' interval already does. The
 * library's own default is a fixed 10.
 */
export function rulerSplitCount(tickSeconds: number, pxPerSecond: number): number {
  const tickPx = tickSeconds * pxPerSecond;
  for (const split of SPLIT_CANDIDATES) {
    if (tickPx / split >= MIN_MINOR_TICK_PX) return split;
  }
  return 1;
}

/**
 * D-432 P3 — a ruler label in the spec's adaptive format (§4.6): `0:05`,
 * `1:30`, `1:02:10` (h:mm:ss once there are hours), with frames appended
 * only at frame-level zoom — a sub-second labelled interval — `1:30:12`.
 * No zero-padded hours on every label: the ruler is read at a glance, and
 * `00:00:05` spends five characters saying "five seconds". The marker
 * tooltips and the timecode fields keep the full `HH:MM:SS:FF`
 * (`formatTimecode`, `fmtTimecode`), which is for reading a position exactly.
 */
export function formatRulerLabel(seconds: number, fps: number, tickIntervalSeconds: number): string {
  const safeFps = fps > 0 ? fps : 24;
  const wholeFps = Math.max(1, Math.round(safeFps));
  const totalFrames = Math.max(0, Math.round(seconds * safeFps));
  const ff = totalFrames % wholeFps;
  const totalSeconds = Math.floor(totalFrames / wholeFps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  return tickIntervalSeconds < 1 ? `${base}:${pad(ff)}` : base;
}
