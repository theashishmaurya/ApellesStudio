/**
 * @apelles/motion — the Motion-tab half of the Apelles control server bridge.
 *
 * D-020 built an MCP-driven control server for the Colorist tab: a generic
 * `{op, args}` HTTP endpoint inside the running app (`app/src-tauri/src/
 * chroma/control.rs`) that bridges to a frontend `OPS` registry via Tauri
 * events, so an MCP edit and a manual drag share exactly one state. This
 * hook is the same architecture for Motion — see
 * `docs/notes/motion-mcp-surface-research.md` for the original scoping pass
 * (§1 confirms `control.rs` is a fully generic dispatcher with zero op-name
 * knowledge, so it needed ZERO changes to carry Motion ops too).
 *
 * **What this file is, after D-257: the SHELL only.** The ops themselves
 * moved to `motionOps.ts` as a pure `createMotionOps(ctx)` factory — read
 * that file's own module doc comment for the op surface, the addressing
 * shape, the ease guard, and the "same store action a GUI gesture calls"
 * discipline. What stays here is exactly the part that cannot be pure: the
 * `chroma://request` Tauri listener, the `motion_` prefix filter, the
 * response `emit`, the HMR-teardown `safeUnlisten`, and the React refs that
 * keep the ops' context pointing at live values.
 *
 * **Why the split (D-257).** The registry used to be an object literal
 * declared inside the `useEffect` below, closed over these refs — so no test
 * could reach a single op without rendering the hook, and this package's
 * vitest environment is `node` (no jsdom, no react-dom, no testing-library).
 * That is why the entire D-167→D-170 op surface shipped untested. With the
 * registry pure, `motionOps.test.ts` calls every op directly against a
 * hand-built context and asserts each produces the identical manifest the
 * GUI's own `manifestEdit.ts` call produces. Behaviour is unchanged: the
 * same handlers, the same messages, the same `commit` calls.
 *
 * **Mount point.** Mounted once from `MotionTab.tsx`, which — like every
 * other tab (`app/src/main.tsx`'s own B-007 comment: "every tab stays
 * mounted from boot... including underneath the launcher") — stays mounted
 * regardless of which tab has focus. So this bridge is reachable whether or
 * not Motion is the active tab, exactly the guarantee `useChromaControl`
 * already relies on for Colorist.
 *
 * **Same event pair, no Rust changes.** Listens on the SAME `chroma://
 * request` / `chroma://response/<id>` Tauri events `control.rs` already
 * emits/awaits. Every Motion op is namespaced `motion_*`. This hook answers
 * ONLY ops in that namespace (including `{error: 'unknown motion op'}` for a
 * typo'd one) and does nothing at all for anything else, so it never
 * contends with `useChromaControl`'s own listener for the one-shot response
 * slot `control.rs`'s `app.once(...)` hands out per request id —
 * `useChromaControl.ts` mirrors this by skipping (not error-responding to)
 * any `motion_*` op. Two listeners on one event name, partitioned by a
 * naming convention, not two servers or two ports.
 *
 * **Why this hook needs refs and `useChromaControl` never did.**
 * Colorist's store is zustand — a module-level object reachable via
 * `.getState()` from any JS context. `useMotionManifest`'s state is plain
 * component-local React state BY DESIGN (its own doc comment: "nothing
 * outside this tab needs it"), so there is no module-level object to reach
 * into from a Tauri event handler registered once at mount. `mRef`/`selRef`
 * are kept synced to the latest values on every render (plain assignments in
 * the component body — no effect needed for that part); the ops read them
 * through the context's accessor functions at CALL time, so they always see
 * the render that just happened, never a stale closure from whichever render
 * was current when `listen()` was first called. `playerRef`/`measureApiRef`/
 * `setSelections` need no such re-sync: a `useRef` object's identity and a
 * `useState` setter's identity are both stable for the component's whole
 * lifetime (only `.current` mutates), so they are destructured once.
 *
 * **`motion_render`'s blocking-vs-polling decision — no new machinery.**
 * D-398: the render is a backend JOB (`app/src-tauri/src/chroma/motion_job.rs`)
 * that survives a page reload; `motion_render` starts it and then awaits it
 * settling, however long that takes. **One real, pre-existing constraint this does NOT paper over:**
 * `control.rs`'s `dispatch()` — shared by EVERY op, Motion or Colorist —
 * hardcodes `BRIDGE_TIMEOUT = 20s`. A render past that makes the HTTP caller
 * see a 504 ("frontend did not respond within 20s") while the frontend's own
 * `await cur.render()` keeps running, the real render completes on disk, and
 * the eventual `respond(...)` emits into an event nobody listens for any
 * more (a harmless no-op). Fixing it would mean editing `control.rs`
 * (against this surface's foundational "zero Rust changes" design, D-167 §1)
 * or building real polling (no precedent in `manifestIO.ts` to wrap) — so it
 * is recorded as a genuine known limitation. An agent expecting a slow render
 * should treat a 504 from `motion_render` as "inconclusive, not failed" and
 * check the output on disk (or Sources — see below) rather than re-rendering.
 *
 * **What happens to a rendered file (verified, D-257; extended by D-260).**
 * Every scene's output is imported into the Edit tab's Sources pool
 * automatically, by `app/src/Root.tsx`'s `onMotionRendered` (D-062) — once per
 * scene, at the pool root. It is deliberately NOT spliced onto the Edit
 * timeline: the app cannot know the intended track or position, so placing it
 * stays one explicit action.
 *
 * **D-260 replaces this file's previous "there is NO live link" paragraph.**
 * Re-rendering a scene now refreshes the clips already placed from it: the
 * render replaces its fixed per-scene file atomically, the app drops the live
 * decode pipe on it, the pool item is re-probed and re-thumbnailed, and every
 * Edit clip reading that file re-reads its new length and rate
 * (`refresh_media`). It is not a live embed — nothing re-renders on a manifest
 * edit, and a clip keeps showing the last render until the next one — but from
 * the Edit timeline's point of view a re-render lands by itself, with no
 * re-import and no manual swap. `motion_get_edit_links` reports what a render
 * will refresh; `motion_render`'s own MCP docstring states the whole chain.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { newBridgeClaim } from '@apelles/bridge';
import { runAsAgent } from '@apelles/history';
// B-217/D-358 — the cross-store project-identity guard; see the dispatcher below.
import { assertProjectIdentity } from '@apelles/store';
import type { PlayerRef } from '@remotion/player';

import { createMotionOps, type MotionOpsApi, type MotionEditLinks } from './motionOps';
import { useMotionLayerPresetStore } from './layerPresetIO';
import { useMotionThemeLibraryStore } from './themeLibraryIO';
import { useMotionTemplateLibraryStore } from './templateLibraryIO';
import { componentAccess } from './customComponentLibraryIO';
import { importAsset, previewFrames } from './manifestIO';
import type { Selection } from './LayerList';
import type { MotionCanvasMeasureApi } from './MotionPreview';
import type { useMotionManifest } from './useMotionManifest';

type MotionManifestApi = ReturnType<typeof useMotionManifest>;

/**
 * The navigation/selection handles the ops need that `m`
 * (`useMotionManifest`) does not own: the live selection is
 * `MotionTab.tsx`'s own `useState` and the player/canvas escape hatches are
 * its own `useRef`s.
 *
 * `measureApiRef` is accepted for parity with the pattern the research doc
 * describes, so a future op needing a screen-space measurement (e.g. an
 * MCP-driven "snap to layer") doesn't need another signature change just to
 * add a ref that was always available one render up. No shipped op reads it
 * yet.
 *
 * D-257 adds `selections` — the READ half. `motion_get_state`/
 * `motion_set_selection` are the Motion analogue of `editor_get_state`/
 * `editor_set_selection` (D-216), and reading what is selected was
 * previously impossible from outside the webview. Unlike the two refs and
 * the setter, this is a plain value that changes every render, so it gets
 * the same `mRef`-style re-sync `m` does.
 */
export interface MotionControlRefs {
  playerRef: RefObject<PlayerRef | null>;
  measureApiRef: RefObject<MotionCanvasMeasureApi | null>;
  setSelections: (next: Selection[]) => void;
  selections: Selection[];
  /** D-260 — the Edit-tab footprint of each scene, supplied by the app layer
   *  (`app/src/Root.tsx`) because computing it needs the media pool and the
   *  Edit timeline, neither of which a tab package may import. Like
   *  `selections`, a plain value that changes every render, so it gets the
   *  same ref re-sync. `undefined` when nothing supplies it — see
   *  `MotionOpsContext.editLinks`. */
  editLinks?: MotionEditLinks;
}

const MOTION_OP_PREFIX = 'motion_';

/** B-071 — this registry's own cold-start handshake, announced on
 *  `chroma://bridge-ready` once `listen()` below has actually resolved.
 *
 *  `control.rs` binds its port in Tauri's `.setup()` hook, long before the
 *  webview loads and this effect runs, and a `chroma://request` emitted before
 *  this subscription exists is lost outright (Tauri does not buffer events) —
 *  the request then burned its whole budget and came back a misleading timeout.
 *  The control server now waits for this announcement before forwarding a
 *  `motion_*` op. `defers: []`: this registry claims its prefix and nothing
 *  else, so it has nothing to hand back to another. */

/**
 * `safeUnlisten` duplicated (not imported) from `app/src/utils/
 * tauriListeners.ts`: that file lives under `app/src`, and a tab package
 * importing from `app` would invert D-039's layer direction (app → tabs,
 * never back), the same reasoning already documented at every other
 * app/tab boundary in this codebase. The logic itself (B-032/B-034/D-112):
 * `listen()`'s cleanup is `unlistenPromise.then((f) => f())`, and Tauri's own
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

/** B-280 — this evaluation of the module: new after a dev hot update to this
 *  file or anything it imports, so the bridge subscription below (which
 *  depends on it) re-subscribes with the new op code. See `@apelles/bridge`'s
 *  `controlBridge` for why `[]` alone is not enough. */
const REGISTRY_EVALUATION = Symbol('useMotionControl evaluation');

/**
 * Mount once from `MotionTab.tsx`, passing the SAME `useMotionManifest()`
 * result the tab itself renders against — this hook never calls that hook
 * itself (it isn't a second source of manifest state, just a second *entry
 * point* into the one `useMotionManifest` instance the tab already owns).
 */
export function useMotionControl(m: MotionManifestApi, refs: MotionControlRefs): void {
  const mRef = useRef<MotionManifestApi>(m);
  mRef.current = m;
  const selRef = useRef<Selection[]>(refs.selections);
  selRef.current = refs.selections;
  // D-260 — same re-sync as `selections` above, for the same reason: a plain
  // value that changes every render, read at CALL time by the ops.
  const linksRef = useRef<MotionEditLinks | undefined>(refs.editLinks);
  linksRef.current = refs.editLinks;
  // No wrapper needed for these three — see `MotionControlRefs`'s own doc
  // comment for why a `useRef` object's identity and a `useState` setter's
  // identity are already stable across renders.
  const { playerRef, measureApiRef, setSelections } = refs;

  const evaluation = REGISTRY_EVALUATION;
  useEffect(() => {
    void evaluation;
    // `measureApiRef` is plumbed through for future ops (see the interface's
    // doc comment); referenced here so the dependency is explicit rather
    // than looking accidentally unused.
    void measureApiRef;

    const OPS = createMotionOps({
      // Read fresh on every call — never captured, since `useMotionManifest`
      // returns a new object every render. `MotionManifestApi` structurally
      // satisfies the narrower `MotionOpsApi` the ops actually use.
      api: (): MotionOpsApi => mRef.current,
      selections: () => selRef.current,
      setSelections,
      player: () => playerRef.current,
      editLinks: () => linksRef.current ?? {},
      // D-332 — the saved-component library. Read through `getState()` rather
      // than a subscribed hook value for the same reason every other accessor
      // here is a function: this registry is built once at mount and called
      // much later, so a captured list would go stale the moment the user (or
      // another op) saved a component. `commit` writes through to disk and
      // updates the store, so the Catalog panel re-renders on its own.
      presets: () => ({
        list: () => useMotionLayerPresetStore.getState().presets,
        commit: (next) => useMotionLayerPresetStore.getState().commit(next),
        now: () => new Date().toISOString(),
      }),
      // D-399 — the saved-theme library, read the same way (`getState()` at
      // call time, never a captured list).
      themes: () => ({
        list: () => useMotionThemeLibraryStore.getState().themes,
        commit: (next) => useMotionThemeLibraryStore.getState().commit(next),
      }),
      // D-403 — still frames through the backend's Remotion `still` path.
      preview: (req) => previewFrames(req),
      // D-404 — the content-hash asset import.
      importAsset: (path) => importAsset(path),
      // D-407 — the template library, read the same way.
      templates: () => ({
        list: () => useMotionTemplateLibraryStore.getState().templates,
        loadErrors: () => useMotionTemplateLibraryStore.getState().loadErrors,
        save: (t) => useMotionTemplateLibraryStore.getState().save(t),
        remove: (id) => useMotionTemplateLibraryStore.getState().remove(id),
      }),
      // D-409 — the custom-component library and its backend commands.
      components: () => componentAccess(),
    });

    // B-272 — this subscription's identity; see `useEditorControl.ts`.
    const bridge = newBridgeClaim(MOTION_OP_PREFIX);
    const unlistenP = listen('chroma://request', async (ev: { payload?: unknown }) => {
      const payload = (ev?.payload || {}) as { id?: string; op?: string; args?: Record<string, unknown> };
      const { id, op, args } = payload;
      if (!bridge.isForMe(payload)) return;
      if (typeof op !== 'string' || !op.startsWith(MOTION_OP_PREFIX)) {
        // Not ours — leave it for useChromaControl.ts's Colorist registry
        // (or whatever else may claim this event in the future). Responding
        // here would race a real handler elsewhere for the one-shot
        // response slot; see this file's own module doc comment.
        return;
      }

      const respond = (body: unknown) => emit(`chroma://response/${id}`, body);
      const fn = OPS[op];
      if (!fn) {
        void respond({ ok: false, error: `unknown motion op: ${op}` });
        return;
      }

      try {
        // B-217/D-358 — refuse to run while the app's stores disagree about
        // which project is open. The Motion half of B-217's own symptom was
        // `motion_get_state` answering `loadState: "no-project"` while a real
        // project was demonstrably open; this makes that a loud error instead of
        // a confident wrong answer, and stops a `motion_save_manifest` from
        // writing into the wrong project's sidecar.
        await assertProjectIdentity(op);

        // D-298 — every `@apelles/history` push inside this window is stamped
        // `source: 'agent'`, which is the whole of this tab's agent-activity
        // instrumentation: one wrapper at the dispatcher, not a line in each
        // of the ~90 handlers. The shell-level feed reads those entries, so
        // work an agent does here is finally visible from any tab.
        const result = await runAsAgent(() => fn(args || {}));
        void respond({ ok: !result?.error, error: result?.error ?? null, result });
      } catch (e) {
        void respond({ ok: false, error: e instanceof Error ? e.message : String(e), result: null });
      }
    });

    // B-071 — announce only once the subscription has genuinely landed (the
    // promise resolving is that fact), and only if this effect is still live.
    let subscribed = true;
    void unlistenP.then(() => {
      if (subscribed) void emit('chroma://bridge-ready', bridge.claim);
    });

    return () => {
      subscribed = false;
      safeUnlisten(unlistenP);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation]);
}
