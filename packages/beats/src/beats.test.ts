import { describe, expect, it } from 'vitest';
import {
  beatParamsProblem,
  isBeatOfKind,
  nearestIndex,
  parseCue,
  planMoves,
  snapSpan,
  snapTo,
  spread,
  within,
  type CueBeat,
} from './index';

/** 4/4 at 120 BPM from t = 0.25 s: a beat every 0.5 s, a downbeat every 2 s,
 *  beat 3 of each bar also strong (a backbeat-style accent). */
function grid(bars: number): CueBeat[] {
  const out: CueBeat[] = [];
  for (let i = 0; i < bars * 4; i++) {
    out.push({ at: 0.25 + i * 0.5, downbeat: i % 4 === 0, strong: i % 4 === 0 || i % 4 === 2 });
  }
  return out;
}

describe('snapping', () => {
  const t = [0, 10, 20, 30];
  it('finds the nearest, ties to the earlier', () => {
    expect(nearestIndex(t, 14)).toBe(1);
    expect(nearestIndex(t, 15)).toBe(1);
    expect(nearestIndex(t, 16)).toBe(2);
    expect(nearestIndex(t, -5)).toBe(0);
    expect(nearestIndex(t, 99)).toBe(3);
    expect(nearestIndex([], 1)).toBe(-1);
  });
  it('snaps only within the tolerance', () => {
    expect(snapTo(12, t, 3)).toEqual({ value: 10, snapped: true });
    expect(snapTo(15, t, 3)).toEqual({ value: 15, snapped: false });
  });
  it('snaps a span by whichever edge is closer', () => {
    // head 11 is 1 from 10; tail 11+8=19 is 1 from 20: tie → head.
    expect(snapSpan(11, 8, t, 3)).toEqual({ value: 10, snapped: true });
    // head 12 is 2 away, tail 12+7=19 is 1 away → tail lands on 20.
    expect(snapSpan(12, 7, t, 3)).toEqual({ value: 13, snapped: true });
    expect(snapSpan(4, 2, t, 1)).toEqual({ value: 4, snapped: false });
  });
  it('filters a window', () => {
    expect(within(t, 5, 20)).toEqual([10, 20]);
  });
});

describe('kinds and params', () => {
  it('classifies beats', () => {
    const down = { downbeat: true, strong: true };
    const weak = { downbeat: false, strong: false };
    expect(isBeatOfKind(down, 'downbeat')).toBe(true);
    expect(isBeatOfKind(weak, 'strong')).toBe(false);
    expect(isBeatOfKind(weak, 'beat')).toBe(true);
  });
  it('checks params', () => {
    expect(beatParamsProblem(4, undefined)).toBeNull();
    expect(beatParamsProblem(1, undefined)).toMatch(/meter/);
    expect(beatParamsProblem(4.5, undefined)).toMatch(/meter/);
    expect(beatParamsProblem(undefined, 400)).toMatch(/tempo_hint_bpm/);
  });
});

describe('parseCue', () => {
  it('reads every form', () => {
    expect(parseCue('downbeat 1')).toEqual({ type: 'nth', kind: 'downbeat', n: 1 });
    expect(parseCue('  Strong   Beat 2 ')).toEqual({ type: 'nth', kind: 'strong', n: 2 });
    expect(parseCue('bar 3')).toEqual({ type: 'nth', kind: 'downbeat', n: 3 });
    expect(parseCue('bar 2 beat 3')).toEqual({ type: 'bar', bar: 2, beat: 3 });
    expect(parseCue('on the first downbeat')).toEqual({ type: 'first', kind: 'downbeat' });
    expect(parseCue('last beat')).toEqual({ type: 'last', kind: 'beat' });
    expect(parseCue('next strong beat')).toEqual({ type: 'next', kind: 'strong', after: null });
    expect(parseCue('next beat after reveal')).toEqual({ type: 'next', kind: 'beat', after: 'reveal' });
    expect(parseCue('every beat between')).toEqual({ type: 'every', kind: 'beat', between: null });
    expect(parseCue('every downbeats between a and b')).toEqual({ type: 'every', kind: 'downbeat', between: ['a', 'b'] });
  });
  it('refuses nonsense with the forms listed', () => {
    const r = parseCue('whenever it feels right');
    expect('error' in r && r.error).toMatch(/Use one of/);
    expect('error' in parseCue('beat 0')).toBe(true);
  });
});

describe('planMoves — the reel example', () => {
  it('reveal on downbeat 1, scale on the next strong beat, accents between', () => {
    const r = planMoves(grid(4), [
      { name: 'reveal', cue: 'downbeat 1', items: 1 },
      { name: 'scale', cue: 'next strong beat', items: 1 },
      { name: 'accents', cue: 'every beat between', items: 1 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [reveal, scale, accents] = r.plans;
    expect(reveal.times).toEqual([0.25]); // downbeat 1
    expect(scale.times).toEqual([1.25]); // beat 3 of bar 1, the next strong
    expect(accents.times).toEqual([0.75]); // the one beat strictly between
  });

  it('spreads items over more beats, first and last included', () => {
    const r = planMoves(grid(4), [
      { name: 'in', cue: 'downbeat 1', items: 1 },
      { name: 'out', cue: 'downbeat 3', items: 1 },
      { name: 'pulses', cue: 'every beat between in and out', items: 3 },
    ]);
    expect(r.ok && r.plans[2].times).toEqual([0.75, 2.25, 3.75]);
  });

  it('lets an `every` name a move listed after it', () => {
    const r = planMoves(grid(2), [
      { name: 'ticks', cue: 'every beat between a and b', items: 2 },
      { name: 'a', cue: 'beat 1', items: 1 },
      { name: 'b', cue: 'beat 4', items: 1 },
    ]);
    expect(r.ok && r.plans[0].times).toEqual([0.75, 1.25]);
  });

  it('bar N beat M and last', () => {
    const r = planMoves(grid(3), [
      { name: 'x', cue: 'bar 2 beat 3', items: 2 },
      { name: 'y', cue: 'last downbeat', items: 1 },
    ]);
    expect(r.ok && r.plans[0].times).toEqual([3.25, 3.25]);
    expect(r.ok && r.plans[1].times).toEqual([4.25]);
  });

  it('refuses what cannot be placed, naming the move', () => {
    const tooFar = planMoves(grid(2), [{ name: 'big', cue: 'downbeat 5', items: 1 }]);
    expect(tooFar).toMatchObject({ ok: false, move: 'big' });
    expect(!tooFar.ok && tooFar.error).toMatch(/has 2/);

    const crowded = planMoves(grid(2), [
      { name: 'a', cue: 'beat 1', items: 1 },
      { name: 'b', cue: 'beat 3', items: 1 },
      { name: 'c', cue: 'every beat between', items: 2 },
    ]);
    expect(!crowded.ok && crowded.error).toMatch(/only 1 beats/);

    const lonely = planMoves(grid(2), [
      { name: 'a', cue: 'beat 1', items: 1 },
      { name: 'c', cue: 'every beat between', items: 1 },
    ]);
    expect(!lonely.ok && lonely.error).toMatch(/needs two single-beat moves/);

    expect(planMoves([], [{ name: 'a', cue: 'beat 1', items: 1 }]).ok).toBe(false);
    expect(planMoves(grid(1), [{ name: 'a', cue: 'beat 1', items: 1 }, { name: 'A', cue: 'beat 2', items: 1 }]).ok).toBe(false);
    expect(planMoves(grid(1), [{ name: 'a', cue: 'next beat after ghost', items: 1 }]).ok).toBe(false);
  });

  it('is deterministic', () => {
    const moves = [
      { name: 'a', cue: 'downbeat 2', items: 1 },
      { name: 'b', cue: 'next downbeat', items: 1 },
      { name: 'c', cue: 'every strong beat between', items: 1 },
    ];
    expect(planMoves(grid(4), moves)).toEqual(planMoves(grid(4), moves));
  });
});

describe('spread', () => {
  it('covers the edge cases', () => {
    expect(spread(5, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(spread(5, 1)).toEqual([2]);
    expect(spread(5, 2)).toEqual([0, 4]);
    expect(spread(7, 3)).toEqual([0, 3, 6]);
  });
});
