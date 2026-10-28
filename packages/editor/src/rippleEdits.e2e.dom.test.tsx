// @vitest-environment jsdom
/**
 * The owner's critical-edit fixes of 2026-10-28, end to end at the OP layer:
 * each `editor_*` op driven through the real `chroma://request` dispatch
 * `control.rs` uses, the real timeline store and the shared undo stack.
 *
 * - B-310 — `editor_ripple_delete_ranges` cuts exactly the ranges it reports;
 * - B-307 / D-422 — markers follow the ripple ops, in the same undo step;
 * - B-306 / B-314 / D-423 — `editor_move_clip` moves or says why; a request past
 *   its bridge deadline never runs;
 * - B-304 / D-421 — emptying a track keeps it; `editor_remove_track` is the
 *   explicit removal; a move keeps clip indices in start order.
 *
 * **Tier and its honest limit.** jsdom, backend commands stubbed. On trial: the
 * op contracts (arguments, refusals, results) over the real reducers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

const bus = vi.hoisted(() => ({
  listeners: new Map<string, Set<(ev: { payload: unknown }) => unknown>>(),
  emitted: [] as { event: string; payload: unknown }[],
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => unknown) => {
    const set = bus.listeners.get(event) ?? new Set();
    set.add(handler);
    bus.listeners.set(event, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
  emit: (event: string, payload: unknown) => {
    bus.emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

import { useHistoryStore } from '@apelles/history';
import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';
import { type Timeline } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<OpEnvelope | null> {
  const id = `re-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args, ...extra } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  return hit ? (hit.payload as OpEnvelope) : null;
}

async function op(name: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const r = await callOp(name, args);
  if (!r) throw new Error(`no response emitted for ${name}`);
  return r;
}

const clipOf = (id: string, startFrame: number, duration: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  source_path: `/fixtures/${id}.mov`,
  source_start: 0,
  duration,
  source_len: 100_000,
  source_fps: 24,
  start_frame: startFrame,
  ...extra,
});

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

async function mountWith(timeline: unknown): Promise<void> {
  act(() =>
    useEditorTimelineStore.setState({
      timeline: timeline as never,
      openProjectKey: '/projects/ripple.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(2);
}

const tl = (): Timeline => useEditorTimelineStore.getState().timeline as Timeline;
const ids = (track: number) => tl().tracks[track].clips.map((c) => c.id);
const undoDepth = (): number => useHistoryStore.getState().undoStack.length;

beforeEach(() => {
  bus.emitted.length = 0;
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('B-304 / D-421 — tracks keep their index; removing one is explicit', () => {
  function threeTracks() {
    return {
      id: 'tl',
      name: 'tracks',
      rate: { num: 24, den: 1 },
      tracks: [
        { kind: 'video', clips: [clipOf('a', 0, 48)], gain: 1, sync_locked: false },
        { kind: 'video', clips: [clipOf('b', 0, 48)], gain: 1, sync_locked: false },
        { kind: 'video', clips: [clipOf('c', 0, 48)], gain: 1, sync_locked: false },
      ],
      markers: [],
    };
  }

  it('removing a track\'s last clip leaves the track, so the next call by index still hits the right track', async () => {
    await mountWith(threeTracks());
    expect((await op('editor_remove_clip', { track: 0, clip: 0 })).ok).toBe(true);
    expect(tl().tracks.map((t) => t.clips.length)).toEqual([0, 1, 1]);
    // Composed against the original numbering: track 2 is still `c`.
    const r = await op('editor_trim_clip', { track: 2, clip: 0, edge: 'end', delta: -12 });
    expect(r.ok).toBe(true);
    expect(ids(2)).toEqual(['c']);
    expect(tl().tracks[2].clips[0].duration).toBe(36);
  });

  it('editor_remove_track removes an empty track, refuses a non-empty one unless with_clips, and is one undo step', async () => {
    await mountWith(threeTracks());
    const refused = await op('editor_remove_track', { track: 1 });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/still holds 1 clip/);
    expect(tl().tracks).toHaveLength(3);

    await op('editor_remove_clip', { track: 1, clip: 0 });
    const depth = undoDepth();
    const r = await op('editor_remove_track', { track: 1 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ track: 1, removedClips: 0, tracks: 2 });
    expect(tl().tracks.map((t) => t.clips.map((c) => c.id))).toEqual([['a'], ['c']]);
    expect(undoDepth()).toBe(depth + 1);

    const forced = await op('editor_remove_track', { track: 1, withClips: true });
    expect(forced.result).toMatchObject({ removedClips: 1, tracks: 1 });
    expect((await op('editor_remove_track', { track: 5 })).error).toMatch(/no track 5/);
  });

  it('a move keeps clip indices in start order, so index-based follow-ups hit the clip they mean', async () => {
    await mountWith({
      id: 'tl',
      name: 'order',
      rate: { num: 24, den: 1 },
      tracks: [{ kind: 'video', clips: [clipOf('a', 0, 24), clipOf('b', 24, 24), clipOf('c', 48, 24)], gain: 1, sync_locked: false }],
      markers: [],
    });
    expect((await op('editor_move_clip', { fromTrack: 0, clip: 0, startFrame: 200 })).ok).toBe(true);
    expect(ids(0)).toEqual(['b', 'c', 'a']);
  });
});

describe('B-310 — editor_ripple_delete_ranges reports exactly what it did', () => {
  function voTimeline(overlay = false) {
    return {
      id: 'tl',
      name: 'vo',
      rate: { num: 24, den: 1 },
      tracks: [
        {
          kind: 'audio',
          clips: [clipOf('p', 450, 100), { ...clipOf('voice', 561, 205), source_start: 760 }],
          gain: 1,
          sync_locked: false,
        },
        // A sync-locked title whose clip straddles frame 571 refuses that one range (B-033).
        ...(overlay
          ? [{ kind: 'video', clips: [clipOf('title', 565, 10)], gain: 1, sync_locked: true }]
          : []),
      ],
      markers: [],
    };
  }
  const spans = () => tl().tracks[0].clips.map((c) => [c.start_frame, c.source_start, c.duration]);

  it('cuts the live repro\'s three ranges as one undo step, the track shorter by exactly 23 frames', async () => {
    await mountWith(voTimeline());
    const depth = undoDepth();
    const r = await op('editor_ripple_delete_ranges', {
      track: 0,
      ranges: [
        { startFrame: 544, endFrame: 558 },
        { startFrame: 568, endFrame: 571 },
        { startFrame: 580, endFrame: 586 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ applied: 3, ranges: 3 });
    expect(spans()).toEqual([
      [450, 0, 94],
      [547, 760, 7],
      [554, 770, 9],
      [563, 785, 180],
    ]);
    expect(undoDepth()).toBe(depth + 1);
    act(() => useHistoryStore.getState().undo());
    expect(spans()).toEqual([
      [450, 0, 100],
      [561, 760, 205],
    ]);
  });

  it('a range it reports skipped is left exactly as it was; the others still apply', async () => {
    await mountWith(voTimeline(true));
    const r = await op('editor_ripple_delete_ranges', {
      track: 0,
      ranges: [
        { startFrame: 568, endFrame: 571 },
        { startFrame: 580, endFrame: 586 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.result.applied).toBe(1);
    expect(r.result.skipped).toEqual([{ startFrame: 568, endFrame: 571, reason: expect.stringMatching(/straddles frame 571/) }]);
    // Voice frames 568..570 (source 767..769) are all still there, unmoved.
    expect(spans()).toEqual([
      [450, 0, 100],
      [561, 760, 19], // 760..778, 580..585 cut
      [580, 785, 180],
    ]);
  });
});

describe('B-307 — markers follow ripple edits, in the same undo step', () => {
  function marked() {
    return {
      id: 'tl',
      name: 'markers',
      rate: { num: 24, den: 1 },
      tracks: [
        { kind: 'video', clips: [clipOf('a', 0, 100), clipOf('b', 100, 100), clipOf('c', 220, 100)], gain: 1, sync_locked: false },
      ],
      markers: [
        { id: 'm-before', frame: 20, color: '#3B8FE3' },
        { id: 'm-inside', frame: 130, color: '#D9434E' },
        { id: 'm-after', frame: 250, color: '#4CAF50', duration_frames: 24 },
      ],
    };
  }
  const markerFrames = () => (tl().markers ?? []).map((m) => [m.id, m.frame, m.duration_frames ?? 0]);

  it('editor_ripple_delete_ranges moves later markers back, a marker inside the cut to the cut point; one undo restores both', async () => {
    await mountWith(marked());
    const depth = undoDepth();
    expect((await op('editor_ripple_delete_ranges', { track: 0, ranges: [{ startFrame: 120, endFrame: 150 }] })).ok).toBe(true);
    expect(markerFrames()).toEqual([
      ['m-before', 20, 0],
      ['m-inside', 120, 0],
      ['m-after', 220, 24],
    ]);
    expect(undoDepth()).toBe(depth + 1);
    act(() => useHistoryStore.getState().undo());
    expect(markerFrames()).toEqual([
      ['m-before', 20, 0],
      ['m-inside', 130, 0],
      ['m-after', 250, 24],
    ]);
    expect(tl().tracks[0].clips.map((c) => c.start_frame)).toEqual([0, 100, 220]);
  });

  it('editor_remove_gap closes the gap and the markers after it follow', async () => {
    await mountWith(marked());
    expect((await op('editor_remove_gap', { track: 0, frame: 210 })).ok).toBe(true);
    expect(markerFrames()).toEqual([
      ['m-before', 20, 0],
      ['m-inside', 130, 0],
      ['m-after', 230, 24],
    ]);
  });
});

describe('B-306 / B-314 — editor_move_clip moves, or says why not; a timed-out call never applies late', () => {
  // A linked pair v/a at 50..150 on sync-locked tracks, and a free spot on
  // track 2 at y's start (80): the ripple at 80 meets `a` itself.
  function linkedTimeline(lockAudio = false) {
    return {
      id: 'tl',
      name: 'move',
      rate: { num: 24, den: 1 },
      tracks: [
        { kind: 'video', clips: [clipOf('x', 0, 50), clipOf('v', 50, 100, { link_group: 'g' }), clipOf('w', 150, 100)], gain: 1, sync_locked: true },
        { kind: 'audio', clips: [clipOf('a', 50, 100, { link_group: 'g' }), clipOf('a2', 150, 100)], gain: 1, sync_locked: true, locked: lockAudio },
        { kind: 'video', clips: [clipOf('y', 80, 100)], gain: 1, sync_locked: true },
      ],
      markers: [],
    };
  }
  const at = (track: number) => tl().tracks[track].clips.map((c) => [c.id, c.start_frame]);

  it('ripple=true really moves, the linked partner with it, and reports where the clip landed', async () => {
    await mountWith(linkedTimeline());
    const r = await op('editor_move_clip', { fromTrack: 0, clip: 1, toTrack: 2, startFrame: 80, ripple: true });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ toTrack: 2, clip: 0, id: 'v', startFrame: 80, rippled: true, linkedMoved: 1 });
    expect(at(2)).toEqual([
      ['v', 80],
      ['y', 180],
    ]);
    expect(at(1)).toEqual([
      ['a', 80],
      ['a2', 250],
    ]);
  });

  it('refuses — not ok — when the linked partner is on a locked track, and changes nothing', async () => {
    await mountWith(linkedTimeline(true));
    const before = JSON.stringify(tl());
    const r = await op('editor_move_clip', { fromTrack: 0, clip: 1, startFrame: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/track 1 is locked .*A\/V-linked/);
    expect(JSON.stringify(tl())).toBe(before);
  });

  it('a request that arrives after the bridge stopped waiting is dropped, not applied late to whatever clip now has that index', async () => {
    await mountWith(linkedTimeline());
    const before = JSON.stringify(tl());
    const r = await callOp('editor_move_clip', { fromTrack: 0, clip: 0, startFrame: 400 }, { deadline_ms: Date.now() - 5_000 });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/not run: the caller stopped waiting/);
    expect(JSON.stringify(tl())).toBe(before);
    // Within its deadline the same call runs.
    const live = await callOp('editor_move_clip', { fromTrack: 0, clip: 0, startFrame: 400 }, { deadline_ms: Date.now() + 20_000 });
    expect(live?.ok).toBe(true);
  });
});
