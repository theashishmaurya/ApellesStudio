/**
 * @apelles/motion — manifest I/O (D-046).
 *
 * Thin wrappers around the `chroma_motion_*` Tauri commands
 * (`app/src-tauri/src/chroma/motion.rs`): get/save the current project's
 * manifest sidecar, and start, watch and resume the backend render job
 * (`motion_job.rs`, D-398).
 * Pure I/O — no manifest validation here. Validation is the engine's own
 * `zod` schema (`@apelles/motion-engine`'s `manifestSchema`), applied by
 * `useMotionManifest` before a save/render is ever attempted.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { MotionRenderStatus, SceneRenderJob } from './renderLoop';

/** The exact message `motion.rs::current_project_dir` rejects with. */
const NO_PROJECT_MESSAGE = 'no project open — open one in the Colorist tab';

/** Thrown by every call below when no `.chroma` project is currently open.
 *
 *  B-058: this is a *label on a backend error*, not evidence about the app's
 *  state, and nothing may treat it as the latter any more. `motionProjectStore`
 *  never calls at all while the app says no project is open, so seeing this
 *  from a `load()` means a real frontend/backend desync and is reported as the
 *  error it is. It still gives `save`/`render` a readable message for the same
 *  desync (or for a project closed mid-edit). */
export class NoProjectOpenError extends Error {
  constructor() {
    super(NO_PROJECT_MESSAGE);
    this.name = 'NoProjectOpenError';
  }
}

function rethrow(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes(NO_PROJECT_MESSAGE)) throw new NoProjectOpenError();
  throw new Error(message);
}

/** The current project's saved manifest, or `null` if none has been saved yet. */
export async function getSavedManifest(): Promise<unknown | null> {
  try {
    return await invoke<unknown | null>('chroma_motion_get_manifest');
  } catch (e) {
    rethrow(e);
  }
}

/** Persist `manifest` as the current project's motion manifest. Returns the sidecar path. */
export async function saveManifest(manifest: unknown): Promise<string> {
  try {
    return await invoke<string>('chroma_motion_save_manifest', { manifest });
  } catch (e) {
    rethrow(e);
  }
}

/** What a delivered scene is, as the app layer receives it (D-062/D-260). */
export interface MotionRenderResult {
  outputPath: string;
  stdoutTail: string;
}

/** Start a render job (D-398), or with `resume` continue the interrupted or
 *  failed one from its own manifest snapshot.
 *
 *  `manifest` is the EXACT document `windows` were computed from; the backend
 *  snapshots it and renders from the snapshot, so a manifest file changed
 *  mid-render cannot misalign the frame windows (B-264). `windows` is the set of
 *  scenes to render (B-263), each the scene's absolute inclusive frame range in
 *  the whole manifest. Resolves with the job's first status as soon as the
 *  backend worker has started; the render itself runs in the backend and keeps
 *  running through a webview reload (B-265). */
export async function startRenderJob(
  manifest: unknown,
  windows: SceneRenderJob[],
  resume: boolean,
): Promise<MotionRenderStatus> {
  try {
    return await invoke<MotionRenderStatus>('chroma_motion_job_start', { manifest, windows, resume });
  } catch (e) {
    rethrow(e);
  }
}

/** The render job's status for the open project, live while a worker is running
 *  it and read from the persisted job otherwise (so a restarted app reports
 *  `interrupted`, not a blank `idle`). */
export async function getRenderJobStatus(): Promise<MotionRenderStatus> {
  try {
    return await invoke<MotionRenderStatus>('chroma_motion_job_status');
  } catch (e) {
    rethrow(e);
  }
}

/** D-403 — render still frames of `manifest` (absolute composition frames)
 *  through the backend's Remotion `still` path; one PNG, or a contact sheet of
 *  several. `manifest` is the document as the caller has it, unsaved or not. */
export async function previewFrames(req: {
  manifest: unknown;
  frames: number[];
  scale: number;
  label: string;
}): Promise<{ path: string; width: number; height: number; columns: number; rows: number }> {
  try {
    return await invoke('chroma_motion_preview_frame', req);
  } catch (e) {
    rethrow(e);
  }
}

/** D-404 — one imported project asset (`apelles_motion::assets::AssetRecord`). */
export interface MotionAssetRecord {
  /** what a manifest writes: `sha256:<hex>.<ext>` */
  id: string;
  fileName: string;
  path: string;
  bytes: number;
  /** `false` when the same content was already in the project */
  copied: boolean;
  width: number | null;
  height: number | null;
}

/** D-404 — copy an image into the open project's asset folder, named by the
 *  SHA-256 of its bytes; resolves to the id a manifest uses. */
export async function importAsset(path: string): Promise<MotionAssetRecord> {
  try {
    return await invoke<MotionAssetRecord>('chroma_motion_import_asset', { path });
  } catch (e) {
    rethrow(e);
  }
}

/** D-404 — the open project's asset folder (made readable by the webview, so
 *  the live preview can show `image` layers through `convertFileSrc`). */
export async function getAssetsDir(): Promise<string> {
  try {
    return await invoke<string>('chroma_motion_assets_dir');
  } catch (e) {
    rethrow(e);
  }
}

/** Tell the backend a finished scene has been taken into Sources. */
export async function acknowledgeRenderedScene(sceneId: string): Promise<void> {
  try {
    await invoke<void>('chroma_motion_job_ack', { sceneId });
  } catch (e) {
    rethrow(e);
  }
}

/** Every job transition, as it happens (the `chroma://motion-render` event the
 *  backend worker emits). Resolves to the unsubscribe function. */
export async function onRenderJobStatus(handler: (status: MotionRenderStatus) => void): Promise<() => void> {
  return listen<MotionRenderStatus>('chroma://motion-render', (event) => handler(event.payload));
}
