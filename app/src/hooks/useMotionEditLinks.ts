/**
 * useMotionEditLinks — the Motion tab's view of where each scene's render sits
 * on the open Edit timeline (D-260), for the composition root (`Root.tsx`).
 *
 * What it does: computes `computeEditLinks(media pool, timeline tracks, project
 * dir)` and returns a value whose IDENTITY changes only when the links do.
 *
 * Why it exists (B-370): `Root` used to select `timeline.tracks` itself to
 * compute these links, so every Edit change (a trim, a nudge, a release) re-
 * rendered `Root` and with it `Shell` and every non-memoised panel under it.
 * Measured live on the 300-clip fixture (dev bundle, React Performance Tracks):
 * `Shell` was ~21 ms of a ~30 ms release commit. Here the tracks are read by a
 * raw store subscription instead, and a recomputed link set that says the same
 * thing (`sameEditLinks`) keeps the previous object, so React bails out and
 * `Root` does not render at all on an edit that leaves the links alone — which
 * is every edit of a clip that is not a Motion render.
 *
 * What it does NOT do: decide what a link is (`@apelles/motion`'s
 * `computeEditLinks` does) or touch the timeline.
 */

import { useEffect, useState } from 'react';
import { useMediaPoolStore } from '@apelles/bridge';
import { useEditorTimelineStore } from '@apelles/editor';
import { computeEditLinks, sameEditLinks, type MotionEditLinks } from '@apelles/motion';

export function useMotionEditLinks(projectDir: string | null | undefined): MotionEditLinks {
  const mediaItems = useMediaPoolStore((s) => s.items);
  const compute = () => computeEditLinks(mediaItems, useEditorTimelineStore.getState().timeline?.tracks ?? [], projectDir);
  const [links, setLinks] = useState<MotionEditLinks>(compute);

  useEffect(() => {
    const update = () => {
      const next = computeEditLinks(mediaItems, useEditorTimelineStore.getState().timeline?.tracks ?? [], projectDir);
      setLinks((prev) => (sameEditLinks(prev, next) ? prev : next));
    };
    // The pool or the project changed (this effect's deps), or the timeline
    // changed between the first render and this subscription.
    update();
    return useEditorTimelineStore.subscribe((s, prev) => {
      if (s.timeline?.tracks !== prev.timeline?.tracks) update();
    });
  }, [mediaItems, projectDir]);

  return links;
}
