/**
 * @apelles/motion — manifest I/O (D-046).
 *
 * Thin wrappers around the `chroma_motion_*` Tauri commands
 * (`app/src-tauri/src/chroma/motion.rs`): get/save the current project's
 * manifest sidecar, and run a real render via the `apelles-motion` crate.
 * Pure I/O — no manifest validation here. Validation is the engine's own
 * `zod` schema (`@apelles/motion-engine`'s `manifestSchema`), applied by
 * `useMotionManifest` before a save/render is ever attempted.
 */
import { invoke } from '@tauri-apps/api/core';

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

export interface MotionRenderResult {
  outputPath: string;
  stdoutTail: string;
}

/** Render the current project's *saved* manifest — the caller must save
 *  first if dirty (`useMotionManifest.ts`'s `render()` does).
 *
 *  D-180 — `frameRange` (an inclusive `[start, end]` pair of ABSOLUTE
 *  composition frames) and `sceneId` let a caller render just ONE scene's
 *  own window instead of the whole manifest; `sceneId` alone (no explicit
 *  `outputPath`) also picks `chroma_motion_render`'s per-scene default
 *  output naming (`<project>/motion/renders/<sceneId>.mp4`) on the Rust
 *  side — this function never constructs a path itself, matching
 *  `motion.rs`'s own module doc comment ("only this side actually knows
 *  where the project lives"). Omitting both renders the whole manifest to
 *  the single pre-D-180 default path, unchanged. */
export async function renderManifest(
  outputPath?: string,
  frameRange?: [number, number],
  sceneId?: string,
): Promise<MotionRenderResult> {
  try {
    return await invoke<MotionRenderResult>('chroma_motion_render', { outputPath, frameRange, sceneId });
  } catch (e) {
    rethrow(e);
  }
}
