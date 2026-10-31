// @vitest-environment jsdom
/**
 * SourcesPanel's media tiles use the shared `MediaThumbnail` (D-436 follow-up):
 * an audio-only item is an audio tile (glyph while no peaks, never the film
 * icon), a video with a poster shows it, both carry a duration badge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { useShellStore } from '@apelles/shell';

import { useSessionStore } from '../../store/useSessionStore';

// No peaks for any source: the audio tile must settle on its glyph.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('./ProjectLauncher', () => ({ pickClips: vi.fn() }));

import { SourcesPanel } from './SourcesPanel';

const SHELL_INITIAL = useShellStore.getState();
const POOL_INITIAL = useMediaPoolStore.getState();
const SESSION_INITIAL = useSessionStore.getState();

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: 'i',
  sourcePath: '/m/x',
  name: 'x',
  added: '2026-11-01T00:00:00Z',
  offline: false,
  ...over,
});

let restoreRO: () => void;

beforeEach(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  const had = 'ResizeObserver' in g;
  const original = g.ResizeObserver;
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  restoreRO = () => {
    if (had) g.ResizeObserver = original;
    else delete g.ResizeObserver;
  };
  useShellStore.setState({ ...SHELL_INITIAL });
  useSessionStore.setState({ ...SESSION_INITIAL, projectName: 'p', projectPath: '/p.chroma' });
  useMediaPoolStore.setState({
    ...POOL_INITIAL,
    folders: [],
    loading: false,
    openProjectKey: 'k',
    items: [
      item({
        id: 'a',
        name: 'Hook.m4a',
        sourcePath: '/m/Hook.m4a',
        video: { width: 0, height: 0, fps: 24, frameCount: 1488, durationSecs: 62, hasAudio: true },
      }),
      item({
        id: 'v',
        name: 'clip.mov',
        sourcePath: '/m/clip.mov',
        thumb: 'data:image/jpeg;base64,AA',
        video: { width: 1920, height: 1080, fps: 24, frameCount: 240, durationSecs: 10, hasAudio: true },
      }),
    ],
  });
});

afterEach(() => {
  cleanup();
  restoreRO();
});

describe('SourcesPanel media tiles', () => {
  it('an audio-only item is an audio tile with its glyph (never the film icon) and a duration badge', () => {
    const { container } = render(<SourcesPanel />);
    const tile = container.querySelector('[data-chroma-thumbnail="audio"]');
    expect(tile).toBeTruthy();
    expect(tile?.querySelector('[data-chroma-audio-glyph]')).toBeTruthy();
    expect(tile?.querySelector('[data-chroma-thumb-glyph="video"]')).toBeNull();
    expect(tile?.querySelector('[data-chroma-tile-duration]')?.textContent).toBe('1:02');
  });

  it('a video with a poster shows it, with its duration', () => {
    const { container } = render(<SourcesPanel />);
    const tile = container.querySelector('[data-chroma-thumbnail="video"]');
    expect(tile?.querySelector('img')).toBeTruthy();
    expect(tile?.querySelector('[data-chroma-tile-duration]')?.textContent).toBe('0:10');
  });
});
