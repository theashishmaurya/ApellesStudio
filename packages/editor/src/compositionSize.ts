/**
 * @apelles/editor — the active project's COMPOSITION (output) pixel size, as a
 * module-level value the SYNCHRONOUS export compiler can read (B-208/D-353).
 *
 * **What it is:** a thin wrapper over `chroma_timeline_composition_size`
 * (`chroma::edit::composition_size_only`, D-199) — the project's recorded
 * output spec (D-038 `ProjectSettings`), or the timeline's first real video
 * clip's own probed resolution when no explicit settings exist.
 *
 * **What it is for.** `compileEditorExportArgs` must hand
 * `TimelineExportOptions.sourceFootprints` a clip's source resolution *as a
 * fraction of the composition*, and it is synchronous (the export queue
 * compiles a job's argv at ENQUEUE time — D-198). So the async answer has to
 * already be in memory by the time it runs. That is the same shape, and the
 * same reason, as `textFonts.ts`, `captionMetrics.ts` and `gradeLuts.ts`:
 * `warm…()` from the async entry point, read the snapshot synchronously in
 * the compiler.
 *
 * **It refetches on every warm, deliberately** — unlike `textFonts.ts`, whose
 * catalogue is static machine data. The composition size changes whenever
 * `ProjectSettings` is written (from the Edit tab's own panel, from the
 * Colorist modal, or from MCP's `set_project_settings`) and whenever the
 * timeline's first video clip changes; a cache that answered from the first
 * fetch would quietly compile an export against a size the project no longer
 * has. Concurrent callers still share one in-flight request.
 *
 * **What it does NOT do:** no React state, no event subscription, no fallback
 * invention. `useCompositionSize.ts` remains the LIVE, event-subscribed view
 * for on-screen surfaces (the canvas-boundary overlay); this is the one-shot
 * read for compile time. A failed or unresolvable fetch is `null` — "there is
 * no composition size right now" (an empty timeline with no clip to derive one
 * from and no explicit settings) — never a guessed number, so a caller decides
 * for itself what to do about it rather than being handed a plausible lie.
 */
import { invoke } from '@tauri-apps/api/core';

export interface CompositionSizeValue {
  width: number;
  height: number;
}

/** Mirrors `chroma::edit::ClipGeometry` (`#[serde(rename_all = "camelCase")]`).
 *  The command reuses that DTO rather than inventing a second near-identical
 *  one; its `naturalWidth`/`naturalHeight` are always `1.0` with no clip
 *  involved and are unused here. */
interface CompositionSizeResponse {
  compWidth: number;
  compHeight: number;
}

let cached: CompositionSizeValue | null = null;
let inflight: Promise<CompositionSizeValue | null> | null = null;

/** Fetch the composition size and publish it for [`compositionSizeSnapshot`].
 *
 *  Idempotent per call site and concurrency-safe: parallel callers share one
 *  in-flight request. Resolves to `null` (and clears the snapshot) when the
 *  backend cannot answer, so a later call retries rather than inheriting a
 *  stale success. */
export async function warmCompositionSize(): Promise<CompositionSizeValue | null> {
  if (!inflight) {
    inflight = invoke<CompositionSizeResponse>('chroma_timeline_composition_size')
      .then((g) => {
        const value =
          g.compWidth > 0 && g.compHeight > 0 ? { width: g.compWidth, height: g.compHeight } : null;
        cached = value;
        return value;
      })
      .catch(() => {
        cached = null;
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** The last warmed composition size, or `null` if none has resolved (or the
 *  last warm failed). Synchronous — this is the whole point of the module. */
export function compositionSizeSnapshot(): CompositionSizeValue | null {
  return cached;
}
