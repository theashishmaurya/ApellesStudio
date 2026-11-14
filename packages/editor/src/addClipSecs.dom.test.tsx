// @vitest-environment jsdom
/**
 * @apelles/editor — `editor_add_clip`'s SECONDS forms (B-390).
 *
 * What it is: the regression guard for B-390, run through the real
 * `chroma://request` dispatch into the real timeline store, so what is
 * asserted is the clip an MCP caller actually gets.
 *
 * Why it exists: `duration`/`sourceStart` are in the SOURCE's own frames, which
 * differ per file — a 1925 silent transfer runs at 20881/1214 ≈ 17.2 fps, a
 * NASA clip at 60000/1001 ≈ 59.94 — so `duration: 25` is one second of a 25 fps
 * source and 0.42 s of the NASA one, with no error either way: the clip is
 * simply the wrong length, and on a cut timed to music every shot after it is
 * wrong too. The fix accepts the intent (`durationSecs` / `sourceStartSecs`)
 * and converts from the clip's own rate. That conversion had no test, which is
 * exactly the shape of defect that regresses silently.
 *
 * What it does NOT do: assert anything about the MCP tool schemas (both servers
 * carry the parameters; the parity corpus covers that), or about placement,
 * track choice or linking — `addClipNewTrack.dom.test.tsx` owns those.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
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

// B-386 — replies reach the control server through commands, not events.
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

import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { useHistoryStore } from '@apelles/history';
import type { Clip, Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

/** The two real rates from B-390's own repro, and the timeline's own 25 fps. */
const SILENT_FPS = 20881 / 1214; // ≈ 17.19934 — a 1925 transfer
const NTSC_FPS = 60000 / 1001; // ≈ 59.94006 — the NASA clip
const TIMELINE_FPS = 25;

const pool: MediaItem[] = [
  {
    id: 'm-silent',
    sourcePath: '/footage/potemkin.mp4',
    name: 'potemkin.mp4',
    added: '2026-11-07T00:00:00Z',
    offline: false,
    folder: null,
    video: {
      width: 1360,
      height: 1072,
      fps: SILENT_FPS,
      frameCount: 1720,
      durationSecs: 100,
      hasAudio: false,
      audioChannels: 0,
    },
  },
  {
    id: 'm-ntsc',
    sourcePath: '/footage/nasa.mp4',
    name: 'nasa.mp4',
    added: '2026-11-07T00:00:00Z',
    offline: false,
    folder: null,
    video: {
      width: 1280,
      height: 720,
      fps: NTSC_FPS,
      frameCount: 5994,
      durationSecs: 100,
      hasAudio: false,
      audioChannels: 0,
    },
  },
];

const timeline = (): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: TIMELINE_FPS, den: 1 },
  tracks: [{ kind: 'video', clips: [] }],
});

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `secs-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

/** The clip the op just placed, read out of the store the GUI renders. */
function placed(): Clip {
  const clips = useEditorTimelineStore.getState().timeline?.tracks[0]?.clips ?? [];
  const last = clips[clips.length - 1];
  if (!last) throw new Error('no clip was placed');
  return last;
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

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

describe('editor_add_clip in seconds (B-390)', () => {
  it('converts durationSecs from the SOURCE\'s own rate, not the timeline\'s', async () => {
    const env = await callOp('editor_add_clip', {
      mediaId: 'm-silent',
      track: 0,
      startFrame: 0,
      durationSecs: 1,
    });
    expect(env.error).toBeNull();
    // 17.19934 rounds to 17 of the source's frames — NOT the timeline's 25,
    // which is the number a caller would have passed as `duration` meaning
    // "one second" and got 1.44 s for.
    expect(placed().duration).toBe(Math.round(SILENT_FPS));
    expect(placed().duration).not.toBe(TIMELINE_FPS);
  });

  it('gives the same request a different frame count on a source of a different rate — one second each', async () => {
    await callOp('editor_add_clip', { mediaId: 'm-ntsc', track: 0, startFrame: 0, durationSecs: 1 });
    expect(placed().duration).toBe(Math.round(NTSC_FPS)); // 60
    await callOp('editor_add_clip', { mediaId: 'm-silent', track: 0, startFrame: 100, durationSecs: 1 });
    expect(placed().duration).toBe(Math.round(SILENT_FPS)); // 17
  });

  it('converts sourceStartSecs the same way', async () => {
    const env = await callOp('editor_add_clip', {
      mediaId: 'm-silent',
      track: 0,
      startFrame: 0,
      sourceStartSecs: 2,
      durationSecs: 1,
    });
    expect(env.error).toBeNull();
    expect(placed().source_start).toBe(Math.round(2 * SILENT_FPS)); // 34
  });

  it('leaves the frame forms exactly as they were — nothing existing moves', async () => {
    await callOp('editor_add_clip', {
      mediaId: 'm-silent',
      track: 0,
      startFrame: 0,
      sourceStart: 50,
      duration: 25,
    });
    expect(placed().duration).toBe(25);
    expect(placed().source_start).toBe(50);
  });

  it('lets the seconds form win when both are given, for duration and for sourceStart', async () => {
    await callOp('editor_add_clip', {
      mediaId: 'm-ntsc',
      track: 0,
      startFrame: 0,
      duration: 25,
      durationSecs: 1,
      sourceStart: 5,
      sourceStartSecs: 1,
    });
    expect(placed().duration).toBe(Math.round(NTSC_FPS));
    expect(placed().source_start).toBe(Math.round(NTSC_FPS));
  });

  it('refuses a seconds range that runs off the end of the source, in the same words as the frame form', async () => {
    const env = await callOp('editor_add_clip', {
      mediaId: 'm-silent',
      track: 0,
      startFrame: 0,
      durationSecs: 1000,
    });
    expect(env.ok).toBe(false);
    expect(env.error).toContain("the source's own length");
  });

  it('never converts a second to zero frames: a sub-frame request still places a real clip', async () => {
    const env = await callOp('editor_add_clip', {
      mediaId: 'm-silent',
      track: 0,
      startFrame: 0,
      durationSecs: 0.001,
    });
    expect(env.error).toBeNull();
    expect(placed().duration).toBeGreaterThanOrEqual(1);
  });
});
