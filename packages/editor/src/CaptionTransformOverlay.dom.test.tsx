// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the on-canvas CAPTION box (D-316,
 * fixing B-183).
 *
 * **Why this tier, and not only a pure-math test.** The defect being fixed was
 * that selecting a caption drew *nothing at all* on the canvas — a whole
 * surface silently absent. No unit test of any arithmetic could have caught
 * that, and none can prove it is fixed: what matters is that a box appears, in
 * the right place, and that a real pointer gesture on it writes the right op
 * exactly once. So this mounts the real `PreviewPane` (real overlays, real
 * store, real ops, real `TransformBox` pointer wiring) and drives it with real
 * `PointerEvent`s, the same harness — and the same honest jsdom limits (no
 * layout engine; `stubOffsetMetrics` supplies the one fixed viewport) —
 * `PreviewPane.transform.dom.test.tsx` and `DynamicZoomOverlay.dom.test.tsx`
 * already use for the video-clip boxes.
 *
 * **Geometry is chosen so every expected number is readable by inspection.**
 * The stubbed container and the composition are both 1000x500 (no
 * letterboxing), so one composition fraction is 1000 screen px across and 500
 * down. The stubbed measurement puts the caption's box at fractions
 * `0.3,0.7 .. 0.7,0.82` — i.e. screen `300,350` to `700,410` — with its
 * bottom-right corner landing exactly on the default style anchor
 * (`position_x 0.5`, `position_y 0.82`), which is the point a corner drag
 * scales about. That makes the corner-drag factor a plain ratio of two
 * horizontal distances.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

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
const DURATION = 120;

/** The measured caption box the backend is stubbed to report, in composition
 *  fractions. Its bottom-right corner IS the default anchor (0.5, 0.82). */
const CAPTION_BOX = { left: 0.3, top: 0.7, width: 0.4, height: 0.12 };

const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

const captionMeasureCalls: Array<{ text: string; compWidth: number; compHeight: number }> = [];

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
    chroma_measure_caption_bounds: (args: unknown) => {
      const a = args as { text: string; compWidth: number; compHeight: number };
      captionMeasureCalls.push({ text: a.text, compWidth: a.compWidth, compHeight: a.compHeight });
      return CAPTION_BOX;
    },
    chroma_project_get_settings: () => ({ width: CANVAS_W, height: CANVAS_H }),
    chroma_audio_play: () => undefined,
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: () => undefined,
    chroma_timeline_set: () => undefined,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useEditorTimelineStore } from './timelineStore';
import { visibleCaptionsAt } from './canvasPick';
import { PreviewPane } from './PreviewPane';
import {
  DEFAULT_CAPTION_SIZE,
  resolveCaptionStyle,
  type CaptionStyle,
  type Clip,
  type Timeline,
  type Track,
} from './timeline';

function captionClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'cue-1',
    name: 'Caption',
    source_path: '',
    source_start: 0,
    duration: DURATION,
    source_len: DURATION,
    source_fps: FPS,
    start_frame: 0,
    caption: { text: 'Hello, and welcome back' },
    ...extra,
  };
}

function videoClip(): Clip {
  return {
    id: 'bg',
    name: 'BG',
    source_path: '/bg.mov',
    source_start: 0,
    duration: DURATION,
    source_len: DURATION,
    source_fps: FPS,
    start_frame: 0,
  };
}

function timelineOf(tracks: Track[]): Timeline {
  return { id: 'cap-tl', name: 'cap', rate: { num: FPS, den: 1 }, tracks };
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let objectUrls: ReturnType<typeof installObjectUrlStub>;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** Seed the store with one video track under one subtitle track, select
 *  `selected`, and mount the real `PreviewPane`. */
async function mountWith(
  options: {
    selected?: 'caption' | 'video' | 'none';
    trackStyle?: CaptionStyle | null;
    cueStyle?: CaptionStyle | null;
    locked?: boolean;
    /** B-185 — where the playhead sits. Defaults inside the cue's own span
     *  (which starts at 0), because "the cue is on screen" is the precondition
     *  for there being a box at all. */
    playhead?: number;
    /** B-185 — the cue's own span, so a test can put the playhead OUTSIDE it. */
    cueStart?: number;
    cueDuration?: number;
  } = {},
): Promise<void> {
  const {
    selected = 'caption',
    trackStyle = null,
    cueStyle = null,
    locked = false,
    playhead = 0,
    cueStart = 0,
    cueDuration = DURATION,
  } = options;
  const cue = captionClip({
    start_frame: cueStart,
    duration: cueDuration,
    source_len: cueDuration,
    caption: { text: 'Hello, and welcome back', ...(cueStyle ? { style: cueStyle } : {}) },
  });
  const tracks: Track[] = [
    { kind: 'video', clips: [videoClip()] },
    { kind: 'subtitle', clips: [cue], locked, ...(trackStyle ? { caption_style: trackStyle } : {}) },
  ];
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: timelineOf(tracks),
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead,
      playing: false,
      selection:
        selected === 'caption'
          ? [{ track: 1, id: cue.id }]
          : selected === 'video'
            ? [{ track: 0, id: 'bg' }]
            : [],
      selectedGap: null,
      dynamicZoom: null,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
}

function captionBoxEl(): HTMLElement | null {
  return (
    (mounted?.container.querySelector(
      '[data-caption-transform-overlay] [data-transform-box]',
    ) as HTMLElement | null) ?? null
  );
}

/** The CLIP transform overlay's boxes. The `:not(...)` matters: the caption
 *  overlay carries `data-transform-overlay` too — deliberately, because
 *  `useCanvasClipPick`'s rule 5 ("a press on the overlay itself is not a
 *  selection") tests for exactly that marker and must apply to this overlay as
 *  well. So the two are told apart by the caption overlay's own extra marker,
 *  not by the shared one. */
function clipBoxEls(): HTMLElement[] {
  const all = mounted?.container.querySelectorAll(
    '[data-transform-overlay]:not([data-caption-transform-overlay]) [data-transform-box]',
  );
  return [...(all ?? [])] as HTMLElement[];
}

/** The box's four corner handles — empty when resizing is disabled. */
function cornerHandles(): HTMLElement[] {
  const box = captionBoxEl();
  return [...(box?.querySelectorAll('[data-transform-handle]') ?? [])] as HTMLElement[];
}

function rectOf(box: HTMLElement) {
  const px = (v: string) => Number.parseFloat(v);
  return {
    left: px(box.style.left),
    top: px(box.style.top),
    width: px(box.style.width),
    height: px(box.style.height),
  };
}

/** The resolved style the store currently holds for the one caption. */
function currentStyle(): Required<CaptionStyle> {
  const tl = useEditorTimelineStore.getState().timeline;
  const track = tl?.tracks[1];
  const cue = track?.clips[0]?.caption;
  return resolveCaptionStyle(cue?.style, track?.caption_style);
}

/** Drag the box BODY (a reposition) by `dx`/`dy` screen pixels. */
async function dragBodyBy(dx: number, dy: number): Promise<void> {
  const box = captionBoxEl();
  if (!box) throw new Error('no caption box to drag');
  const body = box.querySelector('div:not([data-transform-handle])') as HTMLElement;
  const r = rectOf(box);
  const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  await dragPointer(body, linearPath(from, { x: from.x + dx, y: from.y + dy }), {
    moveTarget: body,
    release: body,
  });
  await waitFrames(2);
}

/** Drag the bottom-right corner handle to `to` (screen px). */
async function dragCornerTo(to: { x: number; y: number }): Promise<void> {
  const box = captionBoxEl();
  if (!box) throw new Error('no caption box to drag');
  // Render order is nw, ne, sw, se — the last is the bottom-right.
  const handles = cornerHandles();
  const se = handles[handles.length - 1];
  if (!se) throw new Error('no corner handle to drag');
  const r = rectOf(box);
  await dragPointer(se, linearPath({ x: r.left + r.width, y: r.top + r.height }, to), {
    moveTarget: se,
    release: se,
  });
  await waitFrames(2);
}

beforeEach(() => {
  captionMeasureCalls.length = 0;
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  console_ = captureConsole();
});

afterEach(() => {
  // Same bar every prior pointer-gesture suite sets: zero console errors under
  // real StrictMode double-invoke, asserted rather than eyeballed — which is
  // what catches a commit run from inside a state updater (the `draftRef`
  // hazard `TransformBox` documents).
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  expect(errors).toEqual([]);
});

describe('D-316 — the on-canvas caption box', () => {
  it('draws a box on the caption’s MEASURED bounds when one is selected (B-183)', async () => {
    await mountWith();
    const box = captionBoxEl();
    // The regression guard for the whole bug: before D-316 this was `null`.
    expect(box).not.toBeNull();
    expect(rectOf(box as HTMLElement)).toEqual({
      left: CAPTION_BOX.left * CANVAS_W,
      top: CAPTION_BOX.top * CANVAS_H,
      width: CAPTION_BOX.width * CANVAS_W,
      height: CAPTION_BOX.height * CANVAS_H,
    });
    // And it really came from the backend measurement, for THIS cue's own text
    // and composition — a PURE measurement, not a lookup by index (see
    // `useCaptionGeometry`'s doc for why that distinction is load-bearing).
    expect(captionMeasureCalls).toContainEqual({
      text: 'Hello, and welcome back',
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
    });
  });

  it('re-measures when the STYLE changes, without waiting on a persisted timeline', async () => {
    // The B-088-class regression guard. The first build of this asked the
    // backend to resolve the cue from `track`/`clip` indices, so the box was
    // measured against whatever the last debounced save had persisted — a
    // caption's position moved and its box stayed behind. The request must
    // carry the live style, so a style edit is a NEW measurement immediately.
    await mountWith();
    const before = captionMeasureCalls.length;
    actSync(() => {
      const tl = useEditorTimelineStore.getState().timeline;
      if (!tl) throw new Error('no timeline');
      const next = structuredClone(tl);
      next.tracks[1].caption_style = { position_x: 0.2, position_y: 0.3 };
      useEditorTimelineStore.setState({ timeline: next });
    });
    await waitFrames(3);
    expect(captionMeasureCalls.length).toBeGreaterThan(before);
  });

  it('is the ONLY box: the clip transform overlay stands aside for a caption', async () => {
    await mountWith();
    // One box per meaning — `TransformOverlay` explicitly renders nothing for a
    // caption clip rather than (as before D-316) happening to fail its
    // geometry probe.
    expect(clipBoxEls()).toHaveLength(0);
    expect(captionBoxEl()).not.toBeNull();
  });

  it('draws nothing when the selection is not a caption', async () => {
    await mountWith({ selected: 'video' });
    expect(captionBoxEl()).toBeNull();
    expect(clipBoxEls()).toHaveLength(1);
  });

  it('draws nothing when nothing is selected', async () => {
    await mountWith({ selected: 'none' });
    expect(captionBoxEl()).toBeNull();
  });

  // ---- B-185 / D-317: the box may not outlive its cue's own span ----------
  //
  // The live defect this reproduces: a caption was selected, the playhead sat
  // over a DIFFERENT cue, and the overlay drew a box for the selected (not
  // visible) one on top of the cue that WAS rendered. Because `CaptionLayout`
  // anchors `position_y` at the cue's LAST line and stacks earlier lines
  // upward, a one-line phantom box lands exactly on a two-line cue's bottom
  // line — which is why the report reads "the box only covers one line of a
  // multi-line caption". Nothing was mis-measured; it was a correct box for
  // the wrong cue.

  it('draws NOTHING while the playhead is outside the selected cue’s span (B-185)', async () => {
    // The cue occupies [40, 70). The playhead sits at 100 — past its end, so
    // the caption is not on screen and there is nothing on the picture for a
    // box to be around. Derived from the span, not from a recorded number:
    // 100 >= 40 + 30, so `clipCoversFrame` is false by construction.
    await mountWith({ cueStart: 40, cueDuration: 30, playhead: 100 });
    expect(captionBoxEl()).toBeNull();
    // And it did not even ASK for a measurement: an off-screen cue has no box
    // to draw, so scrubbing past one must not cost a font round trip a frame.
    expect(captionMeasureCalls).toEqual([]);
  });

  it('draws nothing one frame PAST the cue’s end, and does at its last frame (B-185)', async () => {
    // The half-open boundary, checked from both sides rather than assumed:
    // `endFrame` is exclusive, so frame 69 is the cue's last visible frame and
    // 70 belongs to whatever follows it.
    await mountWith({ cueStart: 40, cueDuration: 30, playhead: 69 });
    expect(captionBoxEl()).not.toBeNull();
    mounted?.unmount();
    mounted = null;
    captionMeasureCalls.length = 0;

    await mountWith({ cueStart: 40, cueDuration: 30, playhead: 70 });
    expect(captionBoxEl()).toBeNull();
  });

  it('draws nothing BEFORE the selected cue starts (B-185)', async () => {
    await mountWith({ cueStart: 40, cueDuration: 30, playhead: 39 });
    expect(captionBoxEl()).toBeNull();
  });

  it('brings the box BACK when the playhead re-enters the cue’s span (B-185)', async () => {
    // The gate must be a gate, not a removal: the same selection that drew
    // nothing a moment ago draws its real measured box once its cue is on
    // screen again, with no re-selection needed.
    await mountWith({ cueStart: 40, cueDuration: 30, playhead: 100 });
    expect(captionBoxEl()).toBeNull();

    actSync(() => useEditorTimelineStore.setState({ playhead: 50 }));
    await waitFrames(4);

    const box = captionBoxEl();
    expect(box).not.toBeNull();
    expect(rectOf(box as HTMLElement)).toEqual({
      left: CAPTION_BOX.left * CANVAS_W,
      top: CAPTION_BOX.top * CANVAS_H,
      width: CAPTION_BOX.width * CANVAS_W,
      height: CAPTION_BOX.height * CANVAS_H,
    });
  });

  it('agrees with what a canvas click could have selected (B-185)', async () => {
    // The invariant behind the fix, stated as `canvasPick.ts`'s own doc states
    // it: a click can only ever select a cue that is on screen
    // (`visibleCaptionsAt`), so a box drawn for one that is NOT on screen is
    // the single way the draw half and the pick half can disagree. Both now
    // ask `clipCoversFrame`, so this is checked against the pick side's own
    // answer rather than against a second copy of the rule.
    const tl = () => useEditorTimelineStore.getState().timeline;
    await mountWith({ cueStart: 40, cueDuration: 30, playhead: 100 });
    expect(visibleCaptionsAt(tl(), 100)).toHaveLength(0);
    expect(captionBoxEl()).toBeNull();

    actSync(() => useEditorTimelineStore.setState({ playhead: 55 }));
    await waitFrames(4);
    expect(visibleCaptionsAt(tl(), 55)).toHaveLength(1);
    expect(captionBoxEl()).not.toBeNull();
  });

  it('draws nothing when the selected cue’s track is HIDDEN (B-185)', async () => {
    // A hidden subtitle track renders no caption at all, so the same rule
    // applies for the same reason — and `visibleCaptionsAt` already excluded
    // it, which is the agreement the test above pins down.
    await mountWith();
    expect(captionBoxEl()).not.toBeNull();
    actSync(() => {
      const t = useEditorTimelineStore.getState().timeline;
      if (!t) throw new Error('no timeline');
      const tracks = t.tracks.map((tr, i) => (i === 1 ? { ...tr, hidden: true } : tr));
      useEditorTimelineStore.setState({ timeline: { ...t, tracks } });
    });
    await waitFrames(4);
    expect(captionBoxEl()).toBeNull();
  });

  it('a body drag writes position_x/position_y ONCE, through the caption style op', async () => {
    await mountWith();
    const before = useEditorTimelineStore.getState().timeline;
    expect(currentStyle().position_x).toBeCloseTo(0.5, 6);

    // +100px across a 1000px canvas is +0.1 of a composition fraction;
    // -50px down a 500px canvas is -0.1.
    await dragBodyBy(100, -50);

    const style = currentStyle();
    expect(style.position_x).toBeCloseTo(0.6, 6);
    expect(style.position_y).toBeCloseTo(0.72, 6);
    // The cue itself carries no override — the drag landed on the TRACK style,
    // exactly where the Inspector's own Position X field writes for a cue
    // using its track's style.
    expect(useEditorTimelineStore.getState().timeline?.tracks[1].clips[0].caption?.style).toBeUndefined();
    expect(useEditorTimelineStore.getState().timeline?.tracks[1].caption_style?.position_x).toBeCloseTo(0.6, 6);
    // And the font size is untouched: a move is never a resize.
    expect(style.size).toBeCloseTo(DEFAULT_CAPTION_SIZE, 6);
    expect(useEditorTimelineStore.getState().timeline).not.toBe(before);
  });

  it('a body drag on a cue with its OWN style override writes that override, not the track', async () => {
    await mountWith({ cueStyle: { size: 0.08 }, trackStyle: { color: '#00FF00' } });
    await dragBodyBy(100, 0);
    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.tracks[1].clips[0].caption?.style?.position_x).toBeCloseTo(0.6, 6);
    // The track style is left alone — one caption moved, not the whole track.
    expect(tl?.tracks[1].caption_style?.position_x).toBeUndefined();
    // And the override kept its other fields.
    expect(tl?.tracks[1].clips[0].caption?.style?.size).toBeCloseTo(0.08, 6);
  });

  it('a corner drag writes FONT SIZE — scaled about the style’s anchor', async () => {
    await mountWith();
    // The box's bottom-right corner sits at screen (700, 410); the anchor
    // (pivot) is (0.5, 0.82) → screen (500, 410). Dragging the corner to
    // x = 800 takes its distance from the pivot from 0.2 to 0.3 of a
    // composition width — a factor of exactly 1.5.
    await dragCornerTo({ x: 800, y: 410 });

    const style = currentStyle();
    expect(style.size).toBeCloseTo(DEFAULT_CAPTION_SIZE * 1.5, 6);
    // A resize is never a move.
    expect(style.position_x).toBeCloseTo(0.5, 6);
    expect(style.position_y).toBeCloseTo(0.82, 6);
  });

  it('a corner drag inward shrinks the font size', async () => {
    await mountWith();
    // 0.2 → 0.1 of the composition width: a factor of 0.5.
    await dragCornerTo({ x: 600, y: 410 });
    expect(currentStyle().size).toBeCloseTo(DEFAULT_CAPTION_SIZE * 0.5, 6);
  });

  it('the box follows the pointer LIVE and commits nothing until release', async () => {
    await mountWith();
    const box = captionBoxEl() as HTMLElement;
    const body = box.querySelector('div:not([data-transform-handle])') as HTMLElement;
    const r = rectOf(box);
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

    // Press and move WITHOUT releasing — the overlay-only half of the D-136
    // "live feedback, one commit on pointer-up" contract. Done with raw
    // events rather than `dragPointer`, which always releases.
    firePointerEvent(body, 'pointerdown', from);
    await waitFrames(1);
    firePointerEvent(body, 'pointermove', { x: from.x + 50, y: from.y });
    await waitFrames(1);
    firePointerEvent(body, 'pointermove', { x: from.x + 100, y: from.y });
    await waitFrames(1);

    // The box moved on screen…
    expect(rectOf(captionBoxEl() as HTMLElement).left).toBeCloseTo(r.left + 100, 3);
    // …and the model has not been touched at all.
    expect(currentStyle().position_x).toBeCloseTo(0.5, 6);
  });

  it('a locked subtitle track draws the box but refuses both gestures', async () => {
    await mountWith({ locked: true });
    // Same posture `TransformOverlay` takes for a locked clip: the box still
    // shows (locking protects a clip from being edited, not from being
    // selected), the gestures simply do nothing.
    expect(captionBoxEl()).not.toBeNull();
    // Resizing is off entirely, so there is no handle to grab at all.
    expect(cornerHandles()).toHaveLength(0);
    await dragBodyBy(100, 0);
    const style = currentStyle();
    expect(style.position_x).toBeCloseTo(0.5, 6);
    expect(style.size).toBeCloseTo(DEFAULT_CAPTION_SIZE, 6);
  });

  it('an unlocked box offers exactly four corner handles', async () => {
    await mountWith();
    // Four, not eight (D-316): a side handle has two attested meanings in the
    // reference tools — non-uniform scale, and wrap width — and a caption has
    // neither field, so drawing one would promise a gesture nothing could
    // honour.
    expect(cornerHandles()).toHaveLength(4);
  });
});
