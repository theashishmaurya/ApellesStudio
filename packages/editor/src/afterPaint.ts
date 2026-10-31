/**
 * @apelles/editor — run a callback once the NEXT frame has been painted
 * (D-437 S7, `docs/notes/timeline-lanes.md` §2.9 item 3).
 *
 * What it is: a rAF callback runs at the start of a rendering update, so a task
 * posted from it (a `MessageChannel` message, which unlike `setTimeout` is not
 * clamped or throttled) runs once that update has finished its style, layout and
 * paint work. This is the one place that shape lives: `editPerf.ts`'s
 * `commit-painted` measure and the edit gesture's `will-change` teardown both use
 * it, so "the commit has painted" means the same thing to the mark and to the
 * layer removal.
 *
 * What it does NOT do: any perf marking (that is `editPerf.ts`), or cancel — the
 * callbacks it is used for are idempotent style resets.
 */

/** Run `callback` after the next frame has rendered. Without rAF / MessageChannel
 *  (a bare test runtime) it runs on a macrotask, which is the same ordering. */
export function afterPaint(callback: () => void): void {
  if (typeof requestAnimationFrame !== 'function' || typeof MessageChannel === 'undefined') {
    setTimeout(callback, 0);
    return;
  }
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      callback();
    };
    channel.port2.postMessage(null);
  });
}
