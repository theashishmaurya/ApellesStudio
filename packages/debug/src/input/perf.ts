/**
 * perf.ts — what the UI did, frame by frame, while a gesture ran (D-434).
 *
 * What it is: a `requestAnimationFrame` loop that runs for the duration of
 *   one `debug_pointer` / `debug_key` call and records:
 *     - every frame's timestamp → frame-time p50/p95/max and dropped frames
 *       against `FRAME_BUDGET_MS` (main-thread jank during a drag/scroll/zoom);
 *     - optionally, on every frame, the live rects of `watch.selectors` and
 *       the CSS cursor under the pointer — the "does the clip block visibly
 *       move on every pointermove, and does the cursor change to the tool's
 *       cursor" evidence the owner asked for (D-434, coordinator note), which
 *       a before/after store comparison cannot give;
 *     - store commits (`noteStoreChange`) → input-to-update latency.
 *
 * What it does NOT do: measure the Edit preview's playback loop — that is
 *   `debug_frame_timing` (`@apelles/editor`'s `previewTiming.ts`), a separate
 *   instrument with separate channels; the scenario runner reads that one
 *   around playback steps.
 *
 * The rAF loop is the measurement, so it is subject to the same throttling
 *   any rAF is: a window WebKit considers occluded runs no frames at all, and
 *   then `frames.samples` is 0 — reported as such, never as "0 ms". Turn
 *   occlusion throttling off first (`debug_set_occlusion_throttling`).
 */

import { describeElement } from './geometry';
import { droppedFrames, FRAME_BUDGET_MS, intervals, summarize, type Summary } from './stats';

export interface WatchOptions {
  /** CSS selectors whose matched elements' rects are sampled every frame. */
  selectors?: readonly string[];
  /** Also sample the computed `cursor` of the element under the pointer. */
  cursor?: boolean;
  /** Cap on recorded frames. Default {@link DEFAULT_WATCH_FRAMES}. */
  maxFrames?: number;
}

export const DEFAULT_WATCH_FRAMES = 120;
/** At most this many elements per watched selector are sampled per frame. */
export const MAX_WATCH_MATCHES = 8;

export interface WatchedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WatchFrame {
  /** ms since the gesture started. */
  t: number;
  rects: Record<string, WatchedRect[]>;
  cursor?: string;
  under?: string | null;
}

export interface PerfReport {
  frameBudgetMs: number;
  frames: (Summary & { dropped: number }) | { samples: 0 };
  /** Per input event: time from the event to the next animation frame. */
  inputToFrame: Summary | null;
  store: {
    commits: number;
    /** From the first input event to the first store commit after it. */
    firstCommitAfterInputMs: number | null;
    /** From the LAST input event to the last store commit — how long the UI
     *  kept changing after the hand stopped. */
    lastCommitAfterLastInputMs: number | null;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface FrameSampler {
  noteStoreChange(): void;
  stop(inputTimes: readonly number[]): { perf: PerfReport; watch: WatchFrame[] | null; watchTruncated: boolean };
}

export function startFrameSampler(opts: {
  win?: Window;
  watch?: WatchOptions | null;
  pointer?: () => { x: number; y: number } | null;
}): FrameSampler {
  const win = opts.win ?? window;
  const doc = win.document;
  const now = () => win.performance?.now() ?? Date.now();
  const t0 = now();
  const frameTimes: number[] = [];
  const storeTimes: number[] = [];
  const watch = opts.watch && ((opts.watch.selectors?.length ?? 0) > 0 || opts.watch.cursor) ? opts.watch : null;
  const maxFrames = Math.max(1, Math.round(watch?.maxFrames ?? DEFAULT_WATCH_FRAMES));
  const watchFrames: WatchFrame[] = [];
  let watchTruncated = false;
  let running = true;
  let handle = 0;

  const sampleWatch = (ts: number) => {
    if (!watch) return;
    if (watchFrames.length >= maxFrames) {
      watchTruncated = true;
      return;
    }
    const frame: WatchFrame = { t: r1(ts - t0), rects: {} };
    for (const sel of watch.selectors ?? []) {
      let els: Element[] = [];
      try {
        els = Array.from(doc.querySelectorAll(sel)).slice(0, MAX_WATCH_MATCHES);
      } catch {
        els = [];
      }
      frame.rects[sel] = els.map((el) => {
        const b = el.getBoundingClientRect();
        return { x: r1(b.x), y: r1(b.y), width: r1(b.width), height: r1(b.height) };
      });
    }
    if (watch.cursor) {
      const p = opts.pointer?.() ?? null;
      const el = p && typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(p.x, p.y) : null;
      frame.under = describeElement(el);
      frame.cursor = el ? win.getComputedStyle(el).cursor : undefined;
    }
    watchFrames.push(frame);
  };

  const tick = (ts: number) => {
    if (!running) return;
    frameTimes.push(ts);
    sampleWatch(ts);
    handle = win.requestAnimationFrame(tick);
  };
  handle = win.requestAnimationFrame(tick);

  return {
    noteStoreChange: () => {
      storeTimes.push(now());
    },
    stop(inputTimes) {
      running = false;
      win.cancelAnimationFrame(handle);
      const frameIntervals = intervals(frameTimes);
      const summary = summarize(frameIntervals);
      const latencies: number[] = [];
      for (const t of inputTimes) {
        const next = frameTimes.find((f) => f >= t);
        if (next !== undefined) latencies.push(next - t);
      }
      const firstInput = inputTimes.length ? Math.min(...inputTimes) : null;
      const lastInput = inputTimes.length ? Math.max(...inputTimes) : null;
      const firstCommit = firstInput === null ? undefined : storeTimes.find((s) => s >= firstInput);
      const lastCommit = storeTimes.length ? storeTimes[storeTimes.length - 1] : undefined;
      return {
        perf: {
          frameBudgetMs: r1(FRAME_BUDGET_MS),
          frames: summary ? { ...summary, dropped: droppedFrames(frameIntervals) } : { samples: 0 },
          inputToFrame: summarize(latencies),
          store: {
            commits: storeTimes.length,
            firstCommitAfterInputMs: firstInput !== null && firstCommit !== undefined ? r1(firstCommit - firstInput) : null,
            lastCommitAfterLastInputMs:
              lastInput !== null && lastCommit !== undefined && lastCommit >= lastInput ? r1(lastCommit - lastInput) : null,
          },
        },
        watch: watch ? watchFrames : null,
        watchTruncated,
      };
    },
  };
}
