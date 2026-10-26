// @apelles/editor — B-276: an export settles the timeline save it is owed
// before any backend command that reads the PERSISTED timeline.
//
// `composition_size` and the compositor render both read `project.json`, while
// `applyOp` persists ~400 ms after changing the store. An agent that places a
// still and exports straight away used to have the export sized (and rendered)
// from the document as it was before the still: on a fresh project, "no clip to
// derive a composition size from". The fake backend here answers exactly as the
// real one would from whatever it was last sent.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  calls: [] as string[],
  persisted: null as unknown,
  failSave: false,
}));

const invokeMock = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    backend.calls.push(cmd);
    switch (cmd) {
      case 'chroma_timeline_set':
        if (backend.failSave) throw new Error('disk full');
        backend.persisted = args?.timeline;
        return null;
      case 'chroma_text_fonts':
        return [];
      case 'chroma_timeline_grade_luts':
        return { luts: {}, warnings: [] };
      case 'chroma_timeline_composition_size': {
        // The real command's reading: the project has no settings, so the size
        // comes from a still on a video track, if the PERSISTED timeline has one.
        const tl = backend.persisted as { tracks: { kind: string; clips: { source_path: string }[] }[] } | null;
        const still = tl?.tracks.some((t) => t.kind === 'video' && t.clips.some((c) => c.source_path.endsWith('.png')));
        if (!still) throw new Error('this project has no frame size yet');
        return { compWidth: 1280, compHeight: 720, naturalWidth: 1, naturalHeight: 1 };
      }
      case 'chroma_render_timeline_export':
        return { ok: true, frames: 72, segments: 1, ms: 1, stderr_tail: '' };
      default:
        throw new Error(`no stub for ${cmd}`);
    }
  }),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const { runEditorExport } = await import('./editorExport');
const { useEditorTimelineStore } = await import('./timelineStore');
const { useMediaPoolStore } = await import('@apelles/bridge');
const { compositionSizeSnapshot } = await import('./compositionSize');
import type { NewClipFields, Timeline } from './timeline';

const emptyProject = (): Timeline => ({
  id: 'tl',
  name: 'tl',
  rate: { num: 24, den: 1 },
  tracks: [{ kind: 'video', clips: [] }],
});

const still: NewClipFields = {
  id: 'card',
  name: 'card.png',
  source_path: '/refs/card.png',
  source_start: 0,
  duration: 72,
  source_len: 86400,
};

const exportArgs = { outPath: '/tmp/out.mp4', width: 640, height: 360, renderer: 'compositor' };

beforeEach(() => {
  invokeMock.mockClear();
  backend.calls.length = 0;
  backend.persisted = emptyProject();
  backend.failSave = false;
  useMediaPoolStore.setState({ items: [] });
  useEditorTimelineStore.setState({ timeline: emptyProject(), error: null });
});

describe('editor_export after an unsaved edit (B-276)', () => {
  it('saves the edit before sizing and rendering, so a still just placed sizes the composition', async () => {
    useEditorTimelineStore.getState().applyOp({ kind: 'add_clip', track: 0, clip: still });
    // The edit is in the store but still on its debounce: nothing sent yet.
    expect(backend.calls).not.toContain('chroma_timeline_set');

    const result = await runEditorExport(exportArgs);

    expect('error' in result && !('ok' in result) ? result.error : null).toBeNull();
    const at = (cmd: string) => backend.calls.indexOf(cmd);
    expect(at('chroma_timeline_set')).toBeGreaterThanOrEqual(0);
    expect(at('chroma_timeline_set')).toBeLessThan(at('chroma_timeline_composition_size'));
    expect(at('chroma_timeline_set')).toBeLessThan(at('chroma_render_timeline_export'));
    expect(compositionSizeSnapshot()).toEqual({ width: 1280, height: 720 });
  });

  it('refuses rather than exporting a document other than the one on screen when the save fails', async () => {
    useEditorTimelineStore.getState().applyOp({ kind: 'add_clip', track: 0, clip: still });
    backend.failSave = true;

    const result = await runEditorExport(exportArgs);

    expect('error' in result ? result.error : null).toMatch(/could not save the timeline before exporting/);
    expect(backend.calls).not.toContain('chroma_render_timeline_export');
  });

  it('is a no-op when nothing is pending', async () => {
    backend.persisted = useEditorTimelineStore.getState().timeline;
    await runEditorExport(exportArgs);
    expect(backend.calls).not.toContain('chroma_timeline_set');
  });
});
