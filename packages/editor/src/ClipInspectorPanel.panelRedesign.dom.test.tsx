// @vitest-environment jsdom
/**
 * @apelles/editor — the v0.3.0 Inspector panel redesign on a real panel
 * (B-365 / B-366, D-442 / D-443; `docs/notes/panel-redesign.md` "Revision 2"
 * and "As built").
 *
 * The real `EditorInspectorPanel` → `ClipInspectorPanel` → store path, jsdom,
 * StrictMode, a stubbed `invoke` (geometry: a 1 × 1 footprint in a 1920 ×
 * 1080 frame). Proves what the redesign promised and a unit test cannot see:
 * every collapsed header states its value; Position reads in px from the
 * centre and a Scale edit keeps the centre; a crop edit from the L · R · T ·
 * B row keeps the picture in place in one undo step; the Crop header's button
 * is the viewer's crop mode; the Keyframes ‹ › walk every key; fades read and
 * write seconds; the Audio tab's Fades row opens the Video tab's Fade; the
 * Dynamic zoom section shows its boxes; and no explanatory paragraph is left
 * on the Video tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { actSync, installResizeObserverStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

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
import type { Clip, Timeline } from './timeline';
import { fieldByLabel, tabByLabel } from './testUtils/inspectorDom';
import { typeNumber } from './testUtils/numberField';

const CLIP_ID = 'clip-1';

function fixture(over: Partial<Clip> = {}): Timeline {
  const clip = {
    id: CLIP_ID,
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
    ...over,
  } as Clip;
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [
      { kind: 'video', clips: [clip] },
      { kind: 'audio', clips: [], duck_from: null },
    ],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;

function setup(over: Partial<Clip> = {}, openSections = true) {
  if (openSections) openAllInspectorSections(useEditorTimelineStore);
  else useEditorTimelineStore.setState({ inspectorSections: {} });
  useEditorTimelineStore.setState({
    timeline: fixture(over),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    inspectorTab: 'video',
    cropEdit: null,
  });
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  useHistoryStore.getState().clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
});

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(3);
}

function clip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
}

/** A collapsed section's header summary. */
function meta(id: string): string {
  const header = mounted?.container.querySelector(`[data-chroma-section="${id}"] button[aria-expanded]`);
  return header?.querySelector('span:nth-of-type(2)')?.textContent ?? '';
}

function field(label: string): HTMLInputElement {
  const f = fieldByLabel(mounted?.container, label) ?? mounted?.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!f) throw new Error(`no field ${label}`);
  return f as HTMLInputElement;
}

function button(label: string): HTMLButtonElement {
  const b = mounted?.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!b) throw new Error(`no button ${label}`);
  return b;
}

function click(el: Element) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('collapsed headers say their value (B-366)', () => {
  it('Transform, Compositing, Crop, Dynamic zoom, Highlights, Fade and Keyframes', async () => {
    setup(
      {
        scale: 1.1,
        position_x: -0.05,
        position_y: -0.0944444,
        opacity: 0.8,
        corner_radius: 24,
        crop_left: 0.12,
        crop_right: 0.12,
        fade_in_frames: 12,
        chroma_keyframes: [{ frame: 0, params: { opacity: 0.8 } }],
      },
      false,
    );
    await render();
    // 110 % of a 1 × 1 box at (−0.05, −0.094): centre (0.5, 0.4556) → 102 px up.
    expect(meta('transform')).toMatch(/^110% · 0° · /);
    expect(meta('compositing')).toBe('80% · 24 px corners');
    expect(meta('crop')).toBe('L 12% · R 12%');
    expect(meta('dynamic-zoom')).toBe('Off');
    expect(meta('highlights')).toBe('None');
    expect(meta('fade')).toBe('In 0.50 s · Out none');
    expect(meta('keyframes')).toBe('1 on this clip');
  });

  it('a plain clip reads centred, square corners, no crop', async () => {
    setup({}, false);
    await render();
    expect(meta('transform')).toBe('100% · 0° · centred');
    expect(meta('compositing')).toBe('100% · square corners');
    expect(meta('crop')).toBe('None');
    expect(meta('fade')).toBe('In none · Out none');
    expect(meta('keyframes')).toBe('None');
  });

  it('the Audio tab: Level, Fades and Ducking summaries', async () => {
    setup({ volume: 0.7079458, pan: -0.4, fade_out_frames: 24 }, false);
    useEditorTimelineStore.setState({ inspectorTab: 'audio' });
    await render();
    expect(meta('audio')).toBe('−3.0 dB · L 40');
    const rows = [...(mounted?.container.querySelectorAll('[data-chroma-summary-row]') ?? [])];
    expect(rows.map((r) => r.getAttribute('data-chroma-summary-row'))).toEqual(['Fades', 'Ducking']);
    expect(rows[0].textContent).toContain('In none · Out 1.00 s');
    expect(rows[1].textContent).toContain('Off');
    expect(meta('eq')).toBe('Off');
  });
});

describe('units at the edge (D-443)', () => {
  it('Position reads px from the centre; a Scale edit keeps the centre', async () => {
    setup();
    await render();
    expect(field('Position X').value).toBe('0');
    expect(field('Position Y').value).toBe('0');
    typeNumber(field('Scale'), 50);
    await waitFrames(2);
    expect(clip().scale).toBe(0.5);
    // Top-left moved by a quarter so the centre stayed put …
    expect(clip().position_x).toBeCloseTo(0.25, 8);
    expect(clip().position_y).toBeCloseTo(0.25, 8);
    // … so the readout still says centred, and one undo step did it.
    expect(field('Position X').value).toBe('0');
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });

  it('typing a Position in px writes the stored fraction', async () => {
    setup();
    await render();
    typeNumber(field('Position X'), 192);
    await waitFrames(2);
    expect(clip().position_x).toBeCloseTo(0.1, 8);
    typeNumber(field('Position Y'), -54);
    await waitFrames(2);
    expect(clip().position_y).toBeCloseTo(-0.05, 8);
  });

  it('fades read and write seconds, with the curve in plain words on the same row', async () => {
    setup({ fade_in_frames: 12 });
    await render();
    expect(field('Fade in').value).toBe('0.50');
    typeNumber(field('Fade in'), 1);
    await waitFrames(2);
    expect(clip().fade_in_frames).toBe(24);
    const curve = mounted?.container.querySelector('[aria-label="Fade in curve"]');
    expect(curve?.textContent).toContain('Even');
  });
});

describe('Crop (D-443)', () => {
  it('one L · R · T · B row; an edit keeps the picture in place, one undo step', async () => {
    setup();
    await render();
    const row = mounted?.container.querySelector('[data-chroma-crop-row]');
    expect([...(row?.querySelectorAll('input') ?? [])].map((i) => i.getAttribute('aria-label'))).toEqual([
      'Crop left',
      'Crop right',
      'Crop top',
      'Crop bottom',
    ]);
    typeNumber(field('Crop left'), 25);
    await waitFrames(2);
    expect(clip().crop_left).toBe(0.25);
    expect(clip().scale).toBeCloseTo(0.75, 8);
    expect(clip().position_x).toBeCloseTo(0.25, 8);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(meta('crop')).toBe('L 25%');
  });

  it('the header button arms the viewer’s crop mode and disarms it', async () => {
    setup();
    await render();
    const toggle = button('Crop in the viewer');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().cropEdit).toEqual({ clipId: CLIP_ID });
    expect(button('Crop in the viewer').getAttribute('aria-pressed')).toBe('true');
    click(button('Crop in the viewer'));
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().cropEdit).toBeNull();
  });

  it('Reset Crop un-crops back to the original placement', async () => {
    setup();
    await render();
    typeNumber(field('Crop top'), 20);
    await waitFrames(2);
    click(button('Reset Crop'));
    await waitFrames(2);
    expect(clip().crop_top).toBe(0);
    expect(clip().scale).toBeCloseTo(1, 8);
    expect(clip().position_y).toBeCloseTo(0, 8);
  });
});

describe('the rest of the Video tab', () => {
  it('Keyframes ‹ › walk every key of any property', async () => {
    setup({
      chroma_keyframes: [
        { frame: 10, params: { opacity: 1 } },
        { frame: 40, params: { scale: 1 } },
      ],
    });
    await render();
    expect(button('Previous keyframe').disabled).toBe(true);
    click(button('Next keyframe'));
    await waitFrames(2);
    expect(useEditorTimelineStore.getState().playhead).toBe(10);
    click(button('Next keyframe'));
    await waitFrames(2);
    expect(useEditorTimelineStore.getState().playhead).toBe(40);
    expect(button('Next keyframe').disabled).toBe(true);
    click(button('Previous keyframe'));
    await waitFrames(2);
    expect(useEditorTimelineStore.getState().playhead).toBe(10);
  });

  it('Dynamic zoom shows its Start and End boxes; no description paragraph', async () => {
    setup();
    await render();
    const preview = mounted?.container.querySelector('[data-chroma-dz-preview]');
    expect(preview?.querySelector('[data-chroma-dz-box="start"]')?.textContent).toBe('Start');
    expect(preview?.querySelector('[data-chroma-dz-box="end"]')?.textContent).toBe('End');
    expect(mounted?.container.querySelector('[data-dynamic-zoom-toggle]')?.textContent).toContain('Edit boxes in the viewer');
  });

  it('no explanatory paragraph is left on the Video tab (revision 2)', async () => {
    setup();
    await render();
    const video = mounted?.container.querySelector('[role="tabpanel"]:not([inert])');
    expect(video?.querySelectorAll('p')).toHaveLength(0);
  });

  it('the Audio tab’s Fades row opens the Video tab’s Fade section', async () => {
    setup({}, false);
    useEditorTimelineStore.setState({ inspectorTab: 'audio' });
    await render();
    click(mounted?.container.querySelector('[data-chroma-summary-row="Fades"]') as Element);
    await waitFrames(2);
    expect(useEditorTimelineStore.getState().inspectorTab).toBe('video');
    expect(useEditorTimelineStore.getState().inspectorSections.fade).toBe(true);
    expect(tabByLabel(mounted?.container, 'Video')?.hasAttribute('data-active')).toBe(true);
  });
});
