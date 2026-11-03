/** B-321 — a slow backend operation is a start + short polls, never one long `invoke`. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { proveComponent } from './customComponentLibraryIO';
import { previewFrames } from './manifestIO';
import { runLongOp } from './longOp';

beforeEach(() => {
  invokeMock.mockReset();
});

/** A backend whose operation reports `running` for `slowPolls` polls, then finishes. */
function backend(slowPolls: number, outcome: { state: 'done'; result: unknown } | { state: 'failed'; error: string }) {
  let polls = 0;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd.endsWith('_start')) return '7';
    if (cmd === 'chroma_motion_longop_poll') {
      polls += 1;
      return polls <= slowPolls ? { state: 'running' } : outcome;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return () => polls;
}

describe('runLongOp', () => {
  it('resolves with the result of an operation that takes many polls', async () => {
    const polls = backend(5, { state: 'done', result: { path: 'sheet.png' } });
    await expect(runLongOp(Promise.resolve('7'), 1)).resolves.toEqual({ path: 'sheet.png' });
    expect(polls()).toBe(6);
  });

  it('rejects with the backend error of a failed operation', async () => {
    backend(1, { state: 'failed', error: 'render failed: boom' });
    await expect(runLongOp(Promise.resolve('7'), 1)).rejects.toThrow('render failed: boom');
  });

  it('rejects when the operation cannot be started', async () => {
    await expect(runLongOp(Promise.reject(new Error('no project open')), 1)).rejects.toThrow('no project open');
  });
});

describe('the two slow Motion operations use it (B-321)', () => {
  it('the preview still starts, then polls to its result', async () => {
    backend(3, { state: 'done', result: { path: 'p.png', width: 960, height: 540, columns: 1, rows: 1 } });
    const r = await previewFrames({ manifest: {}, frames: [0], scale: 0.5, label: 's' });
    expect(r.path).toBe('p.png');
    expect(invokeMock.mock.calls[0][0]).toBe('chroma_motion_preview_frame_start');
    expect(invokeMock.mock.calls.slice(1).every((c) => c[0] === 'chroma_motion_longop_poll')).toBe(true);
  });

  it('the component proof starts, then polls to its result', async () => {
    backend(3, { state: 'done', result: { ok: true, frames: [], passes: 3 } });
    const r = await proveComponent('c', 1, {} as never);
    expect(r).toMatchObject({ ok: true });
    expect(invokeMock.mock.calls[0][0]).toBe('chroma_motion_prove_component_start');
  });
});
