/**
 * @chroma/motion — the Motion tab's MCP op registry, as a PURE function.
 *
 * **What it is.** Every `motion_*` op an agent can call, in one place, built
 * by a plain factory (`createMotionOps`) that takes a context object and
 * returns a `Record<opName, handler>`. No React, no Tauri, no DOM — so it
 * runs (and is tested) under `vitest`'s `node` environment, the same split
 * `manifestEdit.ts` / `catalog.ts` / `propCatalog.ts` already use in this
 * package.
 *
 * **What it does NOT do.** It does not listen for anything and it does not
 * talk to the control server — `useMotionControl.ts` is the thin shell that
 * owns the `chroma://request` Tauri listener, the `motion_` prefix filter,
 * and the response `emit`. It also contains **no manifest-mutation logic of
 * its own**: every mutating op is a thin adapter over a REAL
 * `manifestEdit.ts` function — the same function the equivalent GUI gesture
 * calls — committed through the same `useMotionManifest().commit` an
 * Inspector edit uses, so an agent's edit lands on the SAME `@chroma/history`
 * undo stack a human's does (D-140, restated in
 * `docs/notes/mcp-architecture.md`).
 *
 * **Why this file exists at all (D-255).** Before this pass the whole op
 * registry was an object literal declared INSIDE `useMotionControl`'s
 * `useEffect`, closed over React refs — unreachable from a test without
 * rendering the hook, which this package cannot do (its vitest environment
 * is `node`; there is no jsdom, no react-dom, no testing-library here, and
 * adding all three to test a dispatch table would be a heavy new dependency
 * set for a thin listener). That is why the whole D-167→D-170 Motion op
 * surface shipped with **zero** tests. Splitting the registry out as a pure
 * factory makes every op directly callable — `createMotionOps(ctx).motion_
 * add_layer({...})` — against a hand-built context, which is what
 * `motionOps.test.ts` does for all 32 of them, asserting each produces the
 * IDENTICAL manifest the GUI's own `manifestEdit.ts` call produces. Same
 * thin-shell/fat-core direction D-039 already sets for the Rust side.
 *
 * **The context (`MotionOpsContext`).** Everything an op needs that lives
 * outside this file, as accessor FUNCTIONS rather than values — the ops are
 * built once (at listener-registration time) but called much later, so a
 * captured value would go stale. `api()` returns the live
 * `useMotionManifest` result; `selections()`/`setSelections` are
 * `MotionTab.tsx`'s own `useState` pair; `player()` is the mounted
 * `@remotion/player` handle or `null`. The player is typed structurally
 * (`MotionPlayer`, just `seekTo`/`getCurrentFrame`) so this module imports
 * nothing from `@remotion/player` — a real `PlayerRef` satisfies it.
 *
 * **Addressing.** `{scene_index, target: {kind, index?, id?}}`, mirroring
 * `LayerList.tsx`'s own `Selection` exactly (D-168 §3) — never "whatever the
 * GUI currently has selected." `target.id`, when given, is preferred over
 * `target.index` (`resolveOrError` → `manifestEdit.ts`'s D-158
 * `resolveSelection`), so an agent that reads a layer's `id` off
 * `motion_get_manifest` gets the same reorder/insert safety the GUI's own
 * live selection gets. `snake_case` and `camelCase` are both accepted on
 * every arg, since MCP callers write the former and the frontend the latter.
 *
 * **Ease validation (B-062).** `schema.ts`'s `ease` is a bare 4-tuple with
 * NO runtime validation and `Easing.bezier` throws unless `x1`,`x2` ∈
 * `[0,1]`. Every `ease` arriving here goes through `validateEaseArg` —
 * `resolveEaseCurve` (shape) then `clampEaseCurve` (the SAME clamp the
 * Inspector's bezier widget applies before a drag reaches the manifest).
 * Malformed is a hard error; out-of-range is clamped with a `warning`, never
 * a blocker. `schema.ts` itself is untouched — this is a guard at the MCP
 * boundary, not a fix to the still-open bug.
 *
 * **The "nothing happened" signal.** Every `manifestEdit.ts` `set*`/`move*`/
 * `align*`/`distribute*` function returns the SAME `Manifest` reference,
 * unchanged, when its args don't resolve to anything editable. So
 * `next === cur.manifest` is a reliable "no-op" check, used throughout
 * instead of re-deriving each function's own resolution logic a second time.
 */
import {
  addLayer,
  addScene,
  alignSelections,
  distributeSelections,
  layerActiveSchedule,
  layerDragBase,
  layerTransformKeys,
  layerVisibleFrameRange,
  layerWorldPosition,
  layerWorldSize,
  moveCamera2dKeyAt,
  moveCamera3dKeyAt,
  moveKeysByDelta,
  moveLayerActiveKeyAt,
  moveLayersByDelta,
  moveLayersByDeltaAutoKey,
  moveLayerTransformKeyAt,
  reorderLayers,
  resetLayerItemPosition,
  resolveSelection,
  resolveSelections,
  selectedCamera2d,
  selectedCamera3d,
  selectedLayer,
  selectedLayerItem,
  selectedScene,
  setCamera2d,
  setCamera3d,
  setFieldOnSelections,
  setLayerActiveSchedule,
  setLayerField,
  setLayerItemField,
  setLayerItemOffset,
  setLayerPosition,
  setLayerSize,
  setLayerTransformField,
  setLayerTransformKeys,
  setSceneField,
  setTransformFieldOnSelections,
  upsertLayerTransformKeyXY,
  type ActiveKey,
  type AlignEdge,
  type KeyMoveTarget,
} from './manifestEdit';
import { catalogEntries, type PrimitiveUse } from './catalog';
import {
  CAM2D_KEY_FIELDS,
  CAM3D_KEY_FIELDS,
  fieldsForPrimitive,
  LAYER_TRANSFORM_FIELDS,
  LAYER_TRANSFORM_KEY_FIELDS,
  positionFields,
  SCENE_FIELDS,
  sizeFields,
} from './propCatalog';
import { clampEaseCurve, resolveEaseCurve, type EaseCurve } from './easeCurve';
import { layerLabel, type Selection } from './LayerList';
import { sceneStartFrame, totalFrames } from '@chroma/motion-engine/src/engine/build';
import type { Cam2dKey, Cam3dKey, Manifest, TransformKey } from '@chroma/motion-engine/src/engine/schema';
import type { LoadState, RenderOutcome, SaveOutcome } from './useMotionManifest';

/**
 * The slice of `useMotionManifest()`'s return value these ops actually use.
 * Deliberately NARROWER than `ReturnType<typeof useMotionManifest>`: the
 * real hook result structurally satisfies this, and a TEST can build one by
 * hand without stubbing a dozen fields no op ever reads.
 */
export interface MotionOpsApi {
  loadState: LoadState;
  manifest: Manifest | null;
  parseError: string | null;
  dirty: boolean;
  saveError: string | null;
  commit: (next: Manifest, label: string) => void;
  save: () => Promise<SaveOutcome>;
  render: () => Promise<RenderOutcome>;
}

/** The bit of `@remotion/player`'s `PlayerRef` these ops touch — structural,
 *  so this module imports nothing from that package. */
export interface MotionPlayer {
  seekTo: (frame: number) => void;
  getCurrentFrame: () => number;
}

export interface MotionOpsContext {
  /** the LIVE `useMotionManifest()` result — read fresh on every call, never
   *  captured, since the hook returns a new object every render. */
  api: () => MotionOpsApi;
  /** `MotionTab.tsx`'s own live `selections` state (the READ half). */
  selections: () => Selection[];
  /** `MotionTab.tsx`'s own `setSelections` (the WRITE half). */
  setSelections: (next: Selection[]) => void;
  /** the mounted player, or `null` before it mounts. */
  player: () => MotionPlayer | null;
}

/** An op's return value: anything, plus the `error` convention the shell
 *  turns into `{ok:false}`. Kept loose on purpose — each op returns its own
 *  shape, exactly as the Colorist/Editor registries do. */
export type MotionOpResult = Record<string, unknown>;
export type MotionOps = Record<string, (args: Record<string, unknown>) => MotionOpResult | Promise<MotionOpResult>>;

const VALID_USES = new Set<string>(catalogEntries.map((e) => e.use));
const ALIGN_EDGES = new Set<string>(['left', 'centerH', 'right', 'top', 'centerV', 'bottom']);
const DISTRIBUTE_AXES = new Set<string>(['horizontal', 'vertical']);
const KEY_LANES = new Set<string>(['layer', 'camera', 'scene3d-camera', 'active']);
/** the default `fps` used when a manifest somehow carries none — the same
 *  floor `useMotionControl`'s Phase 3 ops already applied inline. */
const FALLBACK_FPS = 30;

/** reads an arg under either its `snake_case` or `camelCase` spelling. */
function arg(a: Record<string, unknown>, snake: string, camel: string): unknown {
  return a?.[snake] ?? a?.[camel];
}

function isErr<T>(v: T | { error: string }): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in (v as Record<string, unknown>);
}

/**
 * The `no-project` / `no manifest` preamble every op shares, verbatim from
 * the per-op copies it replaces (same two sentences, so no caller-visible
 * message changed). `nothingTo` customises the second message for the two
 * ops that already said something more specific ("nothing to save"/"nothing
 * to render").
 */
function requireManifest(cur: MotionOpsApi, nothingTo?: string): { manifest: Manifest } | { error: string } {
  if (cur.loadState === 'no-project') {
    return { error: 'no project open — open one in the Colorist tab' };
  }
  if (!cur.manifest) {
    return { error: nothingTo ? `no manifest loaded yet — nothing to ${nothingTo}` : 'no manifest loaded yet' };
  }
  return { manifest: cur.manifest };
}

/**
 * The `{scene_index, target}` wire shape's parser — mirrors `Selection`
 * exactly (D-168 §3). Deliberately does NOT resolve against a manifest;
 * callers do that separately via `resolveOrError`, mirroring the two-step
 * "parse the wire shape, then resolve it" split `MotionTab.tsx` itself uses.
 */
export function parseSelectionArg(a: Record<string, unknown>): Selection | { error: string } {
  const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
  if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };

  const target = a?.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== 'object') {
    return {
      error:
        'target ({kind, index?, id?}) required — kind is one of: scene, camera, scene3d-camera, layer, scene3d-child, layer-item',
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
    // `id`, when present, is what actually resolves the target — `index`
    // just needs to be SOME finite integer to satisfy `Selection`'s shape
    // when only an `id` was given (D-158's `resolveSelection` ignores
    // `index` entirely whenever `id` is set).
    const index = hasIndex ? Math.round(Number(target.index)) : 0;
    if (hasIndex && !Number.isFinite(index)) return { error: 'target.index must be an integer' };
    return { sceneIndex, target: { kind, index, ...(hasId ? { id: String(target.id) } : {}) } };
  }
  // D-255 — `layer-item` (one CARD inside a `layers` primitive, D-182) was
  // missing from the pre-split parser, which is exactly why the whole
  // per-card drag gesture had no MCP surface. Index-only by nature:
  // `LayerItem` carries no id (nothing reorders cards today).
  if (kind === 'layer-item') {
    const index = Math.round(Number(target.index));
    const itemIndex = Math.round(Number(target.item_index ?? target.itemIndex));
    if (!Number.isFinite(index)) return { error: 'target.index (the parent layer) must be an integer' };
    if (!Number.isFinite(itemIndex)) return { error: 'target.item_index (the card) must be an integer' };
    return { sceneIndex, target: { kind: 'layer-item', index, itemIndex } };
  }
  return {
    error: `target.kind must be one of: scene, camera, scene3d-camera, layer, scene3d-child, layer-item (got "${String(kind)}")`,
  };
}

/** the `selections` (plural) wire shape — an array of `parseSelectionArg`'s. */
export function parseSelectionsArg(a: Record<string, unknown>): Selection[] | { error: string } {
  const list = a?.selections;
  if (!Array.isArray(list) || list.length === 0) {
    return { error: 'selections (non-empty array of {scene_index, target}) required' };
  }
  const out: Selection[] = [];
  for (let i = 0; i < list.length; i++) {
    const parsed = parseSelectionArg(list[i] as Record<string, unknown>);
    if (isErr(parsed)) return { error: `selections[${i}]: ${parsed.error}` };
    out.push(parsed);
  }
  return out;
}

/**
 * Resolves a parsed `Selection` against the live manifest, preferring
 * `target.id` over `target.index` — `manifestEdit.ts`'s `resolveSelection`
 * (D-158) implements that preference; this only turns its `null` into the
 * `{error}` shape every op returns. Every op reading `target.id`/`index` off
 * the wire MUST route through this rather than handing the raw parsed
 * selection to `setLayerField`/etc. directly — those key off `target.index`
 * alone and know nothing about id-preference, so skipping this would make
 * id-addressed calls silently behave like index-addressed ones.
 */
export function resolveOrError(manifest: Manifest, selection: Selection): Selection | { error: string } {
  const resolved = resolveSelection(manifest, selection);
  if (!resolved) {
    return {
      error: `selection (scene ${selection.sceneIndex}, ${JSON.stringify(selection.target)}) does not resolve to anything in the current manifest`,
    };
  }
  return resolved;
}

/** parse + resolve + "is it a layer-ish target" in one step — the preamble
 *  every layer-targeting op shares. `kinds` names what that op accepts. */
function resolveLayerTarget(
  manifest: Manifest,
  a: Record<string, unknown>,
  opName: string,
  kinds: readonly Selection['target']['kind'][] = ['layer', 'scene3d-child'],
): Selection | { error: string } {
  const parsed = parseSelectionArg(a);
  if (isErr(parsed)) return parsed;
  const resolved = resolveOrError(manifest, parsed);
  if (isErr(resolved)) return resolved;
  if (!kinds.includes(resolved.target.kind)) {
    return { error: `${opName} targets ${kinds.join(' or ')}, got target.kind="${resolved.target.kind}"` };
  }
  return resolved;
}

/**
 * B-062's guard, at the MCP boundary. `undefined`/`null` is a no-op success;
 * a malformed value is a real error, never silently dropped; a well-shaped
 * but out-of-range one is clamped and reported as a `warning`.
 */
export function validateEaseArg(raw: unknown): { curve?: EaseCurve; warning?: string } | { error: string } {
  if (raw === undefined || raw === null) return {};
  const resolved = resolveEaseCurve(raw);
  if (!resolved) {
    return { error: 'ease must be a 4-number array [x1, y1, x2, y2] (Easing.bezier control points)' };
  }
  const clamped = clampEaseCurve(resolved);
  const changed = clamped.some((v, i) => v !== resolved[i]);
  return {
    curve: clamped,
    warning: changed
      ? `ease ${JSON.stringify(resolved)} was out of range — clamped to ${JSON.stringify(clamped)}`
      : undefined,
  };
}

/** `easeCurve.ts`'s `EaseCurve` is `readonly` (D-164); the schema-inferred
 *  key `ease` is the mutable tuple zod infers. One spread, one place. */
function toSchemaEase(curve: EaseCurve): [number, number, number, number] {
  return [...curve] as [number, number, number, number];
}

function manifestFps(manifest: Manifest): number {
  return typeof manifest.fps === 'number' && manifest.fps > 0 ? manifest.fps : FALLBACK_FPS;
}

/** reads a scene's key array for one lane — the shared read half of
 *  `motion_set_keyframe_ease`/`motion_move_camera_keyframe`. */
function laneKeys(
  manifest: Manifest,
  lane: string,
  sceneIndex: number,
  selection: Selection | null,
): { at: number }[] | null {
  if (lane === 'camera') return selectedCamera2d(manifest, sceneIndex);
  if (lane === 'scene3d-camera') return selectedCamera3d(manifest, sceneIndex);
  if (lane === 'layer') return selection ? layerTransformKeys(manifest, selection) : null;
  if (lane === 'active') return selection ? layerActiveSchedule(manifest, selection) : null;
  return null;
}

/**
 * Build the whole `motion_*` op registry against a live context.
 *
 * Called once by `useMotionControl.ts` (inside its mount effect) and once
 * per test. Every handler reads `ctx.api()` fresh, so a registry built at
 * mount still sees the manifest from the render that just happened.
 */
export function createMotionOps(ctx: MotionOpsContext): MotionOps {
  return {
    // ---- reads --------------------------------------------------------

    /** the live in-editor manifest (parsed, not necessarily saved — the same
     *  value `<MotionPreview>` renders from right now). */
    motion_get_manifest: () => {
      const cur = ctx.api();
      return {
        manifest: cur.manifest,
        loadState: cur.loadState,
        parseError: cur.parseError,
        dirty: cur.dirty,
        saveError: cur.saveError,
      };
    },

    /**
     * D-255 — the read half of `motion_select`/`motion_set_selection`, and
     * the Motion analogue of `editor_get_state`. Everything an agent needs
     * to orient itself WITHOUT pulling the whole manifest: what is selected,
     * where the playhead is, and one summary row per scene (its own start
     * frame, duration, layer counts). Selection was previously invisible to
     * everything outside the webview — the exact gap D-216 closed for Edit,
     * and `mcp-tool-coverage.md` explicitly flagged it as still open here.
     */
    motion_get_state: () => {
      const cur = ctx.api();
      const manifest = cur.manifest;
      const frame = ctx.player()?.getCurrentFrame() ?? null;
      return {
        loadState: cur.loadState,
        dirty: cur.dirty,
        parseError: cur.parseError,
        saveError: cur.saveError,
        playerMounted: ctx.player() !== null,
        playheadFrame: frame,
        selection: ctx.selections(),
        fps: manifest ? manifestFps(manifest) : null,
        totalFrames: manifest ? totalFrames(manifest) : null,
        width: manifest?.width ?? null,
        height: manifest?.height ?? null,
        scenes: manifest
          ? manifest.scenes.map((scene, i) => ({
              index: i,
              id: scene.id,
              dur: scene.dur,
              startFrame: sceneStartFrame(manifest, i),
              layerCount: scene.layers?.length ?? 0,
              scene3dChildCount: scene.scene3d?.children?.length ?? 0,
              camera2dKeys: scene.camera?.length ?? 0,
              camera3dKeys: scene.scene3d?.camera?.length ?? 0,
            }))
          : [],
      };
    },

    /**
     * D-255 — every addressable layer in the manifest, flattened, with the
     * exact `{scene_index, target}` each mutating op wants. `motion_get_
     * manifest` already returns all of this buried inside the document; this
     * is the addressing INDEX, so an agent does not have to re-derive
     * "which index is the headline, and does it have an id" by walking the
     * JSON itself. Mirrors what `editor_get_timeline` does for clips.
     */
    motion_list_layers: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const onlyScene = arg(a, 'scene_index', 'sceneIndex');
      const filter = onlyScene === undefined || onlyScene === null ? null : Math.round(Number(onlyScene));
      if (filter !== null && !Number.isFinite(filter)) return { error: 'scene_index must be an integer' };

      const rows: Record<string, unknown>[] = [];
      manifest.scenes.forEach((scene, sceneIndex) => {
        if (filter !== null && sceneIndex !== filter) return;
        const push = (kind: 'layer' | 'scene3d-child', list: unknown[] | undefined) => {
          (list ?? []).forEach((raw, index) => {
            const layer = raw as { use?: string; id?: string; items?: unknown[] };
            const selection: Selection = { sceneIndex, target: { kind, index, ...(layer.id ? { id: layer.id } : {}) } };
            const pos = layerWorldPosition(manifest, selection);
            const size = layerWorldSize(manifest, selection);
            rows.push({
              sceneIndex,
              target: selection.target,
              use: layer.use,
              // the same one-line label `LayerList`'s own rows show, so an
              // agent and the human are naming the same thing.
              label: layerLabel(raw as Parameters<typeof layerLabel>[0]),
              position: pos,
              size,
              transformKeyCount: layerTransformKeys(manifest, selection).length,
              activeKeyCount: layerActiveSchedule(manifest, selection).length,
              itemCount: Array.isArray(layer.items) ? layer.items.length : undefined,
            });
          });
        };
        push('layer', scene.layers as unknown[] | undefined);
        push('scene3d-child', scene.scene3d?.children as unknown[] | undefined);
      });
      return { layers: rows, count: rows.length };
    },

    /**
     * D-255 — the static reference tool, Motion's answer to
     * `editor_get_capabilities`: what primitives exist (`motion_add_layer`'s
     * legal `use` values), and for each, the field keys `motion_set_layer_
     * field` accepts, whether it has a draggable position and a resizable
     * size. Without it, an agent's only route to a valid `use` string or a
     * field key was reading `catalog.ts`/`propCatalog.ts` in the repo — the
     * exact "would otherwise only learn by reading source" gap D-191 names.
     * Reads pure catalogue data, mutates nothing.
     */
    motion_list_primitives: () => ({
      primitives: catalogEntries.map((e) => ({
        use: e.use,
        name: e.name,
        description: e.description,
        in3d: e.in3d,
        container: e.in3d ? 'scene.scene3d.children (target.kind="scene3d-child")' : 'scene.layers (target.kind="layer")',
        fields: fieldsForPrimitive(e.use) ?? [],
        position: positionFields(e.use) ?? null,
        size: sizeFields(e.use) ?? null,
      })),
      sceneFields: SCENE_FIELDS,
      layerTransformFields: LAYER_TRANSFORM_FIELDS,
      layerTransformKeyFields: LAYER_TRANSFORM_KEY_FIELDS,
      camera2dKeyFields: CAM2D_KEY_FIELDS,
      camera3dKeyFields: CAM3D_KEY_FIELDS,
    }),

    // ---- scenes -------------------------------------------------------

    /** insert a new 4s scene right after `after_scene_index` (or at the end)
     *  — `addScene`, the exact function `LayerList.tsx`'s own "+ Scene"
     *  button calls (D-178). */
    motion_add_scene: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;

      const raw = arg(a, 'after_scene_index', 'afterSceneIndex');
      let after: number | undefined;
      if (raw !== undefined && raw !== null) {
        after = Math.round(Number(raw));
        if (!Number.isFinite(after)) return { error: 'after_scene_index must be an integer' };
      }

      const { manifest: next, selection } = addScene(guard.manifest, after);
      cur.commit(next, 'Add scene');
      return { selection, sceneIndex: selection.sceneIndex, sceneCount: next.scenes.length };
    },

    /** set (or delete, `value: null`) one field on the scene itself. */
    motion_set_scene_field: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      }

      const key = a?.key;
      if (typeof key !== 'string' || !key) return { error: 'key (string) required' };
      if (!a || !('value' in a)) return { error: 'value is required (use JSON null to delete the field)' };
      const value = a.value === null ? undefined : a.value;

      const warning = SCENE_FIELDS.some((f) => f.key === key)
        ? undefined
        : `"${key}" is not one of the known scene fields (${SCENE_FIELDS.map((f) => f.key).join(', ')}) — set anyway`;

      const next = setSceneField(manifest, sceneIndex, key, value);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, `Set scene ${key}`);
      return { sceneIndex, key, value: value ?? null, warning };
    },

    /**
     * replace a scene's 2D camera keyframe array WHOLESALE — `setCamera2d`.
     * There is no granular "patch one camera key VALUE" write function in
     * `manifestEdit.ts` (only the retiming `moveCamera2dKeyAt`, which
     * `motion_move_camera_keyframe` wraps), so an agent tweaking one key's
     * `zoom` reads the array via `motion_get_manifest`, edits it, and
     * resends. A real, current limitation, documented rather than papered
     * over with new logic here.
     */
    motion_set_camera_2d: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      }

      const rawKeys = a?.keys;
      if (!Array.isArray(rawKeys)) return { error: 'keys (array of {at, x?, y?, zoom?, ease?}) required' };

      const keys: Cam2dKey[] = [];
      const warnings: string[] = [];
      for (let i = 0; i < rawKeys.length; i++) {
        const k = rawKeys[i] as Record<string, unknown>;
        if (!k || typeof k !== 'object' || typeof k.at !== 'number' || !Number.isFinite(k.at)) {
          return { error: `keys[${i}] needs a numeric "at"` };
        }
        const ease = validateEaseArg(k.ease);
        if (isErr(ease)) return { error: `keys[${i}].${ease.error}` };
        if (ease.warning) warnings.push(`keys[${i}]: ${ease.warning}`);
        const key: Cam2dKey = { at: k.at };
        for (const field of ['x', 'y', 'zoom'] as const) {
          const v = k[field];
          if (typeof v === 'number' && Number.isFinite(v)) key[field] = v;
        }
        if (ease.curve) key.ease = toSchemaEase(ease.curve);
        keys.push(key);
      }

      const next = setCamera2d(manifest, sceneIndex, keys);
      if (next === manifest) return { error: `no scene at index ${sceneIndex}` };
      cur.commit(next, 'Set camera');
      return { sceneIndex, keyCount: keys.length, warning: warnings.length ? warnings.join('; ') : undefined };
    },

    /** replace a scene's 3D camera keyframe array WHOLESALE — `setCamera3d`.
     *  Same wholesale-only limitation as `motion_set_camera_2d`. A scene with
     *  no `scene3d` block yet has no camera to set: the only way to create
     *  one today is `motion_add_layer` with an `in3d` use. */
    motion_set_camera_3d: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      const scene = manifest.scenes[sceneIndex];
      if (!scene) return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      if (!scene.scene3d) {
        return {
          error: `scene ${sceneIndex} has no scene3d block yet — add a 3D layer first (motion_add_layer with an in3d use) to create one`,
        };
      }

      const rawKeys = a?.keys;
      if (!Array.isArray(rawKeys) || rawKeys.length < 1) {
        return {
          error: 'keys (non-empty array of {at, pos:[x,y,z], look?, ease?}) required — scene3d.camera needs at least one key',
        };
      }

      const keys: Cam3dKey[] = [];
      const warnings: string[] = [];
      for (let i = 0; i < rawKeys.length; i++) {
        const k = rawKeys[i] as Record<string, unknown>;
        if (
          !k ||
          typeof k !== 'object' ||
          typeof k.at !== 'number' ||
          !Number.isFinite(k.at) ||
          !Array.isArray(k.pos) ||
          k.pos.length !== 3
        ) {
          return { error: `keys[${i}] needs a numeric "at" and a 3-number "pos" [x,y,z]` };
        }
        const ease = validateEaseArg(k.ease);
        if (isErr(ease)) return { error: `keys[${i}].${ease.error}` };
        if (ease.warning) warnings.push(`keys[${i}]: ${ease.warning}`);
        const key: Cam3dKey = { at: k.at, pos: k.pos as [number, number, number] };
        if (Array.isArray(k.look) && k.look.length === 3) key.look = k.look as [number, number, number];
        if (ease.curve) key.ease = toSchemaEase(ease.curve);
        keys.push(key);
      }

      const next = setCamera3d(manifest, sceneIndex, keys);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, 'Set 3D camera');
      return { sceneIndex, keyCount: keys.length, warning: warnings.length ? warnings.join('; ') : undefined };
    },

    // ---- layers -------------------------------------------------------

    /** insert a schema-valid default instance of a primitive into a scene —
     *  the Catalog panel's own action (`MotionTab.tsx`'s `onCatalogAdd`). */
    motion_add_layer: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      }

      const use = String(a?.use ?? '');
      if (!VALID_USES.has(use)) return { error: `use must be one of: ${[...VALID_USES].join(', ')}` };

      const { manifest: next, selection } = addLayer(manifest, sceneIndex, use as PrimitiveUse);
      if (!selection) {
        // `addLayer` only returns a null selection for an unresolvable scene
        // index — already checked above, so this is a defensive floor.
        return { error: `could not add a "${use}" layer to scene ${sceneIndex}` };
      }
      cur.commit(next, `Add ${use} layer`);
      return { sceneIndex, selection, addedUse: use };
    },

    /**
     * D-255 — move a layer WITHIN one scene's `layers[]` (or one scene's
     * `scene3d.children[]`), `reorderLayers`: the exact function
     * `LayerList.tsx`'s drag-to-reorder gesture commits through (D-177).
     * Paint order is array order, so this is how an agent puts one layer in
     * front of another. Reordering ACROSS scenes is not supported (no such
     * function exists — a layer belongs to its scene).
     */
    motion_reorder_layers: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      }

      const kind = (a?.kind as string) ?? 'layer';
      if (kind !== 'layer' && kind !== 'scene3d-child') {
        return { error: 'kind must be "layer" or "scene3d-child"' };
      }
      const fromIndex = Math.round(Number(arg(a, 'from_index', 'fromIndex')));
      const toIndex = Math.round(Number(arg(a, 'to_index', 'toIndex')));
      if (!Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) {
        return { error: 'from_index and to_index (integers) required' };
      }

      const list =
        kind === 'layer' ? manifest.scenes[sceneIndex].layers : manifest.scenes[sceneIndex].scene3d?.children;
      const length = list?.length ?? 0;
      if (fromIndex < 0 || fromIndex >= length || toIndex < 0 || toIndex >= length) {
        return { error: `from_index/to_index must both be within 0..${length - 1} (${kind} count = ${length})` };
      }
      if (fromIndex === toIndex) return { error: 'from_index and to_index are the same — nothing to reorder' };

      const next = reorderLayers(manifest, sceneIndex, kind, fromIndex, toIndex);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, 'Reorder layers');
      return { sceneIndex, kind, fromIndex, toIndex, count: length };
    },

    /** set (or delete, `value: null`) one top-level field on a layer or
     *  scene3d-child — `setLayerField`. */
    motion_set_layer_field: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'set_layer_field');
      if (isErr(resolved)) return resolved;

      const key = a?.key;
      if (typeof key !== 'string' || !key) return { error: 'key (string) required' };
      if (!a || !('value' in a)) return { error: 'value is required (use JSON null to delete the field)' };
      const value = a.value === null ? undefined : a.value;

      // Soft validation against the same field list the Inspector renders —
      // never blocks the write (a hand-authored manifest can carry fields
      // the Inspector doesn't know about yet), just flags it.
      let warning: string | undefined;
      const found = selectedLayer(manifest, resolved);
      if (found) {
        const fields = fieldsForPrimitive(found.use);
        if (fields && !fields.some((f) => f.key === key)) {
          warning = `"${key}" is not a known field for use="${found.use}" (see motion_list_primitives) — set anyway`;
        }
      }

      const next = setLayerField(manifest, resolved, key, value);
      if (next === manifest) return { error: 'no change — selection did not resolve to an editable layer' };
      cur.commit(next, `Set ${key}`);
      return { selection: resolved, key, value: value ?? null, warning };
    },

    /**
     * D-255 — set one field across a WHOLE multi-selection in one undo step,
     * `setFieldOnSelections` / `setTransformFieldOnSelections`: the two
     * functions the Inspector's own multi-select form commits through
     * (D-158). `transform=true` writes the nested `layer.transform.<key>`
     * (the generic group every primitive has, D-157) rather than a top-level
     * field. N separate `motion_set_layer_field` calls are NOT equivalent —
     * they would be N undo entries instead of the one a human's edit makes.
     */
    motion_set_field_on_layers: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const parsedList = parseSelectionsArg(a);
      if (isErr(parsedList)) return parsedList;

      const key = a?.key;
      if (typeof key !== 'string' || !key) return { error: 'key (string) required' };
      if (!a || !('value' in a)) return { error: 'value is required (use JSON null to delete the field)' };
      const value = a.value === null ? undefined : a.value;
      const onTransform = a?.transform === true;

      const resolved = resolveSelections(manifest, parsedList);
      const droppedCount = parsedList.length - resolved.length;
      if (resolved.length === 0) return { error: 'no selections resolved against the current manifest' };

      const next = onTransform
        ? setTransformFieldOnSelections(manifest, resolved, key, value)
        : setFieldOnSelections(manifest, resolved, key, value);
      if (next === manifest) return { error: 'no change — no selection resolved to an editable layer' };
      cur.commit(next, resolved.length > 1 ? `Edit ${resolved.length} layers` : `Set ${key}`);
      return { key, value: value ?? null, transform: onTransform, changedCount: resolved.length, droppedCount };
    },

    /**
     * D-255 — one CARD inside a `layers`-primitive layer (D-182/B-068): its
     * `dx`/`dy` pixel offset (`setLayerItemOffset`, what the per-card canvas
     * drag commits), any other field such as `label`/`sublabel`
     * (`setLayerItemField`, the Inspector's card form), or `reset=true`
     * (`resetLayerItemPosition`, that form's own Reset position button —
     * both offsets dropped in ONE undo step, not two).
     *
     * Target is `{kind:"layer-item", index, item_index}` — `index` is the
     * parent layer's own index, `item_index` the card's position in its
     * `items[]`. Index-only by nature: a card carries no id.
     */
    motion_set_layer_item: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'set_layer_item', ['layer-item']);
      if (isErr(resolved)) return resolved;

      const reset = a?.reset === true;
      const dx = Number(a?.dx);
      const dy = Number(a?.dy);
      const hasOffset = Number.isFinite(dx) && Number.isFinite(dy);
      const key = a?.key;
      const hasField = typeof key === 'string' && key.length > 0;

      if (Number(reset) + Number(hasOffset) + Number(hasField) !== 1) {
        return {
          error: 'pass exactly one of: reset=true, dx+dy (both numbers), or key (+value) — they are three different edits',
        };
      }

      let next: Manifest;
      let label: string;
      if (reset) {
        next = resetLayerItemPosition(manifest, resolved);
        label = 'Reset card position';
      } else if (hasOffset) {
        next = setLayerItemOffset(manifest, resolved, dx, dy);
        label = 'Move card';
      } else {
        if (!a || !('value' in a)) return { error: 'value is required alongside key (use JSON null to delete the field)' };
        next = setLayerItemField(manifest, resolved, key as string, a.value === null ? undefined : a.value);
        label = `Set card ${String(key)}`;
      }

      if (next === manifest) return { error: 'no change — the card did not resolve, or already held that value' };
      cur.commit(next, label);
      return { selection: resolved, item: selectedLayerItem(next, resolved) };
    },

    // ---- selection ----------------------------------------------------

    /**
     * Set the tab's live selection to exactly ONE target AND seek the player
     * to it — `MotionTab.tsx`'s own `onSelect`, reached from here instead of
     * a click. Read-only w.r.t. the manifest (no `commit()`).
     *
     * B-125 (fixed here) — this used to seek unconditionally to the target
     * SCENE's start frame, which is what `onSelect` did back when D-170 wrote
     * this op. `onSelect` has since gained D-173's "only seek if the target
     * is in a different scene than the playhead" rule and D-176's "seek to
     * the LAYER's own visible start, not the scene's" — so the op and the
     * gesture had silently diverged. It now runs the same logic.
     */
    motion_select: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const parsed = parseSelectionArg(a);
      if (isErr(parsed)) return parsed;
      const resolved = resolveOrError(manifest, parsed);
      if (isErr(resolved)) return resolved;

      ctx.setSelections([resolved]);

      const player = ctx.player();
      const currentFrame = player?.getCurrentFrame();
      let seekedTo: number | null = null;
      if (player && currentFrame !== undefined) {
        // D-176 — a layer target seeks to where it ACTUALLY starts, and only
        // when the playhead isn't already inside its own visible window.
        const range = layerVisibleFrameRange(manifest, resolved);
        if (range) {
          if (currentFrame < range.start || currentFrame >= range.end) {
            player.seekTo(range.start);
            seekedTo = range.start;
          }
        } else {
          // D-173 — scene/camera targets have no `at`/`dur` of their own, so
          // the check is the scene boundary: only jump if we're looking at a
          // different scene already.
          const start = sceneStartFrame(manifest, resolved.sceneIndex);
          const end = start + Math.round(manifestFps(manifest) * (selectedScene(manifest, resolved.sceneIndex)?.dur ?? 0));
          if (currentFrame < start || currentFrame >= end) {
            player.seekTo(start);
            seekedTo = start;
          }
        }
      }
      return { selection: resolved, seekedTo, playerMounted: player !== null };
    },

    /**
     * D-255 — set the WHOLE selection array without seeking: the marquee /
     * shift-toggle half of the canvas's selection model (`MotionTab.tsx`'s
     * `onSelectionChange`), as distinct from `motion_select`'s single
     * explicit pick. `selections: []` clears.
     *
     * **Why an agent needs this at all**, given every mutating op above
     * already takes an explicit target: exactly D-216's reasoning for the
     * Edit tab. Motion has surfaces that render ONLY for a selection — the
     * Inspector's property form, the on-canvas transform box and its resize
     * handles, the align/distribute buttons (2+ / 3+ selected), and the
     * KeyframeTimeline's own per-row lanes. Until this existed nothing but a
     * mouse could put the app into the state those surfaces need, so none of
     * them could be driven or screenshot-verified by an agent. Pair it with
     * `debug_screenshot`.
     *
     * **Not undoable**, exactly like `editor_set_selection`: `selections` is
     * `MotionTab.tsx`'s own React state, not part of the manifest, so
     * nothing persists it and the GUI's own click pushes nothing either.
     */
    motion_set_selection: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const list = a?.selections;
      if (!Array.isArray(list)) {
        return { error: 'selections (array of {scene_index, target}; [] clears) required' };
      }
      if (list.length === 0) {
        ctx.setSelections([]);
        return { selection: [], cleared: true };
      }

      const parsedList = parseSelectionsArg(a);
      if (isErr(parsedList)) return parsedList;

      // Every entry is validated against the LIVE manifest — a target that
      // doesn't resolve is a real error, never a stored selection of nothing
      // (the same rule `editor_set_selection` holds).
      const out: Selection[] = [];
      for (let i = 0; i < parsedList.length; i++) {
        const resolved = resolveOrError(manifest, parsedList[i]);
        if (isErr(resolved)) return { error: `selections[${i}]: ${resolved.error}` };
        out.push(resolved);
      }
      ctx.setSelections(out);
      return { selection: out, count: out.length, singleSelected: out.length === 1 };
    },

    // ---- transform ----------------------------------------------------

    /** move a layer/scene3d-child to a new WORLD-px position — `setLayerPosition`. */
    motion_set_layer_position: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const parsed = parseSelectionArg(a);
      if (isErr(parsed)) return parsed;
      const resolved = resolveOrError(manifest, parsed);
      if (isErr(resolved)) return resolved;

      const x = Number(a?.x);
      const y = Number(a?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x and y (numbers) required' };

      const next = setLayerPosition(manifest, resolved, x, y);
      if (next === manifest) {
        const use = selectedLayer(manifest, resolved)?.use ?? 'unknown';
        return { error: `selection has no draggable x/y position (use="${use}")` };
      }
      cur.commit(next, 'Set layer position');
      return { selection: resolved, x, y };
    },

    /** resize a layer/scene3d-child in WORLD px — `setLayerSize`. */
    motion_set_layer_size: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const parsed = parseSelectionArg(a);
      if (isErr(parsed)) return parsed;
      const resolved = resolveOrError(manifest, parsed);
      if (isErr(resolved)) return resolved;

      const w = Number(a?.w);
      const h = Number(a?.h);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return { error: 'w and h (numbers) required' };

      const next = setLayerSize(manifest, resolved, w, h);
      if (next === manifest) {
        const use = selectedLayer(manifest, resolved)?.use ?? 'unknown';
        return { error: `selection has no resizable field (use="${use}")` };
      }
      cur.commit(next, 'Set layer size');
      return { selection: resolved, w, h };
    },

    /**
     * D-255 — one field of a layer's own `transform` WRAPPER
     * (`scale`/`rot`/`opacity`/`x`/`y`, `propCatalog.ts`'s
     * `LAYER_TRANSFORM_FIELDS`), via `setLayerTransformField`: the Inspector's
     * Transform group, which is generic across every primitive (D-157).
     *
     * **This is the op for scale/rotation/opacity**, and it is genuinely
     * different from `motion_set_layer_position`/`motion_set_layer_size`
     * above: those write the PRIMITIVE's own native geometry fields (a
     * `text` layer's own `x`/`y`, an `emphasis` layer's own `box`), whereas
     * this writes the generic post-transform every primitive shares. It is
     * also the STATIC counterpart to `motion_set_layer_transform_keys` — a
     * keyed property silently beats a static one at render time, so setting
     * `scale` here on a layer that already has `transform.keys` carrying
     * `scale` will not visibly change anything; clear or rewrite the keys
     * instead. Setting the LAST remaining transform field to `null` drops
     * the whole `transform` object rather than leaving an empty one.
     */
    motion_set_layer_transform_field: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'set_layer_transform_field');
      if (isErr(resolved)) return resolved;

      const key = a?.key;
      if (typeof key !== 'string' || !key) return { error: 'key (string) required' };
      if (!a || !('value' in a)) return { error: 'value is required (use JSON null to delete the field)' };
      const value = a.value === null ? undefined : a.value;

      const warning = LAYER_TRANSFORM_FIELDS.some((f) => f.key === key)
        ? undefined
        : `"${key}" is not one of the known transform fields (${LAYER_TRANSFORM_FIELDS.map((f) => f.key).join(', ')}) — set anyway`;

      const next = setLayerTransformField(manifest, resolved, key, value);
      if (next === manifest) return { error: 'no change — selection did not resolve to an editable layer' };
      cur.commit(next, `Set transform ${key}`);
      const keyed = layerTransformKeys(next, resolved).length;
      return {
        selection: resolved,
        key,
        value: value ?? null,
        warning:
          warning ??
          (keyed > 0
            ? `this layer has ${keyed} transform keyframe(s) — a keyed property overrides this static value at render time`
            : undefined),
      };
    },

    /**
     * nudge a multi-selection by a shared (dx, dy) — `moveLayersByDelta`, or
     * (`auto_key=true`) `moveLayersByDeltaAutoKey`, which is what the canvas
     * drag ACTUALLY commits for a layer that is already keyframed: it
     * upserts a `transform.keys` row at `at` instead of moving the static
     * position, so the move becomes part of the animation rather than
     * silently losing to it (D-159).
     *
     * Each entry's base position is read fresh off the CURRENT manifest
     * (`layerWorldPosition`), never a stale drag-start snapshot — an MCP call
     * has no live gesture to capture a base from, so "current position" is
     * the only honest base for a one-shot op.
     */
    motion_move_layers_by_delta: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const parsedList = parseSelectionsArg(a);
      if (isErr(parsedList)) return parsedList;
      const dx = Number(a?.dx);
      const dy = Number(a?.dy);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { error: 'dx and dy (numbers) required' };

      const autoKey = arg(a, 'auto_key', 'autoKey') === true;
      const at = Number(a?.at);
      if (autoKey && !Number.isFinite(at)) {
        return { error: 'at (seconds, number) required when auto_key is true — a keyframe needs a time' };
      }

      const resolved = resolveSelections(manifest, parsedList);
      const droppedCount = parsedList.length - resolved.length;
      const fps = manifestFps(manifest);

      // The two modes build their `moves` the two different ways the two GUI
      // paths build theirs. Plain: `layerWorldPosition`, the static base
      // `moveLayersByDelta` wants. Auto-key: `layerDragBase` at the target
      // frame — the SAME read `MotionCanvasOverlay.tsx`'s pointer-down does,
      // and the only source of the per-entry `keyed` flag that decides,
      // individually, whether that layer gets a keyframe upsert or a static
      // move (a mixed group is fully supported, D-159).
      const moves: { selection: Selection; base: { x: number; y: number }; keyed: boolean }[] = [];
      if (autoKey) {
        const frame = Math.round(at * fps);
        for (const selection of resolved) {
          const dragBase = layerDragBase(manifest, selection, frame, fps);
          if (dragBase) moves.push({ selection, base: dragBase.base, keyed: dragBase.keyed });
        }
      } else {
        for (const selection of resolved) {
          const base = layerWorldPosition(manifest, selection);
          if (base) moves.push({ selection, base, keyed: false });
        }
      }
      if (moves.length === 0) {
        return { error: 'no draggable layers in selection (none resolved to a world position)' };
      }

      const next = autoKey
        ? moveLayersByDeltaAutoKey(manifest, moves, dx, dy, at, fps)
        : moveLayersByDelta(manifest, moves, dx, dy);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, 'Move layers');
      return {
        movedCount: moves.length,
        droppedCount,
        dx,
        dy,
        autoKey,
        at: autoKey ? at : undefined,
        keyedCount: autoKey ? moves.filter((mv) => mv.keyed).length : undefined,
      };
    },

    /** align a 2+ multi-selection to a shared edge/center line. */
    motion_align_layers: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const parsedList = parseSelectionsArg(a);
      if (isErr(parsedList)) return parsedList;
      const edge = a?.edge;
      if (typeof edge !== 'string' || !ALIGN_EDGES.has(edge)) {
        return { error: `edge must be one of: ${[...ALIGN_EDGES].join(', ')}` };
      }

      const resolved = resolveSelections(manifest, parsedList);
      const droppedCount = parsedList.length - resolved.length;
      if (resolved.length < 2) {
        return { error: 'align requires at least 2 resolvable selections with a draggable position' };
      }

      const next = alignSelections(manifest, resolved, edge as AlignEdge);
      if (next === manifest) return { error: 'no change (fewer than 2 selections had a draggable position)' };
      cur.commit(next, `Align ${edge}`);
      return { alignedCount: resolved.length, droppedCount, edge };
    },

    /** space a 3+ multi-selection with equal gaps along one axis. */
    motion_distribute_layers: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const parsedList = parseSelectionsArg(a);
      if (isErr(parsedList)) return parsedList;
      const axis = a?.axis;
      if (typeof axis !== 'string' || !DISTRIBUTE_AXES.has(axis)) {
        return { error: `axis must be one of: ${[...DISTRIBUTE_AXES].join(', ')}` };
      }

      const resolved = resolveSelections(manifest, parsedList);
      const droppedCount = parsedList.length - resolved.length;
      if (resolved.length < 3) {
        return { error: 'distribute requires at least 3 resolvable selections with a draggable position' };
      }

      const next = distributeSelections(manifest, resolved, axis as 'horizontal' | 'vertical');
      if (next === manifest) return { error: 'no change (fewer than 3 selections had a draggable position)' };
      cur.commit(next, `Distribute ${axis}`);
      return { distributedCount: resolved.length, droppedCount, axis };
    },

    // ---- keyframes ----------------------------------------------------

    /** replace a layer/scene3d-child's `transform.keys` array WHOLESALE. An
     *  EMPTY array deletes the field entirely (the convention
     *  `setLayerTransformKeys` itself holds). */
    motion_set_layer_transform_keys: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'set_layer_transform_keys');
      if (isErr(resolved)) return resolved;

      const rawKeys = a?.keys;
      if (!Array.isArray(rawKeys)) {
        return { error: 'keys (array of {at, x?, y?, scale?, rot?, opacity?, ease?}) required' };
      }

      const keys: TransformKey[] = [];
      const warnings: string[] = [];
      for (let i = 0; i < rawKeys.length; i++) {
        const k = rawKeys[i] as Record<string, unknown>;
        if (!k || typeof k !== 'object' || typeof k.at !== 'number' || !Number.isFinite(k.at)) {
          return { error: `keys[${i}] needs a numeric "at"` };
        }
        const ease = validateEaseArg(k.ease);
        if (isErr(ease)) return { error: `keys[${i}].${ease.error}` };
        if (ease.warning) warnings.push(`keys[${i}]: ${ease.warning}`);
        const key: TransformKey = { at: k.at };
        for (const field of ['x', 'y', 'scale', 'rot', 'opacity'] as const) {
          const v = k[field];
          if (typeof v === 'number' && Number.isFinite(v)) key[field] = v;
        }
        if (ease.curve) key.ease = toSchemaEase(ease.curve);
        keys.push(key);
      }

      const next = setLayerTransformKeys(manifest, resolved, keys);
      if (next === manifest && keys.length > 0) {
        return { error: 'no change — selection did not resolve to an editable layer' };
      }
      cur.commit(next, 'Set transform keys');
      return { selection: resolved, keyCount: keys.length, warnings: warnings.length ? warnings : undefined };
    },

    /** upsert ONE `transform.keys` row at `at`, from the layer's current
     *  on-screen position (`layerDragBase` + `upsertLayerTransformKeyXY` —
     *  the same auto-keyframe write path a canvas drag uses). `x`/`y` are
     *  optional explicit overrides; `ease` is applied to the same key in the
     *  SAME commit (one undo step). */
    motion_add_layer_keyframe: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'add_layer_keyframe');
      if (isErr(resolved)) return resolved;

      const at = Number(a?.at);
      if (!Number.isFinite(at)) return { error: 'at (seconds, number) required' };

      const easeResult = validateEaseArg(a?.ease);
      if (isErr(easeResult)) return easeResult;

      const fps = manifestFps(manifest);
      const hasX = typeof a?.x === 'number' && Number.isFinite(a.x);
      const hasY = typeof a?.y === 'number' && Number.isFinite(a.y);

      let x: number;
      let y: number;
      let derivedFrom: 'explicit' | 'current-position';
      if (hasX && hasY) {
        x = a.x as number;
        y = a.y as number;
        derivedFrom = 'explicit';
      } else {
        const frame = Math.round(at * fps);
        const dragBase = layerDragBase(manifest, resolved, frame, fps);
        if (!dragBase) {
          return { error: 'selection has no draggable position to derive x/y from — pass explicit x and y' };
        }
        x = hasX ? (a.x as number) : dragBase.base.x;
        y = hasY ? (a.y as number) : dragBase.base.y;
        derivedFrom = 'current-position';
      }

      let next = upsertLayerTransformKeyXY(manifest, resolved, at, fps, x, y);
      if (next === manifest) return { error: 'no change — selection did not resolve to an editable layer' };

      if (easeResult.curve) {
        const frame = Math.round(at * fps);
        const keys = layerTransformKeys(next, resolved);
        const idx = keys.findIndex((k) => Math.round((typeof k.at === 'number' ? k.at : 0) * fps) === frame);
        if (idx !== -1) {
          const withEase = keys.map((k, i) =>
            i === idx ? { ...k, ease: toSchemaEase(easeResult.curve as EaseCurve) } : k,
          );
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

    /** retime one existing `transform.keys` entry — `moveLayerTransformKeyAt`
     *  (D-158's shared `moveKeyAt` core: reorders past a neighbour, clamps to
     *  the scene's own `[0, dur]`, never blocks). */
    motion_move_layer_keyframe: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'move_layer_keyframe');
      if (isErr(resolved)) return resolved;

      const keyIndex = Math.round(Number(arg(a, 'key_index', 'keyIndex')));
      if (!Number.isFinite(keyIndex)) return { error: 'key_index (integer) required' };
      const newAt = Number(arg(a, 'new_at', 'newAt'));
      if (!Number.isFinite(newAt)) return { error: 'new_at (seconds, number) required' };

      // D-255 — `lane` picks which of the layer's TWO key arrays to retime:
      // `transform` (default, the animation keys) or `active` (D-178's step
      // schedule, which the KeyframeTimeline draws as its own lane and had
      // no MCP surface at all).
      const lane = (a?.lane as string) ?? 'transform';
      if (lane !== 'transform' && lane !== 'active') return { error: 'lane must be "transform" or "active"' };

      const existingKeys =
        lane === 'active' ? layerActiveSchedule(manifest, resolved) : layerTransformKeys(manifest, resolved);
      if (keyIndex < 0 || keyIndex >= existingKeys.length) {
        return { error: `no ${lane} key at index ${keyIndex} (layer has ${existingKeys.length} key(s))` };
      }

      const scene = selectedScene(manifest, resolved.sceneIndex);
      const clampedAt = scene ? Math.min(scene.dur, Math.max(0, newAt)) : newAt;

      const next =
        lane === 'active'
          ? moveLayerActiveKeyAt(manifest, resolved, keyIndex, newAt)
          : moveLayerTransformKeyAt(manifest, resolved, keyIndex, newAt);
      if (next === manifest) return { error: 'no change — selection did not resolve to a scene' };
      cur.commit(next, 'Move keyframe');
      return {
        selection: resolved,
        lane,
        keyIndex,
        at: clampedAt,
        warning:
          clampedAt !== newAt
            ? `${newAt}s was outside the scene's [0, ${scene?.dur}] range — clamped to ${clampedAt}s`
            : undefined,
      };
    },

    /**
     * D-255 — remove ONE `transform.keys` row. There is no bespoke delete
     * primitive in `manifestEdit.ts` and this does not invent one: it reads
     * the array, drops the named index, and writes the result back through
     * `setLayerTransformKeys` — the same function the Inspector's own
     * keyframe-list editor commits through when a row is removed, which is
     * also why deleting the LAST key drops the whole `transform.keys` field
     * rather than leaving an empty array (that function's own convention).
     */
    motion_delete_layer_keyframe: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'delete_layer_keyframe');
      if (isErr(resolved)) return resolved;

      const keyIndex = Math.round(Number(arg(a, 'key_index', 'keyIndex')));
      if (!Number.isFinite(keyIndex)) return { error: 'key_index (integer) required' };

      const keys = layerTransformKeys(manifest, resolved);
      if (keyIndex < 0 || keyIndex >= keys.length) {
        return { error: `no key at index ${keyIndex} (layer has ${keys.length} key(s))` };
      }

      const remaining = keys.filter((_, i) => i !== keyIndex);
      const next = setLayerTransformKeys(manifest, resolved, remaining);
      if (next === manifest) return { error: 'no change — selection did not resolve to an editable layer' };
      cur.commit(next, 'Delete keyframe');
      return {
        selection: resolved,
        keyIndex,
        remainingKeyCount: remaining.length,
        clearedAnimation: remaining.length === 0,
      };
    },

    /**
     * D-255 — retime one CAMERA key, `moveCamera2dKeyAt`/`moveCamera3dKeyAt`:
     * the camera's own half of the KeyframeTimeline's drag gesture, which had
     * no MCP surface. Distinct from `motion_set_camera_2d`/`_3d`, which
     * replace the whole array and are the only way to change a key's VALUES;
     * this changes only WHEN one fires, with the same clamp-never-block rule
     * every retime in this package holds.
     */
    motion_move_camera_keyframe: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      const scene = manifest.scenes[sceneIndex];
      if (!scene) return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };

      const camera = (a?.camera as string) ?? '2d';
      if (camera !== '2d' && camera !== '3d') return { error: 'camera must be "2d" or "3d"' };

      const keyIndex = Math.round(Number(arg(a, 'key_index', 'keyIndex')));
      if (!Number.isFinite(keyIndex)) return { error: 'key_index (integer) required' };
      const newAt = Number(arg(a, 'new_at', 'newAt'));
      if (!Number.isFinite(newAt)) return { error: 'new_at (seconds, number) required' };

      const keys = camera === '2d' ? selectedCamera2d(manifest, sceneIndex) : selectedCamera3d(manifest, sceneIndex);
      if (!keys) return { error: `scene ${sceneIndex} has no ${camera} camera keys` };
      if (keyIndex < 0 || keyIndex >= keys.length) {
        return { error: `no ${camera} camera key at index ${keyIndex} (scene has ${keys.length} key(s))` };
      }

      const clampedAt = Math.min(scene.dur, Math.max(0, newAt));
      const next =
        camera === '2d'
          ? moveCamera2dKeyAt(manifest, sceneIndex, keyIndex, newAt)
          : moveCamera3dKeyAt(manifest, sceneIndex, keyIndex, newAt);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, 'Move camera keyframe');
      return {
        sceneIndex,
        camera,
        keyIndex,
        at: clampedAt,
        warning:
          clampedAt !== newAt
            ? `${newAt}s was outside the scene's [0, ${scene.dur}] range — clamped to ${clampedAt}s`
            : undefined,
      };
    },

    /**
     * D-255 — nudge MANY keys, across lanes and scenes, by ONE shared delta:
     * `moveKeysByDelta` (D-163), the function the KeyframeTimeline's own
     * box-select-then-drag/nudge gesture commits through. Previously the one
     * op D-169 deliberately left out, on the grounds that its
     * `baseAtSeconds` is captured at a live drag's start and an MCP call has
     * no drag session to capture it from.
     *
     * **What changed, and why this is now honest rather than a guess:** each
     * target's base is READ OFF THE CURRENT MANIFEST when the caller omits
     * it — the same "current position is the only honest base for a one-shot
     * op" rule `motion_move_layers_by_delta` already established for layers,
     * which is exactly the gesture this generalises. An explicit `base_at`
     * is still accepted for a caller replaying a real drag. The correctness
     * trap that made `moveKeysAt` its own primitive (a per-key sequential
     * retime letting an earlier re-sort shift a later `key_index`) is
     * unaffected: bases are resolved BEFORE any write, then one grouped
     * pass runs, exactly as a drag does.
     *
     * Clamping is per-key, never a group veto — a key at a scene edge stops
     * there while the rest move the full delta.
     */
    motion_move_keys_by_delta: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const rawTargets = a?.targets;
      if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
        return { error: 'targets (non-empty array of {scene_index, kind, layer_index?, key_index, base_at?}) required' };
      }
      const delta = Number(arg(a, 'delta_seconds', 'deltaSeconds'));
      if (!Number.isFinite(delta)) return { error: 'delta_seconds (number) required' };

      const targets: KeyMoveTarget[] = [];
      for (let i = 0; i < rawTargets.length; i++) {
        const t = rawTargets[i] as Record<string, unknown>;
        const sceneIndex = Math.round(Number(arg(t, 'scene_index', 'sceneIndex')));
        if (!Number.isFinite(sceneIndex)) return { error: `targets[${i}]: scene_index (integer) required` };
        if (!manifest.scenes[sceneIndex]) return { error: `targets[${i}]: no scene at index ${sceneIndex}` };

        const kind = t?.kind as string;
        if (!KEY_LANES.has(kind)) {
          return { error: `targets[${i}]: kind must be one of: ${[...KEY_LANES].join(', ')}` };
        }
        const keyIndex = Math.round(Number(arg(t, 'key_index', 'keyIndex')));
        if (!Number.isFinite(keyIndex)) return { error: `targets[${i}]: key_index (integer) required` };

        let layerIndex: number | undefined;
        let selection: Selection | null = null;
        if (kind === 'layer' || kind === 'active') {
          layerIndex = Math.round(Number(arg(t, 'layer_index', 'layerIndex')));
          if (!Number.isFinite(layerIndex)) {
            return { error: `targets[${i}]: layer_index (integer) required for kind="${kind}"` };
          }
          selection = { sceneIndex, target: { kind: 'layer', index: layerIndex } };
        }

        const keys = laneKeys(manifest, kind, sceneIndex, selection);
        if (!keys) return { error: `targets[${i}]: scene ${sceneIndex} has no "${kind}" keys` };
        if (keyIndex < 0 || keyIndex >= keys.length) {
          return { error: `targets[${i}]: no "${kind}" key at index ${keyIndex} (${keys.length} key(s) there)` };
        }

        const explicitBase = arg(t, 'base_at', 'baseAt');
        const baseAtSeconds =
          explicitBase === undefined || explicitBase === null ? keys[keyIndex].at : Number(explicitBase);
        if (!Number.isFinite(baseAtSeconds)) return { error: `targets[${i}]: base_at must be a number` };

        targets.push({ sceneIndex, kind: kind as KeyMoveTarget['kind'], layerIndex, keyIndex, baseAtSeconds });
      }

      const next = moveKeysByDelta(manifest, targets, delta);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, targets.length > 1 ? `Move ${targets.length} keyframes` : 'Move keyframe');
      return {
        movedCount: targets.length,
        deltaSeconds: delta,
        targets: targets.map((t) => ({ ...t, newAt: t.baseAtSeconds + delta })),
      };
    },

    /**
     * D-255 — set (or clear, `ease: null`) ONE existing key's easing curve,
     * on any lane that has one: a layer's `transform.keys`, a scene's 2D
     * camera, or its 3D camera. This is D-164's real bezier model — the
     * `EaseCurveEditor` widget's own four control points — reachable in one
     * call instead of a read-modify-resend of the whole array, which was the
     * only route before (and the reason a granular ease edit was the single
     * most awkward thing to do through this surface).
     *
     * `[x1, y1, x2, y2]`, `Easing.bezier`'s control points. `x1`/`x2` outside
     * `[0,1]` are CLAMPED with a warning (B-062 — that function throws on
     * them); `y` outside `[0,1]` is legal and means real overshoot.
     * `active`-lane keys have no ease (a step schedule does not interpolate)
     * and are refused by name rather than silently storing a field nothing
     * reads.
     */
    motion_set_keyframe_ease: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      }

      const lane = (a?.lane as string) ?? 'layer';
      if (lane === 'active') {
        return { error: 'an "active" step schedule does not interpolate, so its keys have no ease' };
      }
      if (lane !== 'layer' && lane !== 'camera' && lane !== 'scene3d-camera') {
        return { error: 'lane must be one of: layer, camera, scene3d-camera' };
      }

      const keyIndex = Math.round(Number(arg(a, 'key_index', 'keyIndex')));
      if (!Number.isFinite(keyIndex)) return { error: 'key_index (integer) required' };

      // `ease: null` CLEARS — distinct from omitting it, which is an error
      // here (there would be nothing to do).
      if (!a || !('ease' in a)) return { error: 'ease ([x1,y1,x2,y2]) required — pass JSON null to clear it' };
      const easeResult = validateEaseArg(a.ease);
      if (isErr(easeResult)) return easeResult;
      const clearing = a.ease === null;

      let resolved: Selection | null = null;
      if (lane === 'layer') {
        const r = resolveLayerTarget(manifest, a, 'set_keyframe_ease');
        if (isErr(r)) return r;
        resolved = r;
      }

      const keys = laneKeys(manifest, lane, sceneIndex, resolved);
      if (!keys) return { error: `scene ${sceneIndex} has no "${lane}" keys` };
      if (keyIndex < 0 || keyIndex >= keys.length) {
        return { error: `no "${lane}" key at index ${keyIndex} (${keys.length} key(s) there)` };
      }

      const apply = <T extends { at: number; ease?: unknown }>(list: T[]): T[] =>
        list.map((k, i) => {
          if (i !== keyIndex) return k;
          const copy = { ...k } as T & { ease?: unknown };
          if (clearing) delete copy.ease;
          else copy.ease = toSchemaEase(easeResult.curve as EaseCurve);
          return copy;
        });

      let next: Manifest;
      if (lane === 'layer' && resolved) {
        next = setLayerTransformKeys(manifest, resolved, apply(layerTransformKeys(manifest, resolved)));
      } else if (lane === 'camera') {
        next = setCamera2d(manifest, sceneIndex, apply(selectedCamera2d(manifest, sceneIndex) ?? []));
      } else {
        next = setCamera3d(manifest, sceneIndex, apply(selectedCamera3d(manifest, sceneIndex) ?? []));
      }
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, clearing ? 'Clear ease' : 'Set ease');
      return {
        sceneIndex,
        lane,
        keyIndex,
        selection: resolved ?? undefined,
        ease: clearing ? null : (easeResult.curve ?? null),
        warning: easeResult.warning,
      };
    },

    /**
     * D-255 — a `layers`/`layerstack` primitive's `active` STEP schedule
     * (`schema.ts`'s `Active = number | {at,i}[]`), via
     * `setLayerActiveSchedule`: which child index is showing, and from when.
     * D-178/B-067 exposed it as its own KeyframeTimeline lane and the
     * Inspector's own schedule editor, with no MCP surface at all.
     *
     * It is a STEP, not an interpolation — `{at: 2, i: 1}` means "from 2s
     * onward, show child 1", holding until the next entry. Hence no `ease`
     * anywhere (see `motion_set_keyframe_ease`). An EMPTY array deletes the
     * field entirely, back to whatever static `active` the layer had.
     */
    motion_set_layer_active_schedule: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'set_layer_active_schedule');
      if (isErr(resolved)) return resolved;

      const rawSchedule = a?.schedule;
      if (!Array.isArray(rawSchedule)) return { error: 'schedule (array of {at, i}) required — [] clears it' };

      const schedule: ActiveKey[] = [];
      for (let i = 0; i < rawSchedule.length; i++) {
        const k = rawSchedule[i] as Record<string, unknown>;
        if (!k || typeof k !== 'object' || typeof k.at !== 'number' || !Number.isFinite(k.at)) {
          return { error: `schedule[${i}] needs a numeric "at" (seconds)` };
        }
        const idx = Math.round(Number(k.i));
        if (!Number.isFinite(idx) || idx < 0) {
          return { error: `schedule[${i}] needs a non-negative integer "i" (the child index to show)` };
        }
        schedule.push({ at: k.at, i: idx });
      }

      const next = setLayerActiveSchedule(manifest, resolved, schedule);
      if (next === manifest) return { error: 'no change — selection did not resolve to an editable layer' };
      cur.commit(next, 'Set active schedule');
      return { selection: resolved, stepCount: schedule.length, cleared: schedule.length === 0 };
    },

    // ---- navigation / persistence / render ----------------------------

    /** move the player to an absolute `frame`, or to `{scene_index, at}`
     *  (seconds within that scene). `frame` wins if both are given.
     *  Out-of-range clamps to `[0, totalFrames-1]` with a warning. */
    motion_seek: (a) => {
      const cur = ctx.api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;
      const player = ctx.player();
      if (!player) return { error: 'player is not mounted yet' };

      const fps = manifestFps(manifest);
      let frame: number;
      if (a?.frame !== undefined && a?.frame !== null) {
        frame = Math.round(Number(a.frame));
        if (!Number.isFinite(frame)) return { error: 'frame must be a finite number' };
      } else {
        const sceneIndexRaw = arg(a, 'scene_index', 'sceneIndex');
        if (sceneIndexRaw === undefined || sceneIndexRaw === null) {
          return { error: 'seek needs either {frame} (absolute) or {scene_index, at} (seconds within a scene)' };
        }
        const sceneIndex = Math.round(Number(sceneIndexRaw));
        if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
        if (!manifest.scenes[sceneIndex]) {
          return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
        }
        const at = Number(a?.at ?? 0);
        if (!Number.isFinite(at)) return { error: 'at (seconds, number) required alongside scene_index' };
        frame = sceneStartFrame(manifest, sceneIndex) + Math.round(at * fps);
      }

      const lastFrame = Math.max(0, totalFrames(manifest) - 1);
      const clamped = Math.min(Math.max(0, frame), lastFrame);
      player.seekTo(clamped);
      return {
        frame: clamped,
        warning: clamped !== frame ? `frame ${frame} was outside [0, ${lastFrame}] — clamped to ${clamped}` : undefined,
      };
    },

    /** force-write the manifest sidecar now — `useMotionManifest().save`, the
     *  action the toolbar's own Save button calls. */
    motion_save_manifest: async () => {
      const cur = ctx.api();
      const guard = requireManifest(cur, 'save');
      if (isErr(guard)) return guard;

      const outcome = await cur.save();
      if (!outcome.ok) return { error: outcome.error ?? 'save failed' };
      return { saved: true, path: outcome.path };
    },

    /** the real Remotion render — `useMotionManifest().render`, which saves
     *  first if dirty then renders ONE VIDEO PER SCENE (D-180). Blocks for
     *  the whole per-scene loop; see `useMotionControl.ts`'s own module doc
     *  comment for the `control.rs` 20s bridge-timeout caveat this does not
     *  paper over. */
    motion_render: async () => {
      const cur = ctx.api();
      const guard = requireManifest(cur, 'render');
      if (isErr(guard)) return guard;

      const outcome = await cur.render();
      if (!outcome.ok || !outcome.result) return { error: outcome.error ?? 'render failed' };
      return {
        results: outcome.result.map((r) => ({
          sceneId: r.sceneId,
          outputPath: r.outputPath,
          stdoutTail: r.stdoutTail,
        })),
      };
    },
  };
}
