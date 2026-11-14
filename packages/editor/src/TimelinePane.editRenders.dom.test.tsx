// @vitest-environment jsdom
/**
 * @apelles/editor — B-377: an edit does NOT re-render the toolbar or an
 * unchanged track header (D-461).
 *
 * The defect: `TimelinePane` subscribed to the whole timeline at its top, so
 * ANY edit re-rendered the toolbar row (a few dozen Base UI tooltips, buttons
 * and popovers) and every track header in the left column — 4–16 ms of React
 * work per edit at 300 clips (D-437 S11, `docs/perf/README.md`). The fix moved
 * both surfaces into their own components with their own narrow subscriptions
 * (`TimelineToolbar`, `TimelineTrackHeaders`), each taking only primitives and
 * a fixed-identity action object, so a pane render cannot reach them.
 *
 * The instrument is the one D-437 S4/S8/S10 established (a correctness test
 * passes on both the fast and the slow implementation, so the property has to
 * be a COUNT). Two of the counters are deliberately NOT memo boundaries, so
 * that they count the same thing in the old implementation as in the new one
 * and the before/after numbers are comparable:
 *   - **Toolbar renders** = calls to `TrimToolbar`, which the toolbar row
 *     renders exactly once, inline in the pane before this fix and inside
 *     `TimelineToolbar` after it.
 *   - **Header-row renders** = calls to `TrackHeader`, by track index, the same
 *     either way.
 *   - `TimelineTrackHeaders` (the list) and `LaneClip` are counted at their
 *     `memo` boundary (the `react` mock, as in
 *     `TimelinePane.laneRenders.dom.test.tsx`).
 * Mounted without StrictMode, which doubles every render in dev.
 *
 * **Measured, before and after** (this file run against the pre-fix
 * `TimelinePane`, a plain trim on a 3-track, 13-clip fixture):
 *   - header rows: **3 of 3 re-render per edit -> 0 of 3**. Two edits scored 6
 *     header renders before, 0 after. A mute toggle scored 3 before, 1 after
 *     (only the muted track's own row).
 *   - the toolbar: **its whole subtree is now skipped at a memo boundary** (0
 *     renders of `TimelineToolbar` on an edit, 1 on a selection change, which
 *     is when its buttons really do change). Before there was no boundary at
 *     all, so React visited the whole toolbar element tree on every edit and
 *     the pane recomputed all six of its gates (`linkCheck`,
 *     `gapCloseCheck`, `selectionIsLinked`, `labels`, `badges`,
 *     `otherTracks`) with it. Note what is NOT part of the saving: the
 *     individual buttons' own bodies were already being skipped before this
 *     fix by the React Compiler (`trimTool` counts 0 per edit in BOTH
 *     shapes), so the toolbar's share of B-377's 4-16 ms is the
 *     reconciliation and the gates, not the buttons.
 *   - clips: 2 -> 2 (the lanes still update, which is what proves the edit
 *     really landed).
 *
 * **Verified to fail on the forbidden implementation:** run against the pre-fix
 * pane, 5 of these 8 fail; handing either child the whole `timeline` (a child
 * that subscribes to it, or a `track` prop on a row) fails it the same way.
 *
 * jsdom: proves the render COUNT, not milliseconds.
 */
import type { FunctionComponent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => ({
  /** `TimelineToolbar` renders, at its `memo` boundary (this fix's shape only). */
  toolbar: 0,
  /** `TrimToolbar` renders — one per toolbar render in EITHER shape, so this is
   *  the before/after-comparable number. The React Compiler re-uses its element
   *  when its own two props are unchanged, so it under-counts a toolbar render
   *  that changed something else; it is exact for the zero case, which is the
   *  property guarded here. */
  trimTool: 0,
  /** `TimelineTrackHeaders` (the list) renders, at its `memo` boundary. */
  headerList: 0,
  /** `TrackHeader` renders, by track index. */
  headerRows: new Map<number, number>(),
  /** `LaneClip` renders, by clip id, at its `memo` boundary. */
  clips: new Map<string, number>(),
}));
vi.mock('./TrimToolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./TrimToolbar')>();
  return {
    ...actual,
    TrimToolbar: (props: Parameters<typeof actual.TrimToolbar>[0]) => {
      counts.trimTool++;
      return actual.TrimToolbar(props);
    },
  };
});
vi.mock('./TrackHeader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./TrackHeader')>();
  return {
    ...actual,
    TrackHeader: (props: Parameters<typeof actual.TrackHeader>[0]) => {
      counts.headerRows.set(props.index, (counts.headerRows.get(props.index) ?? 0) + 1);
      return actual.TrackHeader(props);
    },
  };
});
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  type Props = {
    clip?: { id: string };
    leftPx?: number;
    actions?: unknown;
    trimArmed?: boolean;
  };
  return {
    ...actual,
    memo: ((component: FunctionComponent<Props>, compare?: undefined) =>
      actual.memo(function Counted(props: Props) {
        if (props.clip && props.leftPx !== undefined && props.actions !== undefined) {
          counts.clips.set(props.clip.id, (counts.clips.get(props.clip.id) ?? 0) + 1);
        } else if (props.actions !== undefined && props.trimArmed !== undefined) {
          counts.toolbar++;
        } else if (props.actions !== undefined && Object.keys(props).length === 1) {
          counts.headerList++;
        }
        return component(props);
      }, compare)) as typeof actual.memo,
  };
});

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
import { useTimelineViewStore } from './timelineView';
import { TimelinePane } from './TimelinePane';
import type { Clip, EditOp, Timeline } from './timeline';

const FPS = 24;
/** 1 s clips back to back: v0..v4 on V1, t0..t2 on V2, a0..a4 on A1. */
function fixture(): Timeline {
  const clip = (id: string, i: number): Clip =>
    ({
      id,
      name: id,
      source_path: `/${id}.mp4`,
      source_start: 0,
      duration: 24,
      source_len: 240,
      start_frame: i * 24,
    }) as Clip;
  return {
    id: 'edit-renders',
    name: 'edit renders',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: [0, 1, 2, 3, 4].map((i) => clip(`v${i}`, i)) },
      { kind: 'video', clips: [0, 1, 2].map((i) => clip(`t${i}`, i * 2)), sync_locked: false },
      { kind: 'audio', clips: [0, 1, 2, 3, 4].map((i) => clip(`a${i}`, i)) },
    ],
  } as unknown as Timeline;
}

let restores: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restores = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub()];
  console_ = captureConsole();
  useTimelineViewStore.setState(useTimelineViewStore.getInitialState());
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/edit-renders.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(TimelinePane), { strictMode: false });
  await waitFrames(2);
  reset();
});

afterEach(() => {
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restores.forEach((r) => r());
  actSync(() =>
    useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', playing: false, selection: [] }),
  );
});

function reset() {
  counts.toolbar = 0;
  counts.trimTool = 0;
  counts.headerList = 0;
  counts.headerRows.clear();
  counts.clips.clear();
}

const apply = (op: EditOp) => actSync(() => useEditorTimelineStore.getState().applyOp(op));

describe('B-377 — an edit renders the toolbar and the unchanged headers zero times', () => {
  it('mounted one toolbar, one header list and one row per track', () => {
    expect(mounted!.container.querySelectorAll('[data-chroma-timeline-toolbar]').length).toBe(1);
    expect(mounted!.container.querySelectorAll('[data-testid="timeline-track-header"]').length).toBe(3);
  });

  it('a trim renders the toolbar ZERO times and every track header ZERO times', () => {
    apply({ kind: 'trim_end', track: 0, clip: 2, delta: -6 });
    expect(counts.toolbar).toBe(0);
    expect(counts.trimTool).toBe(0);
    expect([...counts.headerRows.entries()]).toEqual([]);
    // The lanes still update: the trimmed clip (and the neighbour whose cut
    // mark changed) re-render — proof the edit really did reach the pane.
    expect([...counts.clips.keys()].sort()).toEqual(['v2', 'v3']);
  });

  it('a move and a ripple trim are the same: no toolbar, no header', () => {
    apply({ kind: 'move', fromTrack: 1, toTrack: 1, clip: 2, startFrame: 120 });
    apply({ kind: 'trim_end', track: 0, clip: 1, delta: -6, ripple: true });
    expect(counts.toolbar).toBe(0);
    expect(counts.trimTool).toBe(0);
    expect([...counts.headerRows.entries()]).toEqual([]);
    expect(counts.clips.size).toBeGreaterThan(0);
  });

  it('the header LIST re-renders on an edit (it owns the tracks) — the rows are the memo boundary', () => {
    apply({ kind: 'trim_end', track: 0, clip: 2, delta: -6 });
    expect(counts.headerList).toBe(1);
    expect([...counts.headerRows.entries()]).toEqual([]);
  });

  it('a selection change renders the toolbar once (Split/Remove change) and no header', () => {
    actSync(() => useEditorTimelineStore.getState().setSelection([{ track: 0, id: 'v1' }]));
    expect(counts.toolbar).toBe(1);
    expect([...counts.headerRows.entries()]).toEqual([]);
  });

  it('a track rename renders every row once — the names list is a prop of each', () => {
    apply({ kind: 'set_track_name', track: 2, name: 'Dialogue' });
    // Every row shows the whole name list (its ducking "duck from" picker), so
    // a rename legitimately reaches all three — a rename, not an edit, and one
    // per rename. The toolbar's "Move to" menu lists the names too, so it is
    // allowed to re-render here as well. The property this file guards is that
    // an EDIT reaches neither.
    expect([...counts.headerRows.entries()].sort()).toEqual([[0, 1], [1, 1], [2, 1]]);
  });

  it('a mute toggle renders only that track’s row, and no clip', () => {
    apply({ kind: 'set_track_gain', track: 2, gain: 0 });
    expect([...counts.headerRows.entries()]).toEqual([[2, 1]]);
    expect(counts.toolbar).toBe(0);
    expect([...counts.clips.entries()]).toEqual([]);
  });

  it('a playhead tick renders none of the three', () => {
    for (let f = 1; f <= 10; f++) actSync(() => useEditorTimelineStore.getState().setPlayhead(f));
    expect(counts.toolbar).toBe(0);
    expect(counts.headerList).toBe(0);
    expect([...counts.headerRows.entries()]).toEqual([]);
  });
});
