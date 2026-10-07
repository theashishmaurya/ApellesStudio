/**
 * editLinks.test.ts — D-260's Motion→Edit link resolution.
 *
 * The one thing the badge, `motion_get_edit_links` and the composition root's
 * "refreshed N clips" toast all read, so getting it wrong is wrong in three
 * visible places at once.
 */
import { describe, it, expect } from 'vitest';

import {
  checkSceneRename,
  computeEditLinks,
  clipReadsItem,
  type EditLinkClip,
  type EditLinkTrack,
} from './editLinks';
import type { MotionEditLinks } from './motionOps';

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
      hook: { mediaId: 'm1', sourcePath: '/hook.mp4', clips: [], refreshedByRender: null },
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

// ---------------------------------------------------------------------------
// B-219/D-359 — a project COPIED on the filesystem
// ---------------------------------------------------------------------------

/** The two projects B-219 is made of: the same relative media layout under two
 *  different absolute roots. `ORIGINAL` is the project that was copied; `COPY`
 *  is the one now open, whose `project.json` still names ORIGINAL's files. */
const ORIGINAL = '/Movies/Chroma/c040-mgfx.chroma';
const COPY = '/Movies/Chroma/c040-mgfx-recut.chroma';
const ORIGINAL_RENDER = ORIGINAL + '/motion/renders/hook.mp4';
const COPY_RENDER = COPY + '/motion/renders/hook.mp4';

describe('computeEditLinks — the copied-project case (B-219)', () => {
  it('THE headline: an inherited item is reported as NOT refreshed by a render', () => {
    // The copy has never been re-rendered, so its only stamped item is the
    // one it inherited — pointing into the ORIGINAL project, where no render
    // of ours writes. Two clips are placed from it and look perfectly linked.
    const links = computeEditLinks(
      [item('m1', ORIGINAL_RENDER, 'hook')],
      [track(clip('c1', ORIGINAL_RENDER, 'm1'), clip('c2', ORIGINAL_RENDER, 'm1'))],
      COPY,
    );
    expect(links.hook.refreshedByRender).toBe(false);
    expect(links.hook.sourcePath).toBe(ORIGINAL_RENDER);
    // the clips ARE reading it — that fact is unchanged and still reported
    expect(links.hook.clips.map((c) => c.clipId)).toEqual(['c1', 'c2']);
  });

  it("the copy's OWN render wins over the inherited one, whatever the pool order", () => {
    // This is the exact live shape B-219 was found in: the inherited item is
    // FIRST (it came over with project.json) and the copy's own render was
    // appended after it. "The first wins" picked precisely the wrong file.
    const links = computeEditLinks(
      [item('m1', ORIGINAL_RENDER, 'hook'), item('m2', COPY_RENDER, 'hook')],
      [track(clip('c1', ORIGINAL_RENDER, 'm1'), clip('c2', COPY_RENDER, 'm2'))],
      COPY,
    );
    expect(links.hook.mediaId).toBe('m2');
    expect(links.hook.sourcePath).toBe(COPY_RENDER);
    expect(links.hook.refreshedByRender).toBe(true);
    // and it counts the clips reading the file a re-render actually writes
    expect(links.hook.clips.map((c) => c.clipId)).toEqual(['c2']);
  });

  it('a render inside the open project is refreshable', () => {
    const links = computeEditLinks(
      [item('m1', COPY_RENDER, 'hook')],
      [track(clip('c1', COPY_RENDER, 'm1'))],
      COPY,
    );
    expect(links.hook.refreshedByRender).toBe(true);
  });

  it('is null — never true — when no project root is supplied', () => {
    // "we were not told where the project is" must not read as "yes, this
    // will be refreshed". Same two-kinds-of-no discipline as `available`.
    expect(computeEditLinks([item('m1', ORIGINAL_RENDER, 'hook')], []).hook.refreshedByRender).toBeNull();
    expect(computeEditLinks([item('m1', ORIGINAL_RENDER, 'hook')], [], '').hook.refreshedByRender).toBeNull();
  });

  it('a sibling project whose NAME merely extends this one is a different project', () => {
    // `/…/c040.chroma-recut` starts with the string `/…/c040.chroma` and is
    // not inside it. A bare `startsWith` would call this refreshable — and
    // this is the exact pair of names the bug was found on.
    const links = computeEditLinks(
      [item('m1', '/Movies/Chroma/c040.chroma-recut/motion/renders/hook.mp4', 'hook')],
      [],
      '/Movies/Chroma/c040.chroma',
    );
    expect(links.hook.refreshedByRender).toBe(false);
  });

  it('a trailing slash on the project root changes nothing', () => {
    const withSlash = COPY + '/';
    expect(computeEditLinks([item('m1', COPY_RENDER, 'hook')], [], withSlash).hook.refreshedByRender).toBe(true);
    expect(computeEditLinks([item('m1', ORIGINAL_RENDER, 'hook')], [], withSlash).hook.refreshedByRender).toBe(
      false,
    );
  });

  it('two INHERITED items still fall back to "the first wins"', () => {
    // The tie-break only overturns the order when one side is genuinely
    // in-project; two equally-unreachable items keep the old, documented rule
    // rather than picking arbitrarily.
    const links = computeEditLinks(
      [item('m1', ORIGINAL_RENDER, 'hook'), item('m2', ORIGINAL + '/motion/renders/hook2.mp4', 'hook')],
      [],
      COPY,
    );
    expect(links.hook.mediaId).toBe('m1');
    expect(links.hook.refreshedByRender).toBe(false);
  });
});

/**
 * B-242/D-371 — the rename pre-flight.
 *
 * The orphan case is the one worth pinning hardest: before this check existed,
 * `motion_set_scene_field key="id"` wrote the rename straight through (with a
 * spurious "not a known scene field" warning attached), which silently voided
 * D-260's "a re-render refreshes the placed Edit clips" contract — the pool
 * item keeps the OLD id as its `motionSceneId` stamp and the clips keep
 * reading the OLD file, while the next render writes a new one under the new
 * name.
 */
describe('checkSceneRename (B-242/D-371)', () => {
  const scenes = [{ id: 'hook' }, { id: 'body' }, { id: 'outro' }];

  /** a link map exactly as `computeEditLinks` builds one. */
  const linked = (sceneId: string, clips: number, refreshedByRender: boolean | null = true): MotionEditLinks => ({
    [sceneId]: {
      mediaId: 'm1',
      sourcePath: `/p/.chroma/motion/renders/${sceneId}.mp4`,
      clips: Array.from({ length: clips }, (_, i) => ({
        track: 0,
        clip: i,
        clipId: `c${i}`,
        name: `${sceneId}.mp4`,
      })),
      refreshedByRender,
    },
  });

  it('allows a rename of a scene nothing links to', () => {
    expect(checkSceneRename(scenes, 0, 'c038-training', {})).toEqual({
      ok: true,
      from: 'hook',
      to: 'c038-training',
    });
  });

  it('allows a rename when no link data reached the tab at all', () => {
    // `undefined` is "no Edit timeline is mounted here", not "we did not look".
    expect(checkSceneRename(scenes, 0, 'c038-training', undefined).ok).toBe(true);
  });

  it('REFUSES a rename that would orphan placed Edit clips, and names them', () => {
    const r = checkSceneRename(scenes, 0, 'c038-training', linked('hook', 2));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.overridable).toBe(true);
    expect(r.reason).toContain('2 clip(s)');
    expect(r.reason).toContain('hook.mp4');
    expect(r.reason).toContain('motion/renders/c038-training.mp4');
    expect(r.reason).toContain('force: true');
  });

  it('REFUSES when the render is in Sources but never placed — the pool item is orphaned too', () => {
    const r = checkSceneRename(scenes, 0, 'c038-training', linked('hook', 0));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('not placed on the timeline');
  });

  it('force lifts the orphan refusal, and only that one', () => {
    expect(checkSceneRename(scenes, 0, 'c038-training', linked('hook', 2), { force: true }).ok).toBe(true);
    // a collision is not a tradeoff anyone can accept — force does not reach it
    const collide = checkSceneRename(scenes, 0, 'body', linked('hook', 2), { force: true });
    expect(collide.ok).toBe(false);
    if (collide.ok) return;
    expect(collide.overridable).toBe(false);
  });

  it('a link into a DIFFERENT project does not block the rename (B-219, same test renderStaleness uses)', () => {
    // No render of OURS exists under that id, so nothing of ours is orphaned.
    expect(checkSceneRename(scenes, 0, 'c038-training', linked('hook', 2, false)).ok).toBe(true);
  });

  it('a link on a DIFFERENT scene does not block this one', () => {
    expect(checkSceneRename(scenes, 0, 'c038-training', linked('outro', 3)).ok).toBe(true);
  });

  it('renaming a scene to the id it already has is a no-op, link or no link', () => {
    expect(checkSceneRename(scenes, 0, 'hook', linked('hook', 2))).toEqual({
      ok: true,
      from: 'hook',
      to: 'hook',
    });
  });

  it('refuses a collision with another scene — two scenes would render to one file', () => {
    const r = checkSceneRename(scenes, 0, 'outro', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.overridable).toBe(false);
    expect(r.reason).toContain('scene 2 is already called');
  });

  it('refuses a non-string id, which is how `value: null` (delete the field) arrives', () => {
    for (const bad of [null, undefined, 7, { id: 'x' }]) {
      const r = checkSceneRename(scenes, 0, bad, {});
      expect(r.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false);
    }
  });

  it('refuses an empty or whitespace-only id', () => {
    expect(checkSceneRename(scenes, 0, '', {}).ok).toBe(false);
    expect(checkSceneRename(scenes, 0, '   ', {}).ok).toBe(false);
  });

  it('refuses leading/trailing whitespace — invisible on screen, real in the filename', () => {
    expect(checkSceneRename(scenes, 0, ' hook2', {}).ok).toBe(false);
    expect(checkSceneRename(scenes, 0, 'hook2 ', {}).ok).toBe(false);
  });

  it('refuses an id that is not usable as a filename — `default_output_path` does no escaping', () => {
    // `motion.rs`'s `default_output_path` joins the id straight onto
    // `<project>.chroma/motion/renders/` with `.mp4`, so these walk out of the
    // project or produce an unaddressable path.
    const bad = ['../../etc/passwd', 'a/b', 'a\\b', 'a' + String.fromCharCode(0) + 'b', 'a\nb', '.', '..'];
    for (const id of bad) {
      expect(checkSceneRename(scenes, 0, id, {}).ok, `expected ${JSON.stringify(id)} to be refused`).toBe(false);
    }
  });

  it('refuses an out-of-range scene index', () => {
    const r = checkSceneRename(scenes, 9, 'x', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('no scene at index 9');
  });
});
