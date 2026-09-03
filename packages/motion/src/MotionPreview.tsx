/**
 * @chroma/motion — the live preview (D-046; player ref forwarded D-081).
 *
 * A real `@remotion/player` embed of `@chroma/motion-engine`'s own `Video`
 * component — the exact component the `Animation` composition registers in
 * `packages/motion-engine/src/Root.tsx` — fed the manifest as `inputProps`.
 * Not a CLI render: an interactive, scrubbable, playable preview, driven by
 * whatever manifest is currently loaded in the tab's own state.
 *
 * D-081: accepts an optional `playerRef` — `LayerList`'s row clicks call its
 * real `seekTo(frame)` method (`@remotion/player`'s own imperative API,
 * `PlayerRef`) to jump the preview to whatever scene/layer was selected.
 * Optional so this component still works standalone (a ref is a pure
 * addition, nothing about the preview itself needs one).
 */
import type { RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { Video } from '@chroma/motion-engine/src/engine/Video';
import { totalFrames } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

export function MotionPreview({
  manifest,
  playerRef,
}: {
  manifest: Manifest | null;
  playerRef?: RefObject<PlayerRef | null>;
}) {
  if (!manifest) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-black text-text-secondary text-sm px-6 text-center">
        Fix the manifest errors to preview it
      </div>
    );
  }

  return (
    <div className="h-full w-full flex items-center justify-center bg-black">
      <Player
        ref={playerRef}
        component={Video}
        inputProps={manifest}
        durationInFrames={totalFrames(manifest)}
        fps={manifest.fps}
        compositionWidth={manifest.width}
        compositionHeight={manifest.height}
        controls
        loop
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
