// @vitest-environment jsdom
/**
 * @chroma/editor — permanent real-DOM coverage for the viewer's audio
 * MONITORING controls and their MCP surface (D-266): the mute button, the
 * volume slider, `editor_set_audio_monitor` and `editor_get_audio_level`.
 *
 * **Why the DOM.** D-266's whole content is that the agent and the human drive
 * the same two values: D-126 had put `muted`/`volume` in `PreviewPane`'s own
 * `useState`, where nothing outside React could reach them, so a test that
 * called the op and read the store back would prove only that a setter exists.
 * The assertions here are that the op moves the button the human sees, that
 * the human's click moves what the op reports, and — the fact that actually
 * matters at the boundary — that both end at the same
 * `chroma_audio_set_volume` invoke with the same number.
 *
 * **What this tier cannot check.** Whether anything is AUDIBLE. jsdom has no
 * audio device and this file's `chroma_audio_level` is a stub, so the level
 * op's contract is tested (it reaches the command, it reports the transport
 * state alongside the numbers, it explains a zero) and its truth is not. The
 * real end-to-end check is the env-gated `cpal` rms/peak proxy in
 * `crates/chroma-media/src/audio.rs`, the same one D-232's waveform work
 * leaned on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installCanvasContextStub,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type CanvasContextStub,
  type MountedComponent,
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 25;
const STRIP_WIDTH = 600;

const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

/** Every monitoring-related command the tree made, at the boundary the human's
 *  click and the agent's op both have to cross. */
const invoked = vi.hoisted(() => ({
  volume: [] as number[],
  level: 0,
  levelReading: [0, 0] as [number, number],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_frame: () => STUB_FRAME,
    chroma_timeline_composition_size: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...NATURAL_FULL_FRAME,
    }),
    chroma_timeline_clip_geometry: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...NATURAL_FULL_FRAME,
    }),
    chroma_project_get_settings: () => ({ width: CANVAS_W, height: CANVAS_H }),
    chroma_audio_play: () => undefined,
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: (args: Record<string, unknown> | undefined) => {
      invoked.volume.push(Number(args?.volume));
      return undefined;
    },
    chroma_audio_level: () => {
      invoked.level += 1;
      return invoked.levelReading;
    },
    chroma_audio_scrub_begin: () => undefined,
    chroma_audio_scrub_update: () => undefined,
    chroma_audio_scrub_end: () => undefined,
    chroma_audio_waveform: () => [],
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
import { PreviewPane } from './PreviewPane';
import type { Timeline } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;

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

function fixtureTimeline(): Timeline {
  return {
    id: 'monitor-tl',
    name: 'monitor',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'a',
            name: 'A',
            source_path: '/a.mov',
            source_start: 0,
            duration: 1000,
            source_len: 1000,
            source_fps: FPS,
            start_frame: 0,
          },
        ],
      },
    ],
  };
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let objectUrls: ObjectUrlStub;
let canvas: CanvasContextStub;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement(PreviewPane);
}

async function mountHarness(): Promise<MountedComponent> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixtureTimeline(),
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 125,
      playing: false,
      selection: [],
      selectedGap: null,
      waveformView: false,
      monitorVolume: 1,
      monitorMuted: false,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(4);
  return mounted;
}

/** The transport's mute button, by the accessible name it exposes. */
function muteButton(): HTMLElement | null {
  return (
    (mounted?.container.querySelector(
      'button[aria-label="Mute"], button[aria-label="Unmute"]',
    ) as HTMLElement | null) ?? null
  );
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  canvas = installCanvasContextStub(STRIP_WIDTH);
  console_ = captureConsole();
  bus.emitted.length = 0;
  invoked.volume.length = 0;
  invoked.level = 0;
  invoked.levelReading = [0, 0];
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  canvas.restore();
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({ monitorVolume: 1, monitorMuted: false }));
});

describe('the viewer monitoring controls (D-126/D-266)', () => {
  it('starts unmuted at unity and pushes that to the audio callback', async () => {
    await mountHarness();
    expect(muteButton()!.getAttribute('aria-pressed')).toBe('false');
    expect(invoked.volume[invoked.volume.length - 1]).toBe(1);
  });

  it('the human mute button drives the same store state the op reads', async () => {
    await mountHarness();

    await act(async () => {
      muteButton()!.click();
    });
    await waitFrames(3);

    expect(useEditorTimelineStore.getState().monitorMuted).toBe(true);
    expect(muteButton()!.getAttribute('aria-label')).toBe('Unmute');
    // The real effect of a mute: zero reaches the output callback.
    expect(invoked.volume[invoked.volume.length - 1]).toBe(0);

    // …and the agent reads back what the human just did, in one state call.
    const state = await callOp('editor_get_state');
    expect(state.result.monitor).toEqual({ volume: 1, muted: true });
  });
});

describe('editor_set_audio_monitor (D-266)', () => {
  /** **CLAUDE.md's standing rule, asserted rather than assumed**: the op and
   *  the human's button are one capability, so the op has to move the button
   *  the human sees AND reach the same command the click does. */
  it('mutes the same button the human clicks, through the same command', async () => {
    await mountHarness();
    expect(muteButton()!.getAttribute('aria-pressed')).toBe('false');

    const env = await callOp('editor_set_audio_monitor', { muted: true });
    await waitFrames(3);

    expect(env.ok).toBe(true);
    expect(env.result).toMatchObject({ muted: true, volume: 1, effectiveVolume: 0 });
    expect(muteButton()!.getAttribute('aria-pressed')).toBe('true');
    expect(muteButton()!.getAttribute('aria-label')).toBe('Unmute');
    expect(invoked.volume[invoked.volume.length - 1]).toBe(0);
  });

  it('sets a volume and pushes exactly that number to the audio callback', async () => {
    await mountHarness();

    const env = await callOp('editor_set_audio_monitor', { volume: 0.25 });
    await waitFrames(3);

    expect(env.ok).toBe(true);
    expect(env.result).toMatchObject({ volume: 0.25, muted: false, effectiveVolume: 0.25 });
    expect(invoked.volume[invoked.volume.length - 1]).toBe(0.25);
  });

  /** Volume and mute are independent facts: a mute must not forget where the
   *  slider was, or unmuting would silently reset the human's level. */
  it('remembers the volume across a mute, and restores it on unmute', async () => {
    await mountHarness();
    await callOp('editor_set_audio_monitor', { volume: 0.4 });
    await callOp('editor_set_audio_monitor', { muted: true });
    await waitFrames(3);
    expect(invoked.volume[invoked.volume.length - 1]).toBe(0);

    const back = await callOp('editor_set_audio_monitor', { muted: false });
    await waitFrames(3);
    expect(back.result).toMatchObject({ volume: 0.4, muted: false, effectiveVolume: 0.4 });
    expect(invoked.volume[invoked.volume.length - 1]).toBe(0.4);
  });

  /** Never a silent no-op (B-053's shape): the clamp is honoured, and said. */
  it('clamps an out-of-range volume and says that it did', async () => {
    await mountHarness();

    const high = await callOp('editor_set_audio_monitor', { volume: 4 });
    expect(high.ok).toBe(true);
    expect(high.result.volume).toBe(1);
    expect(high.result.note).toMatch(/clamped/);

    const low = await callOp('editor_set_audio_monitor', { volume: -2 });
    expect(low.result.volume).toBe(0);
    expect(low.result.note).toMatch(/clamped/);

    const fine = await callOp('editor_set_audio_monitor', { volume: 0.5 });
    expect(fine.result.note).toBeUndefined();
  });

  it('rejects a call that asks for nothing, or a nonsense volume', async () => {
    await mountHarness();
    expect((await callOp('editor_set_audio_monitor', {})).ok).toBe(false);
    expect((await callOp('editor_set_audio_monitor', { volume: 'loud' })).ok).toBe(false);
    // …and neither of those touched the real state.
    expect(useEditorTimelineStore.getState().monitorVolume).toBe(1);
  });
});

describe('editor_get_audio_level (D-266)', () => {
  it('reports the measured level with the transport state that explains it', async () => {
    await mountHarness();
    invoked.levelReading = [0.12, 0.87];
    actSync(() => useEditorTimelineStore.getState().setPlaying(true));

    const env = await callOp('editor_get_audio_level');

    expect(env.ok).toBe(true);
    expect(invoked.level).toBeGreaterThan(0);
    expect(env.result).toMatchObject({
      rms: 0.12,
      peak: 0.87,
      playing: true,
      muted: false,
      volume: 1,
      windowSecs: 1,
    });
    // A real, non-silent reading needs no caveat.
    expect(env.result.note).toBeUndefined();

    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
  });

  /** A zero has three quite different causes and the tool must not let them
   *  read as one. The stopped case is the trap: the value is the LAST measured
   *  window, not a live zero. */
  it('explains a zero rather than letting it read as "no audio"', async () => {
    await mountHarness();

    const stopped = await callOp('editor_get_audio_level');
    expect(stopped.result.playing).toBe(false);
    expect(stopped.result.note).toMatch(/nothing is playing/);

    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    const playing = await callOp('editor_get_audio_level');
    expect(playing.result.note).toMatch(/silence/);

    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
  });
});
