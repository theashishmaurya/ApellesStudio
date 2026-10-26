// B-259 — `add_clip` on a track that does not exist is refused, never silently
// placed on track 0; an empty timeline gets a track of the kind the source needs.
import { describe, expect, it } from 'vitest';
import { applyOp, checkAddClip, type Clip, type NewClipFields, type Timeline } from './timeline';

const newClip = (over: Partial<NewClipFields> = {}): NewClipFields => ({
  id: 'n',
  name: 'n',
  source_path: '/m/n.mp4',
  source_start: 0,
  duration: 48,
  source_len: 48,
  source_fps: 24,
  ...over,
});

const clip = (id: string, start: number): Clip => ({
  id,
  name: id,
  source_path: `/m/${id}.mp4`,
  source_start: 0,
  duration: 24,
  source_len: 24,
  start_frame: start,
});

const twoTracks = (): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: 24, den: 1 },
  tracks: [
    { kind: 'video', clips: [clip('a', 0)] },
    { kind: 'audio', clips: [] },
  ],
});

const empty = (): Timeline => ({ id: 't', name: 't', rate: { num: 24, den: 1 }, tracks: [] });

describe('add_clip on a track that does not exist (B-259)', () => {
  it('is refused with the valid range, not placed on track 0', () => {
    const tl = twoTracks();
    const check = checkAddClip(tl, 5, newClip());
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('no track 5');
    expect(check.reason).toContain('0..1');
    // and the reducer agrees: the SAME timeline object comes back, nothing placed
    expect(applyOp(tl, { kind: 'add_clip', track: 5, clip: newClip() })).toBe(tl);
    expect(tl.tracks[0].clips).toHaveLength(1);
  });

  it('refuses a negative or non-numeric index the same way', () => {
    const tl = twoTracks();
    expect(checkAddClip(tl, -1, newClip()).ok).toBe(false);
    expect(checkAddClip(tl, Number.NaN, newClip()).ok).toBe(false);
    expect(applyOp(tl, { kind: 'add_clip', track: -1, clip: newClip() })).toBe(tl);
  });

  it('still places on a real track, including the last one', () => {
    const out = applyOp(twoTracks(), { kind: 'add_clip', track: 1, clip: newClip() });
    expect(out.tracks[1].clips.map((c) => c.id)).toEqual(['n']);
    expect(out.tracks[0].clips.map((c) => c.id)).toEqual(['a']);
  });
});

describe('add_clip on an empty timeline (B-259)', () => {
  it('creates a video track by default and places the clip on it', () => {
    const out = applyOp(empty(), { kind: 'add_clip', track: 0, clip: newClip() });
    expect(out.tracks.map((t) => t.kind)).toEqual(['video']);
    expect(out.tracks[0].clips.map((c) => c.id)).toEqual(['n']);
  });

  it('creates an AUDIO track for an audio-only source', () => {
    const out = applyOp(empty(), {
      kind: 'add_clip',
      track: 0,
      clip: newClip({ source_path: '/m/vo.wav' }),
      newTrackKind: 'audio',
    });
    expect(out.tracks.map((t) => t.kind)).toEqual(['audio']);
    expect(out.tracks[0].clips).toHaveLength(1);
  });

  it('whatever index the caller named, the one new track is where the clip goes', () => {
    const out = applyOp(empty(), { kind: 'add_clip', track: 3, clip: newClip() });
    expect(out.tracks).toHaveLength(1);
    expect(out.tracks[0].clips).toHaveLength(1);
  });

  it('picture is always video: a still or a title ignores a request for an audio track', () => {
    const still = applyOp(empty(), {
      kind: 'add_clip',
      track: 0,
      clip: newClip({ source_path: '/m/page.png' }),
      newTrackKind: 'audio',
    });
    expect(still.tracks.map((t) => t.kind)).toEqual(['video']);
    const title = applyOp(empty(), {
      kind: 'add_clip',
      track: 0,
      clip: newClip({ source_path: '', text: { content: 'Hi', font: 'Inter', size: 0.1, color: '#ffffff' } }),
      newTrackKind: 'audio',
    });
    expect(title.tracks.map((t) => t.kind)).toEqual(['video']);
  });
});

describe('add_clip on a brand-new track (B-273)', () => {
  it("onNewTrack 'audio' appends one audio track at the bottom and places the clip there", () => {
    const tl = twoTracks();
    const out = applyOp(tl, {
      kind: 'add_clip',
      track: 0,
      clip: newClip({ source_path: '/m/sfx.wav' }),
      onNewTrack: 'audio',
    });
    expect(out.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'audio']);
    expect(out.tracks[2].clips.map((c) => c.id)).toEqual(['n']);
    expect(tl.tracks, 'the op is pure').toHaveLength(2);
  });

  it("onNewTrack 'video' inserts one video track at the top, whatever `track` says", () => {
    const out = applyOp(twoTracks(), { kind: 'add_clip', track: 5, clip: newClip(), onNewTrack: 'video' });
    expect(out.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'audio']);
    expect(out.tracks[0].clips.map((c) => c.id)).toEqual(['n']);
  });

  it('on an empty timeline it makes exactly one track, not an extra empty one', () => {
    const audio = applyOp(empty(), {
      kind: 'add_clip',
      track: 0,
      clip: newClip({ source_path: '/m/sfx.wav' }),
      onNewTrack: 'audio',
    });
    expect(audio.tracks.map((t) => t.kind)).toEqual(['audio']);
    const video = applyOp(empty(), { kind: 'add_clip', track: 0, clip: newClip(), onNewTrack: 'video' });
    expect(video.tracks.map((t) => t.kind)).toEqual(['video']);
  });

  it('refuses picture on a new audio track as a no-op', () => {
    const tl = twoTracks();
    const out = applyOp(tl, {
      kind: 'add_clip',
      track: 0,
      clip: newClip({ source_path: '/m/page.png' }),
      onNewTrack: 'audio',
    });
    expect(out).toBe(tl);
  });
});
