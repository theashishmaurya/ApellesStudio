// @apelles/bridge — the AI-video-understanding flag's vocabulary and store (D-433).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GIB = 1024 ** 3;

const calls: Array<[string, unknown]> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    calls.push([command, args]);
    return {
      enabled: (args as { enabled?: boolean } | undefined)?.enabled ?? false,
      totalMemoryBytes: 8 * GIB,
      lowMemory: true,
      refusal: null,
      howToEnable: 'Settings → Processing → AI video understanding',
    };
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const { formatRam, lowMemoryWarning, useVideoUnderstandingStore } = await import(
  './videoUnderstanding'
);

const base = {
  enabled: true,
  totalMemoryBytes: 8 * GIB,
  lowMemory: true,
  refusal: null,
  howToEnable: '',
};

describe('formatRam', () => {
  it('rounds to whole GB and is null when unknown', () => {
    expect(formatRam(24 * GIB)).toBe('24 GB');
    expect(formatRam(null)).toBeNull();
    expect(formatRam(0)).toBeNull();
  });
});

describe('lowMemoryWarning', () => {
  it('names the Mac RAM when the backend says memory is low', () => {
    expect(lowMemoryWarning(base)).toContain('8 GB');
  });
  it('is null when memory is not low', () => {
    expect(lowMemoryWarning({ ...base, lowMemory: false })).toBeNull();
  });
});

describe('the store', () => {
  beforeEach(() => {
    calls.length = 0;
    useVideoUnderstandingStore.setState({ status: null });
  });

  it('sets through the backend command and keeps the answer', async () => {
    const result = await useVideoUnderstandingStore.getState().setEnabled(true);
    expect(calls).toEqual([['chroma_set_video_understanding', { enabled: true }]]);
    expect(result.enabled).toBe(true);
    expect(useVideoUnderstandingStore.getState().status?.enabled).toBe(true);
  });
});
