// @vitest-environment jsdom
/**
 * MediaThumbnail on real DOM — kind placeholders, the audio tile's waveform /
 * glyph fallback, loading + offline states and the duration badge. `./Waveform`
 * is mocked (`getPeaks` is the one cached path to the Rust envelope; `Waveform`
 * becomes a marker) so the test asserts the tile's decisions, not canvas drawing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import type { MediaItem } from '@apelles/bridge';

const getPeaks = vi.fn();
vi.mock('./Waveform', () => ({
  getPeaks: (...a: unknown[]) => getPeaks(...a),
  Waveform: () => <canvas data-testid="wave" />,
}));

import { MediaThumbnail, formatDuration, mediaItemThumbnailProps } from './MediaThumbnail';

beforeEach(() => {
  getPeaks.mockReset();
});
afterEach(cleanup);

const audio = { kind: 'audio', sourcePath: '/m/Hook.m4a', durationSecs: 62 } as const;

describe('MediaThumbnail', () => {
  it('audio: draws the waveform and a small glyph when peaks exist, plus the duration badge', async () => {
    getPeaks.mockResolvedValue([[-0.5, 0.5]]);
    const { container, findByTestId } = render(<MediaThumbnail {...audio} />);
    await findByTestId('wave');
    expect(container.querySelector('[data-chroma-audio-glyph]')).toBeTruthy();
    expect(container.querySelector('[data-chroma-tile-duration]')?.textContent).toBe('1:02');
    expect(getPeaks).toHaveBeenCalledWith('/m/Hook.m4a', 0, 62, expect.any(Number));
  });

  it('audio: the centred glyph, never the film icon, while peaks load', () => {
    getPeaks.mockReturnValue(new Promise(() => {}));
    const { container } = render(<MediaThumbnail {...audio} />);
    expect(container.querySelector('[data-testid="wave"]')).toBeNull();
    expect(container.querySelector('[data-chroma-audio-glyph]')).toBeTruthy();
    expect(container.querySelector('[data-chroma-thumb-glyph="video"]')).toBeNull();
  });

  it('audio: falls back to the glyph when no peaks come back, and never asks while offline', async () => {
    getPeaks.mockResolvedValue([]);
    const { container, rerender } = render(<MediaThumbnail {...audio} />);
    await waitFor(() => expect(getPeaks).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="wave"]')).toBeNull();
    getPeaks.mockClear();
    rerender(<MediaThumbnail {...audio} status="offline" />);
    expect(getPeaks).not.toHaveBeenCalled();
    expect(container.querySelector('[data-chroma-thumb-offline]')).toBeTruthy();
  });

  it('a poster src wins for any kind and never asks for peaks', () => {
    const { container } = render(<MediaThumbnail {...audio} src="data:image/jpeg;base64,AA" />);
    expect(container.querySelector('img')).toBeTruthy();
    expect(container.querySelector('[data-chroma-audio-tile]')).toBeNull();
    expect(getPeaks).not.toHaveBeenCalled();
  });

  it.each(['video', 'image', 'motion', 'text'] as const)('%s: its own placeholder glyph, no duration badge without a length', (kind) => {
    const { container } = render(<MediaThumbnail kind={kind} />);
    expect(container.querySelector(`[data-chroma-thumb-glyph="${kind}"]`)).toBeTruthy();
    expect(container.querySelector('[data-chroma-tile-duration]')).toBeNull();
  });

  it('loading shows a spinner instead of a kind glyph; children render as overlays', () => {
    const { container, getByText } = render(
      <MediaThumbnail kind="video" status="loading">
        <button type="button">overlay</button>
      </MediaThumbnail>,
    );
    expect(container.querySelector('[data-chroma-thumb-loading]')).toBeTruthy();
    expect(container.querySelector('[data-chroma-thumb-glyph]')).toBeNull();
    expect(getByText('overlay')).toBeTruthy();
  });

  it('formatDuration and mediaItemThumbnailProps', () => {
    expect(formatDuration(3725)).toBe('1:02:05');
    const base: MediaItem = {
      id: 'a', sourcePath: '/m/x', name: 'x', added: '', offline: false,
      video: { width: 1920, height: 1080, fps: 24, frameCount: 24, durationSecs: 1, hasAudio: true },
    };
    expect(mediaItemThumbnailProps(base).kind).toBe('video');
    expect(mediaItemThumbnailProps({ ...base, motionSceneId: 's1' }).kind).toBe('motion');
    expect(mediaItemThumbnailProps({ ...base, video: null, image: { width: 1, height: 1 } }).kind).toBe('image');
    expect(
      mediaItemThumbnailProps({ ...base, video: { ...base.video!, width: 0, height: 0 }, offline: true }),
    ).toMatchObject({ kind: 'audio', status: 'offline' });
  });
});
