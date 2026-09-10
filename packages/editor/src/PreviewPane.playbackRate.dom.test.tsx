// @vitest-environment jsdom
/**
 * @apelles/editor — permanent real-DOM coverage for the preview PLAYBACK-RATE
 * control and its MCP surface (D-280).
 *
 * **Why this asserts on the DOM and on the IPC boundary rather than on the
 * store.** `@apelles/player`'s `playbackRate.test.ts` already proves the model
 * (bounds, presets, formatting) and its `Player.rate.dom.test.tsx` proves the
 * control's own wiring. What neither can prove is the thing this feature IS in
 * this tab: that the MCP op drives the SAME state the human's control does
 * (CLAUDE.md's "one op/store action under both interfaces" — a test that called
 * the op and read the store back would prove only that a setter was called),
 * and that a rate actually reaches the audio session, which is the half the
 * owner asked for by name ("with audio"). So the ops go through the REAL
 * `chroma://request` dispatch path `control.rs` uses, and the assertions are on
 * what is mounted and what was invoked.
 *
 * **The invariant this file exists to guard:** playback rate is TRANSPORT
 * state. It must never reach the project — no `chroma_timeline_set`, no clip
 * change — which is what keeps it from ever reaching an export, and is exactly
 * what separates it from the Inspector's per-clip Speed field (D-236).
 *
 * **Tier and its honest limits.** jsdom, sharing every caveat the sibling
 * `PreviewPane.*.dom.test.tsx` headers spell out: no layout engine, no real
 * decode, no real audio device. This proves the rate reaches
 * `chroma_audio_play`; whether 3x actually SOUNDS intelligible is proved on the
 * Rust side by `apelles_media::timestretch`'s pitch test (a 440 Hz tone still
 * measures 440 Hz at every rate) and, end to end, only by listening.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { MAX_PLAYBACK_RATE } from '@apelles/player';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 25;

const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

/** Every transport-affecting invoke the tree made, so the rate can be asserted
 *  at the boundary it actually crosses rather than in the store. */
const invoked = vi.hoisted(() => ({
  play: [] as Record<string, unknown>[],
  stop: [] as Record<string, unknown>[],
  timelineSet: [] as Record<string, unknown>[],
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
    chroma_audio_play: (args: Record<string, unknown> | undefined) => {
      invoked.play.push(args ?? {});
      return undefined;
    },
    chroma_audio_stop: (args: Record<string, unknown> | undefined) => {
      invoked.stop.push(args ?? {});
      return undefined;
    },
    chroma_audio_set_volume: () => undefined,
    chroma_audio_scrub_begin: () => undefined,
    chroma_audio_scrub_update: () => undefined,
    chroma_audio_scrub_end: () => undefined,
    chroma_audio_waveform: () => [],
    chroma_timeline_set: (args: Record<string, unknown> | undefined) => {
      invoked.timelineSet.push(args ?? {});
      return undefined;
    },
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

let requestId = 0;

async function callOp(op: string, args: Record<string, unknown>): Promise<OpEnvelope> {
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

/** One video track with one 40-second audio-bearing clip at 25 fps. */
function fixtureTimeline(): Timeline {
  return {
    id: 'rate-tl',
    name: 'rate',
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
      playhead: 125, // 5 s in at 25 fps
      playing: false,
      selection: [],
      selectedGap: null,
      playbackRate: 1,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(4);
  return mounted;
}

/** The transport's rate control, by the accessible name it exposes. */
function rateControl(): HTMLElement | null {
  return (
    (mounted?.container.querySelector('[aria-label="Playback rate"]') as HTMLElement | null) ?? null
  );
}

/** The most recent `chroma_audio_play` args, or `null` if there were none. */
function lastPlay(): Record<string, unknown> | null {
  return invoked.play.length ? invoked.play[invoked.play.length - 1] : null;
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  console_ = captureConsole();
  bus.emitted.length = 0;
  invoked.play.length = 0;
  invoked.stop.length = 0;
  invoked.timelineSet.length = 0;
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({ playbackRate: 1, playing: false }));
  expect(errors).toEqual([]);
});

describe('the preview playback-rate control (D-280)', () => {
  it('is in the transport bar, showing ordinary playback by default', async () => {
    await mountHarness();
    const control = rateControl();
    expect(control).not.toBeNull();
    expect(control!.textContent).toContain('1×');
  });

  /** **CLAUDE.md's standing rule, asserted rather than assumed**: the MCP op
   *  and the human's control are one capability, so the op has to move the same
   *  visible control — not merely set a flag. */
  it('editor_set_playback_rate moves the same control the human uses', async () => {
    await mountHarness();

    const env = await callOp('editor_set_playback_rate', { rate: 3 });
    await waitFrames(3);

    expect(env.ok).toBe(true);
    expect(env.result.playbackRate).toBe(3);
    expect(useEditorTimelineStore.getState().playbackRate).toBe(3);
    expect(rateControl()!.textContent).toContain('3×');
  });

  it('clamps an out-of-range rate and says so rather than failing silently', async () => {
    await mountHarness();

    const env = await callOp('editor_set_playback_rate', { rate: 500 });
    expect(env.ok).toBe(true);
    expect(env.result.playbackRate).toBe(MAX_PLAYBACK_RATE);
    expect(String(env.result.note)).toContain('clamped');
  });

  it('rejects a missing or nonsense rate with a message that names the other tool', async () => {
    await mountHarness();

    const missing = await callOp('editor_set_playback_rate', {});
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain('editor_set_clip_speed');

    const nonsense = await callOp('editor_set_playback_rate', { rate: 'fast' });
    expect(nonsense.ok).toBe(false);
  });

  it('is reported by editor_get_state, so an agent can read the transport it is driving', async () => {
    await mountHarness();
    await callOp('editor_set_playback_rate', { rate: 2 });

    const env = await callOp('editor_get_state', {});
    expect(env.ok).toBe(true);
    expect(env.result.playbackRate).toBe(2);
  });

  // ---- the "with audio" half ------------------------------------------- //

  it('hands the rate to the real audio session when playback starts', async () => {
    await mountHarness();
    await callOp('editor_set_playback_rate', { rate: 4 });
    await waitFrames(2);

    invoked.play.length = 0;
    await callOp('editor_set_playing', { playing: true });
    await waitFrames(3);

    const play = lastPlay();
    expect(play).not.toBeNull();
    expect(play!.rate).toBe(4);
    expect(play!.startFrame).toBe(125);
  });

  it('plays at 1x by default — the rate argument is always sent, never omitted', async () => {
    await mountHarness();

    await callOp('editor_set_playing', { playing: true });
    await waitFrames(3);

    expect(lastPlay()!.rate).toBe(1);
  });

  /** A rate change mid-playback re-baselines BOTH clocks: the old audio session
   *  is stopped and a fresh one starts at the new rate from the playhead the
   *  picture is on. That pairing is D-050's open-loop sync model, and it is the
   *  reason the rate is a session parameter rather than a live one. */
  it('restarts the audio session at the new rate when the rate changes while playing', async () => {
    await mountHarness();
    await callOp('editor_set_playing', { playing: true });
    await waitFrames(3);
    expect(lastPlay()!.rate).toBe(1);

    invoked.play.length = 0;
    invoked.stop.length = 0;
    await callOp('editor_set_playback_rate', { rate: 2 });
    await waitFrames(3);

    expect(invoked.stop.length).toBeGreaterThan(0);
    expect(lastPlay()).not.toBeNull();
    expect(lastPlay()!.rate).toBe(2);
  });

  /** The invariant this file exists for: a PLAYBACK rate is not a clip's Speed
   *  property (D-236). It writes nothing to the project, so it can never reach
   *  a save, an undo entry, or an export. */
  it('never persists anything — the timeline is untouched at any rate', async () => {
    await mountHarness();
    const timelineBefore = useEditorTimelineStore.getState().timeline;

    await callOp('editor_set_playback_rate', { rate: 4 });
    await callOp('editor_set_playing', { playing: true });
    await waitFrames(4);
    await callOp('editor_set_playing', { playing: false });
    await waitFrames(4);

    expect(invoked.timelineSet).toEqual([]);
    expect(useEditorTimelineStore.getState().timeline).toBe(timelineBefore);
  });
});
