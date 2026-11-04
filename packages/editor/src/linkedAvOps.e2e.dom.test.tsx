// @vitest-environment jsdom
/**
 * @apelles/editor — the MCP edit ops resolve an A/V-linked pair the way the
 * Inspector does (B-334, D-430).
 *
 * Drives the REAL op handlers (`useEditorControl`, reached the way the Rust
 * bridge reaches them: a `chroma://request` event) over a linked pair and reads
 * the store back. Addressing EITHER half must land sound properties
 * (`editor_set_clip_audio`, `editor_set_clip_eq`, `volume`/`pan` keyframes) on
 * the audible audio partner and picture properties (`editor_set_clip_transform`,
 * `editor_set_dynamic_zoom`, every other keyframe) on the picture, with a note
 * saying so — and an unlinked clip stays exactly as it was.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_get: () => null,
    chroma_timeline_set: () => undefined,
    chroma_edit_journal_append: () => undefined,
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

// B-386 — replies and the handshake reach the control server through
// commands; record them in the same log the suite reads.
vi.mock('@apelles/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apelles/bridge')>()),
  respondToControlRequest: (id: string, payload: unknown) => {
    bus.emitted.push({ event: `chroma://response/${id}`, payload });
    return Promise.resolve();
  },
  announceBridgeClaim: (payload: unknown) => {
    bus.emitted.push({ event: 'chroma://bridge-ready', payload });
    return Promise.resolve();
  },
}));


import { useHistoryStore } from '@apelles/history';
import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';
import { resolveEqPreset, type Clip, type Timeline } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `av-op-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

const PICTURE = { track: 0, clip: 0 };
const SOUND = { track: 1, clip: 0 };

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: 'C01 hook demo',
    source_path: '/fixtures/hook.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
    link_group: 'lg-hook',
    ...extra,
  } as unknown as Clip;
}

function pair(): Timeline {
  return {
    id: 'tl',
    name: 'tl',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips: [clip('v', { volume: 10.6 })], gain: 1, sync_locked: false },
      { kind: 'audio', clips: [clip('a', { volume: 0.55 })], gain: 1, sync_locked: false },
    ],
    markers: [],
  } as unknown as Timeline;
}

function current(at: { track: number; clip: number }): Clip {
  const c = useEditorTimelineStore.getState().timeline?.tracks[at.track].clips[at.clip];
  if (!c) throw new Error('clip missing');
  return c;
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

beforeEach(async () => {
  bus.emitted.length = 0;
  useHistoryStore.getState().clear();
  act(() =>
    useEditorTimelineStore.setState({
      timeline: pair(),
      timelines: [],
      openProjectKey: '/projects/av.chroma',
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

afterEach(async () => {
  await useEditorTimelineStore.getState().flushPendingSave();
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', timelines: [] }));
});

describe.each([
  ['the picture half', PICTURE],
  ['the audio half', SOUND],
] as const)('addressing %s of a linked pair', (_name, at) => {
  it('editor_set_clip_audio writes the audible audio partner, never the picture', async () => {
    const r = await callOp('editor_set_clip_audio', { ...at, volume: 0.7, pan: -0.25 });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ ok: true, ...SOUND, volume: 0.7, pan: -0.25 });
    expect(current(SOUND)).toMatchObject({ volume: 0.7, pan: -0.25 });
    // The picture half keeps whatever stray value it had — untouched, not cleared.
    expect(current(PICTURE).volume).toBe(10.6);
    expect(current(PICTURE).pan).toBeUndefined();
  });

  it('editor_set_clip_eq writes the audio partner', async () => {
    const r = await callOp('editor_set_clip_eq', { ...at, band: 0, gain_db: 4 });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ ok: true, ...SOUND });
    expect(current(SOUND).eq_bands?.[0]?.gain_db).toBe(4);
    expect(current(PICTURE).eq_bands).toBeUndefined();
  });

  // v0.3.0 (B-365, D-442) — the same preset table the Inspector's menu uses.
  it('editor_set_clip_eq preset writes all four bands on the audio partner, as one undo step', async () => {
    useHistoryStore.getState().clear();
    const r = await callOp('editor_set_clip_eq', { ...at, preset: 'Voice clarity' });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ ok: true, ...SOUND, eqActive: true });
    expect(current(SOUND).eq_bands).toEqual(resolveEqPreset('Voice clarity'));
    expect(current(PICTURE).eq_bands).toBeUndefined();
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });

  it('editor_set_clip_eq refuses an unknown preset, and a preset mixed with band fields', async () => {
    const bad = await callOp('editor_set_clip_eq', { ...at, preset: 'Loud' });
    expect(JSON.stringify(bad)).toContain('preset must be one of Flat, Voice clarity');
    const mixed = await callOp('editor_set_clip_eq', { ...at, preset: 'Flat', band: 0, gain_db: 3 });
    expect(JSON.stringify(mixed)).toContain('pass it alone');
    expect(current(SOUND).eq_bands).toBeUndefined();
  });

  it('editor_set_clip_transform writes the picture, never the audio half', async () => {
    const r = await callOp('editor_set_clip_transform', { ...at, scale: 1.4, position_x: 0.1 });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ ok: true, ...PICTURE });
    expect(current(PICTURE)).toMatchObject({ scale: 1.4, position_x: 0.1 });
    expect(current(SOUND).scale).toBeUndefined();
  });

  it('editor_set_dynamic_zoom animates the picture', async () => {
    const r = await callOp('editor_set_dynamic_zoom', { ...at });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ ok: true, ...PICTURE });
    expect((current(PICTURE).chroma_keyframes ?? []).length).toBeGreaterThan(0);
    expect(current(SOUND).chroma_keyframes).toBeUndefined();
  });

  it('editor_set_clip_keyframes splits one mixed list between the halves, each to its own', async () => {
    const r = await callOp('editor_set_clip_keyframes', {
      ...at,
      keyframes: [
        { frame: 0, params: { scale: 1, volume: 0.5 } },
        { frame: 48, params: { scale: 1.5, volume: 1 } },
      ],
    });
    expect(r.error).toBeNull();
    expect(current(PICTURE).chroma_keyframes).toEqual([
      { frame: 0, params: { scale: 1 } },
      { frame: 48, params: { scale: 1.5 } },
    ]);
    expect(current(SOUND).chroma_keyframes).toEqual([
      { frame: 0, params: { volume: 0.5 } },
      { frame: 48, params: { volume: 1 } },
    ]);
  });

  it('a picture-only list leaves the audio partner’s volume ramp alone', async () => {
    await callOp('editor_set_clip_keyframes', {
      ...SOUND,
      keyframes: [{ frame: 0, params: { volume: 0.55 } }, { frame: 96, params: { volume: 0.2 } }],
    });
    const r = await callOp('editor_set_clip_keyframes', {
      ...at,
      keyframes: [{ frame: 0, params: { scale: 1 } }, { frame: 96, params: { scale: 1.3 } }],
    });
    expect(r.error).toBeNull();
    expect(current(SOUND).chroma_keyframes).toHaveLength(2);
    expect(current(SOUND).chroma_keyframes?.[0].params).toEqual({ volume: 0.55 });
    expect(current(PICTURE).chroma_keyframes?.[1].params).toEqual({ scale: 1.3 });
  });

  it('editor_set_keyframe_ease finds a volume key on the audio partner', async () => {
    await callOp('editor_set_clip_keyframes', {
      ...SOUND,
      keyframes: [{ frame: 0, params: { volume: 0.55 } }, { frame: 96, params: { volume: 0.2 } }],
    });
    const r = await callOp('editor_set_keyframe_ease', { ...at, param: 'volume', frame: 0, curve: 'ease-in' });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ ok: true, ...SOUND, changed: true });
  });
});

describe('the redirect is said out loud, and unlinked clips are untouched', () => {
  it('names the half the write really went to', async () => {
    const r = await callOp('editor_set_clip_audio', { ...PICTURE, volume: 0.6 });
    expect(r.result.note).toMatch(/A\/V-linked pair/);
    const direct = await callOp('editor_set_clip_audio', { ...SOUND, volume: 0.6 });
    expect(direct.result.note).not.toMatch(/A\/V-linked pair/);
  });

  it('a linked picture whose audio half is gone refuses a level (it is silent)', async () => {
    act(() =>
      useEditorTimelineStore.setState((s) => {
        const tl = structuredClone(s.timeline) as Timeline;
        tl.tracks[1].clips = [];
        return { timeline: tl };
      }),
    );
    const r = await callOp('editor_set_clip_audio', { ...PICTURE, volume: 0.6 });
    expect(r.result.error).toMatch(/audio half is gone/);
    expect(current(PICTURE).volume).toBe(10.6);
  });

  it('an unlinked video clip keeps its own embedded-audio level', async () => {
    act(() =>
      useEditorTimelineStore.setState((s) => {
        const tl = structuredClone(s.timeline) as Timeline;
        tl.tracks[0].clips[0].link_group = null;
        tl.tracks[1].clips = [];
        return { timeline: tl };
      }),
    );
    const r = await callOp('editor_set_clip_audio', { ...PICTURE, volume: 0.6 });
    expect(r.error).toBeNull();
    expect(current(PICTURE).volume).toBe(0.6);
  });
});
