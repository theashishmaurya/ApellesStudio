// @vitest-environment jsdom
//
// @chroma/editor — unit tests for `timelineInterchange.ts`: the rational-time
// helpers, and `buildFcpxml`'s real Timeline -> FCPXML compiler.
//
// Verification bar (D-195, matching this session's own `timelineExport.
// ffmpeg.test.ts` precedent that a string-only test can miss real
// invalidity): every fixture below is checked for real XML well-formedness
// via the real `DOMParser` the `jsdom` vitest environment provides globally
// (the SAME environment/pattern `TimelinePane.marquee.dom.test.tsx` already
// uses — not a string match), and the more complete fixtures are ALSO
// validated against Apple's own real, published FCPXML 1.7 DTD
// (`./__fixtures__/fcpxml-1.7.dtd`, a verbatim copy — see that file's own
// header) via `xmllint --dtdvalid`, skipped with a loud console warning
// (never a silent pass) if `xmllint` isn't on the host running the tests.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildFcpxml, fpsToRational, rationalTimeString, type FcpxmlExportOptions } from './timelineInterchange';
import type { Clip, Timeline, Track } from './timeline';

// `path.resolve` against `process.cwd()` rather than `new URL(..., import.meta
// .url)` — this file's own `@vitest-environment jsdom` pragma above replaces
// the global `URL` with jsdom's own WHATWG implementation for the whole file,
// which `node:url`'s `fileURLToPath` (a Node-specific util expecting Node's
// own `URL`/a `file:` string) does not accept, throwing "The URL must be of
// scheme file" even for a well-formed relative URL. `vitest run` is always
// invoked with this package's own directory as `cwd` (the npm workspace
// convention every other script in this repo already relies on), so a
// `cwd`-relative path is exactly as robust here and sidesteps the conflict
// entirely.
const DTD_PATH = path.resolve(process.cwd(), 'src/__fixtures__/fcpxml-1.7.dtd');

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 240,
    source_len: 240,
    start_frame: 0,
    ...overrides,
  };
}

function track(kind: Track['kind'], clips: Clip[], overrides: Partial<Track> = {}): Track {
  return { kind, clips, ...overrides };
}

function timeline(tracks: Track[], overrides: Partial<Timeline> = {}): Timeline {
  return { id: 'tl', name: 'My Timeline', tracks, ...overrides };
}

const opts30: FcpxmlExportOptions = { width: 1920, height: 1080 };

/** Real XML well-formedness via a real parser — never a string match. Uses
 *  the ambient `DOMParser` the `jsdom` vitest environment (this file's own
 *  `@vitest-environment jsdom` pragma above) provides as a global. */
function parseXmlOrThrow(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const errors = doc.getElementsByTagName('parsererror');
  if (errors.length > 0) {
    throw new Error(`XML is not well-formed: ${errors[0].textContent}`);
  }
  return doc;
}

let xmllintChecked = false;
let xmllintAvailable = false;
function hasXmllint(): boolean {
  if (!xmllintChecked) {
    xmllintChecked = true;
    try {
      execFileSync('xmllint', ['--version']);
      xmllintAvailable = true;
    } catch {
      xmllintAvailable = false;
    }
  }
  return xmllintAvailable;
}

/** Validates `xml` against the real FCPXML 1.7 DTD via `xmllint --dtdvalid`.
 *  Skips (with a loud console warning, never a silent pass) if `xmllint`
 *  isn't installed on the host running the tests, or the DTD fixture is
 *  somehow missing — an honest degrade, not a fabricated pass. */
function assertDtdValid(xml: string): void {
  if (!existsSync(DTD_PATH)) {
    // eslint-disable-next-line no-console
    console.warn(`[timelineInterchange.test] DTD fixture missing at ${DTD_PATH} — skipping real DTD validation.`);
    return;
  }
  if (!hasXmllint()) {
    // eslint-disable-next-line no-console
    console.warn('[timelineInterchange.test] `xmllint` not found on PATH — skipping real DTD validation.');
    return;
  }
  try {
    execFileSync('xmllint', ['--noout', '--dtdvalid', DTD_PATH, '-'], { input: xml });
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    throw new Error(`FCPXML failed real DTD validation:\n${err.stderr?.toString() ?? err.message}`);
  }
}

describe('rationalTimeString', () => {
  it('renders zero as the bare "0s" form', () => {
    expect(rationalTimeString(0, { num: 30, den: 1 })).toBe('0s');
  });

  it('renders a whole-second value as "<n>s"', () => {
    expect(rationalTimeString(30, { num: 30, den: 1 })).toBe('1s');
    expect(rationalTimeString(60, { num: 30, den: 1 })).toBe('2s');
  });

  it('renders a non-whole value as a reduced fraction', () => {
    // 15 frames at 30fps = 0.5s = 15/30 reduced to 1/2
    expect(rationalTimeString(15, { num: 30, den: 1 })).toBe('1/2s');
  });

  it('keeps NTSC-style rates exact rather than a decimal approximation', () => {
    // 1 frame at 30000/1001 fps = 1001/30000 s
    expect(rationalTimeString(1, { num: 30000, den: 1001 })).toBe('1001/30000s');
  });
});

describe('fpsToRational', () => {
  it('snaps a probed 29.97 to the real NTSC fraction 30000/1001', () => {
    expect(fpsToRational(29.97)).toEqual({ num: 30000, den: 1001 });
  });

  it('snaps a probed 23.976 to 24000/1001', () => {
    expect(fpsToRational(23.976)).toEqual({ num: 24000, den: 1001 });
  });

  it('keeps an exact integer rate exact', () => {
    expect(fpsToRational(30)).toEqual({ num: 30, den: 1 });
    expect(fpsToRational(24)).toEqual({ num: 24, den: 1 });
  });

  it('reduces an unusual rate to a documented thousandth-of-a-frame approximation', () => {
    expect(fpsToRational(33.333)).toEqual({ num: 33333, den: 1000 });
  });
});

describe('buildFcpxml — structure', () => {
  it('produces well-formed, DTD-valid XML for a single full-canvas clip', () => {
    const tl = timeline([track('video', [clip('c1', { duration: 300, start_frame: 0 })])], {
      rate: { num: 30, den: 1 },
    });
    const { xml, warnings } = buildFcpxml(tl, opts30);

    parseXmlOrThrow(xml);
    assertDtdValid(xml);

    expect(xml).toContain('<fcpxml version="1.7">');
    expect(xml).toContain('<asset-clip ref="asset1" lane="1" offset="0s"');
    expect(xml).toContain('name="c1"');
    expect(warnings).toEqual([]);
  });

  it('escapes special characters in names and paths', () => {
    const tl = timeline([
      track('video', [clip('c1', { name: 'A & B <clip> "quoted"', source_path: "/media/a b's & <clip>.mov" })]),
    ]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const assetClip = doc.getElementsByTagName('asset-clip')[0];
    expect(assetClip.getAttribute('name')).toBe('A & B <clip> "quoted"');
  });

  it('places clip offsets using the exact project rate, not a rounded float', () => {
    const tl = timeline([track('video', [clip('c1', { start_frame: 100, duration: 50 })])], {
      rate: { num: 30000, den: 1001 },
    });
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const assetClip = doc.getElementsByTagName('asset-clip')[0];
    // 100 frames at 30000/1001 fps = 100*1001/30000 s, reduced.
    expect(assetClip.getAttribute('offset')).toBe(rationalTimeString(100, { num: 30000, den: 1001 }));
  });
});

describe('buildFcpxml — track order / lanes', () => {
  it('gives track 0 (Chroma\'s own topmost/foreground track) the HIGHEST fcpxml lane', () => {
    const tl = timeline([
      track('video', [clip('top', { name: 'top' })]),
      track('video', [clip('mid', { name: 'mid' })]),
      track('video', [clip('back', { name: 'back' })]),
    ]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const byName = (n: string) =>
      [...doc.getElementsByTagName('asset-clip')].find((el) => el.getAttribute('name') === n)!;
    const laneOf = (n: string) => Number(byName(n).getAttribute('lane'));
    expect(laneOf('top')).toBeGreaterThan(laneOf('mid'));
    expect(laneOf('mid')).toBeGreaterThan(laneOf('back'));
    expect(laneOf('back')).toBe(1); // never lane 0 — DTD requires a non-zero lane for an anchored item
  });

  it('skips a hidden video track entirely and warns about it', () => {
    const tl = timeline([
      track('video', [clip('visible')]),
      track('video', [clip('hidden')], { hidden: true }),
    ]);
    const { xml, warnings } = buildFcpxml(tl, opts30);
    expect(xml).toContain('name="visible"');
    expect(xml).not.toContain('name="hidden"');
    expect(warnings.some((w) => w.includes('hidden video track'))).toBe(true);
  });

  it('assigns audio tracks negative lanes, distinct from video lanes', () => {
    const tl = timeline([track('video', [clip('v1')]), track('audio', [clip('a1', { name: 'a1' })])]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const a1 = [...doc.getElementsByTagName('asset-clip')].find((el) => el.getAttribute('name') === 'a1')!;
    expect(Number(a1.getAttribute('lane'))).toBeLessThan(0);
  });
});

describe('buildFcpxml — crop / transform', () => {
  it('maps crop_top/crop_bottom to trim-rect exactly (both height-normalised in both systems)', () => {
    const tl = timeline([track('video', [clip('c1', { crop_top: 0.1, crop_bottom: 0.2 })])]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const trimRect = doc.getElementsByTagName('trim-rect')[0];
    expect(Number(trimRect.getAttribute('top'))).toBeCloseTo(10, 5);
    expect(Number(trimRect.getAttribute('bottom'))).toBeCloseTo(20, 5);
  });

  it('warns when crop_left/crop_right is approximated with the canvas aspect ratio (no sourceInfo)', () => {
    const tl = timeline([track('video', [clip('c1', { crop_left: 0.1 })])]);
    const { warnings } = buildFcpxml(tl, opts30);
    expect(warnings.some((w) => w.includes('crop_left/crop_right'))).toBe(true);
  });

  it('does NOT warn about crop_left/crop_right when sourceInfo gives the real native size', () => {
    const tl = timeline([track('video', [clip('c1', { crop_left: 0.1 })])]);
    const { warnings } = buildFcpxml(tl, { ...opts30, sourceInfo: { c1: { width: 1920, height: 1080 } } });
    expect(warnings.some((w) => w.includes('crop_left/crop_right'))).toBe(false);
  });

  it('a default (untransformed) full-canvas clip centres exactly at (0,0) even with the canvas-aspect fallback', () => {
    const tl = timeline([track('video', [clip('c1')])]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const transform = doc.getElementsByTagName('adjust-transform')[0];
    expect(transform.getAttribute('position')).toBe('0 0');
    expect(transform.getAttribute('scale')).toBe('1 1');
  });

  it('warns when a real (non-default) transform is approximated without sourceInfo', () => {
    const tl = timeline([track('video', [clip('c1', { scale: 0.5, position_x: 0.25, position_y: 0.25 })])]);
    const { warnings } = buildFcpxml(tl, opts30);
    expect(warnings.some((w) => w.includes('adjust-transform'))).toBe(true);
  });

  it('computes an exact, non-approximated transform when sourceInfo is supplied', () => {
    // A 3840x2160 source placed at half canvas scale on a 1920x1080 canvas —
    // real box is 960x540, native post-crop is 3840x2160, so fcp scale is
    // 960/3840 = 0.25 on both axes (uniform, since 'fit' preserves aspect).
    const tl = timeline([track('video', [clip('c1', { scale: 0.5, box_width: undefined })])]);
    const { xml, warnings } = buildFcpxml(tl, { ...opts30, sourceInfo: { c1: { width: 3840, height: 2160 } } });
    expect(warnings).toEqual([]);
    const doc = parseXmlOrThrow(xml);
    const transform = doc.getElementsByTagName('adjust-transform')[0];
    const [sx, sy] = transform.getAttribute('scale')!.split(' ').map(Number);
    expect(sx).toBeCloseTo(0.25, 4);
    expect(sy).toBeCloseTo(0.25, 4);
  });

  it('emits adjust-blend only for a non-default opacity', () => {
    const tlDefault = timeline([track('video', [clip('c1')])]);
    expect(buildFcpxml(tlDefault, opts30).xml).not.toContain('adjust-blend');

    const tlFaded = timeline([track('video', [clip('c1', { opacity: 0.5 })])]);
    const { xml } = buildFcpxml(tlFaded, opts30);
    expect(xml).toContain('<adjust-blend amount="0.5"/>');
  });

  it('carries rotation (degrees) even though the sibling ffmpeg exporter does not implement it at all', () => {
    const tl = timeline([track('video', [clip('c1', { rotation: 15 })])]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    expect(Number(doc.getElementsByTagName('adjust-transform')[0].getAttribute('rotation'))).toBe(15);
  });
});

describe('buildFcpxml — A/V linking (D-129)', () => {
  it('exports a linked video+audio pair as two asset-clips sharing one asset, srcEnable video/audio', () => {
    const tl = timeline([
      track('video', [clip('v1', { link_group: 'lg-1', source_path: '/media/shared.mov' })]),
      track('audio', [clip('a1', { link_group: 'lg-1', source_path: '/media/shared.mov', name: 'a1' })]),
    ]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const clips = [...doc.getElementsByTagName('asset-clip')];
    const video = clips.find((c) => c.getAttribute('name') === 'v1')!;
    const audio = clips.find((c) => c.getAttribute('name') === 'a1')!;
    expect(video.getAttribute('srcEnable')).toBe('video');
    expect(audio.getAttribute('srcEnable')).toBe('audio');
    expect(video.getAttribute('ref')).toBe(audio.getAttribute('ref')); // same shared asset
    // Only ONE <asset> resource for the shared source_path, not two.
    expect(doc.getElementsByTagName('asset').length).toBe(1);
  });

  it('an unlinked video clip keeps the default srcEnable="all" (embedded audio plays)', () => {
    const tl = timeline([track('video', [clip('v1')])]);
    const { xml } = buildFcpxml(tl, opts30);
    expect(xml).not.toContain('srcEnable');
  });
});

describe('buildFcpxml — audio track gain (D-057)', () => {
  it('converts a track\'s linear gain to adjust-volume dB, with the right sign', () => {
    const tl = timeline([track('audio', [clip('a1')], { gain: 0.5 })]);
    const { xml } = buildFcpxml(tl, opts30);
    const doc = parseXmlOrThrow(xml);
    const volume = doc.getElementsByTagName('adjust-volume')[0];
    const db = Number(volume.getAttribute('amount')!.replace('dB', ''));
    expect(db).toBeCloseTo(20 * Math.log10(0.5), 4); // ~ -6.02 dB
  });

  it('emits no adjust-volume for unity gain', () => {
    const tl = timeline([track('audio', [clip('a1')], { gain: 1 })]);
    const { xml } = buildFcpxml(tl, opts30);
    expect(xml).not.toContain('adjust-volume');
  });

  it('never emits adjust-volume on a VIDEO track clip (its embedded audio stays unity, D-057)', () => {
    const tl = timeline([track('video', [clip('v1')])]);
    const { xml } = buildFcpxml(tl, opts30);
    expect(xml).not.toContain('adjust-volume');
  });
});

describe('buildFcpxml — documented gaps surface as warnings, never silent drops', () => {
  it('warns about ducking (no static FCPXML equivalent)', () => {
    const tl = timeline([
      track('audio', [clip('music')], { duck_from: 1 }),
      track('audio', [clip('vo')]),
    ]);
    const { warnings } = buildFcpxml(tl, opts30);
    expect(warnings.some((w) => w.includes('ducking'))).toBe(true);
  });

  it('warns about an un-exported fade', () => {
    const tl = timeline([track('video', [clip('c1', { fade_in_frames: 15 })])]);
    const { warnings } = buildFcpxml(tl, opts30);
    expect(warnings.some((w) => w.includes('fade'))).toBe(true);
  });

  it('warns about un-exported chroma_keyframes', () => {
    const tl = timeline([
      track('video', [clip('c1', { chroma_keyframes: [{ frame: 0, params: { scale: 1 } }] })]),
    ]);
    const { warnings } = buildFcpxml(tl, opts30);
    expect(warnings.some((w) => w.includes('chroma_keyframes'))).toBe(true);
  });

  it('warns on a genuinely empty timeline rather than emitting an unexplained empty sequence', () => {
    const tl = timeline([]);
    const { xml, warnings } = buildFcpxml(tl, opts30);
    parseXmlOrThrow(xml);
    expect(warnings.some((w) => w.includes('no visible video or audio tracks'))).toBe(true);
  });
});

describe('buildFcpxml — a realistic multi-track fixture is fully DTD-valid', () => {
  it('validates a stacked two-video + one-audio, linked, cropped, gained timeline', () => {
    const tl = timeline(
      [
        track('video', [
          clip('fg', {
            name: 'Foreground',
            crop_top: 0.05,
            crop_bottom: 0.05,
            scale: 0.5,
            position_x: 0.25,
            position_y: 0.1,
            opacity: 0.9,
            rotation: 3,
            link_group: 'lg-1',
            source_path: '/media/fg.mov',
          }),
        ]),
        track('video', [clip('bg', { name: 'Background', duration: 300, source_path: '/media/bg.mov' })]),
        track('audio', [
          clip('fg-audio', { name: 'Foreground audio', link_group: 'lg-1', source_path: '/media/fg.mov' }),
        ], { gain: 0.7 }),
      ],
      { rate: { num: 30000, den: 1001 } },
    );
    const { xml, warnings } = buildFcpxml(tl, {
      width: 1920,
      height: 1080,
      sourceInfo: { fg: { width: 1920, height: 1080, hasAudio: true }, bg: { width: 1920, height: 1080 } },
    });

    parseXmlOrThrow(xml);
    assertDtdValid(xml);
    // sourceInfo covers every transform-bearing clip, so no approximation warnings.
    expect(warnings).toEqual([]);
  });
});
