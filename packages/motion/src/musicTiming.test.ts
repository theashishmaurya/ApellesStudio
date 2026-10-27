/**
 * D-413 — timing moves to the soundtrack: beats per scene, the reel's
 * "reveal on the first downbeat, land the scale on the next strong beat,
 * accents between", refusals, and snapping keys to beats.
 */
import { describe, expect, it } from 'vitest';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import { compositionBeats, sceneBeats, snapKeysToBeats, timeToMusic } from './musicTiming';
import { beatsFixture, musicDoc } from './fixtures/musicDoc';

describe('beats on the document', () => {
  it('places the music on the composition and in each scene', () => {
    const doc = musicDoc();
    expect(compositionBeats(doc, beatsFixture())).toHaveLength(14); // 7 s of 0.5 s beats
    const outro = sceneBeats(doc, 1, beatsFixture());
    expect(outro[0]).toMatchObject({ n: 1, at: 0, downbeat: true, bar: 3 });
    expect(outro.map((b) => b.at)).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
  });
  it('an offset shifts which music each scene hears', () => {
    const doc = musicDoc(0.25); // the document starts 0.25 s into the music
    const intro = sceneBeats(doc, 0, beatsFixture());
    expect(intro[0].at).toBe(0.25);
    expect(intro[0].bar).toBe(1);
    expect(intro[0].beat).toBe(2);
  });
});

describe('time to music', () => {
  const beats = sceneBeats(musicDoc(), 0, beatsFixture());

  it('reveal on downbeat 1, land the scale on the next strong beat, accents between', () => {
    const r = timeToMusic(musicDoc(), 0, beats, [
      { name: 'reveal', cue: 'downbeat 1', layer: 'hero', track: 'enter' },
      { name: 'scale', cue: 'next strong beat', layer: 'hero', track: 'transform', anchor: 'end' },
      { name: 'accents', cue: 'every beat between', layers: ['dot1'], track: 'enter' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hero = r.manifest.scenes[0].layers?.[0] as unknown as { at: number; transform: { keys: { at: number }[] } };
    expect(hero.at).toBe(0); // downbeat 1
    // The scale's LAST key lands on 1.0 s (the next strong beat after 0);
    // its first key keeps the 0.5 s it had before it.
    expect(hero.transform.keys.map((k) => k.at)).toEqual([0.5, 1]);
    const dot1 = r.manifest.scenes[0].layers?.[1] as unknown as { at: number };
    expect(dot1.at).toBe(0.5); // the one beat strictly between 0 and 1.0
    expect(r.moves[1]).toMatchObject({ name: 'scale', beats: [1] });
    // Nothing else moved: the anim track is untouched.
    expect((r.manifest.scenes[0].layers?.[0] as unknown as { anim: { w: { at: number }[] } }).anim.w[0].at).toBe(1.1);
    // The result is a valid document.
    expect(manifestSchema.safeParse(r.manifest).success).toBe(true);
  });

  it('times anim tracks and the camera, and spreads one layer`s keys over beats', () => {
    const r = timeToMusic(musicDoc(), 0, beats, [
      { name: 'grow', cue: 'downbeat 2', layer: 'hero', track: 'anim:w' },
      { name: 'push', cue: 'bar 1 beat 2', track: 'camera' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = (r.manifest.scenes[0].layers?.[0] as unknown as { anim: { w: { at: number }[] } }).anim.w;
    expect(w.map((k) => k.at)).toEqual([2, 2.3]);
    expect(r.manifest.scenes[0].camera?.map((k) => k.at)).toEqual([0.5, 3.5]);

    const each = timeToMusic(musicDoc(), 0, beats, [
      { name: 'a', cue: 'beat 1', layer: 'dot1', track: 'enter' },
      { name: 'b', cue: 'beat 8', layer: 'dot2', track: 'enter' },
      { name: 'ticks', cue: 'every beat between a and b', layer: 'hero', track: 'transform' },
    ]);
    expect(each.ok && (each.manifest.scenes[0].layers?.[0] as unknown as { transform: { keys: { at: number }[] } }).transform.keys.map((k) => k.at)).toEqual([0.5, 3]);
  });

  it('refuses a move that leaves the scene, passes another key, or names nothing', () => {
    const out = timeToMusic(musicDoc(), 0, beats, [{ name: 'late', cue: 'last beat', layer: 'hero', track: 'transform', anchor: 'start' }]);
    // last beat 3.5 + the move's 0.5 s length = 4.0 is the scene end: allowed.
    expect(out.ok).toBe(true);
    const past = timeToMusic(musicDoc(), 0, beats, [{ name: 'p', cue: 'downbeat 2', layer: 'hero', track: 'all' }]);
    // all = transform (0.4, 0.9) + anim (1.1, 1.4): anchored at 0.4 → 2.0, last key 3.0: fine.
    expect(past.ok).toBe(true);
    const cross = timeToMusic(musicDoc(), 0, beats, [{ name: 'x', cue: 'beat 6', layer: 'hero', keys: 'first', track: 'transform' }]);
    expect(cross).toMatchObject({ ok: false, move: 'x' });
    expect(!cross.ok && cross.error).toMatch(/pass each other/);
    const ghost = timeToMusic(musicDoc(), 0, beats, [{ name: 'g', cue: 'beat 1', layer: 'nobody' }]);
    expect(!ghost.ok && ghost.error).toMatch(/no layer "nobody"/);
    const both = timeToMusic(musicDoc(), 0, beats, [
      { name: 'one', cue: 'beat 1', layer: 'hero', track: 'transform' },
      { name: 'two', cue: 'beat 2', layer: 'hero', track: 'all' },
    ]);
    expect(!both.ok && both.error).toMatch(/both move the same key/);
  });
});

describe('snap keys to beats', () => {
  it('moves each key to its nearest beat within the tolerance', () => {
    const doc = musicDoc();
    const r = snapKeysToBeats(doc, 0, sceneBeats(doc, 0, beatsFixture()), { tolerance: 0.15, includeCamera: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hero = r.manifest.scenes[0].layers?.[0] as unknown as { transform: { keys: { at: number }[] }; anim: { w: { at: number }[] } };
    expect(hero.transform.keys.map((k) => k.at)).toEqual([0.5, 1]);
    expect(hero.anim.w.map((k) => k.at)).toEqual([1, 1.5]);
    expect(r.manifest.scenes[0].camera?.map((k) => k.at)).toEqual([0, 3]);
    const far = snapKeysToBeats(doc, 0, sceneBeats(doc, 0, beatsFixture()), { tolerance: 0.05, kind: 'downbeat' });
    expect(far.ok && far.keys.every((k) => k.to === null)).toBe(true);
  });
});
