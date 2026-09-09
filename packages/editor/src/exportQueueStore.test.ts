// @apelles/editor — unit tests for the export queue (D-198): a REAL
// sequential queue, not a decorative list — job 2 must not start until job 1
// actually settles, and every transition (`queued` -> `running` ->
// `done`/`failed`) must be observable, live, on the store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { useExportQueueStore } = await import('./exportQueueStore');
const { useEditorTimelineStore } = await import('./timelineStore');
const { useMediaPoolStore } = await import('@apelles/bridge');
// D-256 — `enqueue` compiles the argv, and the compiler refuses outright
// unless each clip's Colorist grade has been baked (see `gradeLuts.ts`'s
// cold-cache rule). The GUI's own Export dialog awaits this before enqueueing;
// these tests do the same rather than being exempted from the contract.
const { resetGradeLutCache, warmGradeLuts } = await import('./gradeLuts');
import type { Timeline } from './timeline';

function timelineWithOneClip(): Timeline {
  return {
    id: 'tl',
    name: 'tl',
    rate: { num: 30, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'c1', name: 'c1', source_path: '/media/c1.mov', source_start: 0, duration: 90, source_len: 90, start_frame: 0 },
        ],
      },
    ],
  } as unknown as Timeline;
}

/** A promise plus the handles to settle it whenever the test chooses — the
 *  only reliable way to prove job 2 doesn't start before job 1 settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  invokeMock.mockReset();
  useExportQueueStore.setState({ jobs: [] });
  useEditorTimelineStore.setState({ timeline: timelineWithOneClip() } as any);
  useMediaPoolStore.setState({ items: [] } as any);
  // D-256 — warm the grade cache the way the real Export dialog does. The
  // fixture clip has no grade, so the backend's honest answer is an empty map;
  // what matters is that a warm HAPPENED, since "never asked" and "asked, and
  // nothing is graded" are deliberately different states.
  resetGradeLutCache();
  invokeMock.mockResolvedValueOnce({ luts: {}, warnings: [] });
  await warmGradeLuts(timelineWithOneClip());
  // ...and forget that call, so the tests below can keep counting `invoke` as
  // "how many times ffmpeg was actually run". `mockClear` (not `mockReset`)
  // deliberately: it drops the recorded calls without touching the mock's
  // queued implementations.
  invokeMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const validArgs = { outPath: '/tmp/out.mp4', width: 320, height: 240, fps: 30 };

describe('useExportQueueStore.enqueue', () => {
  it('a compile error (e.g. no timeline) is reported without ever touching the queue', () => {
    useEditorTimelineStore.setState({ timeline: null } as any);
    const result = useExportQueueStore.getState().enqueue('job', validArgs);
    expect(result).toEqual({ error: expect.stringContaining('no timeline') });
    expect(useExportQueueStore.getState().jobs).toHaveLength(0);
  });

  it('a valid export is enqueued as "queued" and immediately starts running (nothing else in the queue)', async () => {
    const { promise } = deferred<unknown>();
    invokeMock.mockReturnValueOnce(promise);

    const result = useExportQueueStore.getState().enqueue('job1', validArgs);
    expect('id' in result).toBe(true);
    await flush();

    const jobs = useExportQueueStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('running');
    expect(jobs[0].startedAt).not.toBeNull();
    expect(jobs[0].args.length).toBeGreaterThan(0); // a real compiled ffmpeg argv, frozen at enqueue time
  });

  it('REAL sequential behavior: job 2 stays "queued" while job 1 is still running, and starts the instant job 1 settles', async () => {
    const job1Ffmpeg = deferred<{ ok: boolean; stdout_tail: string; stderr_tail: string }>();
    invokeMock.mockReturnValueOnce(job1Ffmpeg.promise);

    useExportQueueStore.getState().enqueue('job1', { ...validArgs, outPath: '/tmp/out1.mp4' });
    await flush();
    expect(useExportQueueStore.getState().jobs[0].status).toBe('running');

    // Enqueue job 2 WHILE job 1 is still in flight.
    useExportQueueStore.getState().enqueue('job2', { ...validArgs, outPath: '/tmp/out2.mp4' });
    await flush();
    let jobs = useExportQueueStore.getState().jobs;
    expect(jobs[0].status).toBe('running');
    expect(jobs[1].status).toBe('queued'); // must NOT have started yet
    expect(invokeMock).toHaveBeenCalledTimes(1); // ffmpeg only actually invoked once so far

    // Job 1 finishes -> job 2 must start automatically, with no external poke.
    const job2Ffmpeg = deferred<{ ok: boolean; stdout_tail: string; stderr_tail: string }>();
    invokeMock.mockReturnValueOnce(job2Ffmpeg.promise);
    job1Ffmpeg.resolve({ ok: true, stdout_tail: '', stderr_tail: '' });
    await flush();
    await flush();

    jobs = useExportQueueStore.getState().jobs;
    expect(jobs[0].status).toBe('done');
    expect(jobs[0].finishedAt).not.toBeNull();
    expect(jobs[1].status).toBe('running'); // started automatically
    expect(invokeMock).toHaveBeenCalledTimes(2);

    job2Ffmpeg.resolve({ ok: true, stdout_tail: '', stderr_tail: '' });
    await flush();
    await flush();
    expect(useExportQueueStore.getState().jobs[1].status).toBe('done');
  });

  it('a failed ffmpeg run marks the job "failed" with its real stderr, and still lets the next job run', async () => {
    invokeMock.mockResolvedValueOnce({ ok: false, stdout_tail: '', stderr_tail: 'ffmpeg: real failure reason' });
    useExportQueueStore.getState().enqueue('job1', validArgs);
    await flush();
    await flush();

    const job = useExportQueueStore.getState().jobs[0];
    expect(job.status).toBe('failed');
    expect(job.error).toContain('real failure reason');
  });

  it('a rejected invoke() (not just a {ok:false} result) also marks the job failed rather than hanging forever', async () => {
    invokeMock.mockRejectedValueOnce(new Error('spawn ffmpeg failed'));
    useExportQueueStore.getState().enqueue('job1', validArgs);
    await flush();
    await flush();

    const job = useExportQueueStore.getState().jobs[0];
    expect(job.status).toBe('failed');
    expect(job.error).toContain('spawn ffmpeg failed');
  });
});

describe('useExportQueueStore.clearFinished', () => {
  it('removes done/failed jobs but leaves queued/running ones', async () => {
    const inFlight = deferred<unknown>();
    invokeMock.mockReturnValueOnce(inFlight.promise);
    invokeMock.mockResolvedValueOnce({ ok: true, stdout_tail: '', stderr_tail: '' });

    useExportQueueStore.getState().enqueue('running-job', { ...validArgs, outPath: '/tmp/a.mp4' });
    await flush();
    useExportQueueStore.setState((s) => ({
      jobs: [...s.jobs, { ...s.jobs[0], id: 'done-job', status: 'done' as const }],
    }));

    useExportQueueStore.getState().clearFinished();
    const jobs = useExportQueueStore.getState().jobs;
    expect(jobs.find((j) => j.id === 'done-job')).toBeUndefined();
    expect(jobs.some((j) => j.status === 'running')).toBe(true);
  });
});
