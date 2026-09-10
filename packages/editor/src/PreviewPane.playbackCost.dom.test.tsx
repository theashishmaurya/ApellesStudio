// @vitest-environment jsdom
/**
 * @apelles/editor — what one displayed preview frame COSTS (D-282, B-146).
 *
 * **Why this file exists.** The owner's report was "playback lags", and
 * profiling it live (`debug_frame_timing` against the real app and the real
 * project — the numbers are in D-282) found the ceiling is not the decoder:
 * one pass of `PreviewPane`'s play loop cost 25.0 ms, and 21.5 ms of that was
 * still there over a timeline GAP where Rust decodes nothing at all. The
 * expensive part was this side of the IPC, and the biggest single piece of it
 * that could be removed without a redesign was React: every displayed frame
 * used to commit `PreviewPane`'s whole subtree **twice** — once for the
 * playhead, once again for the picture's `src`.
 *
 * **What is asserted here, and why in this shape.** A wall-clock "it is
 * faster" assertion in jsdom would be worthless — there is no decoder, no
 * paint, no compositor. What jsdom CAN measure exactly, and what the fix
 * actually is, is **how many React commits a played frame causes**. So the
 * assertions are commit counts from a real `React.Profiler`, frame counts from
 * the real `<img>`'s `src`, and call counts at the real IPC boundary. Those
 * are exact numbers with correct answers, and each one fails on the pre-D-282
 * code for the right reason.
 *
 * **Tier and its honest limits.** jsdom, sharing every caveat the sibling
 * `PreviewPane.*.dom.test.tsx` headers spell out: no layout engine, no real
 * decode, no real paint. This proves the loop stopped doing the work; it
 * cannot prove how many milliseconds that is worth on the owner's machine —
 * that is what `debug_frame_timing`'s new `fetch`/`tick` spans are for, live.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

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

/** Every `chroma_timeline_frame` position asked for, in order — the IPC
 *  boundary the redundant-fetch assertions are made at. */
const framesAsked = vi.hoisted(() => ({ pos: [] as number[] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_frame: (args: Record<string, unknown> | undefined) => {
      framesAsked.pos.push(Number(args?.pos));
      return STUB_FRAME;
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

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

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
let objectUrls: ObjectUrlStub;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** React commits of the `PreviewPane` subtree, counted by a real `Profiler`.
 *  This is the number the fix is about. */
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

/** Mounted WITHOUT StrictMode, deliberately: StrictMode's double-invoke is
 *  exactly the thing that would make a commit COUNT meaningless, and every
 *  behaviour this file asserts is already covered under StrictMode by the
 *  sibling `PreviewPane.*.dom.test.tsx` files. */
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

function previewImg(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector('img');
  if (!img) throw new Error('no preview <img> mounted');
  return img as HTMLImageElement;
}

beforeEach(() => {
  console_ = captureConsole();
  restoreOffsets = stubOffsetMetrics(1200, 600);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  framesAsked.pos = [];
  commits.count = 0;
  resetPreviewTiming();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({ playing: false, playbackRate: 1 }));
  console_.restore();
});

describe('a displayed preview frame (D-282 / B-146)', () => {
  it('reaches the <img> without React managing its src at all', async () => {
    const { container } = await mountHarness();
    const img = previewImg(container);

    // The first frame is on screen and came from a real object URL...
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    const first = img.getAttribute('src');

    // ...and React is not the thing holding it: nothing re-renders here, yet
    // a new frame still lands on the element. (Pre-D-282 this attribute was a
    // JSX prop, so it could only ever change via a commit.)
    const before = commits.count;
    actSync(() => useEditorTimelineStore.getState().setPlayhead(140));
    await waitFrames(3);

    expect(img.getAttribute('src')).not.toBe(first);
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    // The element itself was never replaced — the same node was written to.
    expect(previewImg(container)).toBe(img);
    // A scrub still commits (the playhead moved); the point is that the
    // PICTURE did not add a second one on top of it.
    expect(commits.count).toBeGreaterThan(before);
  });

  it('costs at most one React commit per frame during playback, not two', async () => {
    const { container } = await mountHarness();
    const img = previewImg(container);

    const seen = new Set<string>();
    const src = () => img.getAttribute('src') ?? '';
    seen.add(src());

    commits.count = 0;
    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    for (let i = 0; i < 40; i += 1) {
      await waitFrames(1);
      seen.add(src());
    }
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
    await waitFrames(2);

    const painted = seen.size - 1; // the frame already showing before Play
    expect(painted).toBeGreaterThan(2); // the loop really did run

    // THE assertion. Every displayed frame necessarily commits once (the
    // playhead moved, and the timecode/timeline cursor have to follow it).
    // What must NOT happen any more is a SECOND commit per frame for the
    // picture — that is what the pre-D-282 `setFrameSrc(url)` cost, and it is
    // the single biggest thing this side of the IPC was spending a frame on.
    // The `+ 4` is slack for the transport's own start/stop commits, not for
    // per-frame work: a per-frame regression scales with `painted` and blows
    // straight through a constant.
    expect(commits.count).toBeLessThanOrEqual(painted + 4);
  });

  it('does not re-decode the frame already on screen when playback is paused', async () => {
    await mountHarness();

    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    for (let i = 0; i < 12; i += 1) await waitFrames(1);

    const beforePause = framesAsked.pos.length;
    const lastShown = framesAsked.pos[beforePause - 1];
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
    await waitFrames(4);

    // Pausing parks the paused playhead in the loop's `pending` slot, and that
    // is the frame the loop had just decoded and painted. Fetching it again
    // cost a whole extra round trip AND asked the decode pipe for a frame it
    // had already passed — a backward target, which D-125 documents as an
    // ffmpeg respawn plus a keyframe seek.
    const afterPause = framesAsked.pos.slice(beforePause);
    expect(afterPause).not.toContain(lastShown);
  });

  it('never leaks an object URL per played frame', async () => {
    await mountHarness();

    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    for (let i = 0; i < 25; i += 1) await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
    await waitFrames(2);

    // One live URL: the frame currently on screen. Every previous one was
    // revoked as it was replaced — unchanged by D-282's move to an imperative
    // `src`, and worth re-proving precisely because that move is what could
    // have broken it.
    expect(objectUrls.live()).toHaveLength(1);
  });
});

describe('the preview surface during playback (D-282 / B-146)', () => {
  it('does not tear down and re-add its capture-phase pointer listener every frame', async () => {
    await mountHarness();

    // `useCanvasClipPick` owns the only capture-phase `pointerdown` listener
    // on the preview surface. It used to list `layers` — an array rebuilt on
    // every render by design — in its effect dependencies, so it re-registered
    // that listener once per RENDER, which during playback is once per
    // displayed frame, on the hottest surface in the tab.
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
      actSync(() => useEditorTimelineStore.getState().setPlaying(true));
      for (let i = 0; i < 25; i += 1) await waitFrames(1);
      actSync(() => useEditorTimelineStore.getState().setPlaying(false));
      await waitFrames(2);
    } finally {
      spy.mockRestore();
    }

    // Nothing about which clips are under the playhead changed across those
    // frames — it is one clip, 2000 frames long — so the listener had no
    // reason to be rebuilt even once. A small constant is allowed for the
    // transport's own start/stop churn; what must not happen is a count that
    // tracks the frame count.
    expect(added.length).toBeLessThanOrEqual(2);
  });
});

describe('the play loop reports where its time went (D-282)', () => {
  it('records a fetch span and a whole-tick span, with fetch inside tick', async () => {
    await mountHarness();

    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    for (let i = 0; i < 20; i += 1) await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
    await waitFrames(2);

    const report = previewTimingReport();
    expect(report.fetch.samples).toBeGreaterThan(0);
    expect(report.tick.samples).toBeGreaterThan(0);
    expect(report.fetch.medianMs).not.toBeNull();
    expect(report.tick.medianMs).not.toBeNull();

    // The whole point of the two spans is that they SUBTRACT: `fetch` is the
    // IPC round trip and `tick` is the pass that contains it, so a tick can
    // never be shorter than the fetch inside it. If that inverts, the readout
    // is measuring the wrong things and no conclusion drawn from it is safe.
    expect(report.tick.maxMs!).toBeGreaterThanOrEqual(report.fetch.minMs!);
    // Costs, not moments: a duration channel reports no cadence.
    expect(report.fetch).not.toHaveProperty('fps');
    expect(report.tick).not.toHaveProperty('hitches');
  });
});
