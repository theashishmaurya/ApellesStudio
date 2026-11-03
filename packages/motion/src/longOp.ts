/**
 * @apelles/motion — a slow backend operation as start + short polls (B-321).
 *
 * What it is: `runLongOp(start)` takes the promise of a `chroma_motion_*_start`
 * command (which returns an operation id at once) and polls
 * `chroma_motion_longop_poll` until the operation is done, resolving with its
 * result or rejecting with its error. The custom-component proof (1-3 min) and
 * the preview still (a first engine bundle) use it.
 *
 * Why: both used to be one `invoke` pending for the whole render. Live, the
 * render finished on disk and that `invoke` never settled in the webview, so the
 * bridge reply waiting on it timed out and the caller lost a result that
 * existed (B-321). Many instant calls never depend on one long-lived promise.
 *
 * What it does NOT do: cancel, report progress, or retry a failed operation. A
 * poll that itself fails (the id is unknown after an app restart) rejects.
 */
import { invoke } from '@tauri-apps/api/core';

/** How often the backend is asked whether the operation is done. */
export const LONG_OP_POLL_MS = 400;

/** `apelles_motion::longop::LongOpPoll` on the wire. */
type LongOpPoll<T> = { state: 'running' } | { state: 'done'; result: T } | { state: 'failed'; error: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLongOp<T>(start: Promise<string>, pollMs: number = LONG_OP_POLL_MS): Promise<T> {
  const id = await start;
  for (;;) {
    const poll = await invoke<LongOpPoll<T>>('chroma_motion_longop_poll', { id });
    if (poll.state === 'done') return poll.result;
    if (poll.state === 'failed') throw new Error(poll.error);
    await sleep(pollMs);
  }
}
