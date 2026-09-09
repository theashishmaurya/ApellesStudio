/**
 * @apelles/bridge — the media pool (D-044/D-045/D-046/D-059, the roadmap's
 * "media pool + import + multiple timelines" item — this store's pass 4
 * shape).
 *
 * What it is: a typed binding over the `chroma_media_*` / `chroma_project_add_shot`
 * Tauri commands (`app/src-tauri/src/chroma/project.rs`) + a zustand store holding
 * the open project's media pool client-side, consumed by the Sources panel
 * (`app/src/components/chroma/SourcesPanel.tsx`, docked in `@apelles/shell`).
 * What it does: import (probe + pool), list, move between bins (D-045 —
 * `folder` is a plain path string, no separate bin entity), create a new,
 * possibly-still-empty bin (D-059 — `chroma_media_create_folder`, distinct
 * from a folder only *implied* by an item's `folder` string), and "add to
 * grading" (D-046 — create a `ProjectShot` referencing a pool item; distinct
 * from a plain import, which stays pool-only).
 * Which project's pool it holds is pushed in from the composition root
 * (`app/src/Root.tsx` → `setOpenProject`, B-083/D-203), the same one-input
 * shape both tab stores use; the panel no longer fetches it itself.
 * What it does NOT do: no client-side search index (the panel filters `items`
 * in memory). Thumbnail generation (D-059) happens Rust-side at import time —
 * this store just carries whatever `thumb` `chroma_media_list`/`_import`
 * return, it does not generate or cache anything itself.
 *
 * Mirrors the `MediaItem` / `MediaItemDto` split on the Rust side: what this store
 * holds is the DTO shape (`video` facts + a live `offline` flag + a live `thumb`),
 * not the bare persisted model.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/** Mirrors `chroma::project::MediaVideoInfo` (serde camelCase). */
export interface MediaVideoInfo {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSecs: number;
  /** D-129 — whether this source has a decodeable audio stream. The Edit tab
   *  reads it at drop time to decide whether the dropped clip gets a linked
   *  audio half (`@apelles/editor`'s `linkedClipsFromDraggedMedia`).
   *  **Absent/`null` means "not probed for this yet", NOT "silent"** — a pool
   *  item imported before D-129 has no value until `chroma_media_list`'s
   *  one-time backfill resolves it (see the Rust field's own doc). Treated
   *  conservatively as "no audio half" while it's unknown. */
  hasAudio?: boolean | null;
  /** B-101/D-269 — the source's own audio channel count (`0` for a silent
   *  source). The export compiler reads it to know whether a clip is **mono**,
   *  which decides how it is adapted to stereo before a pan: a mono source is
   *  duplicated into both channels at unity, matching the live mixer's own
   *  `adapt_channels` and the 0 dB-centre pan law.
   *
   *  **Absent/`null` means "not probed for this yet", NOT "silent"** — same
   *  sentinel discipline as `hasAudio` above, resolved by `chroma_media_list`'s
   *  one-time backfill. Treated as "channel count unknown" (keep the pre-fix
   *  upmix) while it is, never guessed. */
  audioChannels?: number | null;
}

/** Mirrors `chroma::project::MediaItemDto` (serde camelCase). */
export interface MediaItem {
  id: string;
  sourcePath: string;
  name: string;
  /** RFC-3339 import time */
  added: string;
  /** absent when the source failed to probe at import time */
  video?: MediaVideoInfo | null;
  /** the source path is missing (or not a video) right now */
  offline: boolean;
  /** the bin this item is filed in (D-045); `null`/absent = the pool root */
  folder?: string | null;
  /** `data:image/jpeg;base64,…` poster-frame thumbnail (D-059); absent when
   *  nothing has been cached yet (generation failed at import time, or the
   *  item predates D-059 and hasn't been re-imported) — the panel falls back
   *  to a placeholder icon. */
  thumb?: string | null;
  /** D-260 — the id of the Motion scene whose render wrote this file; absent
   *  for every pool item that isn't a Motion render (nearly all of them).
   *  This is the entire Motion→Edit link: a clip's `mediaId`/`sourcePath`
   *  reaches the pool item, and the pool item names the scene. See the Rust
   *  field's own doc (`apelles_project::manifest::MediaItem::motion_scene_id`)
   *  for why provenance lives on the pool item and not on the clip. */
  motionSceneId?: string | null;
}

interface MediaPoolState {
  items: MediaItem[];
  /** every known bin path (D-059) — union of explicitly-created folders and
   *  folders implied by items' `folder` strings (D-045's original model);
   *  what the Sources panel's tree is actually built from. */
  folders: string[];
  loading: boolean;
  error: string | null;
  /** **Which** project this pool belongs to — the composition root's own
   *  identity key for it (`app/src/store/useSessionStore.ts`'s
   *  `selectProjectKey`), `null` when none is open (B-083/D-203). */
  openProjectKey: string | null;

  /** The one signal that says which project's pool this is. Idempotent per
   *  key; a DIFFERENT key drops everything cached here (it is the outgoing
   *  project's media) and re-reads.
   *
   *  B-083/D-203 — the Sources panel used to fire the initial `refresh()`
   *  itself, off a bare "is a project open" boolean, which never changes when
   *  one project is swapped for another. So after an `open_project`/
   *  `new_project` switch this store still held project A's items — the array
   *  `editor_add_clip` resolves `mediaId`/`sourcePath` against (B-084). */
  setOpenProject: (key: string | null) => void;
  /** re-read the open project's full media pool (+ folder list) from Rust. */
  refresh: () => Promise<{ ok: boolean; error?: string }>;
  /** probe + add `paths` (referenced in place, never copied) to the open
   *  project's media pool, filed into `folder` (D-045 — omit/blank for the
   *  pool root). Already-pooled paths are skipped by the backend, not
   *  duplicated. Appends the newly-added items to `items` on success. */
  importPaths: (
    paths: string[],
    folder?: string,
  ) => Promise<{ ok: boolean; error?: string; added?: MediaItem[] }>;
  /** D-260 — reconcile the pool with what is on disk for `paths`: add any not
   *  pooled yet, RE-READ (probe + thumbnail) any that already are, and stamp
   *  `motionSceneId` on every one of them when given. Resolves to every item
   *  touched, added and refreshed alike, merged into `items` **by id** (not
   *  appended — a refreshed item is already in the array, and appending it
   *  would duplicate the row in the Sources panel).
   *
   *  The complement of `importPaths`, which by design SKIPS a path already in
   *  the pool. That is right for importing the same file twice and wrong for a
   *  file replaced in place — a Motion re-render writes the same per-scene path
   *  with new content, leaving the pool's probed `video` and cached thumbnail
   *  describing the previous render (B-128). Cheap on an unchanged file: the
   *  backend re-probes through an `(mtime, len)` memo and regenerates a
   *  thumbnail only when the source is newer than it. */
  refreshPaths: (
    paths: string[],
    motionSceneId?: string,
  ) => Promise<{ ok: boolean; error?: string; items?: MediaItem[] }>;
  /** B-073 — **re-probe** the pool items named by `ids` and merge whatever
   *  comes back into `items` by id. The repair action for an item whose first
   *  probe failed (offline drive, a file still being written, a transient
   *  `ffprobe` error): such an item is pooled with no `video` block, which
   *  makes it unusable (`editor_add_clip` has no frame count to place a clip
   *  with) and, before this, unrepairable — re-importing the same path deduped
   *  to a no-op and nothing else ever re-read it.
   *
   *  Addressed by **id**, not path, because that is the handle a caller
   *  looking at one bad row actually has (`refreshPaths` above is the same
   *  work addressed the other way, for the Motion re-render that knows a file
   *  and not a pool item; both go through one Rust implementation).
   *
   *  On demand only — never fired for the whole pool by a listing. A source
   *  that is still unavailable comes back unchanged and still unusable, never
   *  falsely marked probed. */
  reprobeMedia: (ids: string[]) => Promise<{ ok: boolean; error?: string; items?: MediaItem[] }>;
  /** re-file an existing pool item into a different bin (D-045); pass
   *  `folder: null` to move it back to the pool root. Updates `items` in
   *  place on success. */
  moveToFolder: (id: string, folder: string | null) => Promise<{ ok: boolean; error?: string }>;
  /** remove one or more items from the pool in a single round trip
   *  (D-060/D-061 — a batch, not a single id, so the panel's multi-select
   *  "Delete N" doesn't do one disk write per item). Does not touch the
   *  file on disk (media is always referenced in place, never owned by the
   *  project), only the pool's reference to it + its cached thumbnail. An
   *  id no longer in the pool is silently skipped, not an error. Removes
   *  every requested id from `items` in place on success. */
  removeMedia: (ids: string[]) => Promise<{ ok: boolean; error?: string }>;
  /** register a new, possibly-still-empty bin path (D-059) — the Sources
   *  panel's "New Folder" action. Idempotent; replaces `folders` with the
   *  backend's fresh (deduped, sorted) list on success. */
  createFolder: (path: string) => Promise<{ ok: boolean; error?: string }>;
  // NOTE: D-046's "add to grading" action (`chroma_project_add_shot`) is
  // deliberately NOT a store action here — it needs `useSessionStore.
  // _hydrateOpenDto` (`app/src/store`), which `@apelles/bridge` cannot depend
  // on without inverting the D-039 layer direction (`app → tabs → services →
  // domain`). It lives in the app layer's `SourcesPanel.tsx` instead, the
  // same place `ProjectLauncher.tsx` already bridges Tauri commands into
  // that store.
}

/** B-083/D-203 — monotonic `refresh()` token. A project switch fires a refresh
 *  while an earlier one (the Sources panel's own, an import's fallback) may
 *  still be in flight; without this the slower call wins by writing last, and
 *  the outgoing project's pool lands on top of the incoming project's. Same
 *  guard, for the same reason, as `@apelles/editor`'s `timelineStore` `load()`
 *  (B-034/D-112). */
let refreshToken = 0;

/** Merge `incoming` into `existing` **by id**: an item already in the list is
 *  replaced in place (order preserved, so the Sources panel does not reshuffle
 *  under the cursor), one that isn't is appended.
 *
 *  Shared by every action that can return a MIX of new and already-known items
 *  — `refreshPaths` (D-260) and `reprobeMedia`/`importPaths` (B-073). Appending
 *  blindly would duplicate the row for the already-known half, which is the
 *  exact failure `refreshPaths`' own doc warned about; extracted here rather
 *  than copied a third time. */
function mergeById(existing: MediaItem[], incoming: MediaItem[]): MediaItem[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(incoming.map((it) => [it.id, it]));
  const merged = existing.map((it) => byId.get(it.id) ?? it);
  const known = new Set(existing.map((it) => it.id));
  return [...merged, ...incoming.filter((it) => !known.has(it.id))];
}

export const useMediaPoolStore = create<MediaPoolState>((set, get) => ({
  items: [],
  folders: [],
  loading: false,
  error: null,
  openProjectKey: null,

  setOpenProject: (key) => {
    if (get().openProjectKey === key) return;
    refreshToken += 1; // orphan any read still in flight from the old project
    set({ openProjectKey: key, items: [], folders: [], error: null, loading: key !== null });
    if (key === null) return;
    void get().refresh();
  },

  refresh: async () => {
    const token = ++refreshToken;
    set({ loading: true, error: null });
    try {
      const [items, folders] = await Promise.all([
        invoke<MediaItem[]>('chroma_media_list'),
        invoke<string[]>('chroma_media_folders'),
      ]);
      if (token !== refreshToken) return { ok: true }; // superseded — a newer read owns the pool
      set({ items, folders, loading: false });
      return { ok: true };
    } catch (e) {
      const error = String(e);
      if (token !== refreshToken) return { ok: false, error };
      set({ loading: false, error });
      return { ok: false, error };
    }
  },

  importPaths: async (paths, folder) => {
    if (paths.length === 0) return { ok: true, added: [] };
    try {
      const added = await invoke<MediaItem[]>('chroma_media_import', {
        paths,
        folder: folder && folder.trim() ? folder : null,
      });
      // B-073 — merged by id, not appended: `chroma_media_import` may now
      // return an item that is ALREADY in the pool (one whose first probe
      // failed and that this call re-probed successfully), and appending it
      // would show the same media twice in the Sources panel.
      set((s) => ({ items: mergeById(s.items, added) }));
      return { ok: true, added };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  reprobeMedia: async (ids) => {
    if (ids.length === 0) return { ok: true, items: [] };
    try {
      const items = await invoke<MediaItem[]>('chroma_media_reprobe', { ids });
      set((s) => ({ items: mergeById(s.items, items) }));
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  refreshPaths: async (paths, motionSceneId) => {
    if (paths.length === 0) return { ok: true, items: [] };
    try {
      const items = await invoke<MediaItem[]>('chroma_media_refresh', {
        paths,
        motionSceneId: motionSceneId ?? null,
      });
      // Merge by id, never append: a refreshed item is already in `items`,
      // and an added one is not. Order preserved for the existing rows so the
      // Sources panel doesn't reshuffle under the cursor.
      set((s) => ({ items: mergeById(s.items, items) }));
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  moveToFolder: async (id, folder) => {
    try {
      const moved = await invoke<MediaItem>('chroma_media_move', { id, folder });
      set((s) => ({ items: s.items.map((it) => (it.id === id ? moved : it)) }));
      if (folder && folder.trim()) {
        set((s) => (s.folders.includes(folder) ? s : { folders: [...s.folders, folder].sort() }));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  removeMedia: async (ids) => {
    if (ids.length === 0) return { ok: true };
    try {
      await invoke('chroma_media_remove', { ids });
      const idSet = new Set(ids);
      set((s) => ({ items: s.items.filter((it) => !idSet.has(it.id)) }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  createFolder: async (path) => {
    try {
      const folders = await invoke<string[]>('chroma_media_create_folder', { path });
      set({ folders });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));
