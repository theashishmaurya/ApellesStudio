/**
 * budgets.ts — what "snappy" means, in numbers (D-434).
 *
 * What it is: the performance budgets every measured scenario step is held
 *   to. CLAUDE.md ranks performance first ("a control that lags, a preview
 *   that stutters ... is a real defect"), so a measured step reports its
 *   numbers against these, and an over-budget step is reported as such — a
 *   separate verdict from functional PASS/FAIL, so "it works but janks" is
 *   visible rather than hidden behind a green tick.
 *
 * The sources: one 60 Hz refresh (`FRAME_BUDGET_MS`, shared with the in-app
 *   instrument); Google's RAIL model for input response (a visible response
 *   within 100 ms reads as instant, and 50 ms is the long-task line that
 *   leaves room for it). Each budget is a named constant so a scenario that
 *   needs a different one says which and why.
 */

import { FRAME_BUDGET_MS } from '@apelles/debug/src/input/stats.ts';

export { FRAME_BUDGET_MS };

export interface PerfBudget {
  /** p95 frame-to-frame interval during the gesture. */
  frameP95Ms: number;
  /** Worst single frame during the gesture. */
  frameMaxMs: number;
  /** Missed refreshes as a fraction of frames sampled. */
  droppedRatio: number;
  /** p95 time from an input event to the next animation frame. */
  inputToFrameP95Ms: number;
  /** From the first input to the first store commit it caused (null = not checked). */
  firstCommitMs: number | null;
}

/** p95 within two refreshes: an occasional missed frame is tolerated, a
 *  steady 30 fps during a drag is not. */
export const FRAME_P95_BUDGET_MS = 2 * FRAME_BUDGET_MS;
/** RAIL's long-task line: no single frame may take longer. */
export const FRAME_MAX_BUDGET_MS = 50;
/** At most one refresh in ten may be missed. */
export const DROPPED_RATIO_BUDGET = 0.1;
/** Input → next frame, p95: one refresh plus the handler's own work. */
export const INPUT_TO_FRAME_P95_BUDGET_MS = 50;
/** Input → the store reflecting it: RAIL's 100 ms "instant" threshold. */
export const FIRST_COMMIT_BUDGET_MS = 100;

/** Playback: frames actually painted per second while playing (the preview's
 *  `debug_frame_timing` `paint` channel). 24 fps is the slowest real footage
 *  rate; a preview below it cannot show a 24 fps edit honestly. */
export const PLAYBACK_PAINT_MIN_FPS = 24;
/** Playback: the play loop's own rAF cadence must not stall. */
export const PLAYBACK_RAF_MIN_FPS = 50;

export const DEFAULT_PERF_BUDGET: PerfBudget = {
  frameP95Ms: FRAME_P95_BUDGET_MS,
  frameMaxMs: FRAME_MAX_BUDGET_MS,
  droppedRatio: DROPPED_RATIO_BUDGET,
  inputToFrameP95Ms: INPUT_TO_FRAME_P95_BUDGET_MS,
  firstCommitMs: null,
};

/** The shape of `debug_pointer` / `debug_key`'s `perf` block. */
export interface PerfReport {
  frameBudgetMs: number;
  frames: { samples: number; p50Ms?: number; p95Ms?: number; maxMs?: number; dropped?: number };
  inputToFrame: { samples: number; p95Ms: number } | null;
  store: { commits: number; firstCommitAfterInputMs: number | null; lastCommitAfterLastInputMs: number | null };
}

export interface BudgetResult {
  ok: boolean;
  /** Each budget that was missed, readable on its own. */
  misses: string[];
}

const fmt = (n: number) => `${Math.round(n * 10) / 10} ms`;

/** Hold one `perf` block to a budget. No frames at all is itself a miss —
 *  it means the window was throttled and nothing was measured. */
export function checkBudget(perf: PerfReport, budget: PerfBudget = DEFAULT_PERF_BUDGET): BudgetResult {
  const misses: string[] = [];
  const f = perf.frames;
  if (!f.samples) {
    misses.push('no frames were sampled — the window is throttled (debug_set_occlusion_throttling(false)) or rAF is stalled');
    return { ok: false, misses };
  }
  if (f.p95Ms !== undefined && f.p95Ms > budget.frameP95Ms) misses.push(`frame p95 ${fmt(f.p95Ms)} > ${fmt(budget.frameP95Ms)}`);
  if (f.maxMs !== undefined && f.maxMs > budget.frameMaxMs) misses.push(`worst frame ${fmt(f.maxMs)} > ${fmt(budget.frameMaxMs)}`);
  const ratio = (f.dropped ?? 0) / Math.max(1, f.samples);
  if (ratio > budget.droppedRatio) {
    misses.push(`${f.dropped} dropped of ${f.samples} frames (${Math.round(ratio * 100)}% > ${Math.round(budget.droppedRatio * 100)}%)`);
  }
  if (perf.inputToFrame && perf.inputToFrame.p95Ms > budget.inputToFrameP95Ms) {
    misses.push(`input→frame p95 ${fmt(perf.inputToFrame.p95Ms)} > ${fmt(budget.inputToFrameP95Ms)}`);
  }
  if (budget.firstCommitMs !== null) {
    const first = perf.store.firstCommitAfterInputMs;
    if (first === null) misses.push('the input caused no store commit');
    else if (first > budget.firstCommitMs) misses.push(`input→store ${fmt(first)} > ${fmt(budget.firstCommitMs)}`);
  }
  return { ok: misses.length === 0, misses };
}
