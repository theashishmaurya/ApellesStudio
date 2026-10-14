/**
 * `@apelles/editor` — the grace window a start-then-poll op waits inside
 * (B-188/D-321).
 *
 * **What it is.** The one helper every store-backed `editor_*` op uses to wait
 * a bounded time for its own job before handing the caller a poll handle:
 * `editor_detect_*` (in `useEditorControl.ts`) and, since D-380 step 2,
 * `editor_retranscribe_words` (in `retakeProposalOps.ts`). Moved out of
 * `useEditorControl.ts` when the second caller arrived, so both wait by one
 * rule rather than two copies of it.
 *
 * **What it does NOT do.** It starts nothing and never rejects: the job is
 * already running in a store, and a failure is already recorded there and
 * comes back as `phase: 'error'`.
 */

import type { AnalysisStatus } from './mediaUnderstandingStore';

/** How long a start op will wait for its own job before handing the caller a
 *  poll handle instead (B-188/D-321).
 *
 *  Comfortably inside `chroma::control`'s 20 s `BRIDGE_TIMEOUT`, so the op
 *  always answers rather than 504-ing. The point of the window is that a
 *  normal recut — a few seconds of decode plus VAD — still completes in ONE
 *  call, exactly as it did before this became pollable; only a job that
 *  genuinely runs long falls through to `state: "running"`. */
export const DETECT_GRACE_MS = 12_000;

/** How often the grace window re-reads the store. Fine-grained on purpose:
 *  unlike the sidecar's minute-scale jobs, a detection that lands at 900 ms
 *  should return at ~900 ms, not at the next coarse tick. */
const DETECT_POLL_MS = 50;

/** Wait up to `ms` for a store-backed job to leave `running`, then report
 *  wherever it got to. Never rejects: a failure is already recorded in the
 *  store and comes back as `phase: 'error'`. */
export async function settleWithin<T>(
  read: () => AnalysisStatus<T>,
  ms: number,
): Promise<AnalysisStatus<T>> {
  const deadline = Date.now() + ms;
  let status = read();
  while (status.phase === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DETECT_POLL_MS));
    status = read();
  }
  return status;
}
