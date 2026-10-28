/**
 * `@apelles/editor` — the word-indexed view of one timeline track, as an MCP
 * client reads it to propose retakes (D-380 step 2).
 *
 * **What it is.** The pure, timeline-side half of the view. A track is a list
 * of clip windows onto source transcripts; this module turns it into the input
 * `chroma_retake_word_view` / `chroma_check_retake_proposals` index — each
 * source's spliced transcript ONCE, plus one window per visible clip in play
 * order — and maps the answer back: word indices to clips and timeline frames,
 * a word range to the window a re-read should cover, a view to the fingerprint
 * the Recut panel uses to say "the timeline changed since the AI read it".
 *
 * **Where the word rules live, and why not here.** Which words a clip shows
 * (midpoint inside its trimmed range), which segment a word is in (start
 * time), how runs are numbered and what the view text looks like are all
 * `apelles_speech::proposal` (`index_pieces`, `render_indexed_page`) — one
 * implementation, the one the eval measures. A TypeScript copy would be the
 * drift CLAUDE.md forbids: the client would read one view and the gate judge
 * another. So this module decides only what is a fact about the TIMELINE:
 * which clips, in which order, onto which windows of which file.
 *
 * **What it does NOT do.** No store access, no I/O, no React, no judgement,
 * and nothing destructive. Times are SOURCE seconds throughout, so a single
 * untrimmed clip yields exactly the eval's view of that file.
 */

import { spanToFrames, clipSourceRangeSecs } from './recut';
import { sweepTargets } from './recutSweep';
import type { TakeSegment } from './recutRuns';
import { spliceTranscript, type RecoveredWindow, type SplicedSegment } from './darkRegions';
import type { Transcript } from './mediaUnderstandingStore';
import { timelineFps, type Clip, type Timeline } from './timeline';

/** One source file in the view, with the transcript every consumer reads —
 *  the whole-file pass with every recovery and applied re-read spliced in. */
export interface WordViewSource {
  path: string;
  segments: SplicedSegment[];
  /** The whole-file pass's own language, to pin a re-read to. */
  language?: string;
}

/** One visible clip's window onto its source, in play order. */
export interface WordViewPiece {
  /** Index into [`WordViewInput.sources`]. */
  source: number;
  startSecs: number;
  endSecs: number;
  /** The clip on the track — index, id and a snapshot, so a late answer is
   *  still mapped against the clip it was measured on. */
  clip: number;
  clipId: string;
  c: Clip;
}

/** Everything the view commands need for one track, plus what is missing. */
export interface WordViewInput {
  track: number;
  fps: number;
  sources: WordViewSource[];
  pieces: WordViewPiece[];
  /** Source paths on this track with no transcript yet. A view built while
   *  any is missing would renumber the moment it lands, so callers wait. */
  pending: string[];
  /** Source paths whose transcription failed, with the reason. */
  failed: Array<{ path: string; error: string }>;
}

/** One word of the view as the commands return it (`include_words`). */
export interface ViewWord {
  text: string;
  start: number;
  end: number;
  /** Index into [`WordViewInput.pieces`]. */
  piece: number;
}

/** A cut range as the gate returns it: one run of one take, padded, in
 *  source seconds, inside one piece. */
export interface CutRangeWire {
  first: number;
  last: number;
  startSecs: number;
  endSecs: number;
  piece: number;
}

/**
 * The view's input for one track.
 *
 * **Clips:** `sweepTargets`' — every clip with a source that is not a still,
 * in the track's own order — so the view covers exactly what the Recut sweep
 * and `editor_detect_retakes` cover. **Transcripts:** each source once,
 * spliced with `recoveriesFor(path)` exactly as `editor_get_timeline_transcript`
 * does, so the client reads the words the Transcript panel shows; this never
 * starts a scan or a recovery.
 */
export function buildWordViewInput(
  tl: Timeline,
  track: number,
  transcripts: Readonly<Record<string, Transcript>>,
  recoveriesFor: (path: string) => readonly RecoveredWindow[],
  transcriptErrors: Readonly<Record<string, string>> = {},
): WordViewInput | { error: string } {
  const tr = tl.tracks[track];
  if (!tr) return { error: `no track ${track} (0..${tl.tracks.length - 1})` };
  const fps = timelineFps(tl);
  const { targets } = sweepTargets(tr);

  const sources: WordViewSource[] = [];
  const sourceIndex = new Map<string, number>();
  const pending: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  const pieces: WordViewPiece[] = [];

  for (const t of targets) {
    const path = t.source;
    const transcript = transcripts[path];
    if (!transcript) {
      const error = transcriptErrors[path];
      if (error) {
        if (!failed.some((f) => f.path === path)) failed.push({ path, error });
      } else if (!pending.includes(path)) {
        pending.push(path);
      }
      continue;
    }
    let source = sourceIndex.get(path);
    if (source === undefined) {
      source = sources.length;
      sourceIndex.set(path, source);
      sources.push({
        path,
        segments: spliceTranscript(transcript.segments ?? [], recoveriesFor(path)),
        language: transcript.language,
      });
    }
    const range = clipSourceRangeSecs(t.c, fps);
    pieces.push({
      source,
      startSecs: range.startSecs,
      endSecs: range.startSecs + range.durationSecs,
      clip: t.clip,
      clipId: t.c.id,
      c: t.c,
    });
  }
  return { track, fps, sources, pieces, pending, failed };
}

/** The view input as the Rust commands take it — no clip snapshots, only the
 *  fields a segment needs (`index_transcript`'s contract). */
export function wireViewArgs(input: WordViewInput): {
  sources: Array<{
    path: string;
    segments: Array<{ start: number; end: number; words: Array<{ word: string; start: number; end: number }> }>;
  }>;
  pieces: Array<{ source: number; startSecs: number; endSecs: number }>;
} {
  return {
    sources: input.sources.map((s) => ({
      path: s.path,
      segments: s.segments.map((seg) => ({
        start: seg.start,
        end: seg.end,
        words: (seg.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end })),
      })),
    })),
    pieces: input.pieces.map((p) => ({ source: p.source, startSecs: p.startSecs, endSecs: p.endSecs })),
  };
}

/**
 * A fingerprint of everything the view is built from — each clip window, each
 * source's word count and splice — WITHOUT asking Rust to render it.
 *
 * The authoritative staleness check is the view id, compared by
 * `editor_propose_retakes` against a freshly built view. This is the cheap
 * twin the Recut panel recomputes on every timeline or transcript change, to
 * say "the timeline changed since the AI read it" before the human ticks rows
 * whose frames now point at other material. Same inputs, same key; any input
 * the view depends on changes it.
 */
export function viewBasisKey(input: WordViewInput): string {
  const sources = input.sources.map((s) => {
    const words = s.segments.reduce((n, seg) => n + (seg.words?.length ?? 0), 0);
    const first = s.segments[0];
    const last = s.segments[s.segments.length - 1];
    const recovered = s.segments.filter((seg) => seg.recovered).length;
    return [s.path, s.segments.length, words, recovered, first?.start ?? '', last?.end ?? ''].join('~');
  });
  const pieces = input.pieces.map((p) => [p.source, p.startSecs, p.endSecs, p.clipId].join('~'));
  return JSON.stringify([input.track, sources, pieces, input.pending]);
}

/** The text of words `first..=last`, joined the way a transcript reads. */
export function wordsText(words: readonly ViewWord[], first: number, last: number): string {
  return words
    .slice(first, last + 1)
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ');
}

/** Where the words `first..=last` sit on the timeline: one segment per clip
 *  they fall in, each through `spanToFrames` (the one seconds→frames rule).
 *  Unpadded — the extent of the words themselves, which is what a kept take
 *  shows. */
export function wordSpanSegments(
  input: WordViewInput,
  words: readonly ViewWord[],
  first: number,
  last: number,
): TakeSegment[] {
  const out: TakeSegment[] = [];
  let i = first;
  while (i <= last && i < words.length) {
    const piece = words[i].piece;
    let j = i;
    let start = words[i].start;
    let end = words[i].end;
    while (j + 1 <= last && j + 1 < words.length && words[j + 1].piece === piece) {
      j += 1;
      start = Math.min(start, words[j].start);
      end = Math.max(end, words[j].end);
    }
    const seg = segmentIn(input, piece, start, end);
    if (seg) out.push(seg);
    i = j + 1;
  }
  return out;
}

/** The gate's padded cut ranges, on the timeline. A range never crosses a
 *  piece, so each is one segment; one that lands on no whole frame is dropped
 *  — the same rule `takeSegments` keeps for the detector's takes. */
export function cutSegments(input: WordViewInput, cuts: readonly CutRangeWire[]): TakeSegment[] {
  return cuts.flatMap((c) => {
    const seg = segmentIn(input, c.piece, c.startSecs, c.endSecs);
    return seg ? [seg] : [];
  });
}

/** D-420 — where one view word plays on the TIMELINE, in the clip it belongs
 *  to: its source span clamped into that clip, through `spanToFrames` (a word
 *  stamped at zero length comes back with `startFrame === endFrame`). `null`
 *  only for a word whose piece is unknown. What `editor_get_word_transcript`'s
 *  `include_timeline` rows carry. */
export function viewWordFrames(
  input: WordViewInput,
  w: ViewWord,
): { clip: number; clipId: string; startFrame: number; endFrame: number } | null {
  const p = input.pieces[w.piece];
  if (!p) return null;
  const span = spanToFrames(p.c, Math.max(w.start, p.startSecs), Math.min(w.end, p.endSecs), input.fps);
  return { clip: p.clip, clipId: p.clipId, startFrame: span.startFrame, endFrame: span.endFrame };
}

function segmentIn(
  input: WordViewInput,
  piece: number,
  startSecs: number,
  endSecs: number,
): TakeSegment | null {
  const p = input.pieces[piece];
  if (!p) return null;
  const span = spanToFrames(p.c, Math.max(startSecs, p.startSecs), Math.min(endSecs, p.endSecs), input.fps);
  if (span.endFrame <= span.startFrame) return null;
  return { clip: p.clip, clipId: p.clipId, span };
}

/**
 * Context either side of a re-read, in seconds. A recogniser reading a clipped
 * fragment with no lead-in invents and drops words — D-349 measured that for
 * Whisper and set a 4 s minimum window; Parakeet is a better reader of short
 * windows but not of a word whose onset is cut off. Two seconds a side gives
 * every re-read at least that 4 s and a sentence of context.
 */
export const REREAD_CONTEXT_SECS = 2;

/** The longest stretch one re-read may cover. A re-read is for checking a few
 *  words the gate could not hear right, not for re-transcribing a scene; a
 *  wider ask is almost always a wrong range, and the answer must stay small
 *  enough to read in one tool response. */
export const MAX_REREAD_SECS = 60;

/**
 * The window to re-read for view words `first..=last`.
 *
 * All of them must come from one source file (a window is a range of ONE
 * file's audio). The window grows by [`REREAD_CONTEXT_SECS`] each side, and
 * each edge is then moved off any word it would cut in half — to the middle of
 * the gap before (or after) that word — because the splice replaces words by
 * midpoint, and an edge through a word would hand the recogniser half of it.
 * The source's whole spliced word list is used for that, not only the words
 * the timeline shows, since the audio either side of a clip is still audio.
 */
export function rereadWindow(
  input: WordViewInput,
  words: readonly ViewWord[],
  first: number,
  last: number,
): { path: string; language?: string; startSecs: number; durationSecs: number } | { error: string } {
  if (!(Number.isInteger(first) && Number.isInteger(last)) || first < 0 || last < first) {
    return { error: 'first and last must be word indices with first <= last' };
  }
  if (last >= words.length) {
    return { error: `word ${last} is past the end of the view (${words.length} words)` };
  }
  const sourceOf = (i: number) => input.pieces[words[i].piece]?.source;
  const source = sourceOf(first);
  for (let i = first; i <= last; i += 1) {
    if (sourceOf(i) !== source) {
      return {
        error:
          `words ${first}-${last} come from more than one source file — re-read each file's ` +
          'stretch separately',
      };
    }
  }
  const src = source === undefined ? undefined : input.sources[source];
  if (!src) return { error: 'that word range has no source transcript' };

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = first; i <= last; i += 1) {
    lo = Math.min(lo, words[i].start);
    hi = Math.max(hi, words[i].end);
  }
  const all = src.segments
    .flatMap((s) => s.words ?? [])
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let start = Math.max(0, lo - REREAD_CONTEXT_SECS);
  let end = hi + REREAD_CONTEXT_SECS;
  for (let i = 0; i < all.length; i += 1) {
    const w = all[i];
    if (w.start < start && start < w.end) {
      const prevEnd = i > 0 ? all[i - 1].end : 0;
      start = Math.max(0, Math.min(w.start, (prevEnd + w.start) / 2));
    }
    if (w.start < end && end < w.end) {
      const next = all[i + 1];
      end = next ? Math.max(w.end, (w.end + next.start) / 2) : w.end;
    }
  }
  if (end - start > MAX_REREAD_SECS) {
    return {
      error:
        `words ${first}-${last} span ${(hi - lo).toFixed(1)}s of audio — a re-read is for checking ` +
        `a few words, at most ${MAX_REREAD_SECS}s with its context; narrow the range`,
    };
  }
  return { path: src.path, language: src.language, startSecs: start, durationSecs: end - start };
}

/** The view words whose midpoint lies inside a window of one source — what a
 *  re-read of that window would replace, as the client knows them. */
export function viewWordsInWindow(
  input: WordViewInput,
  words: readonly ViewWord[],
  path: string,
  startSecs: number,
  endSecs: number,
): Array<{ index: number; word: string; start: number; end: number }> {
  const out: Array<{ index: number; word: string; start: number; end: number }> = [];
  words.forEach((w, index) => {
    const p = input.pieces[w.piece];
    if (!p || input.sources[p.source]?.path !== path) return;
    const mid = (w.start + w.end) / 2;
    if (mid >= startSecs && mid < endSecs) out.push({ index, word: w.text, start: w.start, end: w.end });
  });
  return out;
}
