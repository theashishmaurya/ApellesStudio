// @vitest-environment jsdom
/**
 * @chroma/editor — B-113: a crop value is readable, and the spinner arrows are
 * not sitting on top of it.
 *
 * **The defect.** The owner, working a real project, screenshotted the Crop
 * section reading `0.0` with the up/down arrows drawn over the missing digits;
 * the stored value was `0.052212` (what an on-canvas crop drag writes). Two
 * causes, both real, both fixed: the field was `w-16` with `px-3` and NO space
 * reserved for WebKit's `::-webkit-inner-spin-button` (which is painted inside
 * the right edge without taking layout space, so a `text-right` value runs
 * underneath it), and the raw float was rendered at full precision, which no
 * field this narrow can show.
 *
 * **What this test can and cannot prove — stated rather than implied.** jsdom
 * has no layout engine: every `getBoundingClientRect()` here is zeros, so a
 * literal "these two boxes overlap" assertion is not available and a test
 * claiming to make one would be measuring nothing. What IS real and is
 * asserted: the value string the panel actually renders for a real crop value,
 * against the field's own declared geometry (`numericField.ts`, whose px
 * constants are the rendered Tailwind utilities' own values), including the
 * strip `@chroma/ui`'s Input reserves for the spinner. A value that fits that
 * budget cannot be under the arrows; a value that does not, is — which is
 * exactly what the pre-fix case below still demonstrates. The final visual
 * confirmation is the owner's own, against the running app.
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
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
import { NUMBER_INPUT_SPINNER_RESERVE } from '@chroma/ui';
import {
  NUM_FIELD,
  numericFieldCapacityChars,
  numericFieldFits,
  numericFieldTextWidthPx,
} from './numericField';
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
  const labels = [...(mounted?.container.querySelectorAll('label') ?? [])];
  const hit = labels.find((l) => l.querySelector('span')?.textContent === label);
  const input = hit?.querySelector('input');
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input as HTMLInputElement;
}

function currentClip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
}

describe('the Inspector’s numeric field clears its own spinner (B-113)', () => {
  it('renders a real dragged crop value short enough to fit clear of the arrows', async () => {
    await render();
    const shown = field('Left').value;

    // The regression itself: the raw stored value could never have fitted.
    expect(numericFieldFits(String(REAL_CROP_VALUE))).toBe(false);
    // What is on screen now does — every character of it, inside the width
    // left over once the spinner's strip is taken out.
    expect(
      numericFieldFits(shown),
      `"${shown}" is ${shown.length} chars; the field fits ${numericFieldCapacityChars()} ` +
        `(${numericFieldTextWidthPx()}px at ${NUM_FIELD.charPx}px/char)`,
    ).toBe(true);
    // …and it is still the same number, to the precision the field claims.
    expect(Number(shown)).toBeCloseTo(REAL_CROP_VALUE, 3);
  });

  it('reserves the spinner’s strip on the rendered element, not just in theory', async () => {
    await render();
    const input = field('Left');
    // The reserve comes from `@chroma/ui`'s Input for every `type="number"`,
    // which is where the defect actually lived — one class, applied once,
    // rather than per call site.
    expect(input.type).toBe('number');
    expect(input.className.split(/\s+/)).toContain(NUMBER_INPUT_SPINNER_RESERVE.className);
    // The field cannot be squeezed narrower than the width that budget was
    // computed against, however narrow the Inspector is dragged.
    expect(input.className.split(/\s+/)).toContain('shrink-0');
    expect(input.className.split(/\s+/)).toContain('w-20');
    // Nothing in the merge took the reserve back off the right side. The
    // shadcn base still carries `px-3`, and that is fine rather than a
    // conflict: Tailwind emits the per-side utilities AFTER the axis ones, so
    // `pl-2`/`pr-5` win the cascade over it. What would break the reserve is a
    // SECOND `pr-*` or `pl-*`, so that is what is asserted.
    expect(input.className.match(/\bpr-[\w.[\]-]+/g)).toEqual([NUMBER_INPUT_SPINNER_RESERVE.className]);
    expect(input.className.match(/\bpl-[\w.[\]-]+/g)).toEqual(['pl-2']);
  });

  it('every numeric row on the panel fits, not only the crop ones', async () => {
    await render();
    // Position X carries a dragged full-precision value in this fixture too,
    // and the transform rows looked fine in the owner's screenshot only
    // because their values happened to be short that day.
    for (const label of ['Opacity', 'Position X', 'Position Y', 'Scale', 'Rotation', 'Left', 'Right', 'Top', 'Bottom']) {
      const shown = field(label).value;
      expect(numericFieldFits(shown), `${label} shows "${shown}"`).toBe(true);
    }
  });

  it('focusing the field shows the exact stored value back — nothing is lost', async () => {
    await render();
    const input = field('Left');
    expect(input.value).toBe('0.052');

    // A real focus, not a synthesised event: React delegates `onFocus` off
    // `focusin`, which only `HTMLElement.focus()` actually raises.
    actSync(() => input.focus());
    await waitFrames(1);
    // The rounding is a DISPLAY rounding: the moment the user is in the field,
    // the number they can edit is the real one, so a spinner step or an
    // arrow-key nudge starts from the stored value, not from a rounded copy.
    expect(input.value).toBe(String(REAL_CROP_VALUE));

    actSync(() => input.blur());
    await waitFrames(1);
    expect(input.value).toBe('0.052');
    // …and the clip never changed underneath any of that.
    expect(currentClip().crop_left).toBe(REAL_CROP_VALUE);
  });

  it('the tooltip carries the exact value whenever the display is rounded', async () => {
    await render();
    expect(field('Left').getAttribute('title')).toBe(`Left: ${REAL_CROP_VALUE}`);
    // …and says nothing at all when there is nothing to add.
    expect(field('Opacity').getAttribute('title')).toBeNull();
  });

  it('typing still writes full precision — the rounding is display-only', async () => {
    await render();
    const input = field('Left');
    actSync(() => input.focus());
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    actSync(() => {
      setter?.call(input, '0.123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFrames(1);
    expect(currentClip().crop_left).toBe(0.123456);
  });
});
