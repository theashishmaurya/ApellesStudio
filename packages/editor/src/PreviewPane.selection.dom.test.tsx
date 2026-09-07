// @vitest-environment jsdom
/**
 * @chroma/editor — permanent real-DOM coverage for `editor_set_selection`
 * (D-214, roadmap item 26): the MCP op that gives an agent the one thing it
 * could not do before, PUT A CLIP IN THE SELECTED STATE.
 *
 * **Why this file exists, and why it asserts on the DOM rather than on the
 * store.** A test that called the op and read `useEditorTimelineStore
 * .getState().selection` back would prove only that a setter was called. The
 * op's entire reason to exist is its READ-side consequence: `TransformOverlay`
 * — the on-canvas transform box and its four corner handles — mounts only for
 * a selection of exactly one clip, so before this op the whole on-canvas
 * surface was unreachable from MCP, which is precisely why D-209/B-093 shipped
 * with its pointer tier unverified (see that decision's own "Live, partially"
 * note). So this drives the REAL op through the REAL `chroma://request`
 * dispatch path `control.rs` uses (a `useEditorControl()` mounted in the same
 * tree, its listener fed a real request payload) and then asserts the handles
 * are actually IN the document — the consequence, not the store write.
 *
 * **Tier and its honest limits.** jsdom, sharing every caveat
 * `PreviewPane.pick.dom.test.tsx`'s and `PreviewPane.transform.dom.test.tsx`'s
 * own headers spell out: no layout engine, no hit-testing, one stubbed
 * viewport (`stubOffsetMetrics`) for `useContentBox` to measure. What it
 * proves is that the op resolves/validates a selection correctly and that the
 * real component tree responds by mounting the transform surface — not that a
 * real WKWebView paints it where a human would see it. That last tier is the
 * live one, recorded in D-214.
 *
 * Geometry matches the sibling suites (2:1 container and composition, so no
 * letterboxing); nothing here asserts on pixel positions — only on what is
 * mounted.
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
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 24;

const STUB_FRAME = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** `1/1` — the source exactly fills the composition, same as the sibling
 *  suites. Nothing here depends on the resulting box size. */
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

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
    chroma_timeline_set: () => undefined,
    // `useEditorControl` warms the font catalogue at mount (D-211/D-212).
    chroma_text_fonts: () => [],
  }),
}));

/**
 * A real, minimal stand-in for the `chroma://request` / `chroma://response/<id>`
 * event pair `app/src-tauri/src/chroma/control.rs` actually emits and awaits —
 * the ONE thing the sibling suites stub out to a no-op, because they don't
 * drive an op. `vi.hoisted` because a `vi.mock` factory is hoisted above every
 * `const` in this file.
 */
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
import type { Clip, Timeline, Track } from './timeline';

/** The response envelope `control.rs` forwards back to the MCP layer. */
interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // The op's own result object — an open record by contract, exactly as it is
  // on the wire; every assertion below narrows the one field it reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

let requestId = 0;

/** Post one op through the real listener `useEditorControl` registered, and
 *  return the envelope it emitted — the exact round trip the control server
 *  performs. */
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

function clipOf(id: string, startFrame: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id.toUpperCase(),
    source_path: `/${id}.mov`,
    source_start: 0,
    duration: 100,
    source_len: 480,
    source_fps: FPS,
    start_frame: startFrame,
    ...extra,
  };
}

/** Track 0 holds `a` [0,100) and `b` [200,300) — a real, CLOSEABLE gap at
 *  [100,200) between them, and trailing empty space past 300 that is NOT a
 *  gap (nothing after it to ripple). Track 1 holds one clip, for the
 *  cross-track and multi-select cases. */
function fixtureTimeline(tracks?: Track[]): Timeline {
  return {
    id: 'selection-tl',
    name: 'selection',
    rate: { num: FPS, den: 1 },
    tracks: tracks ?? [
      { kind: 'video', clips: [clipOf('a', 0), clipOf('b', 200)] },
      { kind: 'video', clips: [clipOf('c', 0, { scale: 0.5 })] },
    ],
  };
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** `PreviewPane` (so `TransformOverlay` is really in the tree) plus the real
 *  control-server listener, in ONE tree — the app's own arrangement
 *  (`EditorTab.tsx` mounts `useEditorControl()` alongside the preview). */
function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement(PreviewPane);
}

async function mountHarness(timeline: Timeline = fixtureTimeline()): Promise<MountedComponent> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline,
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(4);
  return mounted;
}

/** The on-canvas transform box, or `null` when nothing is selected — the read
 *  side this whole op exists to make reachable. */
function transformBox(): HTMLElement | null {
  return (mounted?.container.querySelector('[data-transform-overlay] > div') as HTMLElement | null) ?? null;
}

function transformHandles(): HTMLElement[] {
  return [...(mounted?.container.querySelectorAll('[data-transform-handle]') ?? [])] as HTMLElement[];
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
  bus.emitted.length = 0;
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  // Same bar every pointer/DOM suite in this package sets: zero console errors
  // under real StrictMode double-invoke, asserted rather than eyeballed.
  expect(errors).toEqual([]);
});

describe('editor_set_selection — the on-canvas surface it unblocks', () => {
  it('mounts the transform box and its four handles for a clip nothing had selected', async () => {
    await mountHarness();
    // The state D-209 could not reach: nothing selected, no box in the DOM.
    expect(transformBox()).toBeNull();
    expect(transformHandles()).toHaveLength(0);

    const env = await callOp('editor_set_selection', { clips: [{ track: 0, clip: 0 }] });
    await waitFrames(3);

    expect(env.ok).toBe(true);
    expect(env.result.selection).toEqual([{ track: 0, id: 'a' }]);
    expect(env.result.singleClipSelected).toBe(true);
    // The point of the whole op: the on-canvas transform surface is now real.
    expect(transformBox()).not.toBeNull();
    expect(transformHandles()).toHaveLength(4);
  });

  it('selects by clipId as well as by index — the id the read side hands back', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', { clips: [{ track: 1, clipId: 'c' }] });
    await waitFrames(3);

    expect(env.ok).toBe(true);
    expect(env.result.selection).toEqual([{ track: 1, id: 'c' }]);
    expect(env.result.clips[0]).toMatchObject({ track: 1, clip: 0, id: 'c', name: 'C' });
    expect(transformHandles()).toHaveLength(4);
  });

  it('clears with an empty array, and the box unmounts again', async () => {
    await mountHarness();
    await callOp('editor_set_selection', { clips: [{ track: 0, clip: 0 }] });
    await waitFrames(3);
    expect(transformBox()).not.toBeNull();

    const env = await callOp('editor_set_selection', { clips: [] });
    await waitFrames(3);

    expect(env.ok).toBe(true);
    expect(env.result.selection).toEqual([]);
    expect(env.result.singleClipSelected).toBe(false);
    expect(transformBox()).toBeNull();
    expect(transformHandles()).toHaveLength(0);
  });

  it('draws NOTHING for a multi-clip selection — the Phase-1 exactly-one-clip rule', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', {
      clips: [
        { track: 0, clip: 0 },
        { track: 1, clip: 0 },
      ],
    });
    await waitFrames(3);

    // The selection itself is real (the Inspector/keyboard ops read it)...
    expect(env.result.selection).toEqual([
      { track: 0, id: 'a' },
      { track: 1, id: 'c' },
    ]);
    expect(env.result.singleClipSelected).toBe(false);
    // ...but `TransformOverlay` deliberately draws nothing for it, and this
    // asserts that rather than assuming it.
    expect(transformBox()).toBeNull();
  });

  it('suppresses the drag handles on a LOCKED track, and says so in the response', async () => {
    await mountHarness(
      fixtureTimeline([{ kind: 'video', clips: [clipOf('a', 0)], locked: true }]),
    );
    const env = await callOp('editor_set_selection', { clips: [{ track: 0, clip: 0 }] });
    await waitFrames(3);

    expect(env.result.clips[0]).toMatchObject({ trackLocked: true, trackHidden: false });
    // The box still draws (the clip IS selected); the corner handles do not.
    expect(transformBox()).not.toBeNull();
    expect(transformHandles()).toHaveLength(0);
  });
});

describe('editor_set_selection — validation', () => {
  it('refuses a track that does not exist', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', { clips: [{ track: 9, clip: 0 }] });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('no track 9');
    expect(useEditorTimelineStore.getState().selection).toEqual([]);
  });

  it('refuses a clip index that does not exist', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', { clips: [{ track: 0, clip: 7 }] });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('no clip 7 on track 0');
  });

  it('refuses an unknown clipId rather than storing a selection of nothing', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', { clips: [{ track: 0, clipId: 'nope' }] });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('no clip with id "nope"');
    expect(transformBox()).toBeNull();
  });

  it('refuses clips and gap together (D-105 — they are mutually exclusive)', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', {
      clips: [{ track: 0, clip: 0 }],
      gap: { track: 0, frame: 150 },
    });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('mutually exclusive');
  });

  it('refuses an empty call, naming both argument shapes', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', {});
    expect(env.ok).toBe(false);
    expect(env.error).toContain('clips');
    expect(env.error).toContain('gap');
  });

  it('drops a duplicated clip instead of storing it twice', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', {
      clips: [
        { track: 0, clip: 0 },
        { track: 0, clipId: 'a' },
      ],
    });
    await waitFrames(3);
    expect(env.result.selection).toEqual([{ track: 0, id: 'a' }]);
    // ...and a de-duplicated single clip still counts as exactly one, so the
    // box mounts rather than being suppressed by a phantom second entry.
    expect(env.result.singleClipSelected).toBe(true);
    expect(transformBox()).not.toBeNull();
  });
});

describe('editor_set_selection — gap selection (D-105)', () => {
  it('selects a real gap and reports its bounds', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', { gap: { track: 0, frame: 150 } });

    expect(env.ok).toBe(true);
    expect(env.result.selectedGap).toEqual({ track: 0, frame: 150 });
    expect(env.result.gapStart).toBe(100);
    expect(env.result.gapEnd).toBe(200);
    expect(useEditorTimelineStore.getState().selection).toEqual([]);
  });

  it('refuses trailing empty space past the last clip — not a closeable gap', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', { gap: { track: 0, frame: 400 } });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('not inside a real, closeable gap');
    expect(useEditorTimelineStore.getState().selectedGap).toBeNull();
  });

  it('refuses a frame that is inside a clip', async () => {
    await mountHarness();
    const env = await callOp('editor_set_selection', { gap: { track: 0, frame: 50 } });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('not inside a real, closeable gap');
  });

  it('a gap selection supersedes a clip selection, and unmounts the box', async () => {
    await mountHarness();
    await callOp('editor_set_selection', { clips: [{ track: 0, clip: 0 }] });
    await waitFrames(3);
    expect(transformBox()).not.toBeNull();

    await callOp('editor_set_selection', { gap: { track: 0, frame: 150 } });
    await waitFrames(3);

    expect(useEditorTimelineStore.getState().selection).toEqual([]);
    expect(transformBox()).toBeNull();
  });
});

describe('editor_set_selection — it is UI state, not a document edit (D-214)', () => {
  it('pushes nothing onto the shared undo stack and never persists the timeline', async () => {
    const { useHistoryStore } = await import('@chroma/history');
    await mountHarness();
    const before = useHistoryStore.getState().undoStack.length;

    await callOp('editor_set_selection', { clips: [{ track: 0, clip: 0 }] });
    await callOp('editor_set_selection', { gap: { track: 0, frame: 150 } });
    await callOp('editor_set_selection', { clips: [] });
    await waitFrames(3);

    // A human's own click pushes nothing either — an MCP selection that WAS
    // undoable would put a selection entry between the user and their last
    // real edit on the next cmd-Z.
    expect(useHistoryStore.getState().undoStack.length).toBe(before);
    // And `selection`/`selectedGap` are not fields of `Timeline`, so the
    // document the backend persists is byte-identical throughout.
    expect(useEditorTimelineStore.getState().timeline).toEqual(fixtureTimeline());
  });

  it('reads back through editor_get_state, so an agent can confirm its own gesture', async () => {
    await mountHarness();
    await callOp('editor_set_selection', { clips: [{ track: 1, clip: 0 }] });
    const state = await callOp('editor_get_state', {});
    expect(state.result.selection).toEqual([{ track: 1, id: 'c' }]);
    expect(state.result.selectedGap).toBeNull();
  });
});
