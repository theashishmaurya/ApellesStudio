// D-396/D-397 — the suggestion's orchestration: which spoken words count, what
// blocks, what is ignored, and the OCR call. The matching is
// `highlightSuggest.test.ts`.
import { describe, expect, it, vi } from 'vitest';
import { suggestClipHighlights, spokenWordsOver, type SuggestDeps } from './highlightSuggestOp';
import type { AnalysisStatus, Transcript } from './mediaUnderstandingStore';
import { timelineFps, type Clip, type Timeline } from './timeline';
import type { OcrLine } from './highlightSuggest';

const SCREENSHOT = '/media/article.png';
const VO = '/media/voiceover.wav';
const MUSIC = '/media/bed.wav';

function clip(id: string, source: string, start: number, duration: number, over: Partial<Clip> = {}): Clip {
  return { id, name: id, source_path: source, source_start: 0, duration, source_len: 100000, start_frame: start, ...over };
}

const timeline = (): Timeline => ({
  id: 't',
  name: 't',
  tracks: [
    { kind: 'video', clips: [clip('page', SCREENSHOT, 300, 240, { source_start: 0 })] },
    { kind: 'audio', clips: [clip('vo', VO, 0, 3000)] },
    { kind: 'audio', clips: [clip('music', MUSIC, 0, 3000)] },
  ],
});

/** A finished transcript whose words are one every 0.25 s from `t0`. */
function transcript(text: string, t0: number): Transcript {
  const words = text.split(' ').map((w, i) => ({ word: ` ${w}`, start: t0 + i * 0.25, end: t0 + i * 0.25 + 0.2 }));
  return { text, language: 'en', model: 'm', source: VO, segments: [{ start: t0, end: t0 + words.length * 0.25, text, words }] };
}

const done = (t: Transcript): AnalysisStatus<Transcript> => ({ phase: 'done', result: t });
const line = (text: string, y: number): OcrLine => {
  const ws = text.split(' ');
  return {
    text,
    bbox: [0.1, y, 0.9, y + 0.06],
    confidence: 0.9,
    words: ws.map((w, i) => ({ text: w, bbox: [0.1 + i * 0.1, y, 0.1 + i * 0.1 + 0.09, y + 0.06], confidence: 0.9 })),
  };
};

function deps(over: Partial<SuggestDeps> = {}): SuggestDeps {
  const tl = timeline();
  // The page is on screen from timeline frame 300 (10 s at the default 30 fps).
  const fps = timelineFps(tl);
  return {
    timeline: tl,
    transcriptStatus: (p) =>
      p === VO
        ? done(transcript('the breach exposed customer passwords', 300 / fps + 0.5))
        : { phase: 'idle' },
    ocr: vi.fn(async () => [line('Breach exposed customer passwords', 0.3)]),
    ...over,
  };
}

describe('spokenWordsOver', () => {
  it('reads narration from an audio track and ignores an untranscribed music bed', () => {
    const d = deps();
    const out = spokenWordsOver(d.timeline as Timeline, (d.timeline as Timeline).tracks[0].clips[0], 0, d.transcriptStatus);
    expect(out.words.map((w) => w.text)).toEqual(['the', 'breach', 'exposed', 'customer', 'passwords']);
    expect(out.transcribed).toBe(1);
    expect(out.missing).toEqual([MUSIC]);
    // Words are on the TIMELINE, in order, inside the page's span 300..540.
    expect(out.words[0].startFrame).toBeGreaterThanOrEqual(300);
    expect(out.words.every((w, i, a) => i === 0 || a[i - 1].startFrame <= w.startFrame)).toBe(true);
  });

  it('drops words that fall outside the clip’s span or its source window', () => {
    const tl = timeline();
    const status = () => done(transcript('early words nobody hears here', 0));
    const out = spokenWordsOver(tl, tl.tracks[0].clips[0], 0, (p) => (p === VO ? status() : { phase: 'idle' }));
    expect(out.words).toEqual([]);
  });

  it('does not report one utterance twice for an A/V-linked pair', () => {
    const tl = timeline();
    tl.tracks[0].clips.push(clip('talking', '/media/head.mp4', 300, 240));
    const vo = transcript('same words', 300 / timelineFps(tl) + 0.5);
    const out = spokenWordsOver(tl, tl.tracks[0].clips[0], 0, (p) => (p === VO || p === '/media/head.mp4' ? done(vo) : { phase: 'idle' }));
    expect(out.words.map((w) => w.text)).toEqual(['same', 'words']);
  });
});

describe('suggestClipHighlights', () => {
  it('returns matched highlights with OCR called on the clip’s own file', async () => {
    const d = deps();
    const out = await suggestClipHighlights(d, 0, 0);
    if (!('status' in out) || out.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(out)}`);
    expect(out.basis).toBe('transcript');
    expect(out.phrases[0].text).toBe('breach exposed customer passwords');
    expect(out.highlights).toHaveLength(1);
    expect(d.ocr).toHaveBeenCalledWith(SCREENSHOT, 0);
    expect(out.notes.join(' ')).toContain('not transcribed');
  });

  it('waits while a narration source is still being transcribed', async () => {
    const d = deps({ transcriptStatus: (p) => (p === VO ? { phase: 'running' } : { phase: 'idle' }) });
    expect(await suggestClipHighlights(d, 0, 0)).toEqual({ status: 'transcribing', sources: [VO] });
    expect(d.ocr).not.toHaveBeenCalled();
  });

  it('names the sources to transcribe when nothing overlapping has a transcript', async () => {
    const d = deps({ transcriptStatus: () => ({ phase: 'idle' }) });
    const out = await suggestClipHighlights(d, 0, 0);
    expect(out).toMatchObject({ status: 'needs_transcript' });
    expect((out as { sources: string[] }).sources.sort()).toEqual([MUSIC, VO]);
  });

  it('falls back to the headline when nothing is spoken over the clip', async () => {
    const d = deps({ transcriptStatus: () => ({ phase: 'done', result: transcript('x', 0) }) });
    const out = await suggestClipHighlights(d, 0, 0);
    if (!('status' in out) || out.status !== 'ready') throw new Error('not ready');
    expect(out.basis).toBe('headline');
    expect(out.notes.join(' ')).toContain('largest line');
  });

  it('refuses a missing clip, an audio clip and a title', async () => {
    const d = deps();
    expect(await suggestClipHighlights(d, 0, 9)).toMatchObject({ error: expect.stringContaining('no clip 9') });
    expect(await suggestClipHighlights(d, 1, 0)).toMatchObject({ error: expect.stringContaining('picture') });
    expect(await suggestClipHighlights({ ...d, timeline: null }, 0, 0)).toMatchObject({ error: 'no timeline loaded' });
  });

  it('surfaces an OCR failure as an error, not a crash', async () => {
    const d = deps({ ocr: async () => Promise.reject(new Error('text recognition failed for x')) });
    expect(await suggestClipHighlights(d, 0, 0)).toEqual({ error: 'text recognition failed for x' });
  });
});
