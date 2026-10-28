// @vitest-environment jsdom
/**
 * D-413 — the three Edit beat ops end to end at the OP layer, through the
 * real `chroma://request` dispatch: `editor_detect_beats` (analysis through
 * the bridge's binding, grid shown as one undo step), `editor_set_beat_grid`
 * (hide/show) and `editor_snap_cuts_to_beats` (dry run, then one undo step).
 *
 * **Tier and its honest limit.** jsdom with `chroma_detect_beats` stubbed by a
 * fixed 120 BPM grid; the analysis itself is `apelles-beat`'s, pinned by its
 * own Rust suite (synthetic click tracks with known beats).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const BED = '/music/bed.mp3';

const calls = vi.hoisted(() => ({ detect: [] as Array<Record<string, unknown>> }));

function bedBeats(path: string) {
  const beats = Array.from({ length: 40 }, (_, i) => {
    const k = i - 1;
    return {
      time: 0.5 + i * 0.5,
      bar: k < 0 ? 0 : Math.floor(k / 4) + 1,
      beat: k < 0 ? 4 : (k % 4) + 1,
      downbeat: k >= 0 && k % 4 === 0,
      strength: k >= 0 && k % 4 === 0 ? 1 : 0.4,
      strong: k >= 0 && k % 4 === 0,
    };
  });
  return {
    path,
    contentHash: 'abc',
    params: { meter: 4 },
    truncated: false,
    cached: false,
    analysis: { algorithmVersion: 1, duration: 20, tempoBpm: 120, meter: 4, beats },
  };
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_detect_beats: (args) => {
      calls.detect.push(args ?? {});
      if (args?.path !== '/music/bed.mp3') throw new Error(`decoding ${String(args?.path)}: no audio track`);
      return bedBeats(String(args.path));
    },
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
import { useBeatStore } from '@apelles/bridge';
import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';
import { endFrame } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `beats-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

const clip = (id: string, over: Record<string, unknown>) => ({
  id,
  name: id,
  source_path: '/v.mov',
  source_start: 20,
  duration: 48,
  source_len: 400,
  source_fps: 24,
  start_frame: 0,
  ...over,
});

function timeline() {
  return {
    id: 'tl',
    name: 'beats fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [clip('a', { duration: 50 }), clip('b', { start_frame: 50, duration: 46 }), clip('c', { start_frame: 96, duration: 40 })],
        gain: 1,
        sync_locked: false,
      },
      {
        kind: 'audio',
        clips: [clip('bed', { source_path: BED, source_start: 24, duration: 192, source_fps: undefined })],
        gain: 1,
        sync_locked: false,
      },
    ],
    markers: [],
  };
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

const undoDepth = (): number => useHistoryStore.getState().undoStack.length;
const tracks = () => useEditorTimelineStore.getState().timeline?.tracks ?? [];

beforeEach(async () => {
  bus.emitted.length = 0;
  calls.detect.length = 0;
  act(() => useBeatStore.setState({ entries: {} }));
  act(() =>
    useEditorTimelineStore.setState({
      timeline: timeline() as never,
      openProjectKey: '/projects/beats.chroma',
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
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('editor_detect_beats', () => {
  it('analyses the track, shows its grid as one undo step, and answers beats on timeline frames', async () => {
    const before = undoDepth();
    const r = await callOp('editor_detect_beats', { track: 1, kind: 'downbeat' });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({
      track: 1,
      shown: true,
      tempoBpm: 120,
      meter: 4,
      beatSpacingFrames: 12,
      totalBeatsOnTimeline: 16,
      beatCount: 4,
      truncated: false,
    });
    expect(r.result.beats.map((b: { frame: number }) => b.frame)).toEqual([0, 48, 96, 144]);
    expect(r.result.files[0]).toMatchObject({ path: BED, tempoBpm: 120, beats: 40, downbeats: 10 });
    expect(tracks()[1].beat_grid).toEqual({});
    expect(undoDepth()).toBe(before + 1);
    expect(calls.detect).toEqual([{ path: BED, meter: null, tempoHintBpm: null, force: false }]);

    // Asking again re-uses the session's answer and changes nothing.
    const again = await callOp('editor_detect_beats', { track: 1, startFrame: 40, endFrame: 60 });
    expect(again.result.beats.map((b: { frame: number }) => b.frame)).toEqual([48, 60]);
    expect(calls.detect).toHaveLength(1);
    expect(undoDepth()).toBe(before + 1);
  });

  it('B-301: answers a summary by default (counts + first beats) and pages the full list on request', async () => {
    const summary = await callOp('editor_detect_beats', { track: 1 });
    expect(summary.result).toMatchObject({
      totalBeatsOnTimeline: 16,
      beatCount: 16,
      downbeatCount: 4,
      tempoBpm: 120,
      truncated: true,
    });
    expect(summary.result.beats).toHaveLength(8);

    const page1 = await callOp('editor_detect_beats', { track: 1, full: true, limit: 10 });
    expect(page1.result.beats).toHaveLength(10);
    expect(page1.result).toMatchObject({ offset: 0, truncated: true, nextOffset: 10 });
    const page2 = await callOp('editor_detect_beats', { track: 1, full: true, limit: 10, offset: 10 });
    expect(page2.result.beats).toHaveLength(6);
    expect(page2.result).toMatchObject({ truncated: false, nextOffset: null });
    const all = await callOp('editor_detect_beats', { track: 1, full: true });
    expect(all.result.beats).toHaveLength(16);
  });

  it('passes the meter and tempo hint through, and refuses bad ones', async () => {
    await callOp('editor_detect_beats', { track: 1, meter: 3, tempoHintBpm: 90, show: false });
    expect(calls.detect[0]).toMatchObject({ meter: 3, tempoHintBpm: 90 });
    expect(tracks()[1].beat_grid).toBeUndefined();
    expect((await callOp('editor_detect_beats', { track: 1, meter: 9 })).result.error).toMatch(/meter/);
    expect((await callOp('editor_detect_beats', { track: 7 })).result.error).toMatch(/track must be/);
    expect((await callOp('editor_detect_beats', { track: 1, kind: 'offbeat' })).result.error).toMatch(/kind/);
  });

  it('reports a file that cannot be analysed', async () => {
    const r = await callOp('editor_detect_beats', { track: 0 });
    expect(r.result.error).toMatch(/no clip on track 0 could be analysed/);
    expect(r.result.failed[0].error).toMatch(/no audio track/);
  });
});

describe('editor_set_beat_grid', () => {
  it('shows and hides, one undo step each', async () => {
    const before = undoDepth();
    await callOp('editor_set_beat_grid', { track: 1, meter: 3 });
    expect(tracks()[1].beat_grid).toEqual({ meter: 3 });
    await callOp('editor_set_beat_grid', { track: null });
    expect(tracks()[1].beat_grid).toBeUndefined();
    expect(undoDepth()).toBe(before + 2);
  });
});

describe('editor_snap_cuts_to_beats', () => {
  it('needs a grid, dry-runs, then rolls the cuts as one undo step', async () => {
    expect((await callOp('editor_snap_cuts_to_beats', { track: 0 })).result.error).toMatch(/no beat grid/);
    await callOp('editor_set_beat_grid', { track: 1 });

    const dry = await callOp('editor_snap_cuts_to_beats', { track: 0, dryRun: true });
    expect(dry.result).toMatchObject({ applied: 0, moved: 1, maxShiftFrames: 6, to: 'beat' });
    expect(endFrame(tracks()[0].clips[0] as never, 24)).toBe(50);

    const before = undoDepth();
    const r = await callOp('editor_snap_cuts_to_beats', { track: 0 });
    expect(r.result.cuts).toEqual([
      { clip: 0, fromFrame: 50, toFrame: 48 },
      { clip: 1, fromFrame: 96, toFrame: null, reason: 'already on a beat' },
    ]);
    expect(endFrame(tracks()[0].clips[0] as never, 24)).toBe(48);
    expect(undoDepth()).toBe(before + 1);

    act(() => useHistoryStore.getState().undo());
    expect(endFrame(tracks()[0].clips[0] as never, 24)).toBe(50);
  });

  it('snaps to downbeats only when asked, within the given shift', async () => {
    await callOp('editor_set_beat_grid', { track: 1 });
    const r = await callOp('editor_snap_cuts_to_beats', { track: 0, to: 'downbeat', maxShiftFrames: 1 });
    expect(r.result.moved).toBe(0);
    expect(r.result.cuts[0].reason).toBe('no beat within 1 frames');
  });
});
