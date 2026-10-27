/**
 * @apelles/motion — the template library's I/O and its store (D-407).
 *
 * What it is: wrappers around `chroma_motion_load_templates` /
 * `chroma_motion_save_template` / `chroma_motion_delete_template`
 * (`app/src-tauri/src/chroma/motion_presets.rs`, backed by
 * `apelles_motion::templates`: one `<app data>/motion/templates/<id>.json` per
 * template, written atomically) and the store that holds the loaded library
 * for the tab — the `themeLibraryIO.ts` shape, for the same reason: the
 * Catalog panel, the dialogs and `motionOps.ts`'s tools all need the CURRENT
 * list, and one of them runs outside React.
 *
 * Unlike the theme library this saves and deletes ONE template per call
 * (one file each), so a write can never rewrite a template it did not touch.
 *
 * What it does NOT do: validation (`templateLibrary.ts`), instantiation, or
 * manifest writes. The library is user-level state, not part of any document
 * and not in the undo stack.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { MotionTemplate } from '@apelles/motion-engine/src/templateDef';
import {
  sanitizeLoadedTemplates,
  upsertTemplate,
  type RawTemplateLibrary,
  type TemplateLoadError,
} from './templateLibrary';

/** The library off disk: the usable templates and one error per bad file. */
export async function loadTemplates(): Promise<{ templates: MotionTemplate[]; errors: TemplateLoadError[] }> {
  return sanitizeLoadedTemplates(await invoke<RawTemplateLibrary>('chroma_motion_load_templates'));
}

/** Write one template (`<id>.json`, atomically); returns the file path. */
export async function saveTemplateFile(template: MotionTemplate): Promise<string> {
  return await invoke<string>('chroma_motion_save_template', { template });
}

/** Remove one template's file; `false` when there was none. */
export async function deleteTemplateFile(id: string): Promise<boolean> {
  return await invoke<boolean>('chroma_motion_delete_template', { id });
}

export interface MotionTemplateLibraryState {
  templates: MotionTemplate[];
  /** per-file load problems (each bad file named), shown in the Catalog */
  loadErrors: TemplateLoadError[];
  /** the last load/save/delete failure */
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
  /** persist one template; the store changes only once the write succeeded */
  save: (template: MotionTemplate) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

export const useMotionTemplateLibraryStore = create<MotionTemplateLibraryState>((set, get) => ({
  templates: [],
  loadErrors: [],
  error: null,
  loaded: false,

  reload: async () => {
    try {
      const { templates, errors } = await loadTemplates();
      set({ templates, loadErrors: errors, error: null, loaded: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loaded: true });
    }
  },

  save: async (template) => {
    try {
      await saveTemplateFile(template);
      set({ templates: upsertTemplate(get().templates, template), error: null });
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  remove: async (id) => {
    try {
      const removed = await deleteTemplateFile(id);
      set({ templates: get().templates.filter((t) => t.id !== id), error: null });
      return removed;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
}));
