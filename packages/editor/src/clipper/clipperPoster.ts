/**
 * `@apelles/editor` — a short's poster frame (D-445, B-363).
 *
 * **What it is.** {@link useShortPoster}: the frame a short opens on (its
 * opening line when it has a hook, else its first kept range), read once from
 * the source through `clipThumbs.ts`'s shared, cached `chroma_clip_thumbnails`
 * accessor — the same cache the filmstrip and the Index panel use, so a frame
 * already decoded costs nothing. Shown cropped to the run's frame shape in the
 * list's cards and in the review surface.
 *
 * **What it does NOT do.** Render the short (it is not a timeline until it is
 * made), or decode anything itself.
 */
import { useEffect, useState } from 'react';

import { thumbAtSourceSecs } from '../clipThumbs';
import type { RunAnalysis } from './clipperStore';
import type { ClipProposal } from './clipperTypes';
import { posterRange } from './clipperView';

export function useShortPoster(analysis: RunAnalysis | undefined, p: ClipProposal | undefined): string | null {
  const at = p ? posterRange(p) : null;
  const path = at ? analysis?.sourcePaths[at.source] : undefined;
  const secs = at?.secs;
  const [poster, setPoster] = useState<{ key: string; url: string | null } | null>(null);
  const key = path && secs !== undefined ? `${path}@${secs}` : '';
  useEffect(() => {
    if (!path || secs === undefined) return;
    let live = true;
    void thumbAtSourceSecs(path, secs)
      .then((url) => {
        if (live) setPoster({ key: `${path}@${secs}`, url });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path, secs]);
  return poster && poster.key === key ? poster.url : null;
}
