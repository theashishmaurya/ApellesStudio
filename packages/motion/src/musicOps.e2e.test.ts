/**
 * D-413 — the four soundtrack ops end to end through the real op registry
 * (`createMotionOps`), with the guarded commit (a document that would not
 * parse is refused) and the asset import / beat analysis faked at the context
 * seam, which is where the app injects the Tauri calls.
 *
 * The story: import a song as the soundtrack (an image is refused), read the
 * beats of scene 0, time the reveal / scale / accents to them as one commit
 * (after a dry run that commits nothing), snap the rest, and remove the song.
 */
import { describe, expect, it } from 'vitest';
import type { FileBeats } from '@apelles/beats';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { createMotionOps, type MotionOpsApi } from './motionOps';
import { IDLE_RENDER_STATUS } from './renderLoop';
import { beatsFixture, musicDoc } from './fixtures/musicDoc';

const HASH = 'b'.repeat(64);

function harness(initial: Manifest) {
  const state = { manifest: initial as Manifest | null };
  const commits: string[] = [];
  const analysed: string[] = [];
  const api: MotionOpsApi = {
    loadState: 'ready',
    get manifest() {
      return state.manifest;
    },
    parseError: null,
    dirty: false,
    saveError: null,
    commit: (next, label) => {
      commits.push(label);
      state.manifest = next;
    },
    save: async () => ({ ok: true, path: '/p' }) as never,
    render: async () => ({ ok: true }) as never,
    reloadFromDisk: async () => ({ ok: true }) as never,
    renderStatus: IDLE_RENDER_STATUS,
  };
  const ops = createMotionOps({
    api: () => api,
    selections: () => [],
    setSelections: () => undefined,
    player: () => null,
    importAsset: async (path) => ({
      id: path.endsWith('.png') ? `sha256:${HASH}.png` : `sha256:${HASH}.mp3`,
      fileName: 'x',
      path,
      bytes: 1,
      kind: path.endsWith('.png') ? 'image' : 'audio',
      copied: true,
      width: null,
      height: null,
    }),
    soundtrackBeats: async (st): Promise<FileBeats> => {
      analysed.push(st.src);
      return {
        path: '/assets/song.mp3',
        contentHash: 'h',
        params: { meter: st.meter ?? 4 },
        truncated: false,
        cached: false,
        analysis: beatsFixture(),
      };
    },
  });
  return { ops, state, commits, analysed };
}

describe('soundtrack ops (D-413)', () => {
  it('sets the soundtrack, reads beats, times moves to them as one undo step, snaps and clears', async () => {
    const start = musicDoc();
    delete start.soundtrack;
    const h = harness(start);

    // No soundtrack yet: the beat ops say how to get one.
    expect((await h.ops.motion_get_beats({ scene_index: 0 })).error).toMatch(/motion_set_soundtrack/);

    // An image is not a soundtrack.
    expect((await h.ops.motion_set_soundtrack({ path: '/x/logo.png' })).error).toMatch(/not an audio file/);
    expect(h.commits).toEqual([]);

    const set = await h.ops.motion_set_soundtrack({ path: '/music/song.mp3', offset: 0, volume: 0.8, meter: 4 });
    expect(set).toMatchObject({ ok: true, tempoBpm: 120, beatsInDocument: 14, downbeatsInDocument: 4 });
    expect(set.soundtrack).toEqual({ src: `sha256:${HASH}.mp3`, offset: 0, volume: 0.8, meter: 4 });
    expect((set.scenes as unknown[])[1]).toMatchObject({ sceneIndex: 1, id: 'outro', beats: 6, firstDownbeatAt: 0 });
    expect(h.commits).toEqual(['Soundtrack']);
    expect(manifestSchema.safeParse(h.state.manifest).success).toBe(true);

    // Re-setting only `render` keeps the rest.
    await h.ops.motion_set_soundtrack({ render: true });
    expect(h.state.manifest?.soundtrack).toMatchObject({ volume: 0.8, render: true });

    const beats = await h.ops.motion_get_beats({ scene_index: 0, kind: 'downbeat' });
    expect(beats).toMatchObject({ count: 2, tempoBpm: 120 });
    expect((beats.beats as Array<{ at: number }>).map((b) => b.at)).toEqual([0, 2]);

    const moves = [
      { name: 'reveal', cue: 'downbeat 1', layer: 'hero', track: 'enter' },
      { name: 'scale', cue: 'next strong beat', layer: 'hero', track: 'transform', anchor: 'end' },
      { name: 'accents', cue: 'every beat between', layers: ['dot1'], track: 'enter' },
    ];
    const before = h.commits.length;
    const dry = await h.ops.motion_time_to_music({ scene_index: 0, moves, dry_run: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    expect(h.commits).toHaveLength(before);

    const timed = await h.ops.motion_time_to_music({ scene_index: 0, moves });
    expect(timed.ok).toBe(true);
    expect(h.commits.slice(before)).toEqual(['Time to music']);
    const hero = h.state.manifest?.scenes[0].layers?.[0] as unknown as { at: number; transform: { keys: { at: number }[] } };
    expect(hero.at).toBe(0);
    expect(hero.transform.keys.map((k) => k.at)).toEqual([0.5, 1]);

    // A refusal names the move and commits nothing.
    const bad = await h.ops.motion_time_to_music({ scene_index: 0, moves: [{ name: 'boom', cue: 'downbeat 9', layer: 'hero' }] });
    expect(bad).toMatchObject({ move: 'boom' });
    expect(bad.error).toMatch(/has 2/);
    expect(h.commits.slice(before)).toEqual(['Time to music']);

    const snapped = await h.ops.motion_snap_to_beats({ scene_index: 0, layers: ['hero'], tolerance_s: 0.15 });
    expect(snapped).toMatchObject({ ok: true, moved: 2 });
    expect(h.commits.at(-1)).toBe('Snap keys to beats');

    expect((await h.ops.motion_snap_to_beats({ scene_index: 0, tolerance_s: -1 })).error).toMatch(/tolerance_s/);
    expect((await h.ops.motion_get_beats({ scene_index: 9 })).error).toMatch(/scene_index/);

    await h.ops.motion_set_soundtrack({ clear: true });
    expect(h.state.manifest?.soundtrack).toBeUndefined();
    expect(h.commits.at(-1)).toBe('Remove soundtrack');
    expect(h.analysed.every((s) => s === `sha256:${HASH}.mp3`)).toBe(true);
  });

  it('refuses bad analysis params and a non-audio asset id', async () => {
    const h = harness(musicDoc());
    expect((await h.ops.motion_set_soundtrack({ meter: 12 })).error).toMatch(/meter/);
    expect((await h.ops.motion_set_soundtrack({ asset: `sha256:${HASH}.png` })).error).toMatch(/audio asset id/);
    expect((await h.ops.motion_set_soundtrack({ volume: 3 })).error).toMatch(/volume/);
  });
});
