/**
 * `@apelles/editor` — music edits by story beat: the pure half (D-408).
 *
 * **What it is.** Everything about a music dropout that is not the document
 * op itself: the beat KINDS (dropout, stop-time breath, dry cold open, dry
 * call to action, section closer), the three ways to anchor one (explicit
 * timeline frames, a word range of a track's word-indexed view, or "the
 * second before this word"), the parsing of a client's edits off the wire,
 * the resolution of an anchor to a `[start, end)` timeline-frame range, and
 * the proposal rows the Music edits panel reviews — their statuses, the DTO
 * the MCP tools answer with, and which rows an Apply takes.
 *
 * The cutting itself is `applyMusicEdits` in `timeline.ts` (the `music_edits`
 * op): split, lift, slip, fade, never ripple. This module only ever produces
 * the `MusicEditRange`s it consumes, so the GUI and the agent land the same
 * frames through the same op.
 *
 * **Word anchors read the retake flow's view, not a second one.** A word
 * index means a word of `editor_get_word_transcript`'s view of the VOICE track
 * (D-380), under that view's `viewId`; it maps to timeline frames through
 * `wordSpanSegments`, the one seconds→frames rule the Recut panel cuts with.
 *
 * **What it does NOT do.** No store, no I/O, no React, no judgement (which
 * beats deserve a dropout is the agent's or the person's call), and nothing
 * destructive.
 */

import type { MusicEditMode, MusicEditRange, Timeline } from './timeline';
import {
  checkMusicEdit,
  DEFAULT_MUSIC_FADE_IN_FRAMES,
  DEFAULT_MUSIC_FADE_OUT_FRAMES,
  endFrame,
  timelineFps,
} from './timeline';
import { wordSpanSegments, wordsText, type ViewWord, type WordViewInput } from './retakeWordView';

/** The story beats a music edit is made for, from the reference teardown's
 *  rules (`docs/notes/reference-teardown-lewis-jackson-polymarket.md` §1).
 *  Every kind is the same cut — the bed out over a range, faded either side —
 *  so the kind is a label for the reviewer and a default length for a
 *  `before_word` anchor, never a different operation. */
export const MUSIC_EDIT_KINDS = ['dropout', 'breath', 'dry_open', 'dry_cta', 'section_out'] as const;

export type MusicEditKind = (typeof MUSIC_EDIT_KINDS)[number];

/** The panel's and the answers' names for each kind. */
export const MUSIC_EDIT_KIND_LABELS: Record<MusicEditKind, string> = {
  dropout: 'Dropout',
  breath: 'Stop-time breath',
  dry_open: 'Dry cold open',
  dry_cta: 'Dry call to action',
  section_out: 'Section closer',
};

/** How long a stop-time breath is when only its re-entry word is given: the
 *  reference's breaths measured ~1 s (1:27.4, 2:43.3, 5:38.1, 8:42.7). */
export const BREATH_SECONDS = 1;

export const MUSIC_EDIT_MODES: readonly MusicEditMode[] = ['continuous', 'pause'];

/** Where a music edit sits, before it is resolved to frames. */
export type MusicEditAnchor =
  /** Half-open `[startFrame, endFrame)` timeline frames. */
  | { by: 'frames'; startFrame: number; endFrame: number }
  /** Inclusive word indices of the voice track's view: the bed is out from
   *  the first word's start to the last word's end — the punchline, the big
   *  number, the call to action plays dry. */
  | { by: 'words'; firstWord: number; lastWord: number }
  /** The `lengthFrames` immediately before a word, re-entering ON it — a
   *  stop-time breath before the product's name. Defaults to
   *  [`BREATH_SECONDS`]. */
  | { by: 'before_word'; word: number; lengthFrames?: number };

/** One music edit as asked for (by the agent, or by the panel's form). */
export interface MusicEditRequest {
  kind: MusicEditKind;
  anchor: MusicEditAnchor;
  reason?: string;
  fadeOutFrames?: number;
  fadeInFrames?: number;
  mode?: MusicEditMode;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const present = (v: unknown) => v !== undefined && v !== null;

/** Parse one edit off the wire (snake_case keys, the way an MCP client writes
 *  them). Strict: exactly one anchor shape, whole non-negative numbers, a
 *  known kind and mode — a typo is refused by name, never coerced (D-216). */
export function parseMusicEditRequest(raw: unknown, label = 'edit'): MusicEditRequest | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} is not an object` };
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === 'string' ? r.kind.trim().toLowerCase() : 'dropout';
  if (!(MUSIC_EDIT_KINDS as readonly string[]).includes(kind)) {
    return { error: `${label}: kind "${String(r.kind)}" is not one of ${MUSIC_EDIT_KINDS.join(', ')}` };
  }
  const shapes = [
    present(r.start_frame) || present(r.end_frame),
    present(r.first_word) || present(r.last_word),
    present(r.before_word),
  ].filter(Boolean).length;
  if (shapes !== 1) {
    return {
      error:
        `${label}: give exactly ONE anchor — start_frame + end_frame (timeline frames), first_word + last_word ` +
        '(word indices from editor_get_word_transcript), or before_word (+ optional length_frames)',
    };
  }
  let anchor: MusicEditAnchor;
  if (present(r.start_frame) || present(r.end_frame)) {
    if (!isInt(r.start_frame) || !isInt(r.end_frame)) {
      return { error: `${label}: start_frame and end_frame must both be whole, non-negative timeline frames` };
    }
    anchor = { by: 'frames', startFrame: r.start_frame, endFrame: r.end_frame };
  } else if (present(r.first_word) || present(r.last_word)) {
    if (!isInt(r.first_word) || !isInt(r.last_word)) {
      return { error: `${label}: first_word and last_word must both be word indices` };
    }
    anchor = { by: 'words', firstWord: r.first_word, lastWord: r.last_word };
  } else {
    if (!isInt(r.before_word)) return { error: `${label}: before_word must be a word index` };
    if (present(r.length_frames) && (!isInt(r.length_frames) || r.length_frames < 1)) {
      return { error: `${label}: length_frames must be a positive whole number of frames` };
    }
    anchor = {
      by: 'before_word',
      word: r.before_word,
      ...(present(r.length_frames) ? { lengthFrames: r.length_frames as number } : {}),
    };
  }
  for (const key of ['fade_out_frames', 'fade_in_frames'] as const) {
    if (present(r[key]) && !isInt(r[key])) return { error: `${label}: ${key} must be a whole number of frames >= 0` };
  }
  let mode: MusicEditMode | undefined;
  if (present(r.mode)) {
    const m = typeof r.mode === 'string' ? r.mode.trim().toLowerCase() : '';
    if (!(MUSIC_EDIT_MODES as readonly string[]).includes(m)) {
      return { error: `${label}: mode "${String(r.mode)}" is not one of ${MUSIC_EDIT_MODES.join(', ')}` };
    }
    mode = m as MusicEditMode;
  }
  return {
    kind: kind as MusicEditKind,
    anchor,
    ...(typeof r.reason === 'string' && r.reason.trim() ? { reason: r.reason.trim() } : {}),
    ...(present(r.fade_out_frames) ? { fadeOutFrames: r.fade_out_frames as number } : {}),
    ...(present(r.fade_in_frames) ? { fadeInFrames: r.fade_in_frames as number } : {}),
    ...(mode ? { mode } : {}),
  };
}

/** Whether a request needs the voice track's word view to resolve. */
export const usesWords = (r: MusicEditRequest): boolean => r.anchor.by !== 'frames';

/** The voice track's view, as a word anchor resolves against it. */
export interface WordContext {
  input: WordViewInput;
  words: readonly ViewWord[];
}

/** Timeline frames of view words `first..=last`: from the first word's start
 *  to the last word's end, through `wordSpanSegments` (so a range that spans
 *  two voice clips still starts and ends on the right frames). */
export function wordRangeFrames(
  ctx: WordContext,
  first: number,
  last: number,
): { start: number; end: number; text: string } | { error: string } {
  if (first > last) return { error: `first_word ${first} is after last_word ${last}` };
  if (last >= ctx.words.length) {
    return { error: `word ${last} is past the end of the view (${ctx.words.length} words)` };
  }
  const segs = wordSpanSegments(ctx.input, ctx.words, first, last);
  if (segs.length === 0) return { error: `words ${first}-${last} land on no timeline frame` };
  return {
    start: segs[0].span.startFrame,
    end: segs[segs.length - 1].span.endFrame,
    text: wordsText(ctx.words, first, last),
  };
}

/** One request resolved to frames, before it is put on a track. */
export interface ResolvedAnchor {
  start: number;
  end: number;
  /** The words the anchor names, for the reviewer (word anchors only). */
  text?: string;
  words?: { first: number; last: number };
}

/** Resolve an anchor to a `[start, end)` timeline-frame range. `ctx` is
 *  required for the two word shapes. */
export function resolveAnchor(
  r: MusicEditRequest,
  fps: number,
  ctx: WordContext | null,
): ResolvedAnchor | { error: string } {
  const a = r.anchor;
  if (a.by === 'frames') {
    if (a.endFrame <= a.startFrame) {
      return { error: `end_frame ${a.endFrame} must be after start_frame ${a.startFrame}` };
    }
    return { start: a.startFrame, end: a.endFrame };
  }
  if (!ctx) return { error: 'a word anchor needs word_track and view_id (from editor_get_word_transcript)' };
  if (a.by === 'words') {
    const w = wordRangeFrames(ctx, a.firstWord, a.lastWord);
    if ('error' in w) return w;
    return { start: w.start, end: w.end, text: w.text, words: { first: a.firstWord, last: a.lastWord } };
  }
  const w = wordRangeFrames(ctx, a.word, a.word);
  if ('error' in w) return w;
  const length = a.lengthFrames ?? Math.max(1, Math.round(fps * BREATH_SECONDS));
  const start = Math.max(0, w.start - length);
  if (start >= w.start) return { error: `word ${a.word} starts at frame ${w.start}; there is no room before it` };
  return { start, end: w.start, text: w.text, words: { first: a.word, last: a.word } };
}

/** The document op's range for a resolved request on `track`, with the
 *  defaults filled in. */
export function toMusicEditRange(r: MusicEditRequest, at: ResolvedAnchor, track: number): MusicEditRange {
  return {
    track,
    start: at.start,
    end: at.end,
    fadeOutFrames: r.fadeOutFrames ?? DEFAULT_MUSIC_FADE_OUT_FRAMES,
    fadeInFrames: r.fadeInFrames ?? DEFAULT_MUSIC_FADE_IN_FRAMES,
    mode: r.mode ?? 'continuous',
  };
}

// --------------------------------------------------------------------------
// Proposals — the review list (mirrors `retakeProposals.ts`, D-380 step 2)
// --------------------------------------------------------------------------

/** A row's review state. `pending` is how an agent's proposal arrives; only
 *  `accepted` rows are applied by the panel's Apply (an agent applying on the
 *  person's say-so may include `pending` too); `rejected` is never applied. */
export type MusicEditRowStatus = 'pending' | 'accepted' | 'rejected';

/** One reviewable music edit. Frames are the resolved range, adjustable by
 *  the reviewer; `words`/`text` say what it was anchored to. */
export interface MusicEditRow {
  /** Stable within its set. */
  id: string;
  kind: MusicEditKind;
  origin: 'ai' | 'person';
  status: MusicEditRowStatus;
  reason?: string;
  text?: string;
  words?: { first: number; last: number };
  start: number;
  end: number;
  fadeOutFrames: number;
  fadeInFrames: number;
  mode: MusicEditMode;
}

/** One music track's proposals, as the store holds them. */
export interface MusicEditProposalSet {
  /** The timeline they were made on — a set for another timeline is never
   *  shown or applied. */
  timelineId: string;
  /** The audio track holding the bed. */
  track: number;
  /** The voice track the word anchors were read on, and that view's id and
   *  basis key (`viewBasisKey`) — the panel compares the key to say "the voice
   *  track changed since these were proposed" before anyone applies rows whose
   *  frames now point at other words. Absent when every row was frames. */
  wordTrack?: number;
  viewId?: string;
  basisKey?: string;
  /** `Date.now()` on arrival — display only. */
  receivedAt: number;
  rows: MusicEditRow[];
  /** Next id for a row the person adds. */
  nextId: number;
}

/** A row from a resolved request. */
export function rowFrom(
  id: string,
  r: MusicEditRequest,
  at: ResolvedAnchor,
  origin: MusicEditRow['origin'],
  status: MusicEditRowStatus = 'pending',
): MusicEditRow {
  return {
    id,
    kind: r.kind,
    origin,
    status,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(at.text ? { text: at.text } : {}),
    ...(at.words ? { words: at.words } : {}),
    start: at.start,
    end: at.end,
    fadeOutFrames: r.fadeOutFrames ?? DEFAULT_MUSIC_FADE_OUT_FRAMES,
    fadeInFrames: r.fadeInFrames ?? DEFAULT_MUSIC_FADE_IN_FRAMES,
    mode: r.mode ?? 'continuous',
  };
}

/** A row as the document op takes it. */
export const rowRange = (row: MusicEditRow, track: number): MusicEditRange => ({
  track,
  start: row.start,
  end: row.end,
  fadeOutFrames: row.fadeOutFrames,
  fadeInFrames: row.fadeInFrames,
  mode: row.mode,
});

/** Why this row cannot be applied to `tl` as it is NOW, or null. Recomputed
 *  live by the panel and per answer by the tools — never stored, since any
 *  edit can change it. */
export function rowProblem(tl: Timeline, row: MusicEditRow, track: number): string | null {
  const check = checkMusicEdit(tl, rowRange(row, track), timelineFps(tl));
  return check.ok ? null : check.reason;
}

/** The rows an Apply takes, in timeline order: the accepted ones, plus the
 *  pending ones when `includePending` (an agent the person asked to apply). */
export function rowsToApply(set: MusicEditProposalSet, includePending: boolean): MusicEditRow[] {
  return set.rows
    .filter((r) => r.status === 'accepted' || (includePending && r.status === 'pending'))
    .slice()
    .sort((a, b) => a.start - b.start);
}

/** One row as the MCP tools answer it. */
export function rowDto(row: MusicEditRow, fps: number, problem: string | null) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    origin: row.origin,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.words ? { firstWord: row.words.first, lastWord: row.words.last } : {}),
    ...(row.text ? { text: row.text } : {}),
    startFrame: row.start,
    endFrame: row.end,
    startSecs: Number((row.start / fps).toFixed(3)),
    endSecs: Number((row.end / fps).toFixed(3)),
    fadeOutFrames: row.fadeOutFrames,
    fadeInFrames: row.fadeInFrames,
    mode: row.mode,
    ...(problem ? { problem } : {}),
  };
}

/** The `[start, end)` range a "breath" lands on when a person asks for one AT
 *  a frame (the playhead, a transcript line's start): the second before it. */
export function breathBefore(frame: number, fps: number): { start: number; end: number } | null {
  const end = Math.max(0, Math.round(frame));
  const start = Math.max(0, end - Math.max(1, Math.round(fps * BREATH_SECONDS)));
  return start < end ? { start, end } : null;
}

/** The audio track a person's "music dropout here" should act on, when they
 *  did not say: the one audio track with UNLINKED material under the range
 *  (a linked audio clip is a picture's own sound — D-129 — never the bed),
 *  else `preferred` if it is an audio track, else none with the reason. */
export function musicTrackFor(
  tl: Timeline,
  start: number,
  end: number,
  preferred: number | null,
): { track: number } | { error: string } {
  const fps = timelineFps(tl);
  const candidates = tl.tracks
    .map((t, i) => ({ t, i }))
    .filter(
      ({ t }) =>
        t.kind === 'audio' &&
        t.clips.some((c) => !c.link_group && c.start_frame < end && endFrame(c, fps) > start),
    )
    .map(({ i }) => i);
  if (preferred !== null && candidates.includes(preferred)) return { track: preferred };
  if (candidates.length === 1) return { track: candidates[0] };
  if (candidates.length === 0) {
    return { error: 'no music bed under that range — no audio track has an unlinked clip there' };
  }
  return {
    error: `more than one audio track has music under that range (tracks ${candidates.join(', ')}) — pick the bed in the Music edits panel first`,
  };
}
