/**
 * @apelles/motion — the saved-theme library's I/O and its store (D-399).
 *
 * What it is: wrappers around `chroma_motion_load_themes` /
 * `chroma_motion_save_themes` (`app/src-tauri/src/chroma/motion_presets.rs`)
 * and the small store that holds the loaded library for the tab. The exact
 * shape of `layerPresetIO.ts`, for the exact reasons it states: three
 * consumers (the theme editor, the Theme picker, `motionOps.ts`'s tools) need
 * the CURRENT list and one of them runs outside React.
 *
 * What it does NOT do: list surgery or validation (`themeLibrary.ts`), and no
 * manifest writes. The library is user-level state, not part of any document
 * and not in the undo stack: a project that uses a library theme carries its own
 * copy (`manifest.themeDef`), which is what keeps a render deterministic.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { sanitizeLoadedThemes, type ThemeDef } from './themeLibrary';

/** The library off disk, already sanitised. An absent file is an empty list. */
export async function loadThemes(): Promise<ThemeDef[]> {
  return sanitizeLoadedThemes(await invoke<unknown>('chroma_motion_load_themes'));
}

/** Replace the stored library; returns the file path written. */
export async function saveThemes(themes: readonly ThemeDef[]): Promise<string> {
  return await invoke<string>('chroma_motion_save_themes', { themes });
}

export interface MotionThemeLibraryState {
  themes: ThemeDef[];
  /** the last load/save failure, surfaced rather than swallowed (a library that
   *  silently failed to load looks identical to an empty one). */
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
  /** Persist a NEW list; the store changes only once the write succeeded. */
  commit: (next: readonly ThemeDef[]) => Promise<boolean>;
}

export const useMotionThemeLibraryStore = create<MotionThemeLibraryState>((set) => ({
  themes: [],
  error: null,
  loaded: false,

  reload: async () => {
    try {
      set({ themes: await loadThemes(), error: null, loaded: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loaded: true });
    }
  },

  commit: async (next) => {
    try {
      await saveThemes(next);
      set({ themes: [...next], error: null, loaded: true });
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
}));
