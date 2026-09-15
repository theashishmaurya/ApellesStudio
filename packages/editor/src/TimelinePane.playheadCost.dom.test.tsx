// @vitest-environment jsdom
/**
 * @apelles/editor — what a playhead tick costs `TimelinePane` (D-325, B-146).
 *
 * **Why this file exists.** B-146's original D-290 fix found "eight
 * components subscribe to `playhead` and every one re-renders on every
 * displayed frame" and deliberately left fixing that as roadmap item 25 — it
 * measured ~2ms for the Inspector, small enough to defer. This investigation
 * (prompted by a live report that a heavily recut 96-clip timeline plays at
 * 4.3fps against a 1-clip project's 10.5fps, filed as B-146's continuation)
 * found `TimelinePane.tsx` was ALSO one of those eight — and unlike the
 * Inspector, it is a ~4500-line component that (a) fails its own React
 * Compiler coverage test (B-184, open — the whole file loses auto-
 * memoization) and (b) walks every clip on every track to build its render
 * output. Read via `useEditorTimelineStore((s) => s.playhead)`, that selector
 * forced this entire component to re-render — un-memoized — on every single
 * displayed frame during playback, and the cost scaled with clip count:
 * `main` measured 3.75ms/commit at 2 clips, 15.0ms/commit at 96, 27.1ms/
 * commit at 200 (`git show main:packages/editor/src/TimelinePane.tsx` before
 * this fix), TWO commits per tick (one from the reactive selector, a second
 * from the effect's own imperative `editorRef.current.setTime()` call into
 * `@xzdarcy/react-timeline-editor`'s internal state) — i.e. up to ~30-55ms of
 * pure React overhead per displayed frame on a real recut project, paid on
 * top of D-290's own ~21.5ms webview floor.
 *
 * **The fix, and its real limit.** Nothing in this file ever needed a
 * REACTIVE `playhead` — only an imperative `setTime` call (the effect below)
 * and a handful of click handlers (split/marker/zoom-anchor) that only need
 * the value at the moment they fire, exactly the `useEditorTimelineStore
 * .getState()` pattern this file already uses elsewhere (`locateClip`).
 * Reading it via a direct, non-rendering store subscription instead removes
 * the REDUNDANT top-level re-render, which is what this file actually
 * verifies: one playhead-only store update now costs exactly one commit, not
 * two. It does NOT eliminate the remaining per-commit cost — that lives
 * inside `@xzdarcy/react-timeline-editor`'s own internal re-render of its
 * virtualized row/cursor state (a real, legitimate O(visible-clips) cost of a
 * third-party library actually redrawing more rows), and still scales with
 * clip count. That remaining cost is disclosed, not fixed, here — see the
 * investigation's own D-325 for the measured before/after and what is left.
 *
 * **What is asserted.** Commit COUNT from a real `React.Profiler` (the same
 * "not a vague ms guess, a real number with a right answer" instrument
 * `PreviewPane.playbackCost.dom.test.tsx`/D-290 uses): a run of N playhead
 * ticks must cost exactly N commits, at every clip count tried — the
 * regression this fix actually is. Per-tick durations are printed, not
 * asserted flat, because asserting a fixed per-clip-count ceiling would be
 * asserting a property of a third-party library's internals this fix does
 * not (and should not try to) change.
 *
 * **Tier and its honest limits.** jsdom — same caveats as every sibling
 * `*.dom.test.tsx` in this package: no real layout, no real paint, no real
 * IPC. This proves the redundant commit is gone; it cannot say how many real
 * milliseconds that is worth in the actual running app, which is what
 * `debug_frame_timing` against a real project is for.
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

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import type { Timeline, Clip } from './timeline';

const FPS = 24;
const AREA = { left: 0, top: 0, width: 1200, height: 600 };
const TICKS = 30;

function clip(i: number): Clip {
  return {
    id: `clip-${i}`,
    name: `clip number ${i} with a reasonably long name`,
    source_path: `/some/reasonably/long/media/path/clip_${i}.mov`,
    source_start: 0,
    duration: 48,
    source_len: 48,
    start_frame: i * 48,
  } as Clip;
}

function fixture(clipCount: number): Timeline {
  return {
    id: 'perf-fixture-tl',
    name: 'perf fixture',
    rate: { num: FPS, den: 1 },
    tracks: [{ kind: 'video', clips: Array.from({ length: clipCount }, (_, i) => clip(i)) }],
    markers: [],
  };
}

function stubEditAreaRect(): void {
  const el = document.querySelector<HTMLElement>('[data-bench-id="timeline-edit-area"]');
  if (!el) return;
  el.getBoundingClientRect = () =>
    ({
      ...AREA,
      x: AREA.left,
      y: AREA.top,
      right: AREA.left + AREA.width,
      bottom: AREA.top + AREA.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;
let commits: number[] = [];

async function mountPane(clipCount: number): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(clipCount),
      openProjectKey: '/projects/perf-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  commits = [];
  const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    commits.push(actualDuration);
  };
  ui = mount(
    React.createElement(React.Profiler, { id: 'timeline-pane', onRender }, React.createElement(TimelinePane)),
    { strictMode: false },
  );
  await waitFrames(2);
  stubEditAreaRect();
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(AREA.width, AREA.height);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
});

afterEach(() => {
  console_.restore();
  ui?.unmount();
  ui = null;
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
});

describe('D-325 — a playhead-only update commits TimelinePane once, not twice', () => {
  for (const clipCount of [2, 96, 200]) {
    it(`clip_count=${clipCount}: ${TICKS} ticks cost exactly ${TICKS} commits`, async () => {
      await mountPane(clipCount);
      commits.length = 0; // drop mount-time commits — measure steady-state ticks only

      for (let i = 1; i <= TICKS; i++) {
        actSync(() => useEditorTimelineStore.setState({ playhead: i }));
      }

      // The regression this guards: before D-325, a reactive `playhead`
      // selector made this component re-render on top of the SAME effect's
      // own imperative `editorRef.current.setTime()` call — two commits for
      // one playhead update. Exactly one commit per tick is the fixed
      // behaviour; two (or more) is the bug back.
      expect(commits.length).toBe(TICKS);

      const total = commits.reduce((a, b) => a + b, 0);
      // eslint-disable-next-line no-console
      console.log(
        `clip_count=${clipCount}: ${commits.length} commits, ${total.toFixed(3)}ms total, ` +
          `${(total / commits.length).toFixed(4)}ms/commit`,
      );
    }, 15000);
  }
});
