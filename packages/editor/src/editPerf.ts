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
 * Debug-only, compiled out (D-437 S0a): every helper is gated on the build-time
 * define `import.meta.env.APELLES_PERF_MARKS` (`app/perfMarks.mjs`). It is true under `vite dev` and
 * in a `tauri build --debug` bundle (Tauri sets `TAURI_ENV_DEBUG=true`, and that
 * bundle is production React, the one whose numbers ship), false in a release
 * build, where Vite folds the helpers away. It replaced `import.meta.env.DEV`,
 * which is false in the debug-tauri bundle and so left the harness `null`
 * exactly where the production numbers were needed.
 *
 * The commit is measured three ways (the gap between them is the point):
 *   - `commit-rendered`: commit -> React's layout effects (the DOM is committed)
 *   - `commit-effects`:  commit -> the pane's passive effects have run
 *   - `commit-frame`:    commit -> the next rAF callback (the START of the next
 *                        rendering update, before that frame's style/layout/paint)
 *   - `commit-painted`:  commit -> a task posted from that rAF, which runs after
 *                        the frame has rendered (style, layout, paint, composite
 *                        submitted). `painted - frame` estimates paint + composite.
 *
 * What it does NOT do: read, aggregate or judge anything. `performance.mark`
 * and `measure` are cheap enough to leave on in development (the profile in the
 * timeline-drag-perf note found `PerformanceUserTiming::measure` costing only
 * through React's own dev tracks, never ours).
 */

/// <reference path="./perfMarks.d.ts" />
import { EDIT_PERF as EDIT_PERF_NAMES, EDIT_PERF_PREFIX } from './editPerfNames';

export { EDIT_PERF_PREFIX };

// `import.meta.env.APELLES_PERF_MARKS` is substituted by Vite's `define`; where nothing
// defines it (another package's test run) it is undefined, so no marks and no ReferenceError.
const marksOn = import.meta.env.APELLES_PERF_MARKS === 'true';

/**
 * The mark names. In a release build the constant folds to false and the name
 * table with it, so no `apelles:edit:` string ships; the helpers below are no-ops
 * there and never read a name.
 */
export const EDIT_PERF = (marksOn ? EDIT_PERF_NAMES : {}) as typeof EDIT_PERF_NAMES;

// `typeof` guard: a consumer whose bundler does not define the constant (another
// package's test run) simply gets no marks instead of a ReferenceError.
const enabled = (): boolean => marksOn && typeof performance !== 'undefined' && typeof performance.mark === 'function';

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

/** Measure the commit -> the start of the next frame (the rAF callback). It runs BEFORE that frame's style, layout and paint. */
export function perfMeasureAtFrame(name: string, startMark: string): void {
  if (!enabled() || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => perfMeasure(name, startMark));
}

/**
 * Measure the commit -> after the next frame has rendered. A rAF callback runs at
 * the start of a rendering update, so a task posted from it (a `MessageChannel`
 * message, which unlike `setTimeout` is not clamped or throttled) runs once that
 * update has finished its style, layout and paint work.
 */
export function perfMeasureAfterPaint(name: string, startMark: string): void {
  if (!enabled() || typeof requestAnimationFrame !== 'function' || typeof MessageChannel === 'undefined') return;
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      perfMeasure(name, startMark);
    };
    channel.port2.postMessage(null);
  });
}
