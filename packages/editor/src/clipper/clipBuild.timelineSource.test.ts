// B-336 — a short built from a voice-over TIMELINE carries every track of the
// chosen stretch: the picture (reframed for 9:16), the other sound, the titles
// and the Motion renders, with captions generated from the voice on its audio
// track. The fixture is the shape the Nemotron edit had: the cleaned voice on an
// unlinked audio track, the picture on video tracks, music on another.
import { describe, expect, it } from 'vitest';

import type { Transcript } from '../mediaUnderstandingStore';
import type { Clip, Timeline, TimelineOrigin } from '../timeline';
import { buildShortBody, coverTransform, type SourceMedia } from './clipBuild';
import type { Resolved } from './clipperTypes';

const VOICE = '/media/voice.wav';
const SCREEN = '/media/screen.mov';
const MUSIC = '/media/bed.mp3';
const MOTION = '/media/card.mov';

const mediaTable: Record<string, SourceMedia> = {
  [VOICE]: { mediaId: 'mv', name: 'voice', path: VOICE, width: 0, height: 0, fps: 24, frameCount: 24 * 120, hasAudio: true },
  [SCREEN]: { mediaId: 'ms', name: 'screen', path: SCREEN, width: 1920, height: 1080, fps: 24, frameCount: 24 * 120, hasAudio: true },
  [MOTION]: { mediaId: 'mm', name: 'card', path: MOTION, width: 1920, height: 1080, fps: 24, frameCount: 24 * 10, hasAudio: false },
  [MUSIC]: { mediaId: 'mb', name: 'bed', path: MUSIC, width: 0, height: 0, fps: 24, frameCount: 24 * 120, hasAudio: true },
};

const clip = (id: string, path: string, over: Partial<Clip> = {}): Clip => ({
  id,
  name: id,
  source_path: path,
  source_start: 0,
  duration: 24 * 60,
  source_len: 24 * 120,
  source_fps: 24,
  start_frame: 0,
  ...over,
});

const voice = clip('voice', VOICE);

/** Voice on track 1 (unlinked audio), picture on track 0 with its linked demo
 *  sound on track 2, music on track 3, a title on track 4, a Motion card on track 5. */
function longTimeline(): Timeline {
  return {
    id: 'long-0000',
    name: 'Voiceover v2',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', name: 'Video 1', clips: [clip('pic', SCREEN, { link_group: 'lg1' })] },
      { kind: 'audio', name: 'Voice-over', clips: [voice] },
      { kind: 'audio', name: 'Demo sound', clips: [clip('pic-a', SCREEN, { link_group: 'lg1' })] },
      { kind: 'audio', name: 'Music', clips: [clip('bed', MUSIC)] },
      {
        kind: 'video',
        name: 'Titles',
        clips: [clip('title', '', { start_frame: 24 * 12, duration: 24 * 4, text: { content: 'Hello', font: 'sans', size: 0.1, color: '#fff' } as Clip['text'] })],
      },
      { kind: 'video', name: 'Motion', clips: [clip('card', MOTION, { start_frame: 24 * 25, duration: 24 * 5, source_len: 24 * 10 })] },
    ],
  };
}

function transcript(): Transcript {
  const segments = [];
  for (let s = 0; s < 60; s += 5) {
    const words = [];
    for (let t = s; t < s + 4.5; t += 0.5) words.push({ word: ` w${t}`, start: t, end: t + 0.4 });
    segments.push({ start: s, end: s + 4.4, text: words.map((w) => w.word).join(''), words });
  }
  return { text: '', language: 'en', model: 'parakeet', source: VOICE, segments };
}

const origin: TimelineOrigin = {
  kind: 'clip_short',
  run_id: 'run-1',
  proposal_id: 'p1',
  source: { timeline_id: 'long-0000' },
  segments: [],
  built_at_view: 'view-1',
  settings_hash: 's',
};

const resolved = (cuts: Resolved['ranges'][number]['cuts']): Resolved => ({
  ranges: [{ role: 'body', piece: 0, source: 0, first_word: 0, last_word: 10, start_secs: 10, end_secs: 40, cuts }],
  raw_secs: 30,
  tight_secs: 30,
  first_sentence: 0,
  last_sentence: 5,
});

const build = (over: Partial<Parameters<typeof buildShortBody>[0]> = {}) =>
  buildShortBody({
    base: { id: 'abcdef12-0000', name: 'Short 1', rate: { num: 24, den: 1 }, tracks: [] },
    output: { width: 1080, height: 1920 },
    view: {
      sources: [{ path: VOICE, segments: transcript().segments }],
      pieces: [{ source: 0, startSecs: 0, endSecs: 60, clip: { track: 1, index: 0, clipId: 'voice', c: voice } }],
    },
    resolved: resolved([]),
    mediaFor: (p) => mediaTable[p] ?? null,
    hookFirst: true,
    captionStyle: { size: 0.07 },
    transcripts: { [VOICE]: transcript() },
    recoveries: {},
    origin,
    sourceTimeline: longTimeline(),
    ...over,
  });

describe('a short built from a timeline source (B-336)', () => {
  it('carries the picture, the other sound, the title and the Motion card, plus captions', () => {
    const out = build();
    if ('error' in out) throw new Error(out.error);
    const names = out.timeline.tracks.map((t) => `${t.kind}:${t.name ?? ''}`);
    expect(names).toEqual([
      'video:Video 1',
      'audio:Voice-over',
      'audio:Demo sound',
      'audio:Music',
      'video:Titles',
      'video:Motion',
      'subtitle:',
    ]);
    const byName = (n: string) => out.timeline.tracks.find((t) => t.name === n)!.clips;
    // 10 s..40 s of the long edit, from frame 0.
    expect(byName('Video 1')).toHaveLength(1);
    expect(byName('Video 1')[0]).toMatchObject({ source_path: SCREEN, source_start: 240, start_frame: 0, duration: 720 });
    expect(byName('Voice-over')[0]).toMatchObject({ source_path: VOICE, source_start: 240, duration: 720 });
    expect(byName('Music')[0]).toMatchObject({ source_path: MUSIC, source_start: 240, duration: 720 });
    // The title (12 s..16 s) and the card (25 s..30 s) sit where they did, minus the 10 s head.
    expect(byName('Titles')[0]).toMatchObject({ start_frame: 48, duration: 96 });
    expect(byName('Motion')[0]).toMatchObject({ source_path: MOTION, start_frame: 360, duration: 120 });
    // The linked demo sound is still linked to its picture.
    expect(byName('Demo sound')[0].link_group).toBe(byName('Video 1')[0].link_group);
    expect(out.captions).toBeGreaterThan(0);
    expect(out.timeline.tracks.at(-1)!.kind).toBe('subtitle');
    expect(out.warnings.some((w) => w.includes('sound only'))).toBe(false);
  });

  it('reframes the picture for 9:16 and the Motion card too, and carries their grades', () => {
    const out = build();
    if ('error' in out) throw new Error(out.error);
    const cover = coverTransform({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    const pic = out.timeline.tracks[0].clips[0];
    expect(pic).toMatchObject({ scale: cover.scale, position_x: cover.position_x, position_y: cover.position_y });
    const card = out.timeline.tracks.find((t) => t.name === 'Motion')!.clips[0];
    expect(card.scale).toBe(cover.scale);
    expect(out.gradePairs).toEqual(expect.arrayContaining([{ from: 'pic', to: pic.id }]));
    // The voice and the music are sound: no transform stamped on them.
    expect(out.timeline.tracks[1].clips[0].scale).toBeUndefined();
  });

  it('keeps a picture the editor laid out by hand', () => {
    const tl = longTimeline();
    tl.tracks[0].clips[0] = { ...tl.tracks[0].clips[0], scale: 0.4, position_x: 0.5, position_y: 0.05 };
    const out = build({ sourceTimeline: tl });
    if ('error' in out) throw new Error(out.error);
    expect(out.timeline.tracks[0].clips[0]).toMatchObject({ scale: 0.4, position_x: 0.5 });
    expect(out.warnings.some((w) => w.includes('laid out by hand'))).toBe(true);
  });

  it('tightens across every track: a cut removes the same stretch from the picture, voice and music', () => {
    const out = build({ resolved: resolved([{ kind: 'dead_air', start_secs: 20, end_secs: 22 }]) });
    if ('error' in out) throw new Error(out.error);
    expect(out.tightened).toHaveLength(1);
    expect(out.tightened[0].applied).toBe(true);
    const lastEnd = (name: string) => {
      const clips = out.timeline.tracks.find((t) => t.name === name)!.clips;
      return Math.max(...clips.map((c) => c.start_frame + c.duration));
    };
    // 30 s minus a 2 s cut, at 24 fps, on all of them.
    expect(lastEnd('Video 1')).toBe(28 * 24);
    expect(lastEnd('Voice-over')).toBe(28 * 24);
    expect(lastEnd('Music')).toBe(28 * 24);
    // The picture is two clips either side of the cut, the second resuming after it.
    const pics = out.timeline.tracks[0].clips;
    expect(pics).toHaveLength(2);
    expect(pics[1]).toMatchObject({ source_start: 22 * 24, start_frame: 10 * 24 });
    expect(new Set(out.timeline.tracks.flatMap((t) => t.clips.map((c) => c.id))).size).toBe(
      out.timeline.tracks.flatMap((t) => t.clips).length,
    );
  });

  it('captions a voice-only range (no picture under it) and says it is sound only', () => {
    const tl = longTimeline();
    tl.tracks = tl.tracks.filter((t) => t.name === 'Voice-over');
    const out = build({ sourceTimeline: tl });
    if ('error' in out) throw new Error(out.error);
    expect(out.timeline.tracks.map((t) => t.kind)).toEqual(['audio', 'subtitle']);
    expect(out.captions).toBeGreaterThan(0);
    expect(out.warnings.some((w) => w.includes('sound only'))).toBe(true);
  });

  it('refuses a source timeline at a different frame rate than the short', () => {
    const tl = { ...longTimeline(), rate: { num: 30, den: 1 } };
    const out = build({ sourceTimeline: tl });
    expect('error' in out && out.error).toContain('fps');
  });
});
