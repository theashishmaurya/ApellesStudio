/**
 * bigFixture.ts - the 300-clip / 8-track fixture the perf baseline runs on
 * (D-437 S0c; `docs/notes/timeline-lanes.md` section 4).
 *
 * What it is: `bigFixtureSpec`, a pure, deterministic generator of a `FixtureSpec`
 * (same input, same spec: no `Math.random`, no clock). It lays out `clips` clips on
 * `tracks` tracks: mostly video, the rest audio, with mixed lengths and small gaps, a
 * run of butted clips at the start of every track (so every edit tool has neighbours in
 * the visible part of the timeline), `linkedPairs` linked A/V pairs on the first video
 * track (their audio halves land on the first audio track, which the spec leaves empty),
 * four markers and two transitions (past that run, on cuts the edit tools do not touch). `clips` counts every clip on the timeline, the
 * linked audio halves included.
 *
 * Clip names are `t<track>c<index>` (track and per-track index in the spec), so a
 * scenario can aim at `t1c1` without knowing an id.
 *
 * What it does NOT do: build anything. `buildFixture` (`fixture.ts`) turns the spec
 * into a timeline through the same `editor_*` ops an agent uses.
 */

import type { FixtureClip, FixtureSpec } from './scenario.ts';

export interface BigFixtureOptions {
  /** Every clip on the timeline, linked audio halves included. */
  clips: number;
  /** Total tracks; at least 4 (so there are two video tracks for transitions and an audio pair). */
  tracks: number;
  /** Linked A/V pairs on the first video track. Default: one pair in fifteen clips, at most 20. */
  linkedPairs?: number;
}

/** Clip lengths in frames, cycled per track so neighbouring clips differ. */
export const BIG_DURATIONS = [45, 60, 90, 120, 75, 150, 30, 105] as const;
/** The gap before a clip, cycled; 0 = butted. */
export const BIG_GAPS = [0, 0, 0, 15, 0, 0, 30, 0] as const;
/** The first clips of every track are butted, whatever the gap cycle says. */
export const BIG_BUTTED_RUN = 4;
/** Source in-point of every clip: handles in both directions for trims and transitions. */
export const BIG_SOURCE_START = 30;
export const BIG_MARKERS = [150, 600, 1200, 1800] as const;

const MIN_TRACKS = 4;
const DEFAULT_MAX_LINKED_PAIRS = 20;
const LINKED_PAIR_EVERY = 15;

/** Fixture name of clip `index` on spec track `track`. */
export const bigClipName = (track: number, index: number) => `t${track}c${index}`;

export interface BigFixtureShape {
  videoTracks: number;
  audioTracks: number;
  /** Spec track index of the first audio track (where linked audio halves land). */
  linkedAudioTrack: number;
}

/** How `tracks` splits into video and audio: three eighths audio, at least two. */
export function bigFixtureShape(tracks: number): BigFixtureShape {
  const audioTracks = Math.max(2, Math.round((tracks * 3) / 8));
  const videoTracks = tracks - audioTracks;
  return { videoTracks, audioTracks, linkedAudioTrack: videoTracks };
}

export function bigFixtureSpec(options: BigFixtureOptions): FixtureSpec {
  const { clips, tracks } = options;
  if (!Number.isInteger(tracks) || tracks < MIN_TRACKS) throw new Error(`bigFixtureSpec: tracks must be an integer >= ${MIN_TRACKS}, got ${tracks}`);
  if (!Number.isInteger(clips) || clips < tracks) throw new Error(`bigFixtureSpec: clips must be an integer >= tracks (${tracks}), got ${clips}`);
  const { videoTracks, linkedAudioTrack } = bigFixtureShape(tracks);
  const linkedPairs = options.linkedPairs ?? Math.min(DEFAULT_MAX_LINKED_PAIRS, Math.floor(clips / LINKED_PAIR_EVERY));
  if (linkedPairs < 0 || linkedPairs * 2 > clips) throw new Error(`bigFixtureSpec: ${linkedPairs} linked pairs do not fit in ${clips} clips`);

  // Tracks that hold explicit clips: every one except the linked-audio track.
  const holders = Array.from({ length: tracks }, (_, t) => t).filter((t) => t !== linkedAudioTrack);
  const explicit = clips - linkedPairs; // each linked pair is one explicit clip plus its audio half
  const perTrack = holders.map((_, h) => Math.floor(explicit / holders.length) + (h < explicit % holders.length ? 1 : 0));

  const specTracks: FixtureSpec['tracks'] = Array.from({ length: tracks }, (_, t) => ({ kind: t < videoTracks ? 'video' : 'audio', clips: [] as FixtureClip[] }));
  /** Per track, the start frame of every clip after the butted run that follows a clip with no gap (a cut a transition can sit on). */
  const farCuts: Record<number, number[]> = {};
  let pairsLeft = linkedPairs;
  holders.forEach((t, h) => {
    let frame = 0;
    for (let i = 0; i < perTrack[h]; i += 1) {
      const gap = i < BIG_BUTTED_RUN ? 0 : BIG_GAPS[(i + t) % BIG_GAPS.length];
      const duration = BIG_DURATIONS[(i * 3 + t) % BIG_DURATIONS.length];
      const startFrame = frame + gap;
      const linked = t === 0 && i % 2 === 0 && pairsLeft > 0;
      if (linked) pairsLeft -= 1;
      specTracks[t].clips.push({
        name: bigClipName(t, i),
        media: t >= videoTracks ? 'tone' : linked ? 'av' : 'video',
        sourceStart: BIG_SOURCE_START,
        duration,
        startFrame,
      });
      if (i >= BIG_BUTTED_RUN && gap === 0) (farCuts[t] ??= []).push(startFrame);
      frame = startFrame + duration;
    }
  });

  // Two transitions on butted cuts of video tracks 1 and 2, past the butted run at the start of the track: a
  // transition's button sits over its cut, and the run is where the edit-tool scenarios press (D-437 S6: the
  // first perf-300 run's trim scenarios pressed on a transitioned edge).
  const transitions = [1, 2]
    .filter((t) => t < videoTracks && (farCuts[t]?.length ?? 0) > 0)
    .map((t) => ({ track: t, atFrame: farCuts[t][0] }));

  return {
    tracks: specTracks,
    markers: BIG_MARKERS.map((frame, i) => ({ name: `m${i + 1}`, frame })),
    transitions,
  };
}

/** Total clips the built timeline will hold: explicit clips plus one linked audio half per `av` clip. */
export function bigFixtureClipCount(spec: FixtureSpec): number {
  let n = 0;
  for (const track of spec.tracks) for (const c of track.clips) n += c.media === 'av' ? 2 : 1;
  return n;
}

/** The standard perf fixture: 300 clips on 8 tracks. */
export const BIG_300: FixtureSpec = bigFixtureSpec({ clips: 300, tracks: 8 });

/** Convenience name from the plan: `buildBigFixture({ clips: 300, tracks: 8 })` is the spec `buildFixture` takes. */
export const buildBigFixture = bigFixtureSpec;
