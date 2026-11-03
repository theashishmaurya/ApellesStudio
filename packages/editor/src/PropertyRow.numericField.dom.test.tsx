// @vitest-environment jsdom
/**
 * @apelles/editor — the Inspector's numeric field on a real panel (B-113 →
 * D-432 P4).
 *
 * **History.** B-113: a crop value showed `0.0` with native spinner arrows
 * painted over the digits (stored `0.052212`, an 80 px field). D-253 removed
 * the spinner; D-432 P4 replaced the native `type="number"` input with
 * `NumberScrubber` (a `role="spinbutton"` text field with no spinner at all).
 * What stays true, and is asserted here: a resting field shows a `step`-derived
 * ROUNDING, focusing it shows the exact stored value, the tooltip carries the
 * exact value, typing writes full precision, and an external write (undo) wins
 * over a pinned draft immediately (B-135).
 *
 * v0.3.0 (D-443) — values now read in display units (crop in %, Position in
 * px from the centre, Opacity in %); the same five properties hold in those
 * units, with the stored fraction untouched.
 *
 * jsdom has no layout engine, so what this file proves is the rendered value
 * STRING and the declared row geometry (92 px label column, 80 px slot), not
 * pixels; the visual proof is `scratch/ui-redesign-p4/`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  actSync,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

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
import { INSPECTOR_ROW } from '@apelles/ui';
import { fieldByLabel } from './testUtils/inspectorDom';
import { typeNumber } from './testUtils/numberField';
import type { Clip, Timeline } from './timeline';

const CLIP_ID = 'clip-1';
/** The owner's own value, off their own project — an on-canvas crop drag
 *  stores the full float, which is the whole reason this defect existed. */
const REAL_CROP_VALUE = 0.052212;

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
    crop_left: REAL_CROP_VALUE,
    crop_top: 0.1234567,
    position_x: -0.523212,
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

beforeEach(() => {
  // every Inspector section starts collapsed; these suites query inside them
  openAllInspectorSections(useEditorTimelineStore);
  restoreResizeObserver = installResizeObserverStub();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    inspectorTab: 'video',
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
});

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

/** The number field of the row with this label, found the way a human finds
 *  it: by the label text beside it. */
function field(label: string): HTMLInputElement {
  const input = fieldByLabel(mounted?.container, label);
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input;
}

function currentClip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
}

describe('the Inspector’s numeric field (B-113 → D-432)', () => {
  it('rests on a rounded value of a real dragged crop, short enough to read', async () => {
    await render();
    const shown = field('Crop left').value;
    expect(shown).toBe('5');
    expect(Number(shown)).not.toBe(REAL_CROP_VALUE * 100);
    expect(field('Crop top').value).toBe('12');
    // −0.523212 of a 1920 px frame, measured from the centre of a 1 × 1 box.
    expect(field('Position X').value).toBe('-1005');
  });

  it('is a spinbutton with no native number input behind it (nothing to paint spinner arrows)', async () => {
    await render();
    const input = field('Crop left');
    expect(input.getAttribute('role')).toBe('spinbutton');
    expect(input.type).toBe('text');
    expect(input.getAttribute('aria-valuenow')).toBe('5.2212');
    expect(input.getAttribute('aria-label')).toBe('Crop left');
  });

  it('has the declared row geometry: a 92 px label column and an 80 px keyframe slot', async () => {
    await render();
    const row = field('Position X').closest('[data-slot="inspector-row"]') as HTMLElement;
    expect(row.className).toContain(`grid-cols-[${INSPECTOR_ROW.LABEL_PX}px_minmax(0,1fr)_${INSPECTOR_ROW.SLOT_PX}px]`);
    expect(row.querySelector('[data-slot="inspector-slot"]')).toBeTruthy();
  });

  it('focusing the field shows the exact stored value back — nothing is lost', async () => {
    await render();
    const input = field('Crop left');
    expect(input.value).toBe('5');

    actSync(() => input.focus());
    await waitFrames(1);
    // The rounding is a DISPLAY rounding: the moment the user is in the field,
    // the number they can edit is the real one (in %).
    expect(input.value).toBe('5.2212');

    actSync(() => input.blur());
    await waitFrames(1);
    expect(input.value).toBe('5');
    // …and the clip never changed underneath any of that.
    expect(currentClip().crop_left).toBe(REAL_CROP_VALUE);
  });

  it('the tooltip carries the exact value', async () => {
    await render();
    const wrapper = field('Crop left').closest('[data-slot="number-scrubber"]');
    expect(wrapper?.getAttribute('title')).toBe('Crop left: 5.2212 % of the source');
  });

  it('typing still writes full precision — the rounding is display-only', async () => {
    await render();
    typeNumber(field('Crop left'), '12.3456');
    await waitFrames(1);
    expect(currentClip().crop_left).toBe(0.123456);
  });

  it('accepts arithmetic against the shown value (+10 on 5.2212 %)', async () => {
    await render();
    typeNumber(field('Crop left'), '+10');
    await waitFrames(1);
    expect(currentClip().crop_left).toBeCloseTo(0.152212, 6);
  });
});

describe('B-135: an external value change reaches a focused field immediately, not on blur', () => {
  it('undo (or any other external write) overrides a typed draft while still focused', async () => {
    await render();
    const input = field('Opacity');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    // Type without committing: this leaves a draft behind.
    actSync(() => input.focus());
    actSync(() => {
      setter?.call(input, '35');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFrames(1);
    expect(input.value).toBe('35');

    // An external write to the SAME property — exactly what undo does.
    actSync(() => {
      useEditorTimelineStore.setState((s) => {
        const tl = s.timeline;
        if (!tl) return s;
        const clip = tl.tracks[0].clips[0] as unknown as { opacity?: number };
        clip.opacity = 0.5;
        return { ...s, timeline: { ...tl } };
      });
    });
    await waitFrames(1);
    expect(input.value).toBe('50');
  });
});
