// @vitest-environment jsdom
/**
 * B-348 — the In / Out marks and Shift+Delete's ripple delete, at the op and
 * store layer (jsdom, backend commands stubbed): `editor_set_marks` and
 * `editor_get_state` through the real `chroma://request` dispatch, and
 * `rippleDeleteClips` (what Shift+Delete runs) over the real reducers and the
 * shared undo stack.
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

import { useEditorTimelineStore } from './timelineStore';
import { rippleDeleteClips } from './rippleDeleteSelection';
import { useEditorControl } from './useEditorControl';
import type { Timeline } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function op(name: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `mk-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op: name, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${name}`);
  return hit.payload as OpEnvelope;
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
      openProjectKey: '/projects/marks.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      inPoint: null,
      outPoint: null,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(2);
}

const tl = (): Timeline => useEditorTimelineStore.getState().timeline as Timeline;

/** a 0-90, b 90-180, c 180-270 on V1; the same on A1 would be linked, so keep
 *  this one a plain unlinked video track and put a second clip on track 1. */
function threeClips() {
  return {
    id: 'tl',
    name: 'marks',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [clipOf('a', 0, 90), clipOf('b', 90, 90), clipOf('c', 180, 90)],
        gain: 1,
        sync_locked: false,
      },
    ],
    markers: [],
  };
}

beforeEach(() => {
  bus.emitted.length = 0;
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('B-348 — editor_set_marks', () => {
  it('reads nothing set, sets the range inclusive, and reports it in editor_get_state', async () => {
    await mountWith(threeClips());
    expect((await op('editor_set_marks')).result).toMatchObject({ inPoint: null, outPoint: null });
    const r = await op('editor_set_marks', { inPoint: 30, outPoint: 60 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ inPoint: 30, outPoint: 60 });
    const state = (await op('editor_get_state')).result;
    expect(state).toMatchObject({ inPoint: 30, outPoint: 60 });
  });

  it('clamps to the timeline, drops a crossed mark, and clear drops both', async () => {
    await mountWith(threeClips());
    expect((await op('editor_set_marks', { outPoint: 9999 })).result.outPoint).toBe(269);
    const crossed = await op('editor_set_marks', { inPoint: 300 });
    expect(crossed.result).toMatchObject({ inPoint: 269, outPoint: 269 });
    await op('editor_set_marks', { inPoint: 10, outPoint: 50 });
    const moved = await op('editor_set_marks', { inPoint: 80 });
    expect(moved.result).toMatchObject({ inPoint: 80, outPoint: null });
    const cleared = await op('editor_set_marks', { clear: true });
    expect(cleared.result).toMatchObject({ inPoint: null, outPoint: null });
  });

  it('marks set from the playhead (what I / O do) read back through the tool', async () => {
    await mountWith(threeClips());
    const store = () => useEditorTimelineStore.getState();
    act(() => {
      store().setPlayhead(30);
      store().setMarks({ inPoint: store().playhead });
      store().setPlayhead(60);
      store().setMarks({ outPoint: store().playhead });
    });
    expect((await op('editor_set_marks')).result).toMatchObject({ inPoint: 30, outPoint: 60 });
  });
});

describe('B-293 — editor_set_track_gain names a missing track instead of answering ok', () => {
  it('errors on an index past the last track and changes nothing', async () => {
    await mountWith(threeClips());
    const bad = await op('editor_set_track_gain', { track: 4, gain: 0 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no track 4/);
    expect(tl().tracks[0].gain).toBe(1);
    const good = await op('editor_set_track_gain', { track: 0, gain: 0.5 });
    expect(good.ok).toBe(true);
    expect(tl().tracks[0].gain).toBe(0.5);
  });
});

describe('B-293 — a stale track index cannot silently hit the wrong track', () => {
  it('after a title lands on a new top track the old index addresses the title track, and the answer says so', async () => {
    await mountWith(threeClips());
    const added = await op('editor_add_text_clip', { content: 'Title', start_frame: 0, duration_frames: 48 });
    expect(added.ok).toBe(true);
    // The title went on a NEW track 0; the original footage track is now 1.
    expect(tl().tracks).toHaveLength(2);
    expect(tl().tracks[1].clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);

    // The caller still holds the old index 0 for "the voiceover".
    const stale = await op('editor_set_track_gain', { track: 0, gain: 0 });
    expect(stale.ok).toBe(true);
    const r = stale.result as { clipCount: number; trackKind: string };
    // The answer names what was hit: the one-clip title track, not the 3-clip one,
    // so the mismatch is visible to the caller and the footage track is untouched.
    expect(r.clipCount).toBe(1);
    expect(tl().tracks[1].gain).toBe(1);

    // By its CURRENT index the footage track is addressed correctly.
    const right = await op('editor_set_track_gain', { track: 1, gain: 0.5 });
    expect((right.result as { clipCount: number }).clipCount).toBe(3);
    expect(tl().tracks[1].gain).toBe(0.5);
  });
});

describe('B-348 — Shift+Delete ripple delete (rippleDeleteClips)', () => {
  it('lifts the clip AND closes the hole: later clips move up', async () => {
    await mountWith(threeClips());
    expect(rippleDeleteClips(['b'])).toBe(1);
    expect(tl().tracks[0].clips.map((c) => [c.id, c.start_frame])).toEqual([
      ['a', 0],
      ['c', 90],
    ]);
  });

  it('several clips come out last-first so earlier frame numbers stay valid', async () => {
    await mountWith(threeClips());
    expect(rippleDeleteClips(['a', 'c'])).toBe(2);
    expect(tl().tracks[0].clips.map((c) => [c.id, c.start_frame])).toEqual([['b', 0]]);
  });

  it('a clip that no longer exists, or an empty selection, does nothing', async () => {
    await mountWith(threeClips());
    expect(rippleDeleteClips([])).toBe(0);
    expect(rippleDeleteClips(['nope'])).toBe(0);
    expect(tl().tracks[0].clips).toHaveLength(3);
  });

  it('plain remove leaves the gap (the contrast the key pair exists for)', async () => {
    await mountWith(threeClips());
    act(() => useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: 0, clip: 1 }));
    expect(tl().tracks[0].clips.map((c) => c.start_frame)).toEqual([0, 180]);
  });
});
