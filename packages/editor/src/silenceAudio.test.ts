// B-327 / D-428 — audio is the authority: bases, mistimed-word correction,
// merge across a click, cushions, keep. The envelopes are built from a spec of
// (from, to, dBFS) segments at the same 20 ms hop `apelles_speech::energy` emits.
import { describe, expect, it } from 'vitest';

import type { SilenceDetection } from './mediaUnderstandingStore';
import {
  DEFAULT_SILENCE_OPTIONS,
  correctWords,
  cutRange,
  noiseFloorDb,
  parseSilenceOptions,
  resolveSilences,
  type SilenceOptions,
} from './silenceAudio';
import { wordAwareSilences } from './silenceWords';

const HOP = 0.02;
const LOUD = -20;
const ROOM = -60;

/** Envelope over [0, total) that is ROOM except where a segment says otherwise. */
function envelope(total: number, segs: Array<[number, number, number]>): SilenceDetection['energy'] {
  const db = new Array<number>(Math.round(total / HOP)).fill(ROOM);
  for (const [from, to, level] of segs) {
    for (let i = Math.round(from / HOP); i < Math.round(to / HOP); i++) db[i] = level;
  }
  return { hop_secs: HOP, start_secs: 0, db };
}

function detection(energy: SilenceDetection['energy'], vad: Array<[number, number]>): SilenceDetection {
  return {
    source: '/x.wav',
    start_secs: 0,
    duration_secs: energy.db.length * HOP,
    analysed_secs: energy.db.length * HOP,
    min_silence_ms: 350,
    model: 'test',
    silences: vad.map(([a, b]) => ({ start_secs: a, end_secs: b, duration_secs: b - a })),
    energy,
  };
}

const opts = (o: Partial<SilenceOptions> = {}): SilenceOptions => ({ ...DEFAULT_SILENCE_OPTIONS, ...o });
const ok = (r: ReturnType<typeof resolveSilences>) => {
  if ('error' in r) throw new Error(r.error);
  return r;
};
const range = (r: ReturnType<typeof ok>) => r.silences.map((s) => [s.startSecs, s.endSecs]);

// Voice 0-5 s, a flat 1.5 s pause, voice 6.5-9 s.
const PAUSE = envelope(9, [
  [0, 5, LOUD],
  [6.5, 9, LOUD],
]);

describe('noiseFloorDb', () => {
  it('reads the room tone, not the speech', () => {
    expect(noiseFloorDb(PAUSE.db)).toBe(ROOM);
    expect(noiseFloorDb([])).toBeNull();
  });
});

describe('basis: energy', () => {
  it('finds the flat pause from the waveform alone, with the default -30 dB level', () => {
    const r = ok(resolveSilences(detection(PAUSE, []), null, 450, opts({ basis: 'energy' })));
    expect(range(r)).toEqual([[5, 6.5]]);
    expect(r).toMatchObject({ basis: 'energy', thresholdDb: -30, thresholdSource: 'default', noiseFloorDb: ROOM });
  });

  it('threshold_db moves the level: a -70 dB line sees no silence in -60 dB room tone', () => {
    const r = ok(resolveSilences(detection(PAUSE, []), null, 450, opts({ basis: 'energy', thresholdDb: -70 })));
    expect(r.silences).toEqual([]);
  });

  it('auto_threshold follows the measured floor: a noisy -35 dB room is found at floor+12, missed at -40', () => {
    const noisy = envelope(9, [
      [0, 5, LOUD],
      [5, 6.5, -35],
      [6.5, 9, LOUD],
    ]);
    const auto = ok(resolveSilences(detection(noisy, []), null, 450, opts({ basis: 'energy', autoThreshold: true })));
    expect(range(auto)).toEqual([[5, 6.5]]);
    expect(auto).toMatchObject({ thresholdSource: 'auto', thresholdDb: -23, noiseFloorDb: -35 });
    const fixed = ok(resolveSilences(detection(noisy, []), null, 450, opts({ basis: 'energy', thresholdDb: -40 })));
    expect(fixed.silences).toEqual([]);
  });

  it('min_silence_ms drops a pause shorter than it', () => {
    const r = ok(resolveSilences(detection(PAUSE, []), null, 2000, opts({ basis: 'energy' })));
    expect(r.silences).toEqual([]);
  });

  it('refuses when the detection carries no loudness data', () => {
    const d = { ...detection(PAUSE, []), energy: { hop_secs: HOP, start_secs: 0, db: [] } };
    expect(resolveSilences(d, null, 450, opts({ basis: 'energy' }))).toMatchObject({
      error: expect.stringMatching(/loudness/),
    });
  });
});

describe('basis: vad', () => {
  it('reports the voice model exactly, no words, no correction', () => {
    const words = [{ start: 4.5, end: 6.4 }];
    const r = ok(resolveSilences(detection(PAUSE, [[5.05, 6.45]]), words, 350, opts({ basis: 'vad' })));
    expect(range(r)).toEqual([[5.05, 6.45]]);
    expect(r).toMatchObject({ basis: 'vad', wordAware: false, correctedWords: 0 });
  });
});

describe('mistimed words (B-327)', () => {
  // "video." is timed 4.5-6.4 s — stretched over the whole real pause.
  const words = [
    { start: 3.0, end: 4.4 },
    { start: 4.5, end: 6.4 },
    { start: 6.55, end: 7.2 },
  ];
  const d = detection(PAUSE, [[5.05, 6.45]]);

  it('the bare word rule (pre-fix) trims that silence to nothing', () => {
    const old = wordAwareSilences(d.silences, words, 0.35);
    expect(old.silences).toEqual([]);
    expect(old.dropped).toBe(1);
  });

  it('vad+words: the word is clamped to its voiced part and the pause survives', () => {
    const r = ok(resolveSilences(d, words, 350, opts()));
    expect(r.silences).toHaveLength(1);
    // Word end clamps to 5.0 s (last voiced frame), + the 0.125 s guard.
    expect(r.silences[0].startSecs).toBeCloseTo(5.125, 6);
    // The onset word starts 6.55 s: 6.55 - 0.125 = 6.425.
    expect(r.silences[0].endSecs).toBeCloseTo(6.425, 6);
    expect(r).toMatchObject({ correctedWords: 1, droppedForWords: 0, wordAware: true, basis: 'vad+words' });
    expect(r.silences[0].wordCorrected).toBe(true);
    expect(r.silences[0].rawStartSecs).toBeCloseTo(5.05, 6);
    expect(r.silences[0].rawEndSecs).toBeCloseTo(6.45, 6);
  });

  it('energy+words does the same from the waveform silence', () => {
    const r = ok(resolveSilences(detection(PAUSE, []), words, 350, opts({ basis: 'energy+words' })));
    expect(r.silences[0].startSecs).toBeCloseTo(5.125, 6);
    expect(r.silences[0].endSecs).toBeCloseTo(6.425, 6);
    expect(r.basis).toBe('energy+words');
  });

  it('a +words basis with no transcript degrades honestly to the base detector', () => {
    const r = ok(resolveSilences(d, null, 350, opts()));
    expect(r).toMatchObject({ basis: 'vad', requestedBasis: 'vad+words', wordAware: false });
  });

  it('a word lying wholly over silence protects nothing', () => {
    const c = correctWords([{ start: 5.2, end: 6.0 }], PAUSE, -30);
    expect(c.words).toEqual([]);
    expect(c.corrections[0].corrected).toBeNull();
  });

  it('a well-timed word is untouched; a dip inside a word is not an edge', () => {
    const env = envelope(3, [
      [0, 0.5, LOUD],
      [0.7, 1.2, LOUD], // 0.2 s dip inside the word
    ]);
    const c = correctWords([{ start: 0.0, end: 1.2 }], env, -30);
    expect(c.corrections).toEqual([]);
    expect(c.words).toEqual([{ start: 0.0, end: 1.2 }]);
  });
});

describe('merge_gap_ms', () => {
  // A 0.1 s click at 5.7 s splits one pause into two.
  const clicked = envelope(9, [
    [0, 5, LOUD],
    [5.7, 5.8, LOUD],
    [6.5, 9, LOUD],
  ]);

  it('joins silences split by a blip no longer than the gap (default 120 ms)', () => {
    const r = ok(resolveSilences(detection(clicked, []), null, 450, opts({ basis: 'energy' })));
    expect(range(r)).toEqual([[5, 6.5]]);
  });

  it('merge_gap_ms 0 keeps them apart, so each half is too short for 800 ms', () => {
    const r = ok(resolveSilences(detection(clicked, []), null, 800, opts({ basis: 'energy', mergeGapMs: 0 })));
    expect(r.silences).toEqual([]);
  });
});

describe('cushions and keep', () => {
  const base = detection(PAUSE, []);

  it('asymmetric pads leave the cushion inside the silence: 220 ms after speech, 100 ms before the onset', () => {
    const r = ok(resolveSilences(base, null, 450, opts({ basis: 'energy', padAfterMs: 220, padBeforeMs: 100 })));
    expect(r.silences[0].cut?.start).toBeCloseTo(5.22, 6);
    expect(r.silences[0].cut?.end).toBeCloseTo(6.4, 6);
    expect(range(r)).toEqual([[5, 6.5]]); // the measured range is unchanged
  });

  it('keep_ms leaves a total pause, split 2:1 after:before when no pads say otherwise', () => {
    const r = ok(resolveSilences(base, null, 450, opts({ basis: 'energy', keepMs: 300 })));
    expect(r.silences[0].cut?.start).toBeCloseTo(5.2, 6);
    expect(r.silences[0].cut?.end).toBeCloseTo(6.4, 6);
  });

  it('cushions that eat the whole silence leave no cut', () => {
    expect(cutRange(0, 0.3, opts({ padAfterMs: 200, padBeforeMs: 200 }))).toBeNull();
  });

  it('no pads, no keep: the cut is the silence', () => {
    const r = ok(resolveSilences(base, null, 450, opts({ basis: 'energy' })));
    expect(r.silences[0].cut).toEqual({ start: 5, end: 6.5 });
  });
});

describe('determinism and option parsing', () => {
  it('same input, same ranges', () => {
    const run = () =>
      JSON.stringify(resolveSilences(detection(PAUSE, [[5.05, 6.45]]), [{ start: 4.5, end: 6.4 }], 350, opts()));
    expect(run()).toBe(run());
  });

  it('parses camelCase knobs and rejects nonsense', () => {
    expect(parseSilenceOptions({ basis: 'energy', thresholdDb: -35, padAfterMs: 200 })).toMatchObject({
      options: { basis: 'energy', thresholdDb: -35, padAfterMs: 200 },
    });
    expect(parseSilenceOptions({})).toEqual({ options: DEFAULT_SILENCE_OPTIONS });
    expect(parseSilenceOptions({ basis: 'loud' })).toHaveProperty('error');
    expect(parseSilenceOptions({ thresholdDb: 5 })).toHaveProperty('error');
    expect(parseSilenceOptions({ mergeGapMs: -1 })).toHaveProperty('error');
    expect(parseSilenceOptions({ autoThreshold: true, thresholdDb: -30 })).toHaveProperty('error');
  });
});
