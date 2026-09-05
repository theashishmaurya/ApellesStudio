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
 *
 * D-157 (Phase 2): `measureApiRef` is an optional imperative escape hatch —
 * the same shape `playerRef` already is — so `MotionTab.tsx`'s "snap to
 * layer" action (triggered from the Inspector, which has no DOM access of
 * its own to the live player) can measure a target layer's real screen rect
 * and the current camera world-map on demand, ONE-OFF, without this
 * component needing to know anything about snapping itself. Uses the same
 * `layerMeasure.ts` helpers `MotionCanvasOverlay.tsx`'s own selection
 * outline already shares — one measurement technique, three consumers.
 *
 * D-158 (Phase 3): `selection`/`onSelect` become `selections`/`onSelect` +
 * `onSelectionChange` — see `MotionCanvasOverlay.tsx`'s own doc comment for
 * the full reasoning on the two callbacks' different roles (replace-and-seek
 * vs. array-level, no seek). All five interaction props (`onSelect`,
 * `onSelectionChange`, `onTransientChange`, `onCommit`) are required
 * together, same as before — omit all four to use this component with no
 * on-canvas interaction at all.
 *
 * D-160 (Phase 5a of `docs/notes/motion-keyframe-timeline-research.md`,
 * "key visibility"): the player+overlay now sit in a `flex flex-col`
 * container with `<KeyframeStrip>` fixed beneath — a small, ALWAYS-mounted
 * (never behind the interaction-props gate above; navigation alone needs no
 * manifest mutation) strip showing camera + the current single layer
 * selection's own keyframes and the live playhead. See that component's own
 * doc comment for why it's a sibling rather than a modification of
 * Remotion's own scrubber.
 *
 * Phase 5b of the same research doc ("drag a key along time") reuses this
 * component's OWN `onTransientChange`/`onCommit` — already destructured
 * here for `MotionCanvasOverlay` below — as `<KeyframeStrip>`'s, unguarded
 * by the four-props-together check the overlay uses: the strip's marker-
 * drag gesture only needs the two mutation callbacks, not `onSelect`/
 * `onSelectionChange` (it never changes what's selected), so it becomes
 * drag-capable independently of whether on-canvas editing is wired up at
 * all. A caller supplying neither keeps Phase 5a's read-only strip exactly
 * as it was.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { Video } from '@chroma/motion-engine/src/engine/Video';
import { totalFrames } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { MotionCanvasOverlay } from './MotionCanvasOverlay';
import { measureWorldMap, type RectLike, type WorldMap } from './canvasGeometry';
import { measureLayerScreenBox, findWorldElement } from './layerMeasure';
import { KeyframeStrip } from './KeyframeStrip';

/** D-157's imperative measurement escape hatch — see the module doc comment. */
export interface MotionCanvasMeasureApi {
  /** the union of `sceneIndex.layerIndex`'s `[data-motion-box]` descendants,
   *  in screen/viewport coordinates — `null` if that layer isn't in the DOM
   *  right now (wrong scene under the playhead, out of range, not yet
   *  mounted). */
  layerScreenBox: (sceneIndex: number, layerIndex: number) => RectLike | null;
  /** the current screen↔world map, measured fresh off `[data-motion-world]`
   *  — `null` if the world container isn't in the DOM (no scene mounted). */
  worldMap: () => WorldMap | null;
}

export function MotionPreview({
  manifest,
  transientManifest = null,
  playerRef,
  measureApiRef,
  selections = [],
  onSelect,
  onSelectionChange,
  onTransientChange,
  onCommit,
}: {
  /** the STABLE, already-committed manifest — the overlay's drag-start baseline. */
  manifest: Manifest | null;
  /** 0b's in-flight override, preferred for what's actually shown while dragging. */
  transientManifest?: Manifest | null;
  playerRef?: RefObject<PlayerRef | null>;
  /** D-157 — see `MotionCanvasMeasureApi`'s own doc comment above. Optional:
   *  a caller with no snap-style need (e.g. a future standalone preview
   *  embed) just omits it. */
  measureApiRef?: RefObject<MotionCanvasMeasureApi | null>;
  /** D-158 — the whole live selection (was `Selection | null`). */
  selections?: Selection[];
  /** Required together (D-156/D-158): omit all four to use this component
   *  with no on-canvas interaction at all (the overlay isn't rendered). */
  onSelect?: (s: Selection) => void;
  onSelectionChange?: (s: Selection[]) => void;
  onTransientChange?: (next: Manifest | null) => void;
  onCommit?: (next: Manifest, label: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const localPlayerRef = useRef<PlayerRef>(null);
  const effectivePlayerRef = playerRef ?? localPlayerRef;

  // D-157 — populate the measure API once (and again whenever the manifest
  // this scale calc depends on changes) rather than rebuilding it on every
  // render; a `ref` mutation like this deliberately does not trigger a
  // re-render of its own; nothing here reads React state.
  useEffect(() => {
    if (!measureApiRef) return;
    measureApiRef.current = {
      layerScreenBox: (sceneIndex, layerIndex) => {
        const container = containerRef.current;
        return container ? measureLayerScreenBox(container, sceneIndex, layerIndex) : null;
      },
      worldMap: () => {
        const container = containerRef.current;
        if (!container || !manifest) return null;
        const worldEl = findWorldElement(container);
        return worldEl ? measureWorldMap(worldEl.getBoundingClientRect(), manifest.width) : null;
      },
    };
    return () => {
      if (measureApiRef) measureApiRef.current = null;
    };
  }, [measureApiRef, manifest]);

  const shown = transientManifest ?? manifest;
  if (!shown) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-black text-text-secondary text-sm px-6 text-center">
        Fix the manifest errors to preview it
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-black">
      <div className="relative flex-1 min-h-0 flex items-center justify-center">
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
          {onSelect && onSelectionChange && onTransientChange && onCommit && (
            <MotionCanvasOverlay
              containerRef={containerRef}
              playerRef={effectivePlayerRef}
              manifest={manifest}
              selections={selections}
              onSelect={onSelect}
              onSelectionChange={onSelectionChange}
              onTransientChange={onTransientChange}
              onCommit={onCommit}
            />
          )}
        </div>
      </div>
      {/* D-160 (Phase 5a) — always mounted regardless of the interaction
          props above: read-only navigation needs no manifest mutation, so
          it's useful even for a caller with no on-canvas editing wired up.
          Phase 5b adds `onTransientChange`/`onCommit` (independent of the
          four-props check above — see the module doc comment): reads the
          STABLE manifest for marker positions (never `shown`/
          `transientManifest` — see `KeyframeStrip.tsx`'s own doc comment
          for why re-deriving markers from a live-mutating transient
          manifest mid-drag would be actively unsafe, not just unnecessary),
          but CAN now write into it via a drag, through the same two
          callbacks `MotionCanvasOverlay` already uses. */}
      <KeyframeStrip
        manifest={manifest}
        selections={selections}
        playerRef={effectivePlayerRef}
        onTransientChange={onTransientChange}
        onCommit={onCommit}
      />
    </div>
  );
}
