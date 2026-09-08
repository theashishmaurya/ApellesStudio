// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for D-236's Inspector Speed section.
 *
 * **Why a DOM test.** `speedRamp.test.ts` proves the remap math and
 * `speedRamp.ffmpeg.test.ts` proves the exported pixels; neither proves the
 * half a human actually touches — that typing a percentage writes a real
 * `set_clip_speed` op, that adding a point at the playhead splits the clip at
 * the frame that is actually on screen, that a new point inherits the speed
 * already in force (so splitting alone retimes nothing), and that the section
 * is not offered on a generated layer with no footage to retime. That path
 * runs through the real `EditorInspectorPanel`, the real `SpeedRampEditor` and
 * the real `timelineStore.applyOp`, so it can only be asserted here.
 *
 * It also pins the GUI/MCP parity CLAUDE.md requires: the control writes the
 * SAME op, over the SAME `Clip.speed_points`, that `editor_set_clip_speed`
 * writes — asserted by reading the stored points back off the store rather
 * than by inspecting the component.
 *
 * Same tier and same honest limits as `ClipInspectorPanel.eq.dom.test.tsx`:
 * jsdom, real components, real store, a stubbed Tauri `invoke`.
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
import { endFrame } from './timeline';
import type { Clip, Timeline } from './timeline';

const CLIP_ID = 'clip-1';

function fixture(over: Partial<Clip> = {}): Timeline {
  const clip: Clip = {
    id: CLIP_ID,
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
    ...over,
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

function setUp(tl: Timeline, playhead = 0) {
  useEditorTimelineStore.setState({
    timeline: tl,
    status: 'ready',
    error: null,
    playhead,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
  });
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  setUp(fixture());
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
});

/** Every segment's percentage field, in render order — found by the aria-label
 *  the section gives each one, so this reads the DOM the way an assistive
 *  technology (and a user) does rather than by a class name free to change. */
function speedFields(): HTMLInputElement[] {
  return [...(mounted?.container.querySelectorAll('input') ?? [])].filter((i) =>
    (i.getAttribute('aria-label') ?? '').startsWith('Speed of the run starting at source frame'),
  ) as HTMLInputElement[];
}

function addPointButton(): HTMLButtonElement | null {
  return (
    ([...(mounted?.container.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Add speed point at playhead',
    ) as HTMLButtonElement | undefined) ?? null
  );
}

function removeButtons(): HTMLButtonElement[] {
  return [...(mounted?.container.querySelectorAll('button') ?? [])].filter((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith('Remove the speed point'),
  ) as HTMLButtonElement[];
}

/** D-241 — the per-run Reverse buttons, in run order. */
function reverseButtons(): HTMLButtonElement[] {
  return [...(mounted?.container.querySelectorAll('button') ?? [])].filter((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith('Reverse the run starting at source frame'),
  ) as HTMLButtonElement[];
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

describe('the Inspector Speed section (D-236)', () => {
  it('shows one 100% run for an un-ramped clip, and opening the panel writes nothing', async () => {
    await render();
    expect(speedFields().map((f) => f.value)).toEqual(['100']);
    // Selecting a clip must never dirty the project.
    expect(currentClip().speed_points).toBeUndefined();
    // Nothing to remove: the head of the clip is where the ramp begins, not a
    // point you can delete.
    expect(removeButtons()).toHaveLength(0);
  });

  it('typing a percentage stores a real flat ramp and retimes the clip', async () => {
    await render();
    type(speedFields()[0], 200);
    // The op wrote the same model an MCP `speed=2` writes: one point at the
    // clip's own in-point.
    expect(currentClip().speed_points).toEqual([{ source_frame: 0, speed: 2 }]);
    // ...and the clip really is half as long on the timeline now.
    expect(endFrame(currentClip(), 24)).toBe(120);
  });

  it('back to 100% clears the ramp entirely rather than storing an identity point', async () => {
    await render();
    type(speedFields()[0], 50);
    expect(currentClip().speed_points).toEqual([{ source_frame: 0, speed: 0.5 }]);
    type(speedFields()[0], 100);
    // `normalizeSpeedPoints` drops a point that changes nothing, and the
    // reducer normalises `[]` to `undefined` — so the clip is byte-identical
    // to one that was never retimed, which is what keeps the flat export path
    // byte-identical too.
    expect(currentClip().speed_points).toBeUndefined();
    expect(endFrame(currentClip(), 24)).toBe(240);
  });

  it('adds a point at the playhead, inheriting the speed already in force', async () => {
    setUp(fixture(), 96); // 96 timeline frames in, and the clip is 1x, so source 96
    await render();
    click(addPointButton() as HTMLElement);
    // Splitting alone must not retime anything — the new point carries the
    // speed that was already playing there (Resolve's own behaviour), so the
    // clip's length is unchanged until the new run's percentage is edited.
    expect(currentClip().speed_points).toEqual([{ source_frame: 96, speed: 1 }]);
    expect(endFrame(currentClip(), 24)).toBe(240);

    // Two runs now, and editing the second one retimes only its own frames:
    // 96 source frames at 1x + 144 at 2x = 96 + 72 = 168.
    expect(speedFields()).toHaveLength(2);
    type(speedFields()[1], 200);
    expect(endFrame(currentClip(), 24)).toBe(168);
  });

  it('a speed point can be removed, and the head run cannot', async () => {
    setUp(fixture({ speed_points: [{ source_frame: 96, speed: 2 }] }));
    await render();
    expect(speedFields()).toHaveLength(2);
    // Exactly one Remove — for the real point, not for the clip's own head.
    expect(removeButtons()).toHaveLength(1);
    click(removeButtons()[0]);
    expect(currentClip().speed_points).toBeUndefined();
    expect(speedFields()).toHaveLength(1);
  });

  it('is not offered on a generated layer, which has no footage to retime', async () => {
    setUp(
      fixture({
        text: { content: 'Title' } as Clip['text'],
      }),
    );
    await render();
    expect(speedFields()).toHaveLength(0);
    expect(addPointButton()).toBeNull();
  });

  it('is read-only on a locked track, like every other per-clip control', async () => {
    const tl = fixture();
    (tl.tracks[0] as { locked?: boolean }).locked = true;
    setUp(tl, 96);
    await render();
    expect(speedFields()[0].disabled).toBe(true);
    expect(addPointButton()?.disabled).toBe(true);
    expect(reverseButtons()[0].disabled).toBe(true);
    // ...and the reducer refuses the write even if the control were driven.
    type(speedFields()[0], 200);
    expect(currentClip().speed_points).toBeUndefined();
  });
});

describe('the Inspector Speed section — reverse (D-241)', () => {
  it('the Reverse button flips the run\'s sign and stores a real negative speed', async () => {
    await render();
    expect(reverseButtons()).toHaveLength(1);
    expect(reverseButtons()[0].textContent).toBe('Reverse');
    click(reverseButtons()[0]);
    // The same model an MCP `speed=-1` writes — one point at the in-point.
    expect(currentClip().speed_points).toEqual([{ source_frame: 0, speed: -1 }]);
    // Reversing changes DIRECTION, not LENGTH: the clip still ends where it did,
    // which is what stops a sign flip from disturbing a neighbour.
    expect(endFrame(currentClip(), 24)).toBe(240);
    // ...and the control now reads back as reversed, both as a label and as a
    // real pressed state for a screen reader.
    expect(reverseButtons()[0].textContent).toBe('Reversed');
    expect(reverseButtons()[0].getAttribute('aria-pressed')).toBe('true');
    expect(speedFields()[0].value).toBe('-100');
  });

  it('reversing is an exact round trip — the magnitude survives the flip', async () => {
    await render();
    type(speedFields()[0], 37);
    click(reverseButtons()[0]);
    expect(currentClip().speed_points).toEqual([{ source_frame: 0, speed: -0.37 }]);
    click(reverseButtons()[0]);
    // Back to exactly 0.37 — which typing a minus sign into the field could not
    // give you, since it loses the digits you had.
    expect(currentClip().speed_points).toEqual([{ source_frame: 0, speed: 0.37 }]);
  });

  it('typing a negative percentage works too — the way both Resolve and Premiere spell it', async () => {
    await render();
    type(speedFields()[0], -200);
    expect(currentClip().speed_points).toEqual([{ source_frame: 0, speed: -2 }]);
    // Backwards at double speed still occupies half the timeline, exactly as
    // forwards at double speed does.
    expect(endFrame(currentClip(), 24)).toBe(120);
  });

  it('reverse is PER RUN — a ramp can mix directions', async () => {
    setUp(fixture({ speed_points: [{ source_frame: 96, speed: 2 }] }));
    await render();
    expect(reverseButtons()).toHaveLength(2);
    // Reverse only the second run; the first is untouched.
    click(reverseButtons()[1]);
    expect(currentClip().speed_points).toEqual([{ source_frame: 96, speed: -2 }]);
    expect(reverseButtons()[0].textContent).toBe('Reverse');
    expect(reverseButtons()[1].textContent).toBe('Reversed');
    // 96 source frames forwards at 1x + 144 backwards at 2x = 96 + 72 = 168,
    // exactly what the same ramp forwards would occupy.
    expect(endFrame(currentClip(), 24)).toBe(168);
  });
});
