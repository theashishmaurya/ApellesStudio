// @chroma/editor — unit tests for canvas click-to-select's pure hit-testing
// (D-202, fixing B-085). See `canvasPick.ts`'s module doc for what this
// deliberately does and does not model; DOM-free for the same reason
// `transformGeometry.test.ts` is (this package's vitest env is bare `node`).
import { describe, expect, it } from 'vitest';

import { layerBoxFraction, pickTopmostLayer, visibleVideoLayersAt, type PickCandidate } from './canvasPick';
import type { Clip, Timeline, Track } from './timeline';

function clip(id: string, startFrame: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/${id}.mp4`,
    source_start: 0,
    duration,
    source_len: 1000,
    start_frame: startFrame,
    ...extra,
  };
}

function videoTrack(clips: Clip[], extra: Partial<Track> = {}): Track {
  return { kind: 'video', clips, ...extra };
}

function timeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'tl', rate: { num: 24, den: 1 }, tracks };
}

/** A full-frame source (its own resolution exactly fills the composition) —
 *  the `naturalWidth`/`naturalHeight` `chroma_timeline_clip_geometry` reports
 *  for a clip shot at the project's own output size. */
const FULL_FRAME = { width: 1, height: 1 };

describe('visibleVideoLayersAt', () => {
  it('returns nothing for a null timeline', () => {
    expect(visibleVideoLayersAt(null, 0)).toEqual([]);
  });

  it('returns every video track with content at that frame, topmost (track 0) first', () => {
    const tl = timeline([videoTrack([clip('a', 0, 100)]), videoTrack([clip('b', 0, 100)])]);
    const layers = visibleVideoLayersAt(tl, 10);
    expect(layers.map((l) => [l.track, l.clip.id])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
  });

  it('omits a track whose clips do not cover that frame (a gap)', () => {
    const tl = timeline([videoTrack([clip('a', 0, 100)]), videoTrack([clip('b', 0, 50), clip('c', 100, 100)])]);
    expect(visibleVideoLayersAt(tl, 60).map((l) => l.track)).toEqual([0]);
  });

  it('omits a hidden track even when it has content there — mirrors the compositor', () => {
    const tl = timeline([videoTrack([clip('a', 0, 100)]), videoTrack([clip('b', 0, 100)], { hidden: true })]);
    expect(visibleVideoLayersAt(tl, 10).map((l) => l.track)).toEqual([0]);
  });

  it('omits an audio track entirely', () => {
    const tl = timeline([{ kind: 'audio', clips: [clip('music', 0, 100)] }, videoTrack([clip('a', 0, 100)])]);
    expect(visibleVideoLayersAt(tl, 10).map((l) => l.clip.id)).toEqual(['a']);
  });

  it('INCLUDES a locked track — locking blocks edits, not selection', () => {
    const tl = timeline([videoTrack([clip('a', 0, 100)], { locked: true })]);
    expect(visibleVideoLayersAt(tl, 10).map((l) => l.clip.id)).toEqual(['a']);
  });

  it('reports the clip INDEX, not just the clip — the index every per-clip command takes', () => {
    const tl = timeline([videoTrack([clip('a', 0, 50), clip('b', 50, 50)])]);
    expect(visibleVideoLayersAt(tl, 60)[0]).toMatchObject({ track: 0, clipIndex: 1 });
  });

  it('finds a clip by its real start_frame, not its position in the Vec (D-054)', () => {
    // Deliberately stored out of time order, the way a real reorder leaves it.
    const tl = timeline([videoTrack([clip('later', 50, 50), clip('earlier', 0, 50)])]);
    expect(visibleVideoLayersAt(tl, 10)[0]).toMatchObject({ clipIndex: 1, clip: { id: 'earlier' } });
  });
});

describe('layerBoxFraction', () => {
  it('is the identity box for a full-frame, untransformed clip', () => {
    expect(layerBoxFraction(clip('a', 0, 10), FULL_FRAME)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it('applies scale about the clip centre and then position', () => {
    const box = layerBoxFraction(clip('a', 0, 10, { scale: 0.5, position_x: 0.25 }), FULL_FRAME);
    expect(box).toEqual({ left: 0.5, top: 0.25, width: 0.5, height: 0.5 });
  });

  it('honours an independent box_width/box_height override per axis (D-193)', () => {
    const box = layerBoxFraction(clip('a', 0, 10, { scale: 0.5, box_width: 0.8 }), FULL_FRAME);
    expect(box.width).toBeCloseTo(0.8); // override wins on x
    expect(box.height).toBeCloseTo(0.5); // scale still drives y
  });
});

describe('pickTopmostLayer', () => {
  const candidate = (track: number, c: Clip, natural: { width: number; height: number } | null): PickCandidate => ({
    track,
    clipIndex: 0,
    clip: c,
    natural,
  });

  it('returns null on empty canvas — no layers at all', () => {
    expect(pickTopmostLayer({ x: 0.5, y: 0.5 }, [])).toBeNull();
  });

  it('returns null for a point outside every layer box', () => {
    const small = clip('a', 0, 10, { scale: 0.2 });
    expect(pickTopmostLayer({ x: 0.05, y: 0.05 }, [candidate(0, small, FULL_FRAME)])).toBeNull();
  });

  it('hits a layer whose box contains the point', () => {
    const c = clip('a', 0, 10);
    expect(pickTopmostLayer({ x: 0.5, y: 0.5 }, [candidate(0, c, FULL_FRAME)])).toMatchObject({
      track: 0,
      clip: { id: 'a' },
    });
  });

  it('picks the TOPMOST of two overlapping layers, not the last one checked', () => {
    // Both full-frame and both covering the centre; track 0 is painted on top
    // (`resolve_visible_video_layers_at` order), so it must win.
    const candidates = [candidate(0, clip('top', 0, 10), FULL_FRAME), candidate(1, clip('under', 0, 10), FULL_FRAME)];
    expect(pickTopmostLayer({ x: 0.5, y: 0.5 }, candidates)?.clip.id).toBe('top');
  });

  it('falls through to a lower layer when the topmost one does not cover the point', () => {
    // A quarter-size PIP parked in the upper-left, over a full-frame layer.
    const pip = clip('pip', 0, 10, { scale: 0.25, position_x: -0.3, position_y: -0.3 });
    const candidates = [candidate(0, pip, FULL_FRAME), candidate(1, clip('bg', 0, 10), FULL_FRAME)];
    expect(pickTopmostLayer({ x: 0.2, y: 0.2 }, candidates)?.clip.id).toBe('pip');
    expect(pickTopmostLayer({ x: 0.8, y: 0.8 }, candidates)?.clip.id).toBe('bg');
  });

  it('skips a layer whose geometry has not resolved, without blocking a lower one', () => {
    const candidates = [candidate(0, clip('unprobed', 0, 10), null), candidate(1, clip('bg', 0, 10), FULL_FRAME)];
    expect(pickTopmostLayer({ x: 0.5, y: 0.5 }, candidates)?.clip.id).toBe('bg');
  });

  it('is half-open on the right/bottom edge, so abutting boxes never both claim a point', () => {
    // Left half and right half of the frame, exactly touching at x = 0.5.
    const left = clip('left', 0, 10, { box_width: 0.5, position_x: -0.25 });
    const right = clip('right', 0, 10, { box_width: 0.5, position_x: 0.25 });
    const candidates = [candidate(0, left, FULL_FRAME), candidate(1, right, FULL_FRAME)];
    expect(pickTopmostLayer({ x: 0.49999, y: 0.5 }, candidates)?.clip.id).toBe('left');
    expect(pickTopmostLayer({ x: 0.5, y: 0.5 }, candidates)?.clip.id).toBe('right');
  });
});
