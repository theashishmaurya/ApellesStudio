/**
 * @apelles/editor — the pure half of the timeline's edit gestures (D-432 P2,
 * `docs/notes/ui-redesign.md` §4.4 / §5.1).
 *
 * What it is: everything a trim / ripple / roll / slip / slide drag decides
 * that has a right answer, as plain functions over a `Timeline`:
 *   - the `EditOp` a drag of N frames commits (`editOpFor`, a thin wrap of
 *     `trimMode.ts`'s `trimOpFor`, so the gesture and the D-235 mode rule can
 *     never disagree);
 *   - the LIVE PREVIEW of that drag (`previewEdit`): the op is applied to the
 *     timeline with the very `applyOp` the store commits with, and the result
 *     is diffed clip by clip — so what moves on screen while the hand moves is
 *     exactly what the drop will commit, ripple across sync-locked tracks and
 *     linked A/V halves included, with no second model of any edit;
 *   - the clamp: a drag past a media limit or a neighbour previews (and
 *     commits) the furthest legal delta and reports `limited`, which turns the
 *     bracket and the readout red;
 *   - the edit-point brackets each tool highlights, the snap rule and the
 *     readout text.
 *
 * What it does NOT do: touch the DOM, read the pointer, or render. The
 * imperative half (pointer capture, per-frame transforms, the overlay
 * elements) is `useEditGesture.ts` / `EditFeedbackLayer.tsx`.
 *
 * Why it replaced the timeline library's own interact.js resize for trims:
 * that resize wrote `left`/`width` on the library's wrapper per move, moved
 * only the one clip (no neighbour followed a ripple or a roll), and lost the
 * sub-grid remainder of every move, so a 15-frame drag committed 13 (the first
 * D-434 harness run, 2026-10-31). Here the delta is the pointer's own total
 * displacement, converted once.
 */

import {
  applyOp,
  endFrame,
  timelineFps,
  type Clip,
  type EditOp,
  type Timeline,
} from './timeline';
import { outgoingClipAt, trimOpFor } from './trimMode';

/** The five edits a drag on a clip can be (`move` is dnd-kit's, not ours). */
export type EditGestureMode = 'trim' | 'ripple' | 'roll' | 'slip' | 'slide';

export interface EditTarget {
  mode: EditGestureMode;
  track: number;
  /** the pressed clip's index in its track */
  clip: number;
  /** which edge was pressed; for a body press (slip/slide) `'end'` by convention */
  edge: 'start' | 'end';
}

/** The `EditOp` a drag of `delta` timeline frames commits, or `null`. */
export function editOpFor(tl: Timeline, target: EditTarget, delta: number): EditOp | null {
  if (delta === 0) return null;
  return trimOpFor(target.mode, { tl, track: target.track, clip: target.clip, edge: target.edge, delta });
}

/** How one clip moved between the timeline before the drag and the preview. */
export interface ClipShift {
  id: string;
  track: number;
  /** change of `start_frame`, timeline frames */
  dStart: number;
  /** change of the clip's end frame, timeline frames */
  dEnd: number;
  /** change of `source_start`, in SECONDS of source — what slides the clip's
   *  own picture/waveform inside it (a slip, a head trim) */
  dSourceSecs: number;
}

export interface EditPreview {
  /** the delta that really applies, timeline frames (≤ the requested one in size) */
  delta: number;
  /** the request ran into a limit (media, neighbour, 1-frame floor) */
  limited: boolean;
  /** the timeline as the drop would leave it (=== the input when nothing changes) */
  after: Timeline;
  /** every clip whose geometry or source window changed */
  shifts: ClipShift[];
}

interface ClipGeom {
  track: number;
  start: number;
  end: number;
  sourceSecs: number;
}

function geomIndex(tl: Timeline): Map<string, ClipGeom> {
  const fps = timelineFps(tl);
  const m = new Map<string, ClipGeom>();
  tl.tracks.forEach((t, ti) =>
    t.clips.forEach((c) =>
      m.set(c.id, { track: ti, start: c.start_frame, end: endFrame(c, fps), sourceSecs: c.source_start / (c.source_fps ?? fps) }),
    ),
  );
  return m;
}

/** The quantity a mode's delta is read back from, so `delta`/`limited` report
 *  what really happened rather than what was asked. */
function probe(tl: Timeline, target: EditTarget): number | null {
  const fps = timelineFps(tl);
  const tr = tl.tracks[target.track];
  const c = tr?.clips[target.clip];
  if (!c) return null;
  switch (target.mode) {
    case 'trim':
    case 'ripple':
      return target.edge === 'start' ? c.start_frame : endFrame(c, fps);
    case 'roll': {
      // the cut itself: the outgoing clip's end
      const out = target.edge === 'end' ? target.clip : outgoingClipAt(tl, target.track, target.clip);
      const o = out === null ? null : tr.clips[out];
      return o ? endFrame(o, fps) : null;
    }
    case 'slip':
      return Math.round((c.source_start / (c.source_fps ?? fps)) * fps);
    case 'slide':
      return c.start_frame;
  }
}

function applied(tl: Timeline, target: EditTarget, delta: number): Timeline {
  const op = editOpFor(tl, target, delta);
  return op ? applyOp(tl, op) : tl;
}

/**
 * The live preview of dragging `target` by `requested` timeline frames.
 *
 * Some ops clamp internally (roll, slide, slip, a plain out-trim); others
 * refuse outright past a limit (`checkTrim`'s lockstep and overlap rules) and
 * return the timeline unchanged. For the second kind the furthest legal delta
 * is found by bisection between 0 and the request — legality is monotonic in
 * |delta| for every one of these edits (a limit, once hit, stays hit further
 * out), so ⌈log2 |requested|⌉ applies at most, and only while the pointer is
 * past a limit.
 */
export function previewEdit(tl: Timeline, target: EditTarget, requested: number, before?: Map<string, ClipGeom>): EditPreview {
  const none: EditPreview = { delta: 0, limited: false, after: tl, shifts: [] };
  if (requested === 0) return none;
  let delta = requested;
  let after = applied(tl, target, delta);
  if (after === tl) {
    let lo = 0;
    let hi = Math.abs(requested);
    const sign = Math.sign(requested);
    let best: Timeline = tl;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const t = applied(tl, target, sign * mid);
      if (t === tl) hi = mid;
      else {
        lo = mid;
        best = t;
      }
    }
    if (best === tl && lo === 0) {
      // even one frame is refused, or the 1-frame probe was never tried
      const one = applied(tl, target, sign);
      if (one === tl) return { ...none, limited: true };
      best = one;
      lo = 1;
    }
    delta = sign * lo;
    after = best;
  }
  const p0 = probe(tl, target);
  const p1 = probe(after, target);
  const real = p0 !== null && p1 !== null ? p1 - p0 : delta;
  const index = before ?? geomIndex(tl);
  const next = geomIndex(after);
  const shifts: ClipShift[] = [];
  next.forEach((g, id) => {
    const b = index.get(id);
    if (!b) return; // a clip the edit created (a sync-lock auto-split) has no "before" to move from
    const dStart = g.start - b.start;
    const dEnd = g.end - b.end;
    const dSourceSecs = g.sourceSecs - b.sourceSecs;
    if (dStart !== 0 || dEnd !== 0 || Math.abs(dSourceSecs) > 1e-9) {
      shifts.push({ id, track: g.track, dStart, dEnd, dSourceSecs });
    }
  });
  return { delta: real, limited: real !== requested, after, shifts };
}

/** The before-index `previewEdit` diffs against, built once per gesture. */
export function previewIndex(tl: Timeline): Map<string, ClipGeom> {
  return geomIndex(tl);
}

/** One bracket of an edit-point highlight: which clip edge, at which frame. */
export interface EditBracket {
  track: number;
  clipId: string;
  /** the timeline frame the edge sits on */
  frame: number;
  /** `'in'` draws `[` (a clip's head), `'out'` draws `]` (its tail) */
  side: 'in' | 'out';
}

function neighbourAt(clips: Clip[], self: number, frame: number, fps: number, side: 'before' | 'after'): number {
  return clips.findIndex((o, i) =>
    i !== self && (side === 'before' ? endFrame(o, fps) === frame : o.start_frame === frame),
  );
}

/**
 * What a tool highlights for `target` (spec §5.1 "Edit-point highlight"):
 * - trim / ripple: the pressed edge only;
 * - roll: both sides of the cut, `]` on the outgoing clip and `[` on the incoming one;
 * - slip: both edges of the one clip (FCP's "yellow edge selections on the start
 *   point and end point");
 * - slide: the NEIGHBOURS' inner edges, since those are what change (the clip's
 *   own edges where it has no neighbour).
 */
export function editBrackets(tl: Timeline, target: EditTarget): EditBracket[] {
  const fps = timelineFps(tl);
  const tr = tl.tracks[target.track];
  const c = tr?.clips[target.clip];
  if (!c) return [];
  const start = c.start_frame;
  const end = endFrame(c, fps);
  const own = (side: 'in' | 'out'): EditBracket => ({
    track: target.track,
    clipId: c.id,
    frame: side === 'in' ? start : end,
    side,
  });
  switch (target.mode) {
    case 'trim':
    case 'ripple':
      return [own(target.edge === 'start' ? 'in' : 'out')];
    case 'roll': {
      const cut = target.edge === 'start' ? start : end;
      const other = neighbourAt(tr.clips, target.clip, cut, fps, target.edge === 'start' ? 'before' : 'after');
      const o = other >= 0 ? tr.clips[other] : null;
      const mine = own(target.edge === 'start' ? 'in' : 'out');
      if (!o) return [mine];
      const theirs: EditBracket = { track: target.track, clipId: o.id, frame: cut, side: mine.side === 'in' ? 'out' : 'in' };
      return mine.side === 'out' ? [mine, theirs] : [theirs, mine];
    }
    case 'slip':
      return [own('in'), own('out')];
    case 'slide': {
      const prev = neighbourAt(tr.clips, target.clip, start, fps, 'before');
      const next = neighbourAt(tr.clips, target.clip, end, fps, 'after');
      return [
        prev >= 0 ? { track: target.track, clipId: tr.clips[prev].id, frame: start, side: 'out' } : own('in'),
        next >= 0 ? { track: target.track, clipId: tr.clips[next].id, frame: end, side: 'in' } : own('out'),
      ];
    }
  }
}

/** The frame a drag of `delta` puts the gesture's moving edge on, which is
 *  what snaps (slip moves no edge, so it never snaps). */
export function movingEdgeFrame(tl: Timeline, target: EditTarget): number | null {
  if (target.mode === 'slip') return null;
  const fps = timelineFps(tl);
  const c = tl.tracks[target.track]?.clips[target.clip];
  if (!c) return null;
  if (target.mode === 'slide') return c.start_frame;
  return target.edge === 'start' ? c.start_frame : endFrame(c, fps);
}

/** Every frame an edit may snap to: clip edges on every track (except the
 *  moving clip's own), the playhead and the markers — spec §5 "Snapping". */
export function snapTargets(tl: Timeline, exclude: { track: number; clipId: string } | null, extra: number[]): number[] {
  const fps = timelineFps(tl);
  const out = new Set<number>(extra);
  tl.tracks.forEach((t, ti) =>
    t.clips.forEach((c) => {
      if (exclude && ti === exclude.track && c.id === exclude.clipId) return;
      out.add(c.start_frame);
      out.add(endFrame(c, fps));
    }),
  );
  return [...out].sort((a, b) => a - b);
}

/**
 * Snap `frame` to the nearest target within `threshold` frames. `sticky` is
 * the target the edge is already held on: it lets go only past
 * `threshold × STICKY_FACTOR` (Palmier Pro's ×1.5), so an edge sitting on a
 * cut does not chatter on and off it as the hand trembles.
 */
export const SNAP_STICKY_FACTOR = 1.5;
export function snapFrame(
  frame: number,
  targets: readonly number[],
  threshold: number,
  sticky: number | null,
): { frame: number; target: number | null } {
  if (sticky !== null && Math.abs(frame - sticky) <= threshold * SNAP_STICKY_FACTOR) return { frame: sticky, target: sticky };
  let best: number | null = null;
  for (const t of targets) {
    const d = Math.abs(t - frame);
    if (d <= threshold && (best === null || d < Math.abs(best - frame))) best = t;
  }
  return best === null ? { frame, target: null } : { frame: best, target: best };
}

/** `±MM:SS:FF` (hours only when needed) for a signed timeline-frame count. */
export function signedTimecode(frames: number, fps: number): string {
  const sign = frames < 0 ? '−' : '+';
  return sign + timecode(Math.abs(frames), fps);
}

/** `MM:SS:FF` (hours only when needed). */
export function timecode(frames: number, fps: number): string {
  const whole = Math.max(1, Math.round(fps));
  const f = Math.max(0, Math.round(frames));
  const ff = f % whole;
  const total = Math.floor(f / whole);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (hh > 0 ? `${pad(hh)}:` : '') + `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * The text of the edge-pinned readout (spec §5.1 "Delta readout"):
 * trim / ripple `+00:00:12 → 00:04:03` (the delta and the new duration),
 * roll `+12f` under a second and a timecode above, slip the delta and the new
 * source in-point, slide the delta. At a clamp it ends in "Limit".
 */
export function editReadout(preview: EditPreview, target: EditTarget, fps: number): string {
  const { delta, after, limited } = preview;
  const c = after.tracks[target.track]?.clips[target.clip];
  let text: string;
  switch (target.mode) {
    case 'trim':
    case 'ripple':
      text = c ? `${signedTimecode(delta, fps)} → ${timecode(endFrame(c, fps) - c.start_frame, fps)}` : signedTimecode(delta, fps);
      break;
    case 'roll':
      text = Math.abs(delta) < Math.round(fps) ? `${delta < 0 ? '−' : '+'}${Math.abs(delta)}f` : signedTimecode(delta, fps);
      break;
    case 'slip':
      text = c
        ? `${signedTimecode(delta, fps)} · in ${timecode(Math.round((c.source_start / (c.source_fps ?? fps)) * fps), fps)}`
        : signedTimecode(delta, fps);
      break;
    case 'slide':
      text = signedTimecode(delta, fps);
      break;
  }
  return limited ? `${text} · Limit` : text;
}
