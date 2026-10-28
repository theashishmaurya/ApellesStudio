// @vitest-environment jsdom
/**
 * B-318 / B-315 — the track ops end to end at the OP layer, through the real
 * `chroma://request` dispatch: `editor_list_tracks`, the `editor_get_timeline`
 * filters (`track`, `startFrame` / `endFrame`, `fields`) and
 * `editor_set_track_sync_locked` (the same store op the track header's button
 * applies, as one undo step).
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

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `tracks-${++requestId}`;
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
  source_path: '/media/footage/v.mov',
  source_start: 0,
  duration: 48,
  source_len: 400,
  start_frame: 0,
  ...over,
});

function timeline() {
  return {
    id: 'tl',
    name: 'tracks fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [clip('a', {}), clip('b', { start_frame: 100, source_path: '/media/footage/w.mov' })],
        gain: 1,
      },
      {
        kind: 'audio',
        clips: [
          clip('vo1', { source_path: '/media/vo/take1.wav', start_frame: 10, duration: 40 }),
          clip('vo2', { source_path: '/media/vo/take1.wav', start_frame: 200, duration: 40 }),
          clip('vo3', { source_path: '/media/vo/take2.wav', start_frame: 300, duration: 60 }),
        ],
        gain: 0,
        locked: true,
      },
      {
        kind: 'audio',
        clips: [clip('bed', { source_path: '/media/music/bed.mp3', duration: 400 })],
        gain: 0.5,
        sync_locked: false,
        duck_from: 1,
        duck_db: -12,
      },
    ],
    markers: [
      { id: 'm1', frame: 20, color: 'red' },
      { id: 'm2', frame: 250, color: 'blue' },
    ],
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
  act(() =>
    useEditorTimelineStore.setState({
      timeline: timeline() as never,
      openProjectKey: '/projects/tracks.chroma',
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

describe('editor_list_tracks (B-318)', () => {
  it('answers one compact row per track with no clips', async () => {
    const r = await callOp('editor_list_tracks');
    expect(r.error).toBeNull();
    expect(r.result.trackCount).toBe(3);
    expect(r.result.durationFrames).toBe(400);
    const [v, vo, bed] = r.result.tracks;
    expect(v).toMatchObject({
      index: 0,
      kind: 'video',
      name: 'Video 1',
      gain: 1,
      muted: false,
      hidden: false,
      locked: false,
      syncLocked: true,
      duckFrom: null,
      clipCount: 2,
      sourceCount: 2,
      sources: ['v.mov', 'w.mov'],
      firstFrame: 0,
      endFrame: 148,
    });
    expect(vo).toMatchObject({
      name: 'Audio 1',
      muted: true,
      locked: true,
      clipCount: 3,
      sourceCount: 2,
      sources: ['take1.wav', 'take2.wav'],
      firstFrame: 10,
      endFrame: 360,
    });
    expect(bed).toMatchObject({
      name: 'Audio 2',
      gain: 0.5,
      syncLocked: false,
      duckFrom: 1,
      duckDb: -12,
      duckAttackMs: 10,
      duckReleaseMs: 300,
    });
    expect(JSON.stringify(r.result)).not.toContain('"clips"');
  });
});

describe('editor_get_timeline filters (B-318)', () => {
  it('returns the whole timeline unchanged with no filter', async () => {
    const r = await callOp('editor_get_timeline');
    expect(r.result.tracks).toHaveLength(3);
    expect(r.result.tracks[1].clips).toHaveLength(3);
    expect(r.result).not.toHaveProperty('filtered');
  });

  it('keeps only the named track, with its full clipCount', async () => {
    const r = await callOp('editor_get_timeline', { track: 1 });
    expect(r.result.tracks.map((t: { index: number }) => t.index)).toEqual([1]);
    expect(r.result.tracks[0].clips).toHaveLength(3);
    const many = await callOp('editor_get_timeline', { track: [0, 2] });
    expect(many.result.tracks.map((t: { index: number }) => t.index)).toEqual([0, 2]);
  });

  it('keeps clips and markers overlapping a frame window, keeping original clip indices', async () => {
    const r = await callOp('editor_get_timeline', { track: 1, startFrame: 190, endFrame: 310 });
    const clips = r.result.tracks[0].clips as Array<{ index: number; id: string }>;
    expect(clips.map((c) => [c.index, c.id])).toEqual([
      [1, 'vo2'],
      [2, 'vo3'],
    ]);
    expect(r.result.tracks[0].clipCount).toBe(3);
    expect(r.result.markers.map((m: { id: string }) => m.id)).toEqual(['m2']);
    expect(r.result.filtered).toMatchObject({ startFrame: 190, endFrame: 310 });
  });

  it('treats the window end as exclusive and a clip end as exclusive', async () => {
    // vo1 spans [10, 50): a window starting at 50 does not include it.
    const r = await callOp('editor_get_timeline', { track: 1, startFrame: 50, endFrame: 200 });
    expect(r.result.tracks[0].clips).toHaveLength(0);
  });

  it('keeps only the requested clip fields, plus index and id', async () => {
    const r = await callOp('editor_get_timeline', { track: 1, fields: ['name', 'startFrame', 'duration'] });
    expect(Object.keys(r.result.tracks[0].clips[0]).sort()).toEqual(['duration', 'id', 'index', 'name', 'startFrame']);
  });

  it('refuses an unknown field, a bad track and an inverted window with a reason', async () => {
    expect((await callOp('editor_get_timeline', { fields: ['colour'] })).result.error).toMatch(/unknown clip field/);
    expect((await callOp('editor_get_timeline', { track: 9 })).result.error).toMatch(/track must be/);
    expect((await callOp('editor_get_timeline', { startFrame: 50, endFrame: 10 })).result.error).toMatch(/endFrame/);
  });
});

describe('editor_set_track_sync_locked (B-315)', () => {
  it('toggles the track flag as one undo step, the same op the header button applies', async () => {
    const before = undoDepth();
    const off = await callOp('editor_set_track_sync_locked', { track: 0, syncLocked: false });
    expect(off.result).toEqual({ ok: true, track: 0, syncLocked: false });
    expect(tracks()[0].sync_locked).toBe(false);
    expect(undoDepth()).toBe(before + 1);

    const on = await callOp('editor_set_track_sync_locked', { track: 2, syncLocked: true });
    expect(on.result.syncLocked).toBe(true);
    expect(tracks()[2].sync_locked).toBe(true);
    expect((await callOp('editor_list_tracks')).result.tracks[0].syncLocked).toBe(false);
  });

  it('refuses a bad track or a non-boolean flag and changes nothing', async () => {
    const before = undoDepth();
    expect((await callOp('editor_set_track_sync_locked', { track: 7, syncLocked: true })).result.error).toMatch(/track must be/);
    expect((await callOp('editor_set_track_sync_locked', { track: 0 })).result.error).toMatch(/syncLocked/);
    expect(undoDepth()).toBe(before);
  });
});
