// @vitest-environment jsdom
/**
 * @apelles/editor — D-432 P3 on the real `TimelinePane` (and the viewer's
 * two-up store): track headers, per-track height, the Clip Appearance
 * popover, our own ruler (ticks per zoom, drag-to-scrub, B-350), marker drag
 * (B-348), the Snapping (N) and Skimming (S) toggles, keyboard zoom and the
 * two-up trim viewer's frames.
 *
 * Fixture: 24 fps, 90 px/s → 3.75 px per frame. Track 0 (video) 'a' [0,48)
 * 'b' [48,96) 'c' [96,144); track 1 (audio) 'm' [0,48). One marker at 24.
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

import { useHistoryStore } from '@apelles/history';
import { useKeymapStore } from '@apelles/keymap';
import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { TIMELINE_TEST_IDS as ID } from './timelineTestIds';
import { useTimelineViewStore } from './timelineView';
import { usePreviewPeekStore } from './previewPeek';
import type { Timeline } from './timeline';

const FPS = 24;
const PX_PER_FRAME = 90 / FPS;
const START_LEFT = 32;
const ROW_Y = 70;

function clipFixture(id: string, start: number) {
  return { id, name: id.toUpperCase(), source_path: `/${id}.mp4`, source_start: 100, duration: 48, source_len: 480, start_frame: start };
}

function buildFixture(): Timeline {
  return {
    id: 'p3-fixture',
    name: 'p3 fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: [clipFixture('a', 0), clipFixture('b', 48), clipFixture('c', 96)] },
      { kind: 'audio', clips: [clipFixture('m', 0)] },
    ],
    markers: [{ id: 'mk', frame: 24, color: '#3B8FE3', name: 'hook' }],
  };
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restore = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub(), stubBoundingRectsFromInlineStyle()];
  console_ = captureConsole();
  useTimelineViewStore.getState().resetView();
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
  // a field focused by an earlier test (a portal's input) would swallow keys
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  usePreviewPeekStore.setState({ skimFrame: null, twoUp: null });
  useHistoryStore.getState().clear();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/p3.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
      editingMarkerId: null,
    }),
  );
  mounted = mount(React.createElement(TimelinePane));
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

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const header = (t: number) => q(`[data-testid="${ID.trackHeader}"][data-chroma-track="${t}"]`)!;
const body = (id: string) => q(`[data-testid="${ID.clip}"][data-chroma-clip-id="${id}"]`)!;
const zone = (id: string, edge: 'start' | 'end') => body(id).querySelector<HTMLElement>(`[data-chroma-trim-edge="${edge}"]`)!;
const tl = () => useEditorTimelineStore.getState().timeline!;
const clipOf = (id: string) => tl().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const key = (code: string, k: string) =>
  actSync(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true }));
  });
const click = (el: HTMLElement) => actSync(() => el.click());
function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  actSync(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function drag(el: HTMLElement, fromX: number, dxFrames: number, release = true) {
  firePointerEvent(el, 'pointerdown', { x: fromX, y: ROW_Y });
  await nextFrame();
  for (let i = 1; i <= 5; i++) firePointerEvent(window, 'pointermove', { x: fromX + (dxFrames * PX_PER_FRAME * i) / 5, y: ROW_Y });
  if (release) {
    firePointerEvent(window, 'pointerup', { x: fromX + dxFrames * PX_PER_FRAME, y: ROW_Y });
    await nextFrame();
  }
}

describe('track headers (§4.8)', () => {
  it('show a kind strip, the V1 / A1 pill and the name; no per-row trash, no dots grip', () => {
    expect(header(0).querySelector(`[data-testid="${ID.trackBadge}"]`)!.textContent).toBe('V1');
    expect(header(1).querySelector(`[data-testid="${ID.trackBadge}"]`)!.textContent).toBe('A1');
    expect(header(1).querySelector(`[data-testid="${ID.trackName}"]`)!.textContent).toBe('Audio 1');
    expect(qa(`[data-testid="${ID.trackRemove}"]`)).toHaveLength(0);
    expect(q('[aria-label="Drag to reorder track"]')).toBeNull();
    expect(header(0).className).toMatch(/\bcursor-grab\b/);
  });

  it('reveal toggles on hover only, except a toggle in its non-default state', async () => {
    const lock = header(0).querySelector<HTMLElement>(`[data-testid="${ID.trackLock}"]`)!;
    expect(lock.className).toMatch(/(^| )hidden( |$)/);
    expect(lock.className).toMatch(/group-hover\/header:inline-flex/);
    click(lock);
    await nextFrame();
    expect(tl().tracks[0].locked).toBe(true);
    const locked = header(0).querySelector<HTMLElement>(`[data-testid="${ID.trackLock}"]`)!;
    expect(locked.hasAttribute('data-chroma-active')).toBe(true);
    expect(locked.className).not.toMatch(/(^| )hidden( |$)/);
  });

  it('rename inline on double-click: Enter commits one set_track_name, the pill stays', async () => {
    const name = header(1).querySelector<HTMLElement>(`[data-testid="${ID.trackName}"]`)!;
    actSync(() => name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await nextFrame();
    const input = header(1).querySelector<HTMLInputElement>(`[data-testid="${ID.trackNameInput}"]`)!;
    expect(input).not.toBeNull();
    typeInto(input, 'Music');
    actSync(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await nextFrame();
    expect(tl().tracks[1].name).toBe('Music');
    expect(header(1).querySelector(`[data-testid="${ID.trackName}"]`)!.textContent).toBe('Music');
    expect(header(1).querySelector(`[data-testid="${ID.trackBadge}"]`)!.textContent).toBe('A1');
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });

  it('delete lives in the track menu', async () => {
    click(header(1).querySelector<HTMLElement>(`[data-testid="${ID.trackMenu}"]`)!);
    await waitFrames(2);
    const del = q(`[data-testid="${ID.trackRemove}"]`);
    expect(del).not.toBeNull();
    click(del!);
    await nextFrame();
    expect(tl().tracks).toHaveLength(1);
  });
});

describe('per-track height (§4.8, §4.3)', () => {
  it('a bottom-edge drag resizes live without rendering, then commits ONE set_track_height and the anatomy follows', async () => {
    const z = header(0).querySelector<HTMLElement>(`[data-testid="${ID.trackHeightResize}"]`)!;
    const before = paneRenders.n;
    firePointerEvent(z, 'pointerdown', { x: 20, y: 89 });
    firePointerEvent(window, 'pointermove', { x: 20, y: 101 });
    firePointerEvent(window, 'pointermove', { x: 20, y: 113 });
    expect(header(0).style.height).toBe('76px');
    expect(q(`[data-testid="${ID.trackHeightGuide}"]`)!.hidden).toBe(false);
    expect(paneRenders.n).toBe(before);
    firePointerEvent(window, 'pointerup', { x: 20, y: 113 });
    await waitFrames(2);
    expect(tl().tracks[0].height).toBe(76);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    // L anatomy: a 16 px strip (it is 14 below 76)
    expect(body('a').querySelector<HTMLElement>(`[data-testid="${ID.clipStrip}"]`)!.style.height).toBe('16px');
    expect(body('m').querySelector<HTMLElement>(`[data-testid="${ID.clipStrip}"]`)!.style.height).toBe('14px');
    // the rows below moved down by the new height
    const tops = q(`[data-testid="${ID.editArea}"]`)!.getAttribute('data-chroma-row-tops');
    expect(tops).toBe('0,76,128');
  });

  it('Esc cancels a height drag; a double-click resets the track to the view default', async () => {
    const z = header(0).querySelector<HTMLElement>(`[data-testid="${ID.trackHeightResize}"]`)!;
    firePointerEvent(z, 'pointerdown', { x: 20, y: 89 });
    firePointerEvent(window, 'pointermove', { x: 20, y: 140 });
    key('Escape', 'Escape');
    firePointerEvent(window, 'pointerup', { x: 20, y: 140 });
    await nextFrame();
    expect(tl().tracks[0].height).toBeUndefined();
    expect(header(0).style.height).toBe('52px');
    actSync(() => useEditorTimelineStore.getState().applyOp({ kind: 'set_track_height', track: 0, height: 108 }));
    await nextFrame();
    actSync(() => z.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await nextFrame();
    expect(tl().tracks[0].height).toBeUndefined();
  });

  it('the Clip Appearance popover sets the default height, balance, names and badges', async () => {
    click(q(`[data-testid="${ID.clipAppearance}"]`)!);
    await waitFrames(2);
    click(q('[data-chroma-clip-height="XL"]')!);
    await nextFrame();
    expect(useTimelineViewStore.getState().clipHeight).toBe(108);
    expect(header(1).style.height).toBe('108px');
    click(q('[data-chroma-band-ratio="0"]')!);
    await nextFrame();
    expect(useTimelineViewStore.getState().bandRatio).toBe(0);
    // filmstrip only: no waveform band on the video clip
    expect(body('a').querySelector(`[data-testid="${ID.clipBand}"]`)).toBeNull();
    click(q(`[data-testid="${ID.showClipNames}"]`)!);
    await nextFrame();
    expect(useTimelineViewStore.getState().showNames).toBe(false);
    expect(body('a').querySelector(`[data-testid="${ID.clipStrip}"]`)!.textContent).toBe('');
  });
});

describe('ruler (§4.6, B-350)', () => {
  it('labels and tick density follow the zoom, in the adaptive format', async () => {
    const ruler = q(`[data-testid="${ID.ruler}"]`)!;
    expect(ruler.getAttribute('data-chroma-tick-seconds')).toBe('1');
    expect(ruler.getAttribute('data-chroma-tick-split')).toBe('10');
    expect(qa(`[data-testid="${ID.rulerLabel}"]`).map((l) => l.textContent).slice(0, 3)).toEqual(['0:00', '0:01', '0:02']);
    actSync(() => useTimelineViewStore.getState().setPxPerSec(9));
    await waitFrames(2);
    expect(q(`[data-testid="${ID.ruler}"]`)!.getAttribute('data-chroma-tick-seconds')).toBe('10');
    expect(qa(`[data-testid="${ID.rulerLabel}"]`)[1].textContent).toBe('0:10');
    actSync(() => useTimelineViewStore.getState().setPxPerSec(480));
    await waitFrames(2);
    // frame-level zoom: frames appear
    expect(qa(`[data-testid="${ID.rulerLabel}"]`)[1].textContent).toMatch(/^0:00:\d\d$/);
  });

  it('a press seeks and a drag scrubs live (B-350)', async () => {
    const ruler = q(`[data-testid="${ID.ruler}"]`)!;
    firePointerEvent(ruler, 'pointerdown', { x: START_LEFT + 90, y: 10 });
    expect(useEditorTimelineStore.getState().playhead).toBe(24);
    const seen = new Set<number>();
    for (let i = 1; i <= 4; i++) {
      firePointerEvent(window, 'pointermove', { x: START_LEFT + 90 + i * 45, y: 10 });
      seen.add(useEditorTimelineStore.getState().playhead);
    }
    firePointerEvent(window, 'pointerup', { x: START_LEFT + 270, y: 10 });
    await nextFrame();
    expect(seen.size).toBe(4);
    expect(useEditorTimelineStore.getState().playhead).toBe(72);
  });
});

describe('markers (§4.7, B-348)', () => {
  const flag = () => q('[data-chroma-marker="mk"]')!;

  it('the flag is a Phosphor shield centred on its frame', () => {
    expect(flag().querySelector('svg')).not.toBeNull();
    expect(flag().style.left).toBe(`${START_LEFT + 90}px`);
    expect(flag().style.marginLeft).toBe('-7px');
  });

  it('a drag moves the marker (one set_marker), without opening the editor or jumping', async () => {
    firePointerEvent(flag(), 'pointerdown', { x: START_LEFT + 90, y: 30 });
    for (let i = 1; i <= 4; i++) firePointerEvent(window, 'pointermove', { x: START_LEFT + 90 + (i * 23 * PX_PER_FRAME) / 4, y: 30 });
    expect(flag().style.transform).toMatch(/translate3d/);
    firePointerEvent(window, 'pointerup', { x: START_LEFT + 90 + 23 * PX_PER_FRAME, y: 30 });
    click(flag());
    await waitFrames(2);
    // 24 + 23 = 47, snapped to b's start at 48 (snapping is on)
    expect(tl().markers![0].frame).toBe(48);
    expect(flag().style.transform).toBe('');
    expect(q('[data-chroma-marker-editor]')).toBeNull();
    expect(useEditorTimelineStore.getState().playhead).toBe(0);
  });

  it('a second click on the selected flag opens the editor (Name first, Remove / Done)', async () => {
    click(flag());
    await nextFrame();
    expect(q('[data-chroma-marker-editor]')).toBeNull();
    click(flag());
    await waitFrames(2);
    const editor = q('[data-chroma-marker-editor]')!;
    expect(editor).not.toBeNull();
    expect(editor.querySelector('input')!.hasAttribute('data-chroma-marker-name')).toBe(true);
    expect(editor.textContent).toContain('Remove Marker');
    expect(editor.textContent).toContain('Done');
  });
});

describe('snapping (N) and skimming (S)', () => {
  it('N toggles snapping; T is the Roll tool now', async () => {
    key('KeyN', 'n');
    expect(useTimelineViewStore.getState().snapping).toBe(false);
    key('KeyN', 'n');
    expect(useTimelineViewStore.getState().snapping).toBe(true);
    key('KeyT', 't');
    await nextFrame();
    expect(q('[data-chroma-trim-tool="roll"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('with snapping on, a trim lands on the playhead; off, exactly where released', async () => {
    actSync(() => useEditorTimelineStore.setState({ playhead: 150 }));
    const endX = START_LEFT + 144 * PX_PER_FRAME - 2;
    await drag(zone('c', 'end'), endX, 5);
    expect(clipOf('c').duration).toBe(54);
    actSync(() => useEditorTimelineStore.setState({ timeline: buildFixture() }));
    await waitFrames(2);
    key('KeyN', 'n');
    await drag(zone('c', 'end'), endX, 5);
    expect(clipOf('c').duration).toBe(53);
  });

  it('S turns skimming on: the pointer asks the viewer for its frame, the playhead stays, the pane does not render', async () => {
    key('KeyS', 's');
    expect(useTimelineViewStore.getState().skimming).toBe(true);
    await nextFrame();
    const area = q(`[data-testid="${ID.editArea}"]`)!;
    const before = paneRenders.n;
    firePointerEvent(area, 'pointermove', { x: START_LEFT + 180, y: ROW_Y }, { buttons: 0 });
    firePointerEvent(area, 'pointermove', { x: START_LEFT + 190, y: ROW_Y }, { buttons: 0 });
    await nextFrame();
    expect(usePreviewPeekStore.getState().skimFrame).toBe(51);
    expect(useEditorTimelineStore.getState().playhead).toBe(0);
    expect(q(`[data-testid="${ID.skimLine}"]`)!.hidden).toBe(false);
    expect(paneRenders.n).toBe(before);
    actSync(() => area.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })));
    expect(usePreviewPeekStore.getState().skimFrame).toBeNull();
    expect(q(`[data-testid="${ID.skimLine}"]`)!.hidden).toBe(true);
  });

  it('off by default: hovering asks the viewer for nothing', async () => {
    firePointerEvent(q(`[data-testid="${ID.editArea}"]`)!, 'pointermove', { x: START_LEFT + 180, y: ROW_Y }, { buttons: 0 });
    await nextFrame();
    expect(usePreviewPeekStore.getState().skimFrame).toBeNull();
  });
});

describe('keyboard zoom (B-348)', () => {
  it('= zooms in and - zooms out', async () => {
    const base = useTimelineViewStore.getState().pxPerSec;
    key('Equal', '=');
    await nextFrame();
    expect(useTimelineViewStore.getState().pxPerSec).toBeGreaterThan(base);
    key('Minus', '-');
    key('Minus', '-');
    await nextFrame();
    expect(useTimelineViewStore.getState().pxPerSec).toBeLessThan(base);
  });
});

describe('two-up trim viewer (§5.1)', () => {
  it('a roll shows outgoing | incoming frames during the drag only', async () => {
    click(q('[data-chroma-trim-tool="roll"]')!);
    await nextFrame();
    await drag(zone('a', 'end'), START_LEFT + 48 * PX_PER_FRAME - 2, 10, false);
    const view = usePreviewPeekStore.getState().twoUp!;
    expect(view.left).toMatchObject({ label: 'Out', sourcePath: '/a.mp4', sourceFrame: 100 + 58 - 1, timelineFrame: 57 });
    expect(view.right).toMatchObject({ label: 'In', sourcePath: '/b.mp4', sourceFrame: 110, timelineFrame: 58 });
    firePointerEvent(window, 'pointerup', { x: 0, y: ROW_Y });
    await nextFrame();
    expect(usePreviewPeekStore.getState().twoUp).toBeNull();
  });

  it('a plain trim stays one-up', async () => {
    await drag(zone('c', 'end'), START_LEFT + 144 * PX_PER_FRAME - 2, -4, false);
    expect(usePreviewPeekStore.getState().twoUp).toBeNull();
    firePointerEvent(window, 'pointerup', { x: 0, y: ROW_Y });
    await nextFrame();
  });
});
