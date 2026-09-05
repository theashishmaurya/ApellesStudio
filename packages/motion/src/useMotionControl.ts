/**
 * @chroma/motion — the Motion-tab half of the Chroma control server bridge.
 *
 * D-020 built an MCP-driven control server for the Colorist tab: a generic
 * `{op, args}` HTTP endpoint inside the running app (`app/src-tauri/src/
 * chroma/control.rs`) that bridges to a frontend `OPS` registry
 * (`app/src/hooks/useChromaControl.ts`) via Tauri events, so an MCP edit and
 * a manual slider drag share exactly one state. This hook is the same
 * architecture, reused for Motion — see
 * `docs/notes/motion-mcp-surface-research.md` for the full scoping pass
 * (§1 confirms `control.rs` is a fully generic dispatcher with zero op-name
 * knowledge, so it needed ZERO changes to carry Motion ops too).
 *
 * **Mount point.** Mounted once from `MotionTab.tsx`, which — like every
 * other tab (`app/src/main.tsx`'s own B-007 comment: "every tab stays
 * mounted from boot... including underneath the launcher") — stays mounted
 * regardless of which tab has focus. So this bridge is reachable whether or
 * not Motion is the active tab, exactly the guarantee `useChromaControl`
 * already relies on for Colorist (mounted in `App.tsx`, one of those same
 * always-mounted tab bodies) — confirmed by reading `main.tsx`, not assumed
 * (research doc §4).
 *
 * **Same event pair, no Rust changes.** Listens on the SAME `chroma://
 * request` / `chroma://response/<id>` Tauri events `control.rs` already
 * emits/awaits — the HTTP server, its port, and its request/response
 * plumbing are unchanged. Every Motion op is namespaced `motion_*`. This
 * hook answers ONLY ops in that namespace (including `{error: 'unknown
 * motion op'}` for a typo'd one) and does nothing at all for anything else,
 * so it never contends with `useChromaControl`'s own listener for the
 * one-shot response slot `control.rs`'s `app.once(...)` hands out per
 * request id — `useChromaControl.ts` mirrors this by skipping (not
 * error-responding to) any `motion_*` op. Two listeners on one event name,
 * partitioned by a naming convention, not two servers or two ports — see
 * the research doc §6 for why a synchronous "unknown op" fast-path on
 * either side would otherwise race an async handler on the other and win
 * the response slot with a false negative.
 *
 * **Why this hook needs a ref and `useChromaControl` never did.**
 * `useEditorStore` (Colorist) is a zustand store — a plain, mutable,
 * module-level object reachable via `.getState()`/`.setState()` from any JS
 * context, independent of React's render cycle. `useMotionManifest`'s
 * `manifest`/`text`/`commit`/`save`/`render` are plain component-local React
 * state BY DESIGN (its own doc comment: "nothing outside this tab needs
 * it" — true until now), so there is no module-level object to reach into
 * from a Tauri event handler registered once at mount. `mRef` is kept
 * synced to the latest `useMotionManifest()` return value on every render
 * (a plain assignment in the component body — no effect needed for that
 * part); the event handler reads `mRef.current` at call time, so it always
 * sees the manifest/commit from the render that just happened, never a
 * stale closure from whichever render was current when `listen()` was
 * first called.
 */
import { useEffect, useRef } from 'react';
import { listen, emit } from '@tauri-apps/api/event';

import { addLayer } from './manifestEdit';
import { catalogEntries, type PrimitiveUse } from './catalog';
import type { useMotionManifest } from './useMotionManifest';

type MotionManifestApi = ReturnType<typeof useMotionManifest>;

const MOTION_OP_PREFIX = 'motion_';

const VALID_USES = new Set<string>(catalogEntries.map((e) => e.use));

/**
 * `safeUnlisten` duplicated (not imported) from `app/src/utils/
 * tauriListeners.ts`: that file lives under `app/src`, and a tab package
 * importing from `app` would invert D-039's layer direction (app → tabs,
 * never back), the same reasoning already documented at every other
 * app/tab boundary in this codebase (e.g. `MotionTab.tsx`'s own
 * `onRendered` callback, `main.tsx`'s D-062 comment). The logic itself
 * (B-032/B-034/D-112, in the original file's own words): `listen()`'s
 * cleanup is `unlistenPromise.then((f) => f())`, and Tauri's own
 * `_unlisten` is itself `async` — a dev-mode-only HMR race can make that
 * inner call reject as an *unhandled promise rejection* rather than a
 * catchable synchronous throw, so the rejection must be chained onto
 * (`.then(...).catch(() => {})`), not merely wrapped in `try`/`catch`.
 */
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

/**
 * Mount once from `MotionTab.tsx`, passing the SAME `useMotionManifest()`
 * result the tab itself renders against — this hook never calls that hook
 * itself (it isn't a second source of manifest state, just a second
 * *entry point* into the one `useMotionManifest` instance the tab already
 * owns).
 */
export function useMotionControl(m: MotionManifestApi): void {
  const mRef = useRef(m);
  mRef.current = m;

  useEffect(() => {
    // ---- ops --------------------------------------------------------
    // Every entry wraps a REAL existing function — no new manifest-mutation
    // logic here, same discipline `mcp/README.md` states for D-020 ("no
    // grade/mask logic in this server or in control.rs"). See the research
    // doc §5 for the full planned tool list; only these two ship this pass.
    const OPS: Record<string, (args: any) => any> = {
      // Read-only: the live in-editor manifest (parsed, not necessarily
      // saved — the same value `<MotionPreview>` renders from right now).
      motion_get_manifest: () => {
        const cur = mRef.current;
        return {
          manifest: cur.manifest,
          loadState: cur.loadState,
          parseError: cur.parseError,
          dirty: cur.dirty,
          saveError: cur.saveError,
        };
      },

      // Insert a schema-valid default instance of a primitive into a scene
      // — the Catalog panel's own action (`MotionTab.tsx`'s `onCatalogAdd`),
      // just reached from here instead of a click. Commits through
      // `useMotionManifest().commit`, the real undo-wired write path (D-155)
      // — an agent's insert shows up on the SAME `@chroma/history` undo
      // stack an Inspector edit does, exactly like a D-020 grade op shows
      // up in the Colorist "Agent activity" feed.
      motion_add_layer: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const sceneIndexRaw = a?.scene_index ?? a?.sceneIndex;
        const sceneIndex = Math.round(Number(sceneIndexRaw));
        if (!Number.isFinite(sceneIndex)) {
          return { error: 'scene_index (integer) required' };
        }
        if (!cur.manifest.scenes[sceneIndex]) {
          return {
            error: `no scene at index ${sceneIndex} (0..${cur.manifest.scenes.length - 1})`,
          };
        }

        const use = String(a?.use ?? '');
        if (!VALID_USES.has(use)) {
          return { error: `use must be one of: ${[...VALID_USES].join(', ')}` };
        }

        const { manifest: next, selection } = addLayer(cur.manifest, sceneIndex, use as PrimitiveUse);
        if (!selection) {
          // addLayer only returns a null selection when the scene index it
          // was given doesn't resolve — already checked above, so this is a
          // defensive floor, not a path expected to run.
          return { error: `could not add a "${use}" layer to scene ${sceneIndex}` };
        }

        cur.commit(next, `Add ${use} layer`);
        return { sceneIndex, selection, addedUse: use };
      },
    };

    const unlistenP = listen('chroma://request', async (ev: any) => {
      const payload = ev?.payload || {};
      const { id, op, args } = payload;
      if (typeof op !== 'string' || !op.startsWith(MOTION_OP_PREFIX)) {
        // Not ours — leave it for useChromaControl.ts's Colorist registry
        // (or whatever else may claim this event in the future). Responding
        // here would race a real handler elsewhere for the one-shot
        // response slot; see this file's own module doc comment.
        return;
      }

      const respond = (body: any) => emit(`chroma://response/${id}`, body);
      const fn = OPS[op];
      if (!fn) {
        respond({ ok: false, error: `unknown motion op: ${op}` });
        return;
      }

      try {
        const result = await fn(args || {});
        respond({ ok: !result?.error, error: result?.error ?? null, result });
      } catch (e: any) {
        respond({ ok: false, error: String(e?.message || e), result: null });
      }
    });

    return () => {
      safeUnlisten(unlistenP);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
