/**
 * @apelles/editor — an audio-only source may not go on a video track (B-389).
 *
 * **The bug.** Naming a video track explicitly placed an `.mp3` as a PICTURE
 * clip. It was accepted, and the compositor then failed on every frame the clip
 * spanned — `has no usable resolution`, painted over the preview until someone
 * found and removed it. Through the A/V-link path it could even manufacture a
 * whole new video track for an audio file. Found live, twice, cutting the
 * launch film.
 *
 * **Why it is a model test and not a UI one.** `checkAddClip` is the single
 * gate both the GUI drop and `editor_add_clip` pass through, and the two
 * neighbouring kind rules (a title/adjustment clip, and a still) are already
 * enforced there. This is the third rule of the same family — stated from the
 * other side — so it belongs beside them rather than in either caller.
 */
import { describe, expect, it } from 'vitest';

import { AUDIO_ONLY_EXTENSIONS, applyOp, checkAddClip, isAudioOnlySource, type Timeline } from './timeline';

const FPS = 25;

const clip = (sourcePath: string) => ({
  id: 'c1',
  name: sourcePath.split('/').pop() as string,
  source_path: sourcePath,
  source_start: 0,
  duration: 50,
  source_len: 2000,
  source_fps: 25,
  start_frame: 0,
});

const timeline = (): Timeline => ({
  id: 't',
  name: 't',
  tracks: [
    { kind: 'video', clips: [], gain: 1, sync_locked: true },
    { kind: 'audio', clips: [], gain: 1, sync_locked: true },
  ],
});

describe('isAudioOnlySource (B-389)', () => {
  it('knows the sound containers and leaves everything else alone', () => {
    for (const ext of AUDIO_ONLY_EXTENSIONS) {
      expect(isAudioOnlySource(`/music/bed.${ext}`)).toBe(true);
      expect(isAudioOnlySource(`/music/bed.${ext.toUpperCase()}`)).toBe(true);
    }
    for (const other of ['/v/clip.mp4', '/v/clip.mov', '/v/clip.webm', '/i/still.png']) {
      expect(isAudioOnlySource(other)).toBe(false);
    }
    expect(isAudioOnlySource(null)).toBe(false);
    expect(isAudioOnlySource('/no-extension')).toBe(false);
  });
});

describe('an audio-only source is refused on a video track (B-389)', () => {
  it('refuses, and the reason says where it should go instead', () => {
    const r = checkAddClip(timeline(), 0, clip('/music/bed.mp3'), FPS, 0, false);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/audio with no picture/);
    expect(r.reason).toMatch(/audio track/);
  });

  it('allows the same source on an audio track', () => {
    expect(checkAddClip(timeline(), 1, clip('/music/bed.mp3'), FPS, 0, false).ok).toBe(true);
  });

  it('still allows real footage on a video track — the guard is about SOUND, not about "not a video track"', () => {
    expect(checkAddClip(timeline(), 0, clip('/v/shot.mp4'), FPS, 0, false).ok).toBe(true);
  });

  it('the refusal reaches `applyOp`, so the timeline is unchanged rather than holding a silent picture-less clip', () => {
    const before = timeline();
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: clip('/music/bed.mp3'),
      startFrame: 0,
    } as never);
    expect(after.tracks[0].clips).toHaveLength(0);
    expect(after).toBe(before);
  });
});
