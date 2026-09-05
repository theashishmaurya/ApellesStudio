/**
 * @chroma/motion — the live preview (D-046; player ref forwarded D-081;
 * on-canvas select/drag D-156).
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
 *
 * D-156 (Phase 1 of `docs/notes/motion-visual-builder-research.md`) wraps
 * `<Player>` in a `containerRef`'d div and renders `<MotionCanvasOverlay>`
 * as its DOM sibling, positioned over it — the same shape `@chroma/editor`'s
 * `PreviewPane.tsx` uses for `<TransformOverlay containerRef={surfaceRef}>`
 * next to its own `<img>` (see that component's own doc comment for why
 * this one's actual pointer-event wiring differs). `transientManifest` is
 * Phase 0b's in-flight drag override: `shown = transientManifest ??
 * manifest` is what actually reaches `<Player inputProps>`, while `manifest`
 * itself (the STABLE, committed value) is what the overlay reads to work
 * out where a drag starts from — see `MotionCanvasOverlay`'s own doc
 * comment for why those must not be the same value.
 */
import { useRef } from 'react';
import type { RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { Video } from '@chroma/motion-engine/src/engine/Video';
import { totalFrames } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { MotionCanvasOverlay } from './MotionCanvasOverlay';

export function MotionPreview({
  manifest,
  transientManifest = null,
  playerRef,
  selection = null,
  onSelect,
  onTransientChange,
  onCommit,
}: {
  /** the STABLE, already-committed manifest — the overlay's drag-start baseline. */
  manifest: Manifest | null;
  /** 0b's in-flight override, preferred for what's actually shown while dragging. */
  transientManifest?: Manifest | null;
  playerRef?: RefObject<PlayerRef | null>;
  selection?: Selection | null;
  /** Required together (D-156): omit all four to use this component with no
   *  on-canvas interaction at all (the overlay isn't rendered). */
  onSelect?: (s: Selection) => void;
  onTransientChange?: (next: Manifest | null) => void;
  onCommit?: (next: Manifest, label: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const localPlayerRef = useRef<PlayerRef>(null);
  const effectivePlayerRef = playerRef ?? localPlayerRef;

  const shown = transientManifest ?? manifest;
  if (!shown) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-black text-text-secondary text-sm px-6 text-center">
        Fix the manifest errors to preview it
      </div>
    );
  }

  return (
    <div className="h-full w-full flex items-center justify-center bg-black">
      <div ref={containerRef} className="relative h-full w-full">
        <Player
          ref={effectivePlayerRef}
          component={Video}
          inputProps={shown}
          durationInFrames={totalFrames(shown)}
          fps={shown.fps}
          compositionWidth={shown.width}
          compositionHeight={shown.height}
          controls
          loop
          style={{ width: '100%', height: '100%' }}
        />
        {onSelect && onTransientChange && onCommit && (
          <MotionCanvasOverlay
            containerRef={containerRef}
            playerRef={effectivePlayerRef}
            manifest={manifest}
            selection={selection}
            onSelect={onSelect}
            onTransientChange={onTransientChange}
            onCommit={onCommit}
          />
        )}
      </div>
    </div>
  );
}
