/**
 * shuttle.ts — the J / K / L shuttle for the Edit tab's viewer (B-348).
 *
 * What it is: the shuttle's pure state machine (`nextShuttle`) and its
 * controller (`createShuttle`), which turns a state into transport actions.
 *
 *   - **L** plays forward at 1x; each further L doubles the speed (2x, 4x, 8x,
 *     the player's own maximum rate).
 *   - **J** is the same in reverse. The player only plays forward (its rate is
 *     0.25-8 and the audio engine has no reverse), so reverse is a SCRUB: a
 *     frame-clock moves the playhead backward at `speed x real time` through
 *     the ordinary seek path (the viewer shows the frame it can keep up with),
 *     with no audio, and stops at frame 0. This is the documented stand-in for
 *     reverse playback.
 *   - **K** stops. With K held, J / L step one frame back / forward instead
 *     (the "K+J / K+L" frame step, which Premiere and Resolve call slow-motion
 *     scrubbing).
 *   - A key for the OTHER direction while moving restarts at 1x in that
 *     direction (a deliberate simplification of Premiere's "slow down by one
 *     step"; the reverse of a fast shuttle is one key, not three).
 *
 * Forward shuttle uses the viewer's playback rate (`setPlaybackRate`) for the
 * duration and puts the user's own rate back on stop, so a 0.5x review rate
 * is not silently lost. It never touches a clip's Speed.
 *
 * What it does NOT do: own any store state (the controller is handed the
 * transport), or render anything.
 */

import { MAX_PLAYBACK_RATE } from '@apelles/player';

export type ShuttleDir = 'forward' | 'reverse';
/** The shuttle's state: `null` = idle, otherwise a direction at a speed. */
export type ShuttleState = { dir: ShuttleDir; speed: number } | null;

/** The speeds repeated presses climb through: 1x, 2x, 4x, 8x. */
export const SHUTTLE_SPEEDS: readonly number[] = [1, 2, 4, MAX_PLAYBACK_RATE];

/** The state after a press of `dir` (a J or an L). */
export function nextShuttle(state: ShuttleState, dir: ShuttleDir): NonNullable<ShuttleState> {
  if (!state || state.dir !== dir) return { dir, speed: SHUTTLE_SPEEDS[0] };
  const at = SHUTTLE_SPEEDS.indexOf(state.speed);
  return { dir, speed: SHUTTLE_SPEEDS[Math.min(at + 1, SHUTTLE_SPEEDS.length - 1)] };
}

/** What the controller drives: the Edit store's transport, narrowed. */
export interface ShuttleTransport {
  getPlaying(): boolean;
  setPlaying(playing: boolean): void;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getPlayhead(): number;
  /** A user seek (re-baselines playback; clamps to the timeline). */
  seek(frame: number): void;
  /** The timeline's frame rate. */
  getFps(): number;
  /** Frame clock: schedule `tick` on the next frame, return a cancel. */
  schedule(tick: (nowMs: number) => void): () => void;
  now(): number;
}

export interface Shuttle {
  /** J / L pressed. `kHeld`: the K key is down, so it is a one-frame step. */
  press(dir: ShuttleDir, kHeld: boolean): void;
  /** K pressed. */
  stop(): void;
  /** The transport's `playing` flag changed (a subscription, not a key). */
  playingChanged(playing: boolean): void;
  /** The current state (tests, the key handlers' "is it moving"). */
  state(): ShuttleState;
  /** Drop everything without touching the transport (unmount). */
  dispose(): void;
}

export function createShuttle(t: ShuttleTransport): Shuttle {
  let state: ShuttleState = null;
  /** The user's own playback rate, saved while a forward shuttle overrides it. */
  let savedRate: number | null = null;
  let cancelReverse: (() => void) | null = null;

  const stopReverse = () => {
    cancelReverse?.();
    cancelReverse = null;
  };
  const restoreRate = () => {
    if (savedRate !== null) t.setPlaybackRate(savedRate);
    savedRate = null;
  };
  const halt = () => {
    stopReverse();
    if (state?.dir === 'forward' || t.getPlaying()) t.setPlaying(false);
    restoreRate();
    state = null;
  };

  const startReverse = (speed: number) => {
    stopReverse();
    if (t.getPlaying()) t.setPlaying(false);
    restoreRate();
    const startedAt = t.now();
    const from = t.getPlayhead();
    /** The frame this scrub last put the playhead on: anything else at the
     *  next tick means the user (or an agent) moved it, and the scrub yields. */
    let expected = from;
    const tick = (nowMs: number) => {
      if (!state || state.dir !== 'reverse') return;
      if (t.getPlayhead() !== expected || t.getPlaying()) {
        stopReverse();
        state = null;
        return;
      }
      const frame = Math.max(0, from - Math.floor(((nowMs - startedAt) / 1000) * t.getFps() * speed));
      if (frame !== expected) {
        t.seek(frame);
        expected = frame;
      }
      if (frame <= 0) {
        halt();
        return;
      }
      cancelReverse = t.schedule(tick);
    };
    cancelReverse = t.schedule(tick);
  };

  return {
    press(dir, kHeld) {
      if (kHeld) {
        halt();
        t.seek(t.getPlayhead() + (dir === 'forward' ? 1 : -1));
        return;
      }
      // A transport started some other way (Space) is a forward 1x as far as
      // the next L is concerned: it climbs from there, not from idle.
      const base: ShuttleState = state ?? (t.getPlaying() ? { dir: 'forward', speed: 1 } : null);
      const moving = nextShuttle(base, dir);
      state = moving;
      if (dir === 'forward') {
        stopReverse();
        if (savedRate === null) savedRate = t.getPlaybackRate();
        t.setPlaybackRate(moving.speed);
        t.setPlaying(true);
      } else {
        startReverse(moving.speed);
      }
    },
    stop() {
      halt();
    },
    state: () => state,
    playingChanged(playing) {
      // Space, the transport button, an agent, or the end of the timeline
      // stopped a forward shuttle: hand the user's own rate back.
      if (!playing && state?.dir === 'forward') {
        restoreRate();
        state = null;
      }
    },
    dispose() {
      stopReverse();
      state = null;
      savedRate = null;
    },
  };
}
