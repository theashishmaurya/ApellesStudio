/**
 * @apelles/editor — canvas click-to-select for the Edit-tab preview (D-204,
 * fixing B-085; answers Open Question 3 of
 * `docs/notes/on-canvas-transform.md`).
 *
 * **The gap this closes.** D-136 built real on-canvas transform handles, but
 * `TransformOverlay` only ever *reflects* the timeline-side selection — its
 * own module doc said so outright ("clicking on the picture to select is
 * deliberately deferred"). So the handles were unreachable from the picture
 * itself: a human had to find the clip in the timeline first, then come back
 * to the canvas. The owner hit exactly that, live ("not able to click on a
 * clip in canvas to resize it, need to click from timeline") — B-085. Every
 * reference NLE's program monitor selects the clip you click on.
 *
 * **A behaviour, not a surface — so a hook, not a fourth overlay component.**
 * The first cut of this was a full-bleed `pointer-events-auto` div sitting
 * under `TransformOverlay` in z-order, which is the obvious shape and is
 * WRONG in a way only real-browser hit-testing shows (it did, live — see
 * D-204): the selected clip's own transform box is itself full-bleed whenever
 * that clip fills the frame, so it swallowed every press and nothing else on
 * the canvas could ever be picked again. There is no z-order that fixes that,
 * because the two layers genuinely overlap and which one should win depends
 * on WHAT is under the pointer, not on where the elements sit. So this
 * listens on the shared surface container in the **capture** phase, decides,
 * and only then lets the press continue to `TransformOverlay`'s own
 * bubble-phase handlers (or not).
 *
 * **The decision, in order:**
 *   1. Not the primary button → not ours.
 *   2. The press landed on a transform corner HANDLE → never ours. A corner
 *      grab is unambiguous, and a handle's hit area deliberately overhangs the
 *      box (`HANDLE_HIT_SLOP`), so it can sit over a different clip's picture.
 *      Detected with `closest('[data-transform-handle]')` — the same "was this
 *      press on a real widget?" test `TimelinePane`'s own D-100 clear-selection
 *      branch makes with `closest('.timeline-editor-action')`.
 *   3. Hit-test the pointer against every visible layer, topmost first
 *      (`canvasPick.ts`, which mirrors the Rust compositor's own layer
 *      resolution and paint order rather than guessing).
 *   4. The topmost hit IS the one clip already selected → not ours: that is a
 *      grab on the selected clip's own picture, i.e. exactly D-136's move
 *      drag, which continues to work untouched.
 *   5. Nothing hit, but the press was inside the transform overlay → not ours
 *      either. Leaves a drag of a clip whose track was hidden mid-gesture
 *      alone rather than yanking the selection out from under it.
 *   6. Otherwise it IS ours: select the hit clip (or clear, on empty canvas)
 *      and `stopPropagation()` so the press cannot also start a drag of the
 *      selection that was just replaced.
 *
 * **Same selection state as the timeline**, deliberately — this drives
 * `useEditorTimelineStore.setSelection` (D-107/D-118), not a second canvas-side
 * selection concept, which is why the Inspector, the transform handles and
 * every keyboard op light up identically however the clip was picked. Empty
 * canvas clears, mirroring `TimelinePane`'s own D-100/D-105 empty-area rule
 * (owner: "clicking outside does not make it undeselected") including its
 * `setSelectedGap(null)` half.
 *
 * **Not here (deliberate, each with a real reason):**
 *   - **Select-and-move in one gesture.** A press that selects does not also
 *     begin a transform drag. Handing an in-flight pointer gesture to
 *     `TransformOverlay` would mean duplicating its drag/commit logic here or
 *     a pointer-capture handoff between two components — real complexity for
 *     a second gesture that already works (click, then drag). Tracked in the
 *     phased note, not silently dropped.
 *   - **Modifier-extend (shift/cmd) selection.** Timeline-only. Neither
 *     Premiere's nor Resolve's program monitor multi-selects on the picture,
 *     and `TransformOverlay` draws nothing at all for a selection that isn't
 *     exactly one clip — a canvas cmd-click would produce a state with no
 *     canvas feedback whatsoever.
 *   - **A hover cursor/highlight.** Would need per-`pointermove` hit-testing
 *     and a re-render on the preview's hottest surface; a real, separate
 *     affordance to weigh, not a freebie.
 */
import { useEffect } from 'react';

import { pickTopmostLayer, visibleVideoLayersAt, type PickCandidate } from './canvasPick';
import { screenToFraction } from './transformGeometry';
import { useEditorTimelineStore } from './timelineStore';
import { clipGeometryKey, useClipGeometries } from './useClipGeometry';
import { usePreviewContentBox } from './usePreviewContentBox';
import type { CompositionSize } from './useCompositionSize';

/**
 * Wire canvas click-to-select onto `container` — `PreviewPane`'s preview
 * surface, the element the `<img>` is `object-contain`-fit within. It is the
 * ELEMENT, not a ref object, because `PreviewPane` only renders it once the
 * first frame has decoded: the hook has to re-run when it appears, and a ref
 * object never tells anyone that it did (B-085's second half — see
 * `useContentBox`'s own note).
 *
 * Measures its own content box from that container, exactly as
 * `CanvasBoundary` and `TransformOverlay` each already do: all three derive
 * it from the same element and the same (width, height) pair — since D-218
 * through the one shared `usePreviewContentBox`, which also applies the
 * preview's viewport zoom/pan — so they agree pixel-for-pixel by construction
 * rather than by being handed one value (see `CanvasBoundary`'s own note on
 * that).
 *
 * Renders nothing and returns nothing: the only observable effect is on the
 * store's `selection`/`selectedGap`.
 */
export function useCanvasClipPick(container: HTMLElement | null, size: CompositionSize | null): void {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);

  // Rebuilt every render on purpose — `useClipGeometries` keys its fetch on
  // the request list's CONTENT, not this array's identity, so the playhead
  // advancing a frame within the same set of clips refetches nothing.
  const layers = visibleVideoLayersAt(timeline, playhead);
  const geometries = useClipGeometries(
    layers.map((l) => ({ track: l.track, clipIndex: l.clipIndex, sourcePath: l.clip.source_path })),
    // A clip's natural footprint is a fraction OF THE COMPOSITION, so a
    // canvas-size change invalidates every one of them without touching the
    // timeline — see `useClipGeometries`' own `extraDep` doc.
    size ? `${size.width}x${size.height}` : null,
  );

  // D-218 — the ZOOMED content box (the fit box with the preview viewport's
  // zoom/pan composed on top), so a press is hit-tested against where the
  // picture actually IS on screen, not where it would be at fit. Same hook
  // `TransformOverlay` and `CanvasBoundary` read, so all three still agree by
  // construction — see `usePreviewContentBox`'s own doc.
  const contentBox = usePreviewContentBox(container, size);
  const ready = !!size && contentBox.width > 0 && contentBox.height > 0;

  useEffect(() => {
    if (!container || !ready) return;

    const onPointerDownCapture = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      // Rule 2 — a corner grab is never a selection gesture.
      if (target?.closest('[data-transform-handle]')) return;

      const rect = container.getBoundingClientRect();
      const point = screenToFraction({ x: e.clientX - rect.left, y: e.clientY - rect.top }, contentBox);
      const candidates: PickCandidate[] = layers.map((l) => {
        const g = geometries.get(clipGeometryKey(l.track, l.clipIndex, l.clip.source_path));
        return { ...l, natural: g ? { width: g.naturalWidth, height: g.naturalHeight } : null };
      });
      const hit = pickTopmostLayer(point, candidates);

      // Read the selection through `getState()` rather than subscribing: this
      // listener is re-registered on every dependency change already, and an
      // extra store subscription here would re-run that registration on every
      // selection change for no behavioural gain. Same escape-hatch use
      // `TimelinePane`'s own `locateClip` makes (inside a handler, never in a
      // render body — see B-087 for what the render-body version costs).
      const selection = useEditorTimelineStore.getState().selection;
      // Rule 4 — a grab on the already-selected clip's own picture is D-136's
      // move drag, not a selection change.
      if (hit && selection.length === 1 && selection[0].track === hit.track && selection[0].id === hit.clip.id) return;
      // Rule 5 — nothing under the pointer, but the press is on the transform
      // overlay itself: leave that gesture alone.
      if (!hit && target?.closest('[data-transform-overlay]')) return;

      // Rule 6 — ours. D-105: a clip selection and a gap selection are
      // mutually exclusive, so both branches clear the gap.
      const { setSelection, setSelectedGap } = useEditorTimelineStore.getState();
      setSelectedGap(null);
      setSelection(hit ? [{ track: hit.track, id: hit.clip.id }] : []);
      // Stop the press reaching `TransformOverlay`'s bubble-phase handlers,
      // which would otherwise start a move/scale drag of the selection this
      // very press just replaced.
      e.stopPropagation();
    };

    container.addEventListener('pointerdown', onPointerDownCapture, { capture: true });
    return () => container.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
  }, [container, ready, contentBox, layers, geometries]);
}
