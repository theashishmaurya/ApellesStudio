/**
 * @apelles/motion — the custom-component library's I/O and its store (D-409).
 *
 * What it is: typed wrappers around the Tauri commands in
 * `app/src-tauri/src/chroma/motion_components.rs` (backed by
 * `apelles_motion::components`) and the zustand store that holds the loaded
 * library for the tab — the `templateLibraryIO.ts` shape, for the same reason:
 * the Catalog's Custom section and `motionOps.ts`'s tools need the CURRENT
 * list, and the ops run outside React.
 *
 * Every write goes through the backend, which owns the files: `write` runs the
 * static check in Node and stores a draft only when it passes; `prove` renders
 * the certification proof in the renderer process; `certify` seals a proven
 * draft; `install` copies a certified module into the open project's assets;
 * `proxy` renders one custom layer's frames for the live player.
 *
 * What it does NOT do: validate a spec (`customComponents.ts` does, before
 * `write`), run component code (never in the webview, D-409), or touch a
 * manifest.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { ComponentSpec } from '@apelles/motion-engine/src/custom/componentDef';
import type { ValidationIssue } from '@apelles/motion-engine/src/engine/validate';
import {
  sanitizeComponentLibrary,
  type ComponentLoadError,
  type ListedComponent,
  type ProofPlan,
  type RawComponentLibrary,
} from './customComponents';
import type { MotionComponentAccess } from './customComponentActions';

/** The static check's report (the compiled module is kept by the backend). */
export interface ComponentCheckReport {
  ok: boolean;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** `chroma_motion_write_component`'s answer. */
export interface ComponentWriteResult {
  check: ComponentCheckReport;
  /** the stored draft; absent when the check failed or for a dry run */
  draft?: { id: string; version: number; replaced: boolean; dir: string; meta: unknown };
}

/** `chroma_motion_prove_component`'s answer. */
export interface ComponentProofResult {
  proof: {
    ok: boolean;
    sourceHash: string;
    codeHash: string;
    frames: { variant: string; frame: number; hashes: string[]; same: boolean }[];
    passes: string[];
    error?: string;
  };
  contactSheet: string | null;
  thumbnail: string | null;
  recorded: boolean;
}

/** `chroma_motion_install_component`'s answer. */
export interface ComponentInstallResult {
  code: string;
  source: string;
  codeHash: string;
  sourceHash: string;
  meta: unknown;
}

/** `chroma_motion_component_proxy`'s answer. */
export interface ComponentProxyResult {
  dir: string;
  files: string[];
  cached: boolean;
}

export async function loadComponents(): Promise<{ entries: ListedComponent[]; errors: ComponentLoadError[] }> {
  return sanitizeComponentLibrary(await invoke<RawComponentLibrary>('chroma_motion_load_components'));
}

export async function readComponent(id: string, version: number): Promise<{ dir: string; meta: unknown; source: string }> {
  return await invoke('chroma_motion_read_component', { id, version });
}

export async function writeComponent(spec: ComponentSpec, source: string, dryRun: boolean): Promise<ComponentWriteResult> {
  return await invoke<ComponentWriteResult>('chroma_motion_write_component', { spec, source, dryRun });
}

export async function proveComponent(id: string, version: number, plan: ProofPlan): Promise<ComponentProofResult> {
  return await invoke<ComponentProofResult>('chroma_motion_prove_component', { id, version, plan });
}

export async function certifyComponent(id: string, version: number): Promise<unknown> {
  return await invoke('chroma_motion_certify_component', { id, version });
}

export async function deleteComponent(id: string, version: number | null): Promise<number> {
  return await invoke<number>('chroma_motion_delete_component', { id, version });
}

export async function installComponent(id: string, version: number): Promise<ComponentInstallResult> {
  return await invoke<ComponentInstallResult>('chroma_motion_install_component', { id, version });
}

export async function renderComponentProxy(manifest: unknown, scale: number): Promise<ComponentProxyResult> {
  return await invoke<ComponentProxyResult>('chroma_motion_component_proxy', { manifest, scale });
}

/** Make the library folders readable by the webview (contact sheets). */
export async function allowComponentDirs(): Promise<void> {
  await invoke('chroma_motion_components_dirs');
}

/** The live `MotionComponentAccess` both the ops (`useMotionControl.ts`) and
 *  the Catalog's Custom section (`MotionTab.tsx`) use: the store for reads,
 *  the commands above for everything else. */
export function componentAccess(): MotionComponentAccess {
  const store = useMotionComponentLibraryStore;
  return {
    list: () => store.getState().entries,
    loadErrors: () => store.getState().loadErrors,
    reload: () => store.getState().reload(),
    read: readComponent,
    write: writeComponent,
    prove: proveComponent,
    certify: certifyComponent,
    remove: deleteComponent,
    install: installComponent,
  };
}

export interface MotionComponentLibraryState {
  entries: ListedComponent[];
  loadErrors: ComponentLoadError[];
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
}

export const useMotionComponentLibraryStore = create<MotionComponentLibraryState>((set) => ({
  entries: [],
  loadErrors: [],
  error: null,
  loaded: false,
  reload: async () => {
    try {
      const { entries, errors } = await loadComponents();
      set({ entries, loadErrors: errors, error: null, loaded: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loaded: true });
    }
  },
}));
