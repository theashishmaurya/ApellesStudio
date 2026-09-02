// Chroma — multi-shot session (D-033).
//
// A grading job is N shots from one shoot, each with its own grade. This store
// mirrors the Rust session (`engine/src-tauri/src/chroma/session.rs`): the
// ordered shot list + which one is active, plus each shot's in-memory grade
// snapshot so flipping between shots keeps every grade.
//
// Kept separate from useEditorStore / useChromaStore / useAgentStore — same
// fork-hygiene rationale (docs/08 D-003). Lightweight by decision (D-033): no
// `.chroma` project bundle. The per-shot `grade.json` sidecar (D-025) is still
// the on-disk serialisation; `grades` here is a session-only cache that fills as
// you switch away from a shot. A `.chroma/session.json` path list is a deferred
// follow-up.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';

import { useEditorStore } from './useEditorStore';
import { useChromaStore, ChromaVideoInfo } from './useChromaStore';
import { useAgentStore } from './useAgentStore';
import { Adjustments, INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from '../utils/adjustments';

export interface SessionShot {
  path: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSecs: number;
  frame: number;
  codec: string;
  colorSpace: string;
}

interface SessionDto {
  shots: SessionShot[];
  active: number;
  count: number;
}

interface LoadImageResult {
  width: number;
  height: number;
  metadata?: any;
  exif?: any;
  is_raw?: boolean;
}

interface SessionSwitchDto {
  session: SessionDto;
  loaded: LoadImageResult | null;
}

// --- project model (D-037) ---------------------------------------------------
export interface ProjectShotDto {
  id: string;
  sourcePath: string;
  name: string;
  frame: number;
  offline: boolean;
}
/**
 * Per-project output spec (D-038). Every field optional — absent/null =
 * clip-derived (exactly the pre-D-038 behaviour). `colorSpace` is stored +
 * surfaced only; a colour-managed pipeline is D-004.
 */
export interface ProjectSettings {
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  colorSpace?: string | null;
}
interface ProjectOpenDto {
  projectPath: string;
  name: string;
  gradeDir: string;
  schema: string;
  shots: ProjectShotDto[];
  activeShot: number;
  settings: ProjectSettings;
}
export interface OfflineShot {
  id: string;
  sourcePath: string;
  name: string;
}

const GRADE_SCHEMA = 'chroma.grade/1';

/** wrap a bare Adjustments blob in the D-025 grade.json shape for a given shot. */
function gradeWrapper(shot: SessionShot, adj: Adjustments) {
  return {
    schema: GRADE_SCHEMA,
    shot: {
      source: shot.name,
      width: shot.width,
      height: shot.height,
      fps: shot.fps,
      frameCount: shot.frameCount,
      colorSpace: shot.colorSpace || 'bt709',
      reference: null as string | null,
    },
    adjustments: adj,
    notes: '',
  };
}

/** cheap "this shot has a real grade" test — for the strip's dot. */
export function isNonNeutralGrade(adj: Adjustments | undefined | null): boolean {
  if (!adj) return false;
  const a = adj as any;
  const PRIMARY = [
    'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
    'temperature', 'tint', 'saturation', 'vibrance', 'dehaze', 'clarity', 'structure',
  ];
  if (PRIMARY.some((k) => typeof a[k] === 'number' && Math.abs(a[k]) > 0.001)) return true;
  if (Array.isArray(a.masks) && a.masks.length > 0) return true;
  const curves = a.curves || {};
  for (const ch of Object.keys(curves)) {
    const pts = curves[ch];
    if (Array.isArray(pts) && pts.length > 2) return true;
  }
  const cg = a.colorGrading || {};
  for (const zone of ['shadows', 'midtones', 'highlights', 'global']) {
    const z = cg[zone];
    if (z && ['hue', 'saturation', 'luminance'].some((k) => typeof z[k] === 'number' && Math.abs(z[k]) > 0.001)) {
      return true;
    }
  }
  return false;
}

interface SessionState {
  shots: SessionShot[];
  activeIndex: number;
  /** per-shot grade snapshot, keyed by absolute clip path. Fills as you switch. */
  grades: Record<string, Adjustments>;
  /** true while a switch / add / remove is in flight (disables the strip) */
  busy: boolean;

  /** re-read the Rust session and reconcile the store. Also scopes the agent
   *  feed to the active shot. Call after the normal open flow. */
  syncFromRust: () => Promise<void>;
  /** stash the live editor grade under the currently-active shot's path */
  stashActiveGrade: () => void;
  /** switch the active shot: stash the current grade, load the target, restore
   *  its grade (or neutral), reset history + scope the agent feed. */
  switchToShot: (index: number) => Promise<{ ok: boolean; error?: string }>;
  /** append clips to the session (probes in Rust) and switch to the last one */
  addShots: (paths: string[]) => Promise<{ ok: boolean; error?: string }>;
  /** drop a shot; if it was active, the neighbour loads */
  removeShot: (index: number) => Promise<{ ok: boolean; error?: string }>;
  /** copy shot `from`'s grade onto shot `to` (in-memory; applies live if `to` is active) */
  copyGrade: (from: number, to: number) => void;

  // --- project model (D-037) ------------------------------------------------
  /** absolute path to the loaded `<name>.chroma` dir, or null for an Untitled session */
  projectPath: string | null;
  /** display name; 'Untitled' for a loose clip with no project on disk yet */
  projectName: string | null;
  /** `<projectPath>/grades` — where each shot's `<id>.grade.json` is written */
  gradeDir: string | null;
  /** source-path → shot id, for every shot (online + offline) */
  shotIds: Record<string, string>;
  /** shots whose source path is missing — shown in the strip with a Relink action */
  offlineShots: OfflineShot[];
  /** unsaved changes since the last successful save (only meaningful with a project) */
  dirty: boolean;
  /** per-project output spec (D-038): resolution / fps / colour space. null for
   *  an Untitled session or a project with no explicit settings. */
  projectSettings: ProjectSettings | null;

  markDirty: () => void;
  /** merge a partial output spec into the loaded project's settings (writes
   *  project.json via `chroma_project_set_settings`) and update local state. */
  setProjectSettings: (
    partial: ProjectSettings,
  ) => Promise<{ ok: boolean; error?: string; settings?: ProjectSettings }>;
  /** open a saved project: hydrate the session + per-shot grades, ready for the editor */
  openProject: (path: string) => Promise<{ ok: boolean; error?: string; hasShots?: boolean }>;
  /** create `<name>.chroma` from the picked media, then open it */
  newProject: (name: string, mediaPaths: string[]) => Promise<{ ok: boolean; error?: string }>;
  /** turn the current in-memory Untitled session into a saved project */
  saveUntitledAs: (name: string) => Promise<{ ok: boolean; error?: string }>;
  /** write project.json (+ the active shot's grade) + regenerate thumb.jpg. Debounced by the autosave hook. */
  saveProject: (opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; thumbRegenerated?: boolean }>;
  /** re-point an offline shot at a new file and reopen the project */
  relinkShot: (shotId: string, newPath: string) => Promise<{ ok: boolean; error?: string }>;
  /** internal: populate the store from a chroma_project_open/new/relink result */
  _hydrateOpenDto: (dto: ProjectOpenDto) => Promise<void>;
}

/** persist one shot's grade file if a real (non-Untitled) project is loaded. */
async function persistShotGrade(
  get: () => SessionState,
  shot: SessionShot | undefined,
  adj: Adjustments | undefined,
): Promise<void> {
  if (!shot || !adj) return;
  const { projectPath, projectName, gradeDir, shotIds } = get();
  if (!projectPath || projectName === 'Untitled' || !gradeDir) return;
  const id = shotIds[shot.path];
  if (!id) return;
  try {
    await invoke('chroma_save_grade', {
      path: `${gradeDir}/${id}.grade.json`,
      grade: gradeWrapper(shot, adj),
    });
  } catch (e) {
    console.warn('[session] grade persist failed', e);
  }
}

function shotKey(s: SessionShot | undefined): string | null {
  return s ? s.path : null;
}

/** push a loaded frame + a set of adjustments into the editor stores. Shared by
 *  switch / add / remove. */
function applyLoaded(
  shot: SessionShot,
  loaded: LoadImageResult | null,
  nextAdjustments: Adjustments,
) {
  const ed = useEditorStore.getState();
  const width = loaded?.width || shot.width;
  const height = loaded?.height || shot.height;

  ed.setEditor({
    selectedImage: {
      exif: loaded?.exif ?? null,
      group_id: null,
      height,
      isRaw: !!loaded?.is_raw,
      isReady: true,
      metadata: loaded?.metadata ?? null,
      path: shot.path,
      thumbnailUrl: '',
      width,
    } as any,
    originalSize: { width, height },
    adjustments: nextAdjustments,
    activeMaskId: null,
    activeMaskContainerId: null,
    histogram: null,
  });
  ed.resetHistory(nextAdjustments);

  const vi: ChromaVideoInfo = {
    isVideo: true,
    path: shot.path,
    width: shot.width,
    height: shot.height,
    fps: shot.fps,
    frameCount: shot.frameCount,
    durationSecs: shot.durationSecs,
    frame: shot.frame,
    codec: shot.codec,
    colorSpace: shot.colorSpace,
    colorTransfer: '',
  };
  useChromaStore.getState().setVideoInfo(vi);
  useChromaStore.getState().setCurrentFrame(shot.frame);
  useAgentStore.getState().scopeToShot(shot.path);
  useChromaStore.getState().bumpFrameNonce();
}

export const useSessionStore = create<SessionState>((set, get) => ({
  shots: [],
  activeIndex: 0,
  grades: {},
  busy: false,

  projectPath: null,
  projectName: null,
  gradeDir: null,
  shotIds: {},
  offlineShots: [],
  dirty: false,
  projectSettings: null,

  markDirty: () => {
    if (get().projectPath && get().projectName !== 'Untitled') set({ dirty: true });
  },

  setProjectSettings: async (partial) => {
    const { projectPath, projectName } = get();
    if (!projectPath || projectName === 'Untitled') {
      return { ok: false, error: 'no saved project — save this session as a project first' };
    }
    try {
      const merged = await invoke<ProjectSettings>('chroma_project_set_settings', {
        path: projectPath,
        partial,
      });
      set({ projectSettings: merged });
      return { ok: true, settings: merged };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  syncFromRust: async () => {
    let dto: SessionDto;
    try {
      dto = await invoke<SessionDto>('chroma_session_list');
    } catch {
      return;
    }
    set({ shots: dto.shots, activeIndex: dto.active });
    // a loose clip with no project on disk = an in-memory "Untitled" project
    // (D-037 quick-open) — still seeks / plays / exports, just nowhere to autosave.
    if (dto.shots.length > 0 && !get().projectPath && !get().projectName) {
      set({ projectName: 'Untitled', projectSettings: null });
    }
    const activePath = shotKey(dto.shots[dto.active]);
    if (activePath) {
      // seed the active shot's grade from what the editor currently holds if we
      // don't have one yet (the normal open flow already loaded it)
      const { grades } = get();
      if (!grades[activePath]) {
        set({ grades: { ...grades, [activePath]: useEditorStore.getState().adjustments } });
      }
      if (useAgentStore.getState().activeShotKey !== activePath) {
        useAgentStore.getState().scopeToShot(activePath);
      }
    }
  },

  stashActiveGrade: () => {
    const { shots, activeIndex, grades } = get();
    const key = shotKey(shots[activeIndex]);
    if (!key) return;
    set({ grades: { ...grades, [key]: useEditorStore.getState().adjustments } });
  },

  switchToShot: async (index) => {
    const { shots, activeIndex, busy } = get();
    if (busy) return { ok: false, error: 'session busy' };
    if (index === activeIndex) return { ok: true };
    if (index < 0 || index >= shots.length) return { ok: false, error: `shot index ${index} out of range` };

    const outgoing = shots[activeIndex];
    get().stashActiveGrade();
    // flush the outgoing shot's grade to disk — autosave only ever writes the
    // active shot's grade file, so a switch is our chance to persist this one.
    void persistShotGrade(get, outgoing, get().grades[outgoing?.path]);
    set({ busy: true });
    try {
      const res = await invoke<SessionSwitchDto>('chroma_session_set_active', { index });
      set({ shots: res.session.shots, activeIndex: res.session.active });
      const shot = res.session.shots[res.session.active];
      const next = get().grades[shot.path] ?? { ...INITIAL_ADJUSTMENTS };
      applyLoaded(shot, res.loaded, next);
      get().markDirty();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  addShots: async (paths) => {
    if (!paths.length) return { ok: false, error: 'no paths' };
    const { busy } = get();
    if (busy) return { ok: false, error: 'session busy' };
    get().stashActiveGrade();
    set({ busy: true });
    try {
      const res = await invoke<SessionSwitchDto>('chroma_session_add', { paths });
      set({ shots: res.session.shots, activeIndex: res.session.active });
      const shot = res.session.shots[res.session.active];
      const next = get().grades[shot.path] ?? { ...INITIAL_ADJUSTMENTS };
      applyLoaded(shot, res.loaded, next);
      // give any newly-added clip a project shot id + mark the project dirty
      if (get().projectPath) {
        const { shotIds } = get();
        const nextIds = { ...shotIds };
        for (const s of res.session.shots) {
          if (!nextIds[s.path]) nextIds[s.path] = uuidv4();
        }
        set({ shotIds: nextIds });
        get().markDirty();
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  removeShot: async (index) => {
    const { shots, activeIndex, busy, grades } = get();
    if (busy) return { ok: false, error: 'session busy' };
    if (index < 0 || index >= shots.length) return { ok: false, error: 'out of range' };
    if (index === activeIndex) get().stashActiveGrade();
    set({ busy: true });
    try {
      const res = await invoke<SessionSwitchDto>('chroma_session_remove', { index });
      // forget the removed shot's cached grade
      const removedKey = shots[index]?.path;
      const nextGrades = { ...grades };
      if (removedKey) delete nextGrades[removedKey];
      set({ shots: res.session.shots, activeIndex: res.session.active, grades: nextGrades });

      if (get().projectPath && removedKey) {
        const nextIds = { ...get().shotIds };
        delete nextIds[removedKey];
        set({ shotIds: nextIds });
        get().markDirty();
      }

      if (res.loaded && res.session.shots.length > 0) {
        const shot = res.session.shots[res.session.active];
        const next = nextGrades[shot.path] ?? { ...INITIAL_ADJUSTMENTS };
        applyLoaded(shot, res.loaded, next);
      } else {
        // session empty — drop the clip from the editor
        useEditorStore.getState().setEditor({ selectedImage: null });
        useChromaStore.getState().setVideoInfo(null);
        useAgentStore.getState().scopeToShot(null);
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  copyGrade: (from, to) => {
    const { shots, grades, activeIndex } = get();
    const src = shots[from];
    const dst = shots[to];
    if (!src || !dst || from === to) return;
    const srcGrade =
      from === activeIndex ? useEditorStore.getState().adjustments : grades[src.path];
    if (!srcGrade) return;
    const clone = JSON.parse(JSON.stringify(srcGrade));
    set({ grades: { ...grades, [dst.path]: clone } });
    if (to === activeIndex) {
      useEditorStore.getState().setEditor({ adjustments: clone });
      useEditorStore.getState().resetHistory(clone);
      useChromaStore.getState().bumpFrameNonce();
    }
    get().markDirty();
  },

  // --- project model (D-037) ------------------------------------------------

  _hydrateOpenDto: async (dto) => {
    // the Rust session already holds the online shots (chroma_project_open
    // loaded them). Mirror it, then attach per-shot grades + project metadata.
    const list = await invoke<SessionDto>('chroma_session_list');

    const shotIds: Record<string, string> = {};
    for (const s of dto.shots) shotIds[s.sourcePath] = s.id;
    const offlineShots: OfflineShot[] = dto.shots
      .filter((s) => s.offline)
      .map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.name }));

    const grades: Record<string, Adjustments> = {};
    for (const s of dto.shots) {
      if (s.offline) continue;
      try {
        const g: any = await invoke('chroma_load_grade', { path: `${dto.gradeDir}/${s.id}.grade.json` });
        grades[s.sourcePath] = normalizeLoadedAdjustments(g?.adjustments ?? INITIAL_ADJUSTMENTS);
      } catch {
        /* no grade.json for this shot yet — neutral */
      }
    }

    set({
      shots: list.shots,
      activeIndex: list.active,
      grades,
      shotIds,
      offlineShots,
      projectPath: dto.projectPath,
      projectName: dto.name,
      gradeDir: dto.gradeDir,
      projectSettings: dto.settings ?? null,
      dirty: false,
    });

    if (list.shots.length > 0) {
      // decode + install the active shot's frame into the editor and apply its grade
      const sw = await invoke<SessionSwitchDto>('chroma_session_set_active', { index: list.active });
      set({ shots: sw.session.shots, activeIndex: sw.session.active });
      const active = sw.session.shots[sw.session.active];
      applyLoaded(active, sw.loaded, grades[active.path] ?? { ...INITIAL_ADJUSTMENTS });
    } else {
      // every shot offline — nothing to show
      useEditorStore.getState().setEditor({ selectedImage: null });
      useChromaStore.getState().setVideoInfo(null);
      useAgentStore.getState().scopeToShot(null);
    }
  },

  openProject: async (path) => {
    if (get().busy) return { ok: false, error: 'session busy' };
    set({ busy: true });
    try {
      const dto = await invoke<ProjectOpenDto>('chroma_project_open', { path });
      await get()._hydrateOpenDto(dto);
      return { ok: true, hasShots: get().shots.length > 0 || get().offlineShots.length > 0 };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  newProject: async (name, mediaPaths) => {
    if (get().busy) return { ok: false, error: 'session busy' };
    set({ busy: true });
    try {
      const dto = await invoke<ProjectOpenDto>('chroma_project_new', { name, mediaPaths });
      await get()._hydrateOpenDto(dto);
      // write an initial thumb.jpg from the active shot
      void get().saveProject({ force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  saveUntitledAs: async (name) => {
    const paths = get().shots.map((s) => s.path);
    if (!paths.length) return { ok: false, error: 'nothing to save' };
    if (get().busy) return { ok: false, error: 'session busy' };
    set({ busy: true });
    try {
      const dto = await invoke<ProjectOpenDto>('chroma_project_new', { name, mediaPaths: paths });
      await get()._hydrateOpenDto(dto);
      void get().saveProject({ force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  saveProject: async (opts) => {
    const { projectPath, projectName, gradeDir, shotIds, offlineShots, activeIndex } = get();
    if (!projectPath) return { ok: false, error: 'no project loaded' };
    if (projectName === 'Untitled' && !opts?.force) return { ok: false, error: 'untitled — save as first' };

    get().stashActiveGrade();
    const shots = get().shots;
    const active = shots[activeIndex];
    if (active && gradeDir) {
      await persistShotGrade(get, active, get().grades[active.path] ?? useEditorStore.getState().adjustments);
    }

    const manifestShots = [
      ...shots.map((s) => ({
        id: shotIds[s.path],
        sourcePath: s.path,
        frame: Math.round(s.frame || 0),
        name: s.name,
      })),
      ...offlineShots.map((o) => ({ id: o.id, sourcePath: o.sourcePath, frame: 0, name: o.name })),
    ].filter((s) => !!s.id);

    try {
      const res: any = await invoke('chroma_project_save', {
        path: projectPath,
        shots: manifestShots,
        activeShot: activeIndex,
      });
      set({ dirty: false });
      return { ok: true, thumbRegenerated: !!res?.thumbRegenerated };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  relinkShot: async (shotId, newPath) => {
    const { projectPath, busy } = get();
    if (!projectPath) return { ok: false, error: 'no project loaded' };
    if (busy) return { ok: false, error: 'session busy' };
    set({ busy: true });
    try {
      const dto = await invoke<ProjectOpenDto>('chroma_project_relink', {
        path: projectPath,
        shotId,
        newPath,
      });
      await get()._hydrateOpenDto(dto);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },
}));
