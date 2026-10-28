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
 *   3. Hit-test the pointer against every visible CAPTION first (D-316), then
 *      against every visible video layer, each topmost first (`canvasPick.ts`,
 *      which mirrors the Rust compositor's own resolution and paint order
 *      rather than guessing). Captions come first because
 *      `draw_captions_onto` paints them over the finished picture — a caption
 *      is above the whole video stack by construction, so there is no
 *      interleaving to decide, and a press inside a caption's box is a press
 *      on the caption even when a full-frame clip sits behind it.
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
import { useEffect, useState } from 'react';

import {
  pickTopmostCaption,
  pickTopmostLayer,
  visibleCaptionsAt,
  visibleVideoLayersAt,
  type CanvasCaption,
  type CanvasLayer,
  type CaptionPickCandidate,
  type PickCandidate,
} from './canvasPick';
import { screenToFraction } from './transformGeometry';
import { resolveCaptionStyle, type Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { clipGeometryKey, useClipGeometries } from './useClipGeometry';
import { captionGeometryKey, useCaptionGeometries } from './useCaptionGeometry';
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

  // **D-330 — the visible SET, subscribed at clip boundaries, not the
  // playhead.**
  //
  // This hook is called from `PreviewPane`, so its re-render IS `PreviewPane`'s
  // re-render — and a reactive `useEditorTimelineStore((s) => s.playhead)` here
  // therefore re-rendered the preview's whole subtree on every displayed frame
  // of playback. What the hook actually needs from the playhead during render
  // is only *which* clips and captions are on screen, so that their natural
  // sizes can be fetched; that set changes at a cut, not at a frame.
  // `useVisibleAtPlayhead` below is D-328's `useActiveTranscriptRow` pattern
  // applied to that set — it `setState`s only when the identity of the set
  // really changes, so a tick inside one clip costs zero React work.
  //
  // The per-frame half — a keyframed clip's box, which genuinely does move
  // every frame — is not lost: the `pointerdown` handler recomputes the
  // candidates at `getState().playhead` when a press actually arrives, which is
  // the only moment the exact box matters. That is strictly more correct than
  // the refs this replaces, which held whatever the last *rendered* frame was.
  const { layers, captions } = useVisibleAtPlayhead(timeline);
  // Measured from the style the STORE holds right now, not from the persisted
  // timeline — see `useCaptionGeometry`'s own doc for why that distinction is
  // load-bearing (B-088's debounce). Resolved here the same way
  // `CaptionTransformOverlay` resolves it, so the hit rect and the drawn box
  // are the same measurement by construction.
  const captionRequests = captions.map((c) => ({
    id: `${c.track}:${c.clip.id}`,
    req: {
      text: c.clip.caption?.text ?? '',
      style: resolveCaptionStyle(c.clip.caption?.style, timeline?.tracks[c.track]?.caption_style),
      size,
    },
  }));
  const captionGeometries = useCaptionGeometries(captionRequests);
  const geometries = useClipGeometries(
    layers.map((l) => ({ track: l.track, clipIndex: l.clipIndex, sourcePath: l.clip.source_path })),
    // A clip's natural footprint is a fraction OF THE COMPOSITION, so a
    // canvas-size change invalidates every one of them without touching the
    // timeline — see `useClipGeometries`' own `extraDep` doc.
    // D-425 — and each layer's input scaling, which sizes it into the frame.
    size ? `${size.width}x${size.height}|${layers.map((l) => l.clip.scaling ?? '').join(',')}` : null,
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
      // **D-330 — resolved at the playhead this press happened at.**
      // Everything below used to read a ref filled during render, which meant
      // the hit test ran against the last frame React had rendered rather than
      // the one on screen. Recomputing here is both cheaper (nothing at all
      // happens until a press arrives) and more correct for a keyframed clip,
      // whose box genuinely moves every frame — `layerBoxFraction` resolves it
      // at `sourceFrame`, so `sourceFrame` has to be current.
      const frame = useEditorTimelineStore.getState().playhead;
      // D-316 — captions first, unconditionally: `draw_captions_onto` paints
      // every visible cue OVER the finished picture, so a caption is above
      // every video layer by construction and there is no interleaving to
      // resolve. A press inside a caption's measured box is a press on the
      // caption, even where a clip's picture fills the frame behind it.
      //
      // The measured box still comes from `captionGeometries`, keyed exactly as
      // the request that filled it was — a cue whose measurement has not landed
      // yet has `box: null` and is skipped, the same `null`-means-"not yet"
      // fallback this module already uses for a clip's natural size.
      const captionCandidates: CaptionPickCandidate[] = visibleCaptionsAt(timeline, frame).map((c) => {
        const id = `${c.track}:${c.clip.id}`;
        const req = {
          text: c.clip.caption?.text ?? '',
          style: resolveCaptionStyle(c.clip.caption?.style, timeline?.tracks[c.track]?.caption_style),
          size,
        };
        return { ...c, box: captionGeometries.get(captionGeometryKey(id, req)) ?? null };
      });
      const captionHit = pickTopmostCaption(point, captionCandidates);
      const candidates: PickCandidate[] = visibleVideoLayersAt(timeline, frame).map((l) => {
        const g = geometries.get(clipGeometryKey(l.track, l.clipIndex, l.clip.source_path));
        return { ...l, natural: g ? { width: g.naturalWidth, height: g.naturalHeight } : null };
      });
      const hit = captionHit ?? pickTopmostLayer(point, candidates);

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
  }, [container, ready, contentBox, geometries, captionGeometries, timeline, size]);
}

/** The video layers and captions on screen at the playhead — **recomputed only
 *  when that SET changes**, not on every frame (D-330).
 *
 *  D-328's `useActiveTranscriptRow` pattern, applied to the preview's pick
 *  candidates. The hook it replaces subscribed to `playhead` reactively, so
 *  `PreviewPane` — its caller — re-rendered on every displayed frame of
 *  playback to produce, in the overwhelmingly common case, the identical set of
 *  clips it already had.
 *
 *  The identity key is `track:clipIndex:id` per layer and `track:id` per
 *  caption, which is exactly what the two geometry fetches downstream key on.
 *  Anything finer would defeat the purpose (a keyframed clip's transform
 *  changes every frame); anything the key misses is a timeline EDIT, which
 *  replaces the `timeline` object and so re-runs the effect outright.
 *
 *  Both derived arrays are computed INSIDE the effect rather than in a `useMemo`
 *  it depends on — the shape the React Compiler cannot preserve (D-201, and see
 *  `useActiveTranscriptRow`'s own note). */
function useVisibleAtPlayhead(timeline: Timeline | null): {
  layers: CanvasLayer[];
  captions: CanvasCaption[];
} {
  const [visible, setVisible] = useState<{ layers: CanvasLayer[]; captions: CanvasCaption[] }>({
    layers: [],
    captions: [],
  });

  useEffect(() => {
    const at = (frame: number) => ({
      layers: visibleVideoLayersAt(timeline, frame),
      captions: visibleCaptionsAt(timeline, frame),
    });
    const keyOf = (v: { layers: CanvasLayer[]; captions: CanvasCaption[] }) =>
      `${v.layers.map((l) => `${l.track}:${l.clipIndex}:${l.clip.id}`).join('|')}` +
      `#${v.captions.map((c) => `${c.track}:${c.clip.id}`).join('|')}`;

    // Seed from the current value rather than waiting for the next tick, so a
    // preview that mounts mid-playback can hit-test immediately.
    let next = at(useEditorTimelineStore.getState().playhead);
    let lastKey = keyOf(next);
    setVisible(next);

    return useEditorTimelineStore.subscribe((state) => {
      next = at(state.playhead);
      const key = keyOf(next);
      // The whole point: a tick that stays inside the same clips does no React
      // work at all.
      if (key === lastKey) return;
      lastKey = key;
      setVisible(next);
    });
  }, [timeline]);

  return visible;
}
