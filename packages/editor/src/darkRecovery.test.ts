/**
 * `clipTranscriptView` — the one step both `editor_detect_retakes` and the
 * Recut panel run before grouping (D-349, B-216).
 *
 * **Why this file exists separately from `darkRegions.test.ts`.** That one
 * covers the pure maths (which windows to re-read, what the splice does). This
 * one covers the part that can only be wrong in the wiring: which store calls
 * are made, which are NOT made on a status-only read, what a caller is told
 * while a scan or a re-read is still in flight, and — the one that matters most
 * — that **every failure path degrades to the pre-D-349 answer rather than to
 * no answer at all**. A retake sweep that returned nothing because a VAD scan
 * failed would be a worse regression than the bug this feature fixes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { clipTranscriptView } from './darkRecovery';
import {
  darkKey,
  recoveryKey,
  useMediaUnderstandingStore,
  type DarkDetectionArgs,
  type Transcript,
} from './mediaUnderstandingStore';
import type { DarkDetection, DarkRegionWire, RecoveredWindow } from './darkRegions';

const SOURCE = '/fixtures/talk.mov';
/** The clip's trimmed source range, in absolute source seconds. */
const RANGE = { start: 0, secs: 20 };

function word(text: string, start: number, end: number) {
  return { word: text, start, end };
}

/** A transcript that reads 0-8 s and then says nothing until 14 s — the shape a
 *  dropped utterance leaves behind. */
function transcript(overrides: Partial<Transcript> = {}): Transcript {
  const words = [
    word(' the', 1.0, 1.4),
    word(' cat', 1.4, 1.8),
    word(' sat', 6.0, 6.4),
    word(' down', 6.4, 6.8),
    word(' again', 14.0, 14.4),
  ];
  return {
    text: 'the cat sat down again',
    language: 'en',
    model: 'parakeet-tdt-0.6b-v3',
    source: SOURCE,
    segments: [
      { start: 1.0, end: 1.8, text: 'the cat', words: words.slice(0, 2) },
      { start: 6.0, end: 6.8, text: 'sat down', words: words.slice(2, 4) },
      { start: 14.0, end: 14.4, text: 'again', words: words.slice(4) },
    ],
    words,
    ...overrides,
  };
}

function region(start: number, end: number, stretch: [number, number]): DarkRegionWire {
  return {
    start_secs: start,
    end_secs: end,
    duration_secs: end - start,
    stretch_start_secs: stretch[0],
    stretch_end_secs: stretch[1],
    stretch_speech_secs: end - start,
    rms_peak: 0.2,
  };
}

function detection(regions: DarkRegionWire[]): DarkDetection {
  return {
    source: SOURCE,
    start_secs: RANGE.start,
    duration_secs: RANGE.secs,
    analysed_secs: RANGE.secs,
    min_dark_secs: 1.2,
    max_word_secs: 2.0,
    model: 'silero_vad_v6.2.1.onnx',
    regions,
    rms_floor: 0.1,
    calibration_spans: 5,
    gated_out: 0,
    speech_secs: 12,
    covered_secs: 8,
  };
}

/** The store key the view will look a scan up under, derived the same way the
 *  view derives it — never hand-written, so a change to the key shape fails
 *  loudly here instead of silently missing the cache. */
function scanKey(t: Transcript): string {
  const args: DarkDetectionArgs = {
    path: SOURCE,
    startSecs: RANGE.start,
    durationSecs: RANGE.secs,
    words: (t.words ?? []).map((w) => ({ start: w.start, end: w.end })),
  };
  return darkKey(args);
}

function view(t: Transcript, recover = true, start = true) {
  return clipTranscriptView(SOURCE, t, RANGE.start, RANGE.secs, recover, start);
}

beforeEach(() => {
  invoke.mockReset();
  // Nothing should reach the backend in these tests unless a case says so —
  // an unexpected call is a wiring bug, not a detail.
  invoke.mockImplementation((cmd: string) => {
    throw new Error(`unexpected invoke(${cmd})`);
  });
  reset();
});

afterEach(reset);

/** `clear()` deliberately does NOT drop the in-flight flags — a job really is
 *  still running when it is called. These tests deliberately leave one hanging
 *  (a never-resolving `invoke`), so they have to clear those too or the next
 *  test reads `running` for a job nobody started. */
function reset(): void {
  useMediaUnderstandingStore.getState().clear();
  useMediaUnderstandingStore.setState({
    detectingDark: {},
    recovering: {},
    transcribing: {},
    detectingSilences: {},
    detectingRetakes: {},
  } as never);
}

describe('clipTranscriptView', () => {
  it('starts a scan and reports `scanning` until it lands', () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    const v = view(transcript());
    expect(v.pending).toBe('scanning');
    expect(invoke).toHaveBeenCalledWith('chroma_detect_dark_regions', expect.anything());
    // The raw utterances come back anyway, so a caller that decides not to wait
    // still has the pre-D-349 answer in hand.
    expect(v.utterances.map((u) => u.text)).toEqual(['the cat', 'sat down', 'again']);
    expect(v.recovered).toBe(0);
    expect(v.detection).toBeUndefined();
  });

  /** A status poll must never kick off a VAD pass or a transcription run of its own. */
  it('starts nothing when asked to read rather than to run', () => {
    const v = view(transcript(), true, false);
    expect(invoke).not.toHaveBeenCalled();
    expect(v.pending).toBe('scanning');
  });

  it('starts one recovery per window and reports `recovering` until they land', () => {
    const t = transcript();
    invoke.mockImplementation(() => new Promise(() => {}));
    useMediaUnderstandingStore.setState({
      dark: { [scanKey(t)]: detection([region(9, 12, [6.8, 14.0])]) },
    } as never);

    const v = view(t);
    expect(v.pending).toBe('recovering');
    expect(v.detection?.regions).toHaveLength(1);
    // The window is the STRETCH, and the language is PINNED to the whole-file
    // pass's own detection — auto-detect on a short extract is unreliable.
    expect(invoke).toHaveBeenCalledWith(
      'chroma_transcribe',
      expect.objectContaining({
        path: SOURCE,
        language: 'en',
        startSecs: 6.8,
        durationSecs: 7.2,
      }),
    );
  });

  /** The headline: once the re-read lands, the grouper is handed the recovered
   *  line as an ordinary utterance, in time order, with the smeared whole-file
   *  words inside that window gone. */
  it('splices the recovered words into the utterances it hands back', () => {
    const t = transcript();
    const window = { startSecs: 6.8, durationSecs: 7.2 };
    const recovered: RecoveredWindow = {
      window,
      segments: [
        {
          start: 9.2,
          end: 11.5,
          text: 'the cat sat down',
          words: [word(' the', 9.2, 9.6), word(' cat', 9.6, 10.0)],
        },
      ],
    };
    useMediaUnderstandingStore.setState({
      dark: { [scanKey(t)]: detection([region(9, 12, [6.8, 14.0])]) },
      recoveries: { [recoveryKey(SOURCE, window)]: recovered },
    } as never);

    const v = view(t);
    expect(v.pending).toBeNull();
    expect(v.recovered).toBe(1);
    expect(v.utterances.map((u) => u.text)).toEqual([
      'the cat',
      'sat down',
      'the cat sat down',
      'again',
    ]);
  });

  /** `recoverDarkRegions: false` must be the pre-D-349 behaviour exactly, and
   *  must cost nothing — no scan, no recovery, no round trip. */
  it('does nothing at all when recovery is switched off', () => {
    const v = view(transcript(), false);
    expect(invoke).not.toHaveBeenCalled();
    expect(v.pending).toBeNull();
    expect(v.detection).toBeUndefined();
    expect(v.utterances).toHaveLength(3);
  });

  /** Coverage is a fact about WORDS. Scanning a word-less transcript against
   *  segment bounds would call every inter-segment pause a hole, so it is not
   *  scanned at all — and the caller still gets its utterances. */
  it('degrades to the raw transcript when there are no word timings', () => {
    const t = transcript({ words: undefined });
    const v = view(t);
    expect(invoke).not.toHaveBeenCalled();
    expect(v.pending).toBeNull();
    expect(v.detection).toBeUndefined();
    expect(v.utterances).toHaveLength(3);
  });

  /** **The regression that would matter most.** A failed scan must not cost the
   *  caller its retakes — it degrades to the answer it would have given before
   *  this feature existed, and says why. */
  it('degrades to the raw transcript when the scan fails, and reports the reason', () => {
    const t = transcript();
    useMediaUnderstandingStore.setState({
      darkErrors: { [scanKey(t)]: 'the VAD model could not be loaded' },
    } as never);

    const v = view(t);
    expect(v.pending).toBeNull();
    expect(v.error).toBe('the VAD model could not be loaded');
    expect(v.utterances).toHaveLength(3);
    expect(v.recovered).toBe(0);
  });

  /** Same rule one step later: a re-read that failed leaves the scan's findings
   *  visible and the transcript unspliced, rather than blocking forever. */
  it('finishes with the unspliced transcript when a recovery fails', () => {
    const t = transcript();
    const window = { startSecs: 6.8, durationSecs: 7.2 };
    useMediaUnderstandingStore.setState({
      dark: { [scanKey(t)]: detection([region(9, 12, [6.8, 14.0])]) },
      recoveryErrors: { [recoveryKey(SOURCE, window)]: 'transcription timed out' },
    } as never);

    const v = view(t);
    expect(v.pending).toBeNull();
    expect(v.error).toBe('transcription timed out');
    expect(v.recovered).toBe(0);
    expect(v.utterances).toHaveLength(3);
  });

  /** A clean file: the scan ran, found nothing, and the answer is the raw
   *  transcript — but `detection` is present, which is how a caller tells
   *  "scanned and clean" from "never scanned". */
  it('reports a clean scan distinguishably from no scan', () => {
    const t = transcript();
    useMediaUnderstandingStore.setState({ dark: { [scanKey(t)]: detection([]) } } as never);

    const v = view(t);
    expect(v.pending).toBeNull();
    expect(v.detection?.regions).toEqual([]);
    expect(v.recovered).toBe(0);
    expect(v.utterances).toHaveLength(3);
  });

  /** A clip is a trim of its source, so a recovery in material the clip does
   *  not show must not reach the grouper. */
  it('keeps only the utterances the clip actually shows', () => {
    const t = transcript();
    const v = clipTranscriptView(SOURCE, t, 5.0, 4.0, false, false);
    expect(v.utterances.map((u) => u.text)).toEqual(['sat down']);
  });
});
