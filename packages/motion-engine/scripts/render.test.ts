/**
 * `scripts/render.mts` carries, as named constants, the render settings the
 * Remotion CLI read from `remotion.config.ts` (D-417: the app no longer runs the
 * CLI). Studio and hand-run CLI renders still read the config file, so the two
 * must say the same thing — a change to one alone would make the app's renders
 * and a developer's CLI render differ without anyone noticing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestRendersAudio } from './renderAudio.mts';
import { defaultVideoScale, MAX_VIDEO_SCALE } from './renderScale.mts';

const here = dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(join(here, 'render.mts'), 'utf8');
const config = readFileSync(join(here, '..', 'remotion.config.ts'), 'utf8');

describe('the renderer and remotion.config.ts agree', () => {
  it('on the GL backend', () => {
    const gl = /setChromiumOpenGlRenderer\("([a-z-]+)"\)/.exec(config)?.[1];
    expect(gl).toBeDefined();
    expect(runner).toContain(`const CHROMIUM_OPTIONS: ChromiumOptions = { gl: "${gl}" };`);
  });

  it('on the frame format a video is encoded from', () => {
    const format = /setVideoImageFormat\("([a-z]+)"\)/.exec(config)?.[1];
    expect(format).toBeDefined();
    expect(runner).toContain(`const VIDEO_FRAME_FORMAT = "${format}" as const;`);
  });

  it('on the video scale (D-342)', () => {
    const scale = /setScale\((\d+(?:\.\d+)?)\)/.exec(config)?.[1];
    expect(scale).toBeDefined();
    expect(MAX_VIDEO_SCALE).toBe(Number(scale));
    expect(runner).toContain('defaultVideoScale(');
  });
});

describe('a video render carries audio only when the manifest has a rendered soundtrack (B-368)', () => {
  it('passes the audio decision to renderMedia as `muted`', () => {
    expect(runner).toContain('muted: !manifestRendersAudio(inputProps)');
  });

  it('is muted with no soundtrack, or with one that is a timing reference only', () => {
    expect(manifestRendersAudio({ scenes: [] })).toBe(false);
    expect(manifestRendersAudio({ soundtrack: { src: 'sha256:x.mp3' } })).toBe(false);
    expect(manifestRendersAudio({ soundtrack: { src: 'sha256:x.mp3', render: false } })).toBe(false);
  });

  it('keeps the audio when the soundtrack is rendered', () => {
    expect(manifestRendersAudio({ soundtrack: { src: 'sha256:x.mp3', render: true } })).toBe(true);
  });
});

describe('the default video scale never exceeds UHD (B-300)', () => {
  it('renders a 1080p manifest at 2x (3840x2160)', () => {
    expect(defaultVideoScale(1920, 1080)).toBe(2);
  });

  it('renders a 4K manifest at its own size, not 8K', () => {
    expect(defaultVideoScale(3840, 2160)).toBe(1);
  });

  it('keeps a vertical 1080x1920 at 2x and a vertical 4K at 1x', () => {
    expect(defaultVideoScale(1080, 1920)).toBe(2);
    expect(defaultVideoScale(2160, 3840)).toBe(1);
  });

  it('keeps D-348 panel canvases at 2x and a 2560x1440 manifest at 1x', () => {
    expect(defaultVideoScale(1252, 1016)).toBe(2);
    expect(defaultVideoScale(2560, 1440)).toBe(1);
  });
});
