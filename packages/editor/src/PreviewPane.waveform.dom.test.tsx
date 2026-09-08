// @vitest-environment jsdom
/**
 * @chroma/editor — permanent real-DOM coverage for the viewer's audio waveform
 * strip and its MCP surface (D-232, roadmap item 27).
 *
 * **Why this asserts on the DOM rather than on the store.** `scrubSource.test.ts`
 * already proves the resolver and the window/tile arithmetic, which is the part
 * with correct answers. What it cannot prove is the thing this feature is: that
 * the toggle actually puts a waveform surface into the viewer, that the MCP op
 * drives the SAME flag the human's button does (CLAUDE.md's standing "one
 * op/store action under both interfaces" rule — a test that called the op and
 * read the store back would prove only that a setter was called), and that
 * `editor_get_waveform` really reaches the backend with the window the strip
 * would draw. So the ops go through the REAL `chroma://request` dispatch path
 * `control.rs` uses, and the assertions are on what is mounted and what was
 * invoked.
 *
 * **Tier and its honest limits.** jsdom, sharing every caveat the sibling
 * `PreviewPane.*.dom.test.tsx` headers spell out: no layout engine, and no
 * canvas rasteriser at all — `installCanvasContextStub` supplies a recording 2D
 * context and the one fixed strip width every drawn column is measured against.
 * So this can assert the geometry the component *asked for* (where it put the
 * playhead line, how it dimmed material outside the clip) and never that a real
 * WKWebView paints those pixels where a human would see them.
 *
 * What a *scrub* SOUNDS like is not testable at any tier available to an agent.
 * The nearest thing is the env-gated `cpal` rms/peak proxy in
 * `app/src-tauri/src/chroma/audio.rs` — "real, non-silent PCM reached the real
 * output device while scrubbing" — which is a genuine end-to-end check and
 * still says nothing about whether it sounds right. See D-232's verification
 * note.
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

/** The measured pixel width `installCanvasContextStub` hands the strip — jsdom
 *  lays nothing out, so this is the one width every drawn column is against. */
const STRIP_WIDTH = 600;

const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

/** Every `chroma_audio_waveform` call the tree made, so the tile/window
 *  arithmetic can be asserted at the boundary it actually crosses. */
const invoked = vi.hoisted(() => ({ waveform: [] as Record<string, unknown>[] }));

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
    chroma_audio_set_volume: () => undefined,
    chroma_audio_scrub_begin: () => undefined,
    chroma_audio_scrub_update: () => undefined,
    chroma_audio_scrub_end: () => undefined,
    chroma_audio_waveform: (args: Record<string, unknown> | undefined) => {
      invoked.waveform.push(args ?? {});
      // B-115 — a source with no audio stream comes back as an EMPTY envelope,
      // not as an error and not as zeroes: that is `waveform_peaks`'s real
      // contract for `!VideoInfo::has_audio`. One fixture path opts into it so
      // the strip's "why am I empty" branch is driven by the real shape.
      if (String(args?.sourcePath ?? '').includes('silent')) return [];
      // Two buckets, both non-silent — enough to be a real answer without
      // pretending this tier can check the drawing.
      return [
        [-0.5, 0.5],
        [-0.25, 0.25],
      ];
    },
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
import { WAVEFORM_WINDOW_SECS } from './scrubSource';
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

/** One video track with one 10-second audio-bearing clip at 25 fps. */
function fixtureTimeline(): Timeline {
  return {
    id: 'wave-tl',
    name: 'wave',
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
      playhead: 125, // 5 s in at 25 fps — clear of the head-of-file clamp
      playing: false,
      selection: [],
      selectedGap: null,
      waveformView: false,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(4);
  return mounted;
}

/** The strip itself, or `null` when it is toggled off. */
function strip(): HTMLElement | null {
  return (mounted?.container.querySelector('[data-scrub-waveform]') as HTMLElement | null) ?? null;
}

/** B-115 — the strip's own explanation of why it is empty, or `null` when it
 *  is drawing real peaks (or still fetching them). */
function emptyLabel(): string | null {
  const el = mounted?.container.querySelector('[data-scrub-waveform-empty]');
  return el?.textContent ?? null;
}

/** The transport's own toggle button, by the accessible name it exposes. */
function toggleButton(): HTMLElement | null {
  return (
    (mounted?.container.querySelector(
      'button[aria-label="Show the audio waveform"], button[aria-label="Hide the audio waveform"]',
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
  invoked.waveform.length = 0;
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
  actSync(() => useEditorTimelineStore.setState({ waveformView: false }));
  expect(errors).toEqual([]);
});

describe('the viewer waveform strip (D-232)', () => {
  it('is hidden by default and appears when the human toggles it', async () => {
    await mountHarness();
    expect(strip()).toBeNull();

    const button = toggleButton();
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      button!.click();
    });
    await waitFrames(3);

    expect(strip()).not.toBeNull();
    expect(toggleButton()!.getAttribute('aria-pressed')).toBe('true');
    expect(useEditorTimelineStore.getState().waveformView).toBe(true);
  });

  /** **CLAUDE.md's standing rule, asserted rather than assumed**: the MCP op
   *  and the human's button are one capability, so the op has to produce the
   *  same DOM the click does — not merely set a flag. */
  it('editor_set_waveform_view mounts the same strip the button does', async () => {
    await mountHarness();
    expect(strip()).toBeNull();

    const env = await callOp('editor_set_waveform_view', { open: true });
    await waitFrames(3);

    expect(env.ok).toBe(true);
    expect(env.result.waveformView).toBe(true);
    expect(strip()).not.toBeNull();
    // …and the button the human sees now reflects the agent's change.
    expect(toggleButton()!.getAttribute('aria-pressed')).toBe('true');

    const off = await callOp('editor_set_waveform_view', { open: false });
    await waitFrames(3);
    expect(off.ok).toBe(true);
    expect(strip()).toBeNull();
  });

  /** **B-115 — "idk what is this audio waveform but it seems broken."**
   *
   *  The owner opened this strip on a reel of screen recordings that genuinely
   *  have no audio stream, and read the flat centre line as a bug. They were
   *  right to: that same line was what this drew for silence, for "still
   *  fetching" and for "nothing resolved here", so the one state a user has to
   *  be able to tell apart from a defect looked exactly like one. The line is
   *  still the honest picture of silence; the label is what makes it legible. */
  it('says WHY it is empty, rather than drawing a line that could be a bug', async () => {
    await mountHarness();
    await act(async () => {
      useEditorTimelineStore.setState({ waveformView: true });
    });
    await waitFrames(3);

    // A source with real peaks draws them and explains nothing.
    expect(strip()).not.toBeNull();
    expect(emptyLabel()).toBeNull();

    // A clip whose source has no audio stream at all — an empty envelope from
    // `waveform_peaks`, which is exactly what a screen recording returns.
    await act(async () => {
      const tl = fixtureTimeline();
      tl.tracks[0].clips[0].source_path = '/silent-screen-recording.mov';
      useEditorTimelineStore.setState({ timeline: tl });
    });
    await waitFrames(4);
    expect(emptyLabel()).toBe('This clip has no audio');

    // In a GAP there is no source to resolve at all — a different empty for a
    // different reason, and it says so rather than reusing one vague message.
    await act(async () => {
      const tl = fixtureTimeline();
      tl.tracks[0].clips[0].start_frame = 500; // the playhead (125) is before it
      useEditorTimelineStore.setState({ timeline: tl });
    });
    await waitFrames(4);
    expect(emptyLabel()).toBe('No audio at the playhead');
  });

  it('rejects a call with no open flag rather than guessing', async () => {
    await mountHarness();
    const env = await callOp('editor_set_waveform_view', {});
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/open/);
  });

  /** The strip must ask the backend for the SNAPPED TILE, not for the sliding
   *  window — the D-128 cache-miss-per-frame defect this feature is built to
   *  avoid (see `waveformTileFor`). At 30 s the tile is [24, 36), never the
   *  [28, 32) window actually drawn.
   *
   *  A playhead of its own, distinct from every other case here, because
   *  `getPeaks`'s cache is module-level and deliberately outlives one test —
   *  reusing 5 s would make this assert on a cache hit that never reached the
   *  backend at all. */
  it('fetches a snapped tile, not the sliding window it draws', async () => {
    await mountHarness();
    actSync(() => useEditorTimelineStore.getState().setPlayhead(750)); // 30 s
    await act(async () => {
      toggleButton()!.click();
    });
    await waitFrames(4);

    const calls = invoked.waveform.filter((c) => c.sourcePath === '/a.mov');
    expect(calls.length).toBeGreaterThan(0);
    const call = calls[calls.length - 1];
    expect(call.startSecs).toBe(24);
    expect(call.durationSecs).toBe(12);
    expect(call.durationSecs).not.toBe(WAVEFORM_WINDOW_SECS);
  });

  /** The one drawing property this tier can honestly check: the playhead line
   *  lands where `waveformWindowAt` said it would. At 5 s, mid-source, the
   *  window is centred and the line is at half the strip's width — the
   *  behaviour that makes the picture scroll under a fixed playhead. */
  it('draws the playhead line at the centre of a centred window', async () => {
    await mountHarness();
    await act(async () => {
      toggleButton()!.click();
    });
    await waitFrames(4);

    const fills = canvas.fills();
    expect(fills.length).toBeGreaterThan(0);
    // The playhead is the last thing drawn, at full opacity and 2 px wide.
    const line = fills[fills.length - 1];
    expect(line.globalAlpha).toBe(1);
    expect(line.w).toBe(2);
    expect(line.x).toBe(Math.round(STRIP_WIDTH / 2));

    // …and the waveform columns before it were drawn at the in-clip opacity:
    // the whole 4 s window at 5 s sits inside a 40 s clip.
    const columns = fills.slice(0, -1);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((f) => f.globalAlpha > 0.5)).toBe(true);
  });

  /** …and past the clip's own out-point the strip dims: that material exists in
   *  the source but is not on the timeline, which is exactly what the reference
   *  image's brighter-inner-region conveys. The clip ends at 40 s, so a
   *  playhead there puts half the window outside it. */
  it('dims the part of the window that is outside the clip', async () => {
    await mountHarness();
    actSync(() => useEditorTimelineStore.getState().setPlayhead(999)); // the clip's last frame
    await act(async () => {
      toggleButton()!.click();
    });
    await waitFrames(4);

    const columns = canvas.fills().slice(0, -1);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.some((f) => f.globalAlpha > 0.5)).toBe(true);
    expect(columns.some((f) => f.globalAlpha < 0.5)).toBe(true);
  });
});

describe('editor_get_waveform (D-232) — the agent-side half', () => {
  it('answers with the resolved source, the window, and real peaks', async () => {
    await mountHarness();
    const env = await callOp('editor_get_waveform', { buckets: 2 });

    expect(env.ok).toBe(true);
    expect(env.result.frame).toBe(125);
    expect(env.result.source).toMatchObject({ path: '/a.mov', track: 0, clipId: 'a' });
    expect(env.result.source.sourceSecs).toBeCloseTo(5, 6);
    // Centred on the playhead, `WAVEFORM_WINDOW_SECS` wide by default.
    expect(env.result.window.startSecs).toBe(5 - WAVEFORM_WINDOW_SECS / 2);
    expect(env.result.window.durationSecs).toBe(WAVEFORM_WINDOW_SECS);
    expect(env.result.window.playheadFraction).toBeCloseTo(0.5, 6);
    expect(env.result.peaks).toEqual([
      [-0.5, 0.5],
      [-0.25, 0.25],
    ]);
  });

  it('takes an explicit frame and window, and passes them to the backend', async () => {
    await mountHarness();
    const env = await callOp('editor_get_waveform', { frame: 25, windowSecs: 2, buckets: 8 });

    expect(env.ok).toBe(true);
    expect(env.result.frame).toBe(25);
    expect(env.result.window.durationSecs).toBe(2);
    const call = invoked.waveform[invoked.waveform.length - 1];
    expect(call).toMatchObject({ sourcePath: '/a.mov', durationSecs: 2, buckets: 8 });
  });

  /** "Nothing audible here" is a normal answer, not an error — the same
   *  contract `chroma_audio_waveform` itself has for a silent source. */
  it('reports no source past the end of the timeline rather than erroring', async () => {
    await mountHarness();
    const env = await callOp('editor_get_waveform', { frame: 100000 });
    expect(env.ok).toBe(true);
    expect(env.result.source).toBeNull();
    expect(env.result.note).toMatch(/no audible source/);
  });

  it('rejects a nonsense window or bucket count', async () => {
    await mountHarness();
    expect((await callOp('editor_get_waveform', { windowSecs: 0 })).ok).toBe(false);
    expect((await callOp('editor_get_waveform', { buckets: 0 })).ok).toBe(false);
    expect((await callOp('editor_get_waveform', { buckets: 999999 })).ok).toBe(false);
  });
});
