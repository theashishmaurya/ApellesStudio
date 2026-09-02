/**
 * @chroma/bridge — the media pool (D-044/D-045/D-046, the roadmap's "media
 * pool + import + multiple timelines" item — this store's pass 3 shape).
 *
 * What it is: a typed binding over the `chroma_media_*` / `chroma_project_add_shot`
 * Tauri commands (`app/src-tauri/src/chroma/project.rs`) + a zustand store holding
 * the open project's media pool client-side, consumed by the Sources panel
 * (`app/src/components/chroma/SourcesPanel.tsx`, docked in `@chroma/shell`).
 * What it does: import (probe + pool), list, move between bins (D-045 —
 * `folder` is a plain path string, no separate bin entity), and "add to
 * grading" (D-046 — create a `ProjectShot` referencing a pool item; distinct
 * from a plain import, which stays pool-only).
 * What it does NOT do: no thumbnail generation (the panel shows a generic
 * file icon — a real thumbnail strip is a later pass), no client-side search
 * index (the panel filters `items` in memory).
 *
 * Mirrors the `MediaItem` / `MediaItemDto` split on the Rust side: what this store
 * holds is the DTO shape (`video` facts + a live `offline` flag), not the bare
 * persisted model.
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
}

interface MediaPoolState {
  items: MediaItem[];
  loading: boolean;
  error: string | null;

  /** re-read the open project's full media pool from Rust. */
  refresh: () => Promise<{ ok: boolean; error?: string }>;
  /** probe + add `paths` (referenced in place, never copied) to the open
   *  project's media pool, filed into `folder` (D-045 — omit/blank for the
   *  pool root). Already-pooled paths are skipped by the backend, not
   *  duplicated. Appends the newly-added items to `items` on success. */
  importPaths: (
    paths: string[],
    folder?: string,
  ) => Promise<{ ok: boolean; error?: string; added?: MediaItem[] }>;
  /** re-file an existing pool item into a different bin (D-045); pass
   *  `folder: null` to move it back to the pool root. Updates `items` in
   *  place on success. */
  moveToFolder: (id: string, folder: string | null) => Promise<{ ok: boolean; error?: string }>;
  // NOTE: D-046's "add to grading" action (`chroma_project_add_shot`) is
  // deliberately NOT a store action here — it needs `useSessionStore.
  // _hydrateOpenDto` (`app/src/store`), which `@chroma/bridge` cannot depend
  // on without inverting the D-039 layer direction (`app → tabs → services →
  // domain`). It lives in the app layer's `SourcesPanel.tsx` instead, the
  // same place `ProjectLauncher.tsx` already bridges Tauri commands into
  // that store.
}

export const useMediaPoolStore = create<MediaPoolState>((set) => ({
  items: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const items = await invoke<MediaItem[]>('chroma_media_list');
      set({ items, loading: false });
      return { ok: true };
    } catch (e) {
      const error = String(e);
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
      if (added.length > 0) {
        set((s) => ({ items: [...s.items, ...added] }));
      }
      return { ok: true, added };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  moveToFolder: async (id, folder) => {
    try {
      const moved = await invoke<MediaItem>('chroma_media_move', { id, folder });
      set((s) => ({ items: s.items.map((it) => (it.id === id ? moved : it)) }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));
