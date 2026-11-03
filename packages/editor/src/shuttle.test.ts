// @apelles/editor — B-348: the J / K / L shuttle (`shuttle.ts`).
import { describe, expect, it } from 'vitest';

import { createShuttle, nextShuttle, SHUTTLE_SPEEDS, type ShuttleTransport } from './shuttle';

/** A fake transport with a hand-cranked frame clock. */
function rig(opts: { playhead?: number; rate?: number } = {}) {
  let playing = false;
  let rate = opts.rate ?? 1;
  let playhead = opts.playhead ?? 120;
  let nowMs = 0;
  let pending: ((n: number) => void) | null = null;
  const transport: ShuttleTransport = {
    getPlaying: () => playing,
    setPlaying: (p) => {
      playing = p;
    },
    getPlaybackRate: () => rate,
    setPlaybackRate: (r) => {
      rate = r;
    },
    getPlayhead: () => playhead,
    seek: (f) => {
      playhead = Math.max(0, f);
    },
    getFps: () => 30,
    schedule: (tick) => {
      pending = tick;
      return () => {
        if (pending === tick) pending = null;
      };
    },
    now: () => nowMs,
  };
  const shuttle = createShuttle(transport);
  return {
    shuttle,
    get playing() {
      return playing;
    },
    set playing(p: boolean) {
      playing = p;
    },
    get rate() {
      return rate;
    },
    get playhead() {
      return playhead;
    },
    set playhead(f: number) {
      playhead = f;
    },
    /** Advance the frame clock by `ms` and run the pending tick. */
    advance(ms: number) {
      nowMs += ms;
      const tick = pending;
      pending = null;
      tick?.(nowMs);
    },
    get scheduled() {
      return pending !== null;
    },
  };
}

describe('nextShuttle', () => {
  it('climbs 1x, 2x, 4x, 8x and holds at the top', () => {
    let s = nextShuttle(null, 'forward');
    const seen = [s.speed];
    for (let i = 0; i < 5; i++) {
      s = nextShuttle(s, 'forward');
      seen.push(s.speed);
    }
    expect(seen).toEqual([1, 2, 4, 8, 8, 8]);
    expect(SHUTTLE_SPEEDS).toEqual([1, 2, 4, 8]);
  });

  it('the other direction restarts at 1x', () => {
    expect(nextShuttle({ dir: 'forward', speed: 4 }, 'reverse')).toEqual({ dir: 'reverse', speed: 1 });
  });
});

describe('createShuttle', () => {
  it('L plays forward at 1x, again at 2x; K stops and gives the user rate back', () => {
    const r = rig({ rate: 0.5 });
    r.shuttle.press('forward', false);
    expect(r.playing).toBe(true);
    expect(r.rate).toBe(1);
    r.shuttle.press('forward', false);
    expect(r.rate).toBe(2);
    r.shuttle.stop();
    expect(r.playing).toBe(false);
    expect(r.rate).toBe(0.5);
    expect(r.shuttle.state()).toBeNull();
  });

  it('L while already playing (Space) climbs to 2x rather than restarting at 1x', () => {
    const r = rig();
    r.playing = true; // started with Space, at the user's 1x
    r.shuttle.press('forward', false);
    expect(r.rate).toBe(2);
  });

  it('J scrubs backward at speed x real time, with no playback, and stops at 0', () => {
    const r = rig({ playhead: 120 });
    r.shuttle.press('reverse', false);
    expect(r.playing).toBe(false);
    r.advance(500); // 0.5 s at 30 fps, 1x = 15 frames
    expect(r.playhead).toBe(105);
    r.shuttle.press('reverse', false); // 2x, clock restarts from 105
    r.advance(500); // 30 frames
    expect(r.playhead).toBe(75);
    r.advance(60_000);
    expect(r.playhead).toBe(0);
    expect(r.shuttle.state()).toBeNull();
    expect(r.scheduled).toBe(false);
  });

  it('K stops a reverse scrub', () => {
    const r = rig();
    r.shuttle.press('reverse', false);
    r.advance(200);
    r.shuttle.stop();
    const at = r.playhead;
    r.advance(500);
    expect(r.playhead).toBe(at);
  });

  it('a reverse scrub yields when something else moves the playhead', () => {
    const r = rig({ playhead: 120 });
    r.shuttle.press('reverse', false);
    r.advance(200);
    r.playhead = 10; // a click on the ruler
    r.advance(200);
    expect(r.playhead).toBe(10);
    expect(r.shuttle.state()).toBeNull();
  });

  it('J after a forward shuttle stops playback and reverses at 1x, keeping the user rate', () => {
    const r = rig({ rate: 2 });
    r.shuttle.press('forward', false);
    r.shuttle.press('reverse', false);
    expect(r.playing).toBe(false);
    expect(r.rate).toBe(2);
    expect(r.shuttle.state()).toEqual({ dir: 'reverse', speed: 1 });
  });

  it('with K held, J and L step one frame and stop the shuttle', () => {
    const r = rig({ playhead: 50 });
    r.shuttle.press('forward', false);
    r.shuttle.press('forward', true);
    expect(r.playing).toBe(false);
    expect(r.playhead).toBe(51);
    r.shuttle.press('reverse', true);
    r.shuttle.press('reverse', true);
    expect(r.playhead).toBe(49);
    expect(r.shuttle.state()).toBeNull();
  });

  it('playback ending on its own restores the user rate', () => {
    const r = rig({ rate: 0.5 });
    r.shuttle.press('forward', false);
    expect(r.rate).toBe(1);
    r.shuttle.playingChanged(false);
    expect(r.rate).toBe(0.5);
    expect(r.shuttle.state()).toBeNull();
  });
});
