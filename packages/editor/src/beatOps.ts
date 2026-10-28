/**
 * `@apelles/editor` — the beat-grid ops, shared by the MCP tools and the
 * timeline's own controls (D-413).
 *
 * - `editor_detect_beats` — analyse a track's music (tempo, beats, downbeats,
 *   accents) and, by default, show its grid on the timeline;
 * - `editor_set_beat_grid` — show / hide a track's grid without analysing
 *   (the track header's metronome toggle);
 * - `editor_snap_cuts_to_beats` — roll every cut on a track onto its nearest
 *   beat as ONE undo step (the toolbar's "Snap cuts to beats").
 *
 * The GUI calls [`setBeatGrid`] and [`snapCutsToBeats`] below — the functions
 * the tools call — so a person and an agent make identical edits through the
 * same `set_beat_grid` / `rolls` ops.
 *
 * **What it does NOT do.** No analysis of its own (`@apelles/bridge`'s
 * `detectBeats` → `apelles-beat`), no judgement about which cuts deserve a
 * beat, and never a ripple: a roll keeps every clip's neighbours touching and
 * the sequence's length unchanged.
 */
import { beatParamsProblem, isBeatOfKind, type BeatKind, type FileBeats } from '@apelles/beats';
import { detectBeats, type BeatQuery } from '@apelles/bridge';
import {
  beatFramesOf,
  gridQueries,
  gridTrackIndex,
  medianBeatSpacing,
  planCutSnaps,
  trackBeats,
  type CutSnapPlan,
  type TimelineBeat,
} from './beatGrid';
import type { BeatGrid, Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

type OpArgs = Record<string, unknown> | undefined;

/** At most this many beats come back in one answer; filter by window or kind for more. */
export const MAX_BEATS_RETURNED = 1000;

/** B-301 — how many leading beats the default (summary) answer carries. */
export const SUMMARY_BEATS = 8;

const KINDS: readonly BeatKind[] = ['beat', 'downbeat', 'strong'];

function kindArg(raw: unknown, fallback: BeatKind): BeatKind | { error: string } {
  if (raw === undefined || raw === null) return fallback;
  return KINDS.includes(raw as BeatKind)
    ? (raw as BeatKind)
    : { error: `kind must be one of ${KINDS.join(' | ')}` };
}

function trackArg(tl: Timeline, raw: unknown): number | { error: string } {
  const track = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(track) || !tl.tracks[track]) {
    return { error: `track must be a track index, 0..${tl.tracks.length - 1}` };
  }
  return track;
}

/** A track's grid params from loose args, or the reason they are wrong. */
function gridArg(a: OpArgs): BeatGrid | { error: string } {
  const meter = a?.meter ?? undefined;
  const hint = a?.tempoHintBpm ?? undefined;
  const problem = beatParamsProblem(meter, hint);
  if (problem) return { error: problem };
  const g: BeatGrid = {};
  if (typeof meter === 'number') g.meter = meter;
  if (typeof hint === 'number') g.tempo_hint_bpm = hint;
  return g;
}

function sameGrid(a: BeatGrid | null | undefined, b: BeatGrid | null): boolean {
  if (!a || !b) return !a && !b;
  return (a.meter ?? null) === (b.meter ?? null) && (a.tempo_hint_bpm ?? null) === (b.tempo_hint_bpm ?? null);
}

/** Show `grid` on `track` (clearing every other track's), or hide the grid
 *  when `track` is `null`. One undo step; nothing when it is already so. */
export function setBeatGrid(track: number | null, grid: BeatGrid | null): void {
  const store = useEditorTimelineStore.getState();
  const tl = store.timeline;
  if (!tl) return;
  if (track === null) {
    const cur = gridTrackIndex(tl);
    if (cur !== null) store.applyOp({ kind: 'set_beat_grid', track: cur, grid: null });
    return;
  }
  if (gridTrackIndex(tl) === track && sameGrid(tl.tracks[track].beat_grid, grid)) return;
  store.applyOp({ kind: 'set_beat_grid', track, grid });
}

/** The analyses of every file `queries` names (awaited), keyed by path. */
async function analyse(
  queries: readonly BeatQuery[],
  force: boolean,
): Promise<{ byPath: Map<string, FileBeats>; failed: Array<{ path: string; error: string }> }> {
  const byPath = new Map<string, FileBeats>();
  const failed: Array<{ path: string; error: string }> = [];
  const settled = await Promise.allSettled(queries.map((q) => detectBeats(q, force)));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') byPath.set(queries[i].path, r.value);
    else failed.push({ path: queries[i].path, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { byPath, failed };
}

function beatDto(b: TimelineBeat) {
  return {
    frame: b.frame,
    bar: b.bar,
    beat: b.beat,
    downbeat: b.downbeat,
    strong: b.strong,
    strength: b.strength,
    clip: b.clip,
  };
}

/**
 * B-301 — the beats part of an `editor_detect_beats` answer. A real track has
 * hundreds of beats (the full list was 40-68 KB per call), so the default is a
 * summary: the first [`SUMMARY_BEATS`] and `truncated: true`. `full: true`
 * returns the list, paged by `offset` / `limit` (at most [`MAX_BEATS_RETURNED`]
 * per page); `nextOffset` is set when more remain.
 */
function beatListing(chosen: readonly TimelineBeat[], a: OpArgs) {
  if (a?.full !== true) {
    return {
      truncated: chosen.length > SUMMARY_BEATS,
      beats: chosen.slice(0, SUMMARY_BEATS).map(beatDto),
    };
  }
  const offset = typeof a.offset === 'number' && a.offset > 0 ? Math.floor(a.offset) : 0;
  const asked = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : MAX_BEATS_RETURNED;
  const limit = Math.min(asked, MAX_BEATS_RETURNED);
  const page = chosen.slice(offset, offset + limit);
  const end = offset + page.length;
  return {
    offset,
    truncated: end < chosen.length,
    nextOffset: end < chosen.length ? end : null,
    beats: page.map(beatDto),
  };
}

/** `editor_detect_beats`. */
export async function detectTrackBeats(tl: Timeline, a: OpArgs) {
  const track = trackArg(tl, a?.track);
  if (typeof track !== 'number') return track;
  const tr = tl.tracks[track];
  if (tr.kind === 'subtitle') return { error: `track ${track} is a subtitle track — pass the track holding the music` };
  if (tr.clips.length === 0) return { error: `track ${track} has no clips to analyse` };
  const grid = gridArg(a);
  if ('error' in grid) return grid;
  const kind = kindArg(a?.kind, 'beat');
  if (typeof kind !== 'string') return kind;
  const show = a?.show !== false;
  const force = a?.force === true;

  const queries = gridQueries({ ...tr, beat_grid: grid });
  const { byPath, failed } = await analyse(queries, force);
  if (byPath.size === 0) {
    return { error: `no clip on track ${track} could be analysed`, failed };
  }
  if (show) setBeatGrid(track, grid);

  // Place the beats on the timeline as it is NOW (the grid op above changed
  // no clip, so this is the same timeline the analysis was asked about).
  const now = useEditorTimelineStore.getState().timeline ?? tl;
  const placed = trackBeats(now, track, (p) => byPath.get(p));
  const from = typeof a?.startFrame === 'number' ? a.startFrame : Number.NEGATIVE_INFINITY;
  const to = typeof a?.endFrame === 'number' ? a.endFrame : Number.POSITIVE_INFINITY;
  const chosen = placed.beats.filter((b) => b.frame >= from && b.frame <= to && isBeatOfKind(b, kind));
  return {
    track,
    shown: show,
    meter: grid.meter ?? 4,
    tempoBpm: [...byPath.values()][0]?.analysis.tempoBpm ?? 0,
    files: [...byPath.values()].map((fb) => ({
      path: fb.path,
      tempoBpm: fb.analysis.tempoBpm,
      beats: fb.analysis.beats.length,
      downbeats: fb.analysis.beats.filter((b) => b.downbeat).length,
      durationSecs: fb.analysis.duration,
      truncated: fb.truncated,
      cached: fb.cached,
      contentHash: fb.contentHash,
    })),
    failed,
    beatSpacingFrames: medianBeatSpacing(placed.beats),
    totalBeatsOnTimeline: placed.beats.length,
    kind,
    beatCount: chosen.length,
    downbeatCount: chosen.filter((b) => b.downbeat).length,
    strongCount: chosen.filter((b) => b.strong).length,
    ...beatListing(chosen, a),
  };
}

/** `editor_set_beat_grid`. */
export function setBeatGridOp(tl: Timeline, a: OpArgs) {
  if (a?.track === null || a?.track === undefined) {
    setBeatGrid(null, null);
    return { ok: true, track: null };
  }
  const track = trackArg(tl, a.track);
  if (typeof track !== 'number') return track;
  if (tl.tracks[track].kind === 'subtitle') return { error: `track ${track} is a subtitle track` };
  const grid = gridArg(a);
  if ('error' in grid) return grid;
  setBeatGrid(track, grid);
  return { ok: true, track, beatGrid: grid };
}

/** The grid's beats, analysed if they are not yet. */
async function gridBeats(tl: Timeline): Promise<{ beats: TimelineBeat[] } | { error: string }> {
  const g = gridTrackIndex(tl);
  if (g === null) {
    return { error: 'no beat grid is shown — run editor_detect_beats on the music track first (or toggle its metronome)' };
  }
  const { byPath, failed } = await analyse(gridQueries(tl.tracks[g]), false);
  if (byPath.size === 0) return { error: `the music on track ${g} could not be analysed: ${failed.map((f) => f.error).join('; ')}` };
  return { beats: trackBeats(tl, g, (p) => byPath.get(p)).beats };
}

/** Plan (and unless `dryRun`, apply as one undo step) rolling every cut on
 *  `track` onto its nearest beat of `kind`. The toolbar button and the MCP
 *  tool both land here. */
export async function snapCutsToBeats(
  track: number,
  kind: BeatKind,
  opts: { maxShiftFrames?: number; clips?: readonly number[]; dryRun?: boolean } = {},
): Promise<{ plan: CutSnapPlan; maxShiftFrames: number; applied: number } | { error: string }> {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return { error: 'no timeline is open' };
  if (!tl.tracks[track]) return { error: `no track ${track}` };
  const got = await gridBeats(tl);
  if ('error' in got) return got;
  const spacing = medianBeatSpacing(got.beats);
  const maxShift = opts.maxShiftFrames ?? Math.max(1, Math.floor(spacing / 2));
  // Re-read: the timeline may have changed while the analysis ran.
  const cur = useEditorTimelineStore.getState().timeline ?? tl;
  const plan = planCutSnaps(cur, track, beatFramesOf(got.beats, kind), maxShift, opts.clips);
  if (!opts.dryRun && plan.rolls.length > 0) {
    useEditorTimelineStore.getState().applyOp({ kind: 'rolls', track, rolls: plan.rolls });
  }
  return { plan, maxShiftFrames: maxShift, applied: opts.dryRun ? 0 : plan.rolls.length };
}

/** `editor_snap_cuts_to_beats`. */
export async function snapCutsToBeatsOp(tl: Timeline, a: OpArgs) {
  const track = trackArg(tl, a?.track);
  if (typeof track !== 'number') return track;
  const kind = kindArg(a?.to, 'beat');
  if (typeof kind !== 'string') return kind;
  const maxShift = a?.maxShiftFrames;
  if (maxShift !== undefined && maxShift !== null && (typeof maxShift !== 'number' || !Number.isInteger(maxShift) || maxShift < 1)) {
    return { error: 'max_shift_frames must be a whole number of frames, at least 1' };
  }
  const clips = a?.clips;
  if (clips !== undefined && clips !== null && (!Array.isArray(clips) || clips.some((c) => !Number.isInteger(c)))) {
    return { error: 'clips must be a list of clip indices on the track (the OUTGOING clip of each cut)' };
  }
  const r = await snapCutsToBeats(track, kind, {
    maxShiftFrames: typeof maxShift === 'number' ? maxShift : undefined,
    clips: Array.isArray(clips) ? (clips as number[]) : undefined,
    dryRun: a?.dryRun === true,
  });
  if ('error' in r) return r;
  return {
    track,
    to: kind,
    dryRun: a?.dryRun === true,
    maxShiftFrames: r.maxShiftFrames,
    applied: r.applied,
    moved: r.plan.cuts.filter((c) => c.toFrame !== null).length,
    cuts: r.plan.cuts,
  };
}
