/**
 * `@apelles/editor` — a window of a long TIMELINE, cut across every track
 * (B-336, D-411 §5.1).
 *
 * **What it is.** Pure functions that take the frames `[start, end)` of a source
 * timeline and return what plays there on EVERY track — picture, other audio,
 * titles, Motion renders, adjustment layers — as clips trimmed to the window and
 * moved to frame 0, so a Clipper short built from a timeline plays what the long
 * edit plays, not only the track its words were read from. The trimming is the
 * reducer's own `split` (so a linked A/V pair is cut in lock-step, keyframes and
 * speed ramps follow the clip), never a re-implementation.
 *
 * - [`sliceTimelineWindow`] — one window.
 * - [`reframeForShort`] — the Clipper's 9:16 treatment for a sliced picture clip:
 *   the cover transform [`coverTransform`] gives a file source, unless the editor
 *   laid that clip out by hand (a picture-in-picture, a zoom), which is kept.
 *
 * **What it does NOT do.** Decide the windows (the clean-cut gate's ranges),
 * place them back to back, caption, or touch the project; `clipBuild.ts` does.
 * Source captions are not carried: a short's captions are generated from its own
 * transcript, styled by the run's choice, like a file source's.
 */
import {
  applyOp,
  checkSplit,
  clipAt,
  CLIP_TRANSFORM_DEFAULTS,
  endFrame,
  type Clip,
  type Timeline,
  type Track,
} from '../timeline';

/** Transform parameters a reframe overrides; their keyframes belong to the long
 *  edit's 16:9 layout and are dropped with them. */
const LAYOUT_PARAMS = [
  'position_x',
  'position_y',
  'scale',
  'rotation',
  'crop_left',
  'crop_top',
  'crop_right',
  'crop_bottom',
] as const;

/** One track of a slice, with the index it had in the source timeline. */
export interface SlicedTrack {
  /** The track's index in the source timeline: slices of one source line up by it. */
  sourceIndex: number;
  track: Track;
}

/** The tracks of `source` over `[start, end)` (timeline frames), subtitle
 *  tracks excluded, every clip trimmed to the window and moved so the window
 *  starts at frame 0. Tracks with nothing in the window come back empty (the
 *  caller keeps the track so later windows line up). Locks are ignored: this
 *  edits a copy. */
export function sliceTimelineWindow(source: Timeline, start: number, end: number, fps: number): SlicedTrack[] {
  // Only the clips touching the window go through the reducer: a 300-clip
  // source timeline would otherwise be cloned whole for every split.
  const tracks: Track[] = source.tracks.map((t) => ({
    ...t,
    locked: false,
    clips: t.kind === 'subtitle' ? [] : t.clips.filter((c) => c.start_frame < end && endFrame(c, fps) > start),
  }));
  let tl: Timeline = { ...source, tracks, markers: [] };
  for (let ti = 0; ti < tl.tracks.length; ti++) {
    // The later boundary first: cutting at `start` would renumber the clip `end` falls in.
    for (const at of [end, start]) {
      const hit = clipAt(tl.tracks[ti], at, fps);
      // A boundary on a clip edge needs no split.
      if (!hit || at <= hit.clip.start_frame) continue;
      if (!checkSplit(tl, ti, hit.index, at, fps).ok) continue;
      tl = applyOp(tl, { kind: 'split', track: ti, clip: hit.index, atFrame: at });
    }
  }
  return tl.tracks
    .map((track, sourceIndex) => ({
      sourceIndex,
      track: {
        ...track,
        clips: track.clips
          .filter((c) => c.start_frame >= start && c.start_frame < end)
          .map((c) => ({ ...c, start_frame: c.start_frame - start })),
      },
    }))
    .filter((s) => s.track.kind !== 'subtitle');
}

/** Whether the editor placed a picture clip by hand (a scale, a position, a crop
 *  other than the defaults), as opposed to a plain full-frame clip. */
export function hasHandLayout(c: Clip): boolean {
  const d = CLIP_TRANSFORM_DEFAULTS;
  return (
    (c.scale !== undefined && c.scale !== d.scale) ||
    (c.position_x !== undefined && c.position_x !== d.position_x) ||
    (c.position_y !== undefined && c.position_y !== d.position_y) ||
    (c.rotation !== undefined && c.rotation !== d.rotation) ||
    !!c.crop_left ||
    !!c.crop_top ||
    !!c.crop_right ||
    !!c.crop_bottom ||
    c.box_width != null ||
    c.box_height != null
  );
}

/** Whether a clip on a video track is a plain picture (footage, a still, a
 *  Motion render) rather than a title, an adjustment layer or a caption. */
export function isPicture(c: Clip): boolean {
  return !c.text && !c.adjustment && !c.caption && !!c.source_path;
}

/** `c` laid out by `transform` (the cover transform for the short's frame): its
 *  long-edit layout, and the keyframes of that layout, are replaced. */
export function reframeForShort(c: Clip, transform: { scale: number; position_x: number; position_y: number }): Clip {
  const next: Clip = { ...c, ...transform };
  delete next.rotation;
  delete next.crop_left;
  delete next.crop_top;
  delete next.crop_right;
  delete next.crop_bottom;
  delete next.box_width;
  delete next.box_height;
  delete next.scaling;
  if (next.chroma_keyframes) {
    const kept = next.chroma_keyframes
      .map((k) => ({ ...k, params: Object.fromEntries(Object.entries(k.params).filter(([name]) => !(LAYOUT_PARAMS as readonly string[]).includes(name))) }))
      .filter((k) => Object.keys(k.params).length > 0);
    if (kept.length > 0) next.chroma_keyframes = kept;
    else delete next.chroma_keyframes;
  }
  return next;
}
