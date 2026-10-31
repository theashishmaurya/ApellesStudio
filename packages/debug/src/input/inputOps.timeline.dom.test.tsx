// @vitest-environment jsdom
/**
 * D-434 — `debug_pointer` / `debug_key` reach the REAL timeline handlers.
 *
 * Mounts the real `TimelinePane` and drives it only through the ops, in
 * `synthetic` mode (jsdom has no native path), then checks the app's own state
 * moved: the toolbar zoom, the ctrl+wheel zoom listener, the keymap's `M`.
 * What this proves is the plumbing — target resolution → plan → dispatch →
 * the app's listeners → the reply's `observed`/`perf`. What it cannot prove is
 * how WebKit treats a real event; that is the native path's job and is
 * verified on the live app (docs/notes/ui-harness.md).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from '@apelles/editor/src/testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
  // Not inside Tauri: `auto` mode must pick the synthetic dispatcher.
  isTauri: () => false,
}));

import { useEditorTimelineStore, TimelinePane } from '@apelles/editor';
import type { Timeline } from '@apelles/editor/src/timeline';
import { TIMELINE_TEST_IDS, TIMELINE_VIEW_ATTRS } from '@apelles/editor/src/timelineTestIds';

import { debugKey, debugPointer } from './inputOps';

const FPS = 24;
const AREA = { left: 0, top: 0, width: 1200, height: 600 };

function fixture(): Timeline {
  return {
    id: 'input-ops-tl',
    name: 'input ops fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [{ id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 720, source_len: 720, start_frame: 0 }],
      },
    ],
    markers: [],
  };
}

function giveRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => ({}) }) as DOMRect;
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`${id} is not mounted`);
  return el;
}

const pxPerSec = () => Number(byTestId(TIMELINE_TEST_IDS.editArea).getAttribute(TIMELINE_VIEW_ATTRS.pxPerSec));

let restore: (() => void)[] = [];

/** Run an op inside React's `act`, so the renders its events cause are flushed
 *  the way a real frame would flush them. */
async function inAct<T>(fn: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  await act(async () => {
    out = await fn();
  });
  return out as T;
}
let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountPane() {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/input-ops.chroma',
      status: 'ready',
      error: null,
      playhead: 48,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  ui = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
  giveRect(byTestId(TIMELINE_TEST_IDS.editArea), AREA);
  giveRect(byTestId(TIMELINE_TEST_IDS.zoomIn), { left: 900, top: 4, width: 24, height: 24 });
}

beforeEach(() => {
  restore = [stubOffsetMetrics(AREA.width, AREA.height), installResizeObserverStub(), installPointerCaptureStub()];
  console_ = captureConsole();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  ui?.unmount();
  ui = null;
  restore.forEach((r) => r());
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [] }));
  expect(errors, errors.map((e) => e.join(' ')).join('\n')).toEqual([]);
});

describe('debug_pointer / debug_key drive the real TimelinePane (D-434)', () => {
  it('a click on the zoom-in test id zooms the timeline, and the reply says what was hit and received', async () => {
    await mountPane();
    const button = byTestId(TIMELINE_TEST_IDS.zoomIn);
    document.elementFromPoint = () => button;
    const before = pxPerSec();

    const reply = (await inAct(() => debugPointer({ action: 'click', target: { testid: TIMELINE_TEST_IDS.zoomIn }, settleMs: 20 }))) as Record<
      string,
      unknown
    >;
    await waitFrames(2);

    expect(reply.error).toBeUndefined();
    expect(reply.mode).toBe('synthetic');
    expect(pxPerSec()).toBeGreaterThan(before);
    const [target] = reply.targets as { x: number; y: number; hitInside: boolean }[];
    expect(target).toMatchObject({ x: 912, y: 16, hitInside: true });
    const observed = reply.observed as { counts: Record<string, number>; trusted: number; untrusted: number };
    expect(observed.counts).toMatchObject({ pointerdown: 1, pointerup: 1, click: 1 });
    // Page-made events can never claim to be trusted — the reason native is the default on the app.
    expect(observed.trusted).toBe(0);
    expect(observed.untrusted).toBeGreaterThan(0);
  });

  it('a ctrl+wheel over the edit area reaches the zoom listener', async () => {
    await mountPane();
    const area = byTestId(TIMELINE_TEST_IDS.editArea);
    document.elementFromPoint = () => area;
    const before = pxPerSec();

    const reply = (await inAct(() => debugPointer({
      action: 'wheel',
      target: { testid: TIMELINE_TEST_IDS.editArea },
      modifiers: ['ctrl'],
      deltaY: -120,
      steps: 1,
      settleMs: 20,
    }))) as Record<string, unknown>;
    await waitFrames(2);

    expect(reply.error).toBeUndefined();
    expect(pxPerSec()).toBeGreaterThan(before);
  });

  it('a key press reaches the keymap: M adds a marker at the playhead', async () => {
    await mountPane();
    const reply = (await inAct(() => debugKey({ keys: ['KeyM'], settleMs: 20 }))) as Record<string, unknown>;
    await waitFrames(2);

    expect(reply.error).toBeUndefined();
    const markers = useEditorTimelineStore.getState().timeline?.markers ?? [];
    expect(markers.map((m) => m.frame)).toEqual([48]);
  });

  it('measure:true reports frames and the store commit the gesture caused', async () => {
    await mountPane();
    const reply = (await inAct(() => debugKey({ keys: ['KeyM'], measure: true, settleMs: 60 }))) as {
      perf?: { frames: { samples: number }; store: { commits: number } };
    };
    expect(reply.perf?.frames.samples).toBeGreaterThan(0);
    expect(reply.perf?.store.commits).toBeGreaterThan(0);
  });

  it('watch samples the watched element on every frame of the gesture', async () => {
    await mountPane();
    const reply = (await inAct(() => debugKey({
      keys: ['KeyM'],
      watch: { selectors: [`[data-testid="${TIMELINE_TEST_IDS.editArea}"]`] },
      settleMs: 60,
    }))) as { watch?: { rects: Record<string, unknown[]> }[] };
    expect(reply.watch?.length).toBeGreaterThan(0);
    expect(reply.watch?.[0].rects[`[data-testid="${TIMELINE_TEST_IDS.editArea}"]`]).toHaveLength(1);
  });

  it('native mode is refused outside the Tauri app rather than silently faked', async () => {
    await mountPane();
    const reply = (await inAct(() => debugKey({ keys: ['KeyM'], mode: 'native' }))) as { error?: string };
    expect(reply.error).toMatch(/native input needs the running Tauri app/);
    expect(useEditorTimelineStore.getState().timeline?.markers ?? []).toEqual([]);
  });

  it('a relative {byX} destination is measured from where the gesture pressed', async () => {
    await mountPane();
    const area = byTestId(TIMELINE_TEST_IDS.editArea);
    document.elementFromPoint = () => area;
    const reply = (await inAct(() =>
      debugPointer({
        action: 'drag',
        target: { testid: TIMELINE_TEST_IDS.editArea, at: { fx: 0.5, fy: 0.5 } },
        to: { byX: 60, byY: -10 },
        steps: 3,
        durationMs: 30,
        settleMs: 20,
      }),
    )) as { targets: { x: number; y: number }[]; observed: { counts: Record<string, number> } };
    expect(reply.targets[1]).toMatchObject({ x: reply.targets[0].x + 60, y: reply.targets[0].y - 10 });
    expect(reply.observed.counts.pointermove).toBeGreaterThanOrEqual(3);
    // A relative point needs a previous one.
    const bad = (await inAct(() => debugPointer({ action: 'click', target: { byX: 5 } }))) as { error?: string };
    expect(bad.error).toMatch(/needs a point before it/);
  });

  it('a target that misses is refused with the reason, and nothing is dispatched', async () => {
    await mountPane();
    const reply = (await inAct(() => debugPointer({ action: 'click', target: { testid: 'timeline-nonesuch' } }))) as { error?: string };
    expect(reply.error).toBe('target: no element matches [data-testid="timeline-nonesuch"]');
  });
});
