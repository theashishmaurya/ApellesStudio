/**
 * perfEntries.ts - read the app's own `performance` marks, and wait for the page
 * to go idle (B-347, D-434; `docs/notes/timeline-drag-perf.md` "Instrument next").
 *
 * What it is: the two pure-ish halves of the `debug_perf_entries` op.
 *   - `readPerfEntries` lists the `performance` mark / measure entries whose name
 *     starts with a prefix (the edit gestures write `apelles:edit:*`, see
 *     `@apelles/editor`'s `editPerf.ts`), optionally deleting them so the next
 *     read holds only the next gesture.
 *   - `waitForIdle` resolves once animation frames have arrived on time for a
 *     stretch of `quietMs`, so a measurement does not start while the page is still
 *     decoding the filmstrip and waveform requests a freshly built fixture queued.
 *
 * What it does NOT do: write marks, or decide what a number means. Both take their
 * clock and scheduler as parameters so they are unit-tested without a browser.
 * Debug-only like the rest of this package (the op is registered only in a debug
 * build, D-219).
 */

export interface PerfEntryDto {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

/** Just the part of `Performance` this reads, so a test can hand in a stub. */
export interface PerfSource {
  getEntries(): PerformanceEntry[];
  clearMarks(name?: string): void;
  clearMeasures(name?: string): void;
}

export const DEFAULT_PERF_PREFIX = 'apelles:';

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The mark / measure entries named `prefix*`, oldest first; with `clear`, also deleted. */
export function readPerfEntries(perf: PerfSource, prefix: string = DEFAULT_PERF_PREFIX, clear = false): PerfEntryDto[] {
  const out: PerfEntryDto[] = [];
  const names = new Set<string>();
  for (const e of perf.getEntries()) {
    if ((e.entryType !== 'mark' && e.entryType !== 'measure') || !e.name.startsWith(prefix)) continue;
    out.push({ name: e.name, entryType: e.entryType, startTime: r1(e.startTime), duration: r1(e.duration) });
    names.add(e.name);
  }
  if (clear) {
    for (const name of names) {
      perf.clearMarks(name);
      perf.clearMeasures(name);
    }
  }
  return out;
}

/** A frame gap above this is "the page was busy" (a 60 Hz frame is 16.7 ms). */
export const IDLE_MAX_FRAME_MS = 24;
/** The longest `waitForIdle` waits, whatever it was asked for. */
export const IDLE_MAX_WAIT_MS = 5000;

export interface IdleDeps {
  raf(cb: (ts: number) => void): number;
  cancelRaf(handle: number): void;
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface IdleResult {
  waitedMs: number;
  /** false = the page never went quiet (or never drew a frame) within the cap. */
  reached: boolean;
}

/** Resolve when `quietMs` has passed with every frame gap <= {@link IDLE_MAX_FRAME_MS}. */
export function waitForIdle(deps: IdleDeps, quietMs: number, timeoutMs: number = IDLE_MAX_WAIT_MS): Promise<IdleResult> {
  const quiet = Math.max(0, quietMs);
  const cap = Math.min(IDLE_MAX_WAIT_MS, Math.max(quiet, timeoutMs));
  const started = deps.now();
  return new Promise((resolve) => {
    let quietSince = started;
    let last: number | null = null;
    let handle = 0;
    let done = false;
    const finish = (reached: boolean) => {
      if (done) return;
      done = true;
      deps.cancelRaf(handle);
      deps.clearTimer(timer);
      resolve({ waitedMs: r1(deps.now() - started), reached });
    };
    // A throttled window never fires a frame: the timer is what ends the wait.
    const timer = deps.setTimer(() => finish(false), cap);
    const tick = (ts: number) => {
      if (done) return;
      if (last !== null && ts - last > IDLE_MAX_FRAME_MS) quietSince = ts;
      last = ts;
      if (ts - quietSince >= quiet) finish(true);
      else handle = deps.raf(tick);
    };
    if (quiet === 0) finish(true);
    else handle = deps.raf(tick);
  });
}

/** The browser's own scheduler, for the live op. */
export function browserIdleDeps(win: Window = window): IdleDeps {
  return {
    raf: (cb) => win.requestAnimationFrame(cb),
    cancelRaf: (h) => win.cancelAnimationFrame(h),
    now: () => win.performance.now(),
    setTimer: (cb, ms) => win.setTimeout(cb, ms),
    clearTimer: (h) => win.clearTimeout(h as number),
  };
}
