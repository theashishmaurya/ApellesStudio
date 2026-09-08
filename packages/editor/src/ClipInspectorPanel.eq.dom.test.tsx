// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for D-224's Inspector EQ section.
 *
 * **Why a DOM test.** `timeline.test.ts` already proves the `set_clip_eq`
 * reducer and `chroma_types::eq` proves the filter math; neither proves the
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
 * nothing about what is heard; that is `chroma-media`'s own measured cascade
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
  installResizeObserverStub,
  linearPath,
  mount,
  stubOffsetMetrics,
  waitFrames,
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
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
import { EQ_BAND_COUNT } from './timeline';
import type { Clip, Timeline } from './timeline';

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

const EQ_GRAPH_WIDTH = 280;
const EQ_GRAPH_HEIGHT = 92;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  restoreOffsetMetrics = stubOffsetMetrics(EQ_GRAPH_WIDTH, EQ_GRAPH_HEIGHT);
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreOffsetMetrics?.();
  restoreOffsetMetrics = null;
});

/** Every band's own container, in render order — found by the band-number
 *  button each one starts with, so this reads the DOM the way a user does
 *  rather than by a class name that is free to change. */
function bandBlocks(): HTMLElement[] {
  const buttons = [...(mounted?.container.querySelectorAll('button') ?? [])].filter((b) =>
    /^Band \d+$/.test(b.textContent ?? ''),
  );
  return buttons.map((b) => {
    const block = b.closest('div')?.parentElement;
    if (!block) throw new Error(`no container for ${b.textContent}`);
    return block as HTMLElement;
  });
}

function bandButton(index: number): HTMLButtonElement {
  const el = [...(mounted?.container.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === `Band ${index + 1}`,
  );
  if (!el) throw new Error(`no Band ${index + 1} button`);
  return el as HTMLButtonElement;
}

/** The numeric field labelled `label` INSIDE band `index` — scoped, because
 *  every band has a Freq, a Gain and a Q, and an unscoped lookup would always
 *  find band 1's. */
function bandField(index: number, label: string): HTMLInputElement {
  const block = bandBlocks()[index];
  const span = [...block.querySelectorAll('span')].find((s) => s.textContent === label);
  const input = span?.parentElement?.querySelector('input');
  if (!input) throw new Error(`no ${label} field in band ${index + 1}`);
  return input as HTMLInputElement;
}

function click(el: HTMLElement) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function type(input: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  actSync(() => {
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

describe('the Inspector EQ section (D-224)', () => {
  it('renders Resolve’s four bands, and opening the panel writes nothing', async () => {
    await render();
    expect(bandBlocks()).toHaveLength(EQ_BAND_COUNT);
    // The default strip is DISPLAYED, not stored — selecting a clip must never
    // dirty the project.
    expect(currentClip().eq_bands).toBeUndefined();
    // …and every band reads as enabled but flat.
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      expect(bandButton(i).getAttribute('aria-pressed')).toBe('true');
      expect(bandField(i, 'Gain').value).toBe('0');
    }
  });

  it('an EQ row carries NO keyframe diamond — the EQ is static by decision', async () => {
    await render();
    // The Audio rows above it DO have one, so this is asserting a real
    // difference rather than an empty panel.
    expect(
      mounted?.container.querySelector('button[aria-label="Toggle Volume keyframes"]'),
    ).not.toBeNull();
    for (const label of ['Freq', 'Gain', 'Q']) {
      expect(
        mounted?.container.querySelector(`button[aria-label="Toggle ${label} keyframes"]`),
      ).toBeNull();
    }
    // …but each row still has its own reset, which a static property wants.
    expect(bandBlocks()[0].querySelectorAll('button[aria-label^="Reset "]')).toHaveLength(3);
  });

  it('typing a Gain materialises the whole strip and moves only that band’s gain', async () => {
    await render();
    type(bandField(2, 'Gain'), -6);
    const bands = currentClip().eq_bands;
    expect(bands).toHaveLength(EQ_BAND_COUNT);
    expect(bands?.[2].gain_db).toBe(-6);
    expect(bands?.[2].freq_hz).toBe(2500); // its own default, not restated
    expect(bands?.filter((b) => b.gain_db !== 0)).toHaveLength(1);
  });

  it('typing a Freq on one band leaves every other band’s frequency alone', async () => {
    await render();
    type(bandField(0, 'Freq'), 85);
    const bands = currentClip().eq_bands;
    expect(bands?.[0].freq_hz).toBe(85);
    expect(bands?.map((b) => b.freq_hz)).toEqual([85, 500, 2500, 8000]);
  });

  it('the band-number button bypasses that band without losing its settings', async () => {
    await render();
    type(bandField(1, 'Gain'), 9);
    expect(currentClip().eq_bands?.[1].enabled).toBe(true);
    click(bandButton(1));
    expect(currentClip().eq_bands?.[1].enabled).toBe(false);
    expect(currentClip().eq_bands?.[1].gain_db).toBe(9);
    expect(bandButton(1).getAttribute('aria-pressed')).toBe('false');
    click(bandButton(1));
    expect(currentClip().eq_bands?.[1].enabled).toBe(true);
  });

  it('a pass filter disables its own Gain field, because it has no gain', async () => {
    await render();
    expect(bandField(0, 'Gain').disabled).toBe(false);
    // The `kind` select is a Base UI popup; writing the kind through the store
    // (the same op the select fires) is what this assertion is about — that
    // the ROW reacts to the stored kind.
    actSync(() => {
      useEditorTimelineStore
        .getState()
        .applyOp({ kind: 'set_clip_eq', track: 0, clip: 0, band: 0, patch: { kind: 'high_pass' } });
    });
    expect(bandField(0, 'Gain').disabled).toBe(true);
    expect(bandField(0, 'Freq').disabled).toBe(false);
  });

  it('the section reset takes the clip back to no EQ at all', async () => {
    await render();
    type(bandField(0, 'Gain'), 4);
    expect(currentClip().eq_bands).toHaveLength(EQ_BAND_COUNT);
    const reset = mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Reset EQ"]');
    if (!reset) throw new Error('no EQ reset button');
    expect(reset.disabled).toBe(false);
    click(reset);
    // Not an empty array — the key is gone, so the clip serialises exactly as
    // it did before this feature existed.
    expect('eq_bands' in currentClip()).toBe(false);
    // …and with no EQ stored, the reset goes back to disabled.
    expect(
      mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Reset EQ"]')?.disabled,
    ).toBe(true);
  });

  it('a locked track disables every EQ control rather than silently dropping the edit', async () => {
    useEditorTimelineStore.setState({
      timeline: {
        ...fixture(),
        tracks: [{ kind: 'video', locked: true, clips: fixture().tracks[0].clips }],
      } as unknown as Timeline,
    });
    await render();
    expect(bandButton(0).disabled).toBe(true);
    expect(bandField(0, 'Freq').disabled).toBe(true);
    expect(bandField(0, 'Gain').disabled).toBe(true);
  });

  describe('the response graph (D-237)', () => {
    it('renders above the four band blocks, one point per band', async () => {
      await render();
      const graph = mounted?.container.querySelector('[data-chroma-eq-graph]');
      expect(graph).not.toBeNull();
      expect(graph?.querySelectorAll('[data-chroma-eq-point]')).toHaveLength(EQ_BAND_COUNT);
      // Above, not below — matches the reference's own stacking order.
      const firstBandBlock = bandBlocks()[0];
      expect(
        graph!.compareDocumentPosition(firstBandBlock) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('dragging a band’s point writes through the SAME onEqBandChange path a typed PropertyRow value does', async () => {
      await render();
      const point = mounted?.container.querySelector('[data-chroma-eq-point="2"]') as SVGCircleElement;
      if (!point) throw new Error('no graph point for band 3');
      const startFreq = 2_500; // band 3's own default (see fourBands' fixture)
      const startX = freqToX(startFreq, EQ_GRAPH_WIDTH);
      const startY = dbToY(0, EQ_GRAPH_HEIGHT);
      const targetX = freqToX(6_000, EQ_GRAPH_WIDTH);
      const targetY = dbToY(-8, EQ_GRAPH_HEIGHT);

      await dragPointer(point, linearPath({ x: startX, y: startY }, { x: targetX, y: targetY }, 4), {
        moveTarget: window,
      });

      // The real store, through the real `set_clip_eq` op — not a callback
      // spy — which is what proves the graph and the Inspector's own
      // Freq/Gain PropertyRows are two views of the identical write.
      const bands = currentClip().eq_bands;
      expect(bands?.[2].freq_hz).toBe(6_000);
      expect(bands?.[2].gain_db).toBe(-8);
      // …and every OTHER band's own frequency is untouched — a graph drag is
      // as scoped to its one band as a typed field already is.
      expect(bands?.[0].freq_hz).toBe(120);
      expect(bands?.[1].freq_hz).toBe(500);
      expect(bands?.[3].freq_hz).toBe(8_000);
    });

    it('a locked track’s graph does not respond to a drag', async () => {
      useEditorTimelineStore.setState({
        timeline: {
          ...fixture(),
          tracks: [{ kind: 'video', locked: true, clips: fixture().tracks[0].clips }],
        } as unknown as Timeline,
      });
      await render();
      const point = mounted?.container.querySelector('[data-chroma-eq-point="0"]') as SVGCircleElement;
      if (!point) throw new Error('no graph point for band 1');
      await dragPointer(
        point,
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
