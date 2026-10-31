// @vitest-environment jsdom
/**
 * @apelles/editor — D-432 P2 on the real `TimelinePane`: the FCP clip block,
 * the selection outline, the edge-trim zones and their bracket, the live edit
 * gestures (B-344 / B-345), the Blade tool, the playhead's grab zone (B-346),
 * the layer scale (B-342) and the render budget of a drag (B-347).
 *
 * jsdom has no layout, so geometry is read from the inline styles the gesture
 * writes (that IS the live motion: a `transform` per moving clip and a `width`
 * on the one whose length changes), and the result from the store.
 *
 * Fixture: 24 fps, 90 px/s → 3.75 px per frame. 'a' [0,48) 'b' [48,96)
 * 'c' [96,144), each 48 source frames from source_start 100 of 480.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actSync,
  captureConsole,
  createInvokeStub,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  nextFrame,
  stubBoundingRectsFromInlineStyle,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
}));

// The pane's own render count: `useEditGesture` is called exactly once per
// `TimelinePane` render, so counting its calls counts the pane, not every
// child commit (thumbnails landing, the library's per-clip layout pass).
const paneRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./useEditGesture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useEditGesture')>();
  return {
    ...actual,
    useEditGesture: (...args: Parameters<typeof actual.useEditGesture>) => {
      paneRenders.n += 1;
      return actual.useEditGesture(...args);
    },
  };
});

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { TIMELINE_TEST_IDS as ID } from './timelineTestIds';
import type { Timeline } from './timeline';

const FPS = 24;
const PX_PER_FRAME = 90 / FPS;
const ROW_Y = 70; // a y inside track 0's row; only the slip/slide band reads y

function clipFixture(id: string, start: number) {
  return { id, name: id.toUpperCase(), source_path: `/${id}.mp4`, source_start: 100, duration: 48, source_len: 480, start_frame: start };
}

function buildFixture(): Timeline {
  return {
    id: 'clip-block-fixture',
    name: 'clip block fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: [clipFixture('a', 0), clipFixture('b', 48), clipFixture('c', 96)] },
      { kind: 'audio', clips: [clipFixture('m', 0)] },
    ],
  };
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;
let commits = 0;

beforeEach(async () => {
  restore = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub(), stubBoundingRectsFromInlineStyle()];
  console_ = captureConsole();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/clip-block.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  commits = 0;
  mounted = mount(
    React.createElement(React.Profiler, { id: 'pane', onRender: () => void (commits += 1) }, React.createElement(TimelinePane)),
  );
  await waitFrames(2);
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  for (const r of restore) r();
  restore = [];
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [], selectedGap: null }));
  expect(errors, errors.map((e) => e.join(' ')).join('\n')).toEqual([]);
});

const q = <T extends Element = HTMLElement>(sel: string) => mounted!.container.querySelector<T & HTMLElement>(sel);
const qa = (sel: string) => Array.from(mounted!.container.querySelectorAll<HTMLElement>(sel));
const body = (id: string) => q(`[data-testid="${ID.clip}"][data-chroma-clip-id="${id}"]`)!;
const zone = (id: string, edge: 'start' | 'end') => body(id).querySelector<HTMLElement>(`[data-chroma-trim-edge="${edge}"]`)!;
const clipOf = (id: string) => {
  for (const t of useEditorTimelineStore.getState().timeline!.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  throw new Error(id);
};
const tx = (el: HTMLElement) => {
  const m = /translate3d\((-?[\d.]+)px/.exec(el.style.transform);
  return m ? Number(m[1]) : 0;
};
const brackets = () => qa(`[data-testid="${ID.editBracket}"]`).filter((b) => !b.hidden);

async function pickTool(tool: string) {
  actSync(() => q<HTMLButtonElement>(`[data-chroma-trim-tool="${tool}"]`)!.click());
  await nextFrame();
}

/** Press, then move in `steps`, sampling the moving clips after each move —
 *  the live-motion evidence; release only when `release`. */
async function drag(el: HTMLElement, fromX: number, dxFrames: number, sample: string[], opts: Record<string, boolean> = {}, release = true) {
  firePointerEvent(el, 'pointerdown', { x: fromX, y: ROW_Y }, opts);
  await nextFrame();
  const frames: Record<string, { x: number; w: string }[]> = Object.fromEntries(sample.map((s) => [s, []]));
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    firePointerEvent(window, 'pointermove', { x: fromX + (dxFrames * PX_PER_FRAME * i) / steps, y: ROW_Y }, opts);
    for (const s of sample) frames[s].push({ x: tx(body(s)), w: body(s).style.width });
  }
  if (release) {
    firePointerEvent(window, 'pointerup', { x: fromX + dxFrames * PX_PER_FRAME, y: ROW_Y }, opts);
    await nextFrame();
  }
  return frames;
}
const distinct = (xs: unknown[]) => new Set(xs.map((x) => JSON.stringify(x))).size;

describe('the clip block (§4.3)', () => {
  it('a video clip at the default 52 px track: 14 px strip, 25 px filmstrip, 11 px waveform band', () => {
    const b = body('a');
    expect(b.querySelector<HTMLElement>(`[data-testid="${ID.clipStrip}"]`)!.style.height).toBe('14px');
    expect(b.querySelector<HTMLElement>(`[data-testid="${ID.clipFilm}"]`)!.style.height).toBe('25px');
    expect(b.querySelector<HTMLElement>(`[data-testid="${ID.clipBand}"]`)!.style.height).toBe('11px');
    expect(b.querySelector(`[data-testid="${ID.clipStrip}"]`)!.textContent).toBe('A');
    // opaque kind token, 2 px radius, 1 px inset in the lane
    expect(b.className).toMatch(/\bbg-clip-video\b/);
    expect(b.className).toMatch(/\brounded-xs\b/);
    expect(b.style.top).toBe('1px');
  });

  it('an audio clip is strip + waveform, with its kind glyph, and no filmstrip', () => {
    const m = body('m');
    expect(m.className).toMatch(/\bbg-clip-audio\b/);
    expect(m.querySelector(`[data-testid="${ID.clipFilm}"]`)).toBeNull();
    expect(m.querySelector<HTMLElement>(`[data-testid="${ID.clipBand}"]`)!.style.height).toBe('36px');
    expect(m.querySelector(`[data-testid="${ID.clipStrip}"] svg`)).not.toBeNull();
  });

  it('draws the cut between two butted clips as a hairline, dashed for a through edit', async () => {
    expect(body('a').querySelector('[data-chroma-cut]')).toBeNull();
    expect(body('b').querySelector('[data-chroma-cut]')!.getAttribute('data-chroma-cut')).toBe('cut');
    // split 'a' (same source, contiguous): the right half is a through edit
    actSync(() => useEditorTimelineStore.getState().applyOp({ kind: 'split', track: 0, clip: 0, atFrame: 24 }));
    await waitFrames(2);
    const halves = qa(`[data-testid="${ID.clip}"][data-chroma-track="0"]`);
    expect(halves.some((h) => h.querySelector('[data-chroma-cut="through"]'))).toBe(true);
  });

  it('puts nothing over the picture: the keyframes badge lives in the strip', () => {
    actSync(() =>
      useEditorTimelineStore.getState().applyOp({
        kind: 'set_clip_keyframes',
        track: 0,
        clip: 0,
        param: 'opacity',
        keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }],
      } as never),
    );
    const badge = body('a').querySelector<HTMLElement>(`[data-testid="${ID.clipKeyframesBadge}"]`);
    if (badge) expect(badge.closest(`[data-testid="${ID.clipStrip}"]`)).not.toBeNull();
    // the old floating corner button is gone everywhere
    expect(q('button[aria-label="Toggle the curve editor for this clip"]:not([data-testid])')).toBeNull();
  });
});

describe('selection (§4.3)', () => {
  it('is a 2 px INSET amber outline — no ring outside the clip, no looping pulse', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'b' }] }));
    await nextFrame();
    const cls = body('b').className;
    expect(cls).toMatch(/\boutline-2\b/);
    expect(cls).toMatch(/-outline-offset-2\b/);
    expect(cls).toMatch(/\boutline-selection\b/);
    expect(cls).not.toMatch(/\bring-|animate-pulse/);
    expect(body('a').className).not.toMatch(/outline-selection\b/);
  });
});

describe('edge-trim zones and the bracket (§4.4)', () => {
  it('gives every clip an 8 px zone inside each edge (16 px across a cut)', () => {
    expect(zone('a', 'end').style.width).toBe('8px');
    expect(zone('b', 'start').style.width).toBe('8px');
    expect(zone('a', 'end').className).toMatch(/cursor-col-resize/);
    // the library's translucent stretch triangles are not rendered at all
    expect(q('.timeline-editor-action-left-stretch, .timeline-editor-action-right-stretch')).toBeNull();
  });

  it('shows ONE amber bracket on the hovered edge only, and none at rest', async () => {
    expect(brackets()).toHaveLength(0);
    firePointerEvent(zone('b', 'end'), 'pointermove', { x: 389, y: ROW_Y });
    await nextFrame();
    const bs = brackets();
    expect(bs).toHaveLength(1);
    expect(bs[0].dataset.chromaBracketSide).toBe('out');
    expect(bs[0].dataset.chromaLimit).toBe('false');
  });

  it('turns the bracket red and the readout to "Limit" at a media/neighbour limit', async () => {
    // a plain out-trim of 'a' cannot grow into 'b'
    await drag(zone('a', 'end'), 210, 10, [], {}, false);
    expect(brackets()[0].dataset.chromaLimit).toBe('true');
    expect(q(`[data-testid="${ID.editReadout}"]`)!.textContent).toMatch(/Limit$/);
    firePointerEvent(window, 'pointerup', { x: 250, y: ROW_Y });
    await nextFrame();
    expect(clipOf('a').duration).toBe(48);
  });
});

describe('edit tools: live motion on every move, exact result on release (B-344, B-345)', () => {
  it('Select trim: the edge moves live and lands EXACTLY where released (15 frames, not 13)', async () => {
    const live = await drag(zone('b', 'end'), 390, -15, ['b']);
    expect(distinct(live.b.map((f) => f.w))).toBeGreaterThanOrEqual(4);
    expect(clipOf('b').duration).toBe(33);
    expect(clipOf('c').start_frame).toBe(96);
  });

  it('Select trim of a head moves the clip and its source in-point together', async () => {
    await drag(zone('c', 'start'), 394, 15, ['c']);
    expect(clipOf('c')).toMatchObject({ start_frame: 111, source_start: 115, duration: 33 });
  });

  it('Ripple: every clip after the edge follows it live, and the timeline shortens', async () => {
    await pickTool('ripple');
    const live = await drag(zone('b', 'end'), 390, -15, ['b', 'c']);
    expect(distinct(live.c.map((f) => f.x))).toBeGreaterThanOrEqual(4);
    // c moves by exactly the edge delta, in the same frame
    live.c.forEach((f, i) => expect(f.x).toBeCloseTo(-15 * PX_PER_FRAME * ((i + 1) / 5), 0));
    expect(clipOf('b').duration).toBe(33);
    expect(clipOf('c').start_frame).toBe(81);
  });

  it('Roll: both sides of the cut move together, live; total length unchanged', async () => {
    await pickTool('roll');
    const live = await drag(zone('a', 'end'), 210, 15, ['a', 'b']);
    expect(distinct(live.a.map((f) => f.w))).toBeGreaterThanOrEqual(4);
    expect(distinct(live.b.map((f) => f.x))).toBeGreaterThanOrEqual(4);
    expect(clipOf('a').duration).toBe(63);
    expect(clipOf('b')).toMatchObject({ start_frame: 63, source_start: 115, duration: 33 });
    expect(clipOf('c').start_frame).toBe(96);
  });

  it('Slip: the clip stays put while its picture slides inside it; the source window moves', async () => {
    await pickTool('slip');
    firePointerEvent(body('b'), 'pointerdown', { x: 300, y: ROW_Y });
    await nextFrame();
    const media = body('b').querySelector<HTMLElement>('[data-chroma-clip-media]')!;
    const seen = new Set<string>();
    for (let i = 1; i <= 5; i++) {
      firePointerEvent(window, 'pointermove', { x: 300 + 3 * i * PX_PER_FRAME, y: ROW_Y });
      seen.add(media.style.transform);
      expect(tx(body('b'))).toBe(0);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    firePointerEvent(window, 'pointerup', { x: 300 + 15 * PX_PER_FRAME, y: ROW_Y });
    await nextFrame();
    expect(clipOf('b')).toMatchObject({ start_frame: 48, duration: 48, source_start: 115 });
  });

  it('Slide: the clip translates and both neighbours follow, live; length unchanged', async () => {
    await pickTool('slide');
    const live = await drag(body('b'), 300, 15, ['a', 'b', 'c']);
    expect(distinct(live.b.map((f) => f.x))).toBeGreaterThanOrEqual(4);
    expect(distinct(live.a.map((f) => f.w))).toBeGreaterThanOrEqual(4);
    expect(distinct(live.c.map((f) => f.x))).toBeGreaterThanOrEqual(4);
    expect(clipOf('a').duration).toBe(63);
    expect(clipOf('b').start_frame).toBe(63);
    expect(clipOf('c')).toMatchObject({ start_frame: 111, duration: 33 });
  });

  it('Esc cancels: nothing commits and the clips go back', async () => {
    await pickTool('ripple');
    await drag(zone('b', 'end'), 390, -15, ['c'], {}, false);
    expect(tx(body('c'))).not.toBe(0);
    actSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(body('c').style.transform).toBe('');
    expect(clipOf('b').duration).toBe(48);
  });

  it('drops the preview styles on the render that lands the edit (no settle, no jump)', async () => {
    await pickTool('roll');
    await drag(zone('a', 'end'), 210, 15, ['b']);
    expect(body('a').style.width).toBe('');
    expect(body('b').style.transform).toBe('');
  });

  it('renders the pane at most twice per gesture, and never while the pointer moves (B-347)', async () => {
    // By key, not a toolbar click: a clicked button's tooltip closing on the
    // next press is a commit of its own and would be counted here.
    actSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b', bubbles: true })));
    await waitFrames(2);
    // Flush whatever async work (thumbnail/waveform fetches) is still pending
    // into its own commit first: every act()-wrapped dispatch flushes it, so
    // without this the first event of ANY kind would be charged for it.
    for (let i = 0; i < 3; i++) firePointerEvent(document.body, 'pointermove', { x: 1, y: 1 });
    const before = commits;
    const panesBefore = paneRenders.n;
    firePointerEvent(zone('b', 'end'), 'pointerdown', { x: 390, y: ROW_Y });
    const afterDown = commits;
    for (let i = 1; i <= 10; i++) firePointerEvent(window, 'pointermove', { x: 390 - i * 6, y: ROW_Y });
    await nextFrame();
    // Not one React commit anywhere in the tree while the hand moves.
    expect({ down: afterDown - before, moves: commits - afterDown }).toEqual({ down: 0, moves: 0 });
    expect(paneRenders.n - panesBefore).toBe(0);
    firePointerEvent(window, 'pointerup', { x: 330, y: ROW_Y });
    await nextFrame();
    // The release: the edit and its selection land in one batched pane render.
    expect(paneRenders.n - panesBefore).toBeLessThanOrEqual(2);
    expect(clipOf('b').duration).toBe(32);
  });
});

describe('the Blade tool', () => {
  it('cuts the clicked clip at the clicked frame, and C selects it', async () => {
    actSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', bubbles: true })));
    await nextFrame();
    expect(q('[data-chroma-trim-tool="blade"]')!.getAttribute('aria-pressed')).toBe('true');
    // x = 32 (start left) + 60 frames × 3.75 → frame 60, inside 'b'
    firePointerEvent(body('b'), 'pointerdown', { x: 32 + 60 * PX_PER_FRAME, y: ROW_Y });
    await nextFrame();
    const track0 = useEditorTimelineStore.getState().timeline!.tracks[0].clips;
    expect(track0).toHaveLength(4);
    expect(clipOf('b').duration).toBe(12);
  });
});

describe('layers (B-342)', () => {
  it('isolates the timeline as one stacking context and puts markers on the named layer', () => {
    const root = q(`[data-testid="${ID.editArea}"]`)!.closest('.isolate');
    expect(root).not.toBeNull();
    expect(q('[data-chroma-marker-strip]')!.className).toMatch(/z-\(--z-timeline-markers\)/);
  });
});
