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
//
// **Unified clip identity (D-070, `docs/notes/unified-clip-model.md`).** For a
// real (non-Untitled) project, `shots` is now sourced from the active
// `chroma_timeline::Timeline`'s clips — `chroma_project_open`/`_new`/
// `_relink`/`_hydrateOpenDto`'s `ProjectOpenDto.shots[i].id` is a **clip id**,
// not the old `ProjectShot.id`. `grades`/`gradeWrapper`/`persistShotGrade` all
// key off `SessionShot.id` (that clip id) instead of `SessionShot.path`, so two
// different clips trimmed from the same source file grade independently, same
// as Resolve's default per-instance grading. The decode session itself
// (`chroma::session`, `chroma_session_*`) still upserts **by path** underneath
// — deliberately not retired this pass (see the scoping doc's "explicitly
// deferred" section) — so `SessionShot.id` is attached on top of the raw
// `chroma_session_list()` result by matching source path against the active
// project's clip list (`reattachIds`/`_hydrateOpenDto`), not carried by the
// decode session itself. One known, documented limit of not retiring the
// decode session this pass: two *different* clips that share the exact same
// `source_path` collapse onto one decode-session entry (upsert-by-path), so
// only one of them is independently switchable/viewable at a time in the
// Colorist tab today — their grade files still stay genuinely separate on
// disk, this only affects which one's *pixels* are currently shown.
//
// For an in-memory **"Untitled"** session (no project on disk — a loose clip
// opened via the file picker / MCP `open`), there is no timeline/clip concept
// at all: `SessionShot.id` is just the clip's `path` (decode-session identity
// is already path-unique there), and `addShots`/`removeShot` stay pure
// `chroma_session_*` calls with nothing persisted — the scoping doc's
// "explicitly deferred" case.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { trackEvent } from '@chroma/bridge';

import { useEditorStore } from './useEditorStore';
import { useChromaStore, ChromaVideoInfo } from './useChromaStore';
import { useAgentStore } from './useAgentStore';
import { Adjustments, INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from '../utils/adjustments';

/** The raw per-shot shape `chroma_session_list`/`_set_active`/`_add`/`_remove`
 *  return (mirrors `chroma::session::ShotDto`) — no identity beyond `path`,
 *  since the decode session it comes from is path-keyed (see the module doc).
 *  `SessionShot` (below) is this plus the store's own attached `id`. */
interface RawShotDto {
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

/** A shot as the store/UI sees it: the decode session's raw fields plus a
 *  stable `id` — a `chroma_timeline::Clip` id for a real project's shot
 *  (D-070), or the shot's own `path` for an in-memory "Untitled" session
 *  (see the module doc). Everything that used to key off `path` (grades,
 *  the strip's React key, grade-file persistence) keys off `id` now. */
export interface SessionShot extends RawShotDto {
  id: string;
}

interface SessionDto {
  shots: RawShotDto[];
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
  /** D-070: a `chroma_timeline::Clip` id, not a `ProjectShot` id — see the
   *  module doc. The field name/shape on the wire is unchanged. */
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
/** Mirrors `chroma::project::ProjectOpenDto` (serde camelCase) — also what
 *  `chroma_project_add_shot`/`_add_shot_paths`/`_remove_clip` (D-070) return,
 *  consumed the same way via `_hydrateOpenDto`. */
export interface ProjectOpenDto {
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
  /** per-shot grade snapshot, keyed by `SessionShot.id` (D-070 — a clip id
   *  for a real project, a path for an in-memory Untitled session; see the
   *  module doc). Fills as you switch. */
  grades: Record<string, Adjustments>;
  /** true while a switch / add / remove is in flight (disables the strip) */
  busy: boolean;

  /** re-read the Rust session and reconcile the store. Also scopes the agent
   *  feed to the active shot. Call after the normal open flow. */
  syncFromRust: () => Promise<void>;
  /** D-071: pick up clips added/removed on the Edit tab's timeline since the
   *  project was last opened — `chroma_timeline_set` (the Edit tab's own
   *  save path) never runs `open_manifest`, so nothing else refreshes this.
   *  Unlike a full re-open, this never disturbs whichever clip is currently
   *  active in the strip if it's still on the timeline (see
   *  `chroma_project_resync_clips`'s doc). A no-op for an in-memory
   *  "Untitled" session (no project on disk, no Edit-tab timeline concept). */
  resyncClips: () => Promise<void>;
  /** stash the live editor grade under the currently-active shot's id */
  stashActiveGrade: () => void;
  /** switch the active shot: stash the current grade, load the target, restore
   *  its grade (or neutral), reset history + scope the agent feed. */
  switchToShot: (index: number) => Promise<{ ok: boolean; error?: string }>;
  /** append clips to the session and switch to the last one. For a real
   *  project this appends real `chroma_timeline::Clip`s to the active
   *  timeline (D-070, same action as dragging onto the Edit tab); for an
   *  in-memory Untitled session it stays a plain decode-session upsert. */
  addShots: (paths: string[]) => Promise<{ ok: boolean; error?: string }>;
  /** drop a shot; if it was active, the neighbour loads. For a real project
   *  this removes the clip from the active timeline (D-070). */
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
  /** close the loaded project / Untitled session → back to the shell-level launcher
   *  (D-039). Flushes a final save for a dirty real project, then resets all
   *  session + project state to initial. */
  closeProject: () => Promise<void>;
  /** create `<name>.chroma` from the picked media, then open it */
  newProject: (name: string, mediaPaths: string[]) => Promise<{ ok: boolean; error?: string }>;
  /** turn the current in-memory Untitled session into a saved project */
  saveUntitledAs: (name: string) => Promise<{ ok: boolean; error?: string }>;
  /** persist which clip is active (D-070) + regenerate thumb.jpg. Debounced by the autosave hook. */
  saveProject: (opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; thumbRegenerated?: boolean }>;
  /** re-point an offline shot at a new file and reopen the project */
  relinkShot: (shotId: string, newPath: string) => Promise<{ ok: boolean; error?: string }>;
  /** internal: populate the store from a chroma_project_open/new/relink/add_shot(_paths)/remove_clip result */
  _hydrateOpenDto: (dto: ProjectOpenDto) => Promise<void>;
}

/** persist one shot's grade file if a real (non-Untitled) project is loaded. */
async function persistShotGrade(
  get: () => SessionState,
  shot: SessionShot | undefined,
  adj: Adjustments | undefined,
): Promise<void> {
  if (!shot || !adj) return;
  const { projectPath, projectName, gradeDir } = get();
  if (!projectPath || projectName === 'Untitled' || !gradeDir) return;
  try {
    await invoke('chroma_save_grade', {
      path: `${gradeDir}/${shot.id}.grade.json`,
      grade: gradeWrapper(shot, adj),
    });
  } catch (e) {
    console.warn('[session] grade persist failed', e);
  }
}

/** Attach each `id` in `fresh` (a raw decode-session read with no identity of
 *  its own) by matching `path` against `previous` (the store's last known
 *  `shots`, which already carry the real id) — falls back to the path itself
 *  for a path `previous` has never seen (a brand new Untitled-session shot).
 *  Path-matched rather than index-matched so this stays correct even if the
 *  decode session's own Vec order ever shifts under us. */
function reattachIds(fresh: RawShotDto[], previous: SessionShot[]): SessionShot[] {
  const byPath = new Map(previous.map((s) => [s.path, s.id]));
  return fresh.map((sh) => ({ ...sh, id: byPath.get(sh.path) ?? sh.path }));
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

/** **The** identity of whatever session is open right now — the `.chroma`
 *  directory path for a real project, an `untitled:` marker for an in-memory
 *  loose-clip session, and `null` when the launcher is showing.
 *
 *  B-083/D-203 — the composition root (`Root.tsx`) hands this to every store
 *  that caches per-project state (`@chroma/editor`'s timeline, `@chroma/motion`'s
 *  manifest, `@chroma/bridge`'s media pool), so each of them can tell "no
 *  project → project A" apart from "project A → project B". The bare boolean
 *  those bridges used before could not, and `open_project`/`new_project`
 *  (GUI and MCP alike) switch projects without ever closing the first — which
 *  is exactly how the Edit tab spent a whole session serving, and letting an
 *  agent edit, the *previous* project's timeline.
 *
 *  A plain selector rather than a stored field: it is derived from
 *  `projectPath`/`projectName` with no state of its own, so there is nothing
 *  to keep in sync. */
export const selectProjectKey = (s: SessionState): string | null =>
  s.projectPath ?? (s.projectName ? `untitled:${s.projectName}` : null);

export const useSessionStore = create<SessionState>((set, get) => ({
  shots: [],
  activeIndex: 0,
  grades: {},
  busy: false,

  projectPath: null,
  projectName: null,
  gradeDir: null,
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
    const shotsWithId = reattachIds(dto.shots, get().shots);
    set({ shots: shotsWithId, activeIndex: dto.active });
    // a loose clip with no project on disk = an in-memory "Untitled" project
    // (D-037 quick-open) — still seeks / plays / exports, just nowhere to autosave.
    if (dto.shots.length > 0 && !get().projectPath && !get().projectName) {
      set({ projectName: 'Untitled', projectSettings: null });
    }
    const active = shotsWithId[dto.active];
    if (active) {
      // seed the active shot's grade from what the editor currently holds if we
      // don't have one yet (the normal open flow already loaded it)
      const { grades } = get();
      if (!grades[active.id]) {
        set({ grades: { ...grades, [active.id]: useEditorStore.getState().adjustments } });
      }
      if (useAgentStore.getState().activeShotKey !== active.path) {
        useAgentStore.getState().scopeToShot(active.path);
      }
    }
  },

  stashActiveGrade: () => {
    const { shots, activeIndex, grades } = get();
    const key = shots[activeIndex]?.id;
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
    void persistShotGrade(get, outgoing, get().grades[outgoing?.id]);
    set({ busy: true });
    try {
      const res = await invoke<SessionSwitchDto>('chroma_session_set_active', { index });
      const nextShots = reattachIds(res.session.shots, shots);
      set({ shots: nextShots, activeIndex: res.session.active });
      const shot = nextShots[res.session.active];
      const next = get().grades[shot.id] ?? { ...INITIAL_ADJUSTMENTS };
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
    if (get().busy) return { ok: false, error: 'session busy' };
    const { projectPath, projectName } = get();

    // D-070: a real project's "+" appends real timeline clips (find-or-create
    // pool item + append a clip to the active timeline on the backend) — the
    // same action as dragging a Sources-panel item onto the Edit tab, just
    // triggered from the Colorist strip. An in-memory Untitled session (no
    // project, no timeline) keeps the old decode-session-only behaviour.
    if (projectPath && projectName !== 'Untitled') {
      set({ busy: true });
      try {
        const dto = await invoke<ProjectOpenDto>('chroma_project_add_shot_paths', { paths });
        await get()._hydrateOpenDto(dto);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      } finally {
        set({ busy: false });
      }
    }

    get().stashActiveGrade();
    set({ busy: true });
    try {
      const res = await invoke<SessionSwitchDto>('chroma_session_add', { paths });
      const nextShots = reattachIds(res.session.shots, get().shots);
      set({ shots: nextShots, activeIndex: res.session.active });
      const shot = nextShots[res.session.active];
      const next = get().grades[shot.id] ?? { ...INITIAL_ADJUSTMENTS };
      applyLoaded(shot, res.loaded, next);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  removeShot: async (index) => {
    const { shots, activeIndex, busy, grades, projectPath, projectName } = get();
    if (busy) return { ok: false, error: 'session busy' };
    if (index < 0 || index >= shots.length) return { ok: false, error: 'out of range' };

    // D-070: a real project's remove drops the clip from the active timeline.
    if (projectPath && projectName !== 'Untitled') {
      const clipId = shots[index].id;
      set({ busy: true });
      try {
        const dto = await invoke<ProjectOpenDto>('chroma_project_remove_clip', { clipId });
        await get()._hydrateOpenDto(dto);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      } finally {
        set({ busy: false });
      }
    }

    if (index === activeIndex) get().stashActiveGrade();
    set({ busy: true });
    try {
      const res = await invoke<SessionSwitchDto>('chroma_session_remove', { index });
      // forget the removed shot's cached grade
      const removedId = shots[index]?.id;
      const nextGrades = { ...grades };
      if (removedId) delete nextGrades[removedId];
      const nextShots = reattachIds(res.session.shots, shots);
      set({ shots: nextShots, activeIndex: res.session.active, grades: nextGrades });

      if (res.loaded && nextShots.length > 0) {
        const shot = nextShots[res.session.active];
        const next = nextGrades[shot.id] ?? { ...INITIAL_ADJUSTMENTS };
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
      from === activeIndex ? useEditorStore.getState().adjustments : grades[src.id];
    if (!srcGrade) return;
    const clone = JSON.parse(JSON.stringify(srcGrade));
    set({ grades: { ...grades, [dst.id]: clone } });
    if (to === activeIndex) {
      useEditorStore.getState().setEditor({ adjustments: clone });
      useEditorStore.getState().resetHistory(clone);
      useChromaStore.getState().bumpFrameNonce();
    }
    get().markDirty();
  },

  // --- project model (D-037) ------------------------------------------------

  _hydrateOpenDto: async (dto) => {
    // D-063: `busy` set here, not just left to each caller — `openProject`/
    // `newProject`/etc. (the in-store callers) already wrap their own call
    // to this in `busy: true`/`false`, but `SourcesPanel`'s "add to grading"
    // action calls this directly and never did, which is exactly why
    // clicking "+" on a Sources clip flashed to a blank/stale preview during
    // the real decode round trip below with zero loading feedback —
    // `Editor.tsx`'s spinner (D-063, now wired to this flag too) had
    // nothing to key off. Setting it here, inside the one function every
    // path funnels through, means a future caller gets this for free
    // instead of needing to remember it. A redundant `true`→`true` from an
    // outer caller that already set it is harmless.
    set({ busy: true });
    try {
      // the Rust session already holds the online clips (chroma_project_open
      // et al loaded them). Mirror it, then attach per-shot grades + project
      // metadata. D-070: `dto.shots[i].id` is now a `chroma_timeline::Clip`
      // id — attach it onto the (path-keyed) decode-session read by matching
      // source path, since the decode session itself carries no clip
      // identity of its own (see the module doc).
      const list = await invoke<SessionDto>('chroma_session_list');
      const onlineDtoShots = dto.shots.filter((s) => !s.offline);
      const pathToClipId = new Map(onlineDtoShots.map((s) => [s.sourcePath, s.id]));
      const shotsWithId: SessionShot[] = list.shots.map((sh) => ({
        ...sh,
        id: pathToClipId.get(sh.path) ?? sh.path,
      }));

      const offlineShots: OfflineShot[] = dto.shots
        .filter((s) => s.offline)
        .map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.name }));

      const grades: Record<string, Adjustments> = {};
      for (const s of dto.shots) {
        if (s.offline) continue;
        try {
          const g: any = await invoke('chroma_load_grade', { path: `${dto.gradeDir}/${s.id}.grade.json` });
          grades[s.id] = normalizeLoadedAdjustments(g?.adjustments ?? INITIAL_ADJUSTMENTS);
        } catch {
          /* no grade.json for this shot/clip yet — neutral */
        }
      }

      set({
        shots: shotsWithId,
        activeIndex: list.active,
        grades,
        offlineShots,
        projectPath: dto.projectPath,
        projectName: dto.name,
        gradeDir: dto.gradeDir,
        projectSettings: dto.settings ?? null,
        dirty: false,
      });

      if (shotsWithId.length > 0) {
        // decode + install the active shot's frame into the editor and apply its grade
        const sw = await invoke<SessionSwitchDto>('chroma_session_set_active', { index: list.active });
        const activeShots = reattachIds(sw.session.shots, shotsWithId);
        set({ shots: activeShots, activeIndex: sw.session.active });
        const active = activeShots[sw.session.active];
        applyLoaded(active, sw.loaded, grades[active.id] ?? { ...INITIAL_ADJUSTMENTS });
      } else {
        // every shot offline — nothing to show
        useEditorStore.getState().setEditor({ selectedImage: null });
        useChromaStore.getState().setVideoInfo(null);
        useAgentStore.getState().scopeToShot(null);
      }
    } finally {
      set({ busy: false });
    }
  },

  // D-071: `chroma_project_resync_clips`'s whole point is NOT disturbing the
  // active clip when it's unaffected, so this deliberately does not set
  // `busy` (that flag drives `Editor.tsx`'s full-screen loading spinner —
  // D-063 — which should only show for a real clip switch, not a
  // background poll that usually changes nothing).
  resyncClips: async () => {
    const { projectPath, projectName, busy } = get();
    if (!projectPath || projectName === 'Untitled' || busy) return;
    let dto: ProjectOpenDto;
    try {
      dto = await invoke<ProjectOpenDto>('chroma_project_resync_clips');
    } catch {
      return; // best-effort background sync — no toast for a quiet no-op failure
    }

    let list: SessionDto;
    try {
      list = await invoke<SessionDto>('chroma_session_list');
    } catch {
      return;
    }
    const onlineDtoShots = dto.shots.filter((s) => !s.offline);
    const pathToClipId = new Map(onlineDtoShots.map((s) => [s.sourcePath, s.id]));
    const shotsWithId: SessionShot[] = list.shots.map((sh) => ({
      ...sh,
      id: pathToClipId.get(sh.path) ?? sh.path,
    }));
    const offlineShots: OfflineShot[] = dto.shots
      .filter((s) => s.offline)
      .map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.name }));

    const prevActive = get().shots[get().activeIndex];
    const newActive = shotsWithId[list.active];
    // Rust already decided whether the active clip needed to change (see
    // `chroma_project_resync_clips`'s doc) — this just detects that outcome
    // rather than re-deciding it, so the frontend and backend can't disagree.
    const activeChanged = prevActive?.id !== newActive?.id;

    set({ shots: shotsWithId, activeIndex: list.active, offlineShots });

    if (activeChanged && newActive) {
      const { grades } = get();
      let grade = grades[newActive.id];
      if (!grade) {
        try {
          const g: any = await invoke('chroma_load_grade', {
            path: `${dto.gradeDir}/${newActive.id}.grade.json`,
          });
          grade = normalizeLoadedAdjustments(g?.adjustments ?? INITIAL_ADJUSTMENTS);
        } catch {
          grade = { ...INITIAL_ADJUSTMENTS };
        }
        set({ grades: { ...get().grades, [newActive.id]: grade } });
      }
      // `loaded: null` is fine here — `applyLoaded` falls back to the
      // decode-session's own width/height/etc when there's no fresher
      // `LoadImageResult`, and the pixels themselves were already installed
      // server-side inside `chroma_project_resync_clips` (it calls the same
      // `seek_and_install` `open_manifest` does) — re-fetching via
      // `chroma_session_set_active` here would just re-decode the exact
      // frame Rust already decoded, for no benefit.
      applyLoaded(newActive, null, grade);
      useAgentStore.getState().scopeToShot(newActive.path);
    }
  },

  openProject: async (path) => {
    if (get().busy) return { ok: false, error: 'session busy' };
    set({ busy: true });
    try {
      const dto = await invoke<ProjectOpenDto>('chroma_project_open', { path });
      await get()._hydrateOpenDto(dto);
      trackEvent('project_open', { shotCount: get().shots.length });
      return { ok: true, hasShots: get().shots.length > 0 || get().offlineShots.length > 0 };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      set({ busy: false });
    }
  },

  closeProject: async () => {
    const { projectPath, projectName, dirty } = get();
    trackEvent('project_close', { hadUnsavedChanges: dirty });
    // best-effort final flush for a dirty, named project (Untitled autosave is
    // already skipped, so an Untitled session is just discarded)
    if (projectPath && projectName !== 'Untitled' && dirty) {
      try {
        await get().saveProject();
      } catch {
        /* ignore — closing anyway */
      }
    }
    // reset everything back to the initial store state. Autosave's debounced
    // saveProject() no-ops once projectPath is null; the Rust `state::ProjectRef`
    // is left as-is (harmless — the next open/new overwrites it, and every
    // frontend save path guards on projectPath).
    set({
      shots: [],
      activeIndex: 0,
      grades: {},
      busy: false,
      projectPath: null,
      projectName: null,
      gradeDir: null,
      offlineShots: [],
      dirty: false,
      projectSettings: null,
    });
    // drop the clip from the editor stores (mirrors removeShot's "session empty" branch)
    useEditorStore.getState().setEditor({ selectedImage: null });
    useChromaStore.getState().setVideoInfo(null);
    useAgentStore.getState().scopeToShot(null);
  },

  newProject: async (name, mediaPaths) => {
    if (get().busy) return { ok: false, error: 'session busy' };
    set({ busy: true });
    try {
      const dto = await invoke<ProjectOpenDto>('chroma_project_new', { name, mediaPaths });
      await get()._hydrateOpenDto(dto);
      trackEvent('project_new', { mediaCount: mediaPaths.length });
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
    const { projectPath, projectName, gradeDir, activeIndex } = get();
    if (!projectPath) return { ok: false, error: 'no project loaded' };
    if (projectName === 'Untitled' && !opts?.force) return { ok: false, error: 'untitled — save as first' };

    get().stashActiveGrade();
    const shots = get().shots;
    const active = shots[activeIndex];
    if (active && gradeDir) {
      await persistShotGrade(get, active, get().grades[active.id] ?? useEditorStore.getState().adjustments);
    }

    try {
      // D-070: no more `shots` list to send — the active timeline (persisted
      // separately by `chroma::edit`'s `chroma_timeline_set`) is the durable
      // clip list now. This just persists which clip is active + regenerates
      // thumb.jpg.
      const res: any = await invoke('chroma_project_save', {
        path: projectPath,
        activeClipId: active?.id ?? null,
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
      // D-070: `shotId` here is a `chroma_timeline::Clip` id (offlineShots
      // now come from the clip-derived `ProjectShotDto`) — the Rust command
      // takes `clipId`, renamed from `shotId` for the same reason.
      const dto = await invoke<ProjectOpenDto>('chroma_project_relink', {
        path: projectPath,
        clipId: shotId,
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
