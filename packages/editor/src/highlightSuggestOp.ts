/**
 * @apelles/editor — gather the inputs for a highlight suggestion (D-396/D-397).
 *
 * What it is: `suggestClipHighlights`, the one async function behind BOTH the
 * `editor_suggest_clip_highlights` MCP op and the Inspector's "Suggest from
 * transcript" button (CLAUDE.md: one op underneath a human and an AI). It reads
 * the clip's picture with OCR, reads what is being spoken while the clip is on
 * screen, and hands both to the pure matcher in `highlightSuggest.ts`.
 *
 * What it does NOT do: write anything. The answer is a suggestion; applying it
 * is `set_clip_highlights`. It also never starts a transcription: that is a
 * long, user-visible job, so a missing transcript is reported by name instead.
 *
 * **What counts as "spoken over this clip".** Every non-hidden clip on ANY
 * track (a narration usually sits on an audio track, which the dialogue list
 * behind the Edit index deliberately skips) whose source has a finished
 * transcript, restricted to the words that overlap the target clip's span on the
 * timeline. A still source has no audio and contributes nothing.
 *
 * Dependencies are injected so the orchestration is testable without Tauri.
 */

import { spanToFrames } from './recut';
import {
  clipSourceFrameAt,
  endFrame,
  isGeneratedClip,
  isStillSource,
  timelineFps,
  type Clip,
  type Timeline,
} from './timeline';
import type { AnalysisStatus, Transcript } from './mediaUnderstandingStore';
import {
  suggestHighlights,
  type HighlightSuggestion,
  type OcrLine,
  type SpokenWord,
} from './highlightSuggest';

/** What `suggestClipHighlights` needs from the outside world. */
export interface SuggestDeps {
  timeline: Timeline | null;
  transcriptStatus: (sourcePath: string) => AnalysisStatus<Transcript>;
  /** `chroma_ocr_media` — the text in a file's picture at a source frame. */
  ocr: (sourcePath: string, sourceFrame: number) => Promise<OcrLine[]>;
}

export type SuggestOutcome =
  | ({ status: 'ready'; notes: string[] } & HighlightSuggestion)
  | { status: 'transcribing'; sources: string[] }
  | { status: 'needs_transcript'; sources: string[] }
  | { error: string };

/** The timeline-located words of every transcribed source that overlaps `target`
 *  while it is on screen, plus the sources that could not contribute yet. */
export function spokenWordsOver(
  tl: Timeline,
  target: Clip,
  trackIndex: number,
  statusOf: SuggestDeps['transcriptStatus'],
): { words: SpokenWord[]; transcribed: number; running: string[]; missing: string[]; failed: string[] } {
  const fps = timelineFps(tl);
  const spanStart = target.start_frame;
  const spanEnd = endFrame(target, fps);
  const words: SpokenWord[] = [];
  const seen = new Set<string>();
  const running = new Set<string>();
  const missing = new Set<string>();
  const failed = new Set<string>();
  const transcribed = new Set<string>();

  tl.tracks.forEach((tr, ti) => {
    if (tr.hidden || tr.kind === 'subtitle') return;
    for (const clip of tr.clips) {
      if (ti === trackIndex && clip.id === target.id) continue;
      if (!clip.source_path || isGeneratedClip(clip) || isStillSource(clip.source_path)) continue;
      if (clip.start_frame >= spanEnd || endFrame(clip, fps) <= spanStart) continue;
      const status = statusOf(clip.source_path);
      if (status.phase === 'running') running.add(clip.source_path);
      else if (status.phase === 'idle') missing.add(clip.source_path);
      else if (status.phase === 'error' || !status.result) failed.add(clip.source_path);
      if (status.phase !== 'done' || !status.result) continue;
      transcribed.add(clip.source_path);

      const rate = clip.source_fps && clip.source_fps > 0 ? clip.source_fps : fps;
      const winStart = clip.source_start / rate;
      const winEnd = winStart + clip.duration / rate;
      for (const segment of status.result.segments ?? []) {
        for (const w of segment.words ?? []) {
          if (w.end <= winStart || w.start >= winEnd) continue;
          const span = spanToFrames(clip, w.start, w.end, fps);
          if (span.endFrame <= spanStart || span.startFrame >= spanEnd) continue;
          // An A/V-linked pair would otherwise report one utterance twice.
          const key = `${span.startFrame}:${w.word.trim().toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          words.push({ text: w.word.trim(), startFrame: span.startFrame, endFrame: span.endFrame });
        }
      }
    }
  });
  words.sort((a, b) => a.startFrame - b.startFrame);
  return {
    words,
    transcribed: transcribed.size,
    running: [...running],
    missing: [...missing],
    failed: [...failed],
  };
}

/** Suggest highlights for the clip at (`track`, `clipIndex`). */
export async function suggestClipHighlights(
  deps: SuggestDeps,
  track: number,
  clipIndex: number,
): Promise<SuggestOutcome> {
  const tl = deps.timeline;
  if (!tl) return { error: 'no timeline loaded' };
  const tr = tl.tracks[track];
  const clip = tr?.clips[clipIndex];
  if (!tr || !clip) return { error: `no clip ${clipIndex} on track ${track}` };
  if (tr.kind !== 'video' || isGeneratedClip(clip) || !clip.source_path) {
    return { error: 'only a video or still clip has a picture to read text from' };
  }
  const fps = timelineFps(tl);

  const spoken = spokenWordsOver(tl, clip, track, deps.transcriptStatus);
  if (spoken.running.length > 0) return { status: 'transcribing', sources: spoken.running };
  // Sources with no transcript only block when NOTHING overlapping has one: a
  // music bed under the narration is never going to be transcribed, and must
  // not stop the narration's words from being used.
  if (spoken.transcribed === 0 && spoken.missing.length > 0) {
    return { status: 'needs_transcript', sources: spoken.missing };
  }

  let lines: OcrLine[];
  try {
    lines = await deps.ocr(clip.source_path, clip.source_start);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const rate = clip.source_fps && clip.source_fps > 0 ? clip.source_fps : fps;
  const suggestion = suggestHighlights({
    lines,
    spoken: spoken.words,
    sourceFrameAt: (timelineFrame) => clipSourceFrameAt(clip, timelineFrame, fps),
    clipSourceStart: clip.source_start,
    clipSourceFps: rate,
    clipSourceFrames: clip.duration,
  });

  const notes: string[] = [];
  if (suggestion.ocrWords === 0) notes.push('no text was found in the clip’s picture');
  if (spoken.words.length === 0) notes.push('nothing is spoken over this clip, so the largest line is swept at its start');
  else if (suggestion.basis === 'headline') notes.push('no spoken phrase matched the picture’s text, so the largest line is swept at the clip’s start');
  if (spoken.failed.length > 0) notes.push(`no usable transcript for: ${spoken.failed.join(', ')}`);
  if (spoken.missing.length > 0) notes.push(`not transcribed (ignored): ${spoken.missing.join(', ')}`);
  return { status: 'ready', notes, ...suggestion };
}
