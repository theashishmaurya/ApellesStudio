// @vitest-environment jsdom
/**
 * @chroma/editor — permanent real-DOM regression coverage for B-093/D-209:
 * the on-canvas transform box on a KEYFRAMED clip, and what a drag on one
 * writes.
 *
 * **Why this file exists.** `clipKeyframes.test.ts` proves the interpolation
 * and `transformGeometry.test.ts` proves the fraction↔pixel math, but B-093
 * lived in neither: it was `TransformOverlay` reading the clip's STATIC
 * `position_x`/`position_y`/`scale` and handing those two correct functions
 * the wrong numbers, so the box was drawn — precisely, and with no failing
 * test anywhere — nowhere near the picture. Only a test at this tier can fail
 * for that. It mounts the real `PreviewPane` (real overlay, real store, real
 * ops) with a clip whose interpolated transform differs from its static
 * fields on purpose, and reads the box's actual CSS geometry back off the DOM.
 *
 * It also covers the second half of the same bug — that a drag used to commit
 * `set_clip_transform`, a write the compositor can never show on a property a
 * keyframe already owns — including the per-property split D-209 chose
 * (`position_x` keyed but `position_y` not) and the "only the final value on
 * pointer-up is written" property that keeps a drag from flooding the key
 * list.
 *
 * **Tier and its honest limits.** jsdom, sharing every caveat
 * `PreviewPane.pick.dom.test.tsx`'s own header spells out (no layout engine,
 * no real hit-testing; `stubOffsetMetrics` supplies the one fixed viewport
 * `useContentBox` measures). What it proves is that the component computes and
 * applies the right geometry and writes the right op — not that a real browser
 * routes the press the same way, which is the live tier D-209 records.
 *
 * Geometry is chosen so every expected number is readable by inspection: the
 * stubbed container and the composition share a 2:1 aspect ratio, so the
 * content box has no letterboxing and `x_px = fraction_x * CANVAS_W`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  dragPointer,
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

/** Whatever `chroma_timeline_frame` answers with — since D-217 that is the
 *  JPEG's raw bytes, not a data URL. Nothing here inspects the picture; the
 *  frame just has to arrive so the preview surface (and with it the transform
 *  overlay) mounts at all. */
const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

/** `1/1` — this source exactly fills the composition at `scale: 1`, so every
 *  box below is `scale` (or the override) directly. */
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
  }),
}));

// Same reason `PreviewPane.pick.dom.test.tsx` mocks it: `useCompositionSize`
// calls the real `listen()`, which reaches for `window.__TAURI_INTERNALS__`.
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import type { Clip, Timeline, Track } from './timeline';

/**
 * The clip under test. Its STATIC fields say "quarter-size box parked far
 * left"; its keyframes say something different at every frame — the same
 * disagreement the owner's real 50-keyframe clip has, at readable numbers. At
 * source frame 50 the keys resolve to `scale 0.75`, `position_x 0.125`.
 */
const STATIC_SCALE = 0.25;
const STATIC_POSITION_X = -0.4;
const PLAYHEAD = 50;
const KEYED_SCALE_AT_PLAYHEAD = 0.75;
const KEYED_POSITION_X_AT_PLAYHEAD = 0.125;

function keyedClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'keyed',
    name: 'KEYED',
    source_path: '/keyed.mov',
    source_start: 0,
    duration: 240,
    source_len: 480,
    source_fps: FPS, // 1:1 with the timeline, so source frame == playhead
    start_frame: 0,
    scale: STATIC_SCALE,
    position_x: STATIC_POSITION_X,
    chroma_keyframes: [
      { frame: 0, params: { scale: 1, position_x: 0, position_y: 0 } },
      { frame: 100, params: { scale: 0.5, position_x: 0.25, position_y: 0 } },
    ],
    ...extra,
  };
}

function plainClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'plain',
    name: 'PLAIN',
    source_path: '/plain.mov',
    source_start: 0,
    duration: 240,
    source_len: 480,
    source_fps: FPS,
    start_frame: 0,
    ...extra,
  };
}

function timelineOf(tracks: Track[]): Timeline {
  return { id: 'transform-tl', name: 'transform', rate: { num: FPS, den: 1 }, tracks };
}

function currentClip(id: string): Clip {
  const clip = useEditorTimelineStore.getState().timeline?.tracks[0].clips.find((c) => c.id === id);
  if (!clip) throw new Error(`clip ${id} vanished from the store`);
  return clip;
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let objectUrls: ReturnType<typeof installObjectUrlStub>;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** Seed the store with `clip` SELECTED at `PLAYHEAD`, mount the real
 *  `PreviewPane`, and return its transform box element (the bordered `div`
 *  the handles hang off). */
async function mountWithSelected(clip: Clip): Promise<HTMLElement> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: timelineOf([{ kind: 'video', clips: [clip] }]),
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: PLAYHEAD,
      playing: false,
      selection: [{ track: 0, id: clip.id }],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
  const box = mounted.container.querySelector('[data-transform-overlay] > div');
  if (!box) throw new Error('the transform box never rendered — frame/geometry stubs are broken');
  return box as HTMLElement;
}

/** The box's own CSS geometry, in the screen pixels the component set. */
function boxRect(box: HTMLElement) {
  const px = (v: string) => Number.parseFloat(v);
  return {
    left: px(box.style.left),
    top: px(box.style.top),
    width: px(box.style.width),
    height: px(box.style.height),
  };
}

/** Drag the box body (a plain reposition) by `dx` screen pixels, starting from
 *  wherever the box currently sits. */
async function dragBodyBy(box: HTMLElement, dx: number, dy = 0): Promise<void> {
  const body = box.querySelector('div') as HTMLElement;
  const rect = boxRect(box);
  const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  await dragPointer(body, linearPath(from, { x: from.x + dx, y: from.y + dy }), {
    moveTarget: body,
    release: body,
  });
  await waitFrames(2);
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  // D-217 — jsdom has no `URL.createObjectURL`, and `PreviewPane` shows every
  // frame through one now.
  objectUrls = installObjectUrlStub();
  console_ = captureConsole();
});

afterEach(() => {
  // Same bar every prior pointer-gesture suite in this repo sets: zero console
  // errors under real StrictMode double-invoke, asserted rather than eyeballed.
  // This is also what catches the `setState`-in-updater commit D-209 replaced
  // with `draftRef` ("Cannot update a component while rendering…").
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

describe('B-093 — the transform box on a keyframed clip', () => {
  it('is drawn at the INTERPOLATED transform for the playhead, not the static fields', async () => {
    const box = boxRect(await mountWithSelected(keyedClip()));

    // scale 0.75 of a full-frame source, centred at 0.5 + 0.125.
    expect(box.width).toBeCloseTo(KEYED_SCALE_AT_PLAYHEAD * CANVAS_W, 3);
    expect(box.height).toBeCloseTo(KEYED_SCALE_AT_PLAYHEAD * CANVAS_H, 3);
    expect(box.left).toBeCloseTo((0.5 - KEYED_SCALE_AT_PLAYHEAD / 2 + KEYED_POSITION_X_AT_PLAYHEAD) * CANVAS_W, 3);
    expect(box.top).toBeCloseTo((0.5 - KEYED_SCALE_AT_PLAYHEAD / 2) * CANVAS_H, 3);

    // And explicitly NOT the pre-fix static box, so this fails for the real
    // reason if the static read ever comes back.
    expect(box.width).not.toBeCloseTo(STATIC_SCALE * CANVAS_W, 3);
    expect(box.left).not.toBeCloseTo((0.5 - STATIC_SCALE / 2 + STATIC_POSITION_X) * CANVAS_W, 3);
  });

  it('follows the playhead — moving it redraws the box at that frame’s value', async () => {
    const box = await mountWithSelected(keyedClip());
    expect(boxRect(box).width).toBeCloseTo(KEYED_SCALE_AT_PLAYHEAD * CANVAS_W, 3);

    // Frame 100 is the last key exactly: scale 0.5, position_x 0.25.
    actSync(() => useEditorTimelineStore.setState({ playhead: 100 }));
    await waitFrames(2);

    const moved = boxRect(box);
    expect(moved.width).toBeCloseTo(0.5 * CANVAS_W, 3);
    expect(moved.left).toBeCloseTo((0.5 - 0.25 + 0.25) * CANVAS_W, 3);
  });
});

describe('B-093 — dragging a keyframed clip', () => {
  it('writes a KEYFRAME at the playhead, leaving the static fields alone', async () => {
    const box = await mountWithSelected(keyedClip());
    await dragBodyBy(box, 100); // 100px right == 0.1 of the canvas

    const after = currentClip('keyed');
    // The static fields — what the pre-fix commit wrote, and what the
    // compositor would then have ignored — are untouched.
    expect(after.position_x).toBeCloseTo(STATIC_POSITION_X, 6);
    expect(after.scale).toBeCloseTo(STATIC_SCALE, 6);

    // ONE new key landed at this exact playhead frame, carrying the dragged
    // position and nothing else (a merge, not a whole-params replace).
    const key = after.chroma_keyframes?.find((k) => k.frame === PLAYHEAD);
    expect(key).toBeDefined();
    expect(key?.params.position_x as number).toBeCloseTo(KEYED_POSITION_X_AT_PLAYHEAD + 0.1, 4);
    expect(Object.keys(key?.params ?? {}).sort()).toEqual(['position_x', 'position_y']);
    // The keys that were already there are still there, still sorted — a drag
    // writes exactly one key, not one per pointermove.
    expect(after.chroma_keyframes?.map((k) => k.frame)).toEqual([0, PLAYHEAD, 100]);
  });

  it('leaves every OTHER frame of the animation exactly as it was', async () => {
    const box = await mountWithSelected(keyedClip());
    await dragBodyBy(box, 100);

    const after = currentClip('keyed');
    const at = (frame: number) => after.chroma_keyframes?.find((k) => k.frame === frame)?.params;
    expect(at(0)).toMatchObject({ scale: 1, position_x: 0 });
    expect(at(100)).toMatchObject({ scale: 0.5, position_x: 0.25 });
  });

  it('still writes the STATIC transform for a clip with no keyframes at all', async () => {
    const box = await mountWithSelected(plainClip({ scale: 0.5 }));
    await dragBodyBy(box, 100);

    const after = currentClip('plain');
    expect(after.position_x).toBeCloseTo(0.1, 4);
    expect(after.chroma_keyframes ?? []).toEqual([]);
  });

  // D-209's per-PROPERTY rule, and the one case it exists for. A whole-clip
  // "does this clip have keyframes?" test would have keyed both axes here and
  // silently lost the `position_y` half of the drag under an animation that
  // does not name it.
  it('splits a move drag per property when only ONE axis is animated', async () => {
    const box = await mountWithSelected(
      plainClip({
        id: 'split',
        position_y: 0.2,
        chroma_keyframes: [
          { frame: 0, params: { position_x: 0 } },
          { frame: 100, params: { position_x: 0.5 } },
        ],
      }),
    );
    await dragBodyBy(box, 100, 50); // +0.1 in x, +0.1 in y

    const after = currentClip('split');
    // `position_x` is animated → it lands on a key at the playhead.
    const key = after.chroma_keyframes?.find((k) => k.frame === PLAYHEAD);
    expect(key?.params.position_x as number).toBeCloseTo(0.25 + 0.1, 4);
    expect(Object.keys(key?.params ?? {})).toEqual(['position_x']);
    // `position_y` is not → it lands on the static field, where the compositor
    // will actually read it.
    expect(after.position_y).toBeCloseTo(0.3, 4);
    // ...and the static `position_x` is left exactly where it was, rather than
    // being overwritten with a value no frame can show.
    expect(after.position_x ?? 0).toBeCloseTo(0, 6);
  });

  it('clears a D-193 box_width override on a corner drag, so the resize is not silently ignored', async () => {
    const box = await mountWithSelected(keyedClip({ box_width: 0.9 }));
    const handle = box.querySelector('[data-transform-handle]') as HTMLElement;
    expect(handle).not.toBeNull();

    // Any corner drives the same uniform-scale math (Phase 1); pulling away
    // from the box centre grows it.
    const rect = boxRect(box);
    const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const grab = { x: centre.x - 200, y: centre.y - 100 };
    await dragPointer(handle, linearPath(grab, { x: centre.x - 300, y: centre.y - 150 }), {
      moveTarget: handle,
      release: handle,
    });
    await waitFrames(2);

    const after = currentClip('keyed');
    expect(after.box_width ?? null).toBeNull();
    const key = after.chroma_keyframes?.find((k) => k.frame === PLAYHEAD);
    expect(key).toBeDefined();
    expect(key?.params.scale as number).toBeGreaterThan(KEYED_SCALE_AT_PLAYHEAD);
  });
});
