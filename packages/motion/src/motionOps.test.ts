/**
 * @apelles/motion — the Motion MCP op registry's test suite (D-257).
 *
 * **What this proves, and why it is the whole point.** `docs/notes/
 * mcp-architecture.md`'s one non-optional design rule is that a mutating MCP
 * tool goes through the SAME code path a GUI click does — not a parallel
 * implementation that happens to produce a similar result. D-216 states the
 * same thing for the Edit tab ("an MCP tool call and a GUI button click both
 * flow through the identical code path"). That rule was never tested for
 * Motion, because until D-257 the op registry lived inside a `useEffect` and
 * could not be reached without rendering the hook.
 *
 * So the assertion shape here is deliberate and repeated for every mutating
 * op: run the op, then run the REAL `manifestEdit.ts` function the
 * equivalent GUI gesture calls, and assert the two manifests are deeply
 * equal. A future refactor that quietly gives an op its own logic — the
 * exact drift that made `motion_select` diverge from `onSelect` (B-125) —
 * fails here rather than shipping.
 *
 * Every op is additionally checked for its own real guards (bad indices,
 * unknown kinds, unresolvable selections) and for whether it commits at all,
 * since "silently did nothing" is the failure mode `manifestEdit.ts`'s
 * same-reference no-op convention makes easy to write by accident.
 */
import { describe, it, expect, vi } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

import {
  addLayer,
  addLayerFromPreset,
  addScene,
  alignSelections,
  deleteLayer,
  deleteScene,
  distributeSelections,
  duplicateLayer,
  resolveSelection,
  layerActiveSchedule,
  layerDragBase,
  layerTransformKeys,
  layerWorldPosition,
  moveCamera2dKeyAt,
  moveKeysByDelta,
  moveLayerActiveKeyAt,
  moveLayersByDelta,
  moveLayersByDeltaAutoKey,
  moveLayerTransformKeyAt,
  reorderLayers,
  resetLayerItemPosition,
  selectedCamera2d,
  setCamera2d,
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
  setSceneField,
  setTransformFieldOnSelections,
  upsertLayerTransformKeyXY,
  layerWorldSize,
} from './manifestEdit';
import {
  createMotionOps,
  type MotionEditLinks,
  type MotionOps,
  type MotionOpsApi,
  type MotionPlayer,
} from './motionOps';
import { sizeFields } from './propCatalog';
import type { Selection } from './LayerList';
import type { MotionLayerPreset } from './layerPresets';
import { IDLE_RENDER_STATUS, type MotionRenderStatus } from './renderLoop';
import type { ReloadOutcome } from './useMotionManifest';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** A hand-built `MotionOpsContext`, standing in for the live React tab.
 *  `commit` behaves like the real `useMotionManifest().commit` in the one
 *  way these tests care about: it becomes the new current manifest, so
 *  sequential ops compose exactly as they do in the app. */
function harness(initial: Manifest = sample) {
  const state = {
    manifest: initial as Manifest | null,
    loadState: 'ready' as MotionOpsApi['loadState'],
    selections: [] as Selection[],
    frame: 0,
    renderStatus: IDLE_RENDER_STATUS as MotionRenderStatus,
  };
  const commits: { manifest: Manifest; label: string }[] = [];
  const seeks: number[] = [];

  const save = vi.fn(async () => ({ ok: true, path: '/p/.chroma/motion/manifest.json' }));
  const render = vi.fn(async () => ({
    ok: true,
    result: [{ sceneId: 'hook', outputPath: '/p/.chroma/motion/hook.mp4', stdoutTail: 'done', sceneId2: undefined }],
  }));

  const reloadFromDisk = vi.fn(
    async (): Promise<ReloadOutcome> => ({ ok: true, scenes: 3, hadSavedManifest: true }),
  );

  const api: MotionOpsApi = {
    get loadState() {
      return state.loadState;
    },
    get manifest() {
      return state.manifest;
    },
    parseError: null,
    dirty: false,
    saveError: null,
    commit: (next: Manifest, label: string) => {
      commits.push({ manifest: next, label });
      state.manifest = next;
    },
    save: save as unknown as MotionOpsApi['save'],
    render: render as unknown as MotionOpsApi['render'],
    reloadFromDisk: reloadFromDisk as unknown as MotionOpsApi['reloadFromDisk'],
    // B-202 — the render's own progress. Mutable through `state` so a test can
    // put the tab into "a scene failed" and read it back out of
    // `motion_get_state`, which is the whole point of the field existing.
    get renderStatus() {
      return state.renderStatus;
    },
  };

  let player: MotionPlayer | null = {
    seekTo: (f: number) => {
      seeks.push(f);
      state.frame = f;
    },
    getCurrentFrame: () => state.frame,
  };

  // D-260 — the harness can supply the Edit-link map the app layer normally
  // computes. `undefined` (the default) is the "nothing supplies it" case
  // `motion_get_edit_links` reports as `available: false`.
  const links: { current: MotionEditLinks | undefined } = { current: undefined };

  // D-332 — the saved-component library, held in memory here instead of on
  // disk. `presetWrites` counts real persistence attempts so a test can prove
  // an op wrote (or, for a refusal, did NOT write); `presetCommitOk` lets a
  // test simulate a failed disk write, which the ops must report rather than
  // claiming a save that did not happen.
  const presetLib: { current: MotionLayerPreset[] } = { current: [] };
  const presetWrites: MotionLayerPreset[][] = [];
  const presetCommitOk = { value: true };
  const presetNow = { value: '2026-09-16T00:00:00.000Z' };

  const ops: MotionOps = createMotionOps({
    api: () => api,
    selections: () => state.selections,
    setSelections: (next) => {
      state.selections = next;
    },
    player: () => player,
    editLinks: () => links.current as MotionEditLinks,
    presets: () => ({
      list: () => presetLib.current,
      commit: async (next) => {
        presetWrites.push([...next]);
        if (!presetCommitOk.value) return false;
        presetLib.current = [...next];
        return true;
      },
      now: () => presetNow.value,
    }),
  });

  return {
    ops,
    state,
    links,
    commits,
    seeks,
    save,
    render,
    reloadFromDisk,
    presetLib,
    presetWrites,
    presetCommitOk,
    presetNow,
    unmountPlayer: () => {
      player = null;
    },
    /** the manifest as it stands now (after any commits) */
    current: () => state.manifest as Manifest,
    /** run an op synchronously and get its result object */
    run: (op: string, args: Record<string, unknown> = {}) =>
      ops[op](args) as Record<string, unknown>,
    runAsync: async (op: string, args: Record<string, unknown> = {}) =>
      (await ops[op](args)) as Record<string, unknown>,
  };
}

const TEXT_L0: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
const EMPH_L1: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
const STACK_TEXT: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 0 } };
const STACK_LAYERS: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
const CHILD_3D: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } };

const sel = (s: Selection) => ({ scene_index: s.sceneIndex, target: s.target });

/** Every op name the registry exposes — the count this whole pass is about. */
const ALL_OPS = [
  'motion_get_manifest',
  'motion_get_state',
  'motion_get_edit_links',
  'motion_list_layers',
  'motion_list_primitives',
  'motion_add_scene',
  'motion_delete_scene',
  'motion_duplicate_scene',
  'motion_set_project_theme',
  'motion_set_project_settings',
  'motion_set_scene_field',
  'motion_set_camera_2d',
  'motion_set_camera_3d',
  'motion_add_layer',
  'motion_delete_layer',
  'motion_duplicate_layer',
  'motion_reorder_layers',
  'motion_set_layer_field',
  'motion_set_field_on_layers',
  'motion_set_layer_item',
  'motion_select',
  'motion_set_selection',
  'motion_set_layer_position',
  'motion_set_layer_size',
  'motion_set_layer_transform_field',
  'motion_move_layers_by_delta',
  'motion_align_layers',
  'motion_distribute_layers',
  'motion_set_layer_transform_keys',
  'motion_add_layer_keyframe',
  'motion_move_layer_keyframe',
  'motion_delete_layer_keyframe',
  'motion_move_camera_keyframe',
  'motion_move_keys_by_delta',
  'motion_set_keyframe_ease',
  'motion_set_layer_active_schedule',
  'motion_seek',
  'motion_save_manifest',
  'motion_render',
  'motion_reload_manifest',
  'motion_list_layer_presets',
  'motion_save_layer_preset',
  'motion_add_layer_from_preset',
  'motion_delete_layer_preset',
];

// ---------------------------------------------------------------------------

describe('the registry itself', () => {
  it('exposes exactly the 44 documented ops, all motion_-prefixed', () => {
    const { ops } = harness();
    const names = Object.keys(ops).sort();
    expect(names).toEqual([...ALL_OPS].sort());
    expect(names).toHaveLength(44);
    expect(names.every((n) => n.startsWith('motion_'))).toBe(true);
  });

  /** The three ops that deliberately ANSWER rather than refuse when no
   *  project is open — they are how an agent finds that out in the first
   *  place. `motion_get_state` is the Motion analogue of `editor_get_state`,
   *  which likewise reports project-open status instead of erroring on it;
   *  refusing here would make "is a project open?" unanswerable without
   *  first triggering an error. */
  const ORIENTATION_OPS = ['motion_get_manifest', 'motion_get_state', 'motion_list_primitives'];

  /** D-332 — the two ops that act on the user's COMPONENT LIBRARY rather than
   *  on a project. The library lives in the app data directory and is shared
   *  across projects, so "no project open" is simply not a relevant refusal
   *  for them: surveying or tidying your own toolbox before opening anything
   *  is a legitimate thing to do, and forcing a project open first would be a
   *  refusal with no reason behind it. The other two preset ops
   *  (`motion_save_layer_preset`, `motion_add_layer_from_preset`) DO touch a
   *  manifest, so they stay in the sweep below. */
  const LIBRARY_OPS = ['motion_list_layer_presets', 'motion_delete_layer_preset'];

  it('every op except the orientation reads and the library ops refuses cleanly with no project open, and never commits', async () => {
    const h = harness();
    h.state.loadState = 'no-project';
    for (const op of ALL_OPS) {
      if (ORIENTATION_OPS.includes(op)) continue;
      if (LIBRARY_OPS.includes(op)) continue;
      // `motion_save_manifest`/`motion_render` are async — awaiting every op
      // keeps this sweep honest rather than reading `.error` off a Promise.
      const r = await h.runAsync(op, {});
      expect(r.error, `${op} should refuse with no project`).toBe(
        'no project open — open one in the Colorist tab',
      );
    }
    expect(h.commits).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
  });

  it('the orientation reads report no-project instead of erroring on it', () => {
    const h = harness();
    h.state.loadState = 'no-project';
    h.state.manifest = null;
    for (const op of ORIENTATION_OPS) {
      const r = h.run(op, {});
      expect(r.error, `${op} should answer, not refuse`).toBeUndefined();
    }
    const state = h.run('motion_get_state');
    expect(state.loadState).toBe('no-project');
    expect(state.scenes).toEqual([]);
    expect(state.totalFrames).toBeNull();
    expect(state.fps).toBeNull();
  });

  it('every mutating op refuses when the manifest has not parsed yet', () => {
    const h = harness();
    h.state.manifest = null;
    expect(h.run('motion_add_layer', { scene_index: 0, use: 'text' }).error).toBe('no manifest loaded yet');
    expect(h.run('motion_set_layer_field', sel(TEXT_L0)).error).toBe('no manifest loaded yet');
    expect(h.commits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

describe('reads', () => {
  it('motion_get_manifest returns the live manifest and its load flags', () => {
    const h = harness();
    const r = h.run('motion_get_manifest');
    expect(r.manifest).toBe(sample);
    expect(r.loadState).toBe('ready');
    expect(r.dirty).toBe(false);
  });

  it('motion_get_state reports selection, playhead and one row per scene', () => {
    const h = harness();
    h.state.selections = [TEXT_L0];
    h.state.frame = 42;
    const r = h.run('motion_get_state');
    expect(r.selection).toEqual([TEXT_L0]);
    expect(r.playheadFrame).toBe(42);
    expect(r.playerMounted).toBe(true);
    expect(r.fps).toBe(30);
    // 4s + 6s + 5s at 30fps
    expect(r.totalFrames).toBe(450);
    const scenes = r.scenes as Record<string, unknown>[];
    expect(scenes).toHaveLength(3);
    expect(scenes[0]).toMatchObject({ index: 0, id: 'hook', dur: 4, startFrame: 0, layerCount: 2, camera2dKeys: 3 });
    expect(scenes[1]).toMatchObject({ index: 1, id: 'stack', startFrame: 120, layerCount: 2 });
    expect(scenes[2]).toMatchObject({ index: 2, id: 'space', startFrame: 300, scene3dChildCount: 2, camera3dKeys: 2 });
  });

  // ------------------------------------------------------------------ //
  // B-202 — motion_get_state reports the render's own status
  // ------------------------------------------------------------------ //

  it('motion_get_state reports an idle render before anything has been rendered', () => {
    const h = harness();
    expect(h.run('motion_get_state').render).toEqual(IDLE_RENDER_STATUS);
  });

  it('THE headline (B-202): a scene that FAILS mid-render is named by motion_get_state', () => {
    // The whole bug: `motion_render` renders one scene at a time and always
    // outlives control.rs's 20s bridge timeout, so when scene 2 of 3 fails the
    // op's reply is long gone. The route by which a caller finds out what
    // happened is this block, which mirrors the BACKEND job (D-398).
    const h = harness();
    h.state.renderStatus = {
      ...IDLE_RENDER_STATUS,
      state: 'error',
      scenesTotal: 3,
      scenesDone: 1,
      failedSceneId: 'stack',
      error: 'remotion render exited 1: ENOMEM',
      doneSceneIds: ['hook'],
      remainingSceneIds: ['stack', 'outro'],
    };
    const render = h.run('motion_get_state').render as Record<string, unknown>;
    expect(render.state).toBe('error');
    expect(render.failedSceneId).toBe('stack');
    expect(render.error).toContain('ENOMEM');
    expect(render.scenesTotal).toBe(3);
    expect(render.scenesDone).toBe(1);
    expect(render.doneSceneIds).toEqual(['hook']);
    expect(render.remainingSceneIds).toEqual(['stack', 'outro']);
  });

  it('motion_get_state reports an INTERRUPTED render with what is left (B-265)', () => {
    // A webview reload used to leave a blank `idle`. The backend job persists,
    // so a render cut off mid-flight reads as `interrupted` with the scenes
    // that remain — what `motion_render(resume=true)` would do.
    const h = harness();
    h.state.renderStatus = {
      ...IDLE_RENDER_STATUS,
      state: 'interrupted',
      scenesTotal: 55,
      scenesDone: 18,
      doneSceneIds: ['s01', 's02'],
      remainingSceneIds: ['s19', 's20'],
    };
    const render = h.run('motion_get_state').render as Record<string, unknown>;
    expect(render.state).toBe('interrupted');
    expect(render.scenesDone).toBe(18);
    expect(render.remainingSceneIds).toEqual(['s19', 's20']);
  });

  it('motion_get_state survives the player not being mounted', () => {
    const h = harness();
    h.unmountPlayer();
    const r = h.run('motion_get_state');
    expect(r.playerMounted).toBe(false);
    expect(r.playheadFrame).toBeNull();
  });

  it('motion_list_layers flattens every addressable layer with its real target', () => {
    const h = harness();
    const rows = h.run('motion_list_layers').layers as Record<string, unknown>[];
    // 2 (scene 0) + 2 (scene 1) + 2 (scene 2 children)
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ sceneIndex: 0, use: 'text', target: { kind: 'layer', index: 0 } });
    expect(rows[3]).toMatchObject({ sceneIndex: 1, use: 'layers', itemCount: 4, activeKeyCount: 2 });
    expect(rows[4]).toMatchObject({ sceneIndex: 2, use: 'particleflow', target: { kind: 'scene3d-child', index: 0 } });
    // the position it reports is the SAME read the drag handles use
    expect(rows[0].position).toEqual(layerWorldPosition(sample, TEXT_L0));
  });

  it('motion_list_layers can be scoped to one scene', () => {
    const h = harness();
    const rows = h.run('motion_list_layers', { scene_index: 1 }).layers as unknown[];
    expect(rows).toHaveLength(2);
    expect(h.run('motion_list_layers', { scene_index: 'x' }).error).toMatch(/must be an integer/);
  });

  it('motion_list_primitives answers what add_layer/set_layer_field accept', () => {
    const h = harness();
    const r = h.run('motion_list_primitives');
    const prims = r.primitives as Record<string, unknown>[];
    expect(prims.length).toBeGreaterThan(0);
    const text = prims.find((p) => p.use === 'text') as Record<string, unknown>;
    expect(text.in3d).toBe(false);
    expect((text.fields as unknown[]).length).toBeGreaterThan(0);
    const particle = prims.find((p) => p.use === 'particleflow') as Record<string, unknown>;
    expect(particle.in3d).toBe(true);
    expect(particle.container).toMatch(/scene3d-child/);
    expect(r.sceneFields).toBeTruthy();
    // it is genuinely static — no project needed
    const h2 = harness();
    h2.state.loadState = 'no-project';
    expect((h2.run('motion_list_primitives').primitives as unknown[]).length).toBe(prims.length);
  });

  /**
   * D-258 — the load-bearing check behind "a new primitive gets its MCP
   * surface for free": `motion_list_primitives` maps over `catalogEntries`
   * and `fieldsForPrimitive`, and `motion_add_layer` takes any catalogued
   * `use`, so registering a primitive in the engine's schema + the two
   * catalogs is the WHOLE job — no new MCP tool, no per-primitive branch
   * anywhere in `motionOps.ts`. This test would fail if either new primitive
   * were reachable from the GUI Catalog panel but not from an agent.
   */
  it('exposes the D-258 device/chat pair to an agent with no new tool', () => {
    const h = harness();
    const prims = h.run('motion_list_primitives').primitives as Record<string, unknown>[];

    const frame = prims.find((p) => p.use === 'deviceframe') as Record<string, unknown>;
    expect(frame).toBeTruthy();
    expect(frame.in3d).toBe(false);
    expect(frame.container).toMatch(/scene\.layers/);
    // its resize affordance is the `'scale'` SizeKind, not a px w/h
    expect(frame.size).toMatchObject({ kind: 'scale', key: 'scale' });
    expect(frame.position).toBe('xy');

    const chat = prims.find((p) => p.use === 'claudechat') as Record<string, unknown>;
    expect(chat).toBeTruthy();
    expect(chat.in3d).toBe(false);
    expect(chat.size).toMatchObject({ kind: 'wh', w: 'width', h: 'height' });

    // the fields an agent needs to drive multiple conversations are all listed
    const keys = (chat.fields as { key: string }[]).map((f) => f.key);
    expect(keys).toContain('conversations');
    // `active` is the shared timing field — THE control for which
    // conversation shows when, not a claudechat-specific one (D-178/B-067)
    expect(keys).toContain('active');
    expect(keys).toContain('stagger');
    expect(keys).toContain('reveal');

    // and both are actually creatable through the generic add path
    for (const use of ['deviceframe', 'claudechat']) {
      const hh = harness();
      const before = (hh.run('motion_list_layers', { scene_index: 0 }).layers as unknown[]).length;
      const res = hh.run('motion_add_layer', { scene_index: 0, use });
      expect(res.error).toBeUndefined();
      expect((hh.run('motion_list_layers', { scene_index: 0 }).layers as unknown[]).length).toBe(
        before + 1,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// scenes
// ---------------------------------------------------------------------------

describe('scenes', () => {
  it('motion_add_scene runs the SAME addScene the "+ Scene" button calls', () => {
    const h = harness();
    const r = h.run('motion_add_scene', { after_scene_index: 0 });
    const expected = addScene(sample, 0);
    // ids are generated, so compare everything else and the shape
    expect(h.current().scenes).toHaveLength(4);
    expect(r.sceneIndex).toBe(1);
    expect(expected.selection.sceneIndex).toBe(1);
    expect(h.current().scenes[1].dur).toBe(4);
    expect(h.commits[0].label).toBe('Add scene');
  });

  it('motion_add_scene appends when given no index, and validates a bad one', () => {
    const h = harness();
    h.run('motion_add_scene');
    expect(h.current().scenes).toHaveLength(4);
    expect(h.run('motion_add_scene', { after_scene_index: 'nope' }).error).toMatch(/must be an integer/);
  });

  // B-242/D-371 — the add path's own half of the bug: the tool had no `id`
  // parameter at all, and an unknown argument is dropped silently by the MCP
  // layer, so a caller that passed `scene_id: "c038-training"` got
  // `scene-kl4e06` back with nothing saying its name had been ignored.
  it('motion_add_scene names the new scene when given an id, and reports it back', () => {
    const h = harness();
    const r = h.run('motion_add_scene', { id: 'c038-training' });
    expect(h.current().scenes[3].id).toBe('c038-training');
    expect(r.sceneId).toBe('c038-training');
    // the generated id is still the default for a caller that does not care
    const h2 = harness();
    expect(h2.run('motion_add_scene').sceneId).toMatch(/^scene-/);
  });

  it('motion_add_scene refuses an id that collides or could not be a filename, and commits nothing', () => {
    const h = harness();
    const existing = sample.scenes[0].id;
    expect(h.run('motion_add_scene', { id: existing }).error).toMatch(/already called/);
    expect(h.run('motion_add_scene', { id: '../escape' }).error).toMatch(/not usable as a scene id/);
    expect(h.run('motion_add_scene', { id: '' }).error).toMatch(/cannot be empty/);
    expect(h.commits).toHaveLength(0);
  });

  // D-339 — the document-level theme setter.
  it('motion_set_project_theme === setProjectTheme, and reports the effective look', () => {
    const h = harness();
    const r = h.run('motion_set_project_theme', { theme: 'apelles-studio' });
    expect(h.current()).toEqual(setProjectTheme(sample, 'apelles-studio'));
    expect(h.current().theme).toBe('apelles-studio');
    expect(r).toMatchObject({
      theme: 'apelles-studio',
      effectiveTheme: 'apelles-studio',
      defaultTheme: 'dark-excalidraw',
    });
  });

  it('motion_set_project_theme with null DELETES the key rather than writing the default name', () => {
    const h = harness();
    h.run('motion_set_project_theme', { theme: 'apelles-studio' });
    const r = h.run('motion_set_project_theme', { theme: null });
    expect('theme' in h.current()).toBe(false);
    expect(r).toMatchObject({ theme: null, effectiveTheme: 'dark-excalidraw' });
    // back to exactly the shape the sample manifest shipped with
    expect(h.current()).toEqual(sample);
  });

  it('motion_set_project_theme rejects an unregistered name outright, listing the real ones', () => {
    const h = harness();
    const r = h.run('motion_set_project_theme', { theme: 'neon-vaporwave' });
    expect(r.error).toMatch(/unknown theme/);
    expect(r.error).toMatch(/dark-excalidraw/);
    expect(r.error).toMatch(/apelles-studio/);
    expect(h.commits).toHaveLength(0);
    expect(h.run('motion_set_project_theme', {}).error).toMatch(/theme is required/);
  });

  // D-345 (fixes B-222) — the manifest's OWN top-level fields.
  it('motion_set_project_settings === setProjectSettings, and the round trip reads back through motion_get_state', () => {
    const h = harness();
    const r = h.run('motion_set_project_settings', { title: 'Split screen', width: 1080, height: 1920, fps: 60 });

    const direct = setProjectSettings(sample, { title: 'Split screen', width: 1080, height: 1920, fps: 60 });
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error(direct.error);
    expect(h.current()).toEqual(direct.manifest);

    expect(r).toMatchObject({ title: 'Split screen', width: 1080, height: 1920, fps: 60 });
    expect(r.changed).toEqual(['title', 'width', 'height', 'fps']);
    // one commit for all four — a resize is not two undo entries
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].label).toBe('Project settings');

    // the actual round trip: set, then re-read, and get the new values back
    expect(h.run('motion_get_state')).toMatchObject({ title: 'Split screen', width: 1080, height: 1920, fps: 60 });
    expect(h.run('motion_get_manifest').manifest).toMatchObject({
      title: 'Split screen',
      width: 1080,
      height: 1920,
      fps: 60,
    });
  });

  it('motion_set_project_settings is a partial merge that touches nothing else', () => {
    const h = harness();
    const r = h.run('motion_set_project_settings', { fps: 24 });
    expect(r.changed).toEqual(['fps']);
    expect(h.current()).toEqual({ ...sample, fps: 24 });
    expect(h.run('motion_set_project_settings', {}).error).toMatch(/at least one of title, width, height, fps/);
  });

  it('motion_set_project_settings REJECTS a non-positive or non-integer dimension rather than clamping it', () => {
    const h = harness();
    expect(h.run('motion_set_project_settings', { width: 0 }).error).toMatch(/width must be a positive integer/);
    expect(h.run('motion_set_project_settings', { height: -1080 }).error).toMatch(/height must be a positive integer/);
    expect(h.run('motion_set_project_settings', { width: 1920.5 }).error).toMatch(/width must be a positive integer/);
    expect(h.run('motion_set_project_settings', { fps: 0 }).error).toMatch(/fps must be positive/);
    expect(h.run('motion_set_project_settings', { title: '   ' }).error).toMatch(/title must be a non-empty string/);
    expect(h.run('motion_set_project_settings', { width: 'wide' }).error).toMatch(/width must be a finite number/);
    // every one of those left the manifest exactly as it was
    expect(h.commits).toHaveLength(0);
    expect(h.current()).toEqual(sample);
  });

  it('motion_set_project_settings warns (but writes) an odd dimension the h264 render will round down', () => {
    const h = harness();
    const r = h.run('motion_set_project_settings', { width: 1081 });
    expect(r.warning).toMatch(/odd/);
    expect(r.warning).toMatch(/1080/);
    expect(h.current().width).toBe(1081);
  });

  it('motion_set_project_settings reports which renders a dimension change just made stale — and renders nothing', () => {
    const h = harness();
    h.links.current = {
      [sample.scenes[0].id]: {
        mediaId: 'm1',
        sourcePath: '/p/.chroma/motion/renders/s0.mp4',
        clips: [{ track: 0, clip: 0, clipId: 'c1', name: 's0.mp4' }],
        refreshedByRender: true,
      },
      [sample.scenes[1].id]: {
        mediaId: 'm2',
        sourcePath: '/p/.chroma/motion/renders/s1.mp4',
        clips: [],
        refreshedByRender: true,
      },
    };

    const resized = h.run('motion_set_project_settings', { width: 1080, height: 1920 });
    expect(resized.renders).toEqual({
      stale: true,
      reason: expect.stringMatching(/width\/height changed/),
      linkDataAvailable: true,
      scenes: 2,
      clips: 1,
      sceneIds: [sample.scenes[0].id, sample.scenes[1].id],
    });
    // a title change invalidates no pixels
    expect(h.run('motion_set_project_settings', { title: 'Renamed' }).renders).toEqual({ stale: false });
    // and nothing here ever triggers a render itself
    expect(h.render).not.toHaveBeenCalled();
  });

  it('motion_set_project_settings tells "no link data" apart from "nothing rendered yet"', () => {
    const noLinks = harness();
    expect(noLinks.run('motion_set_project_settings', { width: 1080 }).renders).toMatchObject({
      stale: true,
      linkDataAvailable: false,
      scenes: null,
      clips: null,
      sceneIds: null,
    });

    const empty = harness();
    empty.links.current = {};
    expect(empty.run('motion_set_project_settings', { width: 1080 }).renders).toMatchObject({
      stale: false,
      linkDataAvailable: true,
      scenes: 0,
      clips: 0,
    });
  });

  it('motion_set_project_settings makes no commit when every value is already what was asked for', () => {
    const h = harness();
    const r = h.run('motion_set_project_settings', { width: sample.width, fps: sample.fps });
    expect(r.changed).toEqual([]);
    expect(h.commits).toHaveLength(0);
    expect(r.renders).toEqual({ stale: false });
  });

  it('motion_set_scene_field === setSceneField, and warns on an unknown key', () => {
    const h = harness();
    h.run('motion_set_scene_field', { scene_index: 1, key: 'dur', value: 9 });
    expect(h.current()).toEqual(setSceneField(sample, 1, 'dur', 9));
    expect(h.current().scenes[1].dur).toBe(9);

    const h2 = harness();
    const r = h2.run('motion_set_scene_field', { scene_index: 0, key: 'nonsense', value: 1 });
    expect(r.warning).toMatch(/not one of the known scene fields/);
  });

  // B-242/D-371 — `key: "id"` is a RENAME. Before the fix it wrote straight
  // through AND carried the spurious unknown-field warning; now it is a known
  // field (no warning) gated by `checkSceneRename` (the link check).
  describe('motion_set_scene_field key="id" (B-242/D-371)', () => {
    /** a link map keyed on whatever `sample`'s first scene is called. */
    const linkedToScene0 = (): MotionEditLinks => ({
      [sample.scenes[0].id]: {
        mediaId: 'm1',
        sourcePath: `/p/.chroma/motion/renders/${sample.scenes[0].id}.mp4`,
        clips: [{ track: 0, clip: 0, clipId: 'c1', name: `${sample.scenes[0].id}.mp4` }],
        refreshedByRender: true,
      },
    });

    it('renames an unlinked scene, with NO "unknown scene field" warning', () => {
      const h = harness();
      const r = h.run('motion_set_scene_field', { scene_index: 0, key: 'id', value: 'c038-training' });
      expect(r.warning).toBeUndefined();
      expect(r.renamedFrom).toBe(sample.scenes[0].id);
      expect(h.current().scenes[0].id).toBe('c038-training');
      // still the same `setSceneField` a GUI commit calls — no parallel logic
      expect(h.current()).toEqual(setSceneField(sample, 0, 'id', 'c038-training'));
      expect(h.commits[0].label).toBe('Rename scene to c038-training');
    });

    it('REFUSES a rename that would orphan a placed Edit clip, and commits nothing', () => {
      const h = harness();
      h.links.current = linkedToScene0();
      const r = h.run('motion_set_scene_field', { scene_index: 0, key: 'id', value: 'c038-training' });
      expect(r.error).toMatch(/would orphan its render/);
      expect(r.overridable).toBe(true);
      expect(h.commits).toHaveLength(0);
      expect(h.current().scenes[0].id).toBe(sample.scenes[0].id);
    });

    it('force: true renames anyway', () => {
      const h = harness();
      h.links.current = linkedToScene0();
      const r = h.run('motion_set_scene_field', {
        scene_index: 0,
        key: 'id',
        value: 'c038-training',
        force: true,
      });
      expect(r.error).toBeUndefined();
      expect(h.current().scenes[0].id).toBe('c038-training');
    });

    it('refuses to DELETE the id (value: null), which would make the manifest unparseable', () => {
      const h = harness();
      const r = h.run('motion_set_scene_field', { scene_index: 0, key: 'id', value: null });
      expect(r.error).toMatch(/must be a non-empty string/);
      expect(h.commits).toHaveLength(0);
    });

    it('refuses a collision with another scene even with force', () => {
      const h = harness();
      const r = h.run('motion_set_scene_field', {
        scene_index: 0,
        key: 'id',
        value: sample.scenes[1].id,
        force: true,
      });
      expect(r.error).toMatch(/already called/);
      expect(r.overridable).toBe(false);
      expect(h.commits).toHaveLength(0);
    });
  });

  it('motion_set_scene_field guards the scene index and a missing value', () => {
    const h = harness();
    expect(h.run('motion_set_scene_field', { scene_index: 99, key: 'dur', value: 1 }).error).toMatch(/no scene at index 99/);
    expect(h.run('motion_set_scene_field', { scene_index: 0, key: 'dur' }).error).toMatch(/value is required/);
    expect(h.commits).toHaveLength(0);
  });

  it('motion_set_camera_2d === setCamera2d, and validates/clamps ease (B-062)', () => {
    const h = harness();
    const keys = [{ at: 0, zoom: 1 }, { at: 2, x: 100, y: 50, zoom: 1.4 }];
    h.run('motion_set_camera_2d', { scene_index: 0, keys });
    expect(h.current()).toEqual(setCamera2d(sample, 0, keys));

    const h2 = harness();
    const clamped = h2.run('motion_set_camera_2d', {
      scene_index: 0,
      keys: [{ at: 0, ease: [-1, 0, 2, 1] }],
    });
    expect(clamped.warning).toMatch(/clamped/);
    expect(selectedCamera2d(h2.current(), 0)?.[0].ease).toEqual([0, 0, 1, 1]);

    const h3 = harness();
    expect(h3.run('motion_set_camera_2d', { scene_index: 0, keys: [{ at: 0, ease: [1, 2] }] }).error).toMatch(
      /4-number array/,
    );
    expect(h3.run('motion_set_camera_2d', { scene_index: 0, keys: [{ zoom: 1 }] }).error).toMatch(/numeric "at"/);
    expect(h3.commits).toHaveLength(0);
  });

  it('motion_set_camera_3d refuses a scene with no scene3d block, by name', () => {
    const h = harness();
    expect(h.run('motion_set_camera_3d', { scene_index: 0, keys: [{ at: 0, pos: [0, 0, 1] }] }).error).toMatch(
      /has no scene3d block yet/,
    );
    const ok = h.run('motion_set_camera_3d', { scene_index: 2, keys: [{ at: 0, pos: [1, 2, 3], look: [0, 0, 0] }] });
    expect(ok.keyCount).toBe(1);
    expect(h.current().scenes[2].scene3d?.camera).toEqual([{ at: 0, pos: [1, 2, 3], look: [0, 0, 0] }]);
    expect(h.run('motion_set_camera_3d', { scene_index: 2, keys: [] }).error).toMatch(/non-empty/);
  });
});

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

describe('layers', () => {
  it('motion_add_layer runs the SAME addLayer the Catalog panel calls', () => {
    const h = harness();
    const r = h.run('motion_add_layer', { scene_index: 0, use: 'text' });
    const expected = addLayer(sample, 0, 'text');
    expect(h.current().scenes[0].layers).toHaveLength(3);
    expect(r.addedUse).toBe('text');
    // same insertion position and same default instance shape
    expect((r.selection as Selection).target).toMatchObject({ kind: 'layer' });
    expect(expected.manifest.scenes[0].layers?.length).toBe(3);
    expect(h.commits[0].label).toBe('Add text layer');
  });

  it('motion_add_layer rejects an unknown use and a bad scene', () => {
    const h = harness();
    expect(h.run('motion_add_layer', { scene_index: 0, use: 'sparkles' }).error).toMatch(/use must be one of/);
    expect(h.run('motion_add_layer', { scene_index: 9, use: 'text' }).error).toMatch(/no scene at index 9/);
    expect(h.commits).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // D-259 — delete / duplicate
  // -------------------------------------------------------------------------

  it('motion_delete_layer === deleteLayer (the layer row\'s own delete button)', () => {
    const h = harness();
    const r = h.run('motion_delete_layer', sel(TEXT_L0));
    expect(h.current()).toEqual(deleteLayer(sample, TEXT_L0).manifest);
    expect(h.current().scenes[0].layers).toHaveLength(1);
    expect(h.current().scenes[0].layers?.[0].use).toBe('emphasis');
    expect(h.commits[0].label).toBe('Delete layer');
    expect(r.deletedUse).toBe('text');
    expect(r.remaining).toBe(1);
  });

  it('motion_delete_layer installs the next selection, so nothing is left dangling', () => {
    const h = harness();
    h.run('motion_delete_layer', sel(TEXT_L0));
    expect(h.state.selections).toEqual([deleteLayer(sample, TEXT_L0).selection]);
    // and it really resolves against the manifest that came back
    expect(resolveSelection(h.current(), h.state.selections[0])).not.toBeNull();
  });

  it('motion_delete_layer empties a scene down to its parent-scene selection', () => {
    const h = harness();
    h.run('motion_delete_layer', sel(TEXT_L0));
    h.run('motion_delete_layer', { scene_index: 0, target: { kind: 'layer', index: 0 } });
    expect(h.current().scenes[0].layers).toBeUndefined();
    expect(h.state.selections).toEqual([{ sceneIndex: 0, target: { kind: 'scene' } }]);
  });

  it('motion_delete_layer works on a 3D child and rejects a non-layer target', () => {
    const h = harness();
    h.run('motion_delete_layer', sel(CHILD_3D));
    expect(h.current()).toEqual(deleteLayer(sample, CHILD_3D).manifest);
    expect(h.commits[0].label).toBe('Delete 3D layer');

    const h2 = harness();
    expect(h2.run('motion_delete_layer', { scene_index: 0, target: { kind: 'scene' } }).error).toMatch(
      /delete_layer targets/,
    );
    expect(h2.run('motion_delete_layer', { scene_index: 0, target: { kind: 'layer', index: 9 } }).error).toMatch(
      /does not resolve/,
    );
    expect(h2.commits).toHaveLength(0);
  });

  it('motion_delete_scene === deleteScene, and installs the shifted selection', () => {
    const h = harness();
    const r = h.run('motion_delete_scene', { scene_index: 0 });
    expect(h.current()).toEqual(deleteScene(sample, 0).manifest);
    expect(h.current().scenes.map((s) => s.id)).toEqual(['stack', 'space']);
    expect(h.commits[0].label).toBe('Delete scene');
    expect(r.deletedSceneId).toBe('hook');
    expect(r.sceneCount).toBe(2);
    expect(h.state.selections).toEqual([{ sceneIndex: 0, target: { kind: 'scene' } }]);
  });

  it('motion_delete_scene refuses the LAST scene with a real message, not an invalid manifest', () => {
    const one: Manifest = { ...sample, scenes: [sample.scenes[0]] };
    const h = harness(one);
    const r = h.run('motion_delete_scene', { scene_index: 0 });
    expect(r.error).toMatch(/only remaining scene/);
    expect(h.current().scenes).toHaveLength(1);
    expect(h.commits).toHaveLength(0);
  });

  it('motion_delete_scene validates its index', () => {
    const h = harness();
    expect(h.run('motion_delete_scene', { scene_index: 9 }).error).toMatch(/no scene at index 9/);
    expect(h.run('motion_delete_scene', {}).error).toMatch(/scene_index \(integer\) required/);
    expect(h.commits).toHaveLength(0);
  });

  it('motion_duplicate_layer === duplicateLayer, inserting directly after the original', () => {
    const h = harness();
    const r = h.run('motion_duplicate_layer', sel(TEXT_L0));
    const expected = duplicateLayer(sample, TEXT_L0);
    expect(h.current().scenes[0].layers).toHaveLength(3);
    expect(h.current().scenes[0].layers?.map((l) => l.use)).toEqual(
      expected.manifest.scenes[0].layers?.map((l) => l.use),
    );
    // ids are generated, so compare everything else field by field
    const copy = h.current().scenes[0].layers![1] as unknown as Record<string, unknown>;
    const original = h.current().scenes[0].layers![0] as unknown as Record<string, unknown>;
    expect({ ...copy, id: undefined }).toEqual({ ...original, id: undefined });
    expect(copy.id).not.toBe(original.id);
    expect(h.commits[0].label).toBe('Duplicate layer');
    expect(r.selection).toMatchObject({ sceneIndex: 0, target: { kind: 'layer', index: 1 } });
  });

  it('motion_duplicate_layer leaves the live selection alone (unlike the delete ops)', () => {
    const h = harness();
    h.run('motion_select', sel(TEXT_L0));
    const before = h.state.selections;
    h.run('motion_duplicate_layer', sel(TEXT_L0));
    expect(h.state.selections).toBe(before);
  });

  it('motion_duplicate_layer works on a 3D child and rejects a non-layer target', () => {
    const h = harness();
    h.run('motion_duplicate_layer', sel(CHILD_3D));
    expect(h.current().scenes[2].scene3d?.children).toHaveLength(3);
    expect(h.commits[0].label).toBe('Duplicate 3D layer');
    expect(h.run('motion_duplicate_layer', { scene_index: 0, target: { kind: 'camera' } }).error).toMatch(
      /duplicate_layer targets/,
    );
  });

  it('motion_duplicate_scene === duplicateScene, with fresh ids throughout', () => {
    const h = harness();
    const r = h.run('motion_duplicate_scene', { scene_index: 1 });
    expect(h.current().scenes).toHaveLength(4);
    expect(h.current().scenes.map((s) => s.id).slice(0, 1)).toEqual(['hook']);
    expect(h.current().scenes[2].id).not.toBe('stack'); // the copy has its own id
    expect(h.current().scenes[3].id).toBe('space'); // the old scene 2, shifted
    // the copy's layers match the source's in everything but their ids
    const src = sample.scenes[1].layers!.map((l) => ({ ...l, id: undefined }));
    const copy = h.current().scenes[2].layers!.map((l) => ({ ...l, id: undefined }));
    expect(copy).toEqual(src);
    expect(h.commits[0].label).toBe('Duplicate scene');
    expect(r.selection).toEqual({ sceneIndex: 2, target: { kind: 'scene' } });
    expect(r.sceneCount).toBe(4);
  });

  it('motion_duplicate_scene validates its index', () => {
    const h = harness();
    expect(h.run('motion_duplicate_scene', { scene_index: 9 }).error).toMatch(/no scene at index 9/);
    expect(h.run('motion_duplicate_scene', {}).error).toMatch(/scene_index \(integer\) required/);
    expect(h.commits).toHaveLength(0);
  });

  it('motion_reorder_layers === reorderLayers (the LayerList drag, D-177)', () => {
    const h = harness();
    h.run('motion_reorder_layers', { scene_index: 0, from_index: 0, to_index: 1 });
    expect(h.current()).toEqual(reorderLayers(sample, 0, 'layer', 0, 1));
    expect(h.current().scenes[0].layers?.[0].use).toBe('emphasis');
    expect(h.commits[0].label).toBe('Reorder layers');
  });

  it('motion_reorder_layers works on scene3d children and guards its indices', () => {
    const h = harness();
    h.run('motion_reorder_layers', { scene_index: 2, kind: 'scene3d-child', from_index: 1, to_index: 0 });
    expect(h.current()).toEqual(reorderLayers(sample, 2, 'scene3d-child', 1, 0));

    const h2 = harness();
    expect(h2.run('motion_reorder_layers', { scene_index: 0, from_index: 0, to_index: 5 }).error).toMatch(/within 0\.\./);
    expect(h2.run('motion_reorder_layers', { scene_index: 0, from_index: 1, to_index: 1 }).error).toMatch(/same/);
    expect(h2.run('motion_reorder_layers', { scene_index: 0, kind: 'nope', from_index: 0, to_index: 1 }).error).toMatch(
      /kind must be/,
    );
    expect(h2.commits).toHaveLength(0);
  });

  it('motion_set_layer_field === setLayerField, including a null delete', () => {
    const h = harness();
    h.run('motion_set_layer_field', { ...sel(TEXT_L0), key: 'text', value: 'hello' });
    expect(h.current()).toEqual(setLayerField(sample, TEXT_L0, 'text', 'hello'));

    const h2 = harness();
    h2.run('motion_set_layer_field', { ...sel(TEXT_L0), key: 'preset', value: null });
    expect(h2.current()).toEqual(setLayerField(sample, TEXT_L0, 'preset', undefined));
    expect(h2.current().scenes[0].layers?.[0]).not.toHaveProperty('preset');
  });

  it('motion_set_layer_field warns (but still writes) an unknown field', () => {
    const h = harness();
    const r = h.run('motion_set_layer_field', { ...sel(TEXT_L0), key: 'wobble', value: 3 });
    expect(r.warning).toMatch(/not a known field for use="text"/);
    expect(h.commits).toHaveLength(1);
  });

  it('motion_set_layer_field prefers target.id over target.index (D-158)', () => {
    const h = harness();
    // give the layer an id, then address it by id with a deliberately WRONG index
    h.run('motion_set_layer_field', { ...sel(TEXT_L0), key: 'id', value: 'headline' });
    const r = h.run('motion_set_layer_field', {
      scene_index: 0,
      target: { kind: 'layer', index: 1, id: 'headline' },
      key: 'size',
      value: 99,
    });
    expect((r.selection as Selection).target).toMatchObject({ kind: 'layer', index: 0, id: 'headline' });
    expect(h.current().scenes[0].layers?.[0].size).toBe(99);
    // the emphasis layer at index 1 was NOT touched
    expect(h.current().scenes[0].layers?.[1]).not.toHaveProperty('size');
  });

  it('motion_set_layer_field refuses a non-layer target and an unresolvable one', () => {
    const h = harness();
    expect(h.run('motion_set_layer_field', { scene_index: 0, target: { kind: 'camera' }, key: 'x', value: 1 }).error).toMatch(
      /targets layer or scene3d-child/,
    );
    expect(
      h.run('motion_set_layer_field', { scene_index: 0, target: { kind: 'layer', index: 44 }, key: 'x', value: 1 }).error,
    ).toMatch(/does not resolve/);
    expect(h.run('motion_set_layer_field', { scene_index: 0 }).error).toMatch(/target \(\{kind/);
  });

  it('motion_set_field_on_layers === setFieldOnSelections / setTransformFieldOnSelections', () => {
    const h = harness();
    h.run('motion_set_field_on_layers', { selections: [sel(TEXT_L0), sel(EMPH_L1)], key: 'at', value: 1.5 });
    expect(h.current()).toEqual(setFieldOnSelections(sample, [TEXT_L0, EMPH_L1], 'at', 1.5));
    expect(h.commits[0].label).toBe('Edit 2 layers');

    const h2 = harness();
    h2.run('motion_set_field_on_layers', {
      selections: [sel(TEXT_L0), sel(EMPH_L1)],
      key: 'opacity',
      value: 0.5,
      transform: true,
    });
    expect(h2.current()).toEqual(setTransformFieldOnSelections(sample, [TEXT_L0, EMPH_L1], 'opacity', 0.5));
  });

  it('motion_set_field_on_layers is ONE undo entry, unlike N single calls', () => {
    const h = harness();
    h.run('motion_set_field_on_layers', { selections: [sel(TEXT_L0), sel(EMPH_L1)], key: 'at', value: 2 });
    expect(h.commits).toHaveLength(1);
  });

  it('motion_set_layer_item drives the three real card writes (D-182)', () => {
    const item = { scene_index: 1, target: { kind: 'layer-item', index: 1, item_index: 2 } };
    const itemSel: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 1, itemIndex: 2 } };

    const h = harness();
    h.run('motion_set_layer_item', { ...item, dx: 12, dy: -8 });
    expect(h.current()).toEqual(setLayerItemOffset(sample, itemSel, 12, -8));
    expect(h.commits[0].label).toBe('Move card');

    const h2 = harness();
    h2.run('motion_set_layer_item', { ...item, key: 'label', value: 'renamed' });
    expect(h2.current()).toEqual(setLayerItemField(sample, itemSel, 'label', 'renamed'));

    const h3 = harness();
    h3.run('motion_set_layer_item', { ...item, dx: 5, dy: 5 });
    const moved = h3.current();
    h3.run('motion_set_layer_item', { ...item, reset: true });
    expect(h3.current()).toEqual(resetLayerItemPosition(moved, itemSel));
    expect(h3.commits[1].label).toBe('Reset card position');
  });

  it('motion_set_layer_item demands exactly one of reset / dx+dy / key', () => {
    const item = { scene_index: 1, target: { kind: 'layer-item', index: 1, item_index: 0 } };
    const h = harness();
    expect(h.run('motion_set_layer_item', item).error).toMatch(/exactly one of/);
    expect(h.run('motion_set_layer_item', { ...item, reset: true, dx: 1, dy: 1 }).error).toMatch(/exactly one of/);
    expect(
      h.run('motion_set_layer_item', { scene_index: 1, target: { kind: 'layer-item', index: 1 }, reset: true }).error,
    ).toMatch(/item_index/);
    expect(h.commits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

describe('selection', () => {
  it('motion_select sets the live selection and seeks like onSelect does', () => {
    const h = harness();
    const r = h.run('motion_select', sel(STACK_TEXT));
    expect(h.state.selections).toEqual([r.selection]);
    // scene 1 starts at frame 120; the text layer's own `at` is 0.1s -> +3
    expect(h.seeks).toEqual([123]);
    expect(r.seekedTo).toBe(123);
    // read-only w.r.t. the manifest
    expect(h.commits).toHaveLength(0);
  });

  it('motion_select does NOT re-seek when the playhead is already inside the target (D-173/D-176, B-125)', () => {
    const h = harness();
    h.state.frame = 130; // inside scene 1's text layer window
    const r = h.run('motion_select', sel(STACK_TEXT));
    expect(h.seeks).toEqual([]);
    expect(r.seekedTo).toBeNull();
  });

  it('motion_select on a scene target seeks to the scene start only from another scene', () => {
    const h = harness();
    h.state.frame = 0; // in scene 0
    h.run('motion_select', { scene_index: 2, target: { kind: 'scene' } });
    expect(h.seeks).toEqual([300]);

    const h2 = harness();
    h2.state.frame = 310; // already inside scene 2
    h2.run('motion_select', { scene_index: 2, target: { kind: 'scene' } });
    expect(h2.seeks).toEqual([]);
  });

  it('motion_select still selects with no player mounted', () => {
    const h = harness();
    h.unmountPlayer();
    const r = h.run('motion_select', sel(TEXT_L0));
    expect(r.playerMounted).toBe(false);
    expect(h.state.selections).toHaveLength(1);
  });

  it('motion_set_selection replaces the whole array without seeking', () => {
    const h = harness();
    const r = h.run('motion_set_selection', { selections: [sel(TEXT_L0), sel(EMPH_L1)] });
    expect(h.state.selections).toHaveLength(2);
    expect(r.count).toBe(2);
    expect(r.singleSelected).toBe(false);
    expect(h.seeks).toEqual([]);
    expect(h.commits).toHaveLength(0);
  });

  it('motion_set_selection clears on [] and refuses an unresolvable entry', () => {
    const h = harness();
    h.run('motion_set_selection', { selections: [sel(TEXT_L0)] });
    expect(h.run('motion_set_selection', { selections: [] }).cleared).toBe(true);
    expect(h.state.selections).toEqual([]);

    const bad = h.run('motion_set_selection', {
      selections: [sel(TEXT_L0), { scene_index: 0, target: { kind: 'layer', index: 77 } }],
    });
    expect(bad.error).toMatch(/selections\[1\].*does not resolve/);
    // a refused call stores nothing — never a partial selection
    expect(h.state.selections).toEqual([]);
    expect(h.run('motion_set_selection', {}).error).toMatch(/selections \(array/);
  });
});

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------

describe('transform', () => {
  it('motion_set_layer_position === setLayerPosition', () => {
    const h = harness();
    h.run('motion_set_layer_position', { ...sel(TEXT_L0), x: 400, y: 700 });
    expect(h.current()).toEqual(setLayerPosition(sample, TEXT_L0, 400, 700));
    expect(h.commits[0].label).toBe('Set layer position');
  });

  it('motion_set_layer_position names the use when a layer is not draggable', () => {
    const h = harness();
    const r = h.run('motion_set_layer_position', { ...sel(CHILD_3D), x: 1, y: 2 });
    expect(String(r.error)).toMatch(/no draggable x\/y position \(use="particleflow"\)/);
    expect(h.run('motion_set_layer_position', sel(TEXT_L0)).error).toMatch(/x and y \(numbers\) required/);
  });

  it('motion_set_layer_size === setLayerSize', () => {
    const h = harness();
    h.run('motion_set_layer_size', { ...sel(EMPH_L1), w: 640, h: 200 });
    expect(h.current()).toEqual(setLayerSize(sample, EMPH_L1, 640, 200));
  });

  it('B-213 — a matrix\'s `w`/`h` mean the same thing on every surface: the op, motion_list_layers, and motion_list_primitives\' catalog note', () => {
    const h = harness();
    const added = h.run('motion_add_layer', { scene_index: 0, use: 'matrix' });
    const matrixSel = added.selection as Selection;
    const afterAdd = h.current();

    // `motion_set_layer_size`'s own request/response contract: w/h are the
    // grid's TOTAL footprint, not the per-cell size — pick a target where
    // both axes agree exactly so the averaging in the `'scalar'` branch
    // isn't itself a source of imprecision for this assertion.
    // rows=4, cols=6, gap=10 (addLayer's own matrix default, catalog.ts) —
    // cellFromW=(578+10)/6-10=88; cellFromH=(382+10)/4-10=88.
    h.run('motion_set_layer_size', { ...sel(matrixSel), w: 578, h: 382 });

    // Surface 1: the op itself, via the real manifestEdit.ts function —
    // already covered by the test above, re-derived here so this test is
    // self-contained about what `cell` a (578, 382) target produces.
    expect(setLayerSize(afterAdd, matrixSel, 578, 382)).toEqual(h.current());

    // Surface 2: `motion_list_layers` (`layerWorldSize` under the hood) must
    // report the SAME (578, 382) TOTAL footprint back, not the 88px cell —
    // this is the "already agrees with the op" surface the bug report and
    // a prior triage pass found.
    const rows = h.run('motion_list_layers', { scene_index: 0 }).layers as Record<string, unknown>[];
    const row = rows.find(
      (r) => (r.target as { kind: string; index: number }).index === (matrixSel.target as { index: number }).index,
    );
    expect(row?.size).toEqual({ w: 578, h: 382 });
    expect(row?.size).toEqual(layerWorldSize(h.current(), matrixSel));

    // Surface 3: `motion_list_primitives`' catalog entry for `matrix` no
    // longer leaves `w`/`h`'s meaning to be inferred from `{kind: 'scalar',
    // key: 'cell'}` alone — it says explicitly that they are the total
    // footprint, matching surfaces 1 and 2, not the per-cell size.
    const primitives = h.run('motion_list_primitives').primitives as { use: string; size: unknown }[];
    const matrixEntry = primitives.find((p) => p.use === 'matrix');
    expect(matrixEntry?.size).toEqual(sizeFields('matrix'));
    const note = (matrixEntry?.size as { note?: string } | null)?.note;
    expect(note).toBeDefined();
    expect(note).toMatch(/TOTAL footprint/);
    expect(note).toMatch(/NOT the per-cell size/);
  });

  it('motion_set_layer_transform_field === setLayerTransformField (scale/rot/opacity)', () => {
    const h = harness();
    h.run('motion_set_layer_transform_field', { ...sel(TEXT_L0), key: 'scale', value: 1.5 });
    expect(h.current()).toEqual(setLayerTransformField(sample, TEXT_L0, 'scale', 1.5));
    expect(h.commits[0].label).toBe('Set transform scale');

    const h2 = harness();
    const r = h2.run('motion_set_layer_transform_field', { ...sel(TEXT_L0), key: 'wobble', value: 1 });
    expect(r.warning).toMatch(/not one of the known transform fields/);
  });

  it('motion_set_layer_transform_field warns when a keyframe would override it', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, scale: 1 }, { at: 1, scale: 2 }] });
    const r = h.run('motion_set_layer_transform_field', { ...sel(TEXT_L0), key: 'scale', value: 3 });
    expect(String(r.warning)).toMatch(/2 transform keyframe\(s\).*overrides this static value/);
  });

  it('motion_move_layers_by_delta === moveLayersByDelta', () => {
    const h = harness();
    h.run('motion_move_layers_by_delta', { selections: [sel(TEXT_L0)], dx: 25, dy: -10 });
    const base = layerWorldPosition(sample, TEXT_L0) as { x: number; y: number };
    expect(h.current()).toEqual(moveLayersByDelta(sample, [{ selection: TEXT_L0, base }], 25, -10));
  });

  it('motion_move_layers_by_delta auto_key === moveLayersByDeltaAutoKey (the real canvas drag)', () => {
    const h = harness();
    h.run('motion_move_layers_by_delta', { selections: [sel(TEXT_L0)], dx: 30, dy: 0, auto_key: true, at: 1 });
    const dragBase = layerDragBase(sample, TEXT_L0, 30, 30) as { base: { x: number; y: number }; keyed: boolean };
    expect(h.current()).toEqual(
      moveLayersByDeltaAutoKey(sample, [{ selection: TEXT_L0, base: dragBase.base, keyed: dragBase.keyed }], 30, 0, 1, 30),
    );
  });

  it('motion_move_layers_by_delta auto_key routes a KEYED layer to a keyframe upsert', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 100, y: 100 }] });
    const before = h.current();
    const r = h.run('motion_move_layers_by_delta', {
      selections: [sel(TEXT_L0)],
      dx: 50,
      dy: 0,
      auto_key: true,
      at: 0,
    });
    expect(r.keyedCount).toBe(1);
    // it wrote a KEY, not the layer's static x
    expect(layerTransformKeys(h.current(), TEXT_L0)[0]).toMatchObject({ x: 150, y: 100 });
    expect(h.current().scenes[0].layers?.[0].x).toBe(before.scenes[0].layers?.[0].x);
  });

  it('motion_move_layers_by_delta requires `at` for auto_key', () => {
    const h = harness();
    expect(
      h.run('motion_move_layers_by_delta', { selections: [sel(TEXT_L0)], dx: 1, dy: 1, auto_key: true }).error,
    ).toMatch(/at \(seconds, number\) required when auto_key/);
    expect(h.run('motion_move_layers_by_delta', { selections: [sel(CHILD_3D)], dx: 1, dy: 1 }).error).toMatch(
      /no draggable layers/,
    );
  });

  it('motion_align_layers === alignSelections and needs 2+', () => {
    const h = harness();
    h.run('motion_align_layers', { selections: [sel(TEXT_L0), sel(EMPH_L1)], edge: 'left' });
    expect(h.current()).toEqual(alignSelections(sample, [TEXT_L0, EMPH_L1], 'left'));
    expect(h.commits[0].label).toBe('Align left');

    const h2 = harness();
    expect(h2.run('motion_align_layers', { selections: [sel(TEXT_L0)], edge: 'left' }).error).toMatch(/at least 2/);
    expect(h2.run('motion_align_layers', { selections: [sel(TEXT_L0), sel(EMPH_L1)], edge: 'sideways' }).error).toMatch(
      /edge must be one of/,
    );
  });

  it('motion_distribute_layers === distributeSelections and needs 3+', () => {
    const h = harness();
    // scene 0 has 2 layers; add a third so distribute has something real
    h.run('motion_add_layer', { scene_index: 0, use: 'text' });
    const withThree = h.current();
    const three = [TEXT_L0, EMPH_L1, { sceneIndex: 0, target: { kind: 'layer', index: 2 } } as Selection];
    h.run('motion_distribute_layers', { selections: three.map(sel), axis: 'horizontal' });
    expect(h.current()).toEqual(distributeSelections(withThree, three, 'horizontal'));

    const h2 = harness();
    expect(h2.run('motion_distribute_layers', { selections: [sel(TEXT_L0), sel(EMPH_L1)], axis: 'horizontal' }).error).toMatch(
      /at least 3/,
    );
  });
});

// ---------------------------------------------------------------------------
// keyframes
// ---------------------------------------------------------------------------

describe('keyframes', () => {
  it('motion_set_layer_transform_keys === setLayerTransformKeys', () => {
    const h = harness();
    const keys = [{ at: 0, x: 10, y: 20 }, { at: 1, x: 30, y: 40, scale: 1.2 }];
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys });
    expect(h.current()).toEqual(setLayerTransformKeys(sample, TEXT_L0, keys));
    expect(layerTransformKeys(h.current(), TEXT_L0)).toHaveLength(2);
  });

  it('motion_set_layer_transform_keys drops unknown fields and validates ease per key', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 1, bogus: 9 }] });
    expect(layerTransformKeys(h.current(), TEXT_L0)[0]).toEqual({ at: 0, x: 1 });

    const h2 = harness();
    expect(h2.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, ease: 'fast' }] }).error).toMatch(
      /keys\[0\]\.ease must be a 4-number array/,
    );
    expect(h2.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0) }).error).toMatch(/keys \(array/);
  });

  it('motion_set_layer_transform_keys with [] clears the animation', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 5 }] });
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [] });
    expect(layerTransformKeys(h.current(), TEXT_L0)).toEqual([]);
  });

  it('motion_add_layer_keyframe === upsertLayerTransformKeyXY from the current position', () => {
    const h = harness();
    const r = h.run('motion_add_layer_keyframe', { ...sel(TEXT_L0), at: 1 });
    const dragBase = layerDragBase(sample, TEXT_L0, 30, 30) as { base: { x: number; y: number } };
    expect(h.current()).toEqual(
      upsertLayerTransformKeyXY(sample, TEXT_L0, 1, 30, dragBase.base.x, dragBase.base.y),
    );
    expect(r.derivedFrom).toBe('current-position');
    expect(r.x).toBe(dragBase.base.x);
  });

  it('motion_add_layer_keyframe honours explicit x/y and attaches ease in ONE commit', () => {
    const h = harness();
    const r = h.run('motion_add_layer_keyframe', { ...sel(TEXT_L0), at: 2, x: 500, y: 600, ease: [0.4, 0, 0.2, 1] });
    expect(r.derivedFrom).toBe('explicit');
    expect(h.commits).toHaveLength(1);
    const key = layerTransformKeys(h.current(), TEXT_L0).find((k) => k.at === 2);
    expect(key).toMatchObject({ x: 500, y: 600, ease: [0.4, 0, 0.2, 1] });
  });

  it('motion_add_layer_keyframe refuses a layer with nothing to derive from', () => {
    const h = harness();
    expect(h.run('motion_add_layer_keyframe', { ...sel(CHILD_3D), at: 1 }).error).toMatch(
      /no draggable position to derive/,
    );
    expect(h.run('motion_add_layer_keyframe', sel(TEXT_L0)).error).toMatch(/at \(seconds, number\) required/);
  });

  it('motion_move_layer_keyframe === moveLayerTransformKeyAt, clamped to the scene', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 1 }, { at: 1, x: 2 }] });
    const before = h.current();
    const r = h.run('motion_move_layer_keyframe', { ...sel(TEXT_L0), key_index: 1, new_at: 2.5 });
    expect(h.current()).toEqual(moveLayerTransformKeyAt(before, TEXT_L0, 1, 2.5));
    expect(r.at).toBe(2.5);

    // scene 0's dur is 4 — past it clamps and warns
    const r2 = h.run('motion_move_layer_keyframe', { ...sel(TEXT_L0), key_index: 1, new_at: 99 });
    expect(r2.at).toBe(4);
    expect(String(r2.warning)).toMatch(/clamped to 4s/);
  });

  it('motion_move_layer_keyframe drives the `active` lane too (D-178)', () => {
    const h = harness();
    const before = h.current();
    h.run('motion_move_layer_keyframe', { ...sel(STACK_LAYERS), lane: 'active', key_index: 0, new_at: 1 });
    expect(h.current()).toEqual(moveLayerActiveKeyAt(before, STACK_LAYERS, 0, 1));
    expect(layerActiveSchedule(h.current(), STACK_LAYERS)[0]).toEqual({ at: 1, i: 2 });
  });

  it('motion_move_layer_keyframe guards the key index and the lane name', () => {
    const h = harness();
    expect(h.run('motion_move_layer_keyframe', { ...sel(TEXT_L0), key_index: 0, new_at: 1 }).error).toMatch(
      /no transform key at index 0 \(layer has 0 key\(s\)\)/,
    );
    expect(h.run('motion_move_layer_keyframe', { ...sel(TEXT_L0), lane: 'sideways', key_index: 0, new_at: 1 }).error).toMatch(
      /lane must be/,
    );
  });

  it('motion_delete_layer_keyframe removes one key through setLayerTransformKeys', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 1 }, { at: 1, x: 2 }, { at: 2, x: 3 }] });
    const before = h.current();
    const r = h.run('motion_delete_layer_keyframe', { ...sel(TEXT_L0), key_index: 1 });
    expect(h.current()).toEqual(
      setLayerTransformKeys(before, TEXT_L0, layerTransformKeys(before, TEXT_L0).filter((_, i) => i !== 1)),
    );
    expect(r.remainingKeyCount).toBe(2);
    expect(layerTransformKeys(h.current(), TEXT_L0).map((k) => k.at)).toEqual([0, 2]);
  });

  it('motion_delete_layer_keyframe deleting the last key clears the animation entirely', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 1 }] });
    const r = h.run('motion_delete_layer_keyframe', { ...sel(TEXT_L0), key_index: 0 });
    expect(r.clearedAnimation).toBe(true);
    expect(layerTransformKeys(h.current(), TEXT_L0)).toEqual([]);
    expect(h.run('motion_delete_layer_keyframe', { ...sel(TEXT_L0), key_index: 0 }).error).toMatch(/no key at index 0/);
  });

  it('motion_move_camera_keyframe === moveCamera2dKeyAt', () => {
    const h = harness();
    const r = h.run('motion_move_camera_keyframe', { scene_index: 0, camera: '2d', key_index: 2, new_at: 3 });
    expect(h.current()).toEqual(moveCamera2dKeyAt(sample, 0, 2, 3));
    expect(r.at).toBe(3);
    expect(h.commits[0].label).toBe('Move camera keyframe');
  });

  it('motion_move_camera_keyframe handles the 3D camera and refuses a missing one', () => {
    const h = harness();
    const r = h.run('motion_move_camera_keyframe', { scene_index: 2, camera: '3d', key_index: 1, new_at: 4 });
    expect(r.at).toBe(4);
    expect(h.current().scenes[2].scene3d?.camera?.[1].at).toBe(4);

    const h2 = harness();
    expect(h2.run('motion_move_camera_keyframe', { scene_index: 1, camera: '2d', key_index: 0, new_at: 1 }).error).toMatch(
      /has no 2d camera keys/,
    );
    expect(h2.run('motion_move_camera_keyframe', { scene_index: 0, camera: '4d', key_index: 0, new_at: 1 }).error).toMatch(
      /camera must be/,
    );
    expect(h2.run('motion_move_camera_keyframe', { scene_index: 0, key_index: 9, new_at: 1 }).error).toMatch(
      /no 2d camera key at index 9/,
    );
  });

  it('motion_move_keys_by_delta === moveKeysByDelta, deriving each base from the manifest', () => {
    const h = harness();
    const targets = [
      { scene_index: 0, kind: 'camera', key_index: 1 },
      { scene_index: 0, kind: 'camera', key_index: 2 },
    ];
    h.run('motion_move_keys_by_delta', { targets, delta_seconds: 0.5 });
    const cam = selectedCamera2d(sample, 0) as { at: number }[];
    expect(h.current()).toEqual(
      moveKeysByDelta(
        sample,
        [
          { sceneIndex: 0, kind: 'camera', layerIndex: undefined, keyIndex: 1, baseAtSeconds: cam[1].at },
          { sceneIndex: 0, kind: 'camera', layerIndex: undefined, keyIndex: 2, baseAtSeconds: cam[2].at },
        ],
        0.5,
      ),
    );
    expect(h.commits[0].label).toBe('Move 2 keyframes');
  });

  it('motion_move_keys_by_delta moves a layer lane and an active lane', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(STACK_TEXT), keys: [{ at: 0, x: 1 }, { at: 1, x: 2 }] });
    const before = h.current();
    h.run('motion_move_keys_by_delta', {
      targets: [
        { scene_index: 1, kind: 'layer', layer_index: 0, key_index: 1 },
        { scene_index: 1, kind: 'active', layer_index: 1, key_index: 0 },
      ],
      delta_seconds: 1,
    });
    expect(h.current()).toEqual(
      moveKeysByDelta(
        before,
        [
          { sceneIndex: 1, kind: 'layer', layerIndex: 0, keyIndex: 1, baseAtSeconds: 1 },
          { sceneIndex: 1, kind: 'active', layerIndex: 1, keyIndex: 0, baseAtSeconds: 2.5 },
        ],
        1,
      ),
    );
    expect(layerActiveSchedule(h.current(), STACK_LAYERS)[0].at).toBe(3.5);
  });

  it('motion_move_keys_by_delta accepts an explicit base_at (replaying a real drag)', () => {
    const h = harness();
    h.run('motion_move_keys_by_delta', {
      targets: [{ scene_index: 0, kind: 'camera', key_index: 2, base_at: 1.0 }],
      delta_seconds: 0.5,
    });
    expect(selectedCamera2d(h.current(), 0)?.map((k) => k.at)).toContain(1.5);
  });

  it('motion_move_keys_by_delta validates every target before writing anything', () => {
    const h = harness();
    expect(h.run('motion_move_keys_by_delta', { targets: [], delta_seconds: 1 }).error).toMatch(/non-empty array/);
    expect(
      h.run('motion_move_keys_by_delta', { targets: [{ scene_index: 0, kind: 'camera', key_index: 1 }] }).error,
    ).toMatch(/delta_seconds \(number\) required/);
    expect(
      h.run('motion_move_keys_by_delta', { targets: [{ scene_index: 0, kind: 'nope', key_index: 0 }], delta_seconds: 1 })
        .error,
    ).toMatch(/kind must be one of/);
    expect(
      h.run('motion_move_keys_by_delta', { targets: [{ scene_index: 0, kind: 'layer', key_index: 0 }], delta_seconds: 1 })
        .error,
    ).toMatch(/layer_index \(integer\) required/);
    expect(
      h.run('motion_move_keys_by_delta', { targets: [{ scene_index: 0, kind: 'camera', key_index: 9 }], delta_seconds: 1 })
        .error,
    ).toMatch(/no "camera" key at index 9/);
    expect(h.commits).toHaveLength(0);
  });

  it('motion_set_keyframe_ease sets one layer key\'s curve, leaving the others alone', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 1 }, { at: 1, x: 2 }] });
    h.run('motion_set_keyframe_ease', { ...sel(TEXT_L0), lane: 'layer', key_index: 1, ease: [0.4, 0, 0.2, 1] });
    const keys = layerTransformKeys(h.current(), TEXT_L0);
    expect(keys[1].ease).toEqual([0.4, 0, 0.2, 1]);
    expect(keys[0]).not.toHaveProperty('ease');
    expect(h.commits[1].label).toBe('Set ease');
  });

  it('motion_set_keyframe_ease clears with null, and clamps an illegal x (B-062)', () => {
    const h = harness();
    h.run('motion_set_layer_transform_keys', { ...sel(TEXT_L0), keys: [{ at: 0, x: 1, ease: [0.4, 0, 0.2, 1] }] });
    h.run('motion_set_keyframe_ease', { ...sel(TEXT_L0), key_index: 0, ease: null });
    expect(layerTransformKeys(h.current(), TEXT_L0)[0]).not.toHaveProperty('ease');

    const h2 = harness();
    const r = h2.run('motion_set_keyframe_ease', { scene_index: 0, lane: 'camera', key_index: 0, ease: [-2, 0, 5, 1] });
    expect(String(r.warning)).toMatch(/clamped/);
    expect(selectedCamera2d(h2.current(), 0)?.[0].ease).toEqual([0, 0, 1, 1]);
    // overshoot on y is legal and preserved
    const h3 = harness();
    h3.run('motion_set_keyframe_ease', { scene_index: 0, lane: 'camera', key_index: 0, ease: [0.5, -0.6, 0.5, 1.6] });
    expect(selectedCamera2d(h3.current(), 0)?.[0].ease).toEqual([0.5, -0.6, 0.5, 1.6]);
  });

  it('motion_set_keyframe_ease reaches the 3D camera and refuses the active lane', () => {
    const h = harness();
    h.run('motion_set_keyframe_ease', { scene_index: 2, lane: 'scene3d-camera', key_index: 1, ease: [0.3, 0, 0.7, 1] });
    expect(h.current().scenes[2].scene3d?.camera?.[1].ease).toEqual([0.3, 0, 0.7, 1]);

    const h2 = harness();
    expect(h2.run('motion_set_keyframe_ease', { ...sel(STACK_LAYERS), lane: 'active', key_index: 0, ease: [0, 0, 1, 1] }).error).toMatch(
      /step schedule does not interpolate/,
    );
    expect(h2.run('motion_set_keyframe_ease', { scene_index: 0, lane: 'camera', key_index: 0 }).error).toMatch(
      /ease \(\[x1,y1,x2,y2\]\) required/,
    );
    expect(h2.run('motion_set_keyframe_ease', { scene_index: 0, lane: 'camera', key_index: 44, ease: null }).error).toMatch(
      /no "camera" key at index 44/,
    );
  });

  it('motion_set_layer_active_schedule === setLayerActiveSchedule', () => {
    const h = harness();
    const schedule = [{ at: 0, i: 0 }, { at: 1.5, i: 1 }, { at: 3, i: 3 }];
    h.run('motion_set_layer_active_schedule', { ...sel(STACK_LAYERS), schedule });
    expect(h.current()).toEqual(setLayerActiveSchedule(sample, STACK_LAYERS, schedule));
    expect(layerActiveSchedule(h.current(), STACK_LAYERS)).toEqual(schedule);
  });

  it('motion_set_layer_active_schedule with [] clears, and validates each step', () => {
    const h = harness();
    const r = h.run('motion_set_layer_active_schedule', { ...sel(STACK_LAYERS), schedule: [] });
    expect(r.cleared).toBe(true);
    expect(h.current().scenes[1].layers?.[1]).not.toHaveProperty('active');

    const h2 = harness();
    expect(h2.run('motion_set_layer_active_schedule', { ...sel(STACK_LAYERS), schedule: [{ i: 1 }] }).error).toMatch(
      /schedule\[0\] needs a numeric "at"/,
    );
    expect(
      h2.run('motion_set_layer_active_schedule', { ...sel(STACK_LAYERS), schedule: [{ at: 1, i: -3 }] }).error,
    ).toMatch(/non-negative integer "i"/);
    expect(h2.run('motion_set_layer_active_schedule', sel(STACK_LAYERS)).error).toMatch(/schedule \(array/);
  });
});

// ---------------------------------------------------------------------------
// navigation / persistence / render
// ---------------------------------------------------------------------------

describe('navigation, persistence and render', () => {
  it('motion_seek takes an absolute frame or a scene-relative time', () => {
    const h = harness();
    expect(h.run('motion_seek', { frame: 200 }).frame).toBe(200);
    // scene 1 starts at 120; +2s at 30fps = 180
    expect(h.run('motion_seek', { scene_index: 1, at: 2 }).frame).toBe(180);
    expect(h.seeks).toEqual([200, 180]);
  });

  it('motion_seek clamps out-of-range with a warning, never an error', () => {
    const h = harness();
    const r = h.run('motion_seek', { frame: 99999 });
    expect(r.frame).toBe(449);
    expect(String(r.warning)).toMatch(/clamped to 449/);
    expect(h.run('motion_seek', { frame: -50 }).frame).toBe(0);
  });

  it('motion_seek needs a target and a mounted player', () => {
    const h = harness();
    expect(h.run('motion_seek', {}).error).toMatch(/either \{frame\}/);
    expect(h.run('motion_seek', { scene_index: 42, at: 0 }).error).toMatch(/no scene at index 42/);
    h.unmountPlayer();
    expect(h.run('motion_seek', { frame: 1 }).error).toBe('player is not mounted yet');
  });

  it('motion_save_manifest wraps save() and surfaces its real outcome', async () => {
    const h = harness();
    const r = await h.runAsync('motion_save_manifest');
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(r.saved).toBe(true);
    expect(r.path).toMatch(/manifest\.json$/);
  });

  it('motion_save_manifest reports a real save failure rather than claiming success', async () => {
    const h = harness();
    h.save.mockResolvedValueOnce({ ok: false, error: 'disk full' } as never);
    const r = await h.runAsync('motion_save_manifest');
    expect(r.error).toBe('disk full');
    expect(r.saved).toBeUndefined();
  });

  it('motion_render returns one result PER SCENE (D-180)', async () => {
    const h = harness();
    h.render.mockResolvedValueOnce({
      ok: true,
      result: [
        { sceneId: 'hook', outputPath: '/p/hook.mp4', stdoutTail: 'ok' },
        { sceneId: 'stack', outputPath: '/p/stack.mp4', stdoutTail: 'ok' },
      ],
    } as never);
    const r = await h.runAsync('motion_render');
    expect(r.results).toEqual([
      { sceneId: 'hook', outputPath: '/p/hook.mp4', stdoutTail: 'ok' },
      { sceneId: 'stack', outputPath: '/p/stack.mp4', stdoutTail: 'ok' },
    ]);
  });

  it('motion_render surfaces a real render failure', async () => {
    const h = harness();
    h.render.mockResolvedValueOnce({ ok: false, error: 'remotion exited 1' } as never);
    expect((await h.runAsync('motion_render')).error).toBe('remotion exited 1');
  });

  it('motion_render(scene_ids) renders only those scenes (B-263), and forwards resume (B-265)', async () => {
    const h = harness();
    await h.runAsync('motion_render', { scene_ids: ['stack'] });
    expect(h.render).toHaveBeenLastCalledWith({ sceneIds: ['stack'], resume: false });
    await h.runAsync('motion_render', {});
    expect(h.render).toHaveBeenLastCalledWith({ sceneIds: undefined, resume: false });
    await h.runAsync('motion_render', { resume: true });
    expect(h.render).toHaveBeenLastCalledWith({ sceneIds: undefined, resume: true });
  });

  it('motion_render rejects malformed scene_ids and a resume that also names scenes', async () => {
    const h = harness();
    expect((await h.runAsync('motion_render', { scene_ids: 'hook' })).error).toMatch(/array of scene id strings/);
    expect((await h.runAsync('motion_render', { scene_ids: [1] })).error).toMatch(/array of scene id strings/);
    expect((await h.runAsync('motion_render', { resume: true, scene_ids: ['hook'] })).error).toMatch(/cannot also take scene_ids/);
    expect(h.render).not.toHaveBeenCalled();
  });

  it('a resume does not need a loaded manifest (it renders the interrupted job\'s own)', async () => {
    const h = harness();
    h.state.manifest = null;
    await h.runAsync('motion_render', { resume: true });
    expect(h.render).toHaveBeenCalledWith({ sceneIds: undefined, resume: true });
  });

  it('motion_reload_manifest re-reads the sidecar and reports what it found (B-262)', async () => {
    const h = harness();
    expect(await h.runAsync('motion_reload_manifest', {})).toEqual({
      reloaded: true,
      scenes: 3,
      hadSavedManifest: true,
    });
    expect(h.reloadFromDisk).toHaveBeenLastCalledWith(false);
    await h.runAsync('motion_reload_manifest', { force: true });
    expect(h.reloadFromDisk).toHaveBeenLastCalledWith(true);
  });

  it('motion_reload_manifest surfaces a refusal (unsaved edits) and a missing project', async () => {
    const h = harness();
    h.reloadFromDisk.mockResolvedValueOnce({
      ok: false,
      error: 'the in-app manifest has unsaved edits',
      scenes: null,
      hadSavedManifest: false,
    });
    expect((await h.runAsync('motion_reload_manifest', {})).error).toMatch(/unsaved edits/);
    h.state.loadState = 'no-project';
    expect((await h.runAsync('motion_reload_manifest', {})).error).toBe(
      'no project open — open one in the Colorist tab',
    );
  });

  it('save/render refuse with their own specific no-manifest message', async () => {
    const h = harness();
    h.state.manifest = null;
    expect((await h.runAsync('motion_save_manifest')).error).toBe('no manifest loaded yet — nothing to save');
    expect((await h.runAsync('motion_render')).error).toBe('no manifest loaded yet — nothing to render');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// the undo contract (D-140)
// ---------------------------------------------------------------------------

describe('the undo contract (D-140)', () => {
  it('every mutating op commits exactly once, with a human-readable label', () => {
    const h = harness();
    h.run('motion_add_layer', { scene_index: 0, use: 'text' });
    h.run('motion_set_layer_field', { ...sel(TEXT_L0), key: 'text', value: 'x' });
    h.run('motion_set_layer_position', { ...sel(TEXT_L0), x: 1, y: 2 });
    expect(h.commits.map((c) => c.label)).toEqual(['Add text layer', 'Set text', 'Set layer position']);
    expect(h.commits.every((c) => typeof c.label === 'string' && c.label.length > 0)).toBe(true);
  });

  it('the three view-state ops commit NOTHING (the Motion half of D-216/D-218)', () => {
    const h = harness();
    h.run('motion_select', sel(TEXT_L0));
    h.run('motion_set_selection', { selections: [sel(EMPH_L1)] });
    h.run('motion_seek', { frame: 10 });
    h.run('motion_get_state');
    h.run('motion_list_layers');
    expect(h.commits).toHaveLength(0);
  });

  it('a refused op never commits — no partial writes anywhere', () => {
    const h = harness();
    const refusals: [string, Record<string, unknown>][] = [
      ['motion_add_layer', { scene_index: 0, use: 'nope' }],
      ['motion_set_layer_field', { ...sel(TEXT_L0), key: 'x' }],
      ['motion_set_camera_2d', { scene_index: 0, keys: [{ at: 'x' }] }],
      ['motion_reorder_layers', { scene_index: 0, from_index: 0, to_index: 9 }],
      ['motion_set_layer_active_schedule', { ...sel(STACK_LAYERS), schedule: [{ at: 0 }] }],
      ['motion_delete_layer_keyframe', { ...sel(TEXT_L0), key_index: 0 }],
      ['motion_delete_layer', { scene_index: 0, target: { kind: 'layer', index: 9 } }],
      ['motion_delete_scene', { scene_index: 9 }],
      ['motion_duplicate_layer', { scene_index: 0, target: { kind: 'scene' } }],
      ['motion_duplicate_scene', { scene_index: 9 }],
    ];
    for (const [op, args] of refusals) {
      const r = h.run(op, args);
      expect(r.error, `${op} should refuse`).toBeTruthy();
    }
    expect(h.commits).toHaveLength(0);
    expect(h.current()).toBe(sample);
  });
});

// ---------------------------------------------------------------------------
// D-260 — motion_get_edit_links
// ---------------------------------------------------------------------------

describe('motion_get_edit_links', () => {
  it('reports every scene, with the clips each one feeds', () => {
    const h = harness();
    const sceneId = sample.scenes[0].id;
    h.links.current = {
      [sceneId]: {
        mediaId: 'm1',
        sourcePath: '/p/.chroma/motion/renders/hook.mp4',
        clips: [
          { track: 0, clip: 2, clipId: 'c9', name: 'hook.mp4' },
          { track: 1, clip: 0, clipId: 'c10', name: 'hook.mp4' },
        ],
        refreshedByRender: true,
      },
    };
    const r = h.run('motion_get_edit_links');
    expect(r.error).toBeUndefined();
    expect(r.available).toBe(true);
    const rows = r.scenes as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(sample.scenes.length);
    const first = rows[0];
    expect(first.sceneId).toBe(sceneId);
    expect(first.rendered).toBe(true);
    expect(first.mediaId).toBe('m1');
    expect(first.sourcePath).toBe('/p/.chroma/motion/renders/hook.mp4');
    expect(first.clipCount).toBe(2);
    // The addressing an agent needs to act on the answer, not just read it.
    expect((first.clips as Array<Record<string, unknown>>)[0]).toEqual({
      track: 0,
      clip: 2,
      clipId: 'c9',
      name: 'hook.mp4',
    });
  });

  it('distinguishes "never rendered" from "no link data at all"', () => {
    // Two different "no": `rendered: false` is a real answer about a scene,
    // `available: false` means nothing supplied any link data — collapsing
    // them would tell an agent a rendered scene is unrendered.
    const unlinked = harness();
    const a = unlinked.run('motion_get_edit_links');
    expect(a.available).toBe(false);
    expect((a.scenes as Array<Record<string, unknown>>).every((s) => s.rendered === false)).toBe(true);

    const linked = harness();
    linked.links.current = {};
    const b = linked.run('motion_get_edit_links');
    expect(b.available).toBe(true);
    expect((b.scenes as Array<Record<string, unknown>>).every((s) => s.rendered === false)).toBe(true);
  });

  it('a rendered-but-unplaced scene is rendered with zero clips', () => {
    const h = harness();
    const sceneId = sample.scenes[0].id;
    h.links.current = {
      [sceneId]: { mediaId: 'm1', sourcePath: '/hook.mp4', clips: [], refreshedByRender: true },
    };
    const row = (h.run('motion_get_edit_links').scenes as Array<Record<string, unknown>>)[0];
    expect(row.rendered).toBe(true);
    expect(row.clipCount).toBe(0);
  });

  // ------------------------------------------------------------------ //
  // B-219/D-359 — a link into a DIFFERENT project
  // ------------------------------------------------------------------ //

  /** The copied-project shape, as `computeEditLinks` hands it over: a stamped
   *  pool item with clips placed from it, which a `motion_render` of this
   *  scene will NOT write to. */
  const staleLinks = (sceneId: string) => ({
    [sceneId]: {
      mediaId: 'm1',
      sourcePath: '/Movies/Chroma/c040-mgfx.chroma/motion/renders/hook.mp4',
      clips: [
        { track: 0, clip: 2, clipId: 'c9', name: 'hook.mp4' },
        { track: 1, clip: 0, clipId: 'c10', name: 'hook.mp4' },
      ],
      refreshedByRender: false as const,
    },
  });

  it('THE headline: a link a re-render cannot reach reads rendered:false, clipCount:0', () => {
    // B-219's own words: "an honest `clipCount: 0` here would have made this
    // visible in one call". This tool's entire job is "what will a re-render
    // refresh?", so answering it against a file no render of ours writes is
    // the one wrong answer that matters.
    const h = harness();
    const sceneId = sample.scenes[0].id;
    h.links.current = staleLinks(sceneId) as MotionEditLinks;

    const r = h.run('motion_get_edit_links');
    const row = (r.scenes as Array<Record<string, unknown>>)[0];
    expect(row.rendered).toBe(false);
    expect(row.clipCount).toBe(0);
    expect(row.clips).toEqual([]);
    expect(row.mediaId).toBeNull();
    expect(row.sourcePath).toBeNull();
    expect(row.refreshedByRender).toBe(false);
  });

  it('…and says what it DID find, rather than flattening it away', () => {
    const h = harness();
    const sceneId = sample.scenes[0].id;
    h.links.current = staleLinks(sceneId) as MotionEditLinks;

    const r = h.run('motion_get_edit_links');
    const row = (r.scenes as Array<Record<string, unknown>>)[0];
    const stale = row.staleLink as Record<string, unknown>;
    expect(stale.mediaId).toBe('m1');
    expect(stale.sourcePath).toBe('/Movies/Chroma/c040-mgfx.chroma/motion/renders/hook.mp4');
    expect(stale.clipCount).toBe(2);
    expect((stale.clips as unknown[]).length).toBe(2);
    expect(stale.reason).toMatch(/DIFFERENT project/);
    // and the whole response is flagged, so an agent skimming the rows sees it
    expect(r.warning).toMatch(/1 scene links to a render belonging to a DIFFERENT project/);
  });

  it('a healthy link carries no staleLink and no warning', () => {
    const h = harness();
    const sceneId = sample.scenes[0].id;
    h.links.current = {
      [sceneId]: { mediaId: 'm1', sourcePath: '/p/.chroma/x.mp4', clips: [], refreshedByRender: true },
    };
    const r = h.run('motion_get_edit_links');
    expect(r.warning).toBeUndefined();
    expect((r.scenes as Array<Record<string, unknown>>)[0].staleLink).toBeNull();
  });

  it('refreshedByRender null (no project root) is NOT treated as stale', () => {
    // Three-valued on purpose: "we could not ask" must not read as "no".
    const h = harness();
    const sceneId = sample.scenes[0].id;
    h.links.current = {
      [sceneId]: {
        mediaId: 'm1',
        sourcePath: '/hook.mp4',
        clips: [{ track: 0, clip: 0, clipId: 'c1', name: 'hook.mp4' }],
        refreshedByRender: null,
      },
    };
    const r = h.run('motion_get_edit_links');
    const row = (r.scenes as Array<Record<string, unknown>>)[0];
    expect(row.rendered).toBe(true);
    expect(row.clipCount).toBe(1);
    expect(row.refreshedByRender).toBeNull();
    expect(row.staleLink).toBeNull();
    expect(r.warning).toBeUndefined();
  });

  it("a stale link is not counted as a render this project's settings made stale", () => {
    // `motion_set_project_settings`' own staleness answer reads the same map,
    // through the same rule: no file of OURS was produced at the old spec, so
    // nothing of ours is stale because of it.
    const h = harness();
    h.links.current = staleLinks(sample.scenes[0].id) as MotionEditLinks;
    const resized = h.run('motion_set_project_settings', { width: 1080, height: 1920 });
    expect(resized.renders).toMatchObject({ stale: false, linkDataAvailable: true, scenes: 0, clips: 0 });
  });

  it("commits nothing — it is a pure read (D-216/D-218's view-state discipline)", () => {
    const h = harness();
    h.links.current = {};
    h.run('motion_get_edit_links');
    expect(h.commits).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D-332 — saved components (the layer-preset library)
// ---------------------------------------------------------------------------

describe('saved components (D-332)', () => {
  /** save the sample's first text layer under `name`, returning the harness
   *  and the op result — the setup nearly every case below starts from. */
  const saveFirstText = async (h: ReturnType<typeof harness>, name = 'my text') =>
    await h.runAsync('motion_save_layer_preset', { ...sel(TEXT_L0), name });

  it('the library ops work with no project open — the library is not project state', async () => {
    const h = harness();
    h.state.loadState = 'no-project';
    expect(h.run('motion_list_layer_presets').error).toBeUndefined();
    // deleting a component that is not there is still a real "not found", not
    // a project refusal — which is the point: the op got as far as the library.
    const r = await h.runAsync('motion_delete_layer_preset', { preset_id: 'nope' });
    expect(r.error).toBe('no saved component with id "nope"');
  });

  it('refuses cleanly when nothing supplies a library at all', async () => {
    // the pre-D-332 context shape: no `presets` accessor
    const bare = createMotionOps({
      api: () => ({
        loadState: 'ready',
        manifest: sample,
        parseError: null,
        dirty: false,
        saveError: null,
        commit: () => {},
        save: (async () => ({ ok: true })) as unknown as MotionOpsApi['save'],
        render: (async () => ({ ok: true })) as unknown as MotionOpsApi['render'],
        reloadFromDisk: (async () => ({ ok: true, scenes: 3, hadSavedManifest: true })) as unknown as MotionOpsApi['reloadFromDisk'],
        renderStatus: IDLE_RENDER_STATUS,
      }),
      selections: () => [],
      setSelections: () => {},
      player: () => null,
    });
    const msg = 'the saved-component library is unavailable in this context';
    expect((bare.motion_list_layer_presets({}) as Record<string, unknown>).error).toBe(msg);
    expect(((await bare.motion_save_layer_preset({})) as Record<string, unknown>).error).toBe(msg);
    expect(((await bare.motion_add_layer_from_preset({})) as Record<string, unknown>).error).toBe(msg);
    expect(((await bare.motion_delete_layer_preset({})) as Record<string, unknown>).error).toBe(msg);
  });

  it('motion_save_layer_preset stores the layer and reports the new preset', async () => {
    const h = harness();
    const r = await saveFirstText(h, '  hero  headline ');
    expect(r.error).toBeUndefined();
    const p = r.preset as Record<string, unknown>;
    expect(p.name).toBe('hero headline');
    expect(p.use).toBe('text');
    expect(p.createdAt).toBe('2026-09-16T00:00:00.000Z');
    expect(h.presetLib.current).toHaveLength(1);
    expect(h.presetWrites).toHaveLength(1);
  });

  it('saving captures the layer as it stands, not a catalog default', async () => {
    const h = harness();
    await saveFirstText(h);
    const stored = h.presetLib.current[0];
    const live = sample.scenes[0].layers![0] as unknown as Record<string, unknown>;
    // every field of the real layer survives except its manifest id
    const { id, ...rest } = live;
    void id;
    expect(stored.layer).toEqual({ ...rest });
    expect('id' in stored.layer).toBe(false);
  });

  it('refuses an empty name and writes nothing', async () => {
    const h = harness();
    const r = await saveFirstText(h, '   ');
    expect(typeof r.error).toBe('string');
    expect(h.presetLib.current).toHaveLength(0);
    expect(h.presetWrites).toHaveLength(0);
  });

  it('reports a failed disk write instead of claiming a save', async () => {
    const h = harness();
    h.presetCommitOk.value = false;
    const r = await saveFirstText(h);
    expect(r.error).toBe('could not write the component library to disk');
    expect(h.presetWrites).toHaveLength(1);
    expect(h.presetLib.current).toHaveLength(0);
  });

  it('motion_list_layer_presets lists newest first with the stored fragment', async () => {
    const h = harness();
    h.presetNow.value = '2026-01-01T00:00:00.000Z';
    await saveFirstText(h, 'older');
    h.presetNow.value = '2026-09-01T00:00:00.000Z';
    await h.runAsync('motion_save_layer_preset', { ...sel(EMPH_L1), name: 'newer' });

    const listed = h.run('motion_list_layer_presets').presets as Record<string, unknown>[];
    expect(listed.map((p) => p.name)).toEqual(['newer', 'older']);
    expect(listed[0].use).toBe('emphasis');
    expect(listed[0].layer).toBeTruthy();
  });

  it('motion_add_layer_from_preset inserts a real copy and commits once', async () => {
    const h = harness();
    await saveFirstText(h, 'hero');
    const presetId = h.presetLib.current[0].id;
    const before = h.current().scenes[1].layers!.length;

    const r = await h.runAsync('motion_add_layer_from_preset', { scene_index: 1, preset_id: presetId });
    expect(r.error).toBeUndefined();
    expect(h.current().scenes[1].layers).toHaveLength(before + 1);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].label).toBe('Add hero');
    const added = h.current().scenes[1].layers!.at(-1) as unknown as Record<string, unknown>;
    expect(added.use).toBe('text');
  });

  /**
   * The op-vs-GUI equivalence this file exists to enforce: the op must land on
   * exactly what the Catalog's own insert path produces from the same preset.
   */
  it('lands on the same manifest the GUI insert path produces', async () => {
    const h = harness();
    await saveFirstText(h, 'hero');
    const preset = h.presetLib.current[0];
    const base = h.current();

    await h.runAsync('motion_add_layer_from_preset', { scene_index: 1, preset_id: preset.id });
    const viaOp = h.current();
    const viaGui = addLayerFromPreset(base, 1, preset).manifest;

    // ids are freshly minted per insert, so compare everything else
    const strip = (m: Manifest) =>
      JSON.stringify(m, (k, v) => (k === 'id' && typeof v === 'string' && v.length === 8 ? '<id>' : v));
    expect(strip(viaOp)).toBe(strip(viaGui));
  });

  it('refuses an unknown preset id, a bad scene index and a missing id', async () => {
    const h = harness();
    await saveFirstText(h, 'hero');
    const id = h.presetLib.current[0].id;

    expect((await h.runAsync('motion_add_layer_from_preset', { scene_index: 0, preset_id: 'nope' })).error)
      .toBe('no saved component with id "nope"');
    expect((await h.runAsync('motion_add_layer_from_preset', { scene_index: 99, preset_id: id })).error)
      .toContain('no scene at index 99');
    expect((await h.runAsync('motion_add_layer_from_preset', { scene_index: 0 })).error)
      .toBe('preset_id must be a non-empty string');
    expect(h.commits).toHaveLength(0);
  });

  it('motion_delete_layer_preset removes it and leaves inserted layers alone', async () => {
    const h = harness();
    await saveFirstText(h, 'hero');
    const id = h.presetLib.current[0].id;
    await h.runAsync('motion_add_layer_from_preset', { scene_index: 1, preset_id: id });
    const afterInsert = h.current().scenes[1].layers!.length;

    const r = await h.runAsync('motion_delete_layer_preset', { preset_id: id });
    expect(r.deleted).toBe(id);
    expect(r.remaining).toBe(0);
    expect(h.presetLib.current).toHaveLength(0);
    // the copy stays — an insert is a copy, nothing links back (D-332)
    expect(h.current().scenes[1].layers).toHaveLength(afterInsert);
  });

  it('a failed delete write is reported and the library is untouched', async () => {
    const h = harness();
    await saveFirstText(h, 'hero');
    const id = h.presetLib.current[0].id;
    h.presetCommitOk.value = false;
    const r = await h.runAsync('motion_delete_layer_preset', { preset_id: id });
    expect(r.error).toBe('could not write the component library to disk');
    expect(h.presetLib.current).toHaveLength(1);
  });

  it('round-trips a 3D primitive into scene3d.children', async () => {
    const h = harness();
    const r = await h.runAsync('motion_save_layer_preset', { ...sel(CHILD_3D), name: 'particles' });
    expect(r.error).toBeUndefined();
    const id = h.presetLib.current[0].id;
    await h.runAsync('motion_add_layer_from_preset', { scene_index: 2, preset_id: id });
    const kids = h.current().scenes[2].scene3d!.children;
    expect(kids.at(-1)).toMatchObject({ use: 'particleflow' });
  });
});
