/**
 * @apelles/motion — the Motion tab's MCP op registry, as a PURE function.
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
 * Inspector edit uses, so an agent's edit lands on the SAME `@apelles/history`
 * undo stack a human's does (D-140, restated in
 * `docs/notes/mcp-architecture.md`).
 *
 * **Why this file exists at all (D-257).** Before this pass the whole op
 * registry was an object literal declared INSIDE `useMotionControl`'s
 * `useEffect`, closed over React refs — unreachable from a test without
 * rendering the hook, which this package cannot do (its vitest environment
 * is `node`; there is no jsdom, no react-dom, no testing-library here, and
 * adding all three to test a dispatch table would be a heavy new dependency
 * set for a thin listener). That is why the whole D-167→D-170 Motion op
 * surface shipped with **zero** tests. Splitting the registry out as a pure
 * factory makes every op directly callable — `createMotionOps(ctx).motion_
 * add_layer({...})` — against a hand-built context, which is what
 * `motionOps.test.ts` does for all 36 of them, asserting each produces the
 * IDENTICAL manifest the GUI's own `manifestEdit.ts` call produces. Same
 * thin-shell/fat-core direction D-039 already sets for the Rust side.
 *
 * **D-259 took the count 32 → 36**, adding `motion_delete_layer`/
 * `motion_delete_scene`/`motion_duplicate_layer`/`motion_duplicate_scene`
 * alongside the GUI affordances for the same four actions, in one pass.
 * D-257 had deliberately shipped without them because `manifestEdit.ts` had
 * no delete function at all and the layer list had no delete gesture —
 * adding the agent half alone would have broken CLAUDE.md's human-AND-AI
 * rule from the AI side, the mirror image of the `editor_slip_clip` gap
 * `mcp-tool-coverage.md` records.
 *
 * **Two of the four touch `ctx.setSelections`, and no other mutating op
 * does.** A delete is the one kind of change that can leave the live
 * selection pointing at something that no longer exists, or — for a scene —
 * at a DIFFERENT scene that merely inherited its index, which
 * `MotionTab.tsx`'s `resolveSelections` effect cannot detect. So the two
 * delete ops install the corrected selection `manifestEdit.ts` hands them.
 * The two duplicate ops deliberately do NOT: they mirror `motion_add_layer`/
 * `motion_add_scene`, which return a `selection` for the caller to use next
 * without yanking the human's own selection around.
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
  addLayerFromPreset,
  addScene,
  alignSelections,
  canDeleteScene,
  deleteLayer,
  deleteScene,
  distributeSelections,
  duplicateLayer,
  duplicateScene,
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
  setProjectSettings,
  setProjectTheme,
  setProjectThemeDef,
  setSceneField,
  setTransformFieldOnSelections,
  upsertLayerTransformKeyXY,
  PROJECT_SETTINGS_KEYS,
  type ActiveKey,
  type AlignEdge,
  type KeyMoveTarget,
  type ProjectSettingsKey,
} from './manifestEdit';
import { catalogEntries, defaultLayerFor, type PrimitiveUse } from './catalog';
import {
  presetFromLayer,
  presetsForDisplay,
  removePreset,
  upsertPreset,
  type MotionLayerPreset,
} from './layerPresets';
import {
  CAM2D_KEY_FIELDS,
  CAM3D_KEY_FIELDS,
  fieldsForPrimitive,
  LAYER_TRANSFORM_FIELDS,
  LAYER_TRANSFORM_KEY_FIELDS,
  positionFields,
  PROJECT_FIELDS,
  SCENE_FIELDS,
  sizeFields,
} from './propCatalog';
import { clampEaseCurve, resolveEaseCurve, type EaseCurve } from './easeCurve';
// B-242/D-371 — the scene-rename pre-flight. A VALUE import of `editLinks.ts`,
// whose own import of this file's link types is `import type` and therefore
// erased, so this is a one-way edge at runtime, not a cycle.
import { checkSceneRename } from './editLinks';
// D-403 — the validated-fragment plans this registry and the GUI share.
import {
  fragmentRefusal,
  NEW_SCENE_ID_PLACEHOLDER,
  planInsertLayers,
  planSetScene,
  refusalFor,
  type MotionRefusal,
} from './authoring';

export type { MotionRefusal };
import { layerLabel, type Selection } from './LayerList';
import { sceneDurationFrames, sceneStartFrame, totalFrames } from '@apelles/motion-engine/src/engine/build';
import { manifestSchema, type Cam2dKey, type Cam3dKey, type Manifest, type ThemeName, type TransformKey } from '@apelles/motion-engine/src/engine/schema';
import {
  issuesFromZod,
  validateLayers,
  validateManifest,
  validateScene,
} from '@apelles/motion-engine/src/engine/validate';
import { primitiveJsonSchema } from '@apelles/motion-engine/src/engine/jsonSchema';
import { DEFAULT_THEME_NAME, THEMES, THEME_NAMES } from '@apelles/motion-engine/src/design';
import type { ThemeDef } from '@apelles/motion-engine/src/themeDef';
import { buildThemeDef, findNamedTheme, removeTheme, upsertTheme } from './themeLibrary';
import type { LoadState, ReloadOutcome, RenderOptions, RenderOutcome, SaveOutcome } from './useMotionManifest';
import type { MotionRenderStatus } from './renderLoop';

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
  render: (opts?: RenderOptions) => Promise<RenderOutcome>;
  /** B-262 — re-read the manifest sidecar from disk, replacing the in-app
   *  document. Refuses while there are unsaved in-app edits unless `force`. */
  reloadFromDisk: (force?: boolean) => Promise<ReloadOutcome>;
  /** B-202 — where the render is: `idle`/`running`/`error`, how many scenes
   *  are done, and which one failed. The one field on this interface that
   *  exists for a caller who is NOT awaiting `render()` — a multi-scene render
   *  always outlives `control.rs`'s 20s bridge timeout, so the op's own reply
   *  is gone by the time the failure happens and this is the only place it can
   *  be read. Reported by `motion_get_state`. */
  renderStatus: MotionRenderStatus;
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
  /** D-260 — where each scene's render has ended up in the Edit tab, keyed by
   *  scene id, or `undefined` when nothing supplies it (the pre-D-260
   *  behaviour, and what a test that does not care about links passes).
   *
   *  **An injected accessor, not an import**, for the same D-039 layer reason
   *  `onRendered` (D-062) is a prop: answering "which Edit clips does this
   *  scene feed" needs the media pool (`@apelles/bridge`) and the Edit timeline
   *  (`@apelles/editor`), and a tab package must not depend on either. The
   *  composition root owns both and computes this; this package only reads it.
   *  Same one value drives the GUI's per-scene badge and the
   *  `motion_get_edit_links` MCP tool, so the two can never disagree. */
  editLinks?: () => MotionEditLinks;
  /** D-332 — the saved-component library, or `undefined` when nothing supplies
   *  one (the pre-D-332 behaviour, and what a test that does not care about
   *  presets passes; the four preset ops then refuse cleanly rather than
   *  throwing).
   *
   *  **Injected, not imported**, for the same reason `editLinks` is: the
   *  library is disk-backed state reached through Tauri, and `motionOps.ts` is
   *  a pure, React-free, Tauri-free factory that this package's `node` vitest
   *  environment has to be able to call. An import would drag
   *  `@tauri-apps/api/core` into every one of those tests.
   *
   *  `now` is injected for the same reason the render path forbids a
   *  wall-clock read: it makes a preset's `createdAt` a value the caller
   *  supplies, so the op is deterministic and its test does not have to mock
   *  a global. */
  presets?: () => MotionPresetAccess;
  /** D-399 — the saved-theme library, accessed the same way `presets` is. */
  themes?: () => MotionThemeAccess;
  /** D-403 — render still frames of a manifest through the backend
   *  (`chroma_motion_preview_frame`, the Remotion `still` path), or
   *  `undefined` when nothing supplies it (a test that does not preview; the op
   *  then refuses cleanly). Injected for the same reason `presets` is: it is a
   *  Tauri call, and this factory stays Tauri-free. */
  preview?: (req: MotionPreviewRequest) => Promise<MotionPreviewResult>;
}

/** D-399 — the ops layer's window onto the saved-theme library. */
export interface MotionThemeAccess {
  /** the CURRENT library, read fresh per call. */
  list: () => ThemeDef[];
  /** persist a replacement library; `false` when the write failed. */
  commit: (next: readonly ThemeDef[]) => Promise<boolean>;
}

/** D-332 — the ops layer's window onto the saved-component library. */
export interface MotionPresetAccess {
  /** the CURRENT library, read fresh per call — never captured, same rule as
   *  `api()` above. */
  list: () => MotionLayerPreset[];
  /** persist a replacement library; resolves `false` when the write failed,
   *  which the op reports rather than claiming a save that did not happen. */
  commit: (next: readonly MotionLayerPreset[]) => Promise<boolean>;
  /** ISO-8601 timestamp for a newly created preset. */
  now: () => string;
}

/** D-260 — one Edit-tab clip fed by a Motion scene's rendered file. */
export interface MotionEditLinkClip {
  /** index into the open timeline's `tracks` */
  track: number;
  /** index into that track's `clips` */
  clip: number;
  /** the clip's own stable id */
  clipId: string;
  name: string;
}

/** D-260 — a Motion scene's footprint in the Edit tab. */
export interface MotionEditLink {
  /** the pool item id for this scene's rendered file, or `null` when the
   *  render is not (or not yet) in Sources. */
  mediaId: string | null;
  /** the rendered file's absolute path, when it is known — i.e. when the pool
   *  has an item for it. `null` before a scene has ever been rendered. */
  sourcePath: string | null;
  /** every clip on the OPEN timeline reading that file. Empty when the scene
   *  has been rendered and imported but never placed. */
  clips: MotionEditLinkClip[];
  /** B-219 — will a `motion_render` of this scene actually write over
   *  `sourcePath`? `true` when the file is inside the open project, `false`
   *  when it belongs to a DIFFERENT project (the filesystem-copy case, where
   *  D-260's refresh contract is silently void), and `null` when no project
   *  root reached `computeEditLinks` and the question was not asked. See
   *  `editLinks.ts` for why containment is the check. */
  refreshedByRender: boolean | null;
}

/** D-260 — scene id → its Edit-tab footprint. A scene with no entry has never
 *  been rendered into this project's Sources. */
export type MotionEditLinks = Record<string, MotionEditLink>;

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
  // D-257 — `layer-item` (one CARD inside a `layers` primitive, D-182) was
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

/**
 * D-345 — what a project-settings change did to the scenes already rendered.
 *
 * Changing `width`/`height`/`fps` does not invalidate anything in the
 * manifest — it invalidates every FILE already on disk, because each was
 * rendered at the old spec and every Edit-tab clip reading one is now showing
 * the wrong resolution (or the wrong duration, for `fps`). This reports that
 * as a fact and nothing more: it does **not** re-render. A render is the one
 * expensive, explicit action in this tab (`motion_render`, D-180) and is
 * never a side effect of something else.
 *
 * Deliberately the same source and the same two-kinds-of-"no" as
 * `motion_get_edit_links` (D-260): `linkDataAvailable: false` means no link
 * data reached the tab at all (no project open, nothing wired) and is NOT the
 * same answer as "nothing has been rendered yet", which is
 * `linkDataAvailable: true` with `scenes: 0`.
 */
function renderStaleness(
  ctx: MotionOpsContext,
  manifest: Manifest,
  changed: ProjectSettingsKey[],
): Record<string, unknown> {
  const pixelKeys = changed.filter((k) => k !== 'title');
  if (pixelKeys.length === 0) return { stale: false };

  const reason = `${pixelKeys.join('/')} changed — every existing scene render was produced at the old spec; re-run motion_render to catch them up`;
  const links = ctx.editLinks?.();
  if (links === undefined) {
    // Every count is `null`, not `0`/`[]`: "we cannot see the Edit tab from
    // here" must not read as "nothing is rendered".
    return { stale: true, reason, linkDataAvailable: false, scenes: null, clips: null, sceneIds: null };
  }
  // B-219 — a link into a DIFFERENT project is not a render this project has:
  // no file of ours was produced at the old spec, so nothing of ours is stale
  // because of it. Same `refreshedByRender === false` test `motion_get_edit_
  // links` uses, for the same reason — one rule, not two.
  const rendered = manifest.scenes.filter(
    (s) => links[s.id] !== undefined && links[s.id].refreshedByRender !== false,
  );
  const clips = rendered.reduce((n, s) => n + links[s.id].clips.length, 0);
  return {
    stale: rendered.length > 0,
    ...(rendered.length > 0 ? { reason } : {}),
    linkDataAvailable: true,
    scenes: rendered.length,
    clips,
    sceneIds: rendered.map((s) => s.id),
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

/** Thrown by the guarded `commit` (see `createMotionOps`'s `api`) when the
 *  document an op is about to commit would not parse. Caught by `guardOps`;
 *  never escapes an op. */
export class ManifestRefusedError extends Error {
  readonly refusal: MotionRefusal;
  constructor(refusal: MotionRefusal) {
    super(refusal.error);
    this.name = 'ManifestRefusedError';
    this.refusal = refusal;
  }
}

/** Wrap every op so a `ManifestRefusedError` (sync or async) becomes that op's
 *  `{error, issues}` answer instead of an exception. Anything else still
 *  throws, exactly as before (the shell reports it). */
function guardOps(ops: MotionOps): MotionOps {
  const out: MotionOps = {};
  for (const [name, fn] of Object.entries(ops)) {
    out[name] = (args) => {
      const asRefusal = (e: unknown): MotionOpResult => {
        if (e instanceof ManifestRefusedError) return { ...e.refusal };
        throw e;
      };
      try {
        const result = fn(args);
        return result instanceof Promise ? result.catch(asRefusal) : result;
      } catch (e) {
        return asRefusal(e);
      }
    };
  }
  return out;
}

/** D-403 — the most frames one `motion_preview_frame` call tiles into a
 *  contact sheet: enough to read a motion (start, middle, settle) without a
 *  sheet so large each tile is unreadable at the default scale. */
export const MAX_PREVIEW_FRAMES = 12;
/** default and bounds of the preview's render scale (Remotion `--scale`). */
export const DEFAULT_PREVIEW_SCALE = 0.5;
const MIN_PREVIEW_SCALE = 0.1;
const MAX_PREVIEW_SCALE = 1;

/** D-403 — what the op hands the backend for a still render. `frames` are
 *  ABSOLUTE composition frames of `manifest` (the backend stays manifest-shape
 *  agnostic, D-046); `label` names the output file. */
export interface MotionPreviewRequest {
  manifest: Manifest;
  frames: number[];
  scale: number;
  label: string;
}

/** D-403 — the rendered still, or contact sheet when several frames. */
export interface MotionPreviewResult {
  path: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
}

/** Parse a `number | number[]` argument into a finite-number list, or an
 *  error naming the argument. */
function numberList(raw: unknown, name: string): number[] | { error: string } {
  const list = Array.isArray(raw) ? raw : [raw];
  const nums = list.map((v) => Number(v));
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) {
    return { error: `${name} must be a number or a non-empty list of numbers` };
  }
  return nums;
}

/**
 * Build the whole `motion_*` op registry against a live context.
 *
 * Called once by `useMotionControl.ts` (inside its mount effect) and once
 * per test. Every handler reads `ctx.api()` fresh, so a registry built at
 * mount still sees the manifest from the render that just happened.
 */
export function createMotionOps(ctx: MotionOpsContext): MotionOps {
  /**
   * D-403 — every op reads the live API through THIS accessor, never
   * `ctx.api()` directly: it is the real one with `commit` guarded. A commit
   * whose document would not parse under `manifestSchema` throws
   * `ManifestRefusedError` before anything changes, and `guardOps` (below)
   * turns that into the op's `{error, issues}` answer. One guard at the one
   * commit path, so no op can land a document the app would then show as a
   * parse error — the same issue list `motion_validate` reports.
   */
  const api = (): MotionOpsApi => {
    const cur = ctx.api();
    return {
      ...cur,
      commit: (next, label) => {
        const refused = refusalFor(next);
        if (refused) throw new ManifestRefusedError(refused);
        cur.commit(next, label);
      },
    };
  };
  return guardOps({
    // ---- reads --------------------------------------------------------

    /** the live in-editor manifest (parsed, not necessarily saved — the same
     *  value `<MotionPreview>` renders from right now). */
    motion_get_manifest: () => {
      const cur = api();
      return {
        manifest: cur.manifest,
        loadState: cur.loadState,
        parseError: cur.parseError,
        dirty: cur.dirty,
        saveError: cur.saveError,
      };
    },

    /**
     * D-257 — the read half of `motion_select`/`motion_set_selection`, and
     * the Motion analogue of `editor_get_state`. Everything an agent needs
     * to orient itself WITHOUT pulling the whole manifest: what is selected,
     * where the playhead is, and one summary row per scene (its own start
     * frame, duration, layer counts). Selection was previously invisible to
     * everything outside the webview — the exact gap D-216 closed for Edit,
     * and `mcp-tool-coverage.md` explicitly flagged it as still open here.
     *
     * **B-202 — `render`.** A multi-scene `motion_render` always outlives
     * `control.rs`'s 20s bridge timeout, so its own reply is gone long before
     * a mid-loop failure happens; before this pass the failure then existed
     * NOWHERE a caller could reach — not in the reply, not in the app log, and
     * not here, which reported no render status at all. It does now: state,
     * progress, and the failing scene id, on the tab's existing polling read.
     */
    motion_get_state: () => {
      const cur = api();
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
        // D-345 — the document's own name, alongside the other three fields
        // `motion_set_project_settings` writes, so the round trip is readable
        // from the orientation call instead of the whole manifest.
        title: manifest?.title ?? null,
        // D-339 — the document's look. `null` means the manifest carries no
        // `theme` key at all, which renders as `defaultTheme`; the two are
        // reported separately rather than collapsed so an agent can tell
        // "never set" from "explicitly set to the default".
        theme: manifest?.theme ?? null,
        // D-399 — whether the document carries its OWN theme definition
        // (`themeDef`) rather than naming a built-in.
        themeEmbedded: manifest?.themeDef !== undefined,
        defaultTheme: DEFAULT_THEME_NAME,
        // B-202 — the render's own progress, verbatim from `renderLoop.ts`'s
        // `MotionRenderStatus`. The GUI's Render button reads the identical
        // value, so a human and an agent are told the same thing.
        render: cur.renderStatus,
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
     * D-260 — what each scene feeds in the Edit tab: its rendered file's pool
     * item, and every clip on the open timeline reading it.
     *
     * The read half of "auto re-render, auto-replace". An agent about to
     * `motion_render` can see, first, whether anything downstream will be
     * refreshed by it; an agent that has just rendered can confirm what was.
     * The GUI shows the identical fact as a per-scene badge in the layer list,
     * off the identical value (see `MotionOpsContext.editLinks`).
     *
     * `linked: false` on every scene means the composition root supplied no
     * link data at all — no project open, or a build with nothing wired — as
     * distinct from a scene that genuinely has no render yet, which is
     * `rendered: false`. Two different "no", never collapsed into one.
     *
     * **B-219 — `rendered` and `clipCount` are reported against the file a
     * render will actually WRITE, not against whatever carries the stamp.** In
     * a project copied on the filesystem, the inherited pool item points into
     * the ORIGINAL project and no re-render can reach it; this tool used to
     * answer `rendered: true` with the original's path and its clip count,
     * which is the one wrong answer that matters here — its entire job is
     * "what will a re-render refresh?". Such a scene now reads
     * `rendered: false, clipCount: 0` with the whole stale link reported
     * separately as `staleLink`, so the fact is visible rather than
     * flattened away.
     */
    motion_get_edit_links: () => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const links = ctx.editLinks?.();
      let stale = 0;
      const scenes = guard.manifest.scenes.map((scene, index) => {
        const link = links?.[scene.id];
        // `false` only — `null` means the question was not asked (no project
        // root reached the tab), which must not read as "this is stale".
        const unreachable = link !== undefined && link.refreshedByRender === false;
        if (unreachable) stale += 1;
        return {
          index,
          sceneId: scene.id,
          rendered: link !== undefined && !unreachable,
          mediaId: unreachable ? null : (link?.mediaId ?? null),
          sourcePath: unreachable ? null : (link?.sourcePath ?? null),
          refreshedByRender: link?.refreshedByRender ?? null,
          clipCount: unreachable ? 0 : (link?.clips.length ?? 0),
          clips: unreachable ? [] : (link?.clips ?? []),
          // B-219 — what WAS found, when it is not something a render reaches.
          staleLink: unreachable
            ? {
                mediaId: link.mediaId,
                sourcePath: link.sourcePath,
                clipCount: link.clips.length,
                clips: link.clips,
                reason:
                  'this pool item lives in a DIFFERENT project — its file is not the one a motion_render of this scene writes, so a re-render cannot refresh the clips reading it (B-219: a project copied on the filesystem keeps the original project\'s absolute source paths). Re-render this scene to produce this project\'s own file, then editor_swap_clip_media those clips onto it.',
              }
            : null,
        };
      });
      return {
        available: links !== undefined,
        scenes,
        ...(stale > 0
          ? {
              warning: `${stale === 1 ? '1 scene links' : `${stale} scenes link`} to a render belonging to a DIFFERENT project — see each scene's staleLink (B-219)`,
            }
          : {}),
      };
    },

    /**
     * D-257 — every addressable layer in the manifest, flattened, with the
     * exact `{scene_index, target}` each mutating op wants. `motion_get_
     * manifest` already returns all of this buried inside the document; this
     * is the addressing INDEX, so an agent does not have to re-derive
     * "which index is the headline, and does it have an id" by walking the
     * JSON itself. Mirrors what `editor_get_timeline` does for clips.
     */
    motion_list_layers: (a) => {
      const cur = api();
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
     * D-257 — the static reference tool, Motion's answer to
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
        // D-403 — the primitive's whole layer as JSON Schema, generated from
        // the SAME zod object the manifest parses with, so it is the exact
        // contract `motion_insert_layers` / `motion_set_scene` validate
        // against (unknown keys refused: `additionalProperties: false`).
        propsSchema: primitiveJsonSchema(e.use),
      })),
      // D-339 — the theme registry, so `motion_set_project_theme`'s legal
      // values are discoverable from the same one static reference call
      // every other Motion vocabulary comes from.
      themes: [
        ...THEME_NAMES.map((name) => ({
          name,
          source: 'builtin',
          description: THEMES[name].description,
          default: name === DEFAULT_THEME_NAME,
        })),
        ...(ctx.themes?.().list() ?? []).map((t) => ({
          name: t.name,
          source: 'library',
          description: t.description ?? '',
          default: false,
        })),
      ],
      defaultTheme: DEFAULT_THEME_NAME,
      // D-345 — the manifest's own top-level fields, for
      // `motion_set_project_settings`, discoverable from the same one static
      // reference call `sceneFields` is.
      projectFields: PROJECT_FIELDS,
      sceneFields: SCENE_FIELDS,
      layerTransformFields: LAYER_TRANSFORM_FIELDS,
      layerTransformKeyFields: LAYER_TRANSFORM_KEY_FIELDS,
      camera2dKeyFields: CAM2D_KEY_FIELDS,
      camera3dKeyFields: CAM3D_KEY_FIELDS,
    }),

    // ---- scenes -------------------------------------------------------

    /**
     * insert a new 4s scene right after `after_scene_index` (or at the end)
     * — `addScene`, the exact function `LayerList.tsx`'s own "+ Scene"
     * button calls (D-178).
     *
     * B-242/D-371 — `id` names the new scene outright. Before this, the tool
     * had no id parameter at all and the MCP layer drops an unknown argument
     * silently, so a caller that passed one got a random `scene-kl4e06` back
     * with no signal its name had been ignored. Validated through
     * `checkSceneRename` against a HYPOTHETICAL scene appended at the end:
     * the three rules that apply to a new id (non-empty, usable as a
     * filename, not already taken) are exactly that function's first three,
     * and running the real one is what keeps the add path and the rename path
     * from drifting into two different notions of a legal id. Its fourth rule
     * — the Edit-link orphan check — is skipped by passing no link map: there
     * is no scene here yet, so there is no render of it to orphan.
     */
    motion_add_scene: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;

      const raw = arg(a, 'after_scene_index', 'afterSceneIndex');
      let after: number | undefined;
      if (raw !== undefined && raw !== null) {
        after = Math.round(Number(raw));
        if (!Number.isFinite(after)) return { error: 'after_scene_index must be an integer' };
      }

      const rawId = a?.id;
      let id: string | undefined;
      if (rawId !== undefined && rawId !== null) {
        const scenes = [...guard.manifest.scenes, { id: NEW_SCENE_ID_PLACEHOLDER }];
        const check = checkSceneRename(scenes, scenes.length - 1, rawId, undefined);
        if (!check.ok) return { error: check.reason };
        id = check.to;
      }

      const { manifest: next, selection } = addScene(guard.manifest, after, id);
      cur.commit(next, 'Add scene');
      return {
        selection,
        sceneIndex: selection.sceneIndex,
        sceneId: next.scenes[selection.sceneIndex].id,
        sceneCount: next.scenes.length,
      };
    },

    /**
     * D-259 — delete a whole scene (its layers, its camera, its `scene3d`
     * block), `deleteScene`: the exact function the layer panel's own
     * per-scene delete button calls. Refuses the LAST remaining scene
     * (`canDeleteScene` — `schema.ts` declares `scenes.min(1)`, so a
     * zero-scene manifest does not parse at all), which is the same reason
     * the GUI hides its button in that case rather than offering one that
     * would break the document.
     *
     * Every later scene's index shifts down by one, so this ALSO installs
     * the corrected selection (the scene that slid into the deleted index) —
     * `motion_add_scene` deliberately does not touch the selection, but a
     * delete must: `resolveSelection` only checks that SOME scene still
     * exists at a selection's `sceneIndex`, which stays true while silently
     * pointing at a different scene. See `deleteScene`'s own doc comment.
     */
    motion_delete_scene: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      const scene = manifest.scenes[sceneIndex];
      if (!scene) return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      if (!canDeleteScene(manifest)) {
        return {
          error:
            'cannot delete the only remaining scene — a manifest needs at least one (schema: scenes.min(1)). Add another scene first, or clear this one\'s layers instead.',
        };
      }

      const { manifest: next, selection } = deleteScene(manifest, sceneIndex);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, 'Delete scene');
      if (selection) ctx.setSelections([selection]);
      return { deletedSceneIndex: sceneIndex, deletedSceneId: scene.id, sceneCount: next.scenes.length, selection };
    },

    /** D-259 — copy a scene (every layer, the camera, the `scene3d` block)
     *  in directly after itself, `duplicateScene`: the layer panel's own
     *  per-scene duplicate button. The copy gets a fresh scene id and fresh
     *  ids on every layer inside it, so nothing addressed by `id` is
     *  ambiguous afterwards. Every later scene's index shifts by one —
     *  re-read `motion_get_state`. */
    motion_duplicate_scene: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      }

      const { manifest: next, selection } = duplicateScene(manifest, sceneIndex);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, 'Duplicate scene');
      return {
        sourceSceneIndex: sceneIndex,
        selection,
        sceneIndex: selection?.sceneIndex,
        sceneId: selection ? next.scenes[selection.sceneIndex].id : undefined,
        sceneCount: next.scenes.length,
      };
    },

    /**
     * D-339 — set (or clear, `theme: null`) the DOCUMENT's theme, the one
     * manifest-level field anything other than the raw-JSON textarea can
     * write. `setProjectTheme`, the same function the raw editor's own parse
     * would produce from typing the key by hand.
     *
     * `null` DELETES the key rather than writing the default name into it:
     * an absent `theme` and an explicit `"dark-excalidraw"` render
     * identically, and absent is the form every existing project file has,
     * so "put it back the way it was" has to be reachable exactly.
     *
     * A name nothing defines is a hard error listing the legal ones —
     * unlike `motion_set_scene_field`/`motion_set_layer_field`, which warn
     * and write anyway because a hand-authored manifest may legitimately
     * carry a field the Inspector does not know. There is no equivalent here:
     * `manifestSchema` refuses a theme name that is neither a built-in nor the
     * embedded `themeDef`'s own, so writing one would break the document.
     * D-399: a LIBRARY theme's name is legal, and is copied into the document
     * as `themeDef` (see `setProjectThemeDef`).
     */
    motion_set_project_theme: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      if (!a || !('theme' in a)) {
        return { error: 'theme is required (use JSON null to clear it back to the default)' };
      }
      const raw = a.theme;
      const library = ctx.themes?.().list() ?? [];
      let next: Manifest;
      let label: string;
      if (raw === null || raw === undefined) {
        next = setProjectTheme(manifest, undefined);
        label = 'Theme: default';
      } else if (typeof raw === 'string') {
        const found = findNamedTheme(raw, library, manifest.themeDef);
        if (!found) {
          return {
            error: `unknown theme ${JSON.stringify(raw)} — built-in: ${THEME_NAMES.join(', ')}${
              library.length ? `; library: ${library.map((t) => t.name).join(', ')}` : ''
            }. Define one with motion_define_theme.`,
          };
        }
        // A built-in is named; a library theme is COPIED INTO the document
        // (D-399), so the manifest renders the same on a machine without it.
        next =
          found.source === 'builtin'
            ? setProjectTheme(manifest, found.name)
            : found.source === 'library'
              ? setProjectThemeDef(manifest, found.def)
              : manifest;
        label = `Theme: ${raw}`;
      } else {
        return { error: 'theme must be a theme name, or null to clear it' };
      }

      if (next !== manifest) cur.commit(next, label);
      return {
        theme: next.theme ?? null,
        embedded: next.themeDef !== undefined,
        effectiveTheme: next.theme ?? DEFAULT_THEME_NAME,
        defaultTheme: DEFAULT_THEME_NAME,
      };
    },

    /**
     * D-399 (B-268) — list every theme a project can use: the compiled
     * built-ins, the user's saved library, and what THIS document uses (a name,
     * and whether it carries the definition itself). Needs no manifest or
     * project open for the first two, the way `motion_list_primitives` doesn't.
     */
    motion_list_themes: () => {
      const library = ctx.themes?.().list() ?? [];
      const cur = api();
      const manifest = cur.manifest;
      return {
        builtin: THEME_NAMES.map((name) => ({
          name,
          description: THEMES[name].description,
          default: name === DEFAULT_THEME_NAME,
        })),
        library: library.map((t) => ({ name: t.name, description: t.description ?? '', definition: t })),
        project: manifest
          ? {
              theme: manifest.theme ?? null,
              source: manifest.themeDef ? 'embedded' : manifest.theme ? 'builtin' : 'default',
              definition: manifest.themeDef ?? null,
            }
          : null,
        defaultTheme: DEFAULT_THEME_NAME,
      };
    },

    /**
     * D-399 (B-268) — define a theme as DATA and (by default) give it to the
     * document. Built from a `base` (a built-in, library or embedded theme;
     * default the engine default), an optional CSS token file and explicit
     * `theme` fields, in that order, then validated as a whole: nothing partial
     * is ever stored. `to_library` also saves it for other projects; `apply`
     * (default true) embeds it in this document, which is what makes a render of
     * the document deterministic. `apply: false` with `to_library: false` is a
     * dry run that just reports the validated definition.
     */
    motion_define_theme: async (a) => {
      // A theme that is to be applied needs an open project; a library-only or
      // dry-run definition (`apply: false`) does not.
      if (a?.apply !== false && api().loadState === 'no-project') {
        return { error: 'no project open — open one in the Colorist tab' };
      }
      const name = a?.name;
      if (typeof name !== 'string' || name.length === 0) return { error: 'name (the new theme\'s id) is required' };
      const fieldsRaw = a?.theme;
      if (fieldsRaw !== undefined && (fieldsRaw === null || typeof fieldsRaw !== 'object' || Array.isArray(fieldsRaw))) {
        return { error: 'theme must be an object of theme fields (bg, text, fontDisplay, …)' };
      }
      if (a?.tokens_css !== undefined && typeof a.tokens_css !== 'string') {
        return { error: 'tokens_css must be a string of --apelles-theme-* custom properties' };
      }
      if (a?.base !== undefined && typeof a.base !== 'string') return { error: 'base must be a theme name' };

      const cur = api();
      const library = ctx.themes?.().list() ?? [];
      const built = buildThemeDef(
        {
          name,
          base: a?.base as string | undefined,
          fields: fieldsRaw as Record<string, unknown> | undefined,
          tokensCss: a?.tokens_css as string | undefined,
        },
        library,
        cur.manifest?.themeDef,
      );
      if ('error' in built) return { error: built.error };
      const def = built.def;

      const toLibrary = a?.to_library === true;
      const apply = a?.apply !== false;
      if (apply) {
        const guard = requireManifest(cur);
        if (isErr(guard)) return guard;
      }
      if (toLibrary) {
        const access = ctx.themes?.();
        if (!access) return { error: 'the theme library is unavailable in this context' };
        if (!(await access.commit(upsertTheme(access.list(), def)))) {
          return { error: 'could not write the theme library to disk' };
        }
      }
      if (apply) {
        const manifest = requireManifest(api());
        if (!isErr(manifest)) api().commit(setProjectThemeDef(manifest.manifest, def), `Theme: ${def.name}`);
      }
      return { defined: def, savedToLibrary: toLibrary, appliedToProject: apply };
    },

    /** D-399 — remove a theme from the user library. A project that already
     *  embeds it keeps its copy, by design (that is what makes it portable). */
    motion_delete_theme: async (a) => {
      const name = a?.name;
      if (typeof name !== 'string' || name.length === 0) return { error: 'name is required' };
      const access = ctx.themes?.();
      if (!access) return { error: 'the theme library is unavailable in this context' };
      const list = access.list();
      const next = removeTheme(list, name);
      if (next === list) return { error: `no theme named "${name}" in the library` };
      if (!(await access.commit(next))) return { error: 'could not write the theme library to disk' };
      return { deleted: name, remaining: next.length };
    },

    /**
     * D-345 — set the manifest's OWN top-level output spec (`title`,
     * `width`, `height`, `fps`). The Motion twin of the Colorist tab's
     * `set_project_settings`, and the second manifest-level writer here
     * after D-339's theme.
     *
     * **Partial merge, one commit.** `width` and `height` are a pair — a
     * resize sent as two separate calls would pass through a wrong aspect
     * ratio, push two undo entries and answer the staleness question twice.
     * So this takes all four at once and commits once, the same shape
     * `set_project_settings` (Colorist) already uses.
     *
     * Validation lives in `setProjectSettings` (`manifestEdit.ts`), shared
     * with the Inspector's Project section, and is a hard REJECT rather than
     * `motion_set_scene_field`'s warn-and-write: these four are read by
     * Remotion itself, which throws on a non-positive/non-integer dimension
     * and takes the live preview down with it.
     *
     * Reports `renders` — which already-rendered scenes a dimension/fps
     * change just invalidated — and renders nothing itself; see
     * `renderStaleness`.
     */
    motion_set_project_settings: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const patch: Record<string, unknown> = {};
      for (const key of PROJECT_SETTINGS_KEYS) {
        const value = a?.[key];
        if (value !== undefined && value !== null) patch[key] = value;
      }
      if (Object.keys(patch).length === 0) {
        return { error: `pass at least one of ${PROJECT_SETTINGS_KEYS.join(', ')}` };
      }

      // D-346 — `reflow` is not one of `PROJECT_SETTINGS_KEYS`: it is not a
      // field of the document, it is what to DO to the document's layers when
      // the canvas moves under them. Read separately for that reason, and
      // `setProjectSettings` would reject it as an unknown project field.
      const reflow = a?.reflow === true;
      const result = setProjectSettings(manifest, patch, { reflow });
      if (!result.ok) return { error: result.error };
      if (result.changed.length > 0) {
        cur.commit(result.manifest, reflow ? 'Project settings + reflow' : 'Project settings');
      }

      const next = result.manifest;
      return {
        title: next.title,
        width: next.width,
        height: next.height,
        fps: next.fps,
        changed: result.changed,
        reflow: result.reflow
          ? {
              scaleX: result.reflow.factors.sx,
              scaleY: result.reflow.factors.sy,
              scaleUniform: result.reflow.factors.su,
              layersMoved: result.reflow.layersMoved,
              fieldsMoved: result.reflow.fieldsMoved,
            }
          : null,
        renders: renderStaleness(ctx, next, result.changed),
        ...(result.warnings.length > 0 ? { warning: result.warnings.join('; ') } : {}),
      };
    },

    /**
     * set (or delete, `value: null`) one field on the scene itself.
     *
     * **B-242/D-371 — `key: "id"` is a RENAME, and goes through
     * `checkSceneRename` first.** It used to be the one working way to set a
     * scene's name and the only one that said it was wrong: `id` was missing
     * from `SCENE_FIELDS`, so the generic unknown-key warning below fired on
     * the field that names the scene. Both halves are fixed — `id` is a known
     * scene field now, and the write is gated instead of warned about, for
     * the reason `checkSceneRename` states: the id keys the Motion→Edit link
     * and names the rendered file, and nothing in this package can follow
     * either reference. A refusal names the clips it would orphan; `force:
     * true` accepts the broken link deliberately.
     */
    motion_set_scene_field: (a) => {
      const cur = api();
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

      if (key === 'id') {
        const check = checkSceneRename(manifest.scenes, sceneIndex, value, ctx.editLinks?.(), {
          force: a?.force === true,
        });
        if (!check.ok) return { error: check.reason, overridable: check.overridable };
        const renamed = setSceneField(manifest, sceneIndex, key, check.to);
        cur.commit(renamed, `Rename scene to ${check.to}`);
        return { sceneIndex, key, value: check.to, renamedFrom: check.from };
      }

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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
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

      // D-403 — optional `props`, laid over the Catalog default. Validated
      // strictly as the WHOLE merged layer (unknown keys refused), so a typo'd
      // prop is an issue naming it rather than a layer that silently ignores it.
      const rawProps = a?.props;
      let props: Record<string, unknown> | undefined;
      if (rawProps !== undefined && rawProps !== null) {
        if (typeof rawProps !== 'object' || Array.isArray(rawProps)) {
          return { error: 'props must be an object of the primitive\'s fields (see motion_list_primitives)' };
        }
        props = rawProps as Record<string, unknown>;
        if ('use' in props || 'id' in props) {
          return { error: 'props may not set "use" (that is the use argument) or "id" (minted for you)' };
        }
        const merged = { ...defaultLayerFor(use as PrimitiveUse), ...props, use };
        const checked = validateLayers([merged], ['props']);
        if (!checked.ok) return fragmentRefusal('props', checked.issues);
      }

      const { manifest: next, selection } = addLayer(manifest, sceneIndex, use as PrimitiveUse, props);
      if (!selection) {
        // `addLayer` only returns a null selection for an unresolvable scene
        // index — already checked above, so this is a defensive floor.
        return { error: `could not add a "${use}" layer to scene ${sceneIndex}` };
      }
      cur.commit(next, `Add ${use} layer`);
      return { sceneIndex, selection, addedUse: use };
    },

    /**
     * D-403 — a dry run of the manifest schema: `{ok, loads, issues}` for a
     * whole `manifest`, one `scene`, or a list of `layers` (exactly one of
     * the three; none validates the live in-app manifest). `ok` means no issue
     * at all, unknown keys included — what `motion_insert_layers` /
     * `motion_set_scene` require; `loads` means the app would accept it as-is.
     * Each issue is `{path, code, message, expected?, hint?}`, the same list a
     * refused mutating op returns. Mutates nothing.
     */
    motion_validate: (a) => {
      const given = (['manifest', 'scene', 'layers'] as const).filter((k) => a?.[k] !== undefined && a[k] !== null);
      if (given.length > 1) return { error: 'pass at most one of manifest, scene, layers' };
      const which = given[0];
      if (which === 'manifest') return { checked: 'manifest', ...validateManifest(a.manifest) };
      if (which === 'scene') {
        const raw = arg(a, 'scene_index', 'sceneIndex');
        const sceneIndex = raw === undefined || raw === null ? undefined : Math.round(Number(raw));
        return { checked: 'scene', ...validateScene(a.scene, sceneIndex) };
      }
      if (which === 'layers') return { checked: 'layers', ...validateLayers(a.layers) };
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      return { checked: 'live manifest', ...validateManifest(guard.manifest) };
    },

    /**
     * D-403 — insert WHOLE layers (manifest fragments) into one scene in ONE
     * undoable edit, `insertLayers`. Each layer is validated strictly first
     * (unknown keys refused); the resulting document must load. `dry_run`
     * validates and reports what would be inserted without committing.
     */
    motion_insert_layers: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      const rawAt = a?.at;
      let at: number | undefined;
      if (rawAt !== undefined && rawAt !== null) {
        at = Math.round(Number(rawAt));
        if (!Number.isFinite(at)) return { error: 'at must be an integer index into scene.layers' };
      }

      const plan = planInsertLayers(guard.manifest, sceneIndex, a?.layers, at);
      if (!plan.ok) return { error: plan.error, ...(plan.issues.length > 0 ? { issues: plan.issues } : {}) };
      const { selections, count } = plan;
      if (a?.dry_run === true || a?.dryRun === true) return { dryRun: true, ok: true, sceneIndex, count, selections };
      cur.commit(plan.manifest, count === 1 ? 'Insert layer' : `Insert ${count} layers`);
      return { sceneIndex, count, selections };
    },

    /**
     * D-403 — replace one WHOLE scene with a validated scene fragment, or
     * append one (`scene_index` = the scene count), in ONE undoable edit,
     * `replaceScene`. Omitting the fragment's `id` keeps the scene's name; a
     * different `id` is a rename and goes through the same pre-flight as
     * `motion_set_scene_field` (`checkSceneRename`, D-371). `dry_run`
     * validates without committing.
     */
    motion_set_scene: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      const plan = planSetScene(guard.manifest, sceneIndex, a?.scene, ctx.editLinks?.());
      if (!plan.ok) return { error: plan.error, ...(plan.issues.length > 0 ? { issues: plan.issues } : {}) };
      const next = plan.manifest;
      const result = {
        sceneIndex,
        sceneId: next.scenes[sceneIndex].id,
        appended: plan.appended,
        layerCount: next.scenes[sceneIndex].layers?.length ?? 0,
        scene3dChildCount: next.scenes[sceneIndex].scene3d?.children.length ?? 0,
      };
      if (a?.dry_run === true || a?.dryRun === true) return { dryRun: true, ok: true, ...result };
      cur.commit(next, plan.appended ? 'Add scene' : 'Replace scene');
      return result;
    },

    /**
     * D-403 — render still frames of one scene through the real engine (the
     * Remotion `still` path, `chroma_motion_preview_frame`) and return the
     * PNG's path: one frame, or a contact sheet of several, left to right then
     * down. `at_seconds` (seconds within the scene, a number or a list) or
     * `frames` (scene-relative frame numbers); neither ⇒ the scene's midpoint.
     * `manifest`, when given, is previewed INSTEAD of the live document
     * (validated to load first), so an agent can look before it commits; the
     * live document itself may carry unsaved edits — it is what is rendered,
     * never the file on disk.
     */
    motion_preview_frame: async (a) => {
      const cur = api();
      let manifest: Manifest;
      if (a?.manifest !== undefined && a.manifest !== null) {
        const parsed = manifestSchema.safeParse(a.manifest);
        if (!parsed.success) {
          const issues = issuesFromZod(parsed.error, manifestSchema, a.manifest);
          return fragmentRefusal('manifest', issues);
        }
        manifest = parsed.data;
      } else {
        const guard = requireManifest(cur);
        if (isErr(guard)) return guard;
        manifest = guard.manifest;
      }

      const sceneIndex = Math.round(Number(arg(a, 'scene_index', 'sceneIndex')));
      if (!Number.isFinite(sceneIndex)) return { error: 'scene_index (integer) required' };
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})` };
      }
      const fps = manifestFps(manifest);
      const sceneFrames = sceneDurationFrames(manifest, sceneIndex);
      const atSeconds = arg(a, 'at_seconds', 'atSeconds');
      let local: number[];
      if (a?.frames !== undefined && a.frames !== null) {
        if (atSeconds !== undefined && atSeconds !== null) return { error: 'pass at_seconds or frames, not both' };
        const list = numberList(a.frames, 'frames');
        if (isErr(list)) return list;
        local = list.map((f) => Math.round(f));
      } else if (atSeconds !== undefined && atSeconds !== null) {
        const list = numberList(atSeconds, 'at_seconds');
        if (isErr(list)) return list;
        local = list.map((t) => Math.round(t * fps));
      } else {
        local = [Math.floor(sceneFrames / 2)];
      }
      if (local.length > MAX_PREVIEW_FRAMES) {
        return { error: `at most ${MAX_PREVIEW_FRAMES} frames per preview (got ${local.length})` };
      }
      const clamped = local.map((f) => Math.max(0, Math.min(sceneFrames - 1, f)));
      const warning = clamped.some((f, i) => f !== local[i])
        ? `some frames were outside the scene (0..${sceneFrames - 1}) and were clamped`
        : undefined;

      const rawScale = a?.scale;
      const scale =
        rawScale === undefined || rawScale === null
          ? DEFAULT_PREVIEW_SCALE
          : Math.max(MIN_PREVIEW_SCALE, Math.min(MAX_PREVIEW_SCALE, Number(rawScale)));
      if (!Number.isFinite(scale)) return { error: 'scale must be a number in (0, 1]' };

      const preview = ctx.preview;
      if (!preview) return { error: 'frame preview is not available in this build' };
      const start = sceneStartFrame(manifest, sceneIndex);
      const sceneId = manifest.scenes[sceneIndex].id;
      const result = await preview({
        manifest,
        frames: clamped.map((f) => start + f),
        scale,
        label: sceneId,
      });
      return {
        ...result,
        sceneIndex,
        sceneId,
        scale,
        frames: clamped.map((f) => ({ frame: f, seconds: f / fps, absoluteFrame: start + f })),
        previewedUncommitted: a?.manifest !== undefined && a.manifest !== null,
        warning,
      };
    },

    /**
     * D-257 — move a layer WITHIN one scene's `layers[]` (or one scene's
     * `scene3d.children[]`), `reorderLayers`: the exact function
     * `LayerList.tsx`'s drag-to-reorder gesture commits through (D-177).
     * Paint order is array order, so this is how an agent puts one layer in
     * front of another. Reordering ACROSS scenes is not supported (no such
     * function exists — a layer belongs to its scene).
     */
    motion_reorder_layers: (a) => {
      const cur = api();
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

    /**
     * D-259 — remove one layer (or one 3D scene child), `deleteLayer`: the
     * exact function the layer list's own per-row delete button calls.
     * Addressable by `target.id`, which is what makes it safe to plan a
     * multi-delete: an `id` names the same layer no matter how the indices
     * around it shift, while a bare `index` does not (delete index 0 and
     * every other index moves).
     *
     * Installs the selection `deleteLayer` hands back (the layer that slid
     * into the deleted slot, or the parent scene when none are left) for the
     * same reason `motion_delete_scene` does: the thing that WAS selected no
     * longer exists, and leaving the tab with an empty Inspector and no
     * canvas target is a worse answer than the neighbour.
     */
    motion_delete_layer: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'delete_layer');
      if (isErr(resolved)) return resolved;
      const kind = resolved.target.kind;
      const removed = selectedLayer(manifest, resolved);

      const { manifest: next, selection } = deleteLayer(manifest, resolved);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, kind === 'layer' ? 'Delete layer' : 'Delete 3D layer');
      if (selection) ctx.setSelections([selection]);
      return {
        sceneIndex: resolved.sceneIndex,
        kind,
        deletedIndex: 'index' in resolved.target ? resolved.target.index : undefined,
        deletedUse: removed?.use,
        selection,
        remaining:
          kind === 'layer'
            ? (next.scenes[resolved.sceneIndex].layers?.length ?? 0)
            : (next.scenes[resolved.sceneIndex].scene3d?.children.length ?? 0),
      };
    },

    /** D-259 — copy one layer (or 3D scene child) in directly ABOVE itself
     *  in paint order, `duplicateLayer`: the layer list's own per-row
     *  duplicate button. Every field is deep-copied except `id`, which is
     *  freshly generated. Returns the `selection` addressing the copy — hand
     *  it straight to the next call (e.g. `motion_set_layer_position`) to
     *  make the duplicate differ from its original. */
    motion_duplicate_layer: (a) => {
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'duplicate_layer');
      if (isErr(resolved)) return resolved;
      const kind = resolved.target.kind;

      const { manifest: next, selection } = duplicateLayer(manifest, resolved);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, kind === 'layer' ? 'Duplicate layer' : 'Duplicate 3D layer');
      return { sceneIndex: resolved.sceneIndex, kind, selection };
    },

    /** set (or delete, `value: null`) one top-level field on a layer or
     *  scene3d-child — `setLayerField`. */
    motion_set_layer_field: (a) => {
      const cur = api();
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
     * D-257 — set one field across a WHOLE multi-selection in one undo step,
     * `setFieldOnSelections` / `setTransformFieldOnSelections`: the two
     * functions the Inspector's own multi-select form commits through
     * (D-158). `transform=true` writes the nested `layer.transform.<key>`
     * (the generic group every primitive has, D-157) rather than a top-level
     * field. N separate `motion_set_layer_field` calls are NOT equivalent —
     * they would be N undo entries instead of the one a human's edit makes.
     */
    motion_set_field_on_layers: (a) => {
      const cur = api();
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
     * D-257 — one CARD inside a `layers`-primitive layer (D-182/B-068): its
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
      const cur = api();
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
      const cur = api();
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
     * D-257 — set the WHOLE selection array without seeking: the marquee /
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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
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
     * D-257 — one field of a layer's own `transform` WRAPPER
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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
      const guard = requireManifest(cur);
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'move_layer_keyframe');
      if (isErr(resolved)) return resolved;

      const keyIndex = Math.round(Number(arg(a, 'key_index', 'keyIndex')));
      if (!Number.isFinite(keyIndex)) return { error: 'key_index (integer) required' };
      const newAt = Number(arg(a, 'new_at', 'newAt'));
      if (!Number.isFinite(newAt)) return { error: 'new_at (seconds, number) required' };

      // D-257 — `lane` picks which of the layer's TWO key arrays to retime:
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
     * D-257 — remove ONE `transform.keys` row. There is no bespoke delete
     * primitive in `manifestEdit.ts` and this does not invent one: it reads
     * the array, drops the named index, and writes the result back through
     * `setLayerTransformKeys` — the same function the Inspector's own
     * keyframe-list editor commits through when a row is removed, which is
     * also why deleting the LAST key drops the whole `transform.keys` field
     * rather than leaving an empty array (that function's own convention).
     */
    motion_delete_layer_keyframe: (a) => {
      const cur = api();
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
     * D-257 — retime one CAMERA key, `moveCamera2dKeyAt`/`moveCamera3dKeyAt`:
     * the camera's own half of the KeyframeTimeline's drag gesture, which had
     * no MCP surface. Distinct from `motion_set_camera_2d`/`_3d`, which
     * replace the whole array and are the only way to change a key's VALUES;
     * this changes only WHEN one fires, with the same clamp-never-block rule
     * every retime in this package holds.
     */
    motion_move_camera_keyframe: (a) => {
      const cur = api();
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
     * D-257 — nudge MANY keys, across lanes and scenes, by ONE shared delta:
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
      const cur = api();
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
     * D-257 — set (or clear, `ease: null`) ONE existing key's easing curve,
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
      const cur = api();
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
     * D-257 — a `layers`/`layerstack` primitive's `active` STEP schedule
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
      const cur = api();
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
      const cur = api();
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
      const cur = api();
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
    /**
     * D-332 — the saved-component library, read half. Needs no project open
     * and no manifest: the library is user-level state, not project state, so
     * an agent can survey what is available before deciding to open anything.
     * That is why this one does NOT call `requireManifest`.
     */
    motion_list_layer_presets: () => {
      const access = ctx.presets?.();
      if (!access) return { error: 'the saved-component library is unavailable in this context' };
      return {
        presets: presetsForDisplay(access.list()).map((p) => ({
          id: p.id,
          name: p.name,
          use: p.use,
          createdAt: p.createdAt,
          layer: p.layer,
        })),
      };
    },

    /**
     * D-332 — save one existing layer as a named, reusable component. The
     * GUI half is the Inspector's "Save as component" section; both go
     * through `presetFromLayer` so a preset an agent saved and a preset a
     * human saved are the same object.
     */
    motion_save_layer_preset: async (a) => {
      const access = ctx.presets?.();
      if (!access) return { error: 'the saved-component library is unavailable in this context' };

      const cur = api();
      const guard = requireManifest(cur, 'save a preset from');
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const resolved = resolveLayerTarget(manifest, a, 'save_layer_preset');
      if (isErr(resolved)) return resolved;

      const found = selectedLayer(manifest, resolved);
      if (!found) return { error: 'that layer no longer exists' };

      const name = typeof a.name === 'string' ? a.name : '';
      const preset = presetFromLayer(
        name,
        found.use,
        found.raw as Record<string, unknown>,
        access.now(),
      );
      if (!preset) {
        return { error: `cannot save a preset named "${name}" for use="${found.use}" — the name must be non-empty and the primitive must be one the engine knows` };
      }

      const ok = await access.commit(upsertPreset(access.list(), preset));
      if (!ok) return { error: 'could not write the component library to disk' };
      return { preset: { id: preset.id, name: preset.name, use: preset.use, createdAt: preset.createdAt } };
    },

    /**
     * D-332 — insert a saved component into a scene. Placement (2D layer vs
     * `scene3d` child) is decided by the primitive, not by the caller, exactly
     * as `motion_add_layer` does — see `addLayerFromPreset`.
     */
    motion_add_layer_from_preset: (a) => {
      const access = ctx.presets?.();
      if (!access) return { error: 'the saved-component library is unavailable in this context' };

      const cur = api();
      const guard = requireManifest(cur, 'add a layer to');
      if (isErr(guard)) return guard;
      const manifest = guard.manifest;

      const sceneIndex = a.scene_index;
      if (typeof sceneIndex !== 'number' || !Number.isInteger(sceneIndex)) {
        return { error: 'scene_index must be an integer' };
      }
      if (!manifest.scenes[sceneIndex]) {
        return { error: `no scene at index ${sceneIndex} (the manifest has ${manifest.scenes.length})` };
      }

      const presetId = a.preset_id;
      if (typeof presetId !== 'string' || presetId.length === 0) {
        return { error: 'preset_id must be a non-empty string' };
      }
      const preset = access.list().find((p) => p.id === presetId);
      if (!preset) return { error: `no saved component with id "${presetId}"` };

      const { manifest: next, selection } = addLayerFromPreset(manifest, sceneIndex, preset);
      if (next === manifest) return { error: 'no change' };
      cur.commit(next, `Add ${preset.name}`);
      return { sceneIndex, presetId, selection };
    },

    /**
     * D-332 — remove one saved component. Deleting a component does NOT touch
     * layers already inserted from it: the insert is a copy, and nothing links
     * back (see `layerPresets.ts`'s header). So this is safe in a way that
     * deleting a Figma component is not, and needs no cascade warning.
     */
    motion_delete_layer_preset: async (a) => {
      const access = ctx.presets?.();
      if (!access) return { error: 'the saved-component library is unavailable in this context' };

      const presetId = a.preset_id;
      if (typeof presetId !== 'string' || presetId.length === 0) {
        return { error: 'preset_id must be a non-empty string' };
      }
      const list = access.list();
      const next = removePreset(list, presetId);
      if (next === list) return { error: `no saved component with id "${presetId}"` };

      const ok = await access.commit(next);
      if (!ok) return { error: 'could not write the component library to disk' };
      return { deleted: presetId, remaining: next.length };
    },

    /**
     * B-262 — re-read the manifest sidecar from disk. The sidecar is the
     * documented, hand-authorable form of a Motion document, and an agent (or a
     * person) that rewrites it outside the app used to have no way to make the
     * app see it short of switching project away and back. Refuses while the
     * in-app document has unsaved edits (they would be lost) unless `force`.
     */
    motion_reload_manifest: async (a) => {
      const cur = api();
      if (cur.loadState === 'no-project') return { error: 'no project open — open one in the Colorist tab' };
      const outcome = await cur.reloadFromDisk(a?.force === true);
      if (!outcome.ok) return { error: outcome.error ?? 'reload failed' };
      return { reloaded: true, scenes: outcome.scenes, hadSavedManifest: outcome.hadSavedManifest };
    },

    /**
     * Render scenes to video, in the BACKEND (D-398). `scene_ids` renders only
     * those scenes (B-263); `resume` continues the interrupted or failed render
     * from its own manifest snapshot instead of starting a new one (B-265).
     * Awaits the whole job, so a long render outlives the bridge's 20s timeout
     * as before: poll `motion_get_state`'s `render` block.
     */
    motion_render: async (a) => {
      const cur = api();
      const resume = a?.resume === true;
      if (!resume) {
        const guard = requireManifest(cur, 'render');
        if (isErr(guard)) return guard;
      } else if (cur.loadState === 'no-project') {
        return { error: 'no project open — open one in the Colorist tab' };
      }
      let sceneIds: string[] | undefined;
      if (a?.scene_ids !== undefined && a.scene_ids !== null) {
        if (resume) return { error: 'resume continues the interrupted render as it was planned; it cannot also take scene_ids' };
        if (!Array.isArray(a.scene_ids) || !a.scene_ids.every((id) => typeof id === 'string')) {
          return { error: 'scene_ids must be an array of scene id strings' };
        }
        sceneIds = a.scene_ids as string[];
      }

      const outcome = await cur.render({ sceneIds, resume });
      if (!outcome.ok || !outcome.result) return { error: outcome.error ?? 'render failed' };
      return {
        results: outcome.result.map((r) => ({
          sceneId: r.sceneId,
          outputPath: r.outputPath,
          stdoutTail: r.stdoutTail,
        })),
      };
    },
  });
}
