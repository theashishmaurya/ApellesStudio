/**
 * @apelles/editor — the imperative half of the timeline's edit gestures
 * (D-432 P2, `docs/notes/ui-redesign.md` §4.4 / §5.1; fixes B-344, B-345).
 *
 * What it is: the pointer handling for every edit that is not a plain move —
 * an edge trim, ripple, roll, slip, slide, and the Blade tool's cut — built on
 * a clip's own edge zones (`[data-chroma-trim-edge]`, rendered by
 * `TimelinePane`'s clip block) rather than the timeline library's interact.js
 * resize, which the pane no longer enables.
 *
 * How a drag works, and why it is fast:
 *   1. Press (capture phase on the clip body): the mode is resolved ONCE by the
 *      same `resolveTrimMode` rule D-235/D-261 defined (tool first, then the
 *      Alt arm), the press is claimed (`stopPropagation`, so dnd-kit's move
 *      never starts), and the pointer is captured.
 *   2. Every pointermove: the delta is the pointer's own total displacement
 *      (plus any scroll since the press) in frames — no accumulator to lose
 *      travel in (B-344) — snapped to clip edges / playhead / markers within
 *      8 px (sticky ×1.5; ⌘ suspends it), then `previewEdit` applies the real
 *      op to a copy and diffs it. Each clip that would move gets a `transform`
 *      (and, for the clip whose length changes, a `width`) written straight to
 *      its body node, and its picture/waveform layer slides for a slip or a
 *      head trim. Brackets, the edge-pinned readout and the snap guide are
 *      written to `EditFeedbackLayer`. No React state is set: the pane does
 *      not re-render during a gesture (B-347, spec "renders exactly twice").
 *      A preview is computed only when the snapped delta changes.
 *   3. Release: the previewed op is committed once (`applyOp`). Because the
 *      preview IS the result, the store's render puts every clip exactly where
 *      it already is; the inline styles are dropped in a layout effect on that
 *      render, before paint, so nothing settles or jumps. A refused or
 *      cancelled (Esc) edit animates back over 120 ms instead.
 *
 * D-432 P3: a roll, slip or slide also feeds the two-up viewer
 * (`twoUp.ts` → `previewPeek.ts` → `TwoUpViewer.tsx`) on each preview, and
 * clears it at the end; the store skips unchanged frames, so this costs no
 * render when the snapped delta does not move a side.
 *
 * What it does NOT do: moves (dnd-kit, `TimelinePane`'s `ClipBody`), fades
 * (`ClipFadeOverlay`), or decide any edit's rules (`editGesture.ts`,
 * `timeline.ts` `applyOp`).
 */

import { useEffect, useLayoutEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import type { EditFeedbackHandle } from './EditFeedbackLayer';
import {
  editBrackets,
  editOpFor,
  editReadout,
  movingEdgeFrame,
  previewEdit,
  previewIndex,
  snapFrame,
  snapTargets,
  type EditGestureMode,
  type EditPreview,
  type EditTarget,
} from './editGesture';
import { endFrame, type EditOp, type Timeline } from './timeline';
import { edgeIsEditPoint, resolveTrimMode, type TrimTool, type TrimZone } from './trimMode';
import { TIMELINE_TEST_IDS } from './timelineTestIds';
import { rowHeightAt, rowTopAt } from './trackHeight';
import { usePreviewPeekStore } from './previewPeek';
import { twoUpView } from './twoUp';
import { afterPaint } from './afterPaint';
import { hideGestureCursor, showGestureCursor } from './gestureCursor';
import { EDIT_PERF, perfMark, perfMeasure, perfMeasureAfterPaint, perfMeasureAtFrame } from './editPerf';

/** Snap threshold, px at any zoom (Palmier Pro's 8 px, spec §5). */
export const EDIT_SNAP_PX = 8;
/** The settle / snap-back duration for a refused or cancelled edit, ms. */
export const EDIT_SETTLE_MS = 120;
/** A clip whose picture layer is wider than this many viewports is not promoted to a
 *  compositor layer for the gesture (the layer's memory is its size, plan §2.9 item 4). */
export const PROMOTE_MAX_VIEWPORTS = 2;
/** Elements inside a clip body that own their own presses. */
const CLIP_CONTROL_SELECTOR = 'button, [data-chroma-fade-handle]';
/** The CSS cursor each gesture shows everywhere while it runs (spec §5.1). */
const GESTURE_CURSOR: Record<EditGestureMode, string> = {
  trim: 'col-resize',
  ripple: 'col-resize',
  roll: 'col-resize',
  slip: 'ew-resize',
  slide: 'ew-resize',
};

/** Everything the gesture reads from the pane. Refreshed every render. */
export interface EditGestureView {
  timeline: Timeline | null;
  fps: number;
  pxPerSec: number;
  /** The lanes' scroll position NOW (D-437 S8: the pane's scroll store, not
   *  React state, so it is read at the moment of each pointer event rather
   *  than refreshed by a render). */
  scroll: () => { left: number; top: number };
  startLeft: number;
  rowsTop: number;
  /** the default row height (every row, when `rowTops` is absent) */
  rowHeight: number;
  /** D-432 P3 — each row's top when tracks have their own heights */
  rowTops?: readonly number[];
  /** D-432 P3 — the toolbar's Snapping toggle (N); off, an edit lands where
   *  the pointer is. Absent = on. */
  snapping?: boolean;
  viewportWidth: number;
  /** extra snap targets in frames: the playhead and the markers */
  snapExtras: () => number[];
  applyOp: (op: EditOp) => void;
  /** select the clip an edit was made on ("a drag also selects what it
   *  edited", the rule every other drag on the pane follows) */
  selectClip: (track: number, clipId: string) => void;
  /** the store's timeline right now (to learn whether a commit changed it) */
  currentTimeline: () => Timeline | null;
}

interface StyledClip {
  body: HTMLElement;
  media: HTMLElement | null;
}

interface Gesture {
  target: EditTarget;
  tl: Timeline;
  index: ReturnType<typeof previewIndex>;
  pointerId: number;
  captureEl: HTMLElement;
  originX: number;
  originScrollLeft: number;
  edgeFrame0: number | null;
  snapTargets: number[];
  sticky: number | null;
  lastDelta: number;
  preview: EditPreview;
  styled: Map<string, StyledClip>;
}

const clipBodySelector = (id: string) =>
  `[data-testid="${TIMELINE_TEST_IDS.clip}"][data-chroma-clip-id="${id.replace(/["\\]/g, '\\$&')}"]`;

/**
 * Swallow the `click` the release that ends an edit produces. A native (or the
 * harness's synthetic) release dispatches `pointerup`, `mouseup` and `click` in
 * one task, so the listener is gone again by the next task whether or not a
 * click came (a release outside the window produces none). Capture phase on
 * `window`, so it runs before React's root listener.
 */
function swallowReleaseClick(): void {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}

/** Drop a gesture's inline preview styles. `layers` also drops the `will-change`
 *  promotion; a committed edit keeps it until its frame has painted (below). */
function resetStyles(styled: Map<string, StyledClip>, layers = true): void {
  styled.forEach(({ body, media }) => {
    body.style.transform = '';
    body.style.width = '';
    body.style.transition = '';
    if (layers) body.style.willChange = '';
    if (media) {
      media.style.transform = '';
      media.style.transition = '';
      if (layers) media.style.willChange = '';
    }
  });
}

/** D-437 S7 (plan §2.9 items 3-4): give a clip the gesture moves its own compositor
 *  layer for the gesture's duration, so a preview frame is a transform on a
 *  retained layer rather than a repaint of the lane. Skipped for a clip wider than
 *  {@link PROMOTE_MAX_VIEWPORTS} viewports (the memory cap). The press promotes
 *  once; nothing is promoted or demoted per frame (B-347 F3 removed `translate3d`
 *  because layers created mid-drag cost more than they saved). */
function promote(entry: StyledClip, widthPx: number, viewportWidth: number): void {
  if (viewportWidth > 0 && widthPx > viewportWidth * PROMOTE_MAX_VIEWPORTS) return;
  entry.body.style.willChange = 'transform';
  if (entry.media) entry.media.style.willChange = 'transform';
}

/** The handlers a timeline pane wires up, plus the two calls its hook makes. */
export interface EditGestureController {
  onClipPointerDownCapture: (e: ReactPointerEvent<HTMLElement>, track: number, clipId: string) => void;
  onHover: (e: ReactPointerEvent<HTMLElement>) => void;
  onHoverLeave: () => void;
  /** the latest view (called every render, from a layout effect) */
  setView: (view: EditGestureView) => void;
  /** the render that landed a committed edit: drop the preview's inline styles */
  committedRendered: () => void;
  /** the passive-effect half of the same commit (a perf mark only, D-437 S0a) */
  committedEffects: () => void;
  /** the pane is going away: end a running gesture as a cancel (B-374: its
   *  full-window cursor layer must not outlive the pane) */
  cancel: () => void;
}

/**
 * The gesture controller itself: plain closures over the pane's refs, not a
 * hook, so its long-lived window listeners and mutable gesture record sit
 * outside React's render model entirely (and outside the React Compiler,
 * which has nothing to memoize in them).
 */
export function createEditGesture(
  editAreaRef: RefObject<HTMLDivElement | null>,
  feedbackRef: RefObject<EditFeedbackHandle | null>,
  toolRef: RefObject<TrimTool>,
  initialView: EditGestureView,
): EditGestureController {
  const viewRef = { current: initialView };
  const gestureRef: { current: Gesture | null } = { current: null };
  /** Clips styled by a committed gesture, cleared on the render that lands it. */
  const pendingClearRef: { current: Map<string, StyledClip> | null } = { current: null };
  /** a commit's passive effects have not run yet (only for the `commit-effects` perf mark) */
  let effectsPending = false;
  const hoverKeyRef: { current: string | null } = { current: null };

  const px = (frames: number) => {
    const v = viewRef.current;
    return (frames / v.fps) * v.pxPerSec;
  };
  const frameX = (frame: number) => {
    const v = viewRef.current;
    return v.startLeft + px(frame) - v.scroll().left;
  };
  const rowTop = (track: number) => {
    const v = viewRef.current;
    return v.rowsTop + (v.rowTops ? rowTopAt(v.rowTops, track, v.rowHeight) : track * v.rowHeight) - v.scroll().top;
  };
  const rowH = (track: number) => {
    const v = viewRef.current;
    return v.rowTops ? rowHeightAt(v.rowTops, track, v.rowHeight) : v.rowHeight;
  };

  const showBrackets = (tl: Timeline, target: EditTarget, limit: boolean) => {
    feedbackRef.current?.brackets(
      editBrackets(tl, target).map((b) => ({
        x: frameX(b.frame),
        top: rowTop(b.track) + 1,
        height: Math.max(0, rowH(b.track) - 2),
        side: b.side,
        limit,
      })),
    );
  };

  const styledFor = (g: Gesture, id: string): StyledClip | null => {
    const cached = g.styled.get(id);
    if (cached) return cached;
    const body = editAreaRef.current?.querySelector<HTMLElement>(clipBodySelector(id)) ?? null;
    if (!body) return null; // scrolled out of the rendered range: nothing to move
    const entry = { body, media: body.querySelector<HTMLElement>('[data-chroma-clip-media]') };
    g.styled.set(id, entry);
    const before = g.index.get(id);
    promote(entry, before ? px(before.end - before.start) : 0, viewRef.current.viewportWidth);
    return entry;
  };

  const paint = (g: Gesture) => {
    const v = viewRef.current;
    const p = g.preview;
    const moved = new Set<string>();
    for (const s of p.shifts) {
      const el = styledFor(g, s.id);
      if (!el) continue;
      moved.add(s.id);
      const before = g.index.get(s.id);
      // 2D `translate`, not `translate3d`: the latter promotes every moved clip to its
      // own compositing layer, created mid-drag and torn down at release (B-347 F3).
      el.body.style.transform = s.dStart !== 0 ? `translate(${px(s.dStart)}px, 0)` : '';
      // The one clip-level layout write: a clip whose length changes takes its
      // new width (spec §5.1 allows width "on that one clip only"); every
      // neighbour that only shifts is a pure transform.
      el.body.style.width = s.dEnd !== s.dStart && before ? `${px(before.end - before.start + s.dEnd - s.dStart)}px` : '';
      if (el.media) {
        const slide = -s.dSourceSecs * v.pxPerSec;
        el.media.style.transform = Math.abs(slide) > 0.01 ? `translate3d(${slide}px, 0, 0)` : '';
      }
    }
    g.styled.forEach((el, id) => {
      if (moved.has(id)) return;
      el.body.style.transform = '';
      el.body.style.width = '';
      if (el.media) el.media.style.transform = '';
    });
    showBrackets(p.after, g.target, p.limited);
    const c = p.after.tracks[g.target.track]?.clips[g.target.clip];
    if (c) {
      const edge =
        g.target.mode === 'slip'
          ? c.start_frame + (endFrame(c, v.fps) - c.start_frame) / 2
          : g.target.mode === 'slide' || g.target.edge === 'start'
            ? c.start_frame
            : endFrame(c, v.fps);
      feedbackRef.current?.readout({
        x: frameX(edge),
        top: rowTop(g.target.track),
        text: editReadout(p, g.target, v.fps),
        limit: p.limited,
        viewportWidth: v.viewportWidth,
      });
    }
  };

  const update = (g: Gesture, clientX: number, suspendSnap: boolean) => {
    const v = viewRef.current;
    const raw = Math.round((((clientX - g.originX) + (v.scroll().left - g.originScrollLeft)) / v.pxPerSec) * v.fps);
    let delta = raw;
    let snapX: number | null = null;
    if (g.edgeFrame0 !== null && !suspendSnap && v.snapping !== false) {
      const threshold = Math.max(1, Math.round((EDIT_SNAP_PX / v.pxPerSec) * v.fps));
      const s = snapFrame(g.edgeFrame0 + raw, g.snapTargets, threshold, g.sticky);
      g.sticky = s.target;
      delta = s.frame - g.edgeFrame0;
      snapX = s.target === null ? null : frameX(s.target);
    } else {
      g.sticky = null;
    }
    feedbackRef.current?.snapGuide(snapX);
    if (delta === g.lastDelta) return;
    g.lastDelta = delta;
    perfMark(EDIT_PERF.previewStart);
    g.preview = previewEdit(g.tl, g.target, delta, g.index);
    paint(g);
    // D-432 P3 — the two-up viewer follows the edit (roll / slip / slide).
    usePreviewPeekStore.getState().setTwoUp(twoUpView(g.tl, g.target, g.preview.after));
    perfMeasure(EDIT_PERF.preview, EDIT_PERF.previewStart);
  };

  const finish = (commit: boolean) => {
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    try {
      g.captureEl.releasePointerCapture(g.pointerId);
    } catch {
      // the capture was never taken (jsdom) or is already gone
    }
    const area = editAreaRef.current;
    if (area) delete area.dataset.chromaEditGesture;
    hideGestureCursor();
    feedbackRef.current?.clear();
    usePreviewPeekStore.getState().setTwoUp(null);
    hoverKeyRef.current = null;
    const v = viewRef.current;
    const op = commit ? editOpFor(g.tl, g.target, g.preview.delta) : null;
    if (op) {
      // B-374 — the release's own `click` is part of the drag, not a click: it
      // used to reach the clip under the pointer (re-selecting it, a second
      // render of the pane) or the empty edit area (clearing the selection the
      // edit just made, after a layout read).
      swallowReleaseClick();
      perfMark(EDIT_PERF.commit);
      v.applyOp(op);
      const edited = g.tl.tracks[g.target.track]?.clips[g.target.clip];
      if (edited) v.selectClip(g.target.track, edited.id);
      if (v.currentTimeline() !== g.tl) {
        pendingClearRef.current = g.styled;
        return;
      }
    }
    // Refused or cancelled: animate back to where the clips are (transform
    // and width only), then drop the inline styles.
    g.styled.forEach(({ body, media }) => {
      body.style.transition = `transform ${EDIT_SETTLE_MS}ms ease-out, width ${EDIT_SETTLE_MS}ms ease-out`;
      body.style.transform = '';
      body.style.width = '';
      if (media) {
        media.style.transition = `transform ${EDIT_SETTLE_MS}ms ease-out`;
        media.style.transform = '';
      }
    });
    window.setTimeout(() => resetStyles(g.styled), EDIT_SETTLE_MS);
  };

  function onMove(e: PointerEvent) {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    update(g, e.clientX, e.metaKey);
  }
  function onUp(e: PointerEvent) {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    update(g, e.clientX, e.metaKey);
    finish(true);
  }
  function onCancel() {
    finish(false);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      finish(false);
    }
  }

  /** Where a press inside a clip body lands: an edge zone or the body. */
  const zoneOf = (target: EventTarget | null): TrimZone => {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-chroma-trim-edge]') : null;
    if (!el) return 'body';
    return el.dataset.chromaTrimEdge === 'start' ? 'edge-start' : 'edge-end';
  };

  const resolve = (
    tl: Timeline,
    track: number,
    clipIndex: number,
    zone: TrimZone,
    e: { altKey: boolean; shiftKey: boolean; clientY: number },
    body: HTMLElement,
  ): EditTarget | null => {
    const tool = toolRef.current ?? 'select';
    if (tool === 'blade') return null;
    const rect = zone === 'body' ? body.getBoundingClientRect() : null;
    const mode = resolveTrimMode({
      zone,
      tool,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      atEditPoint: zone !== 'body' && edgeIsEditPoint(tl, track, clipIndex, zone === 'edge-start' ? 'start' : 'end'),
      bodyYRatio: rect && rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0,
    });
    if (mode === 'move') return null;
    return { mode, track, clip: clipIndex, edge: zone === 'edge-start' ? 'start' : 'end' };
  };

  const frameAtClientX = (clientX: number): number | null => {
    const area = editAreaRef.current;
    if (!area) return null;
    const v = viewRef.current;
    const x = clientX - area.getBoundingClientRect().left + v.scroll().left - v.startLeft;
    return Math.round((x / v.pxPerSec) * v.fps);
  };

  /** The clip body's capture-phase `pointerdown`. Claims the press for an edit
   *  (or a Blade cut); leaves a plain move to dnd-kit by doing nothing. */
  const onClipPointerDownCapture = (e: ReactPointerEvent<HTMLElement>, track: number, clipId: string) => {
    if (e.button !== 0 || gestureRef.current) return;
    // A control inside the clip (the strip's keyframes badge, a fade handle)
    // is its own hit target and keeps its press.
    if (e.target instanceof Element && e.target.closest(CLIP_CONTROL_SELECTOR)) return;
    const v = viewRef.current;
    const tl = v.timeline;
    if (!tl || tl.tracks[track]?.locked) return;
    const clipIndex = tl.tracks[track]?.clips.findIndex((c) => c.id === clipId) ?? -1;
    if (clipIndex < 0) return;
    const body = e.currentTarget;
    if ((toolRef.current ?? 'select') === 'blade') {
      const frame = frameAtClientX(e.clientX);
      e.stopPropagation();
      e.preventDefault();
      if (frame !== null) v.applyOp({ kind: 'split', track, clip: clipIndex, atFrame: frame });
      return;
    }
    const zone = zoneOf(e.target);
    const target = resolve(tl, track, clipIndex, zone, e, body);
    if (!target) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      body.setPointerCapture(e.pointerId);
    } catch {
      // jsdom, or a pointer the platform will not capture: window listeners still see it
    }
    const edgeFrame0 = movingEdgeFrame(tl, target);
    const moving = tl.tracks[track].clips[clipIndex];
    gestureRef.current = {
      target,
      tl,
      index: previewIndex(tl),
      pointerId: e.pointerId,
      captureEl: body,
      originX: e.clientX,
      originScrollLeft: v.scroll().left,
      edgeFrame0,
      snapTargets: edgeFrame0 === null ? [] : snapTargets(tl, { track, clipId: moving.id }, v.snapExtras()),
      sticky: null,
      lastDelta: 0,
      preview: { delta: 0, limited: false, after: tl, shifts: [] },
      styled: new Map(),
    };
    // D-437 S7 — the target's layer is made at the claim (a moved neighbour's on its
    // first preview frame), once, and torn down after the commit has painted.
    styledFor(gestureRef.current, moving.id);
    // D-432 P3 — the two-up viewer opens with the edit's current frames.
    usePreviewPeekStore.getState().setTwoUp(twoUpView(tl, target, tl));
    const area = editAreaRef.current;
    // A marker only (no stylesheet rule names it: B-374); the cursor is the layer's.
    if (area) area.dataset.chromaEditGesture = target.mode;
    showGestureCursor(GESTURE_CURSOR[target.mode]);
    perfMark(EDIT_PERF.press);
    // The readout's one layout read, before this gesture writes anything (F1).
    feedbackRef.current?.measure();
    showBrackets(tl, target, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  /** The edit area's `pointermove` while no gesture runs: the edit-point
   *  brackets for whatever a press here would do (spec §5.1 "shown on hover
   *  and during the drag"), and the Blade tool's cut line. Writes only when
   *  what is hovered changes (the blade line follows the pointer). */
  const onHover = (e: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current) return;
    const v = viewRef.current;
    const tl = v.timeline;
    const fb = feedbackRef.current;
    if (!tl || !fb) return;
    const body = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-chroma-clip-drag]') : null;
    const track = Number(body?.dataset.chromaTrack);
    const clipId = body?.dataset.chromaClipId;
    const clipIndex = clipId && Number.isInteger(track) ? (tl.tracks[track]?.clips.findIndex((c) => c.id === clipId) ?? -1) : -1;
    if (!body || clipIndex < 0 || tl.tracks[track]?.locked) {
      if (hoverKeyRef.current !== null) {
        hoverKeyRef.current = null;
        fb.clear();
      }
      return;
    }
    if ((toolRef.current ?? 'select') === 'blade') {
      const frame = frameAtClientX(e.clientX);
      hoverKeyRef.current = 'blade';
      fb.brackets([]);
      fb.blade(frame === null ? null : { x: frameX(frame), top: rowTop(track) + 1, height: Math.max(0, rowH(track) - 2) });
      return;
    }
    fb.blade(null);
    const zone = zoneOf(e.target);
    const target = resolve(tl, track, clipIndex, zone, e, body);
    const key = target ? `${target.mode}:${track}:${clipId}:${target.edge}` : null;
    if (key === hoverKeyRef.current) return;
    hoverKeyRef.current = key;
    if (target) showBrackets(tl, target, false);
    else fb.brackets([]);
  };

  const onHoverLeave = () => {
    if (gestureRef.current || hoverKeyRef.current === null) return;
    hoverKeyRef.current = null;
    feedbackRef.current?.clear();
  };

  return {
    onClipPointerDownCapture,
    onHover,
    onHoverLeave,
    setView(view) {
      viewRef.current = view;
    },
    committedRendered() {
      const pending = pendingClearRef.current;
      if (!pending) return;
      pendingClearRef.current = null;
      // The inline preview styles come off in this layout effect, before paint. The
      // layers stay until the commit's frame has painted, so the release does not
      // also pay for layer teardown on the frame that repaints (plan §2.9 item 3).
      resetStyles(pending, false);
      afterPaint(() => {
        pending.forEach(({ body, media }) => {
          body.style.willChange = '';
          if (media) media.style.willChange = '';
        });
      });
      effectsPending = true;
      perfMeasure(EDIT_PERF.commitRendered, EDIT_PERF.commit);
      perfMeasureAtFrame(EDIT_PERF.commitFrame, EDIT_PERF.commit);
      perfMeasureAfterPaint(EDIT_PERF.commitPainted, EDIT_PERF.commit);
    },
    cancel() {
      finish(false);
    },
    committedEffects() {
      if (!effectsPending) return;
      effectsPending = false;
      perfMeasure(EDIT_PERF.commitEffects, EDIT_PERF.commit);
    },
  };
}

/** `createEditGesture`, held for the pane's lifetime and fed each render's view. */
export function useEditGesture(
  editAreaRef: RefObject<HTMLDivElement | null>,
  feedbackRef: RefObject<EditFeedbackHandle | null>,
  toolRef: RefObject<TrimTool>,
  view: EditGestureView,
): EditGestureController {
  const [controller] = useState(() => createEditGesture(editAreaRef, feedbackRef, toolRef, view));
  useLayoutEffect(() => {
    controller.setView(view);
  });
  // The commit's render: every clip is now laid out where the preview had it,
  // so the preview's inline styles come off in the same frame, before paint.
  useLayoutEffect(() => {
    controller.committedRendered();
  }, [controller, view.timeline]);
  // The same commit's passive effects (perf mark `commit-effects`).
  useEffect(() => {
    controller.committedEffects();
  }, [controller, view.timeline]);
  useEffect(() => () => controller.cancel(), [controller]);
  return controller;
}
