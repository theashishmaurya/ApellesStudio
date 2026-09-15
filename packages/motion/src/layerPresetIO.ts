/**
 * @apelles/motion — saved-layer-preset I/O and its store (D-332).
 *
 * What it is: thin wrappers around the `chroma_motion_load_layer_presets` /
 *   `chroma_motion_save_layer_presets` Tauri commands
 *   (`app/src-tauri/src/chroma/motion_presets.rs`), plus the small zustand
 *   store that holds the loaded library for the tab.
 * What it does NOT do: no preset construction, validation or list surgery —
 *   that is `layerPresets.ts`, pure and tested on its own. This file is the
 *   I/O boundary and nothing else, the same split `manifestIO.ts` keeps from
 *   `manifestEdit.ts`.
 *
 * **Why a store rather than props from `MotionTab`.** Three consumers need the
 * library — the Catalog panel (list/insert/delete), the Inspector (save), and
 * `motionOps.ts` (the four `motion_*` preset tools, which run outside React
 * and must read the CURRENT list, not one captured at mount). A store is the
 * one shape all three can reach; threading it as props would still leave the
 * ops layer without an answer.
 *
 * **Why the library is NOT project state.** It is deliberately not part of the
 * manifest, not in the undo stack, and not dirtied by a manifest edit: saving
 * a component is a change to the user's toolbox, not to the video they are
 * making. That is also why a save here writes straight through to disk rather
 * than waiting for the Motion tab's own Save button, which persists the
 * manifest and only the manifest.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { MotionLayerPreset } from './layerPresets';
import { sanitizeLoadedPresets } from './layerPresets';

/** Read the library off disk, already sanitized. Never throws for "no library
 *  yet" — the backend returns an empty list for an absent file. */
export async function loadLayerPresets(): Promise<MotionLayerPreset[]> {
  const raw = await invoke<unknown>('chroma_motion_load_layer_presets');
  return sanitizeLoadedPresets(raw);
}

/** Replace the stored library. Returns the file path the backend wrote. */
export async function saveLayerPresets(presets: readonly MotionLayerPreset[]): Promise<string> {
  return await invoke<string>('chroma_motion_save_layer_presets', { presets });
}

export interface MotionLayerPresetState {
  presets: MotionLayerPreset[];
  /** `null` until the first load resolves; a message when the last load or
   *  save failed. Surfaced in the Catalog panel rather than swallowed — a
   *  library that silently failed to load looks identical to an empty one,
   *  and the user would rebuild presets they already have. */
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
  /** Persist a NEW list, updating the store only once the write succeeds, so
   *  the panel never shows a preset that is not actually on disk. */
  commit: (next: readonly MotionLayerPreset[]) => Promise<boolean>;
}

export const useMotionLayerPresetStore = create<MotionLayerPresetState>((set) => ({
  presets: [],
  error: null,
  loaded: false,

  reload: async () => {
    try {
      const presets = await loadLayerPresets();
      set({ presets, error: null, loaded: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loaded: true });
    }
  },

  commit: async (next) => {
    try {
      await saveLayerPresets(next);
      set({ presets: [...next], error: null, loaded: true });
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
}));
