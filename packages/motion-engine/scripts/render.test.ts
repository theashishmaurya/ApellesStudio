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
    expect(runner).toContain(`const DEFAULT_VIDEO_SCALE = ${scale};`);
  });
});
