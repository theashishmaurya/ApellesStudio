/**
 * B-369 — the live open: Rust events land by `openId`, and the tail of an open
 * (the timeline, then the first preview frame) ends the loader when the Edit
 * tab has its timeline and a picture, or at a cap, never later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (ev: { payload: unknown }) => void;
const handlers: Handler[] = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, h: Handler) => {
    handlers.push(h);
    return () => {};
  },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));

let frame: (() => void) | null = null;
vi.mock('@apelles/editor', async (importActual) => {
  const actual = await importActual<typeof import('@apelles/editor')>();
  return {
    ...actual,
    // the first preview frame arrives when the test says so (or the cap passes)
    nextPreviewFrame: (cap: number) =>
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), cap);
        frame = () => {
          clearTimeout(t);
          resolve(true);
        };
      }),
  };
});

const { useEditorTimelineStore } = await import('@apelles/editor');
const { beginOpen, advanceOpen, endOpen, followOpenToReady, useOpenProgressStore, FIRST_FRAME_WAIT_CAP_MS, TIMELINE_WAIT_CAP_MS } =
  await import('./useOpenProgressStore');

const emit = (payload: unknown) => handlers.forEach((h) => h({ payload }));

const timelineWithClip = {
  id: 't1',
  name: 'T',
  fps: 30,
  tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c1' }] }],
} as never;

beforeEach(() => {
  frame = null;
  useEditorTimelineStore.setState({ openProjectKey: null, status: 'idle', timeline: null });
});
afterEach(() => vi.useRealTimers());

describe('the open progress store (B-369)', () => {
  it('applies the Rust phases of this open and drops another open’s', async () => {
    const id = await beginOpen('open', 'Nemotron');
    expect(useOpenProgressStore.getState()).toMatchObject({ active: true, phase: 'reading', projectName: 'Nemotron' });
    emit({ openId: id, phase: 'media', done: 120, total: 288 });
    expect(useOpenProgressStore.getState()).toMatchObject({ phase: 'media', done: 120, total: 288 });
    emit({ openId: id - 1, phase: 'preview', done: 0, total: 0 });
    emit({ openId: id, phase: 'bogus' });
    expect(useOpenProgressStore.getState().phase).toBe('media');
    endOpen(id, false);
    expect(useOpenProgressStore.getState().active).toBe(false);
  });

  it('follows the open through the timeline and the first frame, then ends it', async () => {
    const id = await beginOpen('open', 'P');
    advanceOpen(id, 'grades');
    const follow = followOpenToReady(id, '/p.chroma');
    expect(useOpenProgressStore.getState().phase).toBe('timeline');
    // another project's ready timeline is not this one
    useEditorTimelineStore.setState({ openProjectKey: '/other.chroma', status: 'ready', timeline: timelineWithClip });
    await Promise.resolve();
    expect(useOpenProgressStore.getState().phase).toBe('timeline');
    useEditorTimelineStore.setState({ openProjectKey: '/p.chroma', status: 'ready', timeline: timelineWithClip });
    await vi.waitFor(() => expect(useOpenProgressStore.getState().phase).toBe('previews'));
    expect(useOpenProgressStore.getState().active).toBe(true);
    frame?.();
    await follow;
    expect(useOpenProgressStore.getState().active).toBe(false);
  });

  it('an empty timeline has no picture to wait for', async () => {
    const id = await beginOpen('open', 'Empty');
    useEditorTimelineStore.setState({
      openProjectKey: '/e.chroma',
      status: 'ready',
      timeline: { id: 't', name: 'T', fps: 30, tracks: [] } as never,
    });
    await followOpenToReady(id, '/e.chroma');
    expect(useOpenProgressStore.getState().active).toBe(false);
    expect(frame).toBeNull();
  });

  it('a timeline that never arrives cannot hold the loader past its caps', async () => {
    vi.useFakeTimers();
    const id = await beginOpen('open', 'Stuck');
    const follow = followOpenToReady(id, '/stuck.chroma');
    await vi.advanceTimersByTimeAsync(TIMELINE_WAIT_CAP_MS + FIRST_FRAME_WAIT_CAP_MS + 10);
    await follow;
    expect(useOpenProgressStore.getState().active).toBe(false);
  });

  it('a newer open supersedes the follow of an older one', async () => {
    const first = await beginOpen('open', 'A');
    const follow = followOpenToReady(first, '/a.chroma');
    const second = await beginOpen('open', 'B');
    useEditorTimelineStore.setState({ openProjectKey: '/a.chroma', status: 'ready', timeline: null });
    await follow;
    expect(useOpenProgressStore.getState()).toMatchObject({ openId: second, active: true, projectName: 'B' });
    endOpen(second, true);
  });
});
