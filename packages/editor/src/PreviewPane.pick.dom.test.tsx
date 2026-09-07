// @vitest-environment jsdom
/**
 * @chroma/editor — permanent real-DOM regression coverage for canvas
 * click-to-select (D-204, fixing B-085), built on `testUtils/pointerHarness.ts`
 * (D-142) exactly like `TimelinePane.marquee.dom.test.tsx`.
 *
 * **Why this file exists.** `canvasPick.test.ts` is exhaustive at the pure
 * function level (layer resolution, box math, topmost-wins, edge rules), but
 * a pure test cannot catch the thing B-085 actually was: a component tree
 * where NOTHING was listening for a press on the picture at all. This mounts
 * the real `PreviewPane` — with its real `useCanvasClipPick` listener, real
 * `TransformOverlay`, real store — and drives it with real `PointerEvent`s,
 * so "clicking the canvas selects the clip under the pointer" is a genuine
 * regression signal from `npm test`, not a code read.
 *
 * **Tier and its honest limits — read before trusting this file to prove more
 * than it does.** jsdom tier, not real-Chromium (`app/harness.html?mode=preview`,
 * see `harness-main.tsx`'s own header). jsdom has no layout engine and no hit
 * testing: `clientWidth`/`clientHeight` are stubbed to one fixed viewport
 * (`stubOffsetMetrics`) so `useContentBox` has something real to measure, and
 * an event goes to whatever element the test dispatches it on rather than to
 * whatever a real browser would find visually on top at those coordinates.
 * jsdom DOES model capture/bubble propagation faithfully, which is what the
 * behaviour under test turns on, so every rule can be exercised by stating
 * the press target explicitly — what this file cannot prove is that a real
 * browser would have chosen that same target. That half is verified in the
 * browser harness; see D-204.
 *
 * Geometry below is chosen so the fraction↔pixel mapping is exact and
 * checkable by inspection: the stubbed container and the composition share an
 * aspect ratio, so `useContentBox` produces a content box with zero
 * letterboxing (`offsetX`/`offsetY` both 0) and `x_px = fraction_x *
 * CANVAS_W`, `y_px = fraction_y * CANVAS_H`. jsdom's own
 * `getBoundingClientRect()` is all zeros, so a dispatched event's raw
 * `clientX`/`clientY` is already container-relative with no subtraction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  firePointerEvent,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  waitMs,
  type MountedComponent,
} from './testUtils/pointerHarness';

/** The container size `stubOffsetMetrics` fakes AND the composition size the
 *  stubbed backend reports — deliberately the same aspect ratio (2:1) so
 *  there is no letterboxing to reason about. */
const CANVAS_W = 1000;
const CANVAS_H = 500;

/** A 1×1 transparent GIF — `PreviewPane` only renders its overlay stack once
 *  `chroma_timeline_frame` has produced SOME frame; nothing here inspects the
 *  pixels (that is the Rust compositor's own concern). */
/** Whatever `chroma_timeline_frame` answers with — since D-216 that is the
 *  JPEG's raw bytes, not a data URL. Nothing here inspects the picture; the
 *  frame just has to arrive for the preview surface to mount. */
const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

/** Per-clip natural footprints, keyed by the clip index the geometry command
 *  is actually called with, per track. `1/1` is "this source exactly fills
 *  the composition"; the fixtures below vary `scale`/`position_*` instead, so
 *  every expected box is readable straight off the fixture. */
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

/**
 * How long `chroma_timeline_frame` takes to answer, in ms — B-085's second
 * (WKWebView-only) half, made reproducible.
 *
 * `0` (the default for every test below) is what a stub backend does: the
 * frame and the composition size land in the SAME microtask flush, so React
 * commits both in one render. That coincidence is the whole reason the first
 * fix passed here and in the browser harness while still being broken in the
 * real app — see this file's `real backend ordering` block and B-085's
 * 2026-09-07 follow-up. Set it non-zero to get the REAL app's ordering: a
 * cheap `chroma_timeline_composition_size` resolving first, and a real
 * ffmpeg decode arriving hundreds of ms later in its own commit.
 */
let frameDelayMs = 0;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_frame: () =>
      frameDelayMs === 0
        ? STUB_FRAME
        : new Promise<ArrayBuffer>((resolve) => setTimeout(() => resolve(STUB_FRAME), frameDelayMs)),
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

// B-086 — `useCompositionSize` (used by `PreviewPane`) now calls the real
// `@tauri-apps/api/event` `listen()`, which reaches for
// `window.__TAURI_INTERNALS__` outside jsdom's provided globals. This suite
// doesn't test that broadcast (see `useCompositionSize`'s own doc/live
// verification for that) — just needs it to not throw.
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import type { Clip, Timeline, Track } from './timeline';

const FPS = 24;

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id.toUpperCase(),
    source_path: `/${id}.mp4`,
    source_start: 0,
    duration: 240,
    source_len: 480,
    start_frame: 0,
    ...extra,
  };
}

function timelineOf(tracks: Track[]): Timeline {
  return { id: 'pick-tl', name: 'pick', rate: { num: FPS, den: 1 }, tracks };
}

/** A composition-fraction point as the `clientX`/`clientY` that lands on it —
 *  see this file's own header for why this is a bare multiply. */
function at(fx: number, fy: number): { x: number; y: number } {
  return { x: fx * CANVAS_W, y: fy * CANVAS_H };
}

function selection(): { track: number; id: string }[] {
  return useEditorTimelineStore.getState().selection;
}

let restoreOffsets: () => void;
let objectUrls: ReturnType<typeof installObjectUrlStub>;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** Seed the store, mount the real `PreviewPane`, and wait for its frame
 *  fetch + every geometry probe to settle. Returns the preview SURFACE — the
 *  element `useCanvasClipPick` listens on, and the element a real press on
 *  the picture lands in. */
async function mountWith(
  timeline: Timeline,
  initialSelection: { track: number; id: string }[] = [],
  opts: { strictMode?: boolean } = {},
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
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: opts.strictMode ?? true });
  // A slow frame has to settle in its OWN `act()` block, after the ones the
  // fast commands already settled in — `act` drains everything scheduled
  // inside it into a single render pass, so awaiting one block long enough to
  // cover both would collapse the two commits back into the one commit that
  // hides this bug (which is exactly what the stub backend does naturally).
  // See `frameDelayMs`.
  if (frameDelayMs > 0) {
    await waitFrames(2);
    await waitMs(frameDelayMs + 20);
  }
  await waitFrames(4);
  const el = mounted.container.querySelector('[data-preview-surface]');
  if (!el) throw new Error('preview surface never rendered — frame/composition-size stubs are broken');
  return el as HTMLElement;
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  // D-216 — jsdom has no `URL.createObjectURL`, and `PreviewPane` shows every
  // frame through one now.
  objectUrls = installObjectUrlStub();
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
});

afterEach(() => {
  frameDelayMs = 0;
  // Same bar every prior pointer-gesture harness in this repo set: zero
  // console errors under real StrictMode double-invoke, asserted rather than
  // eyeballed.
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restorePointerCapture();
  restoreResizeObserver();
  objectUrls.restore();
  restoreOffsets();
  expect(errors).toEqual([]);
});

describe('canvas click-to-select (D-204 / B-085)', () => {
  it('selects the clip under the pointer with NOTHING selected first — the exact B-085 repro', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    expect(selection()).toEqual([]);

    firePointerEvent(surface, 'pointerdown', at(0.5, 0.5));
    await waitFrames(1);

    expect(selection()).toEqual([{ track: 0, id: 'solo' }]);
  });

  it('makes the transform handles appear as a result — the affordance the bug report was about', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
    expect(mounted?.container.querySelector('[data-transform-overlay]')).toBeNull();

    firePointerEvent(surface, 'pointerdown', at(0.5, 0.5));
    await waitFrames(2);

    expect(mounted?.container.querySelector('[data-transform-overlay]')).not.toBeNull();
  });

  it('picks the TOPMOST overlapping layer (track 0), not a lower one', async () => {
    const surface = await mountWith(
      timelineOf([
        { kind: 'video', clips: [clip('top')] },
        { kind: 'video', clips: [clip('under')] },
      ]),
    );

    firePointerEvent(surface, 'pointerdown', at(0.5, 0.5));
    await waitFrames(1);

    expect(selection()).toEqual([{ track: 0, id: 'top' }]);
  });

  it('falls through to the layer below where the top layer does not cover the point', async () => {
    // track 0 is a quarter-size PIP parked up and left; track 1 fills the frame.
    const surface = await mountWith(
      timelineOf([
        { kind: 'video', clips: [clip('pip', { scale: 0.25, position_x: -0.3, position_y: -0.3 })] },
        { kind: 'video', clips: [clip('bg')] },
      ]),
    );

    firePointerEvent(surface, 'pointerdown', at(0.2, 0.2));
    await waitFrames(1);
    expect(selection()).toEqual([{ track: 0, id: 'pip' }]);

    firePointerEvent(surface, 'pointerdown', at(0.8, 0.8));
    await waitFrames(1);
    expect(selection()).toEqual([{ track: 1, id: 'bg' }]);
  });

  it('ignores a hidden track, exactly as the compositor does', async () => {
    const surface = await mountWith(
      timelineOf([
        { kind: 'video', clips: [clip('invisible')], hidden: true },
        { kind: 'video', clips: [clip('bg')] },
      ]),
    );

    firePointerEvent(surface, 'pointerdown', at(0.5, 0.5));
    await waitFrames(1);

    expect(selection()).toEqual([{ track: 1, id: 'bg' }]);
  });

  it('still selects a clip on a LOCKED track — locking blocks edits, not selection', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')], locked: true }]));

    firePointerEvent(surface, 'pointerdown', at(0.5, 0.5));
    await waitFrames(1);

    expect(selection()).toEqual([{ track: 0, id: 'solo' }]);
  });

  it('clears the selection when the press lands on empty canvas, mirroring the timeline (D-100)', async () => {
    const surface = await mountWith(
      timelineOf([{ kind: 'video', clips: [clip('pip', { scale: 0.25 })] }]),
      [{ track: 0, id: 'pip' }],
    );
    expect(selection()).toHaveLength(1);

    // Far corner: outside the centred quarter-size box entirely.
    firePointerEvent(surface, 'pointerdown', at(0.02, 0.02));
    await waitFrames(1);

    expect(selection()).toEqual([]);
    expect(useEditorTimelineStore.getState().selectedGap).toBeNull();
  });

  it('replaces the previous selection rather than extending it', async () => {
    const surface = await mountWith(
      timelineOf([
        { kind: 'video', clips: [clip('pip', { scale: 0.25, position_x: -0.3, position_y: -0.3 })] },
        { kind: 'video', clips: [clip('bg')] },
      ]),
      [{ track: 1, id: 'bg' }],
    );

    firePointerEvent(surface, 'pointerdown', at(0.2, 0.2));
    await waitFrames(1);

    expect(selection()).toEqual([{ track: 0, id: 'pip' }]);
  });

  it('ignores a non-primary (right/middle) button press entirely', async () => {
    const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));

    firePointerEvent(surface, 'pointerdown', at(0.5, 0.5), { button: 2, buttons: 2 });
    await waitFrames(1);

    expect(selection()).toEqual([]);
  });

  // The coexistence rules with D-136's drag path. These press on real
  // DESCENDANTS of the surface, so the capture-phase listener under test sees
  // exactly the propagation a real press produces — the one part of the real
  // gesture jsdom does model faithfully (what it cannot model is which
  // element is visually on top; every press below states its own target).
  describe('coexistence with the transform handles', () => {
    function transformBody(): HTMLElement {
      const overlay = mounted?.container.querySelector('[data-transform-overlay]');
      if (!overlay) throw new Error('transform overlay never rendered');
      const body = overlay.querySelector('.cursor-move');
      if (!body) throw new Error('transform box body never rendered');
      return body as HTMLElement;
    }

    it('stands aside for a press on the ALREADY-selected clip’s own picture (that is a move drag)', async () => {
      await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]), [{ track: 0, id: 'solo' }]);

      firePointerEvent(transformBody(), 'pointerdown', at(0.5, 0.5));
      await waitFrames(1);

      expect(selection()).toEqual([{ track: 0, id: 'solo' }]);
    });

    it('stands aside for a press on a corner handle, even one overhanging another clip', async () => {
      // The handle hit area extends past the box by HANDLE_HIT_SLOP, so it can
      // sit over a different layer's picture; a corner grab must still resize.
      await mountWith(
        timelineOf([
          { kind: 'video', clips: [clip('pip', { scale: 0.25, position_x: -0.3, position_y: -0.3 })] },
          { kind: 'video', clips: [clip('bg')] },
        ]),
        [{ track: 1, id: 'bg' }],
      );
      const handle = mounted?.container.querySelector('[data-transform-handle]');
      if (!handle) throw new Error('transform corner handle never rendered');

      firePointerEvent(handle, 'pointerdown', at(0.2, 0.2));
      await waitFrames(1);

      expect(selection()).toEqual([{ track: 1, id: 'bg' }]);
    });

    it('selects a HIGHER layer through the selected clip’s own full-bleed transform box', async () => {
      // The real-browser finding that reshaped D-204 (see this hook's doc): a
      // full-frame clip's transform box covers the whole canvas, so an overlay
      // div under it could never let anything else be picked again. The
      // capture-phase decision can, and this is that case exactly.
      await mountWith(
        timelineOf([
          { kind: 'video', clips: [clip('pip', { scale: 0.25, position_x: -0.3, position_y: -0.3 })] },
          { kind: 'video', clips: [clip('bg')] },
        ]),
        [{ track: 1, id: 'bg' }],
      );

      firePointerEvent(transformBody(), 'pointerdown', at(0.2, 0.2));
      await waitFrames(1);

      expect(selection()).toEqual([{ track: 0, id: 'pip' }]);
    });
  });

  /**
   * B-085's second half — the one the first fix shipped without covering.
   *
   * Every test above (and the whole real-Chromium harness pass) answers
   * `chroma_timeline_frame` and `chroma_timeline_composition_size` in the
   * same microtask flush, because both are synchronous stubs. The real app
   * does not: the composition size is a cheap settings/probe read that
   * answers in milliseconds, while the frame is a real ffmpeg decode over
   * IPC that answers hundreds of milliseconds later. Those are two separate
   * React commits, and `PreviewPane` only renders its surface `<div>` — the
   * element every overlay measures itself against — once a frame exists. So
   * in the real app the composition size arrived while that element was
   * still unmounted, and nothing ever re-measured once it appeared: the
   * content box stayed 0×0 forever, the pick listener was never attached,
   * and clicking the canvas did nothing at all in the shipped app while
   * passing every test here.
   *
   * These two mount with that real ordering, which is the only difference
   * from their same-named counterparts above.
   */
  describe('with the real backend’s ordering — the composition size resolving before the first frame', () => {
    it('still selects the clip under the pointer (the WKWebView-only half of B-085)', async () => {
      frameDelayMs = 120;
      const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]));
      expect(selection()).toEqual([]);

      firePointerEvent(surface, 'pointerdown', at(0.5, 0.5));
      await waitFrames(1);

      expect(selection()).toEqual([{ track: 0, id: 'solo' }]);
    });

    // Without StrictMode — i.e. the shape a RELEASE build actually runs.
    // StrictMode's double-invoke of a newly-mounted effect happens to rescue
    // the two overlays that mount WITH the surface (`CanvasBoundary`,
    // `TransformOverlay`): their second run sees the container attached. It
    // cannot rescue `useCanvasClipPick`, which belongs to `PreviewPane` — long
    // since mounted — and that is exactly why the dev app showed a correct
    // canvas boundary while the click was dead. Drop StrictMode and the
    // boundary is dead too, so this case pins the whole overlay stack.
    it('still selects, and still draws the canvas boundary, with no StrictMode double-invoke to fall back on', async () => {
      frameDelayMs = 120;
      const surface = await mountWith(timelineOf([{ kind: 'video', clips: [clip('solo')] }]), [], {
        strictMode: false,
      });

      expect(mounted?.container.querySelector('[data-canvas-boundary]')).not.toBeNull();

      firePointerEvent(surface, 'pointerdown', at(0.5, 0.5));
      await waitFrames(1);

      expect(selection()).toEqual([{ track: 0, id: 'solo' }]);
    });
  });
});
