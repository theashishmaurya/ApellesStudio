// @vitest-environment jsdom
/**
 * @apelles/editor — `editor_remove_clip`'s `removed` list (B-221).
 *
 * **The bug.** Removing one half of an A/V link group silently removed the
 * OTHER half too (D-129's own `remove` reducer case, which groups by
 * `link_group` before splicing) with nothing in the response saying a second
 * clip went with it — a caller only found out by re-reading the timeline.
 *
 * **What this asserts, at the real op-dispatch layer** (the same
 * `chroma://request` path `control.rs` uses, per this repo's established
 * pattern — see `recutSweep.dom.test.tsx`'s own header): removing one half of
 * a linked pair reports BOTH clips in `removed: [{track, clip, id}]`, an
 * unlinked clip reports itself alone, and a refusal (locked track) reports an
 * empty `removed` rather than a false positive.
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
  const id = `test-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

async function mountWith(timeline: unknown): Promise<void> {
  act(() =>
    useEditorTimelineStore.setState({
      timeline: timeline as never,
      openProjectKey: '/projects/b221.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(2);
}

/** Two linked clips (video track 0 clip 0 + audio track 1 clip 0, same
 *  `link_group`) plus one unlinked clip on track 0, matching B-221's own
 *  repro shape (track 1 clip 7 + track 3 clip 7 linked, the next clip along
 *  unlinked). */
function fixture() {
  return {
    id: 'tl',
    name: 'B-221 fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'v0', name: 'linked-video', source_path: '/f.mov', source_start: 0, duration: 100, source_len: 500, start_frame: 0, link_group: 'lg-1' },
          { id: 'v1', name: 'solo-video', source_path: '/f.mov', source_start: 100, duration: 100, source_len: 500, start_frame: 100 },
        ],
        gain: 1,
        sync_locked: false,
      },
      {
        kind: 'audio',
        clips: [
          { id: 'a0', name: 'linked-audio', source_path: '/f.mov', source_start: 0, duration: 100, source_len: 500, start_frame: 0, link_group: 'lg-1' },
        ],
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

describe('editor_remove_clip reports what it actually removed (B-221)', () => {
  it('removing one half of a linked pair reports BOTH clips in `removed`', async () => {
    await mountWith(fixture());

    const env = await callOp('editor_remove_clip', { track: 0, clip: 0 });

    expect(env.ok).toBe(true);
    expect(env.result.removed).toEqual(
      expect.arrayContaining([
        { track: 0, clip: 0, id: 'v0' },
        { track: 1, clip: 0, id: 'a0' },
      ]),
    );
    expect(env.result.removed).toHaveLength(2);

    // Both halves are actually gone from the live timeline, not just from
    // the report. (Track 1 held only `a0`, so removing it prunes the whole
    // now-empty track — expected, and why this checks every track rather
    // than assuming track 1 still exists at that index.)
    const tl = useEditorTimelineStore.getState().timeline!;
    const remainingIds = tl.tracks.flatMap((t) => t.clips.map((c) => c.id));
    expect(remainingIds).not.toContain('v0');
    expect(remainingIds).not.toContain('a0');
  });

  it('removing an unlinked clip reports itself alone', async () => {
    await mountWith(fixture());

    const env = await callOp('editor_remove_clip', { track: 0, clip: 1 });

    expect(env.ok).toBe(true);
    expect(env.result.removed).toEqual([{ track: 0, clip: 1, id: 'v1' }]);
  });

  it('a refused remove (locked track) reports an empty `removed`, not a false positive', async () => {
    const tl = fixture();
    (tl.tracks[1] as { locked?: boolean }).locked = true;
    await mountWith(tl);

    const env = await callOp('editor_remove_clip', { track: 0, clip: 0 });

    // D-129: the whole link group is refused when any member's track is
    // locked, so nothing moves — and the report must say so, not claim v0
    // was removed just because the caller named it.
    expect(env.ok).toBe(true);
    expect(env.result.removed).toEqual([]);
    const after = useEditorTimelineStore.getState().timeline!;
    expect(after.tracks[0].clips.map((c) => c.id)).toContain('v0');
  });
});
