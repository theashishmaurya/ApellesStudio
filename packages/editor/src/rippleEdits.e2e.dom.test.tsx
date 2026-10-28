// @vitest-environment jsdom
/**
 * The owner's critical-edit fixes of 2026-10-28, end to end at the OP layer:
 * each `editor_*` op driven through the real `chroma://request` dispatch
 * `control.rs` uses, the real timeline store and the shared undo stack.
 *
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
