// @vitest-environment jsdom
/**
 * @apelles/editor — the clip Inspector's P4 structure (D-432): full labels in
 * a fixed label column, a fixed keyframe slot, collapsible sections with
 * remembered state, a linked Width / Height pair, one undo step per scrub.
 *
 * jsdom has no layout engine, so "no truncation at the default width" is
 * asserted as its two declarable halves: every label fits the 92 px column's
 * character budget at the 11 px label size, and the column/slot are the
 * declared grid. The rendered proof is `scratch/ui-redesign-p4/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  nextFrame,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';
import { fieldByLabel, sectionTitles } from './testUtils/inspectorDom';
import { typeNumber } from './testUtils/numberField';

/** The backend's copy, for the one path that re-reads it: undo/redo. */
const backend = vi.hoisted(() => ({ timeline: null as unknown }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_get') return backend.timeline;
    if (cmd === 'chroma_timeline_set') return null;
    if (cmd === 'chroma_timeline_clip_geometry') {
      return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
    }
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
const { useHistoryStore } = await import('@apelles/history');
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
  } as unknown as Clip;
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [clip] }],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreCapture: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  restoreCapture = installPointerCaptureStub();
  useHistoryStore.getState().clear();
  backend.timeline = fixture();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    inspectorTab: 'video',
    inspectorSections: {},
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreCapture?.();
  restoreCapture = null;
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

function rows(): HTMLElement[] {
  return [...(mounted?.container.querySelectorAll('[data-slot="inspector-row"]') ?? [])] as HTMLElement[];
}

function labelOf(row: HTMLElement): string {
  return row.querySelector('[data-slot="inspector-label"]')?.textContent ?? '';
}

function sectionButton(id: string): HTMLButtonElement {
  const btn = mounted?.container.querySelector(`[data-chroma-section="${id}"] button[aria-expanded]`);
  if (!btn) throw new Error(`no section ${id}`);
  return btn as HTMLButtonElement;
}

describe('rows: full labels in a fixed label column', () => {
  it('shows the full property names the screenshots truncated', async () => {
    await render();
    const labels = rows().map(labelOf);
    for (const want of [
      'Position X',
      'Position Y',
      'Scale',
      'Rotation',
      'Corner radius',
      'Opacity',
      'Crop left',
      'Crop right',
      'Crop top',
      'Crop bottom',
    ]) {
      expect(labels).toContain(want);
    }
  });

  it('every label fits the 92 px column at the 11 px label size, and carries its full text as a tooltip', async () => {
    await render();
    // 11 px sans averages ~6 px a character; 92 px therefore holds ~15.
    const budget = Math.floor(92 / 6);
    for (const row of rows()) {
      const label = labelOf(row);
      expect(label.length, `"${label}" would truncate`).toBeLessThanOrEqual(budget);
      expect(row.querySelector('[data-slot="inspector-label"]')?.getAttribute('title')).toBeTruthy();
    }
  });
});

describe('the keyframe slot does not shift', () => {
  it('every keyframeable row owns the same fixed slot before and after it is animated', async () => {
    await render();
    const row = () => rows().find((r) => labelOf(r) === 'Scale') as HTMLElement;
    const before = row().className;
    const slotBefore = row().querySelector('[data-slot="inspector-slot"]');
    expect(slotBefore).toBeTruthy();

    const toggle = row().querySelector('[aria-label="Toggle Scale keyframes"]') as HTMLElement;
    actSync(() => toggle.click());
    await waitFrames(2);

    // The grid (label / control / slot) is unchanged by the property becoming
    // animated; the nav arrows were always laid out (`invisible`), and the
    // curve button joins the same fixed slot instead of widening the row.
    expect(row().className).toBe(before);
    expect(row().querySelector('[data-slot="inspector-slot"]')).toBeTruthy();
    const prev = row().querySelector('[aria-label="Previous Scale keyframe"]') as HTMLElement;
    expect(prev.className).not.toContain('hidden');
  });

  it('a static row hides its diamond and reset with opacity, never by removing them', async () => {
    await render();
    const row = rows().find((r) => labelOf(r) === 'Rotation') as HTMLElement;
    for (const name of ['Toggle Rotation keyframes', 'Reset Rotation']) {
      const el = row.querySelector(`[aria-label="${name}"]`) as HTMLElement;
      expect(el, name).toBeTruthy();
      expect(el.className).toContain('opacity-0');
      expect(el.className).toContain('group-hover:opacity-100');
      expect(el.className).toContain('group-focus-within:opacity-100');
    }
  });
});

describe('collapsible sections', () => {
  it('collapse on their header, unmount their rows, and remember it in the store', async () => {
    await render();
    expect(sectionTitles(mounted?.container)).toContain('Crop');
    expect(sectionButton('crop').getAttribute('aria-expanded')).toBe('true');
    expect(rows().map(labelOf)).toContain('Crop left');

    actSync(() => sectionButton('crop').click());
    await waitFrames(2);
    expect(sectionButton('crop').getAttribute('aria-expanded')).toBe('false');
    expect(rows().map(labelOf)).not.toContain('Crop left');
    // Lazy: a closed section mounts no body at all.
    expect(mounted?.container.querySelector('#inspector-section-crop')).toBeNull();
    expect(useEditorTimelineStore.getState().inspectorSections.crop).toBe(false);

    actSync(() => sectionButton('crop').click());
    await waitFrames(2);
    expect(rows().map(labelOf)).toContain('Crop left');
    expect(useEditorTimelineStore.getState().inspectorSections.crop).toBe(true);
  });

  it('survives a remount (the panel remounts per selection)', async () => {
    await render();
    actSync(() => sectionButton('transform').click());
    await waitFrames(2);
    mounted?.unmount();
    await render();
    expect(sectionButton('transform').getAttribute('aria-expanded')).toBe('false');
  });

  it('starts Dynamic zoom and Highlights closed and the rest open', async () => {
    await render();
    expect(sectionButton('dynamic-zoom').getAttribute('aria-expanded')).toBe('false');
    expect(sectionButton('highlights').getAttribute('aria-expanded')).toBe('false');
    for (const id of ['transform', 'compositing', 'crop', 'speed', 'fade', 'keyframes']) {
      expect(sectionButton(id).getAttribute('aria-expanded'), id).toBe('true');
    }
  });
});

describe('linked Width / Height', () => {
  const pair = () => rows().find((r) => labelOf(r) === 'Size') as HTMLElement;
  const link = () => pair().querySelector('[aria-label="Link width and height"]') as HTMLElement;

  it('is one Size row with a real link toggle between W and H, linked by default', async () => {
    await render();
    const inputs = [...pair().querySelectorAll('input')] as HTMLInputElement[];
    expect(inputs.map((i) => i.getAttribute('aria-label'))).toEqual(['Width', 'Height']);
    expect(link().getAttribute('aria-pressed')).toBe('true');
    // The toggle sits BETWEEN the two fields.
    const order = [...pair().querySelectorAll('input, button[aria-label="Link width and height"]')].map(
      (e) => e.tagName + (e.getAttribute('aria-label') ?? ''),
    );
    expect(order).toEqual(['INPUTWidth', 'BUTTONLink width and height', 'INPUTHeight']);
  });

  it('linked: editing Width moves Height in the same ratio', async () => {
    await render();
    expect((pair().querySelectorAll('input')[0] as HTMLInputElement).value).toBe('1920');
    typeNumber(pair().querySelectorAll('input')[0] as HTMLInputElement, 960);
    await waitFrames(2);
    expect(clip().box_width).toBeCloseTo(0.5, 6);
    expect(clip().box_height).toBeCloseTo(0.5, 6);
  });

  it('unlinked: editing Width leaves Height alone', async () => {
    await render();
    actSync(() => link().click());
    await waitFrames(1);
    expect(link().getAttribute('aria-pressed')).toBe('false');
    typeNumber(pair().querySelectorAll('input')[0] as HTMLInputElement, 960);
    await waitFrames(2);
    expect(clip().box_width).toBeCloseTo(0.5, 6);
    expect(clip().box_height).toBeCloseTo(1, 6);
  });
});

describe('one undo step per scrub', () => {
  it('a drag across many frames is ONE history entry, and one undo restores the start', async () => {
    await render();
    const input = fieldByLabel(mounted?.container, 'Scale') as HTMLInputElement;
    const wrapper = input.closest('[data-slot="number-scrubber"]') as HTMLElement;
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);

    firePointerEvent(wrapper, 'pointerdown', { x: 100, y: 10 });
    await nextFrame();
    for (let i = 1; i <= 8; i++) {
      firePointerEvent(window, 'pointermove', { x: 100 + i * 5, y: 10 });
      await nextFrame();
    }
    firePointerEvent(window, 'pointerup', { x: 140, y: 10 });
    await nextFrame();

    expect(clip().scale).toBeCloseTo(1.4, 6); // 40 px x 0.01
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);

    actSync(() => {
      useHistoryStore.getState().undo();
    });
    await waitFrames(2);
    expect(clip().scale ?? 1).toBe(1);
  });

  it('a typed value is its own single step', async () => {
    await render();
    typeNumber(fieldByLabel(mounted?.container, 'Rotation') as HTMLInputElement, 15);
    await waitFrames(2);
    expect(clip().rotation).toBe(15);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });
});
