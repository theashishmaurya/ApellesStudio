// @apelles/editor — unit tests for the media-understanding store (D-189).
//
// What these actually protect. This store's whole job is to turn the
// `ai-media/` sidecar's START-then-POLL job protocol into something the
// `editor_*` control ops can answer within `chroma::control`'s 20-second
// bridge timeout. Everything that can go wrong there is invisible in a type
// check and expensive to find by hand (a real transcript costs tens of
// seconds of model time per attempt):
//   - polling that never terminates on a job the sidecar has forgotten,
//   - a cache that misses, making an agent pay the model cost twice,
//   - a `force` that doesn't actually re-run,
//   - a rejected background job becoming an unhandled rejection instead of a
//     reportable error the poller can see.
// Each is asserted below. `invoke` is mocked, so no sidecar is needed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
/** The persisted-record commands (D-385) answer from this fake disk instead of
 *  `invokeMock`, so the job-protocol tests below keep asserting exactly the
 *  sidecar calls they always did. `disk` survives `clear()` — that is what a
 *  simulated restart is. */
const disk = new Map<string, unknown>();
const diskMock = vi.fn((command: string, args: { path: string; record?: unknown }) => {
  if (command === 'chroma_media_understanding_load') {
    return Promise.resolve(disk.get(args.path) ?? null);
  }
  disk.set(args.path, structuredClone(args.record));
  return Promise.resolve(null);
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: { path: string; record?: unknown }) =>
    command.startsWith('chroma_media_understanding_')
      ? diskMock(command, args)
      : invokeMock(command, args),
}));

const { useMediaUnderstandingStore, silenceKey, retakeKey, recoveryKey, parsePersisted } = await import(
  './mediaUnderstandingStore',
);

const PATH = '/clips/take-1.mp4';

const TRANSCRIPT = {
  text: 'hello there',
  language: 'en',
  model: 'parakeet-tdt-0.6b-v3',
  source: PATH,
  segments: [{ start: 0, end: 1, text: 'hello there', words: [] }],
  words: [{ word: ' hello', start: 0, end: 0.4 }],
};

const ANALYSIS = {
  video: PATH,
  question: 'q',
  events: [{ time_s: 1.5, event: 'a cut' }],
  _meta: {
    model: 'qwen',
    scene_threshold: 0.12,
    min_gap_s: 1,
    max_candidates: 5,
    candidates: 5,
    truncated: true,
  },
};

/** Script `invoke` as the sidecar would answer: one start call returning a job
 *  id, then `runningPolls` "running" statuses before the terminal one. */
function scriptJob(terminal: Record<string, unknown>, runningPolls = 1) {
  let polls = 0;
  invokeMock.mockImplementation((command: string) => {
    if (command.endsWith('_status')) {
      polls += 1;
      return Promise.resolve(polls <= runningPolls ? { state: 'running' } : terminal);
    }
    return Promise.resolve({ job_id: 'j1' });
  });
}

/** Drain timers + microtasks until `predicate` holds, so tests never depend on
 *  a fixed number of POLL_MS ticks. */
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(1500);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeEach(() => {
  invokeMock.mockReset();
  diskMock.mockClear();
  disk.clear();
  useMediaUnderstandingStore.getState().clear();
  vi.useFakeTimers();
});

describe('the job protocol', () => {
  it('starts a job, polls past "running", and resolves with the finished result', async () => {
    scriptJob({ state: 'done', result: TRANSCRIPT }, 2);

    const promise = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(() => invokeMock.mock.calls.length >= 4, 'the start call plus three polls');
    await expect(promise).resolves.toEqual(TRANSCRIPT);

    expect(invokeMock.mock.calls[0]?.[0]).toBe('chroma_transcribe');
    expect(invokeMock.mock.calls[1]?.[0]).toBe('chroma_transcribe_status');
    // The job id from the start call is what gets polled — not the file path.
    expect(invokeMock.mock.calls[1]?.[1]).toEqual({ jobId: 'j1' });
  });

  it('fails loudly on state "unknown" rather than polling a job that will never resolve', async () => {
    // The sidecar restarted mid-run, or evicted the job record. The result is
    // never coming; polling forever would hang the caller (and, through the
    // control bridge, an agent) indefinitely.
    scriptJob({ state: 'unknown', error: 'no job j1' }, 0);

    const promise = useMediaUnderstandingStore.getState().analyzeVideo(PATH);
    const assertion = expect(promise).rejects.toThrow('no job j1');
    await until(() => invokeMock.mock.calls.length >= 2, 'the terminal poll');
    await assertion;
  });

  it('surfaces a start-call error without ever polling', async () => {
    invokeMock.mockResolvedValue({ error: 'file not found: /nope.mp4' });
    await expect(
      useMediaUnderstandingStore.getState().getTranscript('/nope.mp4'),
    ).rejects.toThrow('file not found');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a start call that returns no job id instead of polling undefined', async () => {
    invokeMock.mockResolvedValue({});
    await expect(useMediaUnderstandingStore.getState().getTranscript(PATH)).rejects.toThrow(
      'no job_id',
    );
  });
});

describe('the cache', () => {
  it('serves a second ask from cache without touching the sidecar', async () => {
    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    const first = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(() => invokeMock.mock.calls.length >= 2, 'first run to finish');
    await first;
    const callsAfterFirst = invokeMock.mock.calls.length;

    await expect(useMediaUnderstandingStore.getState().getTranscript(PATH)).resolves.toEqual(
      TRANSCRIPT,
    );
    expect(invokeMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('force re-runs even with a cached result, and replaces it', async () => {
    const startCalls = () =>
      invokeMock.mock.calls.filter(([c]) => c === 'chroma_transcribe').length;

    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    const first = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(
      () => useMediaUnderstandingStore.getState().transcripts[PATH] !== undefined,
      'the first run to land',
    );
    await first;
    expect(startCalls()).toBe(1);

    // The file changed on disk — the exact case `force` exists for. A distinct
    // result also proves the cache was genuinely REPLACED, not just re-read.
    const updated = { ...TRANSCRIPT, text: 'different words now' };
    scriptJob({ state: 'done', result: updated }, 0);

    const second = useMediaUnderstandingStore.getState().getTranscript(PATH, { force: true });
    await until(
      () => useMediaUnderstandingStore.getState().transcripts[PATH]?.text === updated.text,
      'the forced re-run to land',
    );
    await expect(second).resolves.toEqual(updated);
    expect(startCalls()).toBe(2);
  });

  it('caches transcripts and analyses independently per path', async () => {
    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    const p = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(() => useMediaUnderstandingStore.getState().transcripts[PATH] !== undefined, 'cached');
    await p;

    // A transcript for this path must not satisfy an ANALYSIS ask for it.
    expect(useMediaUnderstandingStore.getState().analysisStatus(PATH).phase).toBe('idle');
    // ...nor a transcript ask for a different file.
    expect(useMediaUnderstandingStore.getState().transcriptStatus('/other.mp4').phase).toBe('idle');
  });

  it('clear(path) drops only that path', async () => {
    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    const p = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(() => useMediaUnderstandingStore.getState().transcripts[PATH] !== undefined, 'cached');
    await p;

    useMediaUnderstandingStore.getState().clear('/somewhere/else.mp4');
    expect(useMediaUnderstandingStore.getState().transcriptStatus(PATH).phase).toBe('done');
    useMediaUnderstandingStore.getState().clear(PATH);
    expect(useMediaUnderstandingStore.getState().transcriptStatus(PATH).phase).toBe('idle');
  });
});

describe('start + status, the shape the control ops actually use', () => {
  it('reports running immediately, then done — never blocking the caller', async () => {
    scriptJob({ state: 'done', result: ANALYSIS }, 2);
    const store = useMediaUnderstandingStore.getState();

    // The whole point: this returns NOW, well inside the 20s bridge timeout,
    // even though the underlying job takes far longer.
    expect(store.startAnalysis(PATH)).toBe('running');
    expect(store.analysisStatus(PATH).phase).toBe('running');

    await until(() => store.analysisStatus(PATH).phase === 'done', 'the job to finish');
    const status = store.analysisStatus(PATH);
    expect(status.result).toEqual(ANALYSIS);
    expect(status.result?._meta.truncated).toBe(true);
  });

  it('a second start while one is in flight does not launch a duplicate job', async () => {
    scriptJob({ state: 'done', result: ANALYSIS }, 3);
    const store = useMediaUnderstandingStore.getState();

    store.startAnalysis(PATH);
    const startCalls = () =>
      invokeMock.mock.calls.filter(([c]) => c === 'chroma_analyze_video').length;
    expect(startCalls()).toBe(1);

    expect(store.startAnalysis(PATH)).toBe('running');
    expect(startCalls()).toBe(1);

    await until(() => store.analysisStatus(PATH).phase === 'done', 'the job to finish');
    expect(startCalls()).toBe(1);
  });

  it('start on an already-cached file reports done at once, with no new job', async () => {
    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    const p = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(() => useMediaUnderstandingStore.getState().transcripts[PATH] !== undefined, 'cached');
    await p;
    const calls = invokeMock.mock.calls.length;

    expect(useMediaUnderstandingStore.getState().startTranscript(PATH)).toBe('done');
    expect(invokeMock.mock.calls.length).toBe(calls);
  });

  it('records a failed background job as an error phase instead of an unhandled rejection', async () => {
    // `startTranscript` deliberately does not await, so without the store's own
    // catch this rejection would escape as an unhandled promise rejection and
    // the poller would just see `running` flip silently back to `idle`.
    scriptJob({ state: 'error', error: 'sidecar unreachable' }, 0);
    const store = useMediaUnderstandingStore.getState();

    store.startTranscript(PATH);
    await until(() => store.transcriptStatus(PATH).phase === 'error', 'the failure to land');
    expect(store.transcriptStatus(PATH).error).toContain('sidecar unreachable');
  });

  it('a later start retries after a failure rather than staying stuck on it', async () => {
    scriptJob({ state: 'error', error: 'sidecar unreachable' }, 0);
    const store = useMediaUnderstandingStore.getState();
    store.startTranscript(PATH);
    await until(() => store.transcriptStatus(PATH).phase === 'error', 'the failure to land');

    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    expect(store.startTranscript(PATH)).toBe('running');
    await until(() => store.transcriptStatus(PATH).phase === 'done', 'the retry to succeed');
    expect(store.transcriptStatus(PATH).result).toEqual(TRANSCRIPT);
  });
});

// --------------------------------------------------------------------------- //
// B-188 / D-321 — the recut detectors' own start-then-poll surface.
//
// The defect this covers is not "the detector is wrong", it is "the detector
// was RIGHT and the answer went nowhere": `editor_detect_silences` ran past its
// caller's 180-second op timeout, finished some minutes later, and had nowhere
// to put the result, so the caller that had already given up could never
// retrieve it. The fix is that the store — not the in-flight promise — is where
// a detection's answer lives, which is exactly what these assert.
// --------------------------------------------------------------------------- //

const SILENCES = {
  source: PATH,
  start_secs: 0,
  duration_secs: 20,
  analysed_secs: 20,
  min_silence_ms: 600,
  model: 'silero_vad_v6.2.1.onnx',
  silences: [{ start_secs: 2, end_secs: 3.5, duration_secs: 1.5 }],
};

const SILENCE_ARGS = { path: PATH, startSecs: 0, durationSecs: 20 };

describe('the detection cache key (D-321)', () => {
  it('separates two clips trimmed from one source, and two thresholds of one clip', () => {
    const a = silenceKey({ path: PATH, startSecs: 0, durationSecs: 20 });
    const b = silenceKey({ path: PATH, startSecs: 20, durationSecs: 20 });
    const c = silenceKey({ path: PATH, startSecs: 0, durationSecs: 20, minSilenceMs: 900 });

    expect(a, 'a different range is a different question').not.toBe(b);
    expect(a, 'so is a different threshold').not.toBe(c);
    expect(silenceKey({ path: PATH, startSecs: 0, durationSecs: 20 }), 'same ask, same key').toBe(a);
  });

  it('defaults the threshold so an omitted 600 and an explicit 600 are one entry', () => {
    expect(silenceKey({ path: PATH, startSecs: 0, durationSecs: 20 })).toBe(
      silenceKey({ path: PATH, startSecs: 0, durationSecs: 20, minSilenceMs: 600 }),
    );
  });

  it('keys retakes on the utterance count, so a run made before the words arrived is not reused', () => {
    const empty = retakeKey({ path: PATH, startSecs: 0, durationSecs: 20, utterances: [] });
    const full = retakeKey({
      path: PATH,
      startSecs: 0,
      durationSecs: 20,
      utterances: [{ start: 0, end: 1, text: 'hello' }],
    });
    expect(empty).not.toBe(full);
  });
});

describe('a detection that outlives the caller waiting on it', () => {
  it('is still retrievable afterwards — the actual B-188 failure', async () => {
    // The detector takes longer than whoever asked is willing to wait.
    let finish: (v: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const store = useMediaUnderstandingStore.getState();

    expect(store.startSilenceDetection(SILENCE_ARGS)).toBe('running');
    const key = silenceKey(SILENCE_ARGS);
    // The caller polls, times out, and gives up right here. Pre-D-321 this is
    // the point past which the answer was unreachable forever.
    expect(store.silenceDetectionStatus(key).phase).toBe('running');

    finish(SILENCES);
    await until(() => store.silenceDetectionStatus(key).phase === 'done', 'the late finish');

    expect(
      store.silenceDetectionStatus(key).result,
      'a later poll finds the answer the timed-out caller never saw',
    ).toEqual(SILENCES);
  });

  it('serves a repeated ask from cache instead of decoding the clip twice', async () => {
    invokeMock.mockResolvedValue(SILENCES);
    const store = useMediaUnderstandingStore.getState();
    await store.detectSilences(SILENCE_ARGS);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await expect(store.detectSilences(SILENCE_ARGS)).resolves.toEqual(SILENCES);
    expect(invokeMock, 'the second ask never reached the detector').toHaveBeenCalledTimes(1);

    await store.detectSilences(SILENCE_ARGS, true);
    expect(invokeMock, 'but force re-runs it').toHaveBeenCalledTimes(2);
  });

  it('reports a failed detection as an error phase, and retries on the next ask', async () => {
    invokeMock.mockRejectedValue(new Error('no audio stream'));
    const store = useMediaUnderstandingStore.getState();
    const key = silenceKey(SILENCE_ARGS);

    store.startSilenceDetection(SILENCE_ARGS);
    await until(() => store.silenceDetectionStatus(key).phase === 'error', 'the failure to land');
    expect(store.silenceDetectionStatus(key).error).toContain('no audio stream');

    invokeMock.mockResolvedValue(SILENCES);
    expect(store.startSilenceDetection(SILENCE_ARGS)).toBe('running');
    await until(() => store.silenceDetectionStatus(key).phase === 'done', 'the retry to succeed');
  });

  it('forgets a file’s detections when that file is cleared, and only that file’s', async () => {
    invokeMock.mockResolvedValue(SILENCES);
    const store = useMediaUnderstandingStore.getState();
    const other = { path: '/clips/take-2.mp4', startSecs: 0, durationSecs: 20 };
    await store.detectSilences(SILENCE_ARGS);
    await store.detectSilences(other);

    store.clear(PATH);

    expect(store.silenceDetectionStatus(silenceKey(SILENCE_ARGS)).phase).toBe('idle');
    expect(
      store.silenceDetectionStatus(silenceKey(other)).phase,
      'the other file is untouched',
    ).toBe('done');
  });
});

describe('client re-reads (D-380 step 2)', () => {
  const W1 = { startSecs: 1, durationSecs: 4 };
  const W2 = { startSecs: 2, durationSecs: 1 };
  const seg = (word: string) => ({ start: 2, end: 2.5, text: word, words: [{ word, start: 2, end: 2.5 }] });

  it('a re-read is a preview until applied, then spliced after the dark recoveries in the order applied', async () => {
    const store = useMediaUnderstandingStore.getState();
    scriptJob({ state: 'done', result: { ...TRANSCRIPT, segments: [seg(' one')] } }, 0);
    store.startReread(PATH, W1, 'en');
    await until(() => store.rereadStatus(recoveryKey(PATH, W1)).phase === 'done', 'the first re-read');
    scriptJob({ state: 'done', result: { ...TRANSCRIPT, segments: [seg(' two')] } }, 0);
    store.startReread(PATH, W2, 'en');
    await until(() => store.rereadStatus(recoveryKey(PATH, W2)).phase === 'done', 'the second re-read');

    expect(store.recoveriesFor(PATH), 'nothing is spliced before apply').toEqual([]);
    expect(store.applyReread(recoveryKey(PATH, W2))).toBe(true);
    expect(store.applyReread(recoveryKey(PATH, W1))).toBe(true);
    expect(store.applyReread('/nope|0|1')).toBe(false);
    expect(store.recoveriesFor(PATH).map((r) => r.window)).toEqual([W2, W1]);
    expect(store.appliedRereadsFor(PATH)).toHaveLength(2);

    // The sidecar was asked for a windowed pass, language pinned.
    expect(invokeMock).toHaveBeenCalledWith('chroma_transcribe', expect.objectContaining({ startSecs: 2, durationSecs: 1, language: 'en' }));

    store.clear(PATH);
    expect(store.recoveriesFor(PATH), 'a cleared file splices nothing').toEqual([]);
  });

  it('holds one proposal set per track and clears it on null', () => {
    const store = useMediaUnderstandingStore.getState();
    const set = { track: 1, viewId: 'v', basisKey: 'k', receivedAt: 0, groups: [] };
    store.setRetakeProposals(1, set);
    expect(useMediaUnderstandingStore.getState().retakeProposals[1]).toEqual(set);
    store.setRetakeProposals(1, null);
    expect(useMediaUnderstandingStore.getState().retakeProposals[1]).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- //
// D-385 — what survives a restart.
//
// A "restart" here is `clear()` (every in-memory map AND the once-per-session
// load bookkeeping gone) with the fake `disk` left as it was — exactly what a
// relaunch looks like to this store. The failure these exist for was seen live
// on C040 (2026-10-14): every launch re-ran Parakeet, and an
// `editor_retranscribe_words apply: true` the client had made was simply gone,
// so the word view everyone indexes into changed size between two runs.
// --------------------------------------------------------------------------- //

describe('persistence across a restart (D-385)', () => {
  const W1 = { startSecs: 1, durationSecs: 4 };
  const W2 = { startSecs: 2, durationSecs: 1 };
  const seg = (word: string) => ({ start: 2, end: 2.5, text: word, words: [{ word, start: 2, end: 2.5 }] });
  /** Whole-file transcription starts only — a windowed re-read is not one. */
  const transcribeStarts = () =>
    invokeMock.mock.calls.filter(
      ([c, a]) => c === 'chroma_transcribe' && (a as { startSecs?: number }).startSecs === undefined,
    ).length;

  /** Transcribe PATH to completion, the way a real first launch does. */
  async function firstLaunchTranscript() {
    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    const p = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(() => disk.has(PATH), 'the transcript to be persisted');
    await p;
  }

  async function applyRereads(...windows: Array<{ startSecs: number; durationSecs: number }>) {
    const store = useMediaUnderstandingStore.getState();
    for (const [i, w] of windows.entries()) {
      scriptJob({ state: 'done', result: { ...TRANSCRIPT, segments: [seg(` r${i}`)] } }, 0);
      store.startReread(PATH, w, 'en');
      await until(() => store.rereadStatus(recoveryKey(PATH, w)).phase === 'done', 're-read');
      expect(store.applyReread(recoveryKey(PATH, w))).toBe(true);
    }
    // Let the persist chain run.
    await vi.advanceTimersByTimeAsync(0);
  }

  function restart() {
    useMediaUnderstandingStore.getState().clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      throw new Error(`the sidecar must not be asked anything here: ${command}`);
    });
  }

  it('a relaunch serves the persisted transcript without running the ASR', async () => {
    await firstLaunchTranscript();
    expect(transcribeStarts()).toBe(1);

    restart();
    const store = useMediaUnderstandingStore.getState();
    expect(store.transcriptStatus(PATH).phase, 'nothing is loaded at startup').toBe('idle');
    await expect(store.getTranscript(PATH)).resolves.toEqual(TRANSCRIPT);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('start-then-poll (the MCP shape) also hydrates instead of transcribing', async () => {
    await firstLaunchTranscript();
    restart();
    const store = useMediaUnderstandingStore.getState();
    expect(store.startTranscript(PATH, { wordTimestamps: true })).toBe('running');
    await until(() => store.transcriptStatus(PATH).phase === 'done', 'the persisted words to land');
    expect(store.transcriptStatus(PATH).result).toEqual(TRANSCRIPT);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('an applied re-read survives the restart, in the order it was applied', async () => {
    await firstLaunchTranscript();
    await applyRereads(W2, W1);
    expect(useMediaUnderstandingStore.getState().recoveriesFor(PATH).map((r) => r.window)).toEqual([W2, W1]);

    restart();
    const store = useMediaUnderstandingStore.getState();
    expect(store.recoveriesFor(PATH), 'not loaded until something asks').toEqual([]);
    await store.getTranscript(PATH);
    const spliced = store.recoveriesFor(PATH);
    expect(spliced.map((r) => r.window), 'same windows, same splice order').toEqual([W2, W1]);
    expect(spliced.map((r) => r.segments[0]?.text)).toEqual([' r0', ' r1']);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a re-read applied after the restart still splices LAST', async () => {
    await firstLaunchTranscript();
    await applyRereads(W1);
    restart();
    await useMediaUnderstandingStore.getState().getTranscript(PATH);

    invokeMock.mockReset();
    await applyRereads(W2);
    expect(useMediaUnderstandingStore.getState().recoveriesFor(PATH).map((r) => r.window)).toEqual([W1, W2]);
    // ...and that new order is what is on disk now.
    expect(parsePersisted(disk.get(PATH))?.appliedRereads.map((r) => r.window)).toEqual([W1, W2]);
  });

  it('a re-read applied before the file was asked about does not clobber the persisted transcript', async () => {
    await firstLaunchTranscript();
    restart();
    invokeMock.mockReset();
    await applyRereads(W1);
    const onDisk = parsePersisted(disk.get(PATH));
    expect(onDisk?.transcript, 'the write loaded the record first').toEqual(TRANSCRIPT);
    expect(onDisk?.appliedRereads).toHaveLength(1);
  });

  it('force re-runs the ASR and overwrites the record, keeping the applied re-reads', async () => {
    await firstLaunchTranscript();
    await applyRereads(W1);
    restart();

    const updated = { ...TRANSCRIPT, text: 'a fresh pass' };
    invokeMock.mockReset();
    scriptJob({ state: 'done', result: updated }, 0);
    const p = useMediaUnderstandingStore.getState().getTranscript(PATH, { force: true });
    await until(
      () => parsePersisted(disk.get(PATH))?.transcript?.text === updated.text,
      'the forced record to be written',
    );
    await expect(p).resolves.toEqual(updated);
    expect(transcribeStarts(), 'force really re-ran').toBe(1);
    expect(parsePersisted(disk.get(PATH))?.appliedRereads.map((r) => r.window)).toEqual([W1]);
  });

  it('persists dark-region recoveries, and serves them after a restart', async () => {
    await firstLaunchTranscript();
    scriptJob({ state: 'done', result: { ...TRANSCRIPT, segments: [seg(' found')] } }, 0);
    useMediaUnderstandingStore.getState().startRecovery(PATH, W1, 'en');
    await until(
      () => (parsePersisted(disk.get(PATH))?.recoveries.length ?? 0) === 1,
      'the recovery to be persisted',
    );

    restart();
    await useMediaUnderstandingStore.getState().getTranscript(PATH);
    expect(useMediaUnderstandingStore.getState().recoveryStatus(recoveryKey(PATH, W1)).phase).toBe('done');
  });

  it('hydrate is disk-only, once per file, and never overrides what memory already has', async () => {
    disk.set(PATH, { transcript: { ...TRANSCRIPT, text: 'stale disk' }, recoveries: [], appliedRereads: [] });
    useMediaUnderstandingStore.setState((s) => ({ transcripts: { ...s.transcripts, [PATH]: TRANSCRIPT } }));
    const store = useMediaUnderstandingStore.getState();
    await store.hydrate(PATH);
    await store.hydrate(PATH);
    expect(diskMock.mock.calls.filter(([c]) => c === 'chroma_media_understanding_load')).toHaveLength(1);
    expect(useMediaUnderstandingStore.getState().transcripts[PATH]?.text).toBe(TRANSCRIPT.text);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a failed read is a miss — the ASR runs exactly as it did before persistence', async () => {
    diskMock.mockImplementationOnce(() => Promise.reject(new Error('disk on fire')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scriptJob({ state: 'done', result: TRANSCRIPT }, 0);
    const p = useMediaUnderstandingStore.getState().getTranscript(PATH);
    await until(() => useMediaUnderstandingStore.getState().transcripts[PATH] !== undefined, 'the ASR result');
    await expect(p).resolves.toEqual(TRANSCRIPT);
    expect(transcribeStarts()).toBe(1);
    warn.mockRestore();
  });

  it('parsePersisted keeps the good parts of a damaged record and calls an empty one a miss', () => {
    const good = { window: W1, segments: [] };
    expect(parsePersisted(null)).toBeNull();
    expect(parsePersisted({ transcript: null, recoveries: [], appliedRereads: [] })).toBeNull();
    expect(
      parsePersisted({ transcript: { nope: 1 }, recoveries: [good, { window: 'x' }], appliedRereads: 'bad' }),
    ).toEqual({ transcript: null, recoveries: [good], appliedRereads: [] });
  });
});
