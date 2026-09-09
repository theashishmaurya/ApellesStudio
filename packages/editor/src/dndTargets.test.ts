/**
 * @apelles/editor — the `@dnd-kit` payload contract (B-122).
 *
 * **The case that matters most is test 1 of `laneDropTrack`:** the exact
 * payload a track HEADER puts on `over.data.current`, fed to the function that
 * answers "which lane is this over". Before B-122 both droppables said
 * `type: 'track'`, so the header passed the discriminator check and yielded
 * `undefined` as a track index — `tracks[undefined]`, then
 * `resolveClipLanding`'s `dest.clips`, an unhandled `TypeError` that killed the
 * render tree and the dev server with it.
 *
 * **Why these are unit tests rather than a DOM drag.** `TimelinePane.trim.dom.
 * test.tsx` documents the reason in its own header: dnd-kit resolves no `over`
 * at all under jsdom (its collision detection never yields one), so a
 * drop-on-a-header cannot be driven end to end in that tier. Rather than assert
 * nothing, the decision that was wrong is now a pure function — so the crashing
 * input is a value a test can simply pass in. That is the honest version of
 * this coverage, and it is stronger than a DOM test would have been anyway:
 * it pins the CONTRACT, not one gesture that happens to reach it.
 */

import { describe, expect, it } from 'vitest';

import {
  asClipDrag,
  asTrackHeaderDrag,
  headerDropIndex,
  laneDropTrack,
} from './dndTargets';

/** Exactly what `SortableTrackHeader`'s `useSortable` puts on its data — the
 *  payload that crashed the app when read as a lane. */
const HEADER = { type: 'track-header', index: 1 };
/** Exactly what `TrackDropZone`'s `useDroppable` puts on its data. */
const LANE = { type: 'track-lane', track: 1 };
/** Exactly what `ClipBody`'s `useDraggable` puts on its data. */
const CLIP = { type: 'clip', track: 0, clipId: 'v' };
/** The transitions palette's own (D-226), which shares this `DndContext`. */
const TRANSITION = { type: 'transition', kind: 'cross_dissolve' };

const TRACKS = 3;

describe('laneDropTrack — which real track a drop is over', () => {
  it('1. B-122: a track HEADER is NOT a lane — this is the payload that crashed the app', () => {
    // The whole bug in one line. Under the old shared `type: 'track'`, this
    // returned `undefined` and the caller indexed `tracks` with it.
    expect(laneDropTrack(HEADER, TRACKS)).toBeNull();
  });

  it('2. a real lane resolves to its own track index', () => {
    expect(laneDropTrack(LANE, TRACKS)).toBe(1);
    expect(laneDropTrack({ type: 'track-lane', track: 0 }, TRACKS)).toBe(0);
    expect(laneDropTrack({ type: 'track-lane', track: TRACKS - 1 }, TRACKS)).toBe(TRACKS - 1);
  });

  it('3. a lane naming a track that no longer exists is not a landing', () => {
    // Reachable with no bug at all: dnd-kit caches droppable data for the
    // whole gesture, so an undo or an MCP call that removes a track mid-drag
    // leaves a stale index behind.
    expect(laneDropTrack({ type: 'track-lane', track: TRACKS }, TRACKS)).toBeNull();
    expect(laneDropTrack({ type: 'track-lane', track: TRACKS + 7 }, TRACKS)).toBeNull();
    expect(laneDropTrack({ type: 'track-lane', track: -1 }, TRACKS)).toBeNull();
    // …and on a timeline with no tracks at all, nothing is ever a landing.
    expect(laneDropTrack(LANE, 0)).toBeNull();
  });

  it('4. a malformed or missing payload is not a landing either', () => {
    expect(laneDropTrack(undefined, TRACKS)).toBeNull();
    expect(laneDropTrack(null, TRACKS)).toBeNull();
    expect(laneDropTrack({}, TRACKS)).toBeNull();
    expect(laneDropTrack({ type: 'track-lane' }, TRACKS)).toBeNull();
    expect(laneDropTrack({ type: 'track-lane', track: '1' }, TRACKS)).toBeNull();
    expect(laneDropTrack({ type: 'track-lane', track: 1.5 }, TRACKS)).toBeNull();
    expect(laneDropTrack({ type: 'track-lane', track: Number.NaN }, TRACKS)).toBeNull();
  });

  it('5. the other two drag kinds are not lanes', () => {
    expect(laneDropTrack(CLIP, TRACKS)).toBeNull();
    expect(laneDropTrack(TRANSITION, TRACKS)).toBeNull();
  });
});

describe('headerDropIndex — which track a REORDER is over', () => {
  it('6. a header resolves to its own index', () => {
    expect(headerDropIndex(HEADER, TRACKS)).toBe(1);
  });

  it('7. B-122, the mirror image: a LANE is not a reorder target', () => {
    // The same confusion in the other direction. It never crashed — the
    // reorder path reads `.index`, which a lane simply lacks, so it silently
    // did nothing instead. Both directions are wrong; both are refused now.
    expect(headerDropIndex(LANE, TRACKS)).toBeNull();
  });

  it('8. an index outside the real track list is refused', () => {
    expect(headerDropIndex({ type: 'track-header', index: TRACKS }, TRACKS)).toBeNull();
    expect(headerDropIndex({ type: 'track-header', index: -1 }, TRACKS)).toBeNull();
  });

  it('9. malformed payloads are refused', () => {
    expect(headerDropIndex(undefined, TRACKS)).toBeNull();
    expect(headerDropIndex({ type: 'track-header' }, TRACKS)).toBeNull();
    expect(headerDropIndex({ type: 'track-header', index: 'top' }, TRACKS)).toBeNull();
  });
});

describe('asClipDrag / asTrackHeaderDrag — which gesture is in flight', () => {
  it('10. each recognises its own payload and nothing else', () => {
    expect(asClipDrag(CLIP)).toEqual({ type: 'clip', track: 0, clipId: 'v' });
    expect(asClipDrag(HEADER)).toBeNull();
    expect(asClipDrag(LANE)).toBeNull();
    expect(asClipDrag(TRANSITION)).toBeNull();

    expect(asTrackHeaderDrag(HEADER)).toEqual({ type: 'track-header', index: 1 });
    expect(asTrackHeaderDrag(CLIP)).toBeNull();
    expect(asTrackHeaderDrag(LANE)).toBeNull();
    expect(asTrackHeaderDrag(TRANSITION)).toBeNull();
  });

  it('11. a payload with the right type but the wrong fields is refused, not half-trusted', () => {
    // The failure mode a cast has and a check does not: `type` alone was never
    // enough to know the rest of the shape is there.
    expect(asClipDrag({ type: 'clip', track: 0 })).toBeNull();
    expect(asClipDrag({ type: 'clip', clipId: 'v' })).toBeNull();
    expect(asClipDrag({ type: 'clip', track: '0', clipId: 'v' })).toBeNull();
    expect(asTrackHeaderDrag({ type: 'track-header', index: null })).toBeNull();
  });

  it('12. nothing throws on any junk input — these run inside drag handlers', () => {
    const junk = [undefined, null, {}, { type: 42 }, { type: 'track' }, [], 'clip'];
    for (const v of junk) {
      const payload = v as Record<string, unknown> | undefined | null;
      expect(() => asClipDrag(payload)).not.toThrow();
      expect(() => asTrackHeaderDrag(payload)).not.toThrow();
      expect(() => laneDropTrack(payload, TRACKS)).not.toThrow();
      expect(() => headerDropIndex(payload, TRACKS)).not.toThrow();
    }
  });

  it('13. the legacy shared discriminator is now recognised by nothing', () => {
    // Belt and braces against a regression: if anyone reintroduces
    // `type: 'track'` on either droppable, every reader refuses it rather than
    // half-matching one of them.
    const legacyHeader = { type: 'track', index: 1 };
    const legacyLane = { type: 'track', track: 1 };
    expect(laneDropTrack(legacyHeader, TRACKS)).toBeNull();
    expect(laneDropTrack(legacyLane, TRACKS)).toBeNull();
    expect(headerDropIndex(legacyHeader, TRACKS)).toBeNull();
    expect(headerDropIndex(legacyLane, TRACKS)).toBeNull();
    expect(asTrackHeaderDrag(legacyHeader)).toBeNull();
  });
});
