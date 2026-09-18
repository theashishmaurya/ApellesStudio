// Apelles — multi-shot session (D-033).
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
// `apelles_timeline::Timeline`'s clips — `chroma_project_open`/`_new`/
// `_relink`/`_hydrateOpenDto`'s `ProjectOpenDto.shots[i].id` is a **clip id**,
// not the old `ProjectShot.id`. `grades`/`gradeWrapper`/`persistShotGrade` all
// key off `SessionShot.id` (that clip id) instead of `SessionShot.path`, so two
// different clips trimmed from the same source file grade independently, same
// as Resolve's default per-instance grading.
//
// **The decode session carries that identity too now (D-306, B-150).** It used
// to upsert **by path**, with `SessionShot.id` attached on top by matching
// source paths against the project's clip list — and D-070 recorded the limit
// that cost: two clips sharing a `source_path` collapsed onto ONE decode-session
// entry, so only one was switchable or viewable in Colorist (the second was
// invisible: B-150), and the path→clip-id match could only ever answer with one
// of the two ids, so a shot could be shown wearing the other's grade and masks
// (B-155). `chroma::state::ShotId` is now the one identity — a clip id for a
// project's shot, the path for an Untitled one — reported on the wire as
// `RawShotDto.clipId` and read straight through by `reattachIds`.
//
// **Mutual exclusion (B-132/D-268).** The seven actions that mutate the
// session — `newProject`, `openProject`, `addShots`, `removeShot`,
// `switchToShot`, `relinkShot`, `saveUntitledAs` — are serialised by a single
// lock, and both interfaces go through them (the GUI's launcher/shot strip
// call them directly; so does the MCP layer, via `useChromaControl.ts`). The
// lock lives in `sessionLock.ts`; `busy` here is the derived boolean the UI
// reads, `lock` is the real state. It is NOT the bare `busy` flag it looks
// like: read that module's header before touching any of this, because all
// three of its properties (a named holder, re-entrancy by explicit hand-off,
// and a stale-lock break) exist to fix a blocker that made a running app
// permanently unable to create or open a project.
//
// For an in-memory **"Untitled"** session (no project on disk — a loose clip
// opened via the file picker / MCP `open`), there is no timeline/clip concept
// at all: `SessionShot.id` is just the clip's `path` (decode-session identity
// is already path-unique there), and `addShots`/`removeShot` stay pure
// `chroma_session_*` calls with nothing persisted — the scoping doc's
// "explicitly deferred" case.
import { invoke } from '@tauri-apps/api/core';
import { trackEvent } from '@apelles/bridge';
// D-358/B-217 — this store is a process-wide singleton and must survive a Vite
// dev-mode module re-evaluation as ONE instance; `createSharedStore` is plain
// `create()` everywhere else. It is also the project-identity AUTHORITY: every
// other store that caches per-project state is measured against what this one
// holds. See `packages/store/README.md`.
import { createSharedStore, registerProjectIdentityAuthority } from '@apelles/store';
import { useEditorTimelineStore, type ProjectSettingsValue } from '@apelles/editor';

import { useEditorStore } from './useEditorStore';
import { useChromaStore, ChromaVideoInfo } from './useChromaStore';
import { useAgentStore } from './useAgentStore';
import {
  acquireSessionLock,
  type AcquireResult,
  type HeldLock,
  type LockSlot,
  type SessionLockHandle,
} from './sessionLock';
import { Adjustments, INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from '../utils/adjustments';

/** The raw per-shot shape `chroma_session_list`/`_set_active`/`_add`/`_remove`
 *  return (mirrors `chroma::session::ShotDto`). D-306: it now carries the
 *  decode session's own `clipId` — a real per-clip identity — so the store no
 *  longer has to infer one by matching source paths. `null` for an in-memory
 *  Untitled session, where the path IS the identity.
 *  `SessionShot` (below) is this plus the resolved `id`. */
interface RawShotDto {
  path: string;
  clipId: string | null;
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
 *  stable `id` — a `apelles_timeline::Clip` id for a real project's shot
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
  /** D-070: a `apelles_timeline::Clip` id, not a `ProjectShot` id — see the
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
 *
 * D-274 — a type ALIAS of `@apelles/editor`'s `ProjectSettingsValue`, not a
 * second, hand-kept-in-sync copy: that package is where the shared
 * `ProjectSettingsForm` (and its own merge-patch contract) is now defined,
 * and `app` may import from a tab package (D-039's one-way layer rule) while
 * the reverse can't. Keeping the name `ProjectSettings` here since every
 * existing call site in this file already spells it that way.
 */
export type ProjectSettings = ProjectSettingsValue;
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
  /** true while a switch / add / remove is in flight (disables the strip).
   *  Derived from `lock` and kept in lockstep with it — the UI wants a plain
   *  boolean, everything that needs to know WHO is holding it reads `lock`. */
  busy: boolean;
  /** B-132/D-268: which action currently holds the session lock, and when it
   *  took it. `null` = free. Replaces the bare `busy` boolean as the real
   *  state; see `sessionLock.ts` for why a bare flag could not work (it let a
   *  nested `_hydrateOpenDto` release its caller's lock, and it latched
   *  `true` forever behind any `await` that never settled). Reported over MCP
   *  by `get_state` so an agent can see a wedged session instead of guessing
   *  at an opaque "session busy". */
  lock: HeldLock | null;

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
   *  project this appends real `apelles_timeline::Clip`s to the active
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
  /** internal: populate the store from a chroma_project_open/new/relink/add_shot(_paths)/remove_clip result.
   *
   *  B-132/D-268 — `held` is the session lock of a caller that ALREADY holds
   *  it (every in-store caller does). Passing it is what makes this
   *  re-entrant: the hand-off means this never takes a second lock and, far
   *  more importantly, never releases its caller's. Omit it only from a true
   *  top-level caller — `SourcesPanel`'s "add to grading" — which then gets a
   *  lock of its own. */
  _hydrateOpenDto: (dto: ProjectOpenDto, held?: SessionLockHandle) => Promise<void>;
}

type SessionSet = (partial: Partial<SessionState>) => void;

/** The session lock's storage cell, backed by the store's own `lock` field.
 *  Writing `busy` alongside it is what keeps the UI's plain boolean honest —
 *  the two can never drift because this is the only place either is set. */
function lockSlot(set: SessionSet, get: () => SessionState): LockSlot {
  return {
    read: () => get().lock,
    write: (next) => set({ lock: next, busy: next !== null }),
  };
}

/** Take the session lock for `op`, or refuse with a message naming the current
 *  holder. Every guarded action starts with this and ends with
 *  `finally { held.lock.release() }`. */
function acquire(set: SessionSet, get: () => SessionState, op: string): AcquireResult {
  return acquireSessionLock(lockSlot(set, get), op);
}

/**
 * B-080 — settle the Edit tab's pending debounced timeline save **before**
 * issuing any command that changes which project the backend is pointing at.
 *
 * `chroma_timeline_set` writes onto whichever timeline is ACTIVE when it
 * arrives; it does not carry the id of the timeline it was built from. So an
 * edit still sitting on `@apelles/editor`'s 400ms save debounce when a project
 * switch goes through is not merely late — it is addressed to a document the
 * backend has already moved off, and `useEditorTimelineStore`'s own
 * `setOpenProject` has by then overwritten the only in-memory copy of it. That
 * edit existed nowhere afterwards: not on disk, not in memory, with no error
 * shown (B-083/D-203 made the cancel deterministic, which stopped it landing in
 * the WRONG project but still dropped it).
 *
 * This is the app layer's job specifically because it is the last point that
 * still runs while the OUTGOING project is the active one — the Edit store only
 * hears about a project switch after `chroma_project_open`/`_new` has already
 * happened, so from there a flush would write into the incoming project. Both
 * interfaces funnel through these same actions (the GUI launcher directly, MCP
 * via `useChromaControl.ts`), so one flush here covers both.
 *
 * A refusal, not a warning: the edit is still in memory at this point, and
 * declining the switch is the only outcome that keeps it reachable.
 */
async function flushEditTimeline(): Promise<{ ok: boolean; error?: string }> {
  const ok = await useEditorTimelineStore.getState().flushPendingSave();
  if (ok) return { ok: true };
  return {
    ok: false,
    error:
      'could not save the Edit tab’s timeline first, so the project switch was cancelled to avoid ' +
      `losing that edit: ${useEditorTimelineStore.getState().error ?? 'chroma_timeline_set failed'}`,
  };
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

/** Resolve each shot's stable `id`.
 *
 *  D-306: the decode session now reports its own `clipId`, so that is the
 *  answer whenever it is present — one identity, decided in one place
 *  (`chroma::state::ShotId`), rather than re-derived here.
 *
 *  The `previous`-by-path fallback remains for the Untitled session, whose
 *  shots genuinely have no clip id, and finally the path itself for a shot
 *  `previous` has never seen. Path-matched rather than index-matched so it
 *  stays correct even if the decode session's own Vec order shifts under us.
 *
 *  B-150/B-155: the old version had ONLY the path fallback, so two clips of one
 *  source file both resolved to whichever id happened to win the path map —
 *  one shot's grade (and its masks) could be applied to the other. */
function reattachIds(fresh: RawShotDto[], previous: SessionShot[]): SessionShot[] {
  const byPath = new Map(previous.map((s) => [s.path, s.id]));
  return fresh.map((sh) => ({ ...sh, id: sh.clipId ?? byPath.get(sh.path) ?? sh.path }));
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
 *  that caches per-project state (`@apelles/editor`'s timeline, `@apelles/motion`'s
 *  manifest, `@apelles/bridge`'s media pool), so each of them can tell "no
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

export const useSessionStore = createSharedStore<SessionState>('app.session', (set, get) => ({
  shots: [],
  activeIndex: 0,
  grades: {},
  busy: false,
  lock: null,

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
    const { shots, activeIndex } = get();
    // Both of these are decided before the lock is taken: they are pure reads
    // that mutate nothing, so refusing them must not depend on, or disturb,
    // whoever currently holds the session.
    if (index === activeIndex) return { ok: true };
    if (index < 0 || index >= shots.length) return { ok: false, error: `shot index ${index} out of range` };
    const held = acquire(set, get, 'switchToShot');
    if (!held.ok) return { ok: false, error: held.error };

    const outgoing = shots[activeIndex];
    get().stashActiveGrade();
    // flush the outgoing shot's grade to disk — autosave only ever writes the
    // active shot's grade file, so a switch is our chance to persist this one.
    void persistShotGrade(get, outgoing, get().grades[outgoing?.id]);
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
      held.lock.release();
    }
  },

  addShots: async (paths) => {
    if (!paths.length) return { ok: false, error: 'no paths' };
    const held = acquire(set, get, 'addShots');
    if (!held.ok) return { ok: false, error: held.error };
    const { projectPath, projectName } = get();

    // D-070: a real project's "+" appends real timeline clips (find-or-create
    // pool item + append a clip to the active timeline on the backend) — the
    // same action as dragging a Sources-panel item onto the Edit tab, just
    // triggered from the Colorist strip. An in-memory Untitled session (no
    // project, no timeline) keeps the old decode-session-only behaviour.
    // One lock for both branches, taken above and released in the single
    // `finally` below — the two paths are alternatives, not nested scopes.
    try {
      if (projectPath && projectName !== 'Untitled') {
        const dto = await invoke<ProjectOpenDto>('chroma_project_add_shot_paths', { paths });
        await get()._hydrateOpenDto(dto, held.lock);
        return { ok: true };
      }

      get().stashActiveGrade();
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
      held.lock.release();
    }
  },

  removeShot: async (index) => {
    const { shots, activeIndex, grades, projectPath, projectName } = get();
    if (index < 0 || index >= shots.length) return { ok: false, error: 'out of range' };
    const held = acquire(set, get, 'removeShot');
    if (!held.ok) return { ok: false, error: held.error };

    // One lock for both branches, taken above and released in the single
    // `finally` below — the two paths are alternatives, not nested scopes.
    try {
      // D-070: a real project's remove drops the clip from the active timeline.
      if (projectPath && projectName !== 'Untitled') {
        const clipId = shots[index].id;
        const dto = await invoke<ProjectOpenDto>('chroma_project_remove_clip', { clipId });
        await get()._hydrateOpenDto(dto, held.lock);
        return { ok: true };
      }

      if (index === activeIndex) get().stashActiveGrade();
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
      held.lock.release();
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

  _hydrateOpenDto: async (dto, heldByCaller) => {
    // B-132/D-268 — the re-entrancy fix. This is called from two kinds of
    // place: five in-store actions that already hold the session lock, and
    // `SourcesPanel`'s "add to grading", which holds nothing. As a bare
    // `busy` flag it could not tell them apart, so it set `busy: true` on
    // entry and cleared it in its own `finally` — which on all five in-store
    // paths released the CALLER's lock while the caller was still running,
    // leaving the rest of `newProject`/`openProject`/`addShots`/`removeShot`/
    // `relinkShot` completely unguarded. A caller now hands its lock down and
    // this takes none; `release()` is identity-checked, so this can no longer
    // drop a lock it did not take. See `sessionLock.ts`.
    //
    // D-063: a lock is taken here, not just left to each caller —
    // `SourcesPanel`'s "add to grading" calls this directly and never did,
    // which is exactly why clicking "+" on a Sources clip flashed to a
    // blank/stale preview during the real decode round trip below with zero
    // loading feedback — `Editor.tsx`'s spinner (D-063, wired to `busy`) had
    // nothing to key off.
    const own = heldByCaller ? null : acquire(set, get, '_hydrateOpenDto');
    if (own && !own.ok) {
      // A direct caller (SourcesPanel) racing a real project switch. Refusing
      // is right — hydrating on top of an in-flight open would interleave two
      // sessions — and it must be a real throw, because this returns `void`
      // and its one external caller reports failure from its own `catch`.
      throw new Error(own.error);
    }
    const lock = heldByCaller ?? (own as { ok: true; lock: SessionLockHandle }).lock;
    try {
      // the Rust session already holds the online clips (chroma_project_open
      // et al loaded them). Mirror it, then attach per-shot grades + project
      // metadata. D-070: a shot's id is a `apelles_timeline::Clip` id.
      // D-306: the decode session reports that id itself now, so `reattachIds`
      // reads it off the wire instead of matching source paths — a match that
      // returned ONE id for two clips of the same file (B-150/B-155).
      const list = await invoke<SessionDto>('chroma_session_list');
      const shotsWithId: SessionShot[] = reattachIds(list.shots, get().shots);

      const offlineShots: OfflineShot[] = dto.shots
        .filter((s) => s.offline)
        .map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.name }));

      // D-334 — ONE round trip for every shot's grade, not one per shot with
      // the `await` inside the loop. On the owner's real 75-clip recut that
      // was 75 strictly sequential IPC calls, 72 of which were for files that
      // do not exist and so came back as thrown errors; nothing below could
      // start until the last one landed. `chroma_load_grades` reads them all
      // on one blocking thread and answers once. A shot with no grade file is
      // simply absent from `grades` — the same "neutral" the per-shot `catch`
      // meant — while a grade that exists but cannot be read now lands in
      // `errors` and gets said out loud instead of silently reading as
      // ungraded, which is the one behaviour this deliberately changes.
      const grades: Record<string, Adjustments> = {};
      const online = dto.shots.filter((s) => !s.offline);
      if (online.length > 0) {
        // `adjustments` is typed as `Adjustments` rather than `unknown` because
        // that is what it is — `normalizeLoadedAdjustments` is precisely the
        // function that tolerates an older/partial on-disk shape, and it takes
        // `Adjustments`. Typing it `unknown` here would only push an `any` cast
        // onto the call below, which is what the per-shot `const g: any` this
        // replaced used to do.
        const loaded = await invoke<{
          grades: Record<string, { adjustments?: Adjustments } | null>;
          errors: Record<string, string>;
        }>('chroma_load_grades', {
          gradeDir: dto.gradeDir,
          clipIds: online.map((s) => s.id),
        });
        for (const [id, g] of Object.entries(loaded.grades)) {
          grades[id] = normalizeLoadedAdjustments(g?.adjustments ?? INITIAL_ADJUSTMENTS);
        }
        for (const [id, message] of Object.entries(loaded.errors)) {
          console.error(`[chroma] grade for clip ${id} exists but could not be loaded: ${message}`);
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
      // A no-op when the lock came from the caller (identity check in
      // `release()`) — the caller's own `finally` is what frees it.
      if (own) lock.release();
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
    // D-306 — identity off the wire, not inferred from source paths. This poll
    // runs on every Colorist tab focus, so the old path map re-derived every
    // shot's id (and therefore which grade the store thought was loaded) many
    // times a session; for two clips of one file it got that wrong every time.
    const shotsWithId: SessionShot[] = reattachIds(list.shots, get().shots);
    const offlineShots: OfflineShot[] = dto.shots
      .filter((s) => s.offline)
      .map((s) => ({ id: s.id, sourcePath: s.sourcePath, name: s.name }));

    const prevActive = get().shots[get().activeIndex];
    const newActive = shotsWithId[list.active];
    // Rust already decided whether the active clip needed to change (see
    // `chroma_project_resync_clips`'s doc) — this just detects that outcome
    // rather than re-deciding it, so the frontend and backend can't disagree.
    const activeChanged = prevActive?.id !== newActive?.id;

    // B-155 — bank the OUTGOING shot's grade before anything replaces the
    // editor's adjustments below. This is a background poll: whatever the user
    // or the agent has just done to the active shot (a mask added seconds ago,
    // an exposure nudge not yet autosaved) lives only in `useEditorStore` until
    // something stashes it, and this branch used to swap `adjustments` wholesale
    // without doing so — so that work was simply discarded, with no warning and
    // no explicit shot switch to blame it on. `switchToShot` has always done
    // this; the resync path never caught up. Done BEFORE the `set` below,
    // because `stashActiveGrade` keys off whatever is active *now*.
    if (activeChanged && prevActive) {
      const carried = useEditorStore.getState().adjustments;
      set({ grades: { ...get().grades, [prevActive.id]: carried } });
      void persistShotGrade(get, prevActive, carried);
    }

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
    const held = acquire(set, get, 'openProject');
    if (!held.ok) return { ok: false, error: held.error };
    try {
      const flushed = await flushEditTimeline();
      if (!flushed.ok) return flushed;
      const dto = await invoke<ProjectOpenDto>('chroma_project_open', { path });
      await get()._hydrateOpenDto(dto, held.lock);
      trackEvent('project_open', { shotCount: get().shots.length });
      return { ok: true, hasShots: get().shots.length > 0 || get().offlineShots.length > 0 };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      held.lock.release();
    }
  },

  closeProject: async () => {
    const { projectPath, projectName, dirty } = get();
    trackEvent('project_close', { hadUnsavedChanges: dirty });
    // B-080 — the Edit tab's own debounced timeline save, settled while this
    // project is still the active one. Best-effort here rather than a refusal
    // (unlike `openProject` above): "‹ Projects" is also the human's escape
    // hatch from a wedged session (B-132/D-268), so it must never become
    // un-clickable because a save is failing. A failure leaves its reason in
    // the Edit tab's own `error`.
    await flushEditTimeline();
    // best-effort final flush for a dirty, named project (Untitled autosave is
    // already skipped, so an Untitled session is just discarded)
    if (projectPath && projectName !== 'Untitled' && dirty) {
      try {
        await get().saveProject();
      } catch {
        /* ignore — closing anyway */
      }
    }
    // B-170 — tell the Rust side too, or its own `state::PROJECT` stays set
    // to this project indefinitely (the next open/new overwrites it, but
    // nothing else ever clears it): the launcher's own delete button reads
    // exactly that value and refuses to delete "the currently open project"
    // — from a screen that, to the human looking at it, has no project open
    // at all. Best-effort, same reasoning as the save flush above: this
    // button is also the escape hatch from a wedged session, so a failed
    // IPC call here must not block getting back to the launcher.
    try {
      await invoke('chroma_project_close');
    } catch {
      /* ignore — closing anyway */
    }
    // reset everything back to the initial store state. Autosave's debounced
    // saveProject() no-ops once projectPath is null.
    set({
      shots: [],
      activeIndex: 0,
      grades: {},
      // B-132/D-268 — the lock is dropped with everything else, so "‹ Projects"
      // is a real, human-reachable recovery from a wedged session rather than
      // a button that inherits the wedge. A still-running holder's own
      // `release()` is identity-checked and becomes a no-op, so it cannot
      // reach back in and clear a lock a LATER action has since taken.
      busy: false,
      lock: null,
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
    const held = acquire(set, get, 'newProject');
    if (!held.ok) return { ok: false, error: held.error };
    try {
      const flushed = await flushEditTimeline();
      if (!flushed.ok) return flushed;
      const dto = await invoke<ProjectOpenDto>('chroma_project_new', { name, mediaPaths });
      await get()._hydrateOpenDto(dto, held.lock);
      trackEvent('project_new', { mediaCount: mediaPaths.length });
      // write an initial thumb.jpg from the active shot
      void get().saveProject({ force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      held.lock.release();
    }
  },

  saveUntitledAs: async (name) => {
    const paths = get().shots.map((s) => s.path);
    if (!paths.length) return { ok: false, error: 'nothing to save' };
    const held = acquire(set, get, 'saveUntitledAs');
    if (!held.ok) return { ok: false, error: held.error };
    try {
      const flushed = await flushEditTimeline();
      if (!flushed.ok) return flushed;
      const dto = await invoke<ProjectOpenDto>('chroma_project_new', { name, mediaPaths: paths });
      await get()._hydrateOpenDto(dto, held.lock);
      void get().saveProject({ force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      held.lock.release();
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
    const { projectPath } = get();
    if (!projectPath) return { ok: false, error: 'no project loaded' };
    const held = acquire(set, get, 'relinkShot');
    if (!held.ok) return { ok: false, error: held.error };
    try {
      // D-070: `shotId` here is a `apelles_timeline::Clip` id (offlineShots
      // now come from the clip-derived `ProjectShotDto`) — the Rust command
      // takes `clipId`, renamed from `shotId` for the same reason.
      const dto = await invoke<ProjectOpenDto>('chroma_project_relink', {
        path: projectPath,
        clipId: shotId,
        newPath,
      });
      await get()._hydrateOpenDto(dto, held.lock);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      held.lock.release();
    }
  },
}));

/** B-217/D-358 — this store is the app's one source of truth for *which* project
 *  is open, so it is what every per-project store in every tab is checked
 *  against before an MCP op runs. Registered here, at module scope, rather than
 *  from `Root.tsx`: the guard has to be armed for any code path that can reach a
 *  store at all, not only the one that happens to render the composition root.
 *
 *  The two fields are the two halves `selectProjectKey`'s own doc explains — the
 *  Edit tab and the media pool follow the full key (non-null for an Untitled
 *  loose-clip session too), Motion follows the path (null for one). */
registerProjectIdentityAuthority(() => {
  const s = useSessionStore.getState();
  return { projectKey: selectProjectKey(s), projectPath: s.projectPath };
});
