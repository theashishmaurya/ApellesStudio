/**
 * editPerf.ts - `performance` marks for the Edit timeline's own edit gestures
 * (B-347, D-434; the design is "Instrument next" in
 * `docs/notes/timeline-drag-perf.md`).
 *
 * What it is: the names of the marks `useEditGesture` writes and four tiny
 * helpers to write them. `debug_perf_entries` (`@apelles/debug`) reads them back
 * so a harness run reports exact per-phase numbers (a preview's cost, the
 * commit's render, the commit's paint) instead of a profiler's proportions.
 *
 * Debug-only, compiled out: every helper is gated on `import.meta.env.DEV`,
 * Vite's build-time constant, so a production web bundle contains none of it
 * (the same gate `previewTiming.ts`'s call sites use, D-219).
 *
 * What it does NOT do: read, aggregate or judge anything. `performance.mark`
 * and `measure` are cheap enough to leave on in development (the profile in the
 * timeline-drag-perf note found `PerformanceUserTiming::measure` costing only
 * through React's own dev tracks, never ours).
 */

/** Every mark / measure name, under one prefix so one read takes them all. */
export const EDIT_PERF_PREFIX = 'apelles:edit:';

export const EDIT_PERF = {
  /** mark: the press claimed an edit gesture. */
  press: `${EDIT_PERF_PREFIX}press`,
  /** mark: a preview started. */
  previewStart: `${EDIT_PERF_PREFIX}preview:start`,
  /** measure: one preview (the op on a copy plus the style writes). */
  preview: `${EDIT_PERF_PREFIX}preview`,
  /** mark: the release is about to call the op. */
  commit: `${EDIT_PERF_PREFIX}commit`,
  /** measure: commit -> React has rendered the result. */
  commitRendered: `${EDIT_PERF_PREFIX}commit-rendered`,
  /** measure: commit -> the frame after it. */
  commitPainted: `${EDIT_PERF_PREFIX}commit-painted`,
} as const;

const enabled = (): boolean => import.meta.env.DEV && typeof performance !== 'undefined' && typeof performance.mark === 'function';

/** Record a point in time. */
export function perfMark(name: string): void {
  if (enabled()) performance.mark(name);
}

/** Record `start` -> now as a measure, `start` being a mark from {@link perfMark}. Ignores a missing mark. */
export function perfMeasure(name: string, startMark: string): void {
  if (!enabled()) return;
  try {
    performance.measure(name, startMark);
  } catch {
    // the start mark was cleared (`debug_perf_entries {clear}`) mid-gesture: nothing to measure
  }
}

/** Measure the commit -> next frame, once the browser has painted. */
export function perfMeasureAfterPaint(name: string, startMark: string): void {
  if (!enabled() || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => perfMeasure(name, startMark));
}
