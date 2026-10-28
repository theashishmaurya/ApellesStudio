// @vitest-environment jsdom
/**
 * @apelles/editor — input scaling end to end through the op layer (D-425,
 * B-325): the real `chroma://request` dispatch into the real timeline store,
 * so what is asserted is what the MCP tools get back and what the Inspector's
 * store holds afterwards.
 *
 * Covers: a placed clip is stamped with the timeline default (`fit` unless
 * changed), a clip saved before D-425 stays `native`, `editor_set_clip_transform`
 * writes/validates `scaling`, `editor_set_timeline_output` writes
 * `default_scaling`, both read back through `editor_get_timeline`, the export's
 * footprint for the B-325 case (a 2160x3840 Motion render on a 1080x1920
 * timeline) is exactly the frame, and one Undo takes each edit back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_set: () => null,
    chroma_timeline_list: () => [{ id: 't', name: 't', duration: 48, active: true, output: { width: 1080, height: 1920 }, fps: 24, clipCount: 1 }],
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

import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { useHistoryStore } from '@apelles/history';
import type { Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';
import { resolveSourceFootprints } from './editorExport';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

const FRAME = { width: 1080, height: 1920 };

const pool: MediaItem[] = [
  {
    id: 'm-motion',
    sourcePath: '/motion/scene.mp4',
    name: 'scene.mp4',
    added: '2026-10-28T00:00:00Z',
    offline: false,
    folder: null,
    // D-342: a 1080x1920 manifest renders at 2x.
    video: { width: 2160, height: 3840, fps: 24, frameCount: 96, durationSecs: 4, hasAudio: false, audioChannels: 0 },
  },
  {
    id: 'm-wide',
    sourcePath: '/footage/wide.mov',
    name: 'wide.mov',
    added: '2026-10-28T00:00:00Z',
    offline: false,
    folder: null,
    video: { width: 1920, height: 1080, fps: 24, frameCount: 96, durationSecs: 4, hasAudio: false, audioChannels: 0 },
  },
];

/** A 1080x1920 timeline holding one clip that predates D-425 (no `scaling`). */
const timeline = (): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: 24, den: 1 },
  output: FRAME,
  tracks: [
    {
      kind: 'video',
      clips: [
        { id: 'old', name: 'old', source_path: '/motion/scene.mp4', source_start: 0, duration: 48, source_len: 96, start_frame: 0 },
      ],
    },
  ],
});

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `scaling-${++requestId}`;
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

const clips = () => useEditorTimelineStore.getState().timeline?.tracks[0].clips ?? [];

beforeEach(async () => {
  bus.emitted.length = 0;
  useMediaPoolStore.setState({ items: pool, folders: [], openProjectKey: 'test-project' });
  useEditorTimelineStore.setState({ timeline: timeline() });
  useHistoryStore.getState().clear();
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(2);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
});

describe('input scaling through the op layer (D-425)', () => {
  it('stamps a newly placed clip with `fit` and leaves a pre-D-425 clip native (the migration rule)', async () => {
    const env = await callOp('editor_add_clip', { mediaId: 'm-motion', track: 0, startFrame: 48 });
    expect(env.error).toBeNull();
    const placed = clips().find((c) => c.start_frame === 48);
    expect(placed?.scaling).toBe('fit');
    // The clip that was already there did not move, did not gain a mode.
    expect(clips().find((c) => c.id === 'old')?.scaling).toBeUndefined();

    const dto = (await callOp('editor_get_timeline')).result;
    const rows = dto.tracks[0].clips as Array<{ id: string; scaling: string }>;
    expect(rows.find((r) => r.id === 'old')?.scaling).toBe('native');
    expect(rows.find((r) => r.id !== 'old')?.scaling).toBe('fit');
    expect(dto.defaultScaling).toBe('fit');
  });

  it('a timeline default of `fill` stamps the next clip, and changes no clip already placed', async () => {
    await callOp('editor_add_clip', { mediaId: 'm-wide', track: 0, startFrame: 48 });
    const fitted = clips().find((c) => c.start_frame === 48);
    expect(fitted?.scaling).toBe('fit');

    const set = await callOp('editor_set_timeline_output', { default_scaling: 'fill' });
    expect(set.error).toBeNull();
    expect(set.result.timeline.defaultScaling).toBe('fill');
    expect(useEditorTimelineStore.getState().timeline?.default_scaling).toBe('fill');
    expect(clips().find((c) => c.id === fitted?.id)?.scaling).toBe('fit');

    await callOp('editor_add_clip', { mediaId: 'm-wide', track: 0, startFrame: 200 });
    expect(clips().find((c) => c.start_frame === 200)?.scaling).toBe('fill');
  });

  it('editor_set_clip_transform writes `scaling`, keeps the rest, rejects a bad name, and undoes in one step', async () => {
    const depth = useHistoryStore.getState().undoStack.length;
    const ok = await callOp('editor_set_clip_transform', { track: 0, clip: 0, scaling: 'fit' });
    expect(ok.error).toBeNull();
    expect(clips()[0].scaling).toBe('fit');
    expect(clips()[0].scale ?? 1).toBe(1);
    expect(useHistoryStore.getState().undoStack.length - depth).toBe(1);

    const bad = await callOp('editor_set_clip_transform', { track: 0, clip: 0, scaling: 'stretch' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('scaling must be one of fit, fill, native');
    expect(clips()[0].scaling).toBe('fit');

    // A transform edit that does not mention `scaling` leaves it alone.
    await callOp('editor_set_clip_transform', { track: 0, clip: 0, opacity: 0.5 });
    expect(clips()[0].scaling).toBe('fit');

    act(() => useHistoryStore.getState().undo());
    act(() => useHistoryStore.getState().undo());
    expect(clips()[0].scaling).toBeUndefined();
  });

  it('editor_set_timeline_output default_scaling is validated', async () => {
    const bad = await callOp('editor_set_timeline_output', { default_scaling: 'stretch' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('default_scaling must be one of');
  });

  it('B-325: the export footprint of a 2160x3840 render on a 1080x1920 timeline is exactly the frame', async () => {
    await callOp('editor_set_clip_transform', { track: 0, clip: 0, scaling: 'fit' });
    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl).not.toBeNull();
    if (!tl) return;
    expect(resolveSourceFootprints(tl, FRAME)).toEqual({ old: { width: 1, height: 1 } });

    // The same clip under `native` is the 2x footprint that cropped the preview.
    await callOp('editor_set_clip_transform', { track: 0, clip: 0, scaling: 'native' });
    const native = useEditorTimelineStore.getState().timeline;
    if (!native) return;
    expect(resolveSourceFootprints(native, FRAME)).toEqual({ old: { width: 2, height: 2 } });
  });

  it('a wide source fits as a letterbox inside the portrait frame', async () => {
    await callOp('editor_add_clip', { mediaId: 'm-wide', track: 0, startFrame: 48 });
    const tl = useEditorTimelineStore.getState().timeline;
    if (!tl) throw new Error('no timeline');
    const wide = tl.tracks[0].clips.find((c) => c.start_frame === 48);
    const fp = resolveSourceFootprints(tl, FRAME)[wide?.id ?? ''];
    expect(fp.width).toBe(1);
    expect(fp.height).toBeCloseTo(607.5 / 1920, 6);
  });
});
