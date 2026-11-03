// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for D-224's Inspector EQ section.
 *
 * **Why a DOM test.** `timeline.test.ts` already proves the `set_clip_eq`
 * reducer and `apelles_types::eq` proves the filter math; neither proves the
 * half a human actually touches — that the section renders Resolve's four
 * bands, that a band's fields write only that band's own field, that the
 * band-number button really bypasses, and that the section's reset takes the
 * clip back to no EQ at all. That path runs through the real
 * `EditorInspectorPanel`, the real `ClipInspectorPanel` rows and the real
 * `timelineStore.applyOp`, so it can only be asserted here.
 *
 * It also pins the two things D-224 decided NOT to build, because both are
 * invisible in a unit test and both would be silently un-done by a future
 * change: an EQ row carries **no keyframe diamond** (an EQ here is static —
 * ffmpeg's biquad filters parse their parameters once, so an animated EQ is
 * not exportable), and merely opening the panel on a clip with no EQ writes
 * **nothing**.
 *
 * Same tier and same honest limits as `EditorInspectorPanel.keyframes.dom.
 * test.tsx`: jsdom, real components, real store, a stubbed Tauri `invoke`. It
 * proves the AUTHORING contract — what ends up in `Clip.eq_bands` — and
 * nothing about what is heard; that is `apelles-media`'s own measured cascade
 * tests and `timelineExport.ffmpeg.test.ts`'s real-ffmpeg response
 * measurement.
 *
 * **D-237** adds one more thing this tier is the only place that can prove:
 * that `EqResponseGraph` — otherwise covered on its own, with its drag/wheel
 * gestures, by `EqResponseGraph.dom.test.tsx` — is really wired to the SAME
 * `onEqBandChange`/`applyOp` path as the `PropertyRow`s below it, through the
 * real `EditorInspectorPanel`/store, not merely unit-tested in isolation.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  actSync,
  dragPointer,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  linearPath,
  mount,
  stubOffsetMetrics,
  waitFrames,
  waitMs,
  type MountedComponent,
} from './testUtils/pointerHarness';
import { dbToY, freqToX } from './eqCurve';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_set') return null;
    if (cmd === 'chroma_timeline_clip_geometry') {
      return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
    }
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { openAllInspectorSections } = await import('./testUtils/inspectorSections');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
const { useHistoryStore } = await import('@apelles/history');
import { EQ_BAND_COUNT, resolveEqPreset } from './timeline';
import type { Clip, Timeline } from './timeline';
import { typeNumber } from './testUtils/numberField';

const CLIP_ID = 'clip-1';

function fixture(): Timeline {
  const clip: Clip = {
    id: CLIP_ID,
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  };
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [clip] }],
  } as unknown as Timeline;
}

function currentClip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
// D-237 — gives the new response graph a real, fixed pixel size to compute
// its screen mapping against (jsdom has no layout engine, so an unstubbed
// `clientWidth` is always 0 and the graph would draw nothing at all). Global
// for the whole file rather than per-graph-test only: every other assertion
// here reads DOM values/attributes, not geometry, so a fixed offset size is
// harmless to them.
let restoreOffsetMetrics: (() => void) | null = null;
let restorePointerCapture: (() => void) | null = null;

const EQ_GRAPH_WIDTH = 280;
const EQ_GRAPH_HEIGHT = 92;

beforeEach(() => {
  // every Inspector section starts collapsed; these suites query inside them
  openAllInspectorSections(useEditorTimelineStore);
  restoreResizeObserver = installResizeObserverStub();
  restoreOffsetMetrics = stubOffsetMetrics(EQ_GRAPH_WIDTH, EQ_GRAPH_HEIGHT);
  restorePointerCapture = installPointerCaptureStub();
  useHistoryStore.getState().clear();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    // D-246 — the EQ section lives on the Inspector's Audio tab. Set here
    // rather than clicked because this file is about the EQ, not the tabs;
    // the click path has its own test (`ClipInspectorPanel.tabs.dom.test.tsx`).
    inspectorTab: 'audio',
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreOffsetMetrics?.();
  restoreOffsetMetrics = null;
  restorePointerCapture?.();
  restorePointerCapture = null;
});

/** The graph's dot (hit target) for band `index`. */
function dot(index: number): SVGCircleElement {
  const el = mounted?.container.querySelector(`[data-chroma-eq-point="${index}"]`);
  if (!el) throw new Error(`no graph dot for band ${index + 1}`);
  return el as SVGCircleElement;
}

/** v0.3.0 (D-442) — a press on a dot selects that band for the band row. */
async function selectBand(index: number) {
  const at = { x: Number(dot(index).getAttribute('cx')), y: Number(dot(index).getAttribute('cy')) };
  firePointerEvent(dot(index), 'pointerdown', at);
  firePointerEvent(window, 'pointerup', at);
  await waitFrames(1);
}

/** The ONE band row's field: `frequency`, `gain` or `Q` of the shown band. */
function bandField(index: number, what: 'frequency' | 'gain' | 'Q'): HTMLInputElement {
  const el = mounted?.container.querySelector<HTMLInputElement>(`input[aria-label="Band ${index + 1} ${what}"]`);
  if (!el) throw new Error(`no ${what} field for band ${index + 1} (is it the selected band?)`);
  return el;
}

function powerButton(index: number): HTMLButtonElement {
  const el = mounted?.container.querySelector<HTMLButtonElement>(`button[aria-label="Band ${index + 1} on"]`);
  if (!el) throw new Error(`no power button for band ${index + 1}`);
  return el;
}

function eqMeta(): string {
  const section = mounted?.container.querySelector('[data-chroma-section="eq"]');
  return section?.querySelector('button[aria-expanded] > span:nth-of-type(2)')?.textContent ?? '';
}

function click(el: Element) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function type(input: HTMLInputElement, value: number | string) {
  typeNumber(input, value);
}

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

describe('the Inspector EQ section — the graph is the control (D-224, v0.3.0 D-442)', () => {
  it('shows the graph’s four dots and ONE band row, and opening the panel writes nothing', async () => {
    await render();
    expect(mounted?.container.querySelectorAll('[data-chroma-eq-point]')).toHaveLength(EQ_BAND_COUNT);
    // No band cards: one row, for the selected band (band 1 on a flat strip).
    expect(mounted?.container.querySelectorAll('[data-chroma-eq-band-row]')).toHaveLength(1);
    expect(bandField(0, 'gain').value).toBe('0.0');
    expect(bandField(0, 'frequency').value).toBe('120');
    // The default strip is DISPLAYED, not stored.
    expect(currentClip().eq_bands).toBeUndefined();
    expect(eqMeta()).toBe('Off');
  });

  it('the shape menu reads a word, not the stored enum (B-365)', async () => {
    await render();
    const trigger = mounted?.container.querySelector('[aria-label="Band 1 shape"]');
    expect(trigger?.textContent).toContain('1 · Low shelf');
    expect(trigger?.textContent).not.toContain('low_shelf');
  });

  it('no EQ field carries a keyframe diamond — the EQ is static by decision', async () => {
    await render();
    expect(mounted?.container.querySelector('button[aria-label="Toggle Volume keyframes"]')).not.toBeNull();
    const row = mounted?.container.querySelector('[data-chroma-eq-band-row]');
    expect(row?.querySelector('button[aria-label^="Toggle "]')).toBeNull();
  });

  it('pressing a dot selects that band (a click writes nothing); typing its gain materialises the strip', async () => {
    await render();
    await selectBand(2);
    expect(currentClip().eq_bands).toBeUndefined();
    expect(mounted?.container.querySelector('[data-chroma-eq-band-row="2"]')).not.toBeNull();
    type(bandField(2, 'gain'), -6);
    const bands = currentClip().eq_bands;
    expect(bands).toHaveLength(EQ_BAND_COUNT);
    expect(bands?.[2].gain_db).toBe(-6);
    expect(bands?.[2].freq_hz).toBe(2500);
    expect(bands?.filter((b) => b.gain_db !== 0)).toHaveLength(1);
  });

  it('the frequency field reads Hz / kHz and takes typed `85` or `3.5k`', async () => {
    await render();
    type(bandField(0, 'frequency'), 85);
    expect(currentClip().eq_bands?.map((b) => b.freq_hz)).toEqual([85, 500, 2500, 8000]);
    await selectBand(3);
    expect(bandField(3, 'frequency').value).toBe('8');
    type(bandField(3, 'frequency'), '3.5k');
    expect(currentClip().eq_bands?.[3].freq_hz).toBe(3500);
  });

  it('the power button bypasses the band without losing its settings', async () => {
    await render();
    await selectBand(1);
    type(bandField(1, 'gain'), 9);
    expect(powerButton(1).getAttribute('aria-pressed')).toBe('true');
    click(powerButton(1));
    expect(currentClip().eq_bands?.[1].enabled).toBe(false);
    expect(currentClip().eq_bands?.[1].gain_db).toBe(9);
    expect(powerButton(1).getAttribute('aria-pressed')).toBe('false');
    click(powerButton(1));
    expect(currentClip().eq_bands?.[1].enabled).toBe(true);
  });

  it('a pass filter disables its gain field and shows a dash, because it has no gain', async () => {
    await render();
    expect(bandField(0, 'gain').disabled).toBe(false);
    actSync(() => {
      useEditorTimelineStore
        .getState()
        .applyOp({ kind: 'set_clip_eq', track: 0, clip: 0, band: 0, patch: { kind: 'high_pass' } });
    });
    expect(bandField(0, 'gain').disabled).toBe(true);
    expect(bandField(0, 'gain').value).toBe('—');
    expect(bandField(0, 'frequency').disabled).toBe(false);
  });

  it('double-clicking a dot puts its gain back to 0 dB', async () => {
    await render();
    await selectBand(2);
    type(bandField(2, 'gain'), 5);
    actSync(() => {
      dot(2).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(currentClip().eq_bands?.[2].gain_db).toBe(0);
  });

  it('scrolling on a dot changes that band’s Q, once per gesture', async () => {
    await render();
    actSync(() => {
      dot(1).dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    await waitMs(400);
    expect(currentClip().eq_bands?.[1].q).toBeGreaterThan(1);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });

  it('a preset writes all four bands in one undo step, and the header names it until a band changes', async () => {
    await render();
    const trigger = mounted?.container.querySelector<HTMLElement>('[data-chroma-eq-preset]');
    if (!trigger) throw new Error('no preset menu');
    expect(trigger.textContent).toContain('Flat');
    click(trigger);
    await waitFrames(2);
    const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Voice clarity');
    if (!option) throw new Error('no "Voice clarity" option');
    // Base UI picks an item on its pointer release (a mouse press-drag-release
    // pick), so the test presses and releases on it as a real click does.
    firePointerEvent(option, 'pointerdown', { x: 0, y: 0 });
    firePointerEvent(option, 'pointerup', { x: 0, y: 0 });
    click(option);
    await waitFrames(2);

    expect(currentClip().eq_bands).toEqual(resolveEqPreset('Voice clarity'));
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(eqMeta()).toBe('Voice clarity · 3 of 4 bands on');

    // An edit makes it an ordinary EQ: "Custom".
    await selectBand(1);
    type(bandField(1, 'gain'), -5);
    expect(eqMeta()).toBe('Custom · 3 of 4 bands on');
    expect(mounted?.container.querySelector('[data-chroma-eq-preset]')?.textContent).toContain('Custom');
  });

  it('the section reset takes the clip back to no EQ at all', async () => {
    await render();
    type(bandField(0, 'gain'), 4);
    expect(currentClip().eq_bands).toHaveLength(EQ_BAND_COUNT);
    const reset = mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Reset EQ"]');
    if (!reset) throw new Error('no EQ reset button');
    click(reset);
    expect('eq_bands' in currentClip()).toBe(false);
    expect(mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Reset EQ"]')?.disabled).toBe(true);
  });

  it('a locked track disables every EQ control rather than silently dropping the edit', async () => {
    useEditorTimelineStore.setState({
      timeline: {
        ...fixture(),
        tracks: [{ kind: 'video', locked: true, clips: fixture().tracks[0].clips }],
      } as unknown as Timeline,
    });
    await render();
    expect(powerButton(0).disabled).toBe(true);
    expect(bandField(0, 'frequency').disabled).toBe(true);
    expect(bandField(0, 'gain').disabled).toBe(true);
    expect(bandField(0, 'Q').disabled).toBe(true);
  });

  describe('the response graph (D-237)', () => {
    it('sits above the band row', async () => {
      await render();
      const graph = mounted?.container.querySelector('[data-chroma-eq-graph]');
      const row = mounted?.container.querySelector('[data-chroma-eq-band-row]');
      expect(graph && row && graph.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('dragging a dot writes frequency AND gain through the store, as ONE undo step', async () => {
      await render();
      const startX = freqToX(2_500, EQ_GRAPH_WIDTH);
      const startY = dbToY(0, EQ_GRAPH_HEIGHT);
      const targetX = freqToX(6_000, EQ_GRAPH_WIDTH);
      const targetY = dbToY(-8, EQ_GRAPH_HEIGHT);

      await dragPointer(dot(2), linearPath({ x: startX, y: startY }, { x: targetX, y: targetY }, 4), {
        moveTarget: window,
      });

      const bands = currentClip().eq_bands;
      expect(bands?.[2].freq_hz).toBe(6_000);
      expect(bands?.[2].gain_db).toBe(-8);
      expect(bands?.[0].freq_hz).toBe(120);
      expect(bands?.[1].freq_hz).toBe(500);
      expect(bands?.[3].freq_hz).toBe(8_000);
      expect(useHistoryStore.getState().undoStack).toHaveLength(1);
      // …and the dragged band is now the one the row shows.
      expect(mounted?.container.querySelector('[data-chroma-eq-band-row="2"]')).not.toBeNull();
    });

    it('a locked track’s graph does not respond to a drag', async () => {
      useEditorTimelineStore.setState({
        timeline: {
          ...fixture(),
          tracks: [{ kind: 'video', locked: true, clips: fixture().tracks[0].clips }],
        } as unknown as Timeline,
      });
      await render();
      await dragPointer(
        dot(0),
        linearPath(
          { x: freqToX(120, EQ_GRAPH_WIDTH), y: dbToY(0, EQ_GRAPH_HEIGHT) },
          { x: freqToX(4_000, EQ_GRAPH_WIDTH), y: dbToY(10, EQ_GRAPH_HEIGHT) },
          4,
        ),
        { moveTarget: window },
      );
      expect(currentClip().eq_bands).toBeUndefined();
    });
  });
});
