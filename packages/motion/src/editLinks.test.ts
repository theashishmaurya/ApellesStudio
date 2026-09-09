/**
 * editLinks.test.ts — D-259's Motion→Edit link resolution.
 *
 * The one thing the badge, `motion_get_edit_links` and the composition root's
 * "refreshed N clips" toast all read, so getting it wrong is wrong in three
 * visible places at once.
 */
import { describe, it, expect } from 'vitest';

import { computeEditLinks, clipReadsItem, type EditLinkClip, type EditLinkTrack } from './editLinks';

const item = (id: string, sourcePath: string, motionSceneId?: string | null) => ({
  id,
  sourcePath,
  motionSceneId,
});

const clip = (id: string, source_path: string, media_id?: string | null): EditLinkClip => ({
  id,
  name: id,
  source_path,
  media_id,
});

const track = (...clips: EditLinkClip[]): EditLinkTrack => ({ clips });

describe('computeEditLinks', () => {
  it('links a scene to the clips reading its rendered file, by media id', () => {
    const links = computeEditLinks(
      [item('m1', '/p/.chroma/motion/renders/hook.mp4', 'hook')],
      [track(clip('c1', '/p/.chroma/motion/renders/hook.mp4', 'm1'), clip('c2', '/other.mp4', 'm9'))],
    );
    expect(Object.keys(links)).toEqual(['hook']);
    expect(links.hook.mediaId).toBe('m1');
    expect(links.hook.sourcePath).toBe('/p/.chroma/motion/renders/hook.mp4');
    expect(links.hook.clips).toEqual([{ track: 0, clip: 0, clipId: 'c1', name: 'c1' }]);
  });

  it('counts every placement across every track, with real track/clip indices', () => {
    const links = computeEditLinks(
      [item('m1', '/hook.mp4', 'hook')],
      [
        track(clip('a', '/other.mp4', 'm9'), clip('b', '/hook.mp4', 'm1')),
        track(clip('c', '/hook.mp4', 'm1')),
      ],
    );
    expect(links.hook.clips).toEqual([
      { track: 0, clip: 1, clipId: 'b', name: 'b' },
      { track: 1, clip: 0, clipId: 'c', name: 'c' },
    ]);
  });

  it('falls back to source_path for a clip with no media_id (a pre-pool clip)', () => {
    const links = computeEditLinks(
      [item('m1', '/hook.mp4', 'hook')],
      [track(clip('a', '/hook.mp4', null), clip('b', '/hook.mp4'))],
    );
    expect(links.hook.clips.map((c) => c.clipId)).toEqual(['a', 'b']);
  });

  it('does not match a clip whose media_id points elsewhere even at the same path', () => {
    // A clip explicitly bound to a DIFFERENT pool item is not this scene's,
    // whatever its path happens to say — `media_id` is the stronger link and
    // must win when it is present. (Two pool items can reference one file.)
    const links = computeEditLinks(
      [item('m1', '/hook.mp4', 'hook')],
      [track(clip('a', '/hook.mp4', 'm2'))],
    );
    expect(links.hook.clips).toEqual([]);
  });

  it('a scene rendered but never placed is present with zero clips — not absent', () => {
    const links = computeEditLinks([item('m1', '/hook.mp4', 'hook')], [track(clip('a', '/x.mp4', 'm9'))]);
    expect(links.hook).toBeDefined();
    expect(links.hook.clips).toEqual([]);
  });

  it('a pool item with no Motion stamp contributes nothing at all', () => {
    // The zero-cost half of the design: an ordinary imported clip must never
    // appear in this map, however it is placed.
    const links = computeEditLinks(
      [item('m1', '/footage.mov'), item('m2', '/music.wav', null)],
      [track(clip('a', '/footage.mov', 'm1'))],
    );
    expect(links).toEqual({});
  });

  it('is empty for an empty pool, and for a pool with no timeline', () => {
    expect(computeEditLinks([], [track(clip('a', '/x.mp4', 'm1'))])).toEqual({});
    expect(computeEditLinks([item('m1', '/hook.mp4', 'hook')], [])).toEqual({
      hook: { mediaId: 'm1', sourcePath: '/hook.mp4', clips: [] },
    });
  });

  it('two items stamped with one scene id: the first wins, counts are not summed', () => {
    // Only reachable by hand-editing project.json. Summing across two
    // different FILES would report a refresh count no re-render can deliver.
    const links = computeEditLinks(
      [item('m1', '/a.mp4', 'hook'), item('m2', '/b.mp4', 'hook')],
      [track(clip('x', '/a.mp4', 'm1'), clip('y', '/b.mp4', 'm2'))],
    );
    expect(links.hook.mediaId).toBe('m1');
    expect(links.hook.clips.map((c) => c.clipId)).toEqual(['x']);
  });
});

describe('clipReadsItem', () => {
  it('is the same rule computeEditLinks counts with', () => {
    const it1 = item('m1', '/hook.mp4', 'hook');
    expect(clipReadsItem(clip('a', '/hook.mp4', 'm1'), it1)).toBe(true);
    expect(clipReadsItem(clip('a', '/hook.mp4', null), it1)).toBe(true);
    expect(clipReadsItem(clip('a', '/hook.mp4', 'm2'), it1)).toBe(false);
    expect(clipReadsItem(clip('a', '/other.mp4'), it1)).toBe(false);
  });
});
