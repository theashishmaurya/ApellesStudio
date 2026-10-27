/**
 * `@apelles/editor` — what a clip run is cut from, as the clipper commands
 * read it (D-411 §5.1, owner decision 4: media files AND long Edit timelines).
 *
 * **What it is.** Pure functions that turn a run's source into the input
 * `chroma_clipper_analyze` / `_check` take — each source file's transcript
 * once, and the clip windows onto them in play order — exactly the shape the
 * retake word view uses (D-380), so a word index means one word on every
 * surface:
 *
 * - a **media file**: one window, the whole file (or the run's `range`). While
 *   it is still being transcribed window by window, the landed windows are
 *   read as a PROVISIONAL view (candidates show early; proposals wait for the
 *   whole transcript, because sentence numbers would shift);
 * - a **long timeline**: every clip with a source on one track, in play
 *   order (`buildWordViewInput`, the retake view's own function), each clip a
 *   window — so the short plays what the long edit plays.
 *
 * Also the reviewed retakes ([`retakeCutsFor`]): the deleted takes of the
 * Recut panel's `verified` / `ai_confirmed` groups, as source-second spans.
 *
 * **What it does NOT do.** Fetch or transcribe (the op layer starts those),
 * analyse (Rust), or judge.
 */
import type { MediaItem } from '@apelles/bridge';

import { spliceTranscript, type RecoveredWindow } from '../darkRegions';
import type { PartialTranscript, Transcript, TranscriptSegment } from '../mediaUnderstandingStore';
import type { RetakeProposalSet } from '../retakeProposals';
import { buildWordViewInput } from '../retakeWordView';
import type { Clip, Timeline } from '../timeline';
import type { RunSettings, RunSource } from './clipperTypes';

/** One clip window onto one source, in play order. `clip` is set for a
 *  timeline source: the long-form clip the window is, which a build copies
 *  grade and audio settings from. */
export interface ClipperPiece {
  source: number;
  startSecs: number;
  endSecs: number;
  clip?: { track: number; index: number; clipId: string; c: Clip };
}

export interface ClipperViewInput {
  sources: Array<{ path: string; segments: TranscriptSegment[] }>;
  pieces: ClipperPiece[];
  /** Files with no transcript (and no landed window) yet. */
  pending: string[];
  failed: Array<{ path: string; error: string }>;
  /** Built from a partial, windowed transcript: readable, not proposable. */
  provisional: boolean;
}

/** What the input is read from: the media-understanding store's maps. */
export interface TranscriptSnapshot {
  transcripts: Readonly<Record<string, Transcript>>;
  partialTranscripts: Readonly<Record<string, PartialTranscript>>;
  transcriptErrors: Readonly<Record<string, string>>;
  recoveriesFor: (path: string) => readonly RecoveredWindow[];
}

/** A piece end for a media file whose duration is unknown: the midpoint rule
 *  only needs it to be past every word. */
const OPEN_END_SECS = 1e9;

/** A media file as one window (the run's `range`, or all of it). */
export function mediaViewInput(
  path: string,
  durationSecs: number | null,
  range: RunSettings['range'],
  snap: TranscriptSnapshot,
): ClipperViewInput {
  const start = range?.start_secs ?? 0;
  const end = range?.end_secs ?? (durationSecs && durationSecs > 0 ? durationSecs + 1 : OPEN_END_SECS);
  const transcript = snap.transcripts[path];
  if (transcript) {
    return {
      sources: [{ path, segments: spliceTranscript(transcript.segments ?? [], snap.recoveriesFor(path)) }],
      pieces: [{ source: 0, startSecs: start, endSecs: end }],
      pending: [],
      failed: [],
      provisional: false,
    };
  }
  const partial = snap.partialTranscripts[path];
  if (partial && partial.coveredSecs > start) {
    return {
      sources: [{ path, segments: partial.segments }],
      pieces: [{ source: 0, startSecs: start, endSecs: Math.min(end, partial.coveredSecs) }],
      pending: [],
      failed: [],
      provisional: true,
    };
  }
  const error = snap.transcriptErrors[path];
  return {
    sources: [],
    pieces: [],
    pending: error ? [] : [path],
    failed: error ? [{ path, error }] : [],
    provisional: false,
  };
}

/** The clips on one track of a timeline, as windows (the retake view's). */
export function timelineViewInput(tl: Timeline, track: number, snap: TranscriptSnapshot): ClipperViewInput | { error: string } {
  const input = buildWordViewInput(tl, track, snap.transcripts, snap.recoveriesFor, snap.transcriptErrors);
  if ('error' in input) return input;
  return {
    sources: input.sources.map((s) => ({ path: s.path, segments: s.segments })),
    pieces: input.pieces.map((p) => ({
      source: p.source,
      startSecs: p.startSecs,
      endSecs: p.endSecs,
      clip: { track, index: p.clip, clipId: p.clipId, c: p.c },
    })),
    pending: input.pending,
    failed: input.failed,
    provisional: false,
  };
}

/** The source of a run, resolved against the project as it is now. */
export function viewInputFor(
  source: RunSource,
  settings: RunSettings,
  ctx: { media: readonly MediaItem[]; timelineById: (id: string) => Timeline | null },
  snap: TranscriptSnapshot,
): ClipperViewInput | { error: string } {
  if (source.kind === 'media') {
    const item = ctx.media.find((m) => m.id === source.media_id) ?? null;
    if (!item) return { error: `media ${source.media_id} is no longer in the project's media pool` };
    return mediaViewInput(item.sourcePath, item.video?.durationSecs ?? null, settings.range, snap);
  }
  const tl = ctx.timelineById(source.timeline_id);
  if (!tl) return { error: `timeline ${source.timeline_id} is not in the project` };
  return timelineViewInput(tl, source.track, snap);
}

/** A reviewed retake's deleted take, as `chroma_clipper_*` take it. */
export interface RetakeCutWire {
  source: number;
  startSecs: number;
  endSecs: number;
}

/**
 * The deleted takes of the reviewed retake groups (`verified` or
 * `ai_confirmed` — never `refused`) on the open timeline, mapped onto this
 * input's sources by file path. A retake set is keyed by track of the OPEN
 * timeline, so each take's clip is looked up there by id; a take whose clip
 * is gone is skipped rather than guessed at.
 */
export function retakeCutsFor(
  input: Pick<ClipperViewInput, 'sources'>,
  openTimeline: Timeline | null,
  sets: Readonly<Record<number, RetakeProposalSet>>,
): RetakeCutWire[] {
  if (!openTimeline) return [];
  const sourceOf = new Map(input.sources.map((s, i) => [s.path, i]));
  const out: RetakeCutWire[] = [];
  for (const set of Object.values(sets)) {
    const clips = openTimeline.tracks[set.track]?.clips ?? [];
    for (const g of set.groups) {
      if (g.status !== 'verified' && g.status !== 'ai_confirmed') continue;
      for (const take of g.takes) {
        if (take.keep) continue;
        for (const seg of take.segments) {
          const clip = clips.find((c) => c.id === seg.clipId);
          const source = clip ? sourceOf.get(clip.source_path) : undefined;
          if (source === undefined) continue;
          out.push({ source, startSecs: seg.span.startSecs, endSecs: seg.span.endSecs });
        }
      }
    }
  }
  return out;
}

/** The request body every clipper command shares. */
export function viewRequest(input: ClipperViewInput, settings: RunSettings, retakeCuts: readonly RetakeCutWire[]) {
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
    retakeCuts: [...retakeCuts],
    durations: [...settings.durations],
    focus: settings.focus ?? null,
    tighten: { deadAir: settings.tighten.dead_air, retakes: settings.tighten.retakes },
  };
}
