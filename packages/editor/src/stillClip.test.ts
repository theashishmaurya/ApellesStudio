/**
 * @apelles/editor — still images as timeline sources (D-292), the model half.
 *
 * **What this covers:** the arithmetic a still needs and footage does not —
 * "which sources are stills", "how long is a still that has no length", and
 * "where does that length come from at each of the places a clip is built".
 * The compiled-argv and real-render halves live in
 * `stillClipExport.ffmpeg.test.ts`, for the reason that file's own header
 * gives.
 *
 * **Why it is worth a file of its own.** Every one of these numbers is
 * synthesized rather than probed, so nothing downstream can catch a wrong one:
 * a still placed at the wrong length renders perfectly, just for the wrong
 * amount of time. The GUI drop and the `editor_add_clip` MCP call must also
 * produce the identical clip (CLAUDE.md's "the same op/store action underneath
 * both"), which is only checkable by asserting both against the one shared
 * `mediaSourceFacts`.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TITLE_SECONDS,
  STILL_EXTENSIONS,
  STILL_SOURCE_SECONDS,
  applyOp,
  checkAddClip,
  clipFromDraggedMedia,
  endFrame,
  isStillSource,
  linkedClipsFromDraggedMedia,
  mediaSourceFacts,
  type Timeline,
} from './timeline';

const FPS = 24;
const still = (over: Record<string, unknown> = {}) => ({
  id: 'img-1',
  sourcePath: '/refs/color-reference.png',
  name: 'color-reference.png',
  ...over,
});
const footage = (over: Record<string, unknown> = {}) => ({
  id: 'mov-1',
  sourcePath: '/footage/a.mov',
  name: 'a.mov',
  frameCount: 240,
  fps: 30,
  ...over,
});

describe('isStillSource (D-292)', () => {
  it('accepts exactly the documented extensions, case-insensitively', () => {
    for (const ext of STILL_EXTENSIONS) {
      expect(isStillSource(`/a/b/ref.${ext}`), ext).toBe(true);
      expect(isStillSource(`/a/b/ref.${ext.toUpperCase()}`), ext).toBe(true);
    }
  });

  it('rejects footage, audio, and the deliberate exclusions', () => {
    expect(isStillSource('/footage/a.mov')).toBe(false);
    expect(isStillSource('/sfx/click.mp3')).toBe(false);
    // Excluded on purpose: an animated GIF is not one frame, and RAW decoding
    // lives above the media layer (and ffmpeg cannot open it either).
    expect(isStillSource('/refs/loop.gif')).toBe(false);
    expect(isStillSource('/refs/DSC_0001.cr2')).toBe(false);
    expect(isStillSource('/refs/noextension')).toBe(false);
    expect(isStillSource('')).toBe(false);
    expect(isStillSource(null)).toBe(false);
  });

  /** The Rust constant is the source of truth (it gates the import probe and
   *  the compositor's decode branch); a drift here means the picker offers a
   *  file the backend then reports as offline. Asserted as a literal so the
   *  test fails loudly rather than tautologically agreeing with itself. */
  it('mirrors apelles_media::still::IMAGE_EXTENSIONS exactly', () => {
    expect([...STILL_EXTENSIONS]).toEqual(['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp']);
  });
});

describe('mediaSourceFacts (D-292)', () => {
  it('synthesizes a still’s length: 3s placed, one hour of trim headroom, no native rate', () => {
    const facts = mediaSourceFacts(still(), FPS);
    expect(facts).not.toBeNull();
    expect(facts!.still).toBe(true);
    expect(facts!.defaultDuration).toBe(DEFAULT_TITLE_SECONDS * FPS);
    expect(facts!.sourceLen).toBe(STILL_SOURCE_SECONDS * FPS);
    // Absent, exactly as a title's is: a source with no native rate takes the
    // documented 1:1 fallback, so `duration` IS the timeline footprint.
    expect(facts!.sourceFps).toBeUndefined();
  });

  it('scales the synthesized length with the project’s own rate', () => {
    expect(mediaSourceFacts(still(), 60)!.defaultDuration).toBe(DEFAULT_TITLE_SECONDS * 60);
    expect(mediaSourceFacts(still(), 60)!.sourceLen).toBe(STILL_SOURCE_SECONDS * 60);
    // A fractional rate still yields a whole number of frames.
    expect(Number.isInteger(mediaSourceFacts(still(), 23.976)!.defaultDuration)).toBe(true);
  });

  it('leaves footage exactly as it was before D-292', () => {
    const facts = mediaSourceFacts(footage(), FPS);
    expect(facts).toEqual({ still: false, sourceLen: 240, sourceFps: 30, defaultDuration: 240 });
  });

  it('still refuses footage with no usable frame count', () => {
    expect(mediaSourceFacts(footage({ frameCount: 0 }), FPS)).toBeNull();
    expect(mediaSourceFacts(footage({ frameCount: null }), FPS)).toBeNull();
    expect(mediaSourceFacts({ id: 'm', sourcePath: '/a.mov', name: 'a.mov' }, FPS)).toBeNull();
  });

  /** A still is placeable with NO probed frame count at all — that is the whole
   *  point, and the thing that used to make `editor_add_clip` refuse it. */
  it('accepts a still that has no frame count, which footage never can', () => {
    expect(mediaSourceFacts(still({ frameCount: null }), FPS)).not.toBeNull();
  });
});

describe('placing a still (D-292)', () => {
  it('builds a 3-second picture clip with no linked audio half', () => {
    const pair = linkedClipsFromDraggedMedia(still(), FPS);
    expect(pair).not.toBeNull();
    expect(pair!.audio).toBeNull();
    expect(pair!.video.link_group).toBeNull();
    expect(pair!.video.duration).toBe(DEFAULT_TITLE_SECONDS * FPS);
    expect(pair!.video.source_start).toBe(0);
    expect(pair!.video.source_len).toBe(STILL_SOURCE_SECONDS * FPS);
    expect(pair!.video.source_fps).toBeUndefined();
    expect(pair!.video.media_id).toBe('img-1');
    expect(pair!.video.source_path).toBe('/refs/color-reference.png');
    // It is an ordinary media clip — NOT a text/adjustment generator.
    expect(pair!.video.text).toBeUndefined();
    expect(pair!.video.adjustment).toBeUndefined();
  });

  /** Even if a pool item somehow claimed `hasAudio`, a still has no audio
   *  stream and must not get a linked half — the export would compile a
   *  `[N:a]` reference to nothing, which is a hard ffmpeg failure. */
  it('never links an audio half, even for a still that claims hasAudio', () => {
    expect(linkedClipsFromDraggedMedia(still({ hasAudio: true }), FPS)!.audio).toBeNull();
  });

  it('occupies exactly its synthesized duration on the timeline (the 1:1 fallback)', () => {
    const clip = clipFromDraggedMedia(still(), FPS)!;
    const placed = { ...clip, start_frame: 100 };
    expect(endFrame(placed, FPS)).toBe(100 + DEFAULT_TITLE_SECONDS * FPS);
    // …and at a project rate that differs from nothing in particular, since the
    // still has no rate of its own to convert from.
    expect(endFrame({ ...placed, duration: 5 * 60 }, 60)).toBe(100 + 300);
  });

  it('really lands on the timeline through the ordinary add_clip op', () => {
    const before: Timeline = { id: 't', name: 't', tracks: [{ kind: 'video', clips: [] }] };
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: clipFromDraggedMedia(still(), FPS)!,
    });
    expect(after.tracks[0].clips).toHaveLength(1);
    expect(after.tracks[0].clips[0].duration).toBe(DEFAULT_TITLE_SECONDS * FPS);
    expect(after.tracks[0].clips[0].start_frame).toBe(0);
  });

  /** A still is picture with no audio stream at all, so unlike a video clip it
   *  cannot be an audio-track source. Refused at the one gate both the GUI drop
   *  and `editor_add_clip` go through. */
  it('is refused on an audio track, with a reason that says why', () => {
    const tl: Timeline = {
      id: 't',
      name: 't',
      tracks: [
        { kind: 'video', clips: [] },
        { kind: 'audio', clips: [] },
      ],
    };
    const clip = clipFromDraggedMedia(still(), FPS)!;
    expect(checkAddClip(tl, 0, clip, FPS, 0).ok).toBe(true);
    const bad = checkAddClip(tl, 1, clip, FPS, 0);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/still image/i);
    expect(bad.reason).toMatch(/audio track 1/);
  });

  /** The still's one-hour `source_len` is a trim CEILING, not a length: it must
   *  let a placed still be dragged out well past its 3-second default, which a
   *  `source_len` equal to the duration (a title's shape) would forbid. */
  it('can be extended far past its default span, unlike a title', () => {
    const before: Timeline = {
      id: 't',
      name: 't',
      tracks: [{ kind: 'video', clips: [{ ...clipFromDraggedMedia(still(), FPS)!, start_frame: 0 }] }],
    };
    // +30 seconds — an order of magnitude past the placed default.
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 30 * FPS });
    expect(after.tracks[0].clips[0].duration).toBe(DEFAULT_TITLE_SECONDS * FPS + 30 * FPS);
  });
});
