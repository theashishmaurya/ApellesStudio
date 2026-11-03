// B-319 — the compact summary open_project / new_project answer with.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { projectSummary } = await import('./projectSummary');

describe('projectSummary', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('counts the shots and lists the timelines by id, name and active flag only', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'chroma_session_list') return { count: 3, shots: [{ path: '/a.mov' }] };
      if (cmd === 'chroma_timeline_list') {
        return [
          { id: 't1', name: 'Main', active: true, duration: 900, output: null },
          { id: 't2', name: 'Short', active: false, duration: 300, output: { width: 1080, height: 1920 } },
        ];
      }
      throw new Error(`unexpected ${cmd}`);
    });
    expect(await projectSummary()).toEqual({
      shotCount: 3,
      timelines: [
        { id: 't1', name: 'Main', active: true },
        { id: 't2', name: 'Short', active: false },
      ],
    });
  });

  it('survives a timeline list that is not available yet', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'chroma_session_list') return { count: 0, shots: [] };
      throw new Error('no project');
    });
    expect(await projectSummary()).toEqual({ shotCount: 0, timelines: [] });
  });
});
