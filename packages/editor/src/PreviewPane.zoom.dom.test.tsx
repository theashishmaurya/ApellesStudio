// @vitest-environment jsdom
/**
 * @apelles/editor — permanent real-DOM regression coverage for the preview
 * viewport's zoom + pan (D-218), and specifically for the thing that made it
 * worth its own pass rather than a quick control: **canvas click-to-select
 * and the on-canvas transform handles have to stay correct at every zoom
 * level, including zoomed AND panned.**
 *
 * `previewZoom.test.ts` proves the math and `transformGeometry.test.ts`
 * proves the fraction↔pixel mapping, but neither can catch the failure this
 * feature actually risks: a component tree where the picture is drawn through
 * one transform and the overlays measure themselves through another, so the
 * box and the hit test drift away from the picture the moment you zoom. That
 * is B-093's exact shape (a box drawn precisely, nowhere near the picture,
 * with every pure test passing) reproduced through a different door, on the
 * same three surfaces D-136/D-204/D-209 have each had to fix live. So the
 * discriminating cases below are written the strong way: each asserts the
 * value the ZOOMED mapping gives AND explicitly rejects the value the
 * pre-zoom (fit) mapping would have given, so a regression that silently
 * ignores the zoom fails for the real reason rather than passing by accident.
 *
 * **Tier and its honest limits.** jsdom, sharing every caveat
 * `PreviewPane.pick.dom.test.tsx`'s own header spells out (no layout engine,
 * no real hit-testing; `stubOffsetMetrics` supplies the one fixed viewport
 * `useContentBox` measures, and `getBoundingClientRect()` is all zeros so a
 * dispatched event's `clientX`/`clientY` is already container-relative). That
 * is *why* D-218 is a mathematical transform of the content box rather than
 * real CSS `overflow: auto` scrolling: a scroll offset would be layout the
 * jsdom tier cannot produce and therefore cannot check — see D-218 for the
 * full weighing.
 *
 * Geometry is chosen so every expected number is readable by inspection: the
 * stubbed container and the composition share a 2:1 aspect ratio, so the FIT
 * box is `{0, 0, 1000, 500}` with no letterboxing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  dragPointer,
  firePointerEvent,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  linearPath,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 24;

const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
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
 * The same minimal stand-in for `control.rs`'s real `chroma://request` /
 * `chroma://response/<id>` pair `PreviewPane.selection.dom.test.tsx` uses —
 * so the MCP half of this feature is driven through the REAL op dispatch
 * path, not by calling the store action a tool happens to wrap.
 * `vi.hoisted` because a `vi.mock` factory is hoisted above every `const`.
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
import { FIT_VIEW, MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM, PREVIEW_ZOOM_STEP, type PreviewView } from './previewZoom';
import type { Clip, Timeline, Track } from './timeline';

/** The view every "zoomed and panned" case below uses. At 2× the picture is
 *  2000×1000 inside a 1000×500 viewport, and a quarter-frame pan brings the
 *  upper-left region into view: the content box becomes
 *  `{offsetX: -250, offsetY: -125, width: 2000, height: 1000}`. */
const ZOOMED_PANNED: PreviewView = { zoom: 2, panX: 0.25, panY: 0.25 };

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id.toUpperCase(),
    source_path: `/${id}.mp4`,
    source_start: 0,
    duration: 240,
    source_len: 480,
    source_fps: FPS,
    start_frame: 0,
    ...extra,
  };
}

function timelineOf(tracks: Track[]): Timeline {
  return { id: 'zoom-tl', name: 'zoom', rate: { num: FPS, den: 1 }, tracks };
}

function selection(): { track: number; id: string }[] {
  return useEditorTimelineStore.getState().selection;
}

function view(): PreviewView {
  return useEditorTimelineStore.getState().previewView;
}

function setView(next: PreviewView): void {
  actSync(() => useEditorTimelineStore.getState().setPreviewView(next));
}

let restoreOffsets: () => void;
let objectUrls: ReturnType<typeof installObjectUrlStub>;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** The app's own arrangement (`EditorTab.tsx` mounts `useEditorControl()`
 *  alongside the preview) — one tree, so the GUI half and the MCP half of the
 *  zoom are exercised against the same live component. */
function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement(PreviewPane);
}

/** The response envelope `control.rs` forwards back to the MCP layer. */
interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // The op's own result object — an open record on the wire; each assertion
  // narrows the one field it reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

let requestId = 0;

/** Post one op through the real listener `useEditorControl` registered, and
 *  return the envelope it emitted — the exact round trip the control server
 *  performs. */
async function callOp(op: string, args: Record<string, unknown>): Promise<OpEnvelope> {
  const id = `zoom-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

async function mountWith(
  timeline: Timeline,
  initialSelection: { track: number; id: string }[] = [],
): Promise<HTMLElement> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline,
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: initialSelection,
      selectedGap: null,
      previewView: FIT_VIEW,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(4);
  const el = mounted.container.querySelector('[data-preview-surface]');
  if (!el) throw new Error('preview surface never rendered — frame/composition-size stubs are broken');
  return el as HTMLElement;
}

function previewImage(): HTMLImageElement {
  const img = mounted?.container.querySelector('[data-preview-surface] img');
  if (!img) throw new Error('the preview <img> never rendered');
  return img as HTMLImageElement;
}

function transformBox(): HTMLElement {
  const box = mounted?.container.querySelector('[data-transform-overlay] > div');
  if (!box) throw new Error('the transform box never rendered');
  return box as HTMLElement;
}

function boxRect(box: HTMLElement) {
  const px = (v: string) => Number.parseFloat(v);
  return { left: px(box.style.left), top: px(box.style.top), width: px(box.style.width), height: px(box.style.height) };
}

function button(label: string): HTMLButtonElement | null {
  return (mounted?.container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null) ?? null;
}

function requireButton(label: string): HTMLButtonElement {
  const el = button(label);
  if (!el) throw new Error(`no control labelled "${label}" in the preview`);
  return el;
}

function click(el: HTMLElement): void {
  actSync(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

/** A real `WheelEvent`, dispatched the way a browser would — `ctrlKey: true`
 *  is what BOTH a trackpad pinch and an explicit Ctrl+scroll arrive as (the
 *  browser synthesizes it for the pinch), which is exactly the distinction
 *  `PreviewPane`'s listener keys off. */
function fireWheel(
  target: EventTarget,
  init: { deltaX?: number; deltaY?: number; ctrlKey?: boolean; clientX?: number; clientY?: number },
): boolean {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    ctrlKey: init.ctrlKey ?? false,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  let dispatched = true;
  actSync(() => {
    dispatched = target.dispatchEvent(event);
  });
  // `dispatchEvent` returns false when a listener called `preventDefault()` —
  // the only way to observe, from a test, whether the page's own scroll/zoom
  // was suppressed. That matters: without it the webview runs its own
  // ctrl+wheel page zoom on top of ours.
  return !dispatched;
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  objectUrls = installObjectUrlStub();
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
  restorePointerCapture();
  restoreResizeObserver();
  objectUrls.restore();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({ previewView: FIT_VIEW }));
  expect(errors).toEqual([]);
});

describe('the default view is fit — the assumption every pre-D-218 suite rests on', () => {
  it('mounts at 100% with no pan and no transform on the picture', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    expect(view()).toEqual(FIT_VIEW);
    // No CSS transform at all at fit — the picture is exactly where every
    // other DOM suite's fixtures assume it is.
    expect(previewImage().style.transform).toBe('');
    expect(button('Reset zoom to fit')).toBeNull();
    expect(requireButton('Zoom in').textContent).toBe('');
    expect(mounted?.container.textContent).toContain('100%');
  });

  // The project-change reset (D-218): a zoom/pan is a look at ONE
  // composition, so it must not survive into a different one. Driven with
  // `setOpenProject(null)` deliberately — a non-null key would additionally
  // start the store's real retry/reload ladder, whose timers outlive this
  // test and would then write into a LATER test's store. Both keys run the
  // identical reset `set({...})`, which is the branch under test here.
  it('resets to fit when the open project changes', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    setView(ZOOMED_PANNED);
    expect(view()).toEqual(ZOOMED_PANNED);

    actSync(() => useEditorTimelineStore.getState().setOpenProject(null));
    expect(view()).toEqual(FIT_VIEW);
  });
});

describe('the zoom control, shaped like the timeline’s own', () => {
  it('steps by the same factor and shows a whole percentage', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    click(requireButton('Zoom in'));
    expect(view().zoom).toBeCloseTo(PREVIEW_ZOOM_STEP, 12);
    expect(requireButton('Reset zoom to fit').textContent).toBe('120%');

    click(requireButton('Zoom out'));
    expect(view().zoom).toBeCloseTo(1, 12);
  });

  it('offers the reset only once there is something to reset, and it returns to fit', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    expect(button('Reset zoom to fit')).toBeNull();

    setView(ZOOMED_PANNED);
    await waitFrames(1);
    click(requireButton('Reset zoom to fit'));

    // Pan as well as zoom — "fit" means the whole frame, centred.
    expect(view()).toEqual(FIT_VIEW);
  });

  it('disables the direction that is already at its bound rather than hiding it', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    setView({ zoom: MAX_PREVIEW_ZOOM, panX: 0, panY: 0 });
    await waitFrames(1);
    expect(requireButton('Zoom in').disabled).toBe(true);
    expect(requireButton('Zoom out').disabled).toBe(false);

    setView({ zoom: MIN_PREVIEW_ZOOM, panX: 0, panY: 0 });
    await waitFrames(1);
    expect(requireButton('Zoom out').disabled).toBe(true);
    expect(requireButton('Zoom in').disabled).toBe(false);
  });
});

describe('the picture itself', () => {
  it('is magnified and displaced by exactly the view, as one compositor transform', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    setView(ZOOMED_PANNED);
    await waitFrames(1);

    // pan is a fraction of the FIT box, so 0.25 of 1000×500 is 250×125 px.
    expect(previewImage().style.transform).toBe('translate(250px, 125px) scale(2)');
  });
});

describe('the canvas boundary follows the picture', () => {
  it('draws at the zoomed, panned rect — it is the picture’s own edge or it is nothing', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    setView(ZOOMED_PANNED);
    await waitFrames(1);

    const boundary = mounted?.container.querySelector('[data-canvas-boundary]') as HTMLElement;
    expect(boundary).not.toBeNull();
    expect(Number.parseFloat(boundary.style.left)).toBeCloseTo(-250, 6);
    expect(Number.parseFloat(boundary.style.top)).toBeCloseTo(-125, 6);
    expect(Number.parseFloat(boundary.style.width)).toBeCloseTo(2000, 6);
    expect(Number.parseFloat(boundary.style.height)).toBeCloseTo(1000, 6);
  });
});

describe('canvas click-to-select at a NON-fit zoom (D-204 must survive D-218)', () => {
  /**
   * A quarter-size PIP parked up-and-left over a full-frame background. Its
   * box in composition fractions is x,y ∈ [0.075, 0.325).
   *
   * The press below lands on screen (350, 175). Through the ZOOMED+PANNED
   * content box that is composition fraction (0.3, 0.3) — inside the PIP.
   * Through the fit box it would be (0.35, 0.35) — outside the PIP, on the
   * background. So this single point discriminates the two mappings, and the
   * assertions state both halves.
   */
  const pipOverBg = () =>
    timelineOf([
      { kind: 'video', clips: [clip('pip', { scale: 0.25, position_x: -0.3, position_y: -0.3 })] },
      { kind: 'video', clips: [clip('bg')] },
    ]);

  it('resolves the clip through the ZOOMED, PANNED box — not the pre-zoom one', async () => {
    const surface = await mountWith(pipOverBg());

    // Baseline: at fit, this exact point is on the background.
    firePointerEvent(surface, 'pointerdown', { x: 350, y: 175 });
    await waitFrames(1);
    expect(selection()).toEqual([{ track: 1, id: 'bg' }]);

    setView(ZOOMED_PANNED);
    await waitFrames(1);

    // Zoomed and panned, the same point is on the PIP.
    firePointerEvent(surface, 'pointerdown', { x: 350, y: 175 });
    await waitFrames(1);
    expect(selection()).toEqual([{ track: 0, id: 'pip' }]);
  });

  it('still falls through to the layer below where the top layer does not cover the point', async () => {
    const surface = await mountWith(pipOverBg());
    setView(ZOOMED_PANNED);
    await waitFrames(1);

    // Screen (550, 275) → fraction (0.4, 0.4), outside the PIP's box.
    firePointerEvent(surface, 'pointerdown', { x: 550, y: 275 });
    await waitFrames(1);
    expect(selection()).toEqual([{ track: 1, id: 'bg' }]);
  });

  it('clears the selection on a press over empty canvas, zoomed', async () => {
    const surface = await mountWith(
      timelineOf([{ kind: 'video', clips: [clip('pip', { scale: 0.25 })] }]),
      [{ track: 0, id: 'pip' }],
    );
    setView({ zoom: 2, panX: 0, panY: 0 });
    await waitFrames(1);

    // Content box is {-500, -250, 2000, 1000}; screen (0, 0) → fraction
    // (0.25, 0.25), outside the centred quarter-size clip (0.375..0.625).
    firePointerEvent(surface, 'pointerdown', { x: 0, y: 0 });
    await waitFrames(1);

    expect(selection()).toEqual([]);
  });
});

describe('the transform handles at a NON-fit zoom (D-136/D-209 must survive D-218)', () => {
  it('draws the box at the zoomed, panned rect', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo', { scale: 0.5 })] }]), [
      { track: 0, id: 'solo' },
    ]);
    setView(ZOOMED_PANNED);
    await waitFrames(2);

    const rect = boxRect(transformBox());
    // A half-scale full-frame clip: fraction box left/top 0.25, size 0.5.
    expect(rect.left).toBeCloseTo(-250 + 0.25 * 2000, 6);
    expect(rect.top).toBeCloseTo(-125 + 0.25 * 1000, 6);
    expect(rect.width).toBeCloseTo(0.5 * 2000, 6);
    expect(rect.height).toBeCloseTo(0.5 * 1000, 6);
  });

  it('commits the fraction the ZOOMED mapping gives for a body drag — not the pre-zoom one', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo', { scale: 0.5 })] }]), [
      { track: 0, id: 'solo' },
    ]);
    setView({ zoom: 2, panX: 0, panY: 0 });
    await waitFrames(2);

    const box = transformBox();
    const body = box.querySelector('div') as HTMLElement;
    const rect = boxRect(box);
    const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    await dragPointer(body, linearPath(from, { x: from.x + 200, y: from.y + 100 }), {
      moveTarget: body,
      release: body,
    });
    await waitFrames(2);

    const after = useEditorTimelineStore.getState().timeline?.tracks[0].clips[0];
    // 200 screen px across a 2000px-wide picture is 0.1 of the composition —
    // NOT the 0.2 the fit mapping would have produced. Same for 100px of
    // 1000px vertically.
    expect(after?.position_x ?? 0).toBeCloseTo(0.1, 6);
    expect(after?.position_y ?? 0).toBeCloseTo(0.1, 6);
    expect(after?.position_x ?? 0).not.toBeCloseTo(0.2, 3);
  });

  it('commits the right fraction for a corner (scale) drag while zoomed AND panned', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo', { scale: 0.5 })] }]), [
      { track: 0, id: 'solo' },
    ]);
    setView(ZOOMED_PANNED);
    await waitFrames(2);

    const box = transformBox();
    const handle = box.querySelector('[data-transform-handle]') as HTMLElement;
    const rect = boxRect(box);
    const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    // Grab the corner and pull to exactly twice its distance from the centre:
    // a uniform corner scale is the ratio of those distances, so `scale`
    // must land on exactly 2× its starting 0.5, at ANY zoom — the pointer
    // distances scale with the picture and the ratio does not.
    const grab = { x: centre.x - rect.width / 2, y: centre.y - rect.height / 2 };
    const to = { x: centre.x - rect.width, y: centre.y - rect.height };
    await dragPointer(handle, linearPath(grab, to), { moveTarget: handle, release: handle });
    await waitFrames(2);

    const after = useEditorTimelineStore.getState().timeline?.tracks[0].clips[0];
    expect(after?.scale ?? 1).toBeCloseTo(1, 6);
    expect(after?.position_x ?? 0).toBeCloseTo(0, 6);
  });
});

describe('the wheel gesture, mirroring TimelinePane’s own ctrl/pinch split', () => {
  it('zooms on ctrl/pinch-wheel, towards the pointer, and suppresses the page’s own zoom', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    // Anchored at the picture's exact centre, so the pan stays zero and the
    // zoom factor is readable on its own.
    const prevented = fireWheel(surface, { deltaY: -100, ctrlKey: true, clientX: 500, clientY: 250 });
    await waitFrames(1);

    expect(prevented).toBe(true);
    expect(view().zoom).toBeCloseTo(PREVIEW_ZOOM_STEP, 12);
    expect(view().panX).toBeCloseTo(0, 12);
  });

  it('keeps the point under the pointer under the pointer', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    // Top-left quarter of the picture: fit fraction (0.25, 0.25).
    fireWheel(surface, { deltaY: -100, ctrlKey: true, clientX: 250, clientY: 125 });
    await waitFrames(1);

    const v = view();
    // Same identity `previewZoom.test.ts` proves in the pure tier, re-checked
    // here through the real component: anchor + (pan - anchor) * ratio.
    const anchor = -0.25; // (250/1000) - 0.5
    expect(v.panX).toBeCloseTo(anchor - anchor * PREVIEW_ZOOM_STEP, 9);
    expect(v.panY).toBeCloseTo(anchor - anchor * PREVIEW_ZOOM_STEP, 9);
  });

  it('leaves a PLAIN wheel entirely alone at fit — an ordinary scroll must not drift the preview', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    const prevented = fireWheel(surface, { deltaY: 120 });
    await waitFrames(1);

    expect(prevented).toBe(false);
    expect(view()).toEqual(FIT_VIEW);
  });

  it('pans on a plain wheel once zoomed in, clamped at the picture’s own edge', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    setView({ zoom: 2, panX: 0, panY: 0 });
    await waitFrames(1);

    expect(fireWheel(surface, { deltaX: 100, deltaY: 50 })).toBe(true);
    await waitFrames(1);
    expect(view().panX).toBeCloseTo(-0.1, 9);
    expect(view().panY).toBeCloseTo(-0.1, 9);

    // ...and it cannot be pushed past the edge, however hard it is scrolled.
    fireWheel(surface, { deltaX: 100000, deltaY: 0 });
    await waitFrames(1);
    expect(view().panX).toBeCloseTo(-0.5, 9);
  });
});

/**
 * The AI half, driven through the REAL `chroma://request` dispatch — the
 * same bar D-216 set for `editor_set_selection`: a tool is not "built for an
 * AI" because a store action exists, it is built when the op round-trips and
 * the real component tree responds to it. Every case below therefore asserts
 * the DOM consequence (the picture's own transform) alongside the response.
 */
describe('editor_set_preview_zoom — the AI half, through the real op dispatch', () => {
  it('zooms the actual picture and reports the view back', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    const res = await callOp('editor_set_preview_zoom', { zoom: 2, panX: 0.25, panY: 0.25 });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ zoom: 2, pct: 200, panX: 0.25, panY: 0.25, fit: false });
    expect(res.result.panLimit).toBeCloseTo(0.5, 9);
    await waitFrames(1);
    expect(previewImage().style.transform).toBe('translate(250px, 125px) scale(2)');
  });

  it('accepts "fit" as the reset, recentring the pan as well as the zoom', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    setView(ZOOMED_PANNED);

    const res = await callOp('editor_set_preview_zoom', { zoom: 'fit' });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ zoom: 1, pct: 100, panX: 0, panY: 0, fit: true });
    expect(view()).toEqual(FIT_VIEW);
    await waitFrames(1);
    expect(previewImage().style.transform).toBe('');
  });

  it('keeps the current pan when only a zoom is given', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    setView(ZOOMED_PANNED);

    const res = await callOp('editor_set_preview_zoom', { zoom: 4 });

    expect(res.result).toMatchObject({ zoom: 4, panX: 0.25, panY: 0.25 });
  });

  it('clamps an out-of-range request and SAYS it clamped, rather than silently doing something else', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    const res = await callOp('editor_set_preview_zoom', { zoom: 99, panX: 99, panY: -99 });

    expect(res.result.zoom).toBe(MAX_PREVIEW_ZOOM);
    expect(res.result.note).toContain('clamped');
    expect(res.result.panX).toBeCloseTo((MAX_PREVIEW_ZOOM - 1) / 2, 9);
    expect(res.result.panY).toBeCloseTo(-(MAX_PREVIEW_ZOOM - 1) / 2, 9);
    expect(view().zoom).toBe(MAX_PREVIEW_ZOOM);
  });

  it('refuses a request it cannot read rather than moving the picture somewhere arbitrary', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    expect((await callOp('editor_set_preview_zoom', {})).error).toContain('zoom');
    expect((await callOp('editor_set_preview_zoom', { zoom: 'huge' })).error).toContain('multiplier');
    expect((await callOp('editor_set_preview_zoom', { zoom: 2, panX: 'left' })).error).toContain('panX');
    expect(view()).toEqual(FIT_VIEW);
  });

  it('is reported by editor_get_state, so a screenshot can be interpreted', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    setView(ZOOMED_PANNED);

    const res = await callOp('editor_get_state', {});

    expect(res.result.previewZoom).toMatchObject({ zoom: 2, pct: 200, panX: 0.25, panY: 0.25, fit: false });
  });

  it('pushes NOTHING onto the shared undo stack — a look is not an edit (D-216’s rule)', async () => {
    await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    const { useHistoryStore } = await import('@apelles/history');
    const before = useHistoryStore.getState().undoStack.length;

    await callOp('editor_set_preview_zoom', { zoom: 2 });
    click(requireButton('Zoom in'));

    expect(useHistoryStore.getState().undoStack.length).toBe(before);
  });
});
