/**
 * `@apelles/editor` — the timeline's beat grid (D-413): the beats of the
 * track that carries `beat_grid`, placed on TIMELINE frames, and the plan for
 * snapping cuts to them.
 *
 * **What it is.** Pure functions over a `Timeline` and the per-file analyses
 * `@apelles/bridge`'s `detectBeats` answers (file seconds):
 *
 * - [`gridTrackIndex`] — which track sets the grid, if any;
 * - [`timelineBeats`] — every beat each of that track's clips actually plays,
 *   mapped through the clip's trim, timeline position, native rate and speed
 *   ramp (`clipTimelineFrameAtSource`, the same remap the speed-ramp editor
 *   uses), so a music bed cut by D-408's dropouts keeps its beats exactly where
 *   they are heard;
 * - [`beatFramesOf`] — the frames of one kind, for snapping;
 * - [`planCutSnaps`] — for every cut on a track (an edit point between two
 *   touching clips), the roll that moves it onto the nearest beat, checked by
 *   dry-running the real `roll` op, so the report never promises a roll the
 *   clips' handles cannot make.
 *
 * The GUI (beat lane, drag/trim/playhead snapping, "Snap cuts to beats") and
 * the MCP ops (`editor_detect_beats`, `editor_snap_cuts_to_beats`) call these
 * same functions.
 *
 * **What it does NOT do.** No analysis and no Tauri (that is the bridge), and
 * no writes: a plan is applied by the caller through the `rolls` op.
 */
import { isBeatOfKind, nearestIndex, type BeatKind, type FileBeats } from '@apelles/beats';
import {
  applyOp,
  clipTimelineFrameAtSource,
  endFrame,
  timelineFps,
  type Clip,
  type Timeline,
  type Track,
} from './timeline';

/** One beat on the timeline. */
export interface TimelineBeat {
  /** TIMELINE frame. */
  frame: number;
  /** Bar / position in the bar, from the clip's file (`apelles_beat::Beat`). */
  bar: number;
  beat: number;
  downbeat: boolean;
  strong: boolean;
  strength: number;
  /** Storage index of the clip on the grid track that plays it. */
  clip: number;
}

/** The index of the track whose music sets the grid, or `null`. */
export function gridTrackIndex(tl: Timeline | null | undefined): number | null {
  if (!tl) return null;
  const i = tl.tracks.findIndex((t) => t.beat_grid != null);
  return i < 0 ? null : i;
}

/** The analysis question for one file of a grid track. */
export interface GridQuery {
  path: string;
  meter: number | null;
  tempoHintBpm: number | null;
}

/** The distinct files a grid track's clips read, with the track's params. */
export function gridQueries(track: Track): GridQuery[] {
  const meter = track.beat_grid?.meter ?? null;
  const tempoHintBpm = track.beat_grid?.tempo_hint_bpm ?? null;
  const paths = [...new Set(track.clips.map((c) => c.source_path).filter((p) => p.length > 0))].sort();
  return paths.map((path) => ({ path, meter, tempoHintBpm }));
}

/** The beats one clip plays, on timeline frames. */
export function clipBeats(c: Clip, clipIndex: number, beats: FileBeats, fps: number): TimelineBeat[] {
  const srcFps = c.source_fps && c.source_fps > 0 ? c.source_fps : fps;
  const end = endFrame(c, fps);
  const out: TimelineBeat[] = [];
  for (const b of beats.analysis.beats) {
    const sourceFrame = b.time * srcFps;
    // Before the clip's in point: not played. Past its out point: the remap
    // lands after `end` and is dropped below.
    if (sourceFrame < c.source_start) continue;
    const frame = clipTimelineFrameAtSource(c, sourceFrame, fps);
    if (frame < c.start_frame || frame >= end) continue;
    out.push({
      frame,
      bar: b.bar,
      beat: b.beat,
      downbeat: b.downbeat,
      strong: b.strong,
      strength: b.strength,
      clip: clipIndex,
    });
  }
  return out;
}

/** Every beat track `track` plays, ascending by frame, one per frame (the
 *  stronger wins where two clips' beats land on the same frame). Clips whose
 *  file has no analysis yet are reported in `pending`. */
export function trackBeats(
  tl: Timeline,
  track: number,
  beatsFor: (path: string) => FileBeats | undefined,
): { beats: TimelineBeat[]; pending: string[] } {
  const tr = tl.tracks[track];
  if (!tr) return { beats: [], pending: [] };
  const fps = timelineFps(tl);
  const pending = new Set<string>();
  const all: TimelineBeat[] = [];
  tr.clips.forEach((c, i) => {
    const fb = beatsFor(c.source_path);
    if (!fb) {
      pending.add(c.source_path);
      return;
    }
    all.push(...clipBeats(c, i, fb, fps));
  });
  all.sort((a, b) => a.frame - b.frame || b.strength - a.strength);
  const beats: TimelineBeat[] = [];
  for (const b of all) {
    if (beats.length > 0 && beats[beats.length - 1].frame === b.frame) continue;
    beats.push(b);
  }
  return { beats, pending: [...pending].sort() };
}

/** [`trackBeats`] of the grid track (none when no track carries a grid). */
export function timelineBeats(
  tl: Timeline,
  beatsFor: (path: string) => FileBeats | undefined,
): { track: number | null; beats: TimelineBeat[]; pending: string[] } {
  const track = gridTrackIndex(tl);
  if (track === null) return { track: null, beats: [], pending: [] };
  return { track, ...trackBeats(tl, track, beatsFor) };
}

/** The frames of the beats of `kind`, ascending. */
export function beatFramesOf(beats: readonly TimelineBeat[], kind: BeatKind = 'beat'): number[] {
  return beats.filter((b) => isBeatOfKind(b, kind)).map((b) => b.frame);
}

/** The median distance between consecutive beats, in frames (0 for < 2). */
export function medianBeatSpacing(beats: readonly TimelineBeat[]): number {
  if (beats.length < 2) return 0;
  const gaps = beats.slice(1).map((b, i) => b.frame - beats[i].frame).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** One cut's outcome in a snap plan. */
export interface CutSnap {
  /** Storage index of the OUTGOING clip (the `roll` op's `clip`). */
  clip: number;
  /** The cut as it is now, timeline frame. */
  fromFrame: number;
  /** Where it lands, or `null` when it is left alone. */
  toFrame: number | null;
  /** Why it is left alone. */
  reason?: string;
}

export interface CutSnapPlan {
  rolls: Array<{ clip: number; delta: number }>;
  cuts: CutSnap[];
}

/** Every edit point on `track`: outgoing clip index + the frame it ends at,
 *  where another clip on the track starts exactly there. Time order. */
export function cutsOf(tl: Timeline, track: number): Array<{ clip: number; frame: number }> {
  const fps = timelineFps(tl);
  const tr = tl.tracks[track];
  if (!tr) return [];
  const out: Array<{ clip: number; frame: number }> = [];
  tr.clips.forEach((c, i) => {
    const e = endFrame(c, fps);
    if (tr.clips.some((o, j) => j !== i && o.start_frame === e)) out.push({ clip: i, frame: e });
  });
  return out.sort((a, b) => a.frame - b.frame);
}

/**
 * The rolls that put each cut on `track` onto its nearest beat frame among
 * `targets` within `maxShift` frames. `onlyClips` restricts it to the cuts
 * after those outgoing clips. Each roll is dry-run in sequence through the
 * real `roll` op; one that cannot land exactly (handles, link groups, a lock)
 * is left out with its reason rather than applied partially.
 */
export function planCutSnaps(
  tl: Timeline,
  track: number,
  targets: readonly number[],
  maxShift: number,
  onlyClips?: readonly number[],
): CutSnapPlan {
  const fps = timelineFps(tl);
  const plan: CutSnapPlan = { rolls: [], cuts: [] };
  let cur = tl;
  const wanted = onlyClips ? new Set(onlyClips) : null;
  for (const cut of cutsOf(tl, track)) {
    if (wanted && !wanted.has(cut.clip)) continue;
    const i = nearestIndex(targets, cut.frame);
    if (i < 0 || Math.abs(targets[i] - cut.frame) > maxShift) {
      plan.cuts.push({ ...cutFields(cut), toFrame: null, reason: `no beat within ${maxShift} frames` });
      continue;
    }
    const to = targets[i];
    if (to === cut.frame) {
      plan.cuts.push({ ...cutFields(cut), toFrame: null, reason: 'already on a beat' });
      continue;
    }
    const delta = to - cut.frame;
    const next = applyOp(cur, { kind: 'roll', track, clip: cut.clip, delta });
    const landed = endFrame(next.tracks[track].clips[cut.clip], fps);
    if (next === cur || landed !== to) {
      plan.cuts.push({
        ...cutFields(cut),
        toFrame: null,
        reason:
          next === cur
            ? 'the roll cannot move this cut (no media handle on one side, a locked track, or a link group that cannot follow)'
            : `the clips' media can only roll ${landed - cut.frame} of ${delta} frames (not enough handle)`,
      });
      continue;
    }
    cur = next;
    plan.rolls.push({ clip: cut.clip, delta });
    plan.cuts.push({ ...cutFields(cut), toFrame: to });
  }
  return plan;
}

function cutFields(cut: { clip: number; frame: number }): Pick<CutSnap, 'clip' | 'fromFrame'> {
  return { clip: cut.clip, fromFrame: cut.frame };
}
