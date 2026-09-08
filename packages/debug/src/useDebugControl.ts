/**
 * useDebugControl.ts — mounts the `debug_*` op registry, in dev builds only
 * (D-218).
 *
 * What it is: one hook, mounted once from `app/src/App.tsx` next to
 *   `useChromaControl()`, that listens on the same `chroma://request` /
 *   `chroma://response/<id>` event pair every other registry uses and answers
 *   the `debug_` namespace from `debugOps.ts`.
 *
 * What it does NOT do: anything at all in a production build. The whole body
 *   sits behind `if (!import.meta.env.DEV) return;`, which Vite replaces with
 *   `if (!false) return;` at build time, and the registry itself is reached
 *   through a dynamic `import()` inside that branch — so Rollup's dead-code
 *   pass drops both the branch and `debugOps.ts`'s entire chunk, along with
 *   `domTree.ts`, `uiState.ts`, and every op body in them. That is the
 *   frontend counterpart of `#[cfg(debug_assertions)]` on the Rust commands
 *   (D-218 / B-099): a real compile-time gate, not a runtime flag, and one
 *   that is *checked* — see `docs/notes/debug-tooling.md` for the bundle grep
 *   that proves it on a real `vite build`.
 *
 * Keeping the hook itself unconditional (rather than calling it conditionally
 * in `App.tsx`) is deliberate: a conditional hook call is illegal in React,
 * and a `useEffect` whose body is constant-folded away costs a single empty
 * effect in production.
 */

import { useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';

const DEBUG_OP_PREFIX = 'debug_';

/** B-032/D-112's `listen()` teardown race, copied verbatim from
 *  `useEditorControl.ts` / `useMotionControl.ts`: the unlisten function Tauri
 *  hands back is itself async, so an HMR teardown can surface as an unhandled
 *  rejection rather than a catchable throw. Chaining `.catch()` onto the SAME
 *  promise is what actually silences it. */
function safeUnlisten(unlistenPromise: Promise<(() => void) | undefined | void>): void {
  unlistenPromise
    .then((f) => {
      const result: unknown = f?.();
      return Promise.resolve(result);
    })
    .catch(() => {
      /* the listener is already gone either way (HMR teardown race) */
    });
}

export function useDebugControl(): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    let disposed = false;
    let unlisten: Promise<(() => void) | undefined | void> | null = null;

    void import('./debugOps').then(({ DEBUG_OPS }) => {
      if (disposed) return;
      unlisten = listen('chroma://request', async (ev) => {
        const payload = (ev?.payload ?? {}) as { id?: string; op?: string; args?: unknown };
        const { id, op } = payload;
        if (typeof op !== 'string' || !op.startsWith(DEBUG_OP_PREFIX)) {
          // Not ours. Every registry claims exactly its own prefix and stays
          // silent otherwise — `control.rs` hands out one `app.once` response
          // slot per request id, so two handlers answering would race for it.
          return;
        }
        // `debug_screenshot` / `debug_sample_pixel` share this prefix but are
        // answered natively in Rust (`control.rs`'s `native_op`, D-210) and
        // never reach the frontend at all, so there is nothing to skip here —
        // noted because the name overlap looks like one.
        const respond = (body: unknown) => emit(`chroma://response/${id}`, body);
        const fn = DEBUG_OPS[op];
        if (!fn) {
          void respond({ ok: false, error: `unknown debug op: ${op}`, result: null });
          return;
        }
        try {
          const result = await fn(payload.args ?? {});
          const error = (result as { error?: string } | null)?.error ?? null;
          void respond({ ok: !error, error, result });
        } catch (e) {
          void respond({ ok: false, error: String((e as Error)?.message ?? e), result: null });
        }
      });
    });

    return () => {
      disposed = true;
      if (unlisten) safeUnlisten(unlisten);
    };
  }, []);
}
