/**
 * @chroma/motion — Phase 5a of `docs/notes/motion-keyframe-timeline-research.md`
 * (D-160). A small, read-only strip rendered under the live player showing
 * WHERE keyframes are and where the playhead is, plus click-to-seek — the
 * visual-builder research doc's own "deliberately cheaper intermediate" for
 * a real keyframe timeline (Phase 5b, not attempted here — see that doc's
 * §4 and the new doc's own §3/§4 for the full scoping and why this is a
 * separate component rather than a literal modification of the player's own
 * scrub bar).
 *
 * **Why this is a component next to `<Player>`, not inside it.** Checked
 * directly this pass: `@remotion/player`'s bundled `PlayerControls.js` has
 * no extension point for injecting markers into its own scrub bar, and
 * `<Player controls>` is a single boolean toggle for the whole built-in bar,
 * not a slot system. Building "the player's own scrubber gains markers" as
 * literally worded would mean forking Remotion's controls or replacing them
 * outright with a fully custom transport bar — real, but most of a whole
 * timeline's own chrome, which is exactly the scope this phase is trying
 * NOT to build yet. This component gets the same INTENT (see keyframes,
 * jump between them, scrub coupled to the player) through a smaller,
 * lower-risk mechanism instead.
 *
 * **Pure navigation, no manifest mutation.** Every click here only ever
 * calls `PlayerRef.seekTo(frame)` — there is nothing to commit, and
 * therefore nothing that needs D-155's transient-preview/undo discipline
 * (the same reason `LayerList`'s own row-click-to-seek has never needed it
 * either). All the frame/position math lives in the pure, unit-tested
 * `keyframeVisibility.ts` — this file is DOM/pointer wiring only,
 * deliberately untested per this package's established split
 * (`MotionCanvasOverlay.tsx`'s own precedent: pure math tested, the
 * component wiring around it is not).
 *
 * Spans the WHOLE composition (every scene), not just the scene under the
 * playhead — reading a key's `at` needs no live DOM (unlike measuring where
 * a layer is actually drawn on screen), so there is no reason to restrict
 * this to what's currently mounted, unlike every canvas gesture in
 * `MotionCanvasOverlay.tsx`.
 */
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { totalFrames } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { cameraKeyMarkers, selectedLayerKeyMarkers, sceneBoundaryFrames, frameToPercent } from './keyframeVisibility';

const markerBase =
  'absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-pointer';

export function KeyframeStrip({
  manifest,
  selections,
  playerRef,
}: {
  /** `null` mirrors `MotionCanvasOverlay.tsx`'s own `manifest` prop — the
   *  caller (`MotionPreview.tsx`) may still hold a `null` STABLE manifest
   *  for an instant even while `shown` (transient-or-stable) is truthy;
   *  this component simply renders nothing rather than assuming non-null. */
  manifest: Manifest | null;
  selections: Selection[];
  playerRef: RefObject<PlayerRef | null>;
}) {
  const [frame, setFrame] = useState(() => playerRef.current?.getCurrentFrame() ?? 0);

  // Same event this package's own `MotionCanvasOverlay.tsx` already
  // subscribes to (`player.addEventListener('frameupdate', …)`) — the
  // playhead line below tracks it live, during both playback and scrubbing.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    setFrame(player.getCurrentFrame());
    const onFrameUpdate = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    player.addEventListener('frameupdate', onFrameUpdate);
    return () => player.removeEventListener('frameupdate', onFrameUpdate);
  }, [playerRef]);

  if (!manifest) return <div className="h-6 shrink-0 border-t border-border-color bg-bg-secondary" />;

  const total = totalFrames(manifest);
  const boundaries = sceneBoundaryFrames(manifest);
  const cameraMarkers = cameraKeyMarkers(manifest);
  const layerMarkers = selectedLayerKeyMarkers(manifest, selections);

  const seekToClientX = (clientX: number, rect: DOMRect) => {
    const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    playerRef.current?.seekTo(Math.round(fraction * total));
  };

  return (
    <div
      className="relative h-6 shrink-0 border-t border-border-color bg-bg-secondary select-none"
      title="Click to seek — diamonds are keyframes"
      onClick={(e) => seekToClientX(e.clientX, e.currentTarget.getBoundingClientRect())}
    >
      {boundaries.map((f) => (
        <div
          key={`boundary-${f}`}
          className="absolute top-0 bottom-0 w-px bg-border-color"
          style={{ left: `${frameToPercent(f, total)}%` }}
        />
      ))}
      {cameraMarkers.map((m, i) => (
        <button
          key={`camera-${i}`}
          type="button"
          className={`${markerBase} border border-text-secondary bg-bg-primary`}
          style={{ left: `${frameToPercent(m.frame, total)}%` }}
          title={`${m.kind === 'scene3d-camera' ? '3D camera' : 'Camera'} key @ frame ${m.frame}`}
          onClick={(e) => {
            e.stopPropagation();
            playerRef.current?.seekTo(m.frame);
          }}
        />
      ))}
      {layerMarkers.map((m, i) => (
        <button
          key={`layer-${i}`}
          type="button"
          className={`${markerBase} border border-accent bg-accent`}
          style={{ left: `${frameToPercent(m.frame, total)}%` }}
          title={`Layer key @ frame ${m.frame}`}
          onClick={(e) => {
            e.stopPropagation();
            playerRef.current?.seekTo(m.frame);
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
        style={{ left: `${frameToPercent(frame, total)}%` }}
      />
    </div>
  );
}
