/**
 * @apelles/brand — the Tauri boundary and the store the panel and the ops share
 * (D-416).
 *
 * What it is: one wrapper per `chroma_brand_*` command (`app/src-tauri/src/
 * chroma/brand.rs`) and `useBrandStore`, which holds the loaded library and the
 * open project's kit snapshot for the Brand panel. The `brand_*` ops call the
 * same store actions, so a person and an agent save, delete and set kits
 * through one path.
 *
 * What it does NOT do: validate (`kit.ts`), apply a kit to a tab (`appliers.ts`).
 * Neither the library nor the snapshot is in the undo stack: a kit is user-level
 * data and setting a project's kit is a file copy; what a kit DOES to a tab's
 * document is applied separately, one undo step per tab.
 */
import { invoke } from '@tauri-apps/api/core';
import { createSharedStore } from '@apelles/store';
import { parseBrandKit, versionForSave, type BrandKit } from './kit';
import { sanitizeLoadedKits, type KitLoadError, type LoadedKitLibrary } from './library';

/** One file in the brand asset store, mirroring `apelles_brand::assets::BrandAsset`. */
export interface BrandAsset {
  id: string;
  fileName: string;
  path: string;
  bytes: number;
  kind: 'image' | 'video' | 'font' | 'lut' | 'audio';
  copied: boolean;
  sourceName: string;
}

/** What setting a project's kit copied, mirroring `apelles_brand::project::InstallReport`. */
export interface InstallReport {
  kitPath: string;
  assetsDir: string;
  assets: string[];
  copied: number;
}

export async function loadKits(): Promise<{ kits: BrandKit[]; loadErrors: KitLoadError[] }> {
  return sanitizeLoadedKits(await invoke<LoadedKitLibrary>('chroma_brand_load_kits'));
}

export async function writeKit(kit: BrandKit): Promise<string> {
  return await invoke<string>('chroma_brand_save_kit', { kit });
}

export async function removeKit(id: string): Promise<boolean> {
  return await invoke<boolean>('chroma_brand_delete_kit', { id });
}

export async function importBrandAsset(path: string): Promise<BrandAsset> {
  return await invoke<BrandAsset>('chroma_brand_import_asset', { path });
}

export async function brandAssetsDir(): Promise<string> {
  return await invoke<string>('chroma_brand_assets_dir');
}

/** The project's snapshot, parsed. A file that no longer parses is an error. */
export async function readProjectKit(): Promise<BrandKit | null> {
  const raw = await invoke<unknown>('chroma_brand_project_get');
  if (raw === null || raw === undefined) return null;
  const parsed = parseBrandKit(raw);
  if ('kit' in parsed) return parsed.kit;
  throw new Error(`the project's brand kit (brand/kit.json) is not valid: ${parsed.error}`);
}

export async function writeProjectKit(kit: BrandKit | null): Promise<InstallReport | null> {
  return await invoke<InstallReport | null>('chroma_brand_project_set', { kit });
}

export async function projectBrandAssetsDir(): Promise<string> {
  return await invoke<string>('chroma_brand_project_assets_dir');
}

export interface BrandStoreState {
  kits: BrandKit[];
  loadErrors: KitLoadError[];
  loaded: boolean;
  /** the last library/project failure, shown rather than swallowed */
  error: string | null;
  /** the open project's active kit (its own copy) */
  project: BrandKit | null;
  /** the project directory `project` belongs to (null: none open) */
  openProjectPath: string | null;
  reload: () => Promise<void>;
  /** The open project changed: drop the old kit and read the new one's. */
  setOpenProject: (path: string | null) => Promise<void>;
  loadProject: () => Promise<BrandKit | null>;
  /** Save `kit` as the next version of its id; resolves to what was written. */
  saveKit: (kit: BrandKit) => Promise<BrandKit>;
  deleteKit: (id: string) => Promise<boolean>;
  /** Copy `kit` into the open project as its active kit, or clear it (`null`). */
  setProjectKit: (kit: BrandKit | null) => Promise<InstallReport | null>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useBrandStore = createSharedStore<BrandStoreState>('brand.kits', (set, get) => ({
  kits: [],
  loadErrors: [],
  loaded: false,
  error: null,
  project: null,
  openProjectPath: null,

  setOpenProject: async (path) => {
    if (path === get().openProjectPath) return;
    set({ openProjectPath: path, project: null });
    if (!path) return;
    try {
      const project = await readProjectKit();
      // A newer switch may have landed while this read was in flight.
      if (get().openProjectPath === path) set({ project, error: null });
    } catch (e) {
      if (get().openProjectPath === path) set({ error: message(e) });
    }
  },

  reload: async () => {
    try {
      const { kits, loadErrors } = await loadKits();
      set({ kits, loadErrors, loaded: true, error: null });
    } catch (e) {
      set({ error: message(e), loaded: true });
    }
  },

  loadProject: async () => {
    try {
      const project = await readProjectKit();
      set({ project, error: null });
      return project;
    } catch (e) {
      set({ project: null, error: message(e) });
      throw e;
    }
  },

  saveKit: async (kit) => {
    // The version is decided against the library ON DISK: an unloaded store
    // would otherwise restart a kit at version 1 over a newer file.
    if (!get().loaded) await get().reload();
    const current = get().kits.find((k) => k.id === kit.id);
    const next: BrandKit = { ...kit, version: versionForSave(current?.version) };
    await writeKit(next);
    const kits = [...get().kits.filter((k) => k.id !== next.id), next].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    set({ kits, error: null });
    return next;
  },

  deleteKit: async (id) => {
    const removed = await removeKit(id);
    set({ kits: get().kits.filter((k) => k.id !== id) });
    return removed;
  },

  setProjectKit: async (kit) => {
    const report = await writeProjectKit(kit);
    set({ project: kit, error: null });
    return report;
  },
}));
