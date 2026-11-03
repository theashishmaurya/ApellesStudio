// @apelles/editor — B-335: every export is its own queue job, from `editor_export`
// through `editor_export_status` to the result. A second export while one runs
// must queue behind it under its own id and report ITS output — never the
// first job's.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Timeline } from './timeline';

const LONG: Timeline = {
  id: 'long',
  name: 'Long-form',
  rate: { num: 24, den: 1 },
  tracks: [
    {
      kind: 'video',
      clips: [{ id: 'l1', name: 'talk', source_path: '/media/long-source.mov', source_start: 0, duration: 240, source_len: 480, source_fps: 24, start_frame: 0 }],
    },
  ],
};

type RenderOutcome = { ok: boolean; frames: number; segments: number; ms: number; stderr_tail: string };
const gate = vi.hoisted(() => ({ pending: [] as Array<(o: unknown) => void> }));

const invokeMock = vi.hoisted(() =>
  vi.fn(async (cmd: string): Promise<unknown> => {
    switch (cmd) {
      case 'chroma_timeline_set':
        return null;
      case 'chroma_text_fonts':
        return [];
      case 'chroma_timeline_grade_luts':
        return { graded: [], warnings: [] };
      case 'chroma_timeline_composition_size':
        return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
      case 'chroma_unused_export_path':
        return '/Users/me/Movies/Five Levels/Long-form.mov';
      case 'chroma_editor_export_status':
        return { state: 'idle', jobId: 0 };
      case 'chroma_render_timeline_export':
        // Held open until the test releases it, so "a job is running" is a fact.
        return await new Promise((resolve) => gate.pending.push(resolve));
      default:
        throw new Error(`no stub for ${cmd}`);
    }
  }),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/path', () => ({ videoDir: () => Promise.resolve('/Users/me/Movies') }));

const { runQueuedEditorExport, exportJobStatus, cancelExportJob } = await import('./exportJobs');
const { useEditorTimelineStore } = await import('./timelineStore');
const { useExportQueueStore } = await import('./exportQueueStore');
const { useMediaPoolStore } = await import('@apelles/bridge');

const finish = (ok: boolean, stderr = '') => {
  const resolve = gate.pending.shift();
  if (!resolve) throw new Error('no render is waiting');
  resolve({ ok, frames: 1, segments: 1, ms: 1, stderr_tail: stderr } satisfies RenderOutcome);
};

beforeEach(() => {
  invokeMock.mockClear();
  gate.pending.length = 0;
  useMediaPoolStore.setState({ items: [] });
  useEditorTimelineStore.setState({ timeline: structuredClone(LONG), error: null });
  useExportQueueStore.setState({ jobs: [] });
});

describe('editor_export jobs (B-335)', () => {
  it('two exports queued back to back report distinct ids and each its OWN output', async () => {
    const first = runQueuedEditorExport({ outPath: '/tmp/one-1080.mp4', jobId: 'job-one' });
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1)); // job one is running
    const second = runQueuedEditorExport({ outPath: '/tmp/two-4k.mp4', width: 3840, height: 2160, jobId: 'job-two' });
    await vi.waitFor(() => expect(useExportQueueStore.getState().jobs).toHaveLength(2));

    // The second waits its turn: queued, behind one, naming its own file.
    expect(exportJobStatus({ job_id: 'job-one' })).toMatchObject({ jobId: 'job-one', state: 'running', outPath: '/tmp/one-1080.mp4' });
    expect(exportJobStatus({ job_id: 'job-two' })).toMatchObject({
      jobId: 'job-two',
      state: 'queued',
      queuePosition: 1,
      ahead: 1,
      outPath: '/tmp/two-4k.mp4',
    });
    expect(gate.pending).toHaveLength(1); // only job one has started

    finish(true);
    const r1 = await first;
    expect(r1).toMatchObject({ ok: true, jobId: 'job-one', outPath: '/tmp/one-1080.mp4' });

    await vi.waitFor(() => expect(gate.pending).toHaveLength(1)); // job two starts when one settles
    finish(false, 'encoder exploded');
    const r2 = await second;
    expect(r2).toMatchObject({ ok: false, jobId: 'job-two', outPath: '/tmp/two-4k.mp4', width: 3840, height: 2160 });
    expect('error' in r2 ? r2.error : null).toContain('encoder exploded');

    // Each id still answers for itself afterwards.
    expect(exportJobStatus({ job_id: 'job-one' })).toMatchObject({ state: 'done', outPath: '/tmp/one-1080.mp4', error: null });
    expect(exportJobStatus({ job_id: 'job-two' })).toMatchObject({ state: 'failed', outPath: '/tmp/two-4k.mp4' });
  });

  it('makes an id when the caller gives none, and the result carries it', async () => {
    const run = runQueuedEditorExport({ outPath: '/tmp/auto.mp4' });
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1));
    finish(true);
    const result = await run;
    if ('error' in result && !('jobId' in result)) throw new Error(result.error);
    expect(result).toMatchObject({ ok: true, outPath: '/tmp/auto.mp4' });
    expect((result as { jobId: string }).jobId).toMatch(/^export-/);
  });

  it('refuses a reused id and an unknown id, in words, without touching the queue', async () => {
    const run = runQueuedEditorExport({ outPath: '/tmp/a.mp4', jobId: 'dup' });
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1));
    const again = await runQueuedEditorExport({ outPath: '/tmp/b.mp4', jobId: 'dup' });
    expect('error' in again ? again.error : '').toMatch(/already exists/);
    expect(useExportQueueStore.getState().jobs).toHaveLength(1);
    expect(exportJobStatus({ job_id: 'nope' })).toMatchObject({ error: expect.stringContaining('no export job with id "nope"') });
    finish(true);
    await run;
  });

  it('a compile error comes back at once and leaves no job behind', async () => {
    const bad = await runQueuedEditorExport({ outPath: '/tmp/half.mp4', width: 1280 });
    expect('error' in bad ? bad.error : '').toMatch(/both width and height, or neither/);
    expect(useExportQueueStore.getState().jobs).toHaveLength(0);
  });
});

// D-441 — `preset`, the default `outPath` and `editor_cancel_export`.
describe('editor_export preset, default output and cancel (D-441)', () => {
  it('a preset fills the job, and an omitted outPath becomes ~/Movies/<project>/<timeline>.<ext>', async () => {
    useEditorTimelineStore.setState({ openProjectKey: '/Users/me/Projects/Five Levels.apelles' });
    const done = runQueuedEditorExport({ preset: 'master', jobId: 'job-master' });
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith('chroma_unused_export_path', {
      dir: '/Users/me/Movies/Five Levels',
      stem: 'Long-form',
      ext: 'mov',
    });
    const job = useExportQueueStore.getState().jobs[0];
    expect(job).toMatchObject({ id: 'job-master', outPath: '/Users/me/Movies/Five Levels/Long-form.mov', format: 'prores_hq', preset: 'Master' });
    expect(job.render.format).toBe('prores_hq'); // D-452: encoded in process; the argv only remuxes
    finish(true);
    expect(await done).toMatchObject({ jobId: 'job-master', ok: true });
  });

  it('cancels a queued job by id, and refuses an unknown id in words', async () => {
    const first = runQueuedEditorExport({ outPath: '/tmp/a.mp4', jobId: 'job-a' });
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1));
    const second = runQueuedEditorExport({ outPath: '/tmp/b.mp4', jobId: 'job-b' });
    await vi.waitFor(() => expect(useExportQueueStore.getState().jobs).toHaveLength(2));
    expect(await cancelExportJob({ job_id: 'job-b' })).toMatchObject({ ok: true, jobId: 'job-b', wasRunning: false });
    expect(await second).toMatchObject({ jobId: 'job-b', ok: false, cancelled: true });
    expect(exportJobStatus({ job_id: 'job-b' })).toMatchObject({ state: 'cancelled' });
    expect(await cancelExportJob({ job_id: 'nope' })).toEqual({ error: expect.stringContaining('no export job') });
    expect(await cancelExportJob({})).toEqual({ error: expect.stringContaining('job_id is required') });
    finish(true);
    await first;
  });
});
