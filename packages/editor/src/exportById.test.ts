// @apelles/editor — D-411 Phase 0: export a timeline by id, without switching.
//
// A 16:9 long-form is the open timeline; a 9:16 short (its own `output`,
// 1080×1920) is not. `editor_export(timeline_id="short")` must compile FROM the
// short (its clips, read by id), size the export at the short's own frame when
// no size is passed, and tell the compositor to render the short — not the
// open timeline. The queue must carry the same id, so a job queued for the
// short still renders the short after the person switches timelines. The fake
// backend answers like `chroma::edit` would.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Timeline } from './timeline';

const backend = vi.hoisted(() => ({
  calls: [] as { cmd: string; args?: Record<string, unknown> }[],
}));

const SHORT: Timeline = {
  id: 'short',
  name: 'Short 1',
  rate: { num: 24, den: 1 },
  output: { width: 1080, height: 1920 },
  tracks: [
    {
      kind: 'video',
      clips: [{ id: 's1', name: 'hook', source_path: '/media/short-source.mov', source_start: 24, duration: 48, source_len: 480, source_fps: 24, start_frame: 0 }],
    },
  ],
};

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

const invokeMock = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    backend.calls.push({ cmd, args });
    switch (cmd) {
      case 'chroma_timeline_set':
        return null;
      case 'chroma_text_fonts':
        return [];
      case 'chroma_timeline_grade_luts':
        return { luts: {}, warnings: [] };
      case 'chroma_timeline_get_by_id': {
        const id = args?.id;
        if (id === 'short') return structuredClone(SHORT);
        if (id === 'long') return structuredClone(LONG);
        throw new Error(`no timeline with id ${String(id)}`);
      }
      case 'chroma_timeline_composition_size': {
        // The real resolver: the timeline's own `output`, else the project's 1920×1080.
        const short = args?.timelineId === 'short';
        return { compWidth: short ? 1080 : 1920, compHeight: short ? 1920 : 1080, naturalWidth: 1, naturalHeight: 1 };
      }
      case 'chroma_render_timeline_export':
        return { ok: true, frames: 48, segments: 1, ms: 1, stderr_tail: '' };
      case 'chroma_editor_export_status':
        return { state: 'idle', jobId: 0, framesTotal: 0, framesWritten: 0, percent: 0, segmentsTotal: 0, segmentsDone: 0, segments: [] };
      case 'chroma_run_ffmpeg':
        return { ok: true, stdout_tail: '', stderr_tail: '' };
      default:
        throw new Error(`no stub for ${cmd}`);
    }
  }),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const { runEditorExport, prepareEditorExport } = await import('./editorExport');
const { useEditorTimelineStore } = await import('./timelineStore');
const { useExportQueueStore } = await import('./exportQueueStore');
const { useMediaPoolStore } = await import('@apelles/bridge');

const lastCall = (cmd: string) => [...backend.calls].reverse().find((c) => c.cmd === cmd);

beforeEach(() => {
  invokeMock.mockClear();
  backend.calls.length = 0;
  useMediaPoolStore.setState({ items: [] });
  useEditorTimelineStore.setState({ timeline: structuredClone(LONG), error: null });
  useExportQueueStore.setState({ jobs: [] });
});

describe('editor_export(timeline_id) — D-411 Phase 0', () => {
  it('renders the named timeline at its own size, without switching the view', async () => {
    const result = await runEditorExport({ outPath: '/tmp/short.mp4', timelineId: 'short', renderer: 'compositor' });
    if (!('ok' in result)) throw new Error(result.error);
    expect(result).toMatchObject({ ok: true, timelineId: 'short', width: 1080, height: 1920 });

    const req = lastCall('chroma_render_timeline_export')?.args?.req as Record<string, unknown>;
    expect(req).toMatchObject({ width: 1080, height: 1920, timelineId: 'short', frames: 48 });
    // Sized against the short's own frame…
    expect(lastCall('chroma_timeline_composition_size')?.args).toEqual({ timelineId: 'short' });
    // …and the open timeline never changed.
    expect(useEditorTimelineStore.getState().timeline?.id).toBe('long');
  });

  it('compiles the named timeline’s clips, not the open one’s (filter path)', async () => {
    const result = await runEditorExport({ outPath: '/tmp/short.mp4', timelineId: 'short' });
    if (!('ok' in result)) throw new Error(result.error);
    const argv = (lastCall('chroma_run_ffmpeg')?.args?.args as string[]).join(' ');
    expect(argv).toContain('/media/short-source.mov');
    expect(argv).not.toContain('/media/long-source.mov');
    expect(argv).toContain('1080x1920');
  });

  it('still exports the open timeline when no id is given, and an explicit size still wins', async () => {
    const result = await runEditorExport({ outPath: '/tmp/long.mp4', width: 1280, height: 720, renderer: 'compositor' });
    if (!('ok' in result)) throw new Error(result.error);
    const req = lastCall('chroma_render_timeline_export')?.args?.req as Record<string, unknown>;
    // The compiled timeline's id rides along even for the active one, so a
    // queued job cannot render a different timeline after a switch.
    expect(req).toMatchObject({ width: 1280, height: 720, timelineId: 'long' });
  });

  it('refuses an unknown id and a half-given size, in words', async () => {
    const unknown = await runEditorExport({ outPath: '/tmp/x.mp4', timelineId: 'nope' });
    expect('error' in unknown ? unknown.error : null).toMatch(/no timeline with id nope/);
    const half = await runEditorExport({ outPath: '/tmp/x.mp4', timelineId: 'short', width: 1080 });
    expect('error' in half ? half.error : null).toMatch(/both width and height, or neither/);
  });

  it('a queued job carries the id it was compiled for', async () => {
    const args = { outPath: '/tmp/short-q.mp4', timelineId: 'short', renderer: 'compositor' };
    const prepared = await prepareEditorExport(args);
    if ('error' in prepared) throw new Error(prepared.error);
    expect(prepared.timeline.id).toBe('short');
    const queued = useExportQueueStore.getState().enqueue('short', args, prepared.timeline);
    expect('id' in queued).toBe(true);
    expect(useExportQueueStore.getState().jobs[0]).toMatchObject({ timelineId: 'short' });
    await vi.waitFor(() => expect(useExportQueueStore.getState().jobs[0].status).toBe('done'));
    const req = lastCall('chroma_render_timeline_export')?.args?.req as Record<string, unknown>;
    expect(req.timelineId).toBe('short');
  });
});
