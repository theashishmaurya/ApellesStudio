// @apelles/editor — B-310: the batched ripple delete's whole contract, checked
// over many seeded random timelines and batches rather than a handful of
// fixtures.
//
// For every range of a batch, either it is fully cut AND the hole closed, or
// nothing in it changes; the reported applied/skipped list is exactly what
// happened; the track shrinks by exactly the applied ranges' lengths; and no
// hole is opened anywhere. Same-rate timelines are checked frame by frame
// (which material sits on every frame afterwards); mixed-rate ones within the
// representation's own one-frame seams (`split` gives each piece a whole number
// of SOURCE frames, so a piece's timeline end can round a frame either way).
import { describe, expect, it } from 'vitest';

import {
  applyRippleDeleteRanges,
  clipAt,
  endFrame,
  mergeFrameRanges,
  timelineFps,
  type Clip,
  type Timeline,
  type Track,
} from './timeline';

/** mulberry32 — a seeded generator, so a failure names a reproducible case. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATES = [
  { num: 24, den: 1 },
  { num: 24000, den: 1001 },
  { num: 25, den: 1 },
  { num: 30, den: 1 },
  { num: 30000, den: 1001 },
  { num: 493480, den: 20563 },
  { num: 60, den: 1 },
];
const SOURCE_RATES = [24, 25, 30, 29.97, 50, 60, 23.976, 44100 / 1024];

interface Case {
  seed: number;
  timeline: Timeline;
  ranges: Array<{ start: number; end: number }>;
  sameRate: boolean;
  linked: boolean;
}

function makeCase(seed: number, opts: { sameRate: boolean; linked: boolean; syncTrack: boolean }): Case {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const rate = pick(RATES);
  const fps = rate.num / rate.den;
  const clips: Clip[] = [];
  let cursor = int(0, 1) ? 0 : int(1, 30);
  const n = int(1, 5);
  for (let i = 0; i < n; i++) {
    const srcFps = opts.sameRate ? fps : pick(SOURCE_RATES);
    const frames = int(12, 260);
    const duration = Math.max(1, Math.round((frames * srcFps) / fps));
    const c = {
      id: `c${i}`,
      name: `c${i}`,
      source_path: `/src/${i}.mov`,
      source_start: int(0, 400),
      duration,
      source_len: 10 ** 9,
      start_frame: cursor,
      source_fps: srcFps,
    } as Clip;
    clips.push(c);
    cursor = endFrame(c, fps) + (int(0, 2) === 0 ? int(1, 40) : 0);
  }
  const tracks: Track[] = [{ kind: 'video', clips, gain: 1, sync_locked: false }];
  if (opts.linked) {
    clips.forEach((c) => (c.link_group = `g-${c.id}`));
    tracks.push({
      kind: 'audio',
      clips: clips.map((c) => ({ ...c, id: `${c.id}-a`, source_path: `${c.source_path}#a` })),
      gain: 1,
      sync_locked: false,
    });
  }
  if (opts.syncTrack) {
    // A sync-locked overlay track with short clips: some ranges ripple it,
    // some are refused because one of its clips straddles the cut (B-033).
    const overlay: Clip[] = [];
    let at = int(0, 60);
    while (at < cursor) {
      const len = int(10, 80);
      overlay.push({ id: `o${at}`, name: 'o', source_path: '/o.png', source_start: 0, duration: len, source_len: 10 ** 9, start_frame: at, source_fps: fps } as Clip);
      at += len + int(5, 120);
    }
    tracks.push({ kind: 'video', clips: overlay, gain: 1, sync_locked: true });
  }
  const end = Math.max(...clips.map((c) => endFrame(c, fps)));
  const ranges = Array.from({ length: int(1, 5) }, () => {
    const s = int(-5, end + 20);
    return { start: s, end: s + int(1, 60) };
  });
  const timeline = { id: 'tl', name: 'prop', rate, tracks, markers: [] } as unknown as Timeline;
  return { seed, timeline, ranges, sameRate: opts.sameRate, linked: opts.linked };
}

function trackEnd(tr: Track | undefined, fps: number): number {
  return tr && tr.clips.length ? Math.max(...tr.clips.map((c) => endFrame(c, fps))) : 0;
}

/** What is on screen at every frame of a track: `path:sourceFrame`, or null in a gap. */
function frames(tr: Track, fps: number): Array<string | null> {
  const out: Array<string | null> = [];
  for (let f = 0; f < trackEnd(tr, fps); f++) {
    const hit = clipAt(tr, f, fps);
    out.push(hit ? `${hit.clip.source_path}:${hit.sourceFrame}` : null);
  }
  return out;
}

/** The frames a correct batch leaves: every frame of an applied range dropped, all else in order. */
function expectedFrames(before: Array<string | null>, applied: Array<{ start: number; end: number }>) {
  return before.filter((_, f) => !applied.some((r) => f >= r.start && f < r.end));
}

function check(c: Case): string | null {
  const fps = timelineFps(c.timeline);
  const merged = mergeFrameRanges(c.ranges);
  const { timeline: out, results } = applyRippleDeleteRanges(c.timeline, 0, c.ranges, fps);
  const tag = `seed ${c.seed} rate ${fps.toFixed(3)} ranges ${JSON.stringify(merged)} results ${JSON.stringify(results.map((x) => x.applied))}`;
  if (results.length !== merged.length) return `${tag}: ${results.length} results for ${merged.length} ranges`;
  const applied = merged.filter((_, i) => results[i].applied);

  // (1) The report is the truth: running ONLY the ranges it calls applied gives
  // the identical timeline, each of them applied again. A skipped range that
  // changed anything fails here.
  const only = applyRippleDeleteRanges(c.timeline, 0, applied, fps);
  if (only.results.some((x) => !x.applied)) return `${tag}: an applied range is refused when run without the skipped ones`;
  if (JSON.stringify(only.timeline) !== JSON.stringify(out)) return `${tag}: the skipped ranges changed the timeline`;

  const before0 = c.timeline.tracks[0];
  const after0 = out.tracks[0];
  if (!after0) return `${tag}: the track disappeared`;
  // A cut that reaches the end of the track can expose a gap that was before
  // it; trailing empty space is not part of a track's length, so it goes too.
  const want = expectedFrames(frames(before0, fps), applied);
  while (want.length && want[want.length - 1] === null) want.pop();
  const got = frames(after0, fps);
  const lost = trackEnd(before0, fps) - want.length;
  const shrink = trackEnd(before0, fps) - trackEnd(after0, fps);

  if (c.sameRate) {
    // (2) Exact: the track shrinks by exactly the applied ranges, and every
    // surviving frame shows the material it showed before, at its rippled
    // position — no material lost outside a range, no hole opened, no gap
    // closed early.
    if (shrink !== lost) return `${tag}: track shrank by ${shrink}, applied ranges remove ${lost}`;
    for (let f = 0; f < Math.max(want.length, got.length); f++) {
      if (want[f] !== got[f]) return `${tag}: frame ${f} shows ${got[f]}, expected ${want[f]}`;
    }
  } else {
    // (2') Within the mixed-rate seams: one frame per cut either way.
    if (Math.abs(shrink - lost) > applied.length) return `${tag}: track shrank by ${shrink}, applied ranges remove ${lost}`;
    let mismatches = 0;
    for (let f = 0; f < Math.min(want.length, got.length); f++) {
      const w = want[f];
      const g = got[f];
      if ((w === null) !== (g === null)) mismatches++;
      else if (w && g && w.split(':')[0] !== g.split(':')[0]) mismatches++;
    }
    // A seam can cost a frame at each end of each cut and at each clip edge.
    const seams = 2 * applied.length + 2 * before0.clips.length;
    if (mismatches > seams) return `${tag}: ${mismatches} frames show the wrong material or a hole (allowed ${seams})`;
  }

  // (3) A/V links stay in sync: the partner track's clips span exactly what
  // the edited track's do.
  if (c.linked) {
    const spans = (tr: Track) => tr.clips.map((x) => [x.start_frame, endFrame(x, fps)].join('-')).join(' ');
    if (spans(out.tracks[1]) !== spans(after0)) return `${tag}: linked partner track out of sync: ${spans(out.tracks[1])} vs ${spans(after0)}`;
  }
  return null;
}

describe('ripple_delete_ranges — the B-310 contract, over random batches', () => {
  const run = (label: string, opts: { sameRate: boolean; linked: boolean; syncTrack: boolean }, seeds: number) => {
    it(label, () => {
      const failures: string[] = [];
      for (let seed = 1; seed <= seeds; seed++) {
        const failure = check(makeCase(seed, opts));
        if (failure) failures.push(failure);
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });
  };
  run('same-rate clips with gaps: every range all-or-nothing, frame-exact', { sameRate: true, linked: false, syncTrack: false }, 1500);
  run('mixed source/timeline rates: all-or-nothing within the one-frame seams', { sameRate: false, linked: false, syncTrack: false }, 1500);
  run('A/V-linked pairs: both tracks cut and closed together', { sameRate: true, linked: true, syncTrack: false }, 800);
  run('mixed-rate linked pairs', { sameRate: false, linked: true, syncTrack: false }, 800);
  run('with a sync-locked overlay track: refused ranges change nothing', { sameRate: true, linked: false, syncTrack: true }, 800);
});
