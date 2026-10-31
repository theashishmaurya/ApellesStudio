// @vitest-environment jsdom
/**
 * @apelles/editor — what an edit's release re-renders, at the PANE level
 * (D-437 S4; plan `docs/notes/timeline-lanes.md` §4 "Release, what re-rendered").
 *
 * The lanes' own suite (`lanes/TimelineLanes.dom.test.tsx`) proves `LaneClip`'s
 * memo against props it is handed. This one mounts the real `TimelinePane`
 * against the real store and applies real edit ops, so it also proves the pane's
 * side of the contract: an op that touches one clip leaves every other clip
 * object `===` (`shareUnchanged`, F4), the `actions` object never changes
 * (`useLaneActions`), and nothing else the pane passes down (the cut style, the
 * visible slice, the selection flags) changes for an untouched clip. A pane
 * render on commit is expected; a re-render of an untouched clip is the bug.
 *
 * `LaneClip` renders are counted at its `memo` boundary (the `react` mock):
 * React calls the inner component only when `memo`'s shallow compare says the
 * props changed, so that IS the count. Only `LaneClip` is counted (it is the
 * one memo component taking both `leftPx` and `actions`). Mounted without
 * StrictMode, which doubles every render in dev.
 */
import type { FunctionComponent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renders = vi.hoisted(() => ({ byId: new Map<string, number>() }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  type Props = { clip?: { id: string }; leftPx?: number; actions?: unknown };
  return {
    ...actual,
    memo: ((component: FunctionComponent<Props>, compare?: undefined) =>
      actual.memo(function Counted(props: Props) {
        if (props.clip && props.leftPx !== undefined && props.actions !== undefined) {
          renders.byId.set(props.clip.id, (renders.byId.get(props.clip.id) ?? 0) + 1);
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
import { syncLinkedClipIds, type Clip, type Timeline } from './timeline';

const FPS = 24;
/** 1 s clips back to back: v0..v4 on V1, a0..a4 on A1 (sync-locked by default), t0..t2 on V2. */
function fixture(): Timeline {
  const clip = (id: string, i: number): Clip =>
    ({ id, name: id, source_path: `/${id}.mp4`, source_start: 0, duration: 24, source_len: 240, start_frame: i * 24 }) as Clip;
  return {
    id: 'lane-renders',
    name: 'lane renders',
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
      openProjectKey: '/projects/lane-renders.chroma',
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
  renders.byId.clear();
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

const apply = (op: Parameters<ReturnType<typeof useEditorTimelineStore.getState>['applyOp']>[0]) =>
  actSync(() => useEditorTimelineStore.getState().applyOp(op));

describe('D-437 S4 — an edit release re-renders only the clips it changed', () => {
  it('mounted every clip (13) once, and an idle pane re-render touches none', () => {
    expect(mounted!.container.querySelectorAll('[data-testid="timeline-clip"]').length).toBe(13);
    // A pane render with nothing changed for any clip (a view toggle the lanes do not read).
    actSync(() => useTimelineViewStore.getState().setView({ skimming: true }));
    expect([...renders.byId.entries()]).toEqual([]);
  });

  it('a plain trim re-renders the trimmed clip, and the next one only because its cut mark changed', () => {
    apply({ kind: 'trim_end', track: 0, clip: 2, delta: -6 });
    // v3's left edge no longer abuts v2, so its hairline cut (`cutStyleAt`) goes:
    // a real prop change. Nothing else is touched.
    expect([...renders.byId.entries()].sort()).toEqual([['v2', 1], ['v3', 1]]);
  });

  it('a trim inside a clip whose neighbour does not abut re-renders that one clip', () => {
    apply({ kind: 'trim_end', track: 1, clip: 0, delta: -6 }); // t0..t2 are 1 s apart
    expect([...renders.byId.entries()]).toEqual([['t0', 1]]);
  });

  it('a ripple trim re-renders the trimmed clip and the clips it shifted, and nothing else', () => {
    apply({ kind: 'trim_end', track: 0, clip: 1, delta: -6, ripple: true });
    const changed = [...renders.byId.keys()].sort();
    // v1 (shorter) + v2..v4 (shifted) on V1; a2..a4 shifted on the sync-locked A1.
    // a1 straddles the cut and is left alone by the ripple's sync rule or split by
    // it; either way V2 (not sync-locked) is untouched.
    expect(changed).toEqual(expect.arrayContaining(['v1', 'v2', 'v3', 'v4']));
    expect(changed.some((id) => id.startsWith('t'))).toBe(false);
    expect(changed).not.toContain('v0');
    expect(changed).not.toContain('a0');
    for (const n of renders.byId.values()) expect(n).toBe(1);
  });

  it('a selection click re-renders only the clips whose flags flipped', () => {
    const selection = [{ track: 2, id: 'a3' }];
    actSync(() => useEditorTimelineStore.getState().setSelection(selection));
    // The selected clip, plus every clip that turns sync-linked (a ripple from a3
    // would shift it: v3, v4 on the sync-locked V1).
    const tl = useEditorTimelineStore.getState().timeline!;
    const expected = ['a3', ...[...syncLinkedClipIds(tl, selection)].filter((id) => id !== 'a3')].sort();
    expect([...renders.byId.keys()].sort()).toEqual(expected);
    expect(expected.length).toBeLessThan(13);
    for (const n of renders.byId.values()) expect(n).toBe(1);
  });

  it('a move re-renders the moved clip only (its neighbours keep their objects)', () => {
    apply({ kind: 'move', fromTrack: 1, toTrack: 1, clip: 2, startFrame: 120 });
    expect([...renders.byId.entries()]).toEqual([['t2', 1]]);
  });
});
