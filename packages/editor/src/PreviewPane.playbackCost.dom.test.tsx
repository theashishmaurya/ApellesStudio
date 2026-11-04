// @vitest-environment jsdom
/**
 * @apelles/editor — what a played preview frame costs the webview (D-290,
 * B-146; reshaped by D-454).
 *
 * **Why this file exists.** The owner's "playback lags" report was profiled to
 * this side of the IPC (D-290): React committing the pane twice per frame, a
 * JPEG to decode per frame, a play loop that waited on its own round trips
 * (B-370). Since D-454 the picture never crosses the IPC at all — the Rust
 * playback loop draws it natively and reports each frame it shows as an event
 * — so what is left to hold down here is what one such event costs: one move
 * of the playhead, at most one commit, no request for a frame, no listener
 * churn on the preview surface, and no redraw of the frame already on screen
 * when the transport pauses.
 *
 * **Tier and its honest limits.** jsdom: no presenter, no decode, no paint.
 * The test plays the Rust loop's part by firing its event. The milliseconds
 * are measured live (`debug_frame_timing`, `debug_native_preview_stats`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  PREVIEW_SURFACE_STUBS,
  actSync,
  captureConsole,
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';
import { fireEvent, resetEventBus } from './testUtils/eventBus';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 25;
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

/** Every position the preview was asked to SHOW (a draw), in order — the IPC
 *  boundary the redundant-draw assertions are made at. */
const shown = vi.hoisted(() => ({ pos: [] as number[] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    ...PREVIEW_SURFACE_STUBS,
    chroma_preview_surface_show: (args: Record<string, unknown> | undefined) => {
      shown.pos.push(Number(args?.position));
      return { position: Number(args?.position), renderMs: 0, acquireMs: 0 };
    },
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
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

vi.mock('@tauri-apps/api/event', async () => (await import('./testUtils/eventBus')).eventModule);

import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import { previewTimingReport, resetPreviewTiming } from './previewTiming';
import type { Timeline } from './timeline';

function fixtureTimeline(): Timeline {
  return {
    id: 'cost-tl',
    name: 'cost',
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
            duration: 2000,
            source_len: 2000,
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
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** React commits of the `PreviewPane` subtree, counted by a real `Profiler`. */
const commits = { count: 0 };

function Harness(): React.ReactElement {
  return React.createElement(
    React.Profiler,
    {
      id: 'preview',
      onRender: () => {
        commits.count += 1;
      },
    },
    React.createElement(PreviewPane),
  );
}

/** Mounted WITHOUT StrictMode, deliberately: its double-invoke would make a
 *  commit COUNT meaningless. */
async function mountHarness(): Promise<MountedComponent> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixtureTimeline(),
      openProjectKey: 'cost-project',
      status: 'ready',
      error: null,
      playhead: 100,
      playing: false,
      selection: [],
      selectedGap: null,
      playbackRate: 1,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(4);
  return mounted;
}

/** Play, with the Rust loop's part played by `frames` events. */
async function playThrough(frames: number[]): Promise<void> {
  actSync(() => useEditorTimelineStore.getState().setPlaying(true));
  await waitFrames(2);
  for (const frame of frames) {
    actSync(() => fireEvent('chroma://preview-playhead', { frame, ended: false }));
    await waitFrames(1);
  }
}

beforeEach(() => {
  console_ = captureConsole();
  restoreOffsets = stubOffsetMetrics(1200, 600);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  shown.pos = [];
  commits.count = 0;
  resetPreviewTiming();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  resetEventBus();
  actSync(() => useEditorTimelineStore.setState({ playing: false, playbackRate: 1 }));
  console_.restore();
});

const PLAYED = Array.from({ length: 30 }, (_, i) => 101 + i);

describe('a played preview frame (D-290 / B-146 / D-454)', () => {
  it('moves the playhead and asks the backend for nothing: the picture is already on the glass', async () => {
    await mountHarness();
    const before = shown.pos.length;
    await playThrough(PLAYED);
    expect(useEditorTimelineStore.getState().playhead).toBe(PLAYED.at(-1));
    expect(shown.pos.length).toBe(before);
  });

  it('costs at most one React commit per frame', async () => {
    await mountHarness();
    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    await waitFrames(2);
    commits.count = 0;
    for (const frame of PLAYED) {
      actSync(() => fireEvent('chroma://preview-playhead', { frame, ended: false }));
      await waitFrames(1);
    }
    // A per-frame regression scales with the frame count and blows through
    // this; the constant is the transport's own churn.
    expect(commits.count).toBeLessThanOrEqual(PLAYED.length + 2);
  });

  it('does not redraw the frame already on screen when playback is paused', async () => {
    await mountHarness();
    await playThrough(PLAYED);
    const before = shown.pos.length;
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
    await waitFrames(4);
    expect(shown.pos.slice(before)).not.toContain(PLAYED.at(-1));
  });

  it('records each shown frame in the paint channel', async () => {
    await mountHarness();
    resetPreviewTiming();
    await playThrough(PLAYED);
    expect(previewTimingReport().paint.samples).toBe(PLAYED.length);
  });
});

describe('the preview surface during playback (D-290 / B-146)', () => {
  it('does not tear down and re-add its capture-phase pointer listener every frame', async () => {
    await mountHarness();
    const added: string[] = [];
    const realAdd = HTMLElement.prototype.addEventListener;
    const spy = vi
      .spyOn(HTMLElement.prototype, 'addEventListener')
      .mockImplementation(function (this: HTMLElement, type: string, ...rest: unknown[]) {
        if (type === 'pointerdown') added.push(type);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realAdd as any).call(this, type, ...rest);
      } as typeof HTMLElement.prototype.addEventListener);
    try {
      await playThrough(PLAYED);
      actSync(() => useEditorTimelineStore.getState().setPlaying(false));
      await waitFrames(2);
    } finally {
      spy.mockRestore();
    }
    expect(added.length).toBeLessThanOrEqual(2);
  });
});
