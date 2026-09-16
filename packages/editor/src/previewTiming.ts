/**
 * previewTiming.ts — what the Edit-tab preview's playback loop ACTUALLY did,
 * measured in the webview (D-219, `docs/notes/debug-tooling.md` piece 5).
 *
 * What it is: two small ring buffers of `performance.now()` timestamps that
 *   `PreviewPane` writes to as it plays — one per `requestAnimationFrame`
 *   tick, one per frame actually handed to the `<img>` — plus, since D-290,
 *   two ring buffers of DURATIONS covering what one iteration of that loop
 *   spent its time on, plus a report that turns all four into intervals, the
 *   derived fps, the drop count and the per-phase spread. The debug op
 *   `debug_frame_timing` reads it.
 *
 * **Why the duration channels exist (D-290).** The two timestamp channels can
 *   say the loop is running at 40 fps; they cannot say WHERE the 25 ms went,
 *   and that is exactly the question the owner's "playback lags" report needs
 *   answered. D-290 profiled the loop from outside using only these two
 *   channels plus a natural experiment (playing over a timeline GAP, whose
 *   frame is a 1×1 JPEG and so costs no decode at all) and could get as far as
 *   "≈3.5 ms is Rust, ≈21.5 ms is this side" — and then stopped, because
 *   nothing could split that 21.5 ms further. So the tool got the missing
 *   half rather than the diagnosis getting a guess:
 *     * `fetch` — the `chroma_timeline_frame` round trip (Tauri IPC + the Rust
 *       decode/composite/JPEG). Everything below the webview.
 *     * `tick`  — one whole pass of the play loop's `tick`, from entry to the
 *       moment it asks for the next animation frame. `tick − fetch` is the
 *       loop's own JavaScript (the `Blob`, the object URL, the store write).
 *   And `raf`'s interval minus `tick` is what is left: React's render/commit
 *   for that frame plus however long the browser made the loop wait for its
 *   next animation frame. Three numbers, one subtraction each, no guessing.
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
 * and this module is tree-shaken out along with them (D-219's frontend gate).
 * Pure and injectable (`at` is a parameter) so the statistics are unit-tested
 * without a clock — see `previewTiming.test.ts`.
 */

/** How many timestamps to keep per channel. ~4 seconds at 60 Hz — long enough
 *  to see a stall and short enough that the report stays readable and the
 *  buffers stay allocation-free after the first fill. */
export const TIMING_CAPACITY = 240;

/** How many intervals a report returns when the caller names no limit.
 *  Everything derived (min/median/p95/max/fps) is computed over the whole
 *  buffer unless a `windowMs` narrows it (see {@link previewTimingReport});
 *  the limit only ever trims the raw list. */
export const DEFAULT_REPORT_LIMIT = 60;

/** The default time window for a LIVE readout (D-330).
 *
 *  Why a window exists at all: the ring buffer holds {@link TIMING_CAPACITY}
 *  samples, which at the frame rates this preview actually hits (5–25 fps,
 *  per D-290/D-325) is **10 to 48 seconds** of history. Averaged whole, that
 *  is the right number for "what did this playback run do" and the WRONG one
 *  for "what is it doing right now": a fix that doubles the frame rate would
 *  take half a minute to show up, and a recording made to demonstrate it
 *  would spend most of its length displaying the old number.
 *
 *  2 s is the compromise the on-screen overlay uses: long enough to hold ~20
 *  intervals at 10 fps (so one slow frame does not swing the readout), short
 *  enough that a real change appears within about a second of happening. */
export const DEFAULT_TIMING_WINDOW_MS = 2000;

export type PreviewTimingChannel = 'raf' | 'paint';

/** The D-290 duration channels. Unlike {@link PreviewTimingChannel} these hold
 *  already-measured spans in ms, not moments in time — see the module doc for
 *  what each one covers and which subtraction it is meant for.
 *
 *  `scrub` is D-334's addition and is deliberately a THIRD channel rather than
 *  more samples in `fetch`. Both time the same `chroma_timeline_frame` round
 *  trip, but they are not the same measurement: `fetch` is only ever recorded
 *  inside the play loop, where the decode pipe is streaming forward and D-290
 *  measured ~3.5 ms of Rust; `scrub` is the paused path, where the requested
 *  frame is frequently BEHIND the pipe and so costs a kill-and-respawn plus a
 *  keyframe seek instead. Averaging the two together would hide exactly the
 *  difference this channel exists to expose, and would silently change what
 *  every pre-D-334 `fetch` number meant. */
export type PreviewSpanChannel = 'fetch' | 'tick' | 'scrub';

const buffers: Record<PreviewTimingChannel, number[]> = { raf: [], paint: [] };

/** One recorded duration, and WHEN it was recorded (D-330).
 *
 *  The `at` is not reported anywhere; it exists so a `windowMs` can narrow
 *  the cost channels by the same real time span as the cadence channels. A
 *  duration alone has no position in time, so without this a windowed report
 *  could only narrow two of its four channels — and two channels silently
 *  covering a different span from the other two is exactly the kind of
 *  quietly-wrong number this module must not produce. */
interface Span {
  at: number;
  ms: number;
}

const spans: Record<PreviewSpanChannel, Span[]> = { fetch: [], tick: [], scrub: [] };

/** Record one event. `at` defaults to `performance.now()` and is a parameter
 *  purely so the tests can drive a deterministic clock. */
export function recordPreviewTiming(channel: PreviewTimingChannel, at: number = performance.now()): void {
  const buf = buffers[channel];
  buf.push(at);
  if (buf.length > TIMING_CAPACITY) buf.shift();
}

/** Record one already-measured duration, in ms (D-290). Negative and
 *  non-finite values are dropped rather than stored: a span is always computed
 *  as `now - start`, so anything else is a caller bug, and silently poisoning
 *  the median with it would make the readout untrustworthy — which is the one
 *  thing this module cannot afford to be. */
export function recordPreviewSpan(
  channel: PreviewSpanChannel,
  ms: number,
  at: number = performance.now(),
): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const buf = spans[channel];
  buf.push({ at, ms });
  if (buf.length > TIMING_CAPACITY) buf.shift();
}

export function resetPreviewTiming(): void {
  buffers.raf = [];
  buffers.paint = [];
  spans.fetch = [];
  spans.tick = [];
  spans.scrub = [];
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

/** One duration channel's spread (D-290). No `fps` and no `hitches`: those
 *  are properties of a CADENCE, and these samples are costs, not moments. */
export interface SpanTimingReport {
  /** how many durations the buffer holds (≤ {@link TIMING_CAPACITY}) */
  samples: number;
  /** the most recent durations in ms, oldest first, rounded to 0.01 */
  msLatest: number[];
  /** null when the buffer is empty */
  minMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

export interface PreviewTimingReport {
  /** `requestAnimationFrame` ticks: how often the play loop got to run at
   *  all. A near-zero fps here with a healthy `paint` fps means the WINDOW is
   *  throttled (backgrounded), not that decoding is slow. */
  raf: ChannelTimingReport;
  /** frames actually handed to the preview `<img>`. */
  paint: ChannelTimingReport;
  /** D-290 — the `chroma_timeline_frame` round trip: Tauri IPC plus all of
   *  Rust's decode + composite + JPEG encode. Everything below the webview. */
  fetch: SpanTimingReport;
  /** D-290 — one whole pass of the play loop's `tick`. `tick.medianMs −
   *  fetch.medianMs` is the loop's own JavaScript; `raf.medianMs −
   *  tick.medianMs` is React's render/commit plus the wait for the next
   *  animation frame. */
  tick: SpanTimingReport;
  /** D-334 — the same `chroma_timeline_frame` round trip as `fetch`, but
   *  measured on the PAUSED/scrub path, where the decode pipe is usually being
   *  asked for a frame behind its read head. A `scrub.medianMs` far above
   *  `fetch.medianMs` is the signature of the respawn-and-keyframe-seek cost,
   *  not of a slow webview. Empty while nothing has scrubbed. */
  scrub: SpanTimingReport;
  capacity: number;
  /** D-330 — the time window every channel above was derived over, in ms, or
   *  `null` for "the whole ring buffer" (the default, and what every report
   *  before D-330 did). Always reported, so a number read out of this object
   *  can never be mistaken for covering a different span than it does. */
  windowMs: number | null;
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

/** The tail of `items` that falls within `windowMs` of `anchor` (D-330).
 *
 *  **Two anchors, for two genuinely different questions**, and picking the
 *  wrong one produces a number that is not false so much as answering
 *  something nobody asked:
 *
 *  * `anchor === null` — the NEWEST sample. This is what `debug_frame_timing`
 *    uses, because the buffers are normally read *after the fact* (play,
 *    stop, then read; the tool's own docstring prescribes exactly that), and
 *    anchoring on the clock would report an empty window for every such call.
 *  * an explicit `anchor` (in practice `performance.now()`) — what the
 *    on-screen overlay uses. A live readout must describe the present, and a
 *    newest-anchored one *freezes* on its last value the moment frames stop,
 *    so a recording would go on displaying "17.1 fps" over an app that has
 *    not painted for thirty seconds. Found doing exactly that during D-330's
 *    own live verification.
 *
 *  The two do not disagree about any measurement: while frames are flowing,
 *  `now ≈ newest` and both select the same samples (measured live: the
 *  overlay's 16.6 against the tool's 16.65 read back-to-back). The only
 *  difference is that the live anchor additionally goes EMPTY — rendered as
 *  `--`, never as `0.0` — rather than asserting a stale number.
 *
 *  Windowing by TIME, not by count: a count-based window covers a different
 *  real span at every frame rate, which is precisely the comparison this is
 *  used for (before/after a performance fix). */
function withinWindow<T>(
  items: T[],
  windowMs: number | null,
  at: (item: T) => number,
  anchor: number | null,
): T[] {
  if (windowMs === null || !items.length) return items;
  const cutoff = (anchor ?? at(items[items.length - 1])) - windowMs;
  // The buffers are append-only in time order, so the kept set is a suffix;
  // scanning back from the end stops as soon as it leaves the window.
  let start = items.length;
  while (start > 0 && at(items[start - 1]) >= cutoff) start -= 1;
  return items.slice(start);
}

function spanReport(durations: number[], limit: number): SpanTimingReport {
  const tail = durations.slice(Math.max(0, durations.length - limit)).map(round2);
  if (!durations.length) {
    return { samples: 0, msLatest: tail, minMs: null, medianMs: null, p95Ms: null, maxMs: null, meanMs: null };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const mean = durations.reduce((sum, n) => sum + n, 0) / durations.length;
  return {
    samples: durations.length,
    msLatest: tail,
    minMs: round2(sorted[0]),
    medianMs: round2(quantile(sorted, 0.5)),
    p95Ms: round2(quantile(sorted, 0.95)),
    maxMs: round2(sorted[sorted.length - 1]),
    meanMs: round2(mean),
  };
}

/** Turn the four ring buffers into one report.
 *
 *  `limit` trims the raw `intervalsMs`/`msLatest` lists only. `windowMs`
 *  (D-330) narrows what everything DERIVED is computed over, to the samples
 *  within that many ms of the newest one — `null`/omitted means the whole
 *  buffer, which is exactly what this function did before D-330, so every
 *  existing caller is unchanged.
 *
 *  One edge effect worth knowing when reading a windowed cadence channel: the
 *  window selects SAMPLES, and intervals are measured between the samples it
 *  kept, so the one interval straddling the cutoff is dropped rather than
 *  half-counted. At the default 2 s window that is one interval in ~20 — far
 *  below the run-to-run spread — and the alternative (keeping a sample from
 *  outside the window) would mean reporting an interval that mostly covers
 *  time the window claims to exclude. */
export function previewTimingReport(
  limit: number = DEFAULT_REPORT_LIMIT,
  windowMs: number | null = null,
  anchor: number | null = null,
): PreviewTimingReport {
  const capped = Math.min(Math.max(Math.round(limit), 1), TIMING_CAPACITY);
  const win = windowMs === null || !Number.isFinite(windowMs) || windowMs <= 0 ? null : windowMs;
  const stampAt = (n: number) => n;
  const spanAt = (s: Span) => s.at;
  return {
    raf: channelReport(withinWindow(buffers.raf, win, stampAt, anchor), capped),
    paint: channelReport(withinWindow(buffers.paint, win, stampAt, anchor), capped),
    fetch: spanReport(
      withinWindow(spans.fetch, win, spanAt, anchor).map((s) => s.ms),
      capped,
    ),
    tick: spanReport(
      withinWindow(spans.tick, win, spanAt, anchor).map((s) => s.ms),
      capped,
    ),
    scrub: spanReport(
      withinWindow(spans.scrub, win, spanAt, anchor).map((s) => s.ms),
      capped,
    ),
    capacity: TIMING_CAPACITY,
    windowMs: win,
  };
}

/** Just the two live frame rates, for the on-screen overlay (D-330).
 *
 *  A thin projection of {@link previewTimingReport} rather than a second
 *  measurement — that is the whole point. The overlay burning a number into a
 *  recording and `debug_frame_timing` answering an agent MUST be the same
 *  number computed the same way over the same window, or the recording is not
 *  evidence of anything. Passing the same `windowMs` to both makes them agree
 *  by construction; the overlay displays the window it used so the two can be
 *  checked against each other. */
export interface PreviewLiveFps {
  paintFps: number | null;
  rafFps: number | null;
  paintSamples: number;
  rafSamples: number;
  /** `paint` intervals over twice the median — visible stutter, in-window. */
  hitches: number;
  windowMs: number;
}

export function previewLiveFps(
  windowMs: number = DEFAULT_TIMING_WINDOW_MS,
  now: number = performance.now(),
): PreviewLiveFps {
  const win = !Number.isFinite(windowMs) || windowMs <= 0 ? DEFAULT_TIMING_WINDOW_MS : windowMs;
  // `limit: 1` — the overlay needs no raw interval list, and asking for the
  // default 60 would allocate two arrays four times a second for nothing.
  //
  // `now` as the anchor, unlike `debug_frame_timing`'s newest-sample one: a
  // readout burned into a recording has to describe the present, so when
  // nothing has painted for a whole window it must go blank rather than keep
  // displaying the last number it saw. See `withinWindow`. Injectable so the
  // staleness behaviour is testable on a deterministic clock.
  const report = previewTimingReport(1, win, now);
  return {
    paintFps: report.paint.fps,
    rafFps: report.raf.fps,
    paintSamples: report.paint.samples,
    rafSamples: report.raf.samples,
    hitches: report.paint.hitches,
    windowMs: win,
  };
}
