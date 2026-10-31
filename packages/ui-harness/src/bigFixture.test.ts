import { describe, expect, it } from 'vitest';

import { BIG_300, BIG_BUTTED_RUN, bigClipName, bigFixtureClipCount, bigFixtureShape, bigFixtureSpec } from './bigFixture.ts';
import type { OpClient } from './client.ts';
import { buildFixture, type ScratchProject } from './fixture.ts';
import { SCENARIOS } from './scenarios/index.ts';

describe('bigFixtureSpec (D-437 S0c)', () => {
  it('holds 300 clips on 8 tracks, linked audio halves counted', () => {
    expect(BIG_300.tracks).toHaveLength(8);
    expect(bigFixtureClipCount(BIG_300)).toBe(300);
  });

  it('is deterministic: the same options give the same spec', () => {
    expect(JSON.stringify(bigFixtureSpec({ clips: 300, tracks: 8 }))).toBe(JSON.stringify(BIG_300));
  });

  it('splits 8 tracks into 5 video and 3 audio, the first audio track empty for the linked halves', () => {
    expect(bigFixtureShape(8)).toEqual({ videoTracks: 5, audioTracks: 3, linkedAudioTrack: 5 });
    expect(BIG_300.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'video', 'video', 'video', 'audio', 'audio', 'audio']);
    expect(BIG_300.tracks[5].clips).toEqual([]);
  });

  it('puts 20 linked A/V pairs on the first video track and plain media elsewhere', () => {
    const av = BIG_300.tracks.flatMap((t, i) => t.clips.filter((c) => c.media === 'av').map(() => i));
    expect(av).toHaveLength(20);
    expect(new Set(av)).toEqual(new Set([0]));
    expect(BIG_300.tracks[6].clips.every((c) => c.media === 'tone')).toBe(true);
    expect(BIG_300.tracks[1].clips.every((c) => c.media === 'video')).toBe(true);
  });

  it('never overlaps two clips on a track, and has mixed lengths', () => {
    for (const track of BIG_300.tracks) {
      let end = 0;
      for (const c of track.clips) {
        expect(c.startFrame).toBeGreaterThanOrEqual(end);
        end = c.startFrame + c.duration;
      }
    }
    const lengths = new Set(BIG_300.tracks.flatMap((t) => t.clips.map((c) => c.duration)));
    expect(lengths.size).toBeGreaterThanOrEqual(6);
  });

  it('butts the first clips of every holder track and names them t<track>c<index>', () => {
    for (const [t, track] of BIG_300.tracks.entries()) {
      if (track.clips.length === 0) continue;
      for (let i = 1; i < BIG_BUTTED_RUN; i += 1) expect(track.clips[i].startFrame).toBe(track.clips[i - 1].startFrame + track.clips[i - 1].duration);
      expect(track.clips[1].name).toBe(bigClipName(t, 1));
    }
    const names = BIG_300.tracks.flatMap((t) => t.clips.map((c) => c.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('has four markers and two transitions, each on a real cut', () => {
    expect(BIG_300.markers).toHaveLength(4);
    expect(BIG_300.transitions).toHaveLength(2);
    for (const tr of BIG_300.transitions ?? []) {
      const clips = BIG_300.tracks[tr.track].clips;
      const incoming = clips.findIndex((c) => c.startFrame === tr.atFrame);
      expect(incoming).toBeGreaterThan(0);
      expect(clips[incoming - 1].startFrame + clips[incoming - 1].duration).toBe(tr.atFrame);
    }
  });

  it('refuses shapes it cannot lay out', () => {
    expect(() => bigFixtureSpec({ clips: 300, tracks: 3 })).toThrow(/tracks/);
    expect(() => bigFixtureSpec({ clips: 5, tracks: 8 })).toThrow(/clips/);
    expect(() => bigFixtureSpec({ clips: 40, tracks: 8, linkedPairs: 30 })).toThrow(/linked/);
  });

  it('scales: other sizes keep the clip count', () => {
    expect(bigFixtureClipCount(bigFixtureSpec({ clips: 120, tracks: 6 }))).toBe(120);
  });
});

describe('buildFixture with transitions', () => {
  it('adds each spec transition as a cross dissolve on its cut', async () => {
    const calls: { op: string; args?: Record<string, unknown> }[] = [];
    const client: OpClient = {
      async op<T>(op: string, args?: Record<string, unknown>): Promise<T> {
        calls.push({ op, args });
        if (op === 'editor_create_timeline') return { timeline: { id: 'tl' } } as T;
        return {} as T;
      },
    };
    const project: ScratchProject = { path: '/x/ui-harness-1.chroma', mediaIds: { video: 'v', av: 'a', tone: 't' }, originalProject: null };
    await buildFixture(client, project, 'x', { tracks: [], transitions: [{ track: 1, atFrame: 90 }] });
    expect(calls.filter((c) => c.op === 'editor_add_transition')).toEqual([{ op: 'editor_add_transition', args: { track: 1, kind: 'cross_dissolve', atFrame: 90 } }]);
  });
});

describe('perf-300 scenarios', () => {
  const perf = SCENARIOS.filter((s) => s.area === 'perf-300');

  it('are opt-in, on the big fixture, and every gesture (not a tool-button click) is measured', () => {
    expect(perf.length).toBeGreaterThanOrEqual(12);
    for (const s of perf) {
      expect(s.optIn).toBe(true);
      expect(s.fixture).toBe(BIG_300);
      for (const step of s.steps) if ('pointer' in step && step.pointer.action !== 'click') expect(step.measure).toBe(true);
    }
  });

  it('target only clips the fixture has', () => {
    const names = new Set(BIG_300.tracks.flatMap((t) => t.clips.map((c) => c.name)));
    for (const s of perf) {
      const used = JSON.stringify(s.steps).match(/@clip:(t\d+c\d+)/g) ?? [];
      for (const u of used) expect(names.has(u.replace('@clip:', ''))).toBe(true);
    }
  });

  it('ids are unique across the whole suite', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
