import { describe, expect, it } from 'vitest';

import { trackDuration, type Timeline, type TimelineOrigin } from '../timeline';
import type { Transcript } from '../mediaUnderstandingStore';
import { buildShortBody, captionStyleForFrame, coverTransform, SHORT_CAPTION_MAX_Y, type SourceMedia } from './clipBuild';
import type { Resolved } from './clipperTypes';

const PATH = '/media/talk.mov';
const media: SourceMedia = {
  mediaId: 'm1',
  name: 'talk.mov',
  path: PATH,
  width: 1920,
  height: 1080,
  fps: 24,
  frameCount: 24 * 600,
  hasAudio: true,
};

const base: Timeline = { id: 'abcdef12-0000', name: 'Short 1', rate: { num: 24, den: 1 }, tracks: [] };
const origin: TimelineOrigin = {
  kind: 'clip_short',
  run_id: 'run-1',
  proposal_id: 'p1',
  source: { media_id: 'm1' },
  segments: [{ source_path: PATH, start_s: 10, end_s: 40, role: 'body' }],
  built_at_view: 'view-1',
  settings_hash: 's',
};

/** Words every 0.5 s from 10 s to 40 s, one sentence per 5 s. */
function transcript(): Transcript {
  const segments = [];
  for (let s = 0; s < 60; s += 5) {
    const words = [];
    for (let t = s; t < s + 4.5; t += 0.5) words.push({ word: ` w${t}`, start: t, end: t + 0.4 });
    segments.push({ start: s, end: s + 4.4, text: words.map((w) => w.word).join(''), words });
  }
  return { text: '', language: 'en', model: 'parakeet', source: PATH, segments };
}

const resolved = (cuts: Resolved['ranges'][number]['cuts']): Resolved => ({
  ranges: [{ role: 'body', piece: 0, source: 0, first_word: 0, last_word: 10, start_secs: 10, end_secs: 40, cuts }],
  raw_secs: 30,
  tight_secs: 30,
  first_sentence: 0,
  last_sentence: 5,
});

const input = (over: Partial<Parameters<typeof buildShortBody>[0]> = {}) => ({
  base,
  output: { width: 1080, height: 1920 },
  view: { sources: [{ path: PATH, segments: transcript().segments }], pieces: [{ source: 0, startSecs: 0, endSecs: 601 }] },
  resolved: resolved([]),
  mediaFor: (p: string) => (p === PATH ? media : null),
  hookFirst: true,
  captionStyle: null,
  transcripts: { [PATH]: transcript() },
  recoveries: {},
  origin,
  ...over,
});

describe('clip build', () => {
  it('covers the 9:16 frame centred, and warns past a 1.5x upscale', () => {
    const t = coverTransform({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    expect(t.scale).toBeCloseTo(1920 / 1080);
    expect(t.position_y).toBeCloseTo(0);
    expect(t.position_x).toBeCloseTo((1 - (1920 * t.scale) / 1080) / 2);
    const out = buildShortBody(input());
    if ('error' in out) throw new Error(out.error);
    expect(out.warnings.some((w) => w.includes('magnifies the source 1.78x'))).toBe(true);
  });

  it('places the range as a linked V+A pair at the short size with provenance', () => {
    const out = buildShortBody(input());
    if ('error' in out) throw new Error(out.error);
    const tl = out.timeline;
    expect(tl.id).toBe(base.id);
    expect(tl.output).toEqual({ width: 1080, height: 1920 });
    expect(tl.origin).toEqual(origin);
    expect(tl.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    const [v] = tl.tracks[0].clips;
    const [a] = tl.tracks[1].clips;
    expect(v.source_path).toBe(PATH);
    expect(v.media_id).toBe('m1');
    expect(v.source_start).toBe(240);
    expect(v.duration).toBe(720);
    expect(v.link_group).toBeTruthy();
    expect(a.link_group).toBe(v.link_group);
    expect(trackDuration(tl.tracks[0], 24)).toBe(720);
  });

  it('tightens through the ripple delete on both linked tracks', () => {
    const out = buildShortBody(
      input({ resolved: resolved([{ kind: 'dead_air', start_secs: 20, end_secs: 22 }, { kind: 'retake', start_secs: 30, end_secs: 33 }]) }),
    );
    if ('error' in out) throw new Error(out.error);
    expect(out.tightened.every((r) => r.applied)).toBe(true);
    expect(out.tightened).toHaveLength(2);
    const tl = out.timeline;
    // 30 s minus 5 s of cuts, at 24 fps, on the picture AND its sound.
    expect(trackDuration(tl.tracks[0], 24)).toBe(25 * 24);
    expect(trackDuration(tl.tracks[1], 24)).toBe(25 * 24);
    expect(tl.tracks[0].clips).toHaveLength(3);
  });

  it('captions follow the cuts, styled for the portrait frame', () => {
    const out = buildShortBody(
      input({
        resolved: resolved([{ kind: 'dead_air', start_secs: 20, end_secs: 22 }]),
        captionStyle: { size: 0.07, position_y: 0.9, font: 'sans-bold' },
      }),
    );
    if ('error' in out) throw new Error(out.error);
    expect(out.captions).toBeGreaterThan(0);
    const sub = out.timeline.tracks.find((t) => t.kind === 'subtitle');
    expect(sub).toBeDefined();
    const end = trackDuration(out.timeline.tracks[0], 24);
    for (const c of sub?.clips ?? []) expect(c.start_frame + c.duration).toBeLessThanOrEqual(end);
    expect(sub?.caption_style?.position_y).toBe(SHORT_CAPTION_MAX_Y);
    expect(sub?.caption_style?.size).toBeCloseTo(0.07 * (1080 / 1920));
    // A word inside the cut is not captioned.
    const words = (sub?.clips ?? []).map((c) => c.caption?.text ?? '').join(' ');
    expect(words).not.toContain('w20.5');
    expect(captionStyleForFrame({}, { width: 1080, height: 1080 }).position_y).toBe(SHORT_CAPTION_MAX_Y);
  });

  it('builds a sound-only short from an audio file, and refuses an unknown source', () => {
    const mp3: SourceMedia = { ...media, path: PATH, width: 0, height: 0, hasAudio: true };
    const out = buildShortBody(input({ mediaFor: () => mp3, captionStyle: { size: 0.07 } }));
    if ('error' in out) throw new Error(out.error);
    expect(out.timeline.tracks.map((t) => t.kind)).toEqual(['audio']);
    expect(out.warnings.some((w) => w.includes('sound only'))).toBe(true);
    const bad = buildShortBody(input({ mediaFor: () => null }));
    expect('error' in bad && bad.error).toContain('not a probed media file');
  });
});
