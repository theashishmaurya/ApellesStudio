/**
 * @chroma/bridge — the media pool (D-044, pass 1 of the roadmap's "media pool
 * + import + multiple timelines" item).
 *
 * What it is: a typed binding over the `chroma_media_import` / `chroma_media_list`
 * Tauri commands (`app/src-tauri/src/chroma/project.rs`) + a small zustand store
 * holding the open project's media pool client-side.
 * What it does NOT do: no bins/folders, no thumbnails, no search, no drag-to-track,
 * no docked panel UI — those are pass 2/3. This is scaffolding only: a future
 * Sources-panel component calls `useMediaPoolStore` and gets real data + a working
 * `importPaths` action; nothing here renders anything.
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
}

interface MediaPoolState {
  items: MediaItem[];
  loading: boolean;
  error: string | null;

  /** re-read the open project's full media pool from Rust. */
  refresh: () => Promise<{ ok: boolean; error?: string }>;
  /** probe + add `paths` (referenced in place, never copied) to the open
   *  project's media pool. Already-pooled paths are skipped by the backend,
   *  not duplicated. Appends the newly-added items to `items` on success. */
  importPaths: (paths: string[]) => Promise<{ ok: boolean; error?: string; added?: MediaItem[] }>;
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

  importPaths: async (paths) => {
    if (paths.length === 0) return { ok: true, added: [] };
    try {
      const added = await invoke<MediaItem[]>('chroma_media_import', { paths });
      if (added.length > 0) {
        set((s) => ({ items: [...s.items, ...added] }));
      }
      return { ok: true, added };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));
