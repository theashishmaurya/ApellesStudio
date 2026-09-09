/**
 * @apelles/motion — the live preview (D-046; player ref forwarded D-081;
 * on-canvas select/drag D-156).
 *
 * A real `@remotion/player` embed of `@apelles/motion-engine`'s own `Video`
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
 * as its DOM sibling, positioned over it — the same shape `@apelles/editor`'s
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
 * D-160/D-161 (Phase 5a/5b part 1 of `docs/notes/
 * motion-keyframe-timeline-research.md`) briefly put a `<KeyframeStrip>`
 * (one flat marker strip + click-to-seek + drag-a-key) directly beneath the
 * player here, inside this component's own `flex flex-col`. **D-162 (Phase
 * 5b part 2, "per-row lanes") moves it back out.** A per-row lane timeline
 * needs real independent estate (a resizable height, its own scroll region,
 * room for a ruler and N rows) that a strip wedged into the bottom of the
 * preview never needed — see `KeyframeTimeline.tsx`'s own module doc
 * comment for the full layout reasoning (the Edit tab's own
 * `PreviewPane`+`TimelinePane` stack, read as precedent, puts its timeline
 * outside the preview component entirely). This component is back to
 * exactly its pre-D-160 shape: just the player + `MotionCanvasOverlay`, no
 * opinion at all about what (if anything) a caller stacks below it —
 * `MotionTab.tsx`'s own layout owns that now.
 *
 * D-181 (Phase 2 of 3, "scene should be a separate composition… exported as
 * separate video, not on top of it" — the owner's own follow-up, after D-180
 * shipped separate EXPORT: also wants selecting a scene to PREVIEW it as its
 * own standalone 0:00-start clip). The underlying `<Player>` is unchanged —
 * still one `Animation` composition, one `durationInFrames`, absolute frames
 * under the hood (Remotion's own CLI/Player never had a notion of "solo one
 * scene" to begin with) — this is entirely a display/interaction SCOPING
 * layer on top of it: `activeSceneIndex` (optional; `null`/`undefined` keeps
 * today's whole-video behavior byte-for-byte) seeks to that scene's own
 * `sceneStartFrame` on change, swaps `@remotion/player`'s native `controls`
 * bar (which has no notion of a sub-range — it always shows progress across
 * the WHOLE composition, so it can't be "cropped" to feel scene-local) for a
 * small owned transport scoped to that scene's own window, and loop-
 * constrains playback to `[sceneStart, sceneEnd)` instead of the whole
 * composition. `sceneStartFrame`/`sceneDurationFrames` are the SAME
 * `build.ts` functions `KeyframeTimeline.tsx`'s own scene-boundary lines and
 * D-180's per-scene export already use — no new scene-window math invented.
 */
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Play, Pause } from 'lucide-react';
import { Player, type PlayerRef } from '@remotion/player';
import { Video } from '@apelles/motion-engine/src/engine/Video';
import { totalFrames, sceneStartFrame, sceneDurationFrames } from '@apelles/motion-engine/src/engine/build';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { MotionCanvasOverlay } from './MotionCanvasOverlay';
import { measureWorldMap, type RectLike, type WorldMap } from './canvasGeometry';
import { measureLayerScreenBox, findWorldElement } from './layerMeasure';

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

/** `M:SS` — the exact format `@remotion/player`'s own native controls bar
 *  already shows (e.g. "0:04"); written locally rather than reused from
 *  `timelineRuler.ts`'s `formatTimecode` (a RULER-TICK label, parameterized
 *  by a tick interval — a different job than a transport's own elapsed/total
 *  time text). */
function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
  activeSceneIndex = null,
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
  /** D-181 — solo this scene: seek/loop/transport scope to its own
   *  `[sceneStartFrame, sceneStartFrame+sceneDurationFrames)` window. `null`
   *  (the default) is today's pre-D-181 whole-video behavior, unchanged. */
  activeSceneIndex?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const localPlayerRef = useRef<PlayerRef>(null);
  const effectivePlayerRef = playerRef ?? localPlayerRef;
  // D-181 — the active scene's own absolute frame window, or `null` in
  // whole-video mode. Recomputed from the STABLE `manifest` (never
  // `transientManifest` — a drag never changes scene boundaries) so a
  // mid-drag re-render can't jitter the loop/seek target.
  const soloWindow =
    activeSceneIndex !== null && manifest && manifest.scenes[activeSceneIndex]
      ? {
          start: sceneStartFrame(manifest, activeSceneIndex),
          end: sceneStartFrame(manifest, activeSceneIndex) + sceneDurationFrames(manifest, activeSceneIndex),
        }
      : null;
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

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

  // D-181 — track the live absolute frame + play state (needed for the
  // custom transport's scrub position/time text/play-pause icon) and
  // enforce the solo loop constraint (`frame >= soloWindow.end` seeks back
  // to `soloWindow.start`, pre-empting `<Player loop>`'s own whole-
  // composition wraparound — see the `loop={soloWindow === null}` prop
  // below for why that native behavior is disabled, not just redundant,
  // whenever a scene other than the last is soloed). Re-subscribes only
  // when the window's own bounds change (switching scenes, or an earlier
  // scene's duration shifting this one's start) — cheap, and avoids a
  // stale closure over `soloWindow` inside the listener.
  useEffect(() => {
    const player = effectivePlayerRef.current;
    if (!player) return;
    const onFrameUpdate = (e: { detail: { frame: number } }) => {
      setFrame(e.detail.frame);
      if (soloWindow && e.detail.frame >= soloWindow.end) player.seekTo(soloWindow.start);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener('frameupdate', onFrameUpdate);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    setFrame(player.getCurrentFrame());
    setPlaying(player.isPlaying());
    return () => {
      player.removeEventListener('frameupdate', onFrameUpdate);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePlayerRef, soloWindow?.start, soloWindow?.end]);

  // D-181 — a SAFETY NET, not the primary seek: `MotionTab.tsx`'s own
  // `onSelect` (B-064/D-176's existing "seek only if not already visible"
  // logic) already lands the playhead precisely inside whatever was just
  // selected BEFORE `activeSceneIndex` ever changes here — every real path
  // that engages solo mode goes through it. This effect only corrects the
  // rare case where `activeSceneIndex` changes WITHOUT a matching seek
  // having already happened, by checking (imperatively, not via the
  // `frame` state — reading that here would re-run this on every single
  // `frameupdate` during playback) whether the current frame is even inside
  // the new window at all; if it's already inside (the common case, since
  // `onSelect` put it there), this is a genuine no-op — it can never
  // override a more precise seek (e.g. D-176's "jump to a layer's own
  // `at`," not just its scene's start) with a cruder "go to scene start."
  useEffect(() => {
    if (!soloWindow) return;
    const player = effectivePlayerRef.current;
    if (!player) return;
    const current = player.getCurrentFrame();
    if (current < soloWindow.start || current >= soloWindow.end) player.seekTo(soloWindow.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSceneIndex, soloWindow?.start, soloWindow?.end]);

  const shown = transientManifest ?? manifest;
  if (!shown) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-black text-text-secondary text-sm px-6 text-center">
        Fix the manifest errors to preview it
      </div>
    );
  }

  return (
    <div className="relative h-full w-full flex items-center justify-center bg-black">
      <div ref={containerRef} className="relative h-full w-full">
        <Player
          ref={effectivePlayerRef}
          component={Video}
          inputProps={shown}
          durationInFrames={totalFrames(shown)}
          fps={shown.fps}
          compositionWidth={shown.width}
          compositionHeight={shown.height}
          // D-172 — `@remotion/player` silently defaults `clickToPlay` to
          // match `controls` (confirmed by reading its own source,
          // `Player.js`: `clickToPlay: typeof clickToPlay === 'boolean' ?
          // clickToPlay : Boolean(controls)`), so enabling the transport bar
          // ALSO turned every click on the canvas into a play/pause toggle —
          // fighting `MotionCanvasOverlay`'s own click-to-select (D-156),
          // which deliberately never calls `stopPropagation` so clicks that
          // land on empty canvas still reach Remotion's own chrome normally.
          // The dedicated Play/Pause button (`controls`) and the spacebar
          // shortcut (`spaceKeyToPlayOrPause`, on by default, untouched) are
          // unaffected — only the "click anywhere toggles play" convenience
          // behavior turns off, which only ever conflicted with selection.
          clickToPlay={false}
          // D-181 — the native controls bar has no notion of a sub-range
          // (it always shows progress across the WHOLE composition), so it
          // can't be "cropped" to feel scene-local; solo mode hides it and
          // renders its own scoped transport below instead. `loop` is
          // likewise disabled while solo'd — the manual loop-constraint
          // effect above already resets to `soloWindow.start` before the
          // player would ever reach the composition's own end (except when
          // soloing the LAST scene, where the two would otherwise race:
          // `loop`'s own wraparound resets to absolute frame 0 — the WHOLE
          // video's start, not this scene's — which is wrong here).
          controls={soloWindow === null}
          loop={soloWindow === null}
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
        {/* D-181 — the solo-scene transport: play/pause, LOCAL elapsed/total
           time (scene-relative, not the whole composition's), and a
           scrubber whose own `[0, sceneDur)` range never exposes a frame
           outside this scene. `frame`/`playing` come from the subscription
           effect above; `seekTo`/`toggle` go straight through the same
           `effectivePlayerRef` the native controls would have used.
           `data-motion-transport` (found live, Phase 3): `MotionCanvasOverlay
           .tsx`'s click/drag hit-testing walks the WHOLE `elementsFromPoint`
           stack looking for a `[data-motion-layer]`/`[data-motion-item-
           index]` match, not just the topmost element — without this
           marker, clicking anywhere on this bar (even the plain time text)
           "saw through" to whatever canvas layer happened to render behind
           it at that exact pixel and silently selected/dragged it. */}
        {soloWindow && (
          <div
            data-motion-transport
            className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 px-3 py-1.5 bg-black/70 text-white text-[11px] select-none"
          >
            <button
              type="button"
              onClick={() => effectivePlayerRef.current?.toggle()}
              className="shrink-0 h-5 w-5 flex items-center justify-center"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <span className="tabular-nums shrink-0">
              {formatSeconds(Math.max(0, frame - soloWindow.start) / shown.fps)} /{' '}
              {formatSeconds((soloWindow.end - soloWindow.start) / shown.fps)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, soloWindow.end - soloWindow.start - 1)}
              value={Math.min(Math.max(0, frame - soloWindow.start), soloWindow.end - soloWindow.start - 1)}
              onChange={(e) => effectivePlayerRef.current?.seekTo(soloWindow.start + Number(e.target.value))}
              className="flex-1 accent-accent"
              aria-label="Scene position"
            />
          </div>
        )}
      </div>
    </div>
  );
}
