/**
 * stats.ts — the small numeric summaries the UI harness reports (D-434).
 *
 * What it is: percentile / mean / dropped-frame arithmetic over a list of
 *   millisecond samples, shared by the in-app input tool (`debug_pointer` /
 *   `debug_key`'s `perf` block) and the Node-side scenario runner
 *   (`packages/ui-harness`), so a p95 means the same thing on both sides.
 *
 * What it does NOT do: measure anything. It is pure arithmetic on numbers it
 *   is handed; `perf.ts` collects them.
 */

/** One display refresh at 60 Hz — the frame budget a "snappy" UI must hold
 *  (CLAUDE.md: performance first). Named once; budgets elsewhere derive from it. */
export const FRAME_BUDGET_MS = 1000 / 60;

export interface Summary {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

/** Nearest-rank percentile of an ASCENDING list (`p` in 0..100). The nearest
 *  rank is used rather than interpolation so every reported value is one that
 *  really happened — a "p95 of 17.3 ms" is a frame someone saw. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Summary of a list of millisecond samples, or `null` for an empty list (no
 *  samples is a different fact from "zero milliseconds", and must read so). */
export function summarize(values: readonly number[]): Summary | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    samples: sorted.length,
    minMs: round2(sorted[0]),
    p50Ms: round2(percentile(sorted, 50)),
    p95Ms: round2(percentile(sorted, 95)),
    maxMs: round2(sorted[sorted.length - 1]),
    meanMs: round2(sum / sorted.length),
  };
}

/** How many refreshes were missed across a list of frame-to-frame intervals:
 *  an interval of `k` budgets long means `k - 1` frames that never painted.
 *  Rounded, so ordinary vsync jitter (a 17.9 ms interval) is not a drop. */
export function droppedFrames(intervalsMs: readonly number[], budgetMs: number = FRAME_BUDGET_MS): number {
  let dropped = 0;
  for (const interval of intervalsMs) {
    if (!Number.isFinite(interval) || interval <= 0) continue;
    dropped += Math.max(0, Math.round(interval / budgetMs) - 1);
  }
  return dropped;
}

/** Successive differences of an ascending list of timestamps. */
export function intervals(timestamps: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) out.push(timestamps[i] - timestamps[i - 1]);
  return out;
}
