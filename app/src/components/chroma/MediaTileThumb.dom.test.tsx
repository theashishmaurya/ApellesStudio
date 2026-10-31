// @vitest-environment jsdom
/**
 * MediaTileThumb on real DOM — the audio tile's waveform / glyph fallback and
 * the duration badge. `getPeaks` is mocked (it is the one cached path to the
 * Rust envelope); `Waveform` is mocked to a marker so the test asserts the
 * tile's decision, not canvas drawing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import type { MediaItem } from '@apelles/bridge';

const getPeaks = vi.fn();
vi.mock('@apelles/editor', () => ({
  getPeaks: (...a: unknown[]) => getPeaks(...a),
  Waveform: () => <canvas data-testid="wave" />,
}));

import { MediaTileThumb } from './MediaTileThumb';

const base: MediaItem = {
  id: 'a1',
  sourcePath: '/m/Hook.m4a',
  name: 'Hook.m4a',
  added: '2026-11-01T00:00:00Z',
  offline: false,
  video: { width: 0, height: 0, fps: 24, frameCount: 1488, durationSecs: 62, hasAudio: true },
};

beforeEach(() => {
  getPeaks.mockReset();
});
afterEach(cleanup);

describe('MediaTileThumb', () => {
  it('draws the waveform and a small glyph when peaks exist, plus the duration badge', async () => {
    getPeaks.mockResolvedValue([[-0.5, 0.5]]);
    const { container, findByTestId } = render(<MediaTileThumb item={base} />);
    await findByTestId('wave');
    expect(container.querySelector('[data-chroma-audio-glyph]')).toBeTruthy();
    expect(container.querySelector('[data-chroma-tile-duration]')?.textContent).toBe('1:02');
    expect(getPeaks).toHaveBeenCalledWith('/m/Hook.m4a', 0, 62, expect.any(Number));
  });

  it('shows the centred glyph, never the film icon, while peaks are loading', () => {
    getPeaks.mockReturnValue(new Promise(() => {}));
    const { container } = render(<MediaTileThumb item={base} />);
    expect(container.querySelector('[data-testid="wave"]')).toBeNull();
    expect(container.querySelector('[data-chroma-audio-glyph]')).toBeTruthy();
  });

  it('falls back to the glyph when no peaks come back', async () => {
    getPeaks.mockResolvedValue([]);
    const { container } = render(<MediaTileThumb item={base} />);
    await waitFor(() => expect(getPeaks).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="wave"]')).toBeNull();
    expect(container.querySelector('[data-chroma-audio-glyph]')).toBeTruthy();
  });

  it('uses the poster frame for video and never asks for peaks', () => {
    const video: MediaItem = {
      ...base,
      video: { width: 1920, height: 1080, fps: 24, frameCount: 240, durationSecs: 10, hasAudio: true },
      thumb: 'data:image/jpeg;base64,AA',
    };
    const { container } = render(<MediaTileThumb item={video} />);
    expect(container.querySelector('img')).toBeTruthy();
    expect(container.querySelector('[data-chroma-audio-tile]')).toBeNull();
    expect(container.querySelector('[data-chroma-tile-duration]')?.textContent).toBe('0:10');
    expect(getPeaks).not.toHaveBeenCalled();
  });

  it('a still has no audio tile and no duration badge', () => {
    const still: MediaItem = { ...base, video: null, image: { width: 100, height: 100 } };
    const { container } = render(<MediaTileThumb item={still} />);
    expect(container.querySelector('[data-chroma-audio-tile]')).toBeNull();
    expect(container.querySelector('[data-chroma-tile-duration]')).toBeNull();
  });
});
