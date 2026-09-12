/**
 * `@apelles/bridge` — teardown for a Tauri `listen()` registration.
 *
 * **What it is:** the package-side home of `safeUnlisten`, the one correct way
 * to release a `listen()` subscription in a React cleanup. It is here rather
 * than in `app/src/utils/tauriListeners.ts` (where B-032/B-034/D-112 worked it
 * out) because `packages/*` sits *below* `app/` in the D-039 layer order and
 * cannot import from it — which is why the function had already been
 * hand-copied into `packages/motion/src/useMotionControl.ts` and
 * `packages/editor/src/useProjectSettings.ts`. Anything in a package that
 * needs it imports it from here instead of making a fourth copy.
 *
 * **What it does NOT do:** register listeners, or know anything about a
 * particular event. It takes the promise `listen()` returns and disposes of it
 * without ever surfacing the dev-mode HMR teardown race as an unhandled
 * rejection.
 *
 * **Why it is not just `try`/`catch`** (B-034/D-112, the full investigation is
 * in `app/src/utils/tauriListeners.ts`'s own header): Tauri's `listen()`
 * resolves to an **`async`** unlisten function, so a failure inside it — which
 * happens when Vite HMR swaps `window.__TAURI_INTERNALS__` out from under a
 * registration mid-flight — produces a *rejected promise*, not a synchronous
 * throw. A `try`/`catch` around the call cannot see that; chaining the result
 * into a `.catch` here is what actually closes the hole.
 */
export function safeUnlisten(unlistenPromise: Promise<(() => void) | undefined | void>): void {
  unlistenPromise
    .then((f) => {
      // Typed `void` by Tauri, really a `Promise<void>` at runtime — hence
      // `unknown` and an explicit resolve rather than trusting the type.
      const result: unknown = f?.();
      return Promise.resolve(result);
    })
    .catch(() => {
      // Either the `listen()` promise never resolved, or the unlisten call
      // rejected against a torn-down bridge. The listener is gone either way.
    });
}
