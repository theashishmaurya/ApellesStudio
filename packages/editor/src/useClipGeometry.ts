/**
 * @chroma/editor — shared clip-geometry fetch (D-136 origin, extracted D-186).
 *
 * `chroma_timeline_clip_geometry` (Rust, `chroma::edit::clip_geometry`) is
 * the one thing about a clip's placement box that neither `TransformOverlay.
 * tsx` (the on-canvas handles) nor `ClipInspectorPanel.tsx`'s Width/Height
 * fields (D-186) can derive on their own: a clip's own SOURCE resolution,
 * measured against the project's composition. Both need the exact same
 * fetch — before D-186 `TransformOverlay.tsx` had its own private copy of
 * this `invoke` call + effect + local state; this hook is the one place it
 * now lives, so a future change to the fetch (retry, caching, whatever)
 * only has to happen once — this repo's own "shared logic -> extract, don't
 * copy-paste" rule.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Mirrors `chroma::edit::ClipGeometry` (`#[serde(rename_all = "camelCase")]`). */
export interface ClipGeometry {
  compWidth: number;
  compHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * `null` while unresolved — no selection (`track === null` or
 * `clipIndex < 0`), still loading, or the probe failed (e.g. offline
 * media). Every caller already treats `null` as "nothing to show/compute
 * yet", the same fallback `TransformOverlay.tsx` used before this was
 * extracted.
 *
 * `sourcePath` is not read by the fetch itself (the command takes `track`/
 * `clip` indices, not a path) — it's a dependency ONLY, so swapping a
 * clip's source re-probes: a clip's natural footprint is a property of its
 * SOURCE, not its (stable) identity.
 */
export function useClipGeometry(
  track: number | null,
  clipIndex: number,
  sourcePath: string | undefined,
): ClipGeometry | null {
  const [geometry, setGeometry] = useState<ClipGeometry | null>(null);

  useEffect(() => {
    if (track === null || clipIndex < 0) {
      setGeometry(null);
      return;
    }
    let cancelled = false;
    invoke<ClipGeometry>('chroma_timeline_clip_geometry', { track, clip: clipIndex })
      .then((g) => {
        if (!cancelled) setGeometry(g);
      })
      .catch(() => {
        if (!cancelled) setGeometry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [track, clipIndex, sourcePath]);

  return geometry;
}
