/**
 * @chroma/editor — context-sensitive trim: which edit a timeline drag really is
 * (D-235, roadmap item 27 "Ripple/roll/slip/slide by pointer position, not a
 * mode switch").
 *
 * WHAT THIS IS. The pure half of the smart trim tool: given where on a clip a
 * press landed, which modifiers were held, and whether that edge is a real edit
 * point, it answers WHICH of the six timeline drags this gesture is — and, given
 * a frame delta, builds the `EditOp` for it. Nothing here touches React, the
 * DOM, or the store; `TimelinePane.tsx` supplies the geometry and applies the op.
 *
 * WHAT IT IS NOT. It does not clamp, validate, or know about neighbours, link
 * groups or locked tracks — every one of those is `applyOp`'s own contract in
 * `timeline.ts`, which refuses an impossible op as a no-op. This module can
 * therefore always name a mode and always build an op; whether that op does
 * anything is deliberately the model's call, not the gesture's.
 *
 * THE RULE, AND WHERE IT COMES FROM (see D-235 for the full write-up).
 * Blackmagic's own copy for the reference this repo already keeps
 * (`scratch/resolve-reference/`, "Automatically Trim and Tighten", plus
 * `trim.jpg` — literally the four cursors Resolve swaps between): "The smart
 * trim tool automatically switches between ripple, roll, slip and slide based on
 * the location of the mouse pointer. This makes DaVinci Resolve faster because
 * you don't have to waste time going back and forth to switch trimming tools."
 * Resolve's actual geometry, cross-checked against its own documentation and
 * two independent write-ups of it: ripple = "slightly in from the edge of the
 * clip"; roll = "directly within an edit point... where one clip connects to
 * another"; slip = over the clip's thumbnails; slide = under the thumbnails, on
 * the clip's title bar. Apple's Final Cut Pro help describes the same four with
 * the same horizontal split, differing only in how it separates the last two:
 * with the Trim tool, dragging a clip's middle is a slip and OPTION-dragging it
 * is a slide.
 *
 * Chroma takes Resolve's horizontal axis verbatim, Resolve's vertical band for
 * slip-vs-slide, and adds ONE thing neither reference needs: an Alt/Option
 * "arm". Resolve and FCP both put these four behind a tool the user has already
 * switched into (Resolve's Trim Edit Mode, `T`); Chroma has no tool palette and
 * the roadmap explicitly asks for no mode switch, so the plain, unmodified
 * gestures must keep meaning exactly what they have always meant — a body drag
 * is `move` (D-100) and an edge drag is a plain, gap-leaving `trim` (D-058).
 * A held key is a transient arm, not a mode: nothing is remembered between
 * gestures, which is the property the roadmap item is actually asking for.
 */

import type { EditOp, Timeline } from './timeline';
import { endFrame, timelineFps } from './timeline';

/** The six things a press on a timeline clip can turn into. `move` and `trim`
 *  are the pre-existing, unmodified gestures (D-100 / D-058); the other four
 *  are the smart trim tool proper. */
export type TrimMode = 'move' | 'trim' | 'ripple' | 'roll' | 'slip' | 'slide';

/** Where on a clip the press landed. The two edge zones are the timeline
 *  library's own 10px resize handles (`flexible: true`, D-051) — this module
 *  does not re-derive them, `TimelinePane` reports which one the library
 *  claimed. */
export type TrimZone = 'edge-start' | 'edge-end' | 'body';

export interface TrimGesture {
  zone: TrimZone;
  /** The smart-trim arm. Alt/Option is the one modifier this surface had left:
   *  Cmd/Ctrl-click already toggles a clip in the selection and Shift-click
   *  extends a range (`TimelinePane.tsx`), so either of those would collide
   *  with a real, shipped gesture on the same element. */
  altKey: boolean;
  shiftKey: boolean;
  /** Edge zones only — is there a clip on this track butted exactly against
   *  this edge? [`edgeIsEditPoint`] answers this from the timeline. */
  atEditPoint: boolean;
  /** Body only — where in the clip's row the press landed, 0 at its top edge
   *  and 1 at its bottom. Resolve's own slip-over-the-thumbnails /
   *  slide-under-them split. */
  bodyYRatio: number;
}

/** The body's slip/slide divide, as a fraction of the row's height.
 *
 *  Resolve splits at the bottom of the clip's thumbnail strip, which on its own
 *  timeline sits a little above the row's midpoint (the title bar under it is
 *  the shorter of the two). A clean half is used here instead: Chroma's clip
 *  rows are much shorter than Resolve's, a row's lower band already carries the
 *  waveform rather than a title bar, and at this row height an unequal split
 *  makes the smaller of the two a target the owner's own "widen the tight hit
 *  target" note (`INSERT_SNAP_PX`, D-100) is explicitly against. Two equal
 *  bands is the version of Resolve's rule that survives the row height Chroma
 *  actually has. */
export const SLIP_BAND_RATIO = 0.5;

/** Which edit a press really is. Total (every input combination names a mode)
 *  and pure — see the module doc for the rule's provenance.
 *
 *  Unarmed (no Alt) is always the pre-D-235 behaviour, unchanged: the body
 *  moves the clip, an edge trims it and leaves the gap. That is the property
 *  that makes this feature additive rather than a re-mapping of gestures the
 *  owner already has in their fingers. */
export function resolveTrimMode(g: TrimGesture): TrimMode {
  if (g.zone === 'body') {
    if (!g.altKey) return 'move';
    return g.bodyYRatio < SLIP_BAND_RATIO ? 'slip' : 'slide';
  }
  if (!g.altKey) return 'trim';
  // At an edit point BOTH ripple and roll are meaningful, and Resolve reaches
  // them by aiming at two hot zones a few pixels apart. Chroma cannot: the
  // library gives one 10px band per side and the seam between two touching
  // clips is the boundary BETWEEN those two bands, so "on the cut" and "just
  // inside a clip" are the same pixels here. Shift is the disambiguator
  // instead, and roll is what an unshifted edit point gives, because roll has
  // nowhere else it can live — there is no such thing as rolling a free edge —
  // whereas ripple is reachable at every edge on the timeline, including this
  // one, by adding Shift.
  if (g.shiftKey) return 'ripple';
  return g.atEditPoint ? 'roll' : 'ripple';
}

/** Is `edge` of the clip at `(track, clip)` a real edit point — another clip on
 *  the same track butted exactly against it, with no gap?
 *
 *  Positional, not index-based: `Track.clips` is storage order (D-054) and this
 *  model deliberately does not tie that to time order, so the clip before this
 *  one in the array need not be the one before it on screen. Mirrors the same
 *  lookup `applyOp`'s own `roll`/`slide` cases do, so the mode the pointer
 *  promises and the op the model performs can never disagree about where the
 *  edit points are. */
export function edgeIsEditPoint(tl: Timeline, track: number, clip: number, edge: 'start' | 'end'): boolean {
  const tr = tl.tracks[track];
  const c = tr?.clips[clip];
  if (!c) return false;
  const fps = timelineFps(tl);
  if (edge === 'start') {
    return tr.clips.some((o, i) => i !== clip && endFrame(o, fps) === c.start_frame);
  }
  const end = endFrame(c, fps);
  return tr.clips.some((o, i) => i !== clip && o.start_frame === end);
}

/** The `EditOp` a resolved `mode` commits, or `null` when that mode has no op
 *  of its own here (`move`, which `TimelinePane`'s dnd-kit drop path builds
 *  itself — it alone can land on a different track and so needs more than a
 *  frame delta).
 *
 *  `delta` is always a TIMELINE-frame delta in the drag's own direction, the
 *  single convention every op in `timeline.ts` already uses for a UI drag
 *  (B-077). `edge` is required for the two edge modes and ignored otherwise.
 *
 *  `roll` addresses the OUTGOING clip of the edit point (`applyOp`'s own
 *  contract), so a roll grabbed at a clip's START — where the outgoing clip is
 *  the one BEFORE it — is redirected to that clip by [`outgoingClipAt`] rather
 *  than being silently applied to the wrong side of the cut. */
export function trimOpFor(
  mode: TrimMode,
  args: { tl: Timeline; track: number; clip: number; edge: 'start' | 'end'; delta: number },
): EditOp | null {
  const { tl, track, clip, edge, delta } = args;
  switch (mode) {
    case 'move':
      return null;
    case 'trim':
      return { kind: edge === 'start' ? 'trim_start' : 'trim_end', track, clip, delta };
    case 'ripple':
      return { kind: edge === 'start' ? 'trim_start' : 'trim_end', track, clip, delta, ripple: true };
    case 'roll': {
      const outgoing = edge === 'end' ? clip : outgoingClipAt(tl, track, clip);
      return outgoing === null ? null : { kind: 'roll', track, clip: outgoing, delta };
    }
    case 'slip':
      return { kind: 'slip', track, clip, delta };
    case 'slide':
      return { kind: 'slide', track, clip, delta };
  }
}

/** The whole of what an EDGE-drag gesture decides, as one pure function: given
 *  where the timeline library says the clip's edge ended up and what the press
 *  that started it was holding, which `EditOp` (if any) should commit.
 *
 *  **Why this is a function and not just the body of `onActionResizeEndCb`.**
 *  That handler is called by `@xzdarcy/react-timeline-editor`'s own
 *  interact.js-driven resize, which does not run under jsdom at all — verified
 *  directly while building this, not assumed: a real `PointerEvent` sequence
 *  on the library's own `.timeline-editor-action-right-stretch` handle commits
 *  nothing in that environment, for a plain pre-D-235 trim exactly as much as
 *  for a ripple. So the decision every edge drag turns on is pulled out to
 *  here, where it is directly and exhaustively testable, and the handler is
 *  left as the two lines of adapter that read the library's arguments. Same
 *  pure-core / thin-shell split the whole repo is organised around (D-039);
 *  the untestable remainder is now too small to hide a bug in.
 *
 *  `dir` is the library's own word for which handle was dragged (`'left'` is
 *  the clip's head). `startFrame`/`endFrame` are where that drag left the
 *  clip's two edges, in timeline frames; the delta is derived against the
 *  clip's real current position, so a drag that ended where it began commits
 *  nothing. `press` is the captured modifier state, `null` meaning "unknown",
 *  which resolves to unarmed — the pre-D-235 behaviour, never a surprise. */
export function resizeEndOp(args: {
  tl: Timeline;
  track: number;
  clip: number;
  dir: 'left' | 'right';
  startFrame: number;
  endFrame: number;
  press: { altKey: boolean; shiftKey: boolean } | null;
}): EditOp | null {
  const { tl, track, clip, dir, press } = args;
  const c = tl.tracks[track]?.clips[clip];
  if (!c) return null;
  const edge = dir === 'left' ? 'start' : 'end';
  const delta = dir === 'left' ? args.startFrame - c.start_frame : args.endFrame - endFrame(c, timelineFps(tl));
  if (delta === 0) return null;
  const mode = resolveTrimMode({
    zone: dir === 'left' ? 'edge-start' : 'edge-end',
    altKey: press?.altKey ?? false,
    shiftKey: press?.shiftKey ?? false,
    atEditPoint: edgeIsEditPoint(tl, track, clip, edge),
    // An edge drag never consults the vertical band — see `resolveTrimMode`.
    bodyYRatio: 0,
  });
  return trimOpFor(mode, { tl, track, clip, edge, delta });
}

/** The body-drag counterpart of [`resizeEndOp`]: what an armed clip-body drag
 *  commits. Returns `null` when the gesture is not armed at all, which is the
 *  caller's signal to fall through to its own (unchanged) `move` path — the
 *  one gesture whose op this module deliberately does not build, because only
 *  the caller knows which track the drag landed on. */
export function bodyDragOp(args: {
  tl: Timeline;
  track: number;
  clip: number;
  delta: number;
  press: { altKey: boolean; shiftKey: boolean; bodyYRatio: number } | null;
}): EditOp | null {
  const { tl, track, clip, delta, press } = args;
  if (!press?.altKey) return null;
  if (delta === 0) return null;
  const mode = resolveTrimMode({
    zone: 'body',
    altKey: true,
    shiftKey: press.shiftKey,
    atEditPoint: false,
    bodyYRatio: press.bodyYRatio,
  });
  return trimOpFor(mode, { tl, track, clip, edge: 'end', delta });
}

/** The clip whose OUT point is the edit point at the start of `clip` — i.e. the
 *  outgoing side of that cut, which is how `roll` names an edit point. `null`
 *  when nothing is butted against it. */
export function outgoingClipAt(tl: Timeline, track: number, clip: number): number | null {
  const tr = tl.tracks[track];
  const c = tr?.clips[clip];
  if (!c) return null;
  const fps = timelineFps(tl);
  const i = tr.clips.findIndex((o, idx) => idx !== clip && endFrame(o, fps) === c.start_frame);
  return i < 0 ? null : i;
}

/** The label shown to the user for an armed mode — the readable stand-in for
 *  Resolve's four swapped cursors (`scratch/resolve-reference/trim.jpg`), which
 *  Chroma cannot reproduce without shipping four custom cursor bitmaps. `null`
 *  for the two unarmed modes, which need no announcement because they are what
 *  the surface has always done. */
export function trimModeLabel(mode: TrimMode): string | null {
  switch (mode) {
    case 'ripple':
      return 'Ripple';
    case 'roll':
      return 'Roll';
    case 'slip':
      return 'Slip';
    case 'slide':
      return 'Slide';
    default:
      return null;
  }
}
