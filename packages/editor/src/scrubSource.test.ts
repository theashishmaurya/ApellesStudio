/**
 * @chroma/editor — `scrubSource.ts` (D-232, roadmap item 27).
 *
 * This resolver is what a scrub actually *hears* and what the viewer's waveform
 * strip actually *draws*, so its failure mode is not a wrong pixel: it is
 * monitoring the wrong file, or monitoring a clip's audio twice, or scrubbing
 * a track the user has muted. The cases below are written around exactly those,
 * and around the one property that keeps the feature honest — that this answers
 * the same question `chroma_audio_play` answers in Rust, in the same
 * track-index priority order.
 */

import { describe, expect, it } from 'vitest';

import {
  scrubSourceAt,
  waveformTileFor,
  waveformWindowAt,
  WAVEFORM_TILE_SECS,
  WAVEFORM_WINDOW_SECS,
} from './scrubSource';
import { newAdjustmentLayer, newTextLayer, type Clip, type Timeline, type Track } from './timeline';

const FPS = 25;

function clip(patch: Partial<Clip>): Clip {
  return {
    id: patch.id ?? 'c1',
    name: patch.name ?? 'clip',
    source_path: '/media/a.mp4',
    source_start: 0,
    duration: 250,
    source_len: 250,
    start_frame: 0,
    ...patch,
  };
}

function track(kind: Track['kind'], clips: Clip[], patch: Partial<Track> = {}): Track {
  return { kind, clips, ...patch };
}

function timeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'T', rate: { num: FPS, den: 1 }, tracks, markers: [] };
}

describe('scrubSourceAt', () => {
  it('resolves the video track\'s embedded audio when there is no audio track', () => {
    const tl = timeline([track('video', [clip({ source_path: '/media/v.mp4' })])]);
    expect(scrubSourceAt(tl, 50)).toMatchObject({
      path: '/media/v.mp4',
      sourceSecs: 2, // frame 50 at 25 fps
      track: 0,
    });
  });

  /** A genuine audio track outranks the video track's embedded stream — the
   *  same priority `chroma_audio_play` gives, so scrubbing and playing pick the
   *  same material. */
  it('prefers a real audio track over the video track', () => {
    const tl = timeline([
      track('video', [clip({ id: 'v', source_path: '/media/v.mp4' })]),
      track('audio', [clip({ id: 'a', source_path: '/media/a.m4a' })]),
    ]);
    expect(scrubSourceAt(tl, 50)?.path).toBe('/media/a.m4a');
  });

  /** Lowest track index wins, matching `Timeline::resolve_video_clip_at`'s own
   *  "lower index = higher priority" convention across the whole model. */
  it('takes the topmost audio track when several overlap', () => {
    const tl = timeline([
      track('video', [clip({ id: 'v', source_path: '/media/v.mp4' })]),
      track('audio', [clip({ id: 'a1', source_path: '/media/top.m4a' })]),
      track('audio', [clip({ id: 'a2', source_path: '/media/under.m4a' })]),
    ]);
    expect(scrubSourceAt(tl, 50)?.path).toBe('/media/top.m4a');
  });

  /** **A muted track must not be what a scrub monitors.** The Rust mixer applies
   *  `gain` per source and so needs no skip; a scrub picks exactly ONE source,
   *  so without this it would be audible while scrubbing and silent on Play. */
  it('skips an audio track muted to zero gain and falls through', () => {
    const tl = timeline([
      track('video', [clip({ id: 'v', source_path: '/media/v.mp4' })]),
      track('audio', [clip({ id: 'a', source_path: '/media/muted.m4a' })], { gain: 0 }),
    ]);
    expect(scrubSourceAt(tl, 50)?.path).toBe('/media/v.mp4');
  });

  /** D-129 — a linked video clip's embedded stream is never monitored: its
   *  sound lives in the linked audio clip. Unconditional, exactly as Rust's is,
   *  so an L-cut that slipped the audio half elsewhere reads as real silence
   *  rather than as doubled audio. */
  it('never monitors a linked video clip\'s embedded audio', () => {
    const linked = timeline([
      track('video', [clip({ id: 'v', source_path: '/media/v.mp4', link_group: 'g1' })]),
    ]);
    expect(scrubSourceAt(linked, 50)).toBeNull();

    // …and with the linked half present, the audio clip is what is heard.
    const paired = timeline([
      track('video', [clip({ id: 'v', source_path: '/media/v.mp4', link_group: 'g1' })]),
      track('audio', [clip({ id: 'a', source_path: '/media/v.mp4', link_group: 'g1' })]),
    ]);
    expect(scrubSourceAt(paired, 50)?.track).toBe(1);
  });

  it('is null in a gap, before zero, and past the end', () => {
    const tl = timeline([track('video', [clip({ start_frame: 100, duration: 50 })])]);
    expect(scrubSourceAt(tl, 50)).toBeNull();
    expect(scrubSourceAt(tl, -1)).toBeNull();
    expect(scrubSourceAt(tl, 500)).toBeNull();
    expect(scrubSourceAt(null, 0)).toBeNull();
  });

  /** A title / adjustment / caption clip has no media to decode at all —
   *  handing one to `symphonia` is a guaranteed open failure. */
  it('is null over a generated clip that has no media', () => {
    const text = newTextLayer({ content: 'hello' });
    if ('error' in text) throw new Error(text.error);
    const adjustmentOrError = newAdjustmentLayer({});
    if ('error' in adjustmentOrError) throw new Error(adjustmentOrError.error);
    const adjustment = adjustmentOrError;
    const tl = timeline([
      track('video', [
        clip({ id: 'title', source_path: '', text, start_frame: 0, duration: 100 }),
      ]),
    ]);
    expect(scrubSourceAt(tl, 10)).toBeNull();

    const adj = timeline([
      track('video', [clip({ id: 'adj', source_path: '', adjustment, duration: 100 })]),
    ]);
    expect(scrubSourceAt(adj, 10)).toBeNull();
  });

  /** A trimmed clip's playhead maps into the SOURCE's own seconds, through its
   *  own `source_start` — the same B-077 conversion `clipAt` does for every
   *  other consumer. */
  it('maps a trimmed clip\'s playhead into real source seconds', () => {
    const tl = timeline([
      track('audio', [clip({ source_path: '/a.m4a', source_start: 250, start_frame: 100 })]),
    ]);
    // 25 frames into the clip → source frame 275 → 11 s at 25 fps.
    expect(scrubSourceAt(tl, 125)?.sourceSecs).toBeCloseTo(11, 9);
  });

  /** B-075/D-193 — a clip whose SOURCE runs at a different rate than the
   *  timeline converts through its own `source_fps`, not the project's. A 50 fps
   *  source at source frame 100 is 2 s in, not 4. */
  it('converts through the clip\'s own source_fps when it has one', () => {
    const tl = timeline([
      track('audio', [clip({ source_path: '/a.m4a', source_fps: 50, duration: 500, source_len: 500 })]),
    ]);
    // clipAt converts the 50-timeline-frame offset into source frames itself;
    // what this pins is that the seconds divide by 50, not by the timeline's 25.
    const got = scrubSourceAt(tl, 50);
    expect(got).not.toBeNull();
    expect(got!.sourceSecs).toBeCloseTo(2, 6);
  });
});

describe('waveformWindowAt', () => {
  const source = {
    path: '/a.m4a',
    sourceSecs: 10,
    track: 0,
    clip: clip({ source_path: '/a.m4a', source_start: 0, duration: 250 }), // 0..10 s at 25 fps
  };

  /** The playhead sits dead centre and the picture scrolls under it — the
   *  property that makes the strip readable while dragging. */
  it('centres the window on the playhead', () => {
    const w = waveformWindowAt(source, FPS);
    expect(w.startSecs).toBe(10 - WAVEFORM_WINDOW_SECS / 2);
    expect(w.durationSecs).toBe(WAVEFORM_WINDOW_SECS);
    expect(w.playheadFraction).toBeCloseTo(0.5, 9);
  });

  /** …except at the head of a file, where there is no lead-in to show. The
   *  window clamps forward and the LINE moves instead of the window showing
   *  two seconds of material that does not exist. */
  it('clamps at the head of the source and moves the playhead line instead', () => {
    const w = waveformWindowAt({ ...source, sourceSecs: 0.5 }, FPS);
    expect(w.startSecs).toBe(0);
    expect(w.playheadFraction).toBeCloseTo(0.5 / WAVEFORM_WINDOW_SECS, 9);
  });

  /** The clip's own trimmed extent, as strip fractions — what the reference
   *  image's brighter inner region is, and what stops the strip implying that
   *  material outside the clip is on the timeline. */
  it('reports the clip\'s own extent as fractions of the strip', () => {
    // playhead at 1 s: window is [0, 4); the clip covers source [0, 10).
    const head = waveformWindowAt({ ...source, sourceSecs: 1 }, FPS);
    expect(head.clipStartFraction).toBeCloseTo(0, 9);
    expect(head.clipEndFraction).toBe(1); // clamped — the clip runs past the strip

    // playhead at 9.5 s: window is [7.5, 11.5); the clip ends at 10 s.
    const tail = waveformWindowAt({ ...source, sourceSecs: 9.5 }, FPS);
    expect(tail.clipStartFraction).toBe(0);
    expect(tail.clipEndFraction).toBeCloseTo((10 - 7.5) / 4, 9);
  });

  /** With no `source_fps` the clip's extent is measured at the PROJECT's rate:
   *  250 source frames at 25 fps is a 10 s clip, so with the playhead at its
   *  very out-point the window is [8, 12) and the clip's end lands dead centre —
   *  half the strip is material past the end of the clip, drawn dim. */
  it('falls back to the project fps for a clip with no source_fps', () => {
    const w = waveformWindowAt(source, FPS);
    expect(w.startSecs).toBe(8);
    expect(w.clipEndFraction).toBeCloseTo(0.5, 9);
  });
});

describe('waveformTileFor', () => {
  /** **The whole reason tiles exist** (D-128's defect, avoided rather than
   *  rediscovered): the peaks REQUEST must not change as the playhead moves, or
   *  every frame of a drag is a fresh `symphonia` decode. */
  it('is stable for every position inside one tile', () => {
    const a = waveformTileFor(4.01);
    expect(waveformTileFor(7.99)).toEqual(a);
    expect(waveformTileFor(8.01)).not.toEqual(a);
  });

  /** …and every window the strip can draw from inside that tile has to be fully
   *  inside the fetched range, in both directions, or the strip would go blank
   *  at a tile seam. */
  it('covers every window centred anywhere inside its own tile', () => {
    for (const index of [0, 1, 5]) {
      for (const offset of [0, 0.5, 0.999]) {
        const at = (index + offset) * WAVEFORM_TILE_SECS;
        const tile = waveformTileFor(at);
        const windowStart = Math.max(0, at - WAVEFORM_WINDOW_SECS / 2);
        expect(tile.startSecs).toBeLessThanOrEqual(windowStart);
        expect(tile.startSecs + tile.durationSecs).toBeGreaterThanOrEqual(
          windowStart + WAVEFORM_WINDOW_SECS,
        );
      }
    }
  });

  it('never asks for audio before the start of the file, whatever it is given', () => {
    expect(waveformTileFor(0).startSecs).toBe(0);
    expect(waveformTileFor(1).startSecs).toBe(0);
    expect(waveformTileFor(-5).startSecs).toBe(0);
    expect(waveformTileFor(Number.NaN).startSecs).toBe(0);
  });

  it('always asks for a real, positive bucket count', () => {
    expect(waveformTileFor(30).buckets).toBeGreaterThan(0);
    expect(waveformTileFor(0).buckets).toBeGreaterThan(0);
  });
});
