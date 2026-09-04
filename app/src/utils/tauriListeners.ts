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
 * unlisten function throws inside Tauri's own `_unlisten` (`Cannot read
 * properties of undefined (reading 'unregisterListener')`), an unhandled
 * rejection. This is a dev-mode-only race (no HMR in a production build) —
 * see B-032 in `docs/BUGS.md` for the full investigation — not a listener
 * leak or a real registration bug, so swallowing it here is correct: the
 * listener is already gone either way.
 */
export function safeUnlisten(unlistenPromise: Promise<(() => void) | undefined | void>): void {
  unlistenPromise
    .then((f) => {
      try {
        f?.();
      } catch {
        // Already torn down (HMR raced the async resolution) — nothing to clean up.
      }
    })
    .catch(() => {
      // The listen()/onResized() promise itself never resolved (same HMR race) — ignore.
    });
}
