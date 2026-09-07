/**
 * @chroma/editor — the active timeline's composition (output) pixel size,
 * with no clip selection required (D-199, `docs/notes/preview-canvas-boundary.md`).
 *
 * `chroma_timeline_composition_size` (Rust, `chroma::edit::composition_size_only`)
 * is the same `composition_size` resolver `useClipGeometry`'s
 * `chroma_timeline_clip_geometry` already calls — the project's recorded
 * output spec (D-038 `ProjectSettings`), or the timeline's first video
 * clip's own probed resolution when no explicit settings exist — but without
 * needing a clip selected first. This is what the canvas-boundary overlay
 * (`CanvasBoundary.tsx`) and the canvas-settings popover
 * (`CanvasSettingsPopover.tsx`) both need: a persistent, selection-independent
 * answer to "what IS the output frame," not a per-clip fact.
 *
 * Refetches whenever `timeline` changes identity (every `applyOp`/`load()`,
 * per `PreviewPane.tsx`'s own module doc) — a `set_project_settings` write
 * doesn't itself touch the timeline, so a caller applying one MUST also bump
 * a `refreshToken` (see `CanvasSettingsPopover.tsx`) or the popover's own
 * write path needs to force this hook to re-run; done here by accepting an
 * optional extra dependency value.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Mirrors `chroma::edit::ClipGeometry` (`#[serde(rename_all = "camelCase")]`)
 *  — the Rust command deliberately reuses that DTO's shape (see its own doc)
 *  rather than inventing a second, near-identical one; `naturalWidth`/
 *  `naturalHeight` are always `1.0` here (no clip involved) and unused by
 *  this hook's own callers. */
interface CompositionSizeResponse {
  compWidth: number;
  compHeight: number;
}

export interface CompositionSize {
  width: number;
  height: number;
}

/** `null` while unresolved — no timeline yet, still loading, or the
 *  resolver failed (e.g. an empty timeline with no clip to derive a size
 *  from and no explicit `ProjectSettings` either — the same "nothing to
 *  show yet" a fresh, empty Edit tab is in). `extraDep` is compared by
 *  reference/value like any other effect dependency — pass a changing
 *  token after a settings write to force a refetch without waiting for the
 *  next timeline edit. */
export function useCompositionSize(
  hasTimeline: boolean,
  extraDep?: unknown,
): CompositionSize | null {
  const [size, setSize] = useState<CompositionSize | null>(null);

  useEffect(() => {
    if (!hasTimeline) {
      setSize(null);
      return;
    }
    let cancelled = false;
    invoke<CompositionSizeResponse>('chroma_timeline_composition_size')
      .then((g) => {
        if (!cancelled) setSize({ width: g.compWidth, height: g.compHeight });
      })
      .catch(() => {
        if (!cancelled) setSize(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTimeline, extraDep]);

  return size;
}
