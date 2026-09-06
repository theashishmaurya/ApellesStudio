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
 *
 * **Phase 2** (this pass, research doc §5's "Phase 2" table) adds the rest
 * of the non-keyframe edit surface: `motion_set_layer_field`,
 * `motion_set_layer_position`/`motion_set_layer_size`,
 * `motion_move_layers_by_delta`, `motion_align_layers`/
 * `motion_distribute_layers`, `motion_set_scene_field`, and
 * `motion_set_camera_2d`/`motion_set_camera_3d`. Every one of these targets
 * an EXISTING layer/scene/camera (Phase 1's `motion_add_layer` didn't need
 * to, since it creates the thing being addressed) — the addressing wire
 * shape is `{scene_index, target: {kind, index?, id?}}`, mirroring
 * `LayerList.tsx`'s own `Selection` exactly (research doc §3's resolved
 * decision — never "whatever the GUI currently has selected," since
 * `manifestEdit.ts` has no such ambient state to read). `target.id`, when
 * given, is preferred over `target.index` (`resolveOrError` below, wrapping
 * `manifestEdit.ts`'s own D-158 `resolveSelection`) — an MCP client that
 * reads a layer's `id` off `motion_get_manifest` gets the exact same
 * reorder/insert/delete safety the GUI's own live selection gets, with
 * `index` alone as the fallback for a hand-written manifest with no ids.
 *
 * `motion_set_camera_2d`/`motion_set_camera_3d` replace a scene's camera
 * keyframe array WHOLESALE, not because that was assumed to be "good
 * enough," but because it's the ONLY write function `manifestEdit.ts`
 * exposes for a camera key's VALUE fields (`x`/`y`/`zoom`/`pos`/`look`/
 * `ease`) — `moveCamera2dKeyAt`/`moveCamera3dKeyAt` exist too, but only
 * retime a key's `at`, and are Phase 3 (keyframing) scope, not this pass's.
 * A real, current limitation, documented rather than worked around with new
 * logic this pass wasn't scoped to add.
 *
 * **Phase 3** (research doc §5's "Phase 3" table) adds the LAYER-keyframing
 * surface: `motion_set_layer_transform_keys` (replace a layer's
 * `transform.keys` array wholesale — `setLayerTransformKeys`),
 * `motion_add_layer_keyframe` (upsert one key at a given time from the
 * layer's current on-screen position — `upsertLayerTransformKeyXY`, the
 * same auto-keyframe write path a canvas drag uses), and
 * `motion_move_layer_keyframe` (retime one existing key —
 * `moveLayerTransformKeyAt`). Same `{scene_index, target}` addressing and
 * `resolveOrError` id-preference as Phase 2 — reused, not re-decided.
 *
 * **`add_layer_keyframe`'s args, and why.** The Phase 3 table's own wording
 * ("from the layer's current on-screen position") names `layerDragBase` as
 * the read half this op needs on top of `upsertLayerTransformKeyXY` itself:
 * that function's real signature (`manifestEdit.ts`) takes `x`/`y`
 * EXPLICITLY — it does not derive them — so something has to supply them.
 * Reading `layerDragBase`'s own contract settled it: it needs a `frame`
 * (`Math.round(at * fps)`, `fps` off `manifest.fps`) and returns the
 * layer's CURRENTLY INTERPOLATED position at that instant (whether or not
 * the layer is already keyed), which is exactly "lock the layer where it
 * visually already is at this time" — the honest MCP analogue of a canvas
 * drag that starts and ends at the same spot (a pure "add a hold point"
 * gesture). So this op's args are `{scene_index, target, at, x?, y?}`:
 * `at` is required; `x`/`y` are OPTIONAL overrides — when both are given,
 * they're used verbatim (an agent that already knows exactly where it wants
 * the key doesn't need a derive-then-resend round trip); when either is
 * omitted, it's filled in from `layerDragBase`'s own current-position read.
 * A selection with no draggable position AND a missing `x`/`y` is a real
 * error (nothing to derive from), not a silent `{x:0,y:0}`.
 *
 * **A small, deliberate addition beyond `upsertLayerTransformKeyXY`'s own
 * signature: an optional `ease` on `add_layer_keyframe`.** The wrapped
 * function has no `ease` parameter at all (it only ever touches `x`/`y`),
 * so a literal wrap can't author an eased keyframe in one call — the only
 * way would be `add_layer_keyframe` then a full `set_layer_transform_keys`
 * resend just to attach one key's easing. Rejected as needless ceremony for
 * something this small: after the upsert, if `ease` was given, this op
 * finds the SAME key (by the identical `Math.round(at*fps)` frame match
 * `upsertLayerTransformKeyXY` itself uses) in the resulting array and sets
 * its `ease`, folded into the SAME manifest before the one `commit()` call
 * (one undo step, same "compose pure writes, commit once" discipline
 * `moveLayersByDeltaAutoKey` already uses for its own two-field write).
 * This is genuinely new (if small) logic, the same class of addition
 * D-168's own `resolveOrError` was — not a new manifest-mutation PRIMITIVE
 * (no new schema field, no new interpolation rule), just the missing glue
 * an MCP call needs that a two-call round trip would otherwise force.
 *
 * **Ease validation — B-062's exact gap, not repeated here.** `schema.ts`'s
 * `ease` is a bare 4-tuple with NO runtime validation; `Easing.bezier`
 * (`interpolateKeys.ts`) throws unless `x1`,`x2` ∈ `[0,1]` (B-062, still
 * open — `docs/BUGS.md`). Rather than accept a raw tuple blind here, any
 * `ease` this file receives (`add_layer_keyframe`, and each key inside
 * `set_layer_transform_keys`'s `keys` array) is checked with
 * `easeCurve.ts`'s own real exports — `resolveEaseCurve` (shape: a genuine
 * 4-length array of finite numbers, `null` otherwise — a real error, not a
 * silent default) then `clampEaseCurve` (the SAME clamp the Inspector's own
 * bezier-curve widget applies before ever letting a drag reach the
 * manifest) — with a `warning` (never a blocking error) when clamping
 * actually changed a value. `schema.ts` itself is untouched — this is a
 * guard at the MCP boundary, not a fix to the still-open bug.
 *
 * **Bonus op considered, deliberately NOT built: multi-key nudge
 * (`moveKeysByDelta`, D-163).** A real capability, but its own
 * `KeyMoveTarget.baseAtSeconds` is captured ONCE at a live drag's start and
 * carried through the gesture (`moveKeysByDelta`'s own doc comment) — an
 * MCP call has no drag session to capture that base from, and the shape it
 * WOULD need on the wire (a list mixing camera/scene3d-camera/layer key
 * targets, each with its own remembered base) is real new wire-protocol
 * design the Phase 3 table never asked for. The single-key case
 * (`move_layer_keyframe`) already covers the common "retime one key" need;
 * an agent wanting several keys moved the same amount can call it N times
 * (no atomicity loss that matters here — each call is already its own
 * commit/undo step, same as every other op in this file). Left out as a
 * scope boundary, not silently dropped.
 *
 * **Phase 4** (research doc §5's "Phase 4" table — navigation, selection,
 * persistence) is the LAST phase on the scoped tool list: `motion_select`
 * (mirrors `MotionTab.tsx`'s own `onSelect` — sets the live selection AND
 * seeks the player to the target scene's start frame, `sceneStartFrame`;
 * read-only w.r.t. the manifest, no `commit()`), `motion_seek` (moves the
 * player to an absolute frame or a `{scene_index, at}` seconds-within-scene
 * pair), `motion_save_manifest` (wraps `useMotionManifest().save`), and
 * `motion_render` (wraps `useMotionManifest().render` — the one op in the
 * WHOLE Motion MCP surface that triggers a real `remotion render`
 * subprocess to disk). This needed a real signature extension this file
 * doesn't own: see `useMotionManifest.ts`'s own module doc comment
 * ("save/render's return values, extended for D-170") for why `save`/
 * `render` now resolve to a real `SaveOutcome`/`RenderOutcome` instead of a
 * bare `boolean`/`void` — an MCP call has no component re-render to read
 * `saveError`/`renderError` state off of afterward the way the GUI does.
 *
 * **`motion_select`/`motion_seek` need refs `m` doesn't own — the new
 * `MotionControlRefs` parameter, above.** `MotionTab.tsx`'s live selection
 * (`selections`) is its OWN `useState`, not part of `useMotionManifest`'s
 * return value, and the player is a `useRef<PlayerRef>` that component owns
 * too. See `MotionControlRefs`'s own doc comment for why these don't need
 * an `mRef`-style per-render re-sync the way `m` does.
 *
 * **`motion_render`'s blocking-vs-polling decision — no new machinery
 * added.** `chroma_motion_render` (`app/src-tauri/src/chroma/motion.rs`) is
 * already an `async fn` that `spawn_blocking`s the real render and
 * `.await`s it — the Rust side was already "single-await, non-blocking of
 * the Tokio runtime" before this pass touched anything, so `motion_render`
 * here just does the same: `await cur.render()`, however long that takes,
 * no timeout, no progress polling invented. **One real, discovered
 * constraint this doesn't (and per this task's own instructions, shouldn't)
 * paper over:** `control.rs`'s own `dispatch()` — shared by EVERY op, Motion
 * or Colorist, unrelated to this pass — hardcodes `BRIDGE_TIMEOUT = 20s` on
 * the `mpsc::channel` it blocks the HTTP thread on. A render that takes
 * longer than 20s will make the ORIGINAL `curl`/HTTP caller see a 504
 * ("frontend did not respond within 20s") — `control.rs` gives up on ITS
 * side and `app.unlisten`s the one-shot handler — but the frontend's own
 * `await cur.render()` keeps running regardless (nothing here observes or
 * reacts to the HTTP client giving up), the real render keeps going to
 * completion on disk, and this hook's own `respond(...)` call, once the
 * render finally finishes, just emits into a Tauri event nobody is listening
 * for any more (a harmless no-op, not an error). Fixing this would mean
 * either editing `control.rs` (against this whole surface's foundational
 * "zero Rust changes" design, D-167 §1) or building a real polling
 * mechanism (explicitly out of this pass's scope, no existing precedent in
 * `manifestIO.ts` to wrap) — so it's recorded here as a genuine, known
 * limitation for a render slow enough to cross 20s, not silently accepted
 * nor incorrectly "fixed" with new machinery. An agent that expects a slow
 * render can work around this today WITHOUT any new server-side code: the
 * render's destination is deterministic when no custom output path is given
 * (`<project>.chroma/motion/render.mp4`, `motion.rs`'s own
 * `default_output_path`), so it can treat a 504 from `motion_render` as
 * "inconclusive, not failed" and poll for that file's existence/mtime on
 * disk itself — exactly how this pass's own live verification confirmed a
 * render actually completed (see the D-170 decision entry).
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import type { PlayerRef } from '@remotion/player';

import {
  addLayer,
  alignSelections,
  distributeSelections,
  layerDragBase,
  layerTransformKeys,
  layerWorldPosition,
  moveLayersByDelta,
  moveLayerTransformKeyAt,
  resolveSelection,
  resolveSelections,
  selectedLayer,
  selectedScene,
  setCamera2d,
  setCamera3d,
  setLayerField,
  setLayerPosition,
  setLayerSize,
  setLayerTransformKeys,
  setSceneField,
  upsertLayerTransformKeyXY,
  type AlignEdge,
} from './manifestEdit';
import { catalogEntries, type PrimitiveUse } from './catalog';
import { fieldsForPrimitive, SCENE_FIELDS } from './propCatalog';
import { clampEaseCurve, resolveEaseCurve, type EaseCurve } from './easeCurve';
import type { Selection } from './LayerList';
import type { MotionCanvasMeasureApi } from './MotionPreview';
import { sceneStartFrame, totalFrames } from '@chroma/motion-engine/src/engine/build';
import type { Cam2dKey, Cam3dKey, TransformKey } from '@chroma/motion-engine/src/engine/schema';
import type { useMotionManifest } from './useMotionManifest';

type MotionManifestApi = ReturnType<typeof useMotionManifest>;

/**
 * D-170 (Phase 4) — the navigation/selection refs `motion_select`/
 * `motion_seek` need, none of which `m` (`useMotionManifest`) owns: the
 * live selection is `MotionTab.tsx`'s own `useState`, and the player/canvas
 * escape hatches are `MotionTab.tsx`'s own `useRef`s (research doc §5's own
 * caveat: "seek needs `playerRef`... the same live-ref bridge extended to
 * cover `playerRef` and `measureApiRef` too, not just `m`").
 *
 * **Why these DON'T need an `mRef`-style per-render re-sync.** `mRef` exists
 * because `m` is a plain object literal `useMotionManifest` RETURNS fresh
 * every render — the object reference itself goes stale the instant
 * anything in it changes, so `mRef.current = m` (a plain assignment in the
 * render body) has to re-run every render to keep pointing at the latest
 * one. `playerRef`/`measureApiRef` are different in kind: they're
 * `useRef(...)` objects `MotionTab.tsx` creates ONCE and never recreates —
 * the ref OBJECT's identity is stable for the component's whole lifetime;
 * only its `.current` field mutates (written by `<Player ref={playerRef}>`/
 * `MotionPreview`'s own imperative-handle wiring, read here at call time).
 * `setSelections` is equally stable: a `useState` dispatch function's
 * identity never changes across renders, by React's own contract. So this
 * hook can just destructure `refs` ONCE, in the render body (below, same
 * place `mRef` is declared), with no ref-of-a-ref wrapper and no re-sync
 * effect — reading `refs.playerRef.current`/calling `refs.setSelections(...)`
 * from inside the mount-once `useEffect` below always reaches the live
 * values, even though the `useEffect` itself only runs once. Confirmed by
 * reading `MotionTab.tsx` before assuming this, not guessed (task's own
 * instruction) — `playerRef`/`measureApiRef` are declared via `useRef` and
 * `selections` via `useState`, exactly as this reasoning requires.
 *
 * `measureApiRef` is accepted here for the SAME reason the research doc
 * names it alongside `playerRef` ("the same live-ref bridge extended to
 * cover playerRef AND measureApiRef too") even though no Phase 4 op reads it
 * yet — `motion_select`/`motion_seek` only need `playerRef`. Plumbed through
 * for parity with the pattern the research doc describes and so a future op
 * needing a screen-space measurement (e.g. an MCP-driven "snap to layer",
 * `MotionTab.tsx`'s own `onSnapToLayer`) doesn't need a THIRD signature
 * change to `useMotionControl` just to add a ref that was always available
 * one render up. Not a load-bearing part of this phase's shipped ops.
 */
export interface MotionControlRefs {
  playerRef: RefObject<PlayerRef | null>;
  measureApiRef: RefObject<MotionCanvasMeasureApi | null>;
  setSelections: (next: Selection[]) => void;
}

const MOTION_OP_PREFIX = 'motion_';

const VALID_USES = new Set<string>(catalogEntries.map((e) => e.use));

const ALIGN_EDGES = new Set<string>(['left', 'centerH', 'right', 'top', 'centerV', 'bottom']);
const DISTRIBUTE_AXES = new Set<string>(['horizontal', 'vertical']);

/**
 * Phase 2 (`docs/notes/motion-mcp-surface-research.md` §5) addressing helper.
 * The research doc's §3 already resolved the wire shape: mirror `Selection`
 * exactly — `{scene_index, target: {kind, index?, id?}}` — never "whatever
 * is currently selected in the GUI." This is that shape's parser, shared by
 * every Phase 2 op that targets one thing.
 *
 * Deliberately does NOT call `resolveSelection` itself — that needs a live
 * `manifest` to search against, which isn't available until an op's own
 * `no-project`/`no-manifest` guards have already run. Callers resolve
 * separately (see `resolveOrError` below), exactly mirroring the two-step
 * "parse the wire shape, then resolve it against the live manifest" split
 * `MotionTab.tsx` itself uses (`resolveSelections` on every commit).
 */
function parseSelectionArg(a: any): Selection | { error: string } {
  const sceneIndexRaw = a?.scene_index ?? a?.sceneIndex;
  const sceneIndex = Math.round(Number(sceneIndexRaw));
  if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };

  const target = a?.target;
  if (!target || typeof target !== 'object') {
    return {
      error: 'target ({kind, index?, id?}) required — kind is one of: scene, camera, scene3d-camera, layer, scene3d-child',
    };
  }
  const kind = target.kind;
  if (kind === 'scene' || kind === 'camera' || kind === 'scene3d-camera') {
    return { sceneIndex, target: { kind } };
  }
  if (kind === 'layer' || kind === 'scene3d-child') {
    const hasId = typeof target.id === 'string' && target.id.length > 0;
    const hasIndex = target.index !== undefined && target.index !== null;
    if (!hasId && !hasIndex) {
      return { error: 'target.index or target.id required for a layer/scene3d-child target' };
    }
    // `id`, when present, is what actually resolves the target (below) —
    // `index` just needs to be SOME finite integer to satisfy `Selection`'s
    // own shape when only an `id` was given (D-158's own `resolveSelection`
    // ignores `index` entirely whenever `id` is set).
    const index = hasIndex ? Math.round(Number(target.index)) : 0;
    if (hasIndex && !Number.isFinite(index)) {
      return { error: 'target.index must be an integer' };
    }
    return { sceneIndex, target: { kind, index, ...(hasId ? { id: String(target.id) } : {}) } };
  }
  return { error: `target.kind must be one of: scene, camera, scene3d-camera, layer, scene3d-child (got "${kind}")` };
}

/** `selections` (plural) wire shape for the multi-select ops — an array of
 *  the same `{scene_index, target}` shape `parseSelectionArg` reads. */
function parseSelectionsArg(a: any): Selection[] | { error: string } {
  const list = a?.selections;
  if (!Array.isArray(list) || list.length === 0) {
    return { error: 'selections (non-empty array of {scene_index, target}) required' };
  }
  const out: Selection[] = [];
  for (let i = 0; i < list.length; i++) {
    const parsed = parseSelectionArg(list[i]);
    if ('error' in parsed) return { error: `selections[${i}]: ${parsed.error}` };
    out.push(parsed);
  }
  return out;
}

/**
 * Resolves a just-parsed `Selection` against the live manifest, preferring
 * `target.id` over `target.index` — `manifestEdit.ts`'s own `resolveSelection`
 * (D-158) already implements exactly this preference; this wrapper's only
 * job is turning its `null` ("doesn't resolve to anything") into the same
 * `{error}` shape every op in this file returns. Every Phase 2 op that reads
 * `target.id`/`target.index` off the wire MUST route through this (not call
 * `manifestEdit.ts`'s own `setLayerField`/`setLayerPosition`/etc. with the
 * raw parsed selection directly) — those functions key off `target.index`
 * alone and know nothing about `id`-preference; skipping this step would
 * silently make `id`-addressed calls behave like `index`-addressed ones,
 * defeating the whole D-158 reorder-safety point of accepting an `id` at
 * all.
 */
function resolveOrError(manifest: any, selection: Selection): Selection | { error: string } {
  const resolved = resolveSelection(manifest, selection);
  if (!resolved) {
    return {
      error: `selection (scene ${selection.sceneIndex}, ${JSON.stringify(selection.target)}) does not resolve to anything in the current manifest`,
    };
  }
  return resolved;
}

/**
 * Phase 3's ease-validation guard — B-062's exact gap (`docs/BUGS.md`,
 * still open: `schema.ts`'s `ease` is a bare 4-tuple with no runtime check,
 * and `Easing.bezier` throws unless `x1`,`x2` ∈ `[0,1]`), closed at THIS
 * boundary rather than in the still-open schema bug. Reuses
 * `easeCurve.ts`'s own real exports — the same validation the Inspector's
 * bezier-curve widget applies to a drag before it ever reaches the
 * manifest — not a reimplementation. `undefined`/`null` (no `ease` given)
 * is a no-op success with no curve and no warning; a present-but-malformed
 * value (wrong length, non-numeric, `NaN`/`Infinity`) is a real `{error}`,
 * never silently dropped; a well-shaped but out-of-range value is clamped
 * and reported back as a `warning`, never a blocker.
 */
function validateEaseArg(raw: unknown): { curve?: EaseCurve; warning?: string } | { error: string } {
  if (raw === undefined || raw === null) return {};
  const resolved = resolveEaseCurve(raw);
  if (!resolved) {
    return { error: 'ease must be a 4-number array [x1, y1, x2, y2] (Easing.bezier control points)' };
  }
  const clamped = clampEaseCurve(resolved);
  const changed = clamped.some((v, i) => v !== resolved[i]);
  return {
    curve: clamped,
    warning: changed ? `ease ${JSON.stringify(resolved)} was out of range — clamped to ${JSON.stringify(clamped)}` : undefined,
  };
}

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
export function useMotionControl(m: MotionManifestApi, refs: MotionControlRefs): void {
  const mRef = useRef(m);
  mRef.current = m;
  // No `refsRef`-style wrapper needed — see `MotionControlRefs`'s own doc
  // comment above for why `playerRef`/`measureApiRef`/`setSelections` are
  // already stable across renders and can just be destructured here, read
  // fresh (`.current`) at call time from inside the mount-once effect below.
  const { playerRef, measureApiRef, setSelections } = refs;

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

      // ---- Phase 2: the rest of the edit surface (research doc §5) ------
      // Every op below is a thin adapter over a REAL `manifestEdit.ts`
      // function — same discipline as `motion_add_layer` above and D-020's
      // own stated rule ("no grade/mask logic in this server or in
      // control.rs"). Every mutating op shares one correctness signal for
      // free: every `manifestEdit.ts` `set*`/`align*`/`distribute*`/`move*`
      // function returns the SAME `Manifest` reference, unchanged, when its
      // selection/args don't resolve to anything editable (each function's
      // own "no-op" doc comment) — so `next === cur.manifest` after calling
      // one is a reliable "nothing happened" signal, checked below instead
      // of re-deriving each function's own resolution logic a second time.

      // set (or delete, `value: null`) one top-level field on a layer or
      // scene3d-child — `setLayerField`.
      motion_set_layer_field: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsed = parseSelectionArg(a);
        if ('error' in parsed) return parsed;
        const resolved = resolveOrError(cur.manifest, parsed);
        if ('error' in resolved) return resolved;
        if (resolved.target.kind !== 'layer' && resolved.target.kind !== 'scene3d-child') {
          return { error: `set_layer_field targets a layer or scene3d-child, got target.kind="${resolved.target.kind}"` };
        }

        const key = a?.key;
        if (typeof key !== 'string' || !key) return { error: 'key (string) required' };
        if (!a || !('value' in a)) return { error: 'value is required (use JSON null to delete the field)' };
        const value = a.value === null ? undefined : a.value;

        // Soft validation against the same field list the Inspector renders
        // (`propCatalog.ts`'s `fieldsForPrimitive`) — never blocks the
        // write (a hand-authored manifest can carry fields the Inspector
        // doesn't know about yet, e.g. a future primitive), just flags it.
        let warning: string | undefined;
        const found = selectedLayer(cur.manifest, resolved);
        if (found) {
          const fields = fieldsForPrimitive(found.use);
          if (fields && !fields.some((f) => f.key === key)) {
            warning = `"${key}" is not a known field for use="${found.use}" (see /motion-primitives) — set anyway`;
          }
        }

        const next = setLayerField(cur.manifest, resolved, key, value);
        if (next === cur.manifest) {
          return { error: 'no change — selection did not resolve to an editable layer' };
        }
        cur.commit(next, `Set ${key}`);
        return { selection: resolved, key, value: value ?? null, warning };
      },

      // move a layer/scene3d-child to a new WORLD-px position — `setLayerPosition`.
      motion_set_layer_position: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsed = parseSelectionArg(a);
        if ('error' in parsed) return parsed;
        const resolved = resolveOrError(cur.manifest, parsed);
        if ('error' in resolved) return resolved;

        const x = Number(a?.x);
        const y = Number(a?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x and y (numbers) required' };

        const next = setLayerPosition(cur.manifest, resolved, x, y);
        if (next === cur.manifest) {
          const use = selectedLayer(cur.manifest, resolved)?.use ?? 'unknown';
          return { error: `selection has no draggable x/y position (use="${use}")` };
        }
        cur.commit(next, 'Set layer position');
        return { selection: resolved, x, y };
      },

      // resize a layer/scene3d-child in WORLD px — `setLayerSize`.
      motion_set_layer_size: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsed = parseSelectionArg(a);
        if ('error' in parsed) return parsed;
        const resolved = resolveOrError(cur.manifest, parsed);
        if ('error' in resolved) return resolved;

        const w = Number(a?.w);
        const h = Number(a?.h);
        if (!Number.isFinite(w) || !Number.isFinite(h)) return { error: 'w and h (numbers) required' };

        const next = setLayerSize(cur.manifest, resolved, w, h);
        if (next === cur.manifest) {
          const use = selectedLayer(cur.manifest, resolved)?.use ?? 'unknown';
          return { error: `selection has no resizable field (use="${use}")` };
        }
        cur.commit(next, 'Set layer size');
        return { selection: resolved, w, h };
      },

      // nudge a multi-selection by a shared (dx, dy) — `moveLayersByDelta`.
      // Each entry's own "base" position is read fresh off the CURRENT
      // manifest (`layerWorldPosition`), never off a stale drag-start
      // snapshot — an MCP call has no live gesture to capture a base at
      // drag-start the way `MotionCanvasOverlay.tsx`'s pointer-down does, so
      // "current position" is the only honest base for a one-shot op.
      motion_move_layers_by_delta: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsedList = parseSelectionsArg(a);
        if ('error' in parsedList) return parsedList;
        const dx = Number(a?.dx);
        const dy = Number(a?.dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { error: 'dx and dy (numbers) required' };

        const resolved = resolveSelections(cur.manifest, parsedList);
        const droppedCount = parsedList.length - resolved.length;

        const moves: { selection: Selection; base: { x: number; y: number } }[] = [];
        for (const selection of resolved) {
          const base = layerWorldPosition(cur.manifest, selection);
          if (base) moves.push({ selection, base });
        }
        if (moves.length === 0) {
          return { error: 'no draggable layers in selection (none resolved to a world position)' };
        }

        const next = moveLayersByDelta(cur.manifest, moves, dx, dy);
        if (next === cur.manifest) return { error: 'no change' };
        cur.commit(next, 'Move layers');
        return { movedCount: moves.length, droppedCount, dx, dy };
      },

      // align a 2+ multi-selection to a shared edge/center line — `alignSelections`.
      motion_align_layers: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsedList = parseSelectionsArg(a);
        if ('error' in parsedList) return parsedList;
        const edge = a?.edge;
        if (typeof edge !== 'string' || !ALIGN_EDGES.has(edge)) {
          return { error: `edge must be one of: ${[...ALIGN_EDGES].join(', ')}` };
        }

        const resolved = resolveSelections(cur.manifest, parsedList);
        const droppedCount = parsedList.length - resolved.length;
        if (resolved.length < 2) {
          return { error: 'align requires at least 2 resolvable selections with a draggable position' };
        }

        const next = alignSelections(cur.manifest, resolved, edge as AlignEdge);
        if (next === cur.manifest) {
          return { error: 'no change (fewer than 2 selections had a draggable position)' };
        }
        cur.commit(next, `Align ${edge}`);
        return { alignedCount: resolved.length, droppedCount, edge };
      },

      // space a 3+ multi-selection with equal gaps along one axis — `distributeSelections`.
      motion_distribute_layers: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsedList = parseSelectionsArg(a);
        if ('error' in parsedList) return parsedList;
        const axis = a?.axis;
        if (typeof axis !== 'string' || !DISTRIBUTE_AXES.has(axis)) {
          return { error: `axis must be one of: ${[...DISTRIBUTE_AXES].join(', ')}` };
        }

        const resolved = resolveSelections(cur.manifest, parsedList);
        const droppedCount = parsedList.length - resolved.length;
        if (resolved.length < 3) {
          return { error: 'distribute requires at least 3 resolvable selections with a draggable position' };
        }

        const next = distributeSelections(cur.manifest, resolved, axis as 'horizontal' | 'vertical');
        if (next === cur.manifest) {
          return { error: 'no change (fewer than 3 selections had a draggable position)' };
        }
        cur.commit(next, `Distribute ${axis}`);
        return { distributedCount: resolved.length, droppedCount, axis };
      },

      // set (or delete, `value: null`) one field on the scene itself — `setSceneField`.
      motion_set_scene_field: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const sceneIndex = Math.round(Number(a?.scene_index ?? a?.sceneIndex));
        if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
        if (!cur.manifest.scenes[sceneIndex]) {
          return { error: `no scene at index ${sceneIndex} (0..${cur.manifest.scenes.length - 1})` };
        }

        const key = a?.key;
        if (typeof key !== 'string' || !key) return { error: 'key (string) required' };
        if (!a || !('value' in a)) return { error: 'value is required (use JSON null to delete the field)' };
        const value = a.value === null ? undefined : a.value;

        const warning = SCENE_FIELDS.some((f) => f.key === key)
          ? undefined
          : `"${key}" is not one of the known scene fields (${SCENE_FIELDS.map((f) => f.key).join(', ')}) — set anyway`;

        const next = setSceneField(cur.manifest, sceneIndex, key, value);
        if (next === cur.manifest) return { error: 'no change' };
        cur.commit(next, `Set scene ${key}`);
        return { sceneIndex, key, value: value ?? null, warning };
      },

      // replace a scene's 2D camera keyframe array WHOLESALE — `setCamera2d`.
      // There is no granular "patch one camera key" write function in
      // `manifestEdit.ts` today (only `moveCamera2dKeyAt`, which retimes a
      // key's `at` and is Phase 3/keyframing scope, not this op) — an agent
      // that wants to tweak one key's `zoom` has to read the array via
      // `motion_get_manifest`, edit it client-side, and resend the whole
      // thing. Documented as a real, current limitation (research doc §5's
      // own framing), not worked around here with new logic.
      motion_set_camera_2d: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const sceneIndex = Math.round(Number(a?.scene_index ?? a?.sceneIndex));
        if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
        if (!cur.manifest.scenes[sceneIndex]) {
          return { error: `no scene at index ${sceneIndex} (0..${cur.manifest.scenes.length - 1})` };
        }

        const rawKeys = a?.keys;
        if (!Array.isArray(rawKeys)) {
          return { error: 'keys (array of {at, x?, y?, zoom?, ease?}) required' };
        }

        const keys: Cam2dKey[] = [];
        const warnings: string[] = [];
        for (let i = 0; i < rawKeys.length; i++) {
          const k = rawKeys[i];
          if (!k || typeof k !== 'object' || typeof k.at !== 'number' || !Number.isFinite(k.at)) {
            return { error: `keys[${i}] needs a numeric "at"` };
          }
          // Same `validateEaseArg` guard `motion_set_layer_transform_keys`
          // already applies (D-169/B-062) — closing the exact gap D-168's
          // own pass left open by wrapping `setCamera2d`/`setCamera3d`
          // BEFORE that guard existed. Malformed ease is a hard error;
          // out-of-range is clamped with a warning, never a blocker.
          const ease = validateEaseArg(k.ease);
          if ('error' in ease) return { error: `keys[${i}].${ease.error}` };
          if (ease.warning) warnings.push(`keys[${i}]: ${ease.warning}`);
          const key: Cam2dKey = { at: k.at };
          for (const field of ['x', 'y', 'zoom'] as const) {
            if (typeof k[field] === 'number' && Number.isFinite(k[field])) key[field] = k[field];
          }
          // `easeCurve.ts`'s `EaseCurve` is deliberately `readonly` (D-164);
          // the schema-inferred `Cam2dKey['ease']` is the mutable tuple zod
          // infers — spread into a fresh mutable tuple to satisfy both.
          if (ease.curve) key.ease = [...ease.curve] as [number, number, number, number];
          keys.push(key);
        }

        const next = setCamera2d(cur.manifest, sceneIndex, keys);
        if (next === cur.manifest) return { error: `no scene at index ${sceneIndex}` };
        cur.commit(next, 'Set camera');
        return { sceneIndex, keyCount: keys.length, warning: warnings.length ? warnings.join('; ') : undefined };
      },

      // replace a scene's 3D camera keyframe array WHOLESALE — `setCamera3d`.
      // Same "no granular patch, only wholesale replace" limitation as
      // `motion_set_camera_2d` above. Additionally, `scene3d.camera` is
      // `.min(1)` in the zod schema (`schema.ts`) and `setCamera3d` itself
      // is a no-op when the scene has no `scene3d` block at all yet — there
      // is no `motion_*` op that creates one directly; the only way today is
      // `motion_add_layer` with an `in3d` `use`, which creates `scene3d`
      // (with a default camera) as a side effect (`manifestEdit.ts`'s own
      // `addLayer`).
      motion_set_camera_3d: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const sceneIndex = Math.round(Number(a?.scene_index ?? a?.sceneIndex));
        if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
        const scene = cur.manifest.scenes[sceneIndex];
        if (!scene) {
          return { error: `no scene at index ${sceneIndex} (0..${cur.manifest.scenes.length - 1})` };
        }
        if (!scene.scene3d) {
          return {
            error: `scene ${sceneIndex} has no scene3d block yet — add a 3D layer first (motion_add_layer with an in3d use) to create one`,
          };
        }

        const rawKeys = a?.keys;
        if (!Array.isArray(rawKeys) || rawKeys.length < 1) {
          return { error: 'keys (non-empty array of {at, pos:[x,y,z], look?, ease?}) required — scene3d.camera needs at least one key' };
        }

        const keys: Cam3dKey[] = [];
        const warnings: string[] = [];
        for (let i = 0; i < rawKeys.length; i++) {
          const k = rawKeys[i];
          if (!k || typeof k !== 'object' || typeof k.at !== 'number' || !Number.isFinite(k.at) || !Array.isArray(k.pos) || k.pos.length !== 3) {
            return { error: `keys[${i}] needs a numeric "at" and a 3-number "pos" [x,y,z]` };
          }
          // Same guard as `motion_set_camera_2d` above — see that op's own
          // comment for why.
          const ease = validateEaseArg(k.ease);
          if ('error' in ease) return { error: `keys[${i}].${ease.error}` };
          if (ease.warning) warnings.push(`keys[${i}]: ${ease.warning}`);
          const key: Cam3dKey = { at: k.at, pos: k.pos as [number, number, number] };
          if (Array.isArray(k.look) && k.look.length === 3) key.look = k.look as [number, number, number];
          // See `motion_set_camera_2d`'s own comment on this same spread.
          if (ease.curve) key.ease = [...ease.curve] as [number, number, number, number];
          keys.push(key);
        }

        const next = setCamera3d(cur.manifest, sceneIndex, keys);
        if (next === cur.manifest) return { error: 'no change' };
        cur.commit(next, 'Set 3D camera');
        return { sceneIndex, keyCount: keys.length, warning: warnings.length ? warnings.join('; ') : undefined };
      },

      // ---- Phase 3: layer keyframing (research doc §5's "Phase 3" table) --

      // replace a layer/scene3d-child's `transform.keys` array WHOLESALE —
      // `setLayerTransformKeys`. Every key needs a numeric `at`; a present
      // `ease` on any key is validated/clamped via `validateEaseArg`
      // (B-062's guard) rather than trusted verbatim.
      motion_set_layer_transform_keys: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsed = parseSelectionArg(a);
        if ('error' in parsed) return parsed;
        const resolved = resolveOrError(cur.manifest, parsed);
        if ('error' in resolved) return resolved;
        if (resolved.target.kind !== 'layer' && resolved.target.kind !== 'scene3d-child') {
          return {
            error: `set_layer_transform_keys targets a layer or scene3d-child, got target.kind="${resolved.target.kind}"`,
          };
        }

        const rawKeys = a?.keys;
        if (!Array.isArray(rawKeys)) {
          return { error: 'keys (array of {at, x?, y?, scale?, rot?, opacity?, ease?}) required' };
        }

        const keys: TransformKey[] = [];
        const warnings: string[] = [];
        for (let i = 0; i < rawKeys.length; i++) {
          const k = rawKeys[i];
          if (!k || typeof k !== 'object' || typeof k.at !== 'number' || !Number.isFinite(k.at)) {
            return { error: `keys[${i}] needs a numeric "at"` };
          }
          const ease = validateEaseArg(k.ease);
          if ('error' in ease) return { error: `keys[${i}].${ease.error}` };
          if (ease.warning) warnings.push(`keys[${i}]: ${ease.warning}`);
          const key: TransformKey = { at: k.at };
          for (const field of ['x', 'y', 'scale', 'rot', 'opacity'] as const) {
            if (typeof k[field] === 'number' && Number.isFinite(k[field])) key[field] = k[field];
          }
          if (ease.curve) key.ease = ease.curve as unknown as TransformKey['ease'];
          keys.push(key);
        }

        const next = setLayerTransformKeys(cur.manifest, resolved, keys);
        if (next === cur.manifest && keys.length > 0) {
          return { error: 'no change — selection did not resolve to an editable layer' };
        }
        cur.commit(next, 'Set transform keys');
        return { selection: resolved, keyCount: keys.length, warnings: warnings.length ? warnings : undefined };
      },

      // upsert ONE `transform.keys` row at a given time, from the layer's
      // current on-screen position (`layerDragBase` + `upsertLayerTransformKeyXY`
      // — the same auto-keyframe write path a canvas drag uses). `x`/`y` are
      // optional overrides — see this file's own module doc comment for the
      // full reasoning on the args shape and the small `ease` addition.
      motion_add_layer_keyframe: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsed = parseSelectionArg(a);
        if ('error' in parsed) return parsed;
        const resolved = resolveOrError(cur.manifest, parsed);
        if ('error' in resolved) return resolved;
        if (resolved.target.kind !== 'layer' && resolved.target.kind !== 'scene3d-child') {
          return {
            error: `add_layer_keyframe targets a layer or scene3d-child, got target.kind="${resolved.target.kind}"`,
          };
        }

        const at = Number(a?.at);
        if (!Number.isFinite(at)) return { error: 'at (seconds, number) required' };

        const easeResult = validateEaseArg(a?.ease);
        if ('error' in easeResult) return easeResult;

        const fps = typeof cur.manifest.fps === 'number' && cur.manifest.fps > 0 ? cur.manifest.fps : 30;
        const hasX = typeof a?.x === 'number' && Number.isFinite(a.x);
        const hasY = typeof a?.y === 'number' && Number.isFinite(a.y);

        let x: number;
        let y: number;
        let derivedFrom: 'explicit' | 'current-position';
        if (hasX && hasY) {
          x = a.x;
          y = a.y;
          derivedFrom = 'explicit';
        } else {
          const frame = Math.round(at * fps);
          const dragBase = layerDragBase(cur.manifest, resolved, frame, fps);
          if (!dragBase) {
            return { error: 'selection has no draggable position to derive x/y from — pass explicit x and y' };
          }
          x = hasX ? a.x : dragBase.base.x;
          y = hasY ? a.y : dragBase.base.y;
          derivedFrom = 'current-position';
        }

        let next = upsertLayerTransformKeyXY(cur.manifest, resolved, at, fps, x, y);
        if (next === cur.manifest) {
          return { error: 'no change — selection did not resolve to an editable layer' };
        }

        if (easeResult.curve) {
          const frame = Math.round(at * fps);
          const keys = layerTransformKeys(next, resolved);
          const idx = keys.findIndex((k) => Math.round((typeof k.at === 'number' ? k.at : 0) * fps) === frame);
          if (idx !== -1) {
            const withEase = keys.map((k, i) => (i === idx ? { ...k, ease: easeResult.curve as unknown as TransformKey['ease'] } : k));
            next = setLayerTransformKeys(next, resolved, withEase);
          }
        }

        cur.commit(next, 'Add keyframe');
        return {
          selection: resolved,
          at,
          x,
          y,
          derivedFrom,
          ease: easeResult.curve ?? null,
          warning: easeResult.warning,
        };
      },

      // retime one existing `transform.keys` entry — `moveLayerTransformKeyAt`
      // (D-158's shared `moveKeyAt` core: reorders past a neighbor, clamps to
      // the scene's own `[0, dur]`, never blocks).
      motion_move_layer_keyframe: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsed = parseSelectionArg(a);
        if ('error' in parsed) return parsed;
        const resolved = resolveOrError(cur.manifest, parsed);
        if ('error' in resolved) return resolved;
        if (resolved.target.kind !== 'layer' && resolved.target.kind !== 'scene3d-child') {
          return {
            error: `move_layer_keyframe targets a layer or scene3d-child, got target.kind="${resolved.target.kind}"`,
          };
        }

        const keyIndexRaw = a?.key_index ?? a?.keyIndex;
        const keyIndex = Math.round(Number(keyIndexRaw));
        if (!Number.isFinite(keyIndex)) return { error: 'key_index (integer) required' };

        const newAtRaw = a?.new_at ?? a?.newAt;
        const newAt = Number(newAtRaw);
        if (!Number.isFinite(newAt)) return { error: 'new_at (seconds, number) required' };

        const existingKeys = layerTransformKeys(cur.manifest, resolved);
        if (keyIndex < 0 || keyIndex >= existingKeys.length) {
          return { error: `no key at index ${keyIndex} (layer has ${existingKeys.length} key(s))` };
        }

        const scene = selectedScene(cur.manifest, resolved.sceneIndex);
        const clampedAt = scene ? Math.min(scene.dur, Math.max(0, newAt)) : newAt;

        const next = moveLayerTransformKeyAt(cur.manifest, resolved, keyIndex, newAt);
        if (next === cur.manifest) {
          return { error: 'no change — selection did not resolve to a scene' };
        }
        cur.commit(next, 'Move keyframe');
        return {
          selection: resolved,
          keyIndex,
          at: clampedAt,
          warning: clampedAt !== newAt ? `${newAt}s was outside the scene's [0, ${scene?.dur}] range — clamped to ${clampedAt}s` : undefined,
        };
      },

      // ---- Phase 4: navigation, selection, persistence (research doc §5's
      // "Phase 4" table — the LAST phase on the scoped tool list) ----------

      // Set the tab's live selection AND seek the player to the target
      // scene's start frame — the exact two-part behaviour of `MotionTab
      // .tsx`'s own `onSelect` (`setSelections([s]); playerRef.current
      // ?.seekTo(sceneStartFrame(m.manifest, s.sceneIndex));`), reached here
      // via the `MotionControlRefs` bridge instead of a click. Read-only
      // w.r.t. the MANIFEST (no `commit()`) — it only moves live UI state
      // (`selections`) and the player's position, exactly like the GUI
      // action it mirrors.
      motion_select: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };

        const parsed = parseSelectionArg(a);
        if ('error' in parsed) return parsed;
        const resolved = resolveOrError(cur.manifest, parsed);
        if ('error' in resolved) return resolved;

        setSelections([resolved]);
        playerRef.current?.seekTo(sceneStartFrame(cur.manifest, resolved.sceneIndex));
        return { selection: resolved };
      },

      // Move the player to an absolute frame, or to `{scene_index, at}`
      // (seconds within that scene, converted via the SAME `sceneStartFrame`
      // term `MotionTab.tsx`'s own `onSelect`/`KeyframeTimeline.tsx` use) —
      // whichever the caller finds easier: an agent that already read a
      // layer's keyframe `at` off `motion_get_manifest` wants the
      // scene-relative form; one that wants to scrub the whole timeline
      // (matching `KeyframeTimeline`'s own ruler-click behaviour) wants an
      // absolute frame. `frame` wins if both are given. Out-of-range values
      // are clamped to `[0, totalFrames-1]` with a `warning`, never a hard
      // error — the same "clamp, don't block" floor `move_layer_keyframe`
      // already established for a seek-shaped op in this file.
      motion_seek: (a) => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet' };
        if (!playerRef.current) return { error: 'player is not mounted yet' };

        const fps = typeof cur.manifest.fps === 'number' && cur.manifest.fps > 0 ? cur.manifest.fps : 30;
        let frame: number;
        if (a?.frame !== undefined && a?.frame !== null) {
          frame = Math.round(Number(a.frame));
          if (!Number.isFinite(frame)) return { error: 'frame must be a finite number' };
        } else {
          const sceneIndexRaw = a?.scene_index ?? a?.sceneIndex;
          if (sceneIndexRaw === undefined || sceneIndexRaw === null) {
            return { error: 'seek needs either {frame} (absolute) or {scene_index, at} (seconds within a scene)' };
          }
          const sceneIndex = Math.round(Number(sceneIndexRaw));
          if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
          if (!cur.manifest.scenes[sceneIndex]) {
            return { error: `no scene at index ${sceneIndex} (0..${cur.manifest.scenes.length - 1})` };
          }
          const at = Number(a?.at ?? 0);
          if (!Number.isFinite(at)) return { error: 'at (seconds, number) required alongside scene_index' };
          frame = sceneStartFrame(cur.manifest, sceneIndex) + Math.round(at * fps);
        }

        const lastFrame = Math.max(0, totalFrames(cur.manifest) - 1);
        const clamped = Math.min(Math.max(0, frame), lastFrame);
        playerRef.current.seekTo(clamped);
        return {
          frame: clamped,
          warning: clamped !== frame ? `frame ${frame} was outside [0, ${lastFrame}] — clamped to ${clamped}` : undefined,
        };
      },

      // Force-write the manifest sidecar now — the autosave-equivalent
      // action `ManifestEditor.tsx`'s own Save button calls
      // (`useMotionManifest().save`). Real async, real error: `save` now
      // resolves to a `SaveOutcome` (`useMotionManifest.ts`'s own D-170
      // extension) instead of a bare boolean specifically so this op can
      // surface the real failure message on the SAME promise it already
      // awaits, no risky re-read of `saveError` state afterward.
      motion_save_manifest: async () => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet — nothing to save' };

        const outcome = await cur.save();
        if (!outcome.ok) return { error: outcome.error ?? 'save failed' };
        return { saved: true, path: outcome.path };
      },

      // The real Remotion render — `useMotionManifest().render`, which
      // saves first if dirty, then calls `manifestIO.ts`'s `renderManifest`
      // → the `chroma_motion_render` Tauri command (a real `remotion
      // render` subprocess). This op just `await`s it, however long that
      // takes — no new polling machinery; see this file's own module doc
      // comment ("motion_render's blocking-vs-polling decision") for the
      // full reasoning, including the real (pre-existing, Motion-agnostic)
      // `control.rs` 20s bridge-timeout caveat that decision doesn't paper
      // over. Real success/failure and the real output path are surfaced
      // via `render`'s own D-170 `RenderOutcome` return value — never
      // swallowed into a state field this caller has no safe way to re-read.
      motion_render: async () => {
        const cur = mRef.current;
        if (cur.loadState === 'no-project') {
          return { error: 'no project open — open one in the Colorist tab' };
        }
        if (!cur.manifest) return { error: 'no manifest loaded yet — nothing to render' };

        const outcome = await cur.render();
        if (!outcome.ok || !outcome.result) return { error: outcome.error ?? 'render failed' };
        return { outputPath: outcome.result.outputPath, stdoutTail: outcome.result.stdoutTail };
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
