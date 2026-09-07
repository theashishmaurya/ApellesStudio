// @chroma/editor — unit tests for the media-understanding store (D-189).
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
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { useMediaUnderstandingStore } = await import('./mediaUnderstandingStore');

const PATH = '/clips/take-1.mp4';

const TRANSCRIPT = {
  text: 'hello there',
  language: 'en',
  model: 'large-v3',
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
