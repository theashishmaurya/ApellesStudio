/**
 * `retakeWordView.ts` — the timeline half of the client's word view (D-380
 * step 2). Which words a clip shows and how the view renders are the Rust
 * crate's (`index_pieces`, tested there against the POC's own input); what is
 * tested here is what only the timeline knows: which clips, in which order,
 * onto which windows of which file — and how answers map back to frames.
 */
import { describe, expect, it } from 'vitest';

import {
  buildWordViewInput,
  cutSegments,
  MAX_REREAD_SECS,
  rereadWindow,
  viewBasisKey,
  viewWordsInWindow,
  wireViewArgs,
  wordSpanSegments,
  type ViewWord,
  type WordViewInput,
} from './retakeWordView';
import type { RecoveredWindow } from './darkRegions';
import type { Transcript } from './mediaUnderstandingStore';
import type { Timeline } from './timeline';

const A = '/media/a.mov';
const B = '/media/b.mov';

/** A transcript of `n` words, one every 0.5 s, in segments of 4. */
function transcript(path: string, n: number): Transcript {
  const words = Array.from({ length: n }, (_, i) => ({ word: ` w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const segments = [];
  for (let i = 0; i < n; i += 4) {
    const ws = words.slice(i, i + 4);
    segments.push({ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.word).join(''), words: ws });
  }
  return { text: '', language: 'en', model: 't', source: path, segments, words };
}

function clip(id: string, path: string | null, sourceStart: number, duration: number, startFrame: number) {
  return {
    id,
    name: id,
    source_path: path,
    source_start: sourceStart,
    duration,
    source_len: 10_000,
    source_fps: 24,
    start_frame: startFrame,
  };
}

function timeline(clips: unknown[]): Timeline {
  return {
    id: 'tl',
    name: 't',
    rate: { num: 24, den: 1 },
    tracks: [{ kind: 'video', clips, gain: 1, sync_locked: false }],
    markers: [],
  } as unknown as Timeline;
}

const none = () => [] as RecoveredWindow[];

function input(tl: Timeline, transcripts: Record<string, Transcript>, rec = none): WordViewInput {
  const v = buildWordViewInput(tl, 0, transcripts, rec);
  if ('error' in v) throw new Error(v.error);
  return v;
}

describe('buildWordViewInput', () => {
  it('a single untrimmed clip is one window over its whole source', () => {
    const v = input(timeline([clip('a', A, 0, 240, 0)]), { [A]: transcript(A, 8) });
    expect(v.sources.map((s) => s.path)).toEqual([A]);
    expect(v.pieces).toHaveLength(1);
    expect(v.pieces[0]).toMatchObject({ source: 0, startSecs: 0, endSecs: 10, clip: 0, clipId: 'a' });
    // The segments are the transcript's own, unchanged when nothing is spliced.
    expect(v.sources[0].segments.map((s) => s.words.length)).toEqual([4, 4]);
  });

  it('a silence-cut run is one window per surviving clip, so removed words are outside every window', () => {
    // 0-2 s and 3-5 s survive; 2-3 s was cut.
    const v = input(timeline([clip('a', A, 0, 48, 0), clip('b', A, 72, 48, 48)]), { [A]: transcript(A, 10) });
    expect(v.sources).toHaveLength(1);
    expect(v.pieces.map((p) => [p.source, p.startSecs, p.endSecs])).toEqual([
      [0, 0, 2],
      [0, 3, 5],
    ]);
  });

  it('several sources are each sent once, in first-use order, and stills and titles are skipped', () => {
    const v = input(
      timeline([
        clip('a', A, 0, 48, 0),
        clip('t', null, 0, 24, 48),
        clip('p', '/media/still.png', 0, 24, 72),
        clip('b', B, 0, 48, 96),
        clip('a2', A, 96, 24, 144),
      ]),
      { [A]: transcript(A, 12), [B]: transcript(B, 4) },
    );
    expect(v.sources.map((s) => s.path)).toEqual([A, B]);
    expect(v.pieces.map((p) => [p.clip, p.source])).toEqual([
      [0, 0],
      [3, 1],
      [4, 0],
    ]);
    const wire = wireViewArgs(v);
    expect(wire.sources).toHaveLength(2);
    expect(wire.pieces[2]).toEqual({ source: 0, startSecs: 4, endSecs: 5 });
  });

  it('reports a source with no transcript as pending, and a failed one as failed', () => {
    const v = buildWordViewInput(
      timeline([clip('a', A, 0, 48, 0), clip('b', B, 0, 48, 48)]),
      0,
      {},
      none,
      { [B]: 'sidecar down' },
    );
    if ('error' in v) throw new Error(v.error);
    expect(v.pending).toEqual([A]);
    expect(v.failed).toEqual([{ path: B, error: 'sidecar down' }]);
    expect(v.pieces).toHaveLength(0);
    expect(buildWordViewInput(timeline([]), 4, {}, none)).toEqual({ error: 'no track 4 (0..0)' });
  });

  it('splices recoveries and applied re-reads in, as every other consumer does', () => {
    const rec: RecoveredWindow[] = [
      {
        window: { startSecs: 0.9, durationSecs: 1.2 },
        segments: [{ start: 1.0, end: 1.9, text: 'new', words: [{ word: ' new', start: 1.0, end: 1.9 }] }],
      },
    ];
    const v = input(timeline([clip('a', A, 0, 240, 0)]), { [A]: transcript(A, 8) }, () => rec);
    const words = v.sources[0].segments.flatMap((s) => s.words.map((w) => w.word.trim()));
    // w2 and w3 (midpoints 1.2, 1.7) are inside 0.9-2.1 and replaced; w4
    // (midpoint 2.2) is not.
    expect(words).toEqual(['w0', 'w1', 'new', 'w4', 'w5', 'w6', 'w7']);
  });
});

describe('viewBasisKey', () => {
  const tl = timeline([clip('a', A, 0, 240, 0)]);
  const t = { [A]: transcript(A, 8) };

  it('is deterministic for the same inputs', () => {
    expect(viewBasisKey(input(tl, t))).toBe(viewBasisKey(input(tl, t)));
  });

  it('moves with a trim, a different transcript, and a splice', () => {
    const base = viewBasisKey(input(tl, t));
    expect(viewBasisKey(input(timeline([clip('a', A, 0, 200, 0)]), t))).not.toBe(base);
    expect(viewBasisKey(input(tl, { [A]: transcript(A, 9) }))).not.toBe(base);
    const rec = () => [{ window: { startSecs: 0, durationSecs: 0.5 }, segments: [] }];
    expect(viewBasisKey(input(tl, t, rec))).not.toBe(base);
  });
});

describe('mapping answers back to the timeline', () => {
  const tl = timeline([clip('a', A, 0, 48, 0), clip('b', A, 72, 48, 48)]);
  const v = input(tl, { [A]: transcript(A, 10) });
  // The view as the Rust command would return it: clip a shows w0-w3, clip b w6-w9.
  const words: ViewWord[] = [0, 1, 2, 3, 6, 7, 8, 9].map((i) => ({
    text: `w${i}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
    piece: i < 4 ? 0 : 1,
  }));

  it('a word range spanning two clips is one segment per clip, in that clip\'s frames', () => {
    const segs = wordSpanSegments(v, words, 2, 5);
    expect(segs.map((s) => s.clip)).toEqual([0, 1]);
    // w2 starts at 1.0 s = frame 24 of clip a; w6 starts at 3.0 s = source
    // frame 72 = clip b's first frame, which sits at timeline frame 48.
    expect(segs[0].span.startFrame).toBe(24);
    expect(segs[1].span.startFrame).toBe(48);
  });

  it('a cut range lands in its own piece, clamped to the clip', () => {
    const segs = cutSegments(v, [{ first: 4, last: 5, startSecs: 2.9, endSecs: 3.95, piece: 1 }]);
    expect(segs).toHaveLength(1);
    expect(segs[0].clipId).toBe('b');
    expect(segs[0].span.sourceStartFrame).toBe(72);
  });
});

describe('rereadWindow', () => {
  const tl = timeline([clip('a', A, 0, 2400, 0)]);
  const t = transcript(A, 40);
  const v = input(tl, { [A]: t });
  const words: ViewWord[] = t.words!.map((w) => ({ text: w.word, start: w.start, end: w.end, piece: 0 }));

  it('adds context either side and never cuts a word in half', () => {
    const w = rereadWindow(v, words, 10, 11);
    if ('error' in w) throw new Error(w.error);
    expect(w.path).toBe(A);
    expect(w.language).toBe('en');
    // Words 10-11 span 5.0-5.9 s; 2 s of context lands 3.0 (on w6's start)
    // and 7.9 (inside w15, 7.5-7.9 — on its end), so neither edge splits a word.
    const end = w.startSecs + w.durationSecs;
    for (const x of t.words!) {
      expect(x.start < w.startSecs && w.startSecs < x.end).toBe(false);
      expect(x.start < end && end < x.end).toBe(false);
    }
    expect(w.startSecs).toBeLessThanOrEqual(3.0);
    expect(end).toBeGreaterThanOrEqual(7.9);
  });

  it('refuses a range across two files, a bad range, and one too long to check', () => {
    const two = input(timeline([clip('a', A, 0, 48, 0), clip('b', B, 0, 48, 48)]), {
      [A]: transcript(A, 4),
      [B]: transcript(B, 4),
    });
    const ws: ViewWord[] = [
      { text: 'a', start: 0, end: 0.4, piece: 0 },
      { text: 'b', start: 0, end: 0.4, piece: 1 },
    ];
    expect(rereadWindow(two, ws, 0, 1)).toMatchObject({ error: expect.stringContaining('more than one source') });
    expect(rereadWindow(v, words, 5, 4)).toMatchObject({ error: expect.stringContaining('first <= last') });
    expect(rereadWindow(v, words, 0, 99)).toMatchObject({ error: expect.stringContaining('past the end') });
    const long = transcript(A, 200);
    const lv = input(timeline([clip('a', A, 0, 4800, 0)]), { [A]: long });
    const lw = long.words!.map((w) => ({ text: w.word, start: w.start, end: w.end, piece: 0 }));
    expect(rereadWindow(lv, lw, 0, 199)).toMatchObject({ error: expect.stringContaining(`${MAX_REREAD_SECS}s`) });
  });

  it('lists the view words a window holds, by midpoint', () => {
    expect(viewWordsInWindow(v, words, A, 5.0, 6.0).map((w) => w.index)).toEqual([10, 11]);
    expect(viewWordsInWindow(v, words, B, 5.0, 6.0)).toEqual([]);
  });
});
