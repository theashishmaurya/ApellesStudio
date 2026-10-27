/**
 * `@apelles/editor` — the music-edit ops, shared by the MCP tools and the
 * Music edits panel (D-408).
 *
 * **What it is.** The stateful half of music edits by story beat:
 *
 * - `editor_music_edit` — one dropout / breath / dry section, applied now;
 * - `editor_propose_music_edits` — a batch stored for the person to review in
 *   the Music edits panel (replaces the track's set; nothing is cut);
 * - `editor_list_music_edits` — the review list as it stands (what the person
 *   accepted, rejected or adjusted);
 * - `editor_apply_music_edits` — apply the reviewed rows as ONE undo step.
 *
 * The panel's Apply button and its "Music dropout here" actions call
 * [`applyMusicRanges`] / [`applyProposalSet`] below — the same functions the
 * tools call — so the person and the agent land identical edits through the
 * one `music_edits` op.
 *
 * **Word anchors** resolve against the voice track's word-indexed view
 * (`editor_get_word_transcript`, D-380), read through the retake ops' own
 * helpers, and are refused outright on a stale `view_id` — never remapped.
 *
 * **What it does NOT do.** No judgement about which beats deserve a dropout
 * (that is the agent's reading of the script, or the person's ear), no audio
 * analysis, and no ripple: a music edit never moves the voice or the picture.
 */

import {
  applyMusicEdits,
  timelineFps,
  type MusicEditRange,
  type MusicEditResult,
  type Timeline,
} from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { readWordView, resolveWordViewInput, staleWordViewError } from './retakeProposalOps';
import { viewBasisKey } from './retakeWordView';
import {
  MUSIC_EDIT_KIND_LABELS,
  MUSIC_EDIT_KINDS,
  musicTrackFor,
  parseMusicEditRequest,
  resolveAnchor,
  rowDto,
  rowFrom,
  rowProblem,
  rowRange,
  rowsToApply,
  toMusicEditRange,
  usesWords,
  type MusicEditKind,
  type MusicEditProposalSet,
  type MusicEditRequest,
  type WordContext,
} from './musicEdits';
import { useMusicEditStore } from './musicEditStore';

type OpArgs = Record<string, unknown> | undefined;

/** The music track argument, checked against the timeline. */
function musicTrack(tl: Timeline, raw: unknown): { track: number } | { error: string } {
  const track = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(track)) return { error: 'track must be the index of the audio track holding the music bed' };
  const tr = tl.tracks[track];
  if (!tr) return { error: `no track ${track} (0..${tl.tracks.length - 1})` };
  if (tr.kind !== 'audio') return { error: `track ${track} is a ${tr.kind} track — pass the AUDIO track with the music bed` };
  return { track };
}

/** The voice track's word view, when any request needs it. */
async function wordContext(
  tl: Timeline,
  a: OpArgs,
  needed: boolean,
): Promise<
  { ctx: WordContext | null; wordTrack?: number; viewId?: string; basisKey?: string } | { error: string; viewId?: string }
> {
  if (!needed) return { ctx: null };
  const wordTrack = a?.wordTrack;
  const viewId = typeof a?.viewId === 'string' ? a.viewId : '';
  if (typeof wordTrack !== 'number' || !Number.isInteger(wordTrack)) {
    return { error: 'a word anchor needs word_track — the voice track you read with editor_get_word_transcript' };
  }
  if (!viewId) return { error: 'a word anchor needs view_id — the viewId editor_get_word_transcript returned' };
  const resolved = resolveWordViewInput(tl, { track: wordTrack }, false);
  if ('error' in resolved) return resolved;
  if ('pending' in resolved) {
    return { error: `track ${wordTrack} still has sources being transcribed — read it with editor_get_word_transcript first` };
  }
  const v = await readWordView(resolved.input, 0, 1, true);
  if (v.viewId !== viewId) return { error: staleWordViewError(v.viewId), viewId: v.viewId };
  return {
    ctx: { input: resolved.input, words: v.words ?? [] },
    wordTrack,
    viewId,
    basisKey: viewBasisKey(resolved.input),
  };
}

/** Parse and resolve a list of wire edits; the first malformed one refuses the call. */
async function resolveRequests(
  tl: Timeline,
  a: OpArgs,
  raw: unknown[],
): Promise<
  | {
      resolved: Array<{ req: MusicEditRequest; at: { start: number; end: number; text?: string; words?: { first: number; last: number } } }>;
      word: { wordTrack?: number; viewId?: string; basisKey?: string };
    }
  | { error: string }
> {
  const reqs: MusicEditRequest[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = parseMusicEditRequest(raw[i], raw.length === 1 ? 'the edit' : `edit ${i}`);
    if ('error' in r) return r;
    reqs.push(r);
  }
  const word = await wordContext(tl, a, reqs.some(usesWords));
  if ('error' in word) return word;
  const fps = timelineFps(tl);
  const resolved = [];
  for (let i = 0; i < reqs.length; i += 1) {
    const at = resolveAnchor(reqs[i], fps, word.ctx);
    if ('error' in at) return { error: `${reqs.length === 1 ? 'the edit' : `edit ${i}`}: ${at.error}` };
    resolved.push({ req: reqs[i], at });
  }
  return { resolved, word: { wordTrack: word.wordTrack, viewId: word.viewId, basisKey: word.basisKey } };
}

/** A result as the tools answer it. */
function resultDto(r: MusicEditResult, fps: number) {
  return {
    track: r.track,
    startFrame: r.start,
    endFrame: r.end,
    startSecs: Number((r.start / fps).toFixed(3)),
    endSecs: Number((r.end / fps).toFixed(3)),
    applied: r.applied,
    ...(r.applied ? { splits: r.splits, removed: r.removed } : { reason: r.reason }),
    ...(r.fadeOutClipId ? { fadeOutClipId: r.fadeOutClipId } : {}),
    ...(r.fadeInClipId ? { fadeInClipId: r.fadeInClipId } : {}),
  };
}

/**
 * Apply ranges to the live timeline as ONE `music_edits` op (one undo), after
 * a dry run through the identical pure function to learn each range's outcome
 * (B-197's rule: a batch answers per item). Nothing is dispatched when none
 * would land. The panel's actions call this too.
 */
export function applyMusicRanges(ranges: readonly MusicEditRange[]): {
  results: MusicEditResult[];
  applied: number;
} {
  const store = useEditorTimelineStore.getState();
  const tl = store.timeline;
  if (!tl) return { results: [], applied: 0 };
  const dry = applyMusicEdits(tl, ranges, timelineFps(tl));
  const landed = dry.results.filter((r) => r.applied);
  if (landed.length > 0) {
    // Only the ranges that land go into the op, so the journal records the
    // edit that happened rather than one whose replay refuses half of it.
    const edits = ranges.filter((_, i) => dry.results[i].applied);
    store.applyOp({ kind: 'music_edits', edits: [...edits] });
  }
  return { results: dry.results, applied: landed.length };
}

/**
 * Apply a proposal set's reviewed rows (accepted; plus pending when
 * `includePending`) as one undo step, then drop the rows that landed and keep
 * the rest. Shared by `editor_apply_music_edits` and the panel's Apply.
 */
export function applyProposalSet(
  track: number,
  includePending: boolean,
): { error: string } | { results: Array<{ id: string; result: MusicEditResult }>; applied: number } {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return { error: 'no timeline open' };
  const set = useMusicEditStore.getState().proposals[track];
  if (!set || set.timelineId !== tl.id) return { error: `track ${track} has no music edits to apply` };
  const rows = rowsToApply(set, includePending);
  if (rows.length === 0) {
    return {
      error: includePending
        ? `nothing to apply on track ${track} — every row is rejected`
        : `nothing to apply on track ${track} — no row is accepted yet (accept rows in the Music edits panel, or pass include_pending: true when the person has asked you to apply them)`,
    };
  }
  const { results, applied } = applyMusicRanges(rows.map((r) => rowRange(r, track)));
  const paired = rows.map((r, i) => ({ id: r.id, result: results[i] }));
  useMusicEditStore.getState().removeRows(
    track,
    paired.filter((p) => p.result.applied).map((p) => p.id),
  );
  return { results: paired, applied };
}

/** `editor_music_edit` — one edit, now. */
export async function musicEditNow(tl: Timeline, a: OpArgs) {
  const t = musicTrack(tl, a?.track);
  if ('error' in t) return t;
  const item: Record<string, unknown> = {
    kind: a?.kind,
    start_frame: a?.startFrame,
    end_frame: a?.endFrame,
    first_word: a?.firstWord,
    last_word: a?.lastWord,
    before_word: a?.beforeWord,
    length_frames: a?.lengthFrames,
    fade_out_frames: a?.fadeOutFrames,
    fade_in_frames: a?.fadeInFrames,
    mode: a?.mode,
  };
  const r = await resolveRequests(tl, a, [item]);
  if ('error' in r) return r;
  const { req, at } = r.resolved[0];
  const range = toMusicEditRange(req, at, t.track);
  const fps = timelineFps(tl);
  const { results } = applyMusicRanges([range]);
  const res = results[0];
  if (!res?.applied) return { error: res?.reason ?? 'the music edit made no change', ...(res ? resultDto(res, fps) : {}) };
  return {
    ok: true,
    kind: req.kind,
    ...(at.text ? { words: at.text } : {}),
    ...resultDto(res, fps),
    fadeOutFrames: range.fadeOutFrames,
    fadeInFrames: range.fadeInFrames,
    mode: range.mode,
    note: 'applied as ONE edit — a single undo reverses it. Read the bed back with editor_get_timeline.',
  };
}

/** `editor_propose_music_edits`. */
export async function proposeMusicEdits(tl: Timeline, a: OpArgs) {
  const t = musicTrack(tl, a?.track);
  if ('error' in t) return t;
  if (!Array.isArray(a?.edits)) return { error: 'edits must be an array (an empty one clears the proposals)' };
  const store = useMusicEditStore.getState();
  if (a.edits.length === 0) {
    store.setProposals(t.track, null);
    return { ok: true, track: t.track, cleared: true, note: 'this track has no proposed music edits now' };
  }
  const r = await resolveRequests(tl, a, a.edits);
  if ('error' in r) return r;
  const rows = r.resolved.map(({ req, at }, i) => rowFrom(`a${i}`, req, at, 'ai'));
  const set: MusicEditProposalSet = {
    timelineId: tl.id,
    track: t.track,
    ...(r.word.wordTrack !== undefined ? { wordTrack: r.word.wordTrack } : {}),
    ...(r.word.viewId ? { viewId: r.word.viewId } : {}),
    ...(r.word.basisKey ? { basisKey: r.word.basisKey } : {}),
    receivedAt: Date.now(),
    rows,
    nextId: 0,
  };
  store.setProposals(t.track, set);
  const fps = timelineFps(tl);
  const dtos = rows.map((row) => rowDto(row, fps, rowProblem(tl, row, t.track)));
  const problems = dtos.filter((d) => 'problem' in d).length;
  return {
    ok: true,
    track: t.track,
    proposed: rows.length,
    problems,
    edits: dtos,
    note:
      (problems > 0
        ? `${problems} edit(s) cannot be applied as they stand — see each one's problem; fix and resubmit EVERY edit (this call replaces the set). `
        : '') +
      'Nothing was cut. The edits are in the Music edits panel for the person to review (accept / reject / adjust, ' +
      'audition); apply with editor_apply_music_edits only when they ask you to.',
  };
}

/** `editor_list_music_edits`. */
export function listMusicEdits(tl: Timeline, a: OpArgs) {
  const fps = timelineFps(tl);
  const sets = Object.values(useMusicEditStore.getState().proposals).filter((s) => s.timelineId === tl.id);
  const wanted = a?.track === undefined || a?.track === null ? null : Number(a.track);
  const chosen = wanted === null ? sets : sets.filter((s) => s.track === wanted);
  return {
    ok: true,
    kinds: MUSIC_EDIT_KINDS,
    sets: chosen.map((s) => ({
      track: s.track,
      ...(s.wordTrack !== undefined ? { wordTrack: s.wordTrack, viewId: s.viewId } : {}),
      counts: {
        pending: s.rows.filter((r) => r.status === 'pending').length,
        accepted: s.rows.filter((r) => r.status === 'accepted').length,
        rejected: s.rows.filter((r) => r.status === 'rejected').length,
      },
      edits: s.rows.map((row) => rowDto(row, fps, rowProblem(tl, row, s.track))),
    })),
    note:
      chosen.length === 0
        ? 'no music edits are waiting for review'
        : 'statuses are the person\'s review; frames may have been adjusted by them since you proposed',
  };
}

/** `editor_apply_music_edits`. */
export function applyMusicEditsOp(tl: Timeline, a: OpArgs) {
  const t = musicTrack(tl, a?.track);
  if ('error' in t) return t;
  const out = applyProposalSet(t.track, !!a?.includePending);
  if ('error' in out) return out;
  const fps = timelineFps(tl);
  const failed = out.results.filter((r) => !r.result.applied);
  const body = {
    track: t.track,
    applied: out.applied,
    edits: out.results.map((r) => ({ id: r.id, ...resultDto(r.result, fps) })),
  };
  if (out.applied === 0) return { error: 'no edit could be applied — see each one\'s reason', ...body };
  return {
    ok: failed.length === 0,
    ...(failed.length > 0
      ? { error: `${failed.length} of ${out.results.length} edits were NOT applied — they stay in the panel with their reason; the rest landed as one undo step` }
      : {}),
    ...body,
    note: 'applied as ONE edit — a single undo reverses all of it. Read the bed back with editor_get_timeline.',
  };
}

/** A "music edit here" from the GUI: the panel's form, a transcript line's or
 *  a marker's context menu. */
export interface QuickMusicEdit {
  kind: MusicEditKind;
  start: number;
  end: number;
  /** What it is anchored to, for the review row (the line's words). */
  text?: string;
  /** Put it on the review list (accepted, ready to apply) instead of cutting now. */
  review?: boolean;
}

/** Make one GUI music edit with the panel's defaults, on the bed
 *  `musicTrackFor` resolves (the one under the range, or the panel's chosen
 *  bed). Returns a sentence for the person either way. */
export function quickMusicEdit(q: QuickMusicEdit): { ok: boolean; message: string } {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return { ok: false, message: 'Open a project first.' };
  const { defaults } = useMusicEditStore.getState();
  const track = musicTrackFor(tl, q.start, q.end, defaults.track);
  if ('error' in track) return { ok: false, message: track.error };
  const label = MUSIC_EDIT_KIND_LABELS[q.kind];
  const fps = timelineFps(tl);
  const where = `${(q.start / fps).toFixed(2)}–${(q.end / fps).toFixed(2)} s`;
  if (q.review) {
    useMusicEditStore.getState().addRow(track.track, tl.id, {
      kind: q.kind,
      origin: 'person',
      status: 'accepted',
      ...(q.text ? { text: q.text } : {}),
      start: q.start,
      end: q.end,
      fadeOutFrames: defaults.fadeOutFrames,
      fadeInFrames: defaults.fadeInFrames,
      mode: defaults.mode,
    });
    return { ok: true, message: `${label} (${where}) added to the Music edits list.` };
  }
  const { results } = applyMusicRanges([
    {
      track: track.track,
      start: q.start,
      end: q.end,
      fadeOutFrames: defaults.fadeOutFrames,
      fadeInFrames: defaults.fadeInFrames,
      mode: defaults.mode,
    },
  ]);
  const r = results[0];
  return r?.applied
    ? { ok: true, message: `${label} cut into track ${track.track} at ${where}. Undo reverses it.` }
    : { ok: false, message: r?.reason ?? 'The music edit made no change.' };
}
