/**
 * perfMethod.ts - how a measured step is run so its numbers mean something
 * (B-347 F6, harness H17; `docs/notes/timeline-drag-perf.md`).
 *
 * What it is: the pure rules the runner applies to a `measure` step.
 *   - `measuredArgs` removes the per-frame rect `watch` (its
 *     `getBoundingClientRect` forces a layout every frame, +5-25 ms of p95) unless
 *     the run asked for live-feedback evidence, and stretches a short gesture so it
 *     yields enough frames for a p95 to be more than "the second-worst frame".
 *   - `summarizeEditMarks` turns the `apelles:edit:*` entries `debug_perf_entries`
 *     returns into the exact per-phase numbers the report attaches to the step.
 *
 * What it does NOT do: send anything or decide a verdict (`budgets.ts` does).
 */

import { EDIT_PERF } from '@apelles/editor/src/editPerfNames.ts';
import { summarize } from '@apelles/debug/src/input/stats.ts';

/** A measured gesture lasts at least this long: ~90 frames at 60 Hz. */
export const MIN_MEASURED_GESTURE_MS = 1500;
/** Pointer moves per second when a gesture is stretched (the harness's own 33 Hz shape). */
export const STRETCH_MOVES_PER_SECOND = 33;
/** How long the page must be quiet before a measured step starts. */
export const IDLE_QUIET_MS = 400;

type Args = Record<string, unknown>;

export interface MeasuredArgs {
  args: Args;
  /** The rect watch was dropped, so a `live` / `cursor` assertion has no frames to read. */
  watchDropped: boolean;
  /** The gesture's duration was lengthened to {@link MIN_MEASURED_GESTURE_MS}. */
  stretched: boolean;
}

/**
 * The wire args of a measured `debug_pointer` step. `keepWatch` (the run's
 * `--evidence` mode) leaves the watch and the gesture exactly as the scenario
 * wrote them. Only a gesture that has a duration and a step count (a drag or a
 * path move) is stretched, and only longer: the endpoints are unchanged.
 */
export function measuredArgs(args: Args, keepWatch: boolean): MeasuredArgs {
  if (keepWatch) return { args, watchDropped: false, stretched: false };
  const next: Args = { ...args };
  const watchDropped = 'watch' in next;
  delete next.watch;
  let stretched = false;
  const duration = typeof next.durationMs === 'number' ? next.durationMs : null;
  if (duration !== null && duration < MIN_MEASURED_GESTURE_MS && (next.action === 'drag' || next.action === 'move')) {
    const legs = 1 + (Array.isArray(next.path) ? next.path.length : 0);
    next.durationMs = MIN_MEASURED_GESTURE_MS;
    // `steps` is per path segment (debug_pointer): keep ~33 moves a second overall.
    next.steps = Math.max(Number(next.steps ?? 0), Math.round(((MIN_MEASURED_GESTURE_MS / 1000) * STRETCH_MOVES_PER_SECOND) / legs));
    stretched = true;
  }
  return { args: next, watchDropped, stretched };
}

export interface PerfEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

export interface EditMarkNumbers {
  /** How many live previews ran, and the per-preview cost. */
  previews: number;
  previewP50Ms: number | null;
  previewP95Ms: number | null;
  previewMaxMs: number | null;
  /** The last commit: release -> React rendered, and release -> painted. */
  commitRenderedMs: number | null;
  commitPaintedMs: number | null;
}

const last = (entries: readonly PerfEntry[], name: string): number | null => {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].name === name) return entries[i].duration;
  return null;
};

/** `null` when the app wrote no edit marks (a production web bundle, or a gesture that never ran). */
export function summarizeEditMarks(entries: readonly PerfEntry[]): EditMarkNumbers | null {
  const previews = entries.filter((e) => e.name === EDIT_PERF.preview).map((e) => e.duration);
  const rendered = last(entries, EDIT_PERF.commitRendered);
  const painted = last(entries, EDIT_PERF.commitPainted);
  if (previews.length === 0 && rendered === null && painted === null) return null;
  const s = summarize(previews);
  return {
    previews: previews.length,
    previewP50Ms: s?.p50Ms ?? null,
    previewP95Ms: s?.p95Ms ?? null,
    previewMaxMs: s?.maxMs ?? null,
    commitRenderedMs: rendered,
    commitPaintedMs: painted,
  };
}
