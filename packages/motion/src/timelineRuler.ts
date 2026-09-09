/**
 * @apelles/motion — Phase 5b part 2 ("per-row lanes", D-162 —
 * `docs/notes/motion-keyframe-timeline-research.md` §4/§2b).
 *
 * `KeyframeTimeline.tsx`'s shared time ruler needs an adaptive tick-density
 * algorithm — evenly-spaced ticks at a fixed interval either clutter into
 * unreadable "0.1, 0.2, 0.3…" at a high zoom or thin out to nothing useful
 * at a low one. `packages/editor/src/ruler.ts` already solves exactly this
 * for the Edit tab's own timeline (`niceTickIntervalSeconds`, a classic
 * "nice numbers" 1-2-5 progression), and the parent research doc's §2b
 * verdict — re-confirmed in D-160/D-161's own decision entries — is that
 * this ~15-line ALGORITHM is the one piece of the Edit tab's timeline stack
 * that transfers, but only as TECHNIQUE, never as an import: `@apelles/motion`
 * cannot depend on `@apelles/editor` (confirmed against both packages'
 * `package.json`s — neither tab package depends on the other, the same
 * house rule `@apelles/inspector`'s own description states outright).
 * Inventing a third shared package for two small, pure functions with only
 * these two call sites would be over-engineering for what this phase needs
 * — so this file re-authors the algorithm locally instead, deliberately
 * kept in lockstep with `ruler.ts`'s own constants and behaviour (verified
 * against that file directly, not from memory) rather than drifting into a
 * subtly different "nice numbers" scheme for no reason.
 *
 * Everything here is pure and seconds-based (no DOM, no React, no frames) —
 * `KeyframeTimeline.tsx` converts a tick's `seconds` to an absolute frame
 * via `manifest.fps` only when it needs to position it, the same
 * seconds-are-the-source-of-truth discipline `keyframeVisibility.ts`'s own
 * `keySecondsToAbsoluteFrame` already follows.
 */

/** Candidate labeled-tick intervals, in seconds, on a 1-2-5 progression —
 *  identical list to `ruler.ts`'s own (a tenth of a second up to an hour).
 *  `niceTickIntervalSeconds` never returns a value outside this list. */
export const NICE_TICK_STEPS_SECONDS: readonly number[] = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/**
 * Pick a labeled-tick interval (seconds) so adjacent labels land at least
 * `targetPx` apart at the current zoom (`pxPerSecond`) — the same algorithm
 * `ruler.ts`'s own `niceTickIntervalSeconds` implements (re-authored here,
 * not imported — see the module doc comment). As `pxPerSecond` shrinks
 * (zoomed out), the chosen interval grows so labels stop colliding; as it
 * grows (zoomed in), the interval shrinks so the ruler isn't wastefully
 * sparse. `minSeconds` (pass `1 / fps`, one frame) floors the result — an
 * interval finer than a single frame doesn't mean anything for this engine.
 */
export function niceTickIntervalSeconds(pxPerSecond: number, targetPx = 64, minSeconds = 0): number {
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
 * `HH:MM:SS:FF` when the ruler's current tick interval is sub-second — the
 * same format `ruler.ts`'s own `formatTimecode` uses, re-authored for the
 * identical reason `niceTickIntervalSeconds` above is: one consistent
 * timecode convention across both tabs, without an import across the
 * package boundary. Frames are shown only at a sub-second tick spacing —
 * at a whole-second-or-coarser spacing every label would show a redundant
 * `:00`/constant frame count.
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

/** One labeled tick on `KeyframeTimeline.tsx`'s shared ruler — `frame`
 *  (rounded via `manifest.fps`, matching every other seconds→frame
 *  conversion in this package) is what the component actually positions via
 *  `frameToPercent`; `seconds`/`label` are kept alongside for anything that
 *  wants the human-readable value without re-deriving it from `frame`. */
export interface RulerTick {
  seconds: number;
  frame: number;
  label: string;
}

/**
 * The ruler's own tick list for one render — `niceTickIntervalSeconds` run
 * once, then walked from `0` to `totalSeconds` at that interval. Kept as a
 * real, tested function (not inline JSX) for the same "getting this wrong is
 * silent" reason every pixel/frame-mapping function in this package already
 * is: an off-by-one loop bound here would either drop the ruler's own last
 * tick or double-render one sitting exactly on `totalSeconds`. `[]` for a
 * non-positive `totalSeconds`/`pxPerSecond` (nothing to tick against).
 */
export function rulerTicks(totalSeconds: number, fps: number, pxPerSecond: number, targetPx = 64): RulerTick[] {
  if (!(totalSeconds > 0) || !(pxPerSecond > 0)) return [];
  const interval = niceTickIntervalSeconds(pxPerSecond, targetPx, fps > 0 ? 1 / fps : 0);
  const ticks: RulerTick[] = [];
  // A tiny epsilon guards against floating-point drift in repeated addition
  // (e.g. 0.1 + 0.1 + 0.1 !== 0.3 exactly) landing just past `totalSeconds`
  // and silently dropping the final tick.
  const epsilon = interval / 1000;
  for (let seconds = 0; seconds <= totalSeconds + epsilon; seconds += interval) {
    const clamped = Math.min(seconds, totalSeconds);
    ticks.push({ seconds: clamped, frame: Math.round(clamped * fps), label: formatTimecode(clamped, fps, interval) });
    if (clamped >= totalSeconds) break;
  }
  return ticks;
}
