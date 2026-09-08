/**
 * previewTiming.ts — what the Edit-tab preview's playback loop ACTUALLY did,
 * measured in the webview (D-218, `docs/notes/debug-tooling.md` piece 5).
 *
 * What it is: two small ring buffers of `performance.now()` timestamps that
 *   `PreviewPane` writes to as it plays — one per `requestAnimationFrame`
 *   tick, one per frame actually handed to the `<img>` — plus a report that
 *   turns them into the intervals, the derived fps, and the drop count. The
 *   debug op `debug_frame_timing` reads it.
 *
 * Why it exists: D-217 fixed the preview's dominant per-frame cost (42.7 →
 *   14.0 ms) and could measure that precisely in Rust, but could NOT measure
 *   the thing the owner actually reported — perceived smoothness — because
 *   nothing could see webview-side timing. Two blockers made the obvious
 *   route impossible: a second app instance needs its `identifier` overridden,
 *   and a **background** window's `requestAnimationFrame` is throttled to a
 *   stop, so the play loop does not tick at all in a non-frontmost instance.
 *   Measuring in-app sidesteps both: the app times itself and an agent reads
 *   the numbers, with no window needing focus and no second instance.
 *
 * What it does NOT do: measure the browser's actual compositor paint. `paint`
 *   here means "the object URL for this frame was handed to React", which is
 *   the last moment this code controls; the pixels land a compositor frame
 *   later. It also doesn't measure the Rust decode/composite cost — that is
 *   already instrumented on the Rust side (D-217) and is the other half of
 *   the same picture.
 *
 * **Debug-only.** Every call site in `PreviewPane.tsx` is wrapped in
 * `if (import.meta.env.DEV)`, so a production build constant-folds them away
 * and this module is tree-shaken out along with them (D-218's frontend gate).
 * Pure and injectable (`at` is a parameter) so the statistics are unit-tested
 * without a clock — see `previewTiming.test.ts`.
 */

/** How many timestamps to keep per channel. ~4 seconds at 60 Hz — long enough
 *  to see a stall and short enough that the report stays readable and the
 *  buffers stay allocation-free after the first fill. */
export const TIMING_CAPACITY = 240;

/** How many intervals a report returns when the caller names no limit.
 *  Everything derived (min/median/p95/max/fps) is computed over the WHOLE
 *  buffer regardless — the limit only trims the raw list. */
export const DEFAULT_REPORT_LIMIT = 60;

export type PreviewTimingChannel = 'raf' | 'paint';

const buffers: Record<PreviewTimingChannel, number[]> = { raf: [], paint: [] };

/** Record one event. `at` defaults to `performance.now()` and is a parameter
 *  purely so the tests can drive a deterministic clock. */
export function recordPreviewTiming(channel: PreviewTimingChannel, at: number = performance.now()): void {
  const buf = buffers[channel];
  buf.push(at);
  if (buf.length > TIMING_CAPACITY) buf.shift();
}

export function resetPreviewTiming(): void {
  buffers.raf = [];
  buffers.paint = [];
}

export interface ChannelTimingReport {
  /** how many timestamps the buffer holds (≤ {@link TIMING_CAPACITY}) */
  samples: number;
  /** the most recent intervals in ms, oldest first, rounded to 0.01 */
  intervalsMs: number[];
  /** null when fewer than two samples — there is no interval yet */
  minMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** 1000 / mean interval, over the whole buffer */
  fps: number | null;
  /** intervals longer than twice the median — a real hitch, not jitter */
  hitches: number;
}

export interface PreviewTimingReport {
  /** `requestAnimationFrame` ticks: how often the play loop got to run at
   *  all. A near-zero fps here with a healthy `paint` fps means the WINDOW is
   *  throttled (backgrounded), not that decoding is slow. */
  raf: ChannelTimingReport;
  /** frames actually handed to the preview `<img>`. */
  paint: ChannelTimingReport;
  capacity: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The value at `q` (0..1) of an already-sorted array, nearest-rank. */
function quantile(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function channelReport(stamps: number[], limit: number): ChannelTimingReport {
  const intervals: number[] = [];
  for (let i = 1; i < stamps.length; i += 1) intervals.push(stamps[i] - stamps[i - 1]);

  const tail = intervals.slice(Math.max(0, intervals.length - limit)).map(round2);
  if (!intervals.length) {
    return {
      samples: stamps.length,
      intervalsMs: tail,
      minMs: null,
      medianMs: null,
      p95Ms: null,
      maxMs: null,
      fps: null,
      hitches: 0,
    };
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const mean = intervals.reduce((sum, n) => sum + n, 0) / intervals.length;
  return {
    samples: stamps.length,
    intervalsMs: tail,
    minMs: round2(sorted[0]),
    medianMs: round2(median),
    p95Ms: round2(quantile(sorted, 0.95)),
    maxMs: round2(sorted[sorted.length - 1]),
    fps: mean > 0 ? round2(1000 / mean) : null,
    // Twice the median, not a fixed ms threshold: "slow" depends on the frame
    // rate being attempted, and a fixed number would call every interval a
    // hitch on a 24 fps timeline and none of them on a stalled one.
    hitches: intervals.filter((ms) => ms > median * 2).length,
  };
}

export function previewTimingReport(limit: number = DEFAULT_REPORT_LIMIT): PreviewTimingReport {
  const capped = Math.min(Math.max(Math.round(limit), 1), TIMING_CAPACITY);
  return {
    raf: channelReport(buffers.raf, capped),
    paint: channelReport(buffers.paint, capped),
    capacity: TIMING_CAPACITY,
  };
}
