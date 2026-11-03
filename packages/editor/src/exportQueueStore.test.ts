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
// D-256 — the grade pre-flight the GUI's own Export dialog runs before it
// enqueues; these tests do the same.
const { warmGradeLuts } = await import('./gradeLuts');
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

/** D-448 — every job is a compositor render. What each render the backend is
 *  asked for answers, in order (a thunk, so a rejection is made only when it is
 *  asked for); status reads answer "idle", so the progress follower has nothing
 *  to believe. */
let renders: Array<() => Promise<unknown>> = [];
const renderWith = (v: unknown) => renders.push(() => (v instanceof Promise ? v : Promise.resolve(v)));
const renderCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'chroma_render_timeline_export');
function routeBackend() {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'chroma_editor_export_status') return Promise.resolve({ state: 'idle', jobId: 0 });
    if (cmd === 'chroma_render_timeline_export') return (renders.shift() ?? (() => new Promise(() => {})))();
    if (cmd === 'chroma_cancel_editor_export') return Promise.resolve({ wasRunning: true });
    return Promise.resolve(undefined);
  });
}

beforeEach(async () => {
  invokeMock.mockReset();
  useExportQueueStore.setState({ jobs: [] });
  useEditorTimelineStore.setState({ timeline: timelineWithOneClip() } as any);
  useMediaPoolStore.setState({ items: [] } as any);
  // D-256 — the grade pre-flight the real Export dialog runs. The fixture clip
  // has no grade, so the backend's honest answer is an empty list.
  renderWith({ graded: [], warnings: [] });
  await warmGradeLuts(timelineWithOneClip());
  // ...and forget that call, so the tests below can keep counting `invoke` as
  // "how many times ffmpeg was actually run". `mockClear` (not `mockReset`)
  // deliberately: it drops the recorded calls without touching the mock's
  // queued implementations.
  invokeMock.mockClear();
  renders = [];
  routeBackend();
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
    renderWith(promise);

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
    renderWith(job1Ffmpeg.promise);

    useExportQueueStore.getState().enqueue('job1', { ...validArgs, outPath: '/tmp/out1.mp4' });
    await flush();
    expect(useExportQueueStore.getState().jobs[0].status).toBe('running');

    // Enqueue job 2 WHILE job 1 is still in flight.
    useExportQueueStore.getState().enqueue('job2', { ...validArgs, outPath: '/tmp/out2.mp4' });
    await flush();
    let jobs = useExportQueueStore.getState().jobs;
    expect(jobs[0].status).toBe('running');
    expect(jobs[1].status).toBe('queued'); // must NOT have started yet
    expect(renderCalls()).toHaveLength(1); // only one render started so far

    // Job 1 finishes -> job 2 must start automatically, with no external poke.
    const job2Ffmpeg = deferred<{ ok: boolean; stdout_tail: string; stderr_tail: string }>();
    renderWith(job2Ffmpeg.promise);
    job1Ffmpeg.resolve({ ok: true, stdout_tail: '', stderr_tail: '' });
    await flush();
    await flush();

    jobs = useExportQueueStore.getState().jobs;
    expect(jobs[0].status).toBe('done');
    expect(jobs[0].finishedAt).not.toBeNull();
    expect(jobs[1].status).toBe('running'); // started automatically
    expect(renderCalls()).toHaveLength(2);

    job2Ffmpeg.resolve({ ok: true, stdout_tail: '', stderr_tail: '' });
    await flush();
    await flush();
    expect(useExportQueueStore.getState().jobs[1].status).toBe('done');
  });

  it('a failed render marks the job "failed" with its real stderr, and still lets the next job run', async () => {
    renderWith({ ok: false, stdout_tail: '', stderr_tail: 'ffmpeg: real failure reason' });
    useExportQueueStore.getState().enqueue('job1', validArgs);
    await flush();
    await flush();

    const job = useExportQueueStore.getState().jobs[0];
    expect(job.status).toBe('failed');
    expect(job.error).toContain('real failure reason');
  });

  it('a rejected invoke() (not just a {ok:false} result) also marks the job failed rather than hanging forever', async () => {
    renders.push(() => Promise.reject(new Error('the render failed to start')));
    useExportQueueStore.getState().enqueue('job1', validArgs);
    await flush();
    await flush();

    const job = useExportQueueStore.getState().jobs[0];
    expect(job.status).toBe('failed');
    expect(job.error).toContain('the render failed to start');
  });
});

// D-362 (fixes B-231) — a running compositor job carries the renderer's own
// live progress, polled from `chroma_editor_export_status`.
describe('a compositor job follows the render\'s real progress', () => {

  /** `{state, jobId, …}` as `chroma::export_status::ExportStatus` serialises. */
  function status(state: string, jobId: number, extra: Record<string, unknown> = {}) {
    return {
      state,
      jobId,
      framesTotal: 200,
      framesWritten: 0,
      percent: 0,
      segmentsTotal: 4,
      segmentsDone: 0,
      segments: [],
      elapsedMs: 0,
      stallTimeoutSecs: 120,
      note: '',
      ...extra,
    };
  }

  it('shows the live percentage while it renders, and drops it the moment the job settles', async () => {
    vi.useFakeTimers();
    try {
      const render = deferred<{ ok: boolean; frames: number; segments: number; ms: number; stderr_tail: string }>();
      // The slot still holds the PREVIOUS export (jobId 7, already done) when
      // the baseline is read — which is exactly the trap the guard exists for.
      const statuses = [
        status('done', 7),
        status('running', 8, { framesWritten: 85, percent: 42.5, segmentsDone: 1, phase: 'rendering' }),
        // A stale read of the old job must NOT paint over the new one.
        status('done', 7),
        status('running', 8, { framesWritten: 150, percent: 75, segmentsDone: 2, phase: 'rendering' }),
      ];
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === 'chroma_editor_export_status') return Promise.resolve(statuses.shift() ?? status('running', 8));
        if (cmd === 'chroma_render_timeline_export') return render.promise;
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });

      useExportQueueStore.getState().enqueue('job1', validArgs);
      await vi.advanceTimersByTimeAsync(0);
      const running = useExportQueueStore.getState().jobs[0];
      expect(running.status).toBe('running');
      expect(running.render).toBeDefined(); // it really compiled for the render path
      expect(running.progress).toBeNull(); // nothing believed before the first poll

      await vi.advanceTimersByTimeAsync(500);
      expect(useExportQueueStore.getState().jobs[0].progress).toMatchObject({
        jobId: 8,
        percent: 42.5,
        framesWritten: 85,
        segmentsDone: 1,
      });

      // The stale `jobId: 7` read lands next — the previous export's result,
      // which would otherwise report this job as 100% done before it is.
      await vi.advanceTimersByTimeAsync(500);
      expect(useExportQueueStore.getState().jobs[0].progress).toMatchObject({ jobId: 8, percent: 42.5 });

      await vi.advanceTimersByTimeAsync(500);
      expect(useExportQueueStore.getState().jobs[0].progress).toMatchObject({ jobId: 8, percent: 75 });

      render.resolve({ ok: true, frames: 200, segments: 4, ms: 1234, stderr_tail: '' });
      await vi.advanceTimersByTimeAsync(0);
      const done = useExportQueueStore.getState().jobs[0];
      expect(done.status).toBe('done');
      expect(done.progress).toBeNull(); // the poller stopped and cleaned up

      // And it really did stop: no further status reads after the job settled.
      const after = invokeMock.mock.calls.filter((c) => c[0] === 'chroma_editor_export_status').length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(invokeMock.mock.calls.filter((c) => c[0] === 'chroma_editor_export_status')).toHaveLength(after);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useExportQueueStore.clearFinished', () => {
  it('removes done/failed jobs but leaves queued/running ones', async () => {
    const inFlight = deferred<unknown>();
    renderWith(inFlight.promise);
    renderWith({ ok: true, stdout_tail: '', stderr_tail: '' });

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

// D-441 — Cancel and Try again, and the ProRes master's argv.
describe('cancel, retry and the ProRes format (D-441)', () => {
  it('cancelling a queued job takes it out of the line without touching the backend', async () => {
    const first = deferred<unknown>();
    renderWith(first.promise);
    useExportQueueStore.getState().enqueue('job1', validArgs);
    const second = useExportQueueStore.getState().enqueue('job2', { ...validArgs, outPath: '/tmp/two.mp4' });
    await flush();
    const id = 'id' in second ? second.id : '';
    const out = await useExportQueueStore.getState().cancel(id);
    expect(out).toEqual({ ok: true, wasRunning: false });
    expect(useExportQueueStore.getState().jobs.find((j) => j.id === id)?.status).toBe('cancelled');
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'chroma_cancel_editor_export')).toHaveLength(0);
    // And it never runs once job 1 settles.
    first.resolve({ ok: true, cancelled: false, stdout_tail: '', stderr_tail: '' });
    await flush();
    await flush();
    expect(renderCalls()).toHaveLength(1);
  });

  it('cancelling a running job asks the backend under the job id, and the run settles it "cancelled"', async () => {
    const run = deferred<unknown>();
    renderWith(run.promise);
    const queued = useExportQueueStore.getState().enqueue('job1', validArgs);
    const id = 'id' in queued ? queued.id : '';
    await flush();
    const runCall = renderCalls()[0];
    expect(runCall?.[1]).toMatchObject({ req: { output: '/tmp/out.mp4', cancelToken: id } });
    const out = await useExportQueueStore.getState().cancel(id);
    expect(out).toEqual({ ok: true, wasRunning: true });
    expect(invokeMock).toHaveBeenCalledWith('chroma_cancel_editor_export', { token: id });
    // The backend kills the encoders; the render comes back cancelled.
    run.resolve({ ok: false, cancelled: true, stdout_tail: '', stderr_tail: 'the export was cancelled' });
    await flush();
    await flush();
    expect(useExportQueueStore.getState().jobs[0].status).toBe('cancelled');
  });

  it('a finished job cannot be cancelled, and Try again queues its frozen argv as a new job', async () => {
    renderWith({ ok: false, cancelled: false, stdout_tail: '', stderr_tail: 'disk full' });
    const queued = useExportQueueStore.getState().enqueue('job1', validArgs);
    const id = 'id' in queued ? queued.id : '';
    await flush();
    await flush();
    expect(useExportQueueStore.getState().jobs[0].status).toBe('failed');
    expect(await useExportQueueStore.getState().cancel(id)).toEqual({ error: expect.stringContaining('already failed') });
    renderWith({ ok: true, cancelled: false, stdout_tail: '', stderr_tail: '' });
    const again = useExportQueueStore.getState().retry(id);
    expect('id' in again && again.id !== id).toBe(true);
    await flush();
    await flush();
    const jobs = useExportQueueStore.getState().jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs[1].args).toEqual(jobs[0].args);
    expect(jobs[1].status).toBe('done');
    expect(useExportQueueStore.getState().retry(jobs[1].id)).toEqual({ error: expect.stringContaining('only a failed or cancelled') });
  });

  it('the ProRes master is a .mov with PCM sound, an .mp4 is refused, and D-446\'s encoder is refused by name', () => {
    const ok = useExportQueueStore.getState().enqueue('master', { ...validArgs, outPath: '/tmp/master.mov', format: 'prores_hq' });
    expect('id' in ok).toBe(true);
    const job = useExportQueueStore.getState().jobs[0];
    expect(job.format).toBe('prores_hq');
    expect(job.render?.format).toBe('prores_hq');
    const argv = job.args.join(' ');
    // D-452 — the remux copies the picture the app encoded; no ffmpeg encoder.
    expect(argv).toContain('-c:v copy');
    expect(argv).not.toContain('prores_ks');
    expect(job.args[job.args.length - 1]).toBe('/tmp/master.mov');
    const sw = useExportQueueStore
      .getState()
      .enqueue('master sw', { ...validArgs, outPath: '/tmp/master2.mov', format: 'prores_hq', encoder: 'software' });
    expect(sw).toMatchObject({ error: expect.stringContaining('encoder was removed') });
    const bad = useExportQueueStore.getState().enqueue('master', { ...validArgs, outPath: '/tmp/master.mp4', format: 'prores_hq' });
    expect(bad).toEqual({ error: expect.stringContaining('.mov') });
  });
});
