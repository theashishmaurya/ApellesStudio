// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM regression coverage for B-236: a gap cut out of
 * a clip by a manual split, on a sync-locked timeline, must stay selected and
 * say why it cannot be closed, instead of the Close action silently doing
 * nothing and dropping the selection.
 *
 * **What it proves.** The real `TimelinePane` mounted against the real store
 * (same harness and geometry as `TimelinePane.marquee.dom.test.tsx`): a click
 * on the empty space of the split-made gap selects it; while another
 * sync-locked track has a clip straddling the gap's end (B-033), the Close Gap
 * button is disabled and the Delete key leaves both the timeline and the gap
 * selection alone; once that track is taken out of sync-lock the same key
 * closes the gap. The pure half (that `gapAt` finds the gap and
 * `checkRemoveGap` refuses it) is `timeline.test.ts`'s own B-236 case.
 *
 * **Limits.** jsdom has no layout engine: the click is dispatched straight on
 * the edit area at coordinates computed from `TimelinePane.tsx`'s own geometry
 * constants (mirrored below, as the marquee test does), so this proves the
 * pane's click → `gapAt` → selection → close path, not real pointer
 * hit-testing on rendered clip boxes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
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

import { useKeymapStore } from '@apelles/keymap';
import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { applyOp, type Timeline } from './timeline';

const FPS = 24;
const ROW_HEIGHT = 52;
const START_LEFT_PX = 32;
const RULER_AND_MARGIN_PX = 32 + 16;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC

/** An overlay clip (track 0) over a longer talking-head clip (track 1), both
 *  sync-locked by default, with the overlay razored at 80 and 140 and the
 *  middle piece lifted — a 60-frame gap at [80,140) made by a manual split.
 *  Track 1's clip straddles the gap's end, so B-033 refuses to close it. */
function buildFixture(): Timeline {
  let t: Timeline = {
    id: 'gap-fixture-tl',
    name: 'gap fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [{ id: 'p', name: 'Overlay', source_path: '/p.mp4', source_start: 0, duration: 200, source_len: 200, start_frame: 0 }],
      },
      {
        kind: 'video',
        clips: [{ id: 'm', name: 'Talking head', source_path: '/m.mp4', source_start: 0, duration: 300, source_len: 300, start_frame: 0 }],
      },
    ],
  };
  t = applyOp(t, { kind: 'split', track: 0, clip: 0, atFrame: 80 });
  t = applyOp(t, { kind: 'split', track: 0, clip: 1, atFrame: 140 });
  return applyOp(t, { kind: 'remove', track: 0, clip: 1 });
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let mounted: MountedComponent | null = null;
let editArea: HTMLElement;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restoreOffsets = stubOffsetMetrics(1200, 600);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/gap-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
  const found = mounted.container.querySelector('[data-bench-id="timeline-edit-area"]');
  if (!found) throw new Error('timeline-edit-area never rendered — fixture/harness setup is broken');
  editArea = found as HTMLElement;
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

function clickAt(frame: number, track: number): void {
  const x = START_LEFT_PX + (frame / FPS) * PX_PER_SEC;
  const y = RULER_AND_MARGIN_PX + track * ROW_HEIGHT + ROW_HEIGHT / 2;
  actSync(() => editArea.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })));
}

function pressDelete(): void {
  actSync(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Delete', key: 'Delete', bubbles: true }));
  });
}

function closeGapButton(): HTMLButtonElement | null {
  return mounted!.container.querySelector('button[aria-label="Close gap"]');
}

describe('B-236 — a split-made gap on a sync-locked timeline', () => {
  it('selects on click, and a refused close keeps the selection and the timeline as they were', async () => {
    clickAt(110, 0);
    await waitFrames();
    expect(useEditorTimelineStore.getState().selectedGap).toEqual({ track: 0, frame: 110 });

    const button = closeGapButton();
    expect(button, 'the Close Gap button should render for a selected gap').not.toBeNull();
    expect(button!.disabled).toBe(true);

    const before = useEditorTimelineStore.getState().timeline;
    pressDelete();
    await waitFrames();
    expect(useEditorTimelineStore.getState().timeline).toBe(before);
    expect(useEditorTimelineStore.getState().selectedGap).toEqual({ track: 0, frame: 110 });
  });

  it('closes once the straddling track is out of sync-lock — the remedy the refusal names', async () => {
    actSync(() =>
      useEditorTimelineStore.getState().applyOp({ kind: 'set_track_sync_locked', track: 1, syncLocked: false }),
    );
    clickAt(110, 0);
    await waitFrames();
    expect(closeGapButton()!.disabled).toBe(false);

    pressDelete();
    await waitFrames();
    const tl = useEditorTimelineStore.getState().timeline!;
    expect(tl.tracks[0].clips.map((c) => c.start_frame)).toEqual([0, 80]);
    expect(tl.tracks[1].clips[0].start_frame).toBe(0);
    expect(useEditorTimelineStore.getState().selectedGap).toBeNull();
  });
});
