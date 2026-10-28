/**
 * @apelles/editor — changing a timeline's frame rate without changing what it
 * plays (B-323). Exact mirror of `apelles-timeline`'s `retime.rs`, same rules,
 * same rounding, so the open timeline (this op) and any other timeline (the
 * `chroma_timeline_set_rate` command) end up identical.
 *
 * **What it converts, by time.** `start_frame`, `fade_in_frames` /
 * `fade_out_frames`, markers' `frame` / `duration_frames`, transitions'
 * `at_frame` / `duration`; and, for a clip with NO `source_fps` (its source
 * axis is the timeline axis, 1:1), also `source_start` / `duration` /
 * `source_len`, speed points, highlight sweeps and keyframe frames.
 *
 * **What it leaves.** A clip that carries a `source_fps` keeps every
 * source-native field: `sourceFramesToTimeline` already re-expresses its
 * footprint at the new rate, so it keeps its length in seconds by construction.
 *
 * Pure: no store, no IPC. `timeline.ts` calls it from the `set_timeline_rate`
 * op; `timelineStore.ts` and the MCP tools go through that op.
 */
import type { Clip, Rational, Timeline } from './timeline';

/** The fastest frame rate a timeline may be set to (`MAX_TIMELINE_FPS` in
 *  `retime.rs`): far above any delivery format, so a typo is refused. */
export const MAX_TIMELINE_FPS = 240;

/** Tolerance for "this float is a whole frame rate". */
const WHOLE_FPS_EPSILON = 1e-6;
/** How far a rate may sit from `n*1000/1001` and still be the NTSC rate. */
const NTSC_FPS_TOLERANCE = 0.005;
/** The NTSC family's divisor (23.976, 29.97, 59.94 ...). */
const NTSC_DIVISOR = 1.001;
/** Denominator for a non-integer, non-NTSC rate: three decimals. */
const FRACTIONAL_FPS_DENOMINATOR = 1000;

/** The exact rational for a float frame rate, or `null` when it is not a
 *  finite positive rate within {@link MAX_TIMELINE_FPS}. 30 -> 30/1,
 *  29.97 -> 30000/1001, 12.5 -> 12500/1000. */
export function fpsToRational(fps: number): Rational | null {
  if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_TIMELINE_FPS) return null;
  const whole = Math.round(fps);
  if (Math.abs(fps - whole) < WHOLE_FPS_EPSILON) return { num: whole, den: 1 };
  const ntscBase = Math.round(fps * NTSC_DIVISOR);
  if (Math.abs(fps - (ntscBase * 1000) / 1001) < NTSC_FPS_TOLERANCE) return { num: ntscBase * 1000, den: 1001 };
  return { num: Math.round(fps * FRACTIONAL_FPS_DENOMINATOR), den: FRACTIONAL_FPS_DENOMINATOR };
}

/** Whether `r` is a rate a timeline may take. */
export function isValidTimelineRate(r: Rational): boolean {
  return Number.isFinite(r.num) && Number.isFinite(r.den) && r.num > 0 && r.den > 0 && r.num / r.den <= MAX_TIMELINE_FPS;
}

/** Round half away from zero, as Rust's `f64::round` does (`Math.round` rounds
 *  halves toward +infinity, which differs for a negative frame). */
function roundAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** `frames` scaled by `ratio`, rounded; a non-zero span never collapses to 0. */
function scale(frames: number, ratio: number): number {
  const scaled = roundAway(frames * ratio);
  return frames !== 0 && scaled === 0 ? Math.sign(frames) : scaled;
}

function retimeClip(c: Clip, ratio: number): void {
  c.start_frame = scale(c.start_frame, ratio);
  if (c.fade_in_frames !== undefined) c.fade_in_frames = scale(c.fade_in_frames, ratio);
  if (c.fade_out_frames !== undefined) c.fade_out_frames = scale(c.fade_out_frames, ratio);
  if (c.source_fps !== undefined && c.source_fps !== null && c.source_fps > 0) return;
  c.source_start = scale(c.source_start, ratio);
  c.duration = scale(c.duration, ratio);
  c.source_len = scale(c.source_len, ratio);
  for (const p of c.speed_points ?? []) p.source_frame = scale(p.source_frame, ratio);
  for (const h of c.highlights ?? []) {
    h.at = scale(h.at, ratio);
    h.dur = scale(h.dur, ratio);
  }
  for (const k of c.chroma_keyframes ?? []) k.frame = scale(k.frame, ratio);
}

/** The effective frame rate of a timeline (its `rate`, else 24). */
function effectiveFps(tl: Timeline, defaultFps: number): number {
  const r = tl.rate;
  return r && r.num > 0 && r.den > 0 ? r.num / r.den : defaultFps;
}

/**
 * `tl` at the new `rate`, every timeline-frame quantity converted by time (see
 * the module doc). The input is not mutated; a rate equal to the current one
 * returns `tl` itself. `defaultFps` is what an unrated timeline resolves to
 * (`DEFAULT_FPS`, passed in so this module need not import it back).
 */
export function retimeTimeline(tl: Timeline, rate: Rational, defaultFps: number): Timeline {
  const ratio = rate.num / rate.den / effectiveFps(tl, defaultFps);
  const next: Timeline = structuredClone(tl);
  next.rate = { num: rate.num, den: rate.den };
  if (Math.abs(ratio - 1) < 1e-12) return tl.rate && tl.rate.num === rate.num && tl.rate.den === rate.den ? tl : next;
  for (const track of next.tracks) {
    for (const clip of track.clips) retimeClip(clip, ratio);
    for (const t of track.transitions ?? []) {
      t.at_frame = scale(t.at_frame, ratio);
      t.duration = scale(t.duration, ratio);
    }
  }
  for (const m of next.markers ?? []) {
    m.frame = scale(m.frame, ratio);
    if (m.duration_frames !== undefined) m.duration_frames = scale(m.duration_frames, ratio);
  }
  return next;
}
