// @vitest-environment jsdom
/**
 * @apelles/editor — `editor_add_clip` with no `track` (B-273).
 *
 * Run through the real `chroma://request` dispatch path into the real timeline
 * store, so what is asserted is what the MCP tool gets back and what the store
 * (the same one the GUI renders) holds afterwards. Omitting `track` must put
 * the clip on a brand-new track of the kind the source needs, in ONE undo
 * entry; a given `track` is still validated and an invalid one still refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    // The store's debounced persist; the test only reads the in-memory store.
    chroma_timeline_set: () => null,
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

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

const pool: MediaItem[] = [
  {
    id: 'm-sfx',
    sourcePath: '/sfx/whoosh.wav',
    name: 'whoosh.wav',
    added: '2026-10-26T00:00:00Z',
    offline: false,
    folder: null,
    video: { width: 0, height: 0, fps: 24, frameCount: 48, durationSecs: 2, hasAudio: true, audioChannels: 2 },
  },
  {
    id: 'm-mov',
    sourcePath: '/footage/b.mov',
    name: 'b.mov',
    added: '2026-10-26T00:00:00Z',
    offline: false,
    folder: null,
    video: { width: 1920, height: 1080, fps: 24, frameCount: 96, durationSecs: 4, hasAudio: false, audioChannels: 0 },
  },
  {
    id: 'm-png',
    sourcePath: '/refs/card.png',
    name: 'card.png',
    added: '2026-10-26T00:00:00Z',
    offline: false,
    folder: null,
    image: { width: 1280, height: 720 },
  },
];

const timeline = (): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: 24, den: 1 },
  tracks: [
    {
      kind: 'video',
      clips: [
        { id: 'a', name: 'a', source_path: '/footage/a.mov', source_start: 0, duration: 48, source_len: 48, start_frame: 0 },
      ],
    },
    {
      kind: 'audio',
      clips: [
        { id: 'vo', name: 'vo', source_path: '/vo/vo.wav', source_start: 0, duration: 48, source_len: 48, start_frame: 0 },
      ],
    },
  ],
});

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `add-${++requestId}`;
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

const undoDepth = (): number => useHistoryStore.getState().undoStack.length;

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

describe('editor_add_clip without a track (B-273)', () => {
  it('puts an audio-only source on a new audio track at the bottom, in one undo entry', async () => {
    const before = undoDepth();
    const env = await callOp('editor_add_clip', { mediaId: 'm-sfx', startFrame: 12, duration: 24 });
    expect(env.error).toBeNull();
    expect(env.ok).toBe(true);
    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'audio']);
    expect(env.result.track).toBe(2);
    expect(env.result.createdTrack).toBe(true);
    expect(env.result.trackCount).toBe(3);
    expect(tl?.tracks[2].clips.map((c) => [c.source_path, c.start_frame])).toEqual([['/sfx/whoosh.wav', 12]]);
    // The existing tracks are untouched, and no linked "audio half" duplicate was made.
    expect(tl?.tracks[1].clips.map((c) => c.id)).toEqual(['vo']);
    expect(env.result.linkedAudio).toBeNull();
    expect(undoDepth() - before).toBe(1);
    // One Undo takes back both the clip and the track it created.
    act(() => useHistoryStore.getState().undo());
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
  });

  it('puts footage on a new video track at the top, renumbering the rest', async () => {
    const env = await callOp('editor_add_clip', { mediaId: 'm-mov' });
    expect(env.ok).toBe(true);
    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'audio']);
    expect(env.result.track).toBe(0);
    expect(env.result.createdTrack).toBe(true);
    expect(tl?.tracks[0].clips.map((c) => c.source_path)).toEqual(['/footage/b.mov']);
    expect(tl?.tracks[1].clips.map((c) => c.id)).toEqual(['a']);
  });

  it('puts a still on a new video track too (never an audio one)', async () => {
    const env = await callOp('editor_add_clip', { mediaId: 'm-png' });
    expect(env.ok).toBe(true);
    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.tracks[0].kind).toBe('video');
    expect(tl?.tracks[0].clips.map((c) => c.source_path)).toEqual(['/refs/card.png']);
  });

  it('treats an explicit null track as omitted', async () => {
    const env = await callOp('editor_add_clip', { mediaId: 'm-sfx', track: null });
    expect(env.ok).toBe(true);
    expect(env.result.createdTrack).toBe(true);
  });
});

describe('editor_add_clip with a track (B-259 / B-273)', () => {
  it('still refuses a track that does not exist, and changes nothing', async () => {
    const before = undoDepth();
    const env = await callOp('editor_add_clip', { mediaId: 'm-sfx', track: 7 });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('no track 7');
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
    expect(undoDepth()).toBe(before);
  });

  it('refuses a track that is not an index at all, rather than reading it as NaN', async () => {
    const env = await callOp('editor_add_clip', { mediaId: 'm-sfx', track: 'audio' });
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/track must be a track index/);
    expect(env.error).not.toContain('NaN');
  });

  it('places on the given track and reports it as not created', async () => {
    const env = await callOp('editor_add_clip', { mediaId: 'm-sfx', track: 1, startFrame: 100 });
    expect(env.ok).toBe(true);
    expect(env.result.track).toBe(1);
    expect(env.result.createdTrack).toBe(false);
    expect(useEditorTimelineStore.getState().timeline?.tracks).toHaveLength(2);
  });
});
