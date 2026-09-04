/**
 * `safeUnlisten` — a Tauri `listen()`/`onResized()`-style unlisten promise,
 * torn down without throwing.
 *
 * `listen()` returns `Promise<UnlistenFn>`; the standard React cleanup is
 * `unlistenPromise.then((f) => f())`. That `.then` callback can fire after
 * Vite HMR has already reloaded the module graph mid-flight (Tauri's own
 * console warning names this directly: "the app is reloaded while Rust is
 * running an asynchronous operation") — at that point `window.__TAURI_INTERNALS__`
 * may no longer match what registered the listener, and calling the resolved
 * unlisten function fails inside Tauri's own `_unlisten` (`Cannot read
 * properties of undefined (reading 'unregisterListener')`). This is a
 * dev-mode-only race (no HMR in a production build) — see B-032 in
 * `docs/BUGS.md` for the full investigation — not a listener leak or a real
 * registration bug, so swallowing it here is correct: the listener is already
 * gone either way.
 *
 * **B-034/D-112 — why this is not just a `try`/`catch`.** B-032's original fix
 * wrapped the call in `try { f?.(); } catch {}` and was reported fixed. It
 * isn't sufficient, and the owner's own live dev log proved it: the identical
 * `TypeError: undefined is not an object (evaluating 'listeners[eventId].handlerId')`
 * kept arriving as an **unhandled rejection** whose stack pointed straight at
 * that `f?.()` line, on a freshly-restarted instance built with the B-032 fix
 * already in it. The reason is in Tauri's own source: `listen()` resolves to
 * `async () => _unlisten(event, eventId)`, and `_unlisten` is itself `async`.
 * An `async` function never throws synchronously — its very first statement
 * blowing up produces a *rejected promise* instead, which a surrounding
 * `try`/`catch` around the call cannot see. The returned promise was then
 * dropped on the floor, unhandled. Chaining the result into this function's
 * own `.catch` (whatever it is — the declared `UnlistenFn` type says `void`,
 * the runtime hands back a promise) is what actually closes the hole.
 */
export function safeUnlisten(unlistenPromise: Promise<(() => void) | undefined | void>): void {
  unlistenPromise
    .then((f) => {
      // `f?.()` is typed `void` by Tauri but really returns `Promise<void>` at
      // runtime — hence `unknown` here rather than trusting the declared type,
      // and hence resolving it instead of only guarding a synchronous throw.
      const result: unknown = f?.();
      return Promise.resolve(result);
    })
    .catch(() => {
      // Either the listen()/onResized() promise never resolved, or the unlisten
      // call itself threw or rejected against a torn-down bridge (same HMR
      // race). The listener is gone regardless — nothing to clean up.
    });
}
