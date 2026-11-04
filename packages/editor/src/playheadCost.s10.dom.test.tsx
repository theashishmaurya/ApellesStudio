// @vitest-environment jsdom
/**
 * @apelles/editor — D-437 S10: the per-frame `playhead` subscribers OUTSIDE the
 * timeline pane, taken off React state (`docs/notes/timeline-lanes.md` S10).
 *
 * S8 left five components re-rendering on every displayed frame of playback
 * (`PreviewPane`, `EditorInspectorPanel`, `ClipHighlightsSection`,
 * `HighlightOverlay`, `ClipCurveEditor`), each through a reactive
 * `useEditorTimelineStore((s) => s.playhead)`. The instrument is the one
 * D-325/D-330 established (`playheadCost.dom.test.tsx`): count renders across a
 * run of playhead ticks, because a correctness test passes on both the fast and
 * the slow implementation.
 *
 * **The property, per component:**
 * - `PreviewPane`: ZERO renders per tick (counted through `useCanvasClipPick`,
 *   which only it calls, once per render); the transport's own
 *   `PlayheadPlayer` renders once per tick (its position bar and timecode are
 *   what change).
 * - `EditorInspectorPanel`: ZERO per tick for a selected clip without
 *   keyframes; once per tick for a keyframed one, whose rows show the value AT
 *   the playhead (that is the feature, not a leak).
 * - `ClipHighlightsSection`, `HighlightOverlay` (not armed): ZERO.
 * - `TransformOverlay` (under the preview, found while profiling): ZERO for a
 *   selected clip without keyframes; once per tick for a keyframed one (its
 *   box follows the animation).
 * - `ClipCurveEditor`: ZERO for ticks inside one segment; the playhead line
 *   still moves (written imperatively).
 *
 * **Verified to fail on the forbidden implementation first:** with the S9
 * selectors restored each component scores TICKS renders here.
 *
 * jsdom: proves the render COUNT, not milliseconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  PREVIEW_SURFACE_STUBS,
  actSync,
  captureConsole,
  createInvokeStub,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

const counts = vi.hoisted(() => ({ preview: 0, player: 0 }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    ...PREVIEW_SURFACE_STUBS,
    chroma_timeline_composition_size: () => ({ compWidth: 1000, compHeight: 500, naturalWidth: 1, naturalHeight: 1 }),
    chroma_timeline_clip_geometry: () => ({ compWidth: 1000, compHeight: 500, naturalWidth: 1000, naturalHeight: 500 }),
    chroma_project_get_settings: () => ({ width: 1000, height: 500 }),
    chroma_audio_play: () => undefined,
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: () => undefined,
    chroma_audio_waveform: () => [],
    chroma_clip_thumbnails: () => [],
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
    chroma_caption_geometry: () => null,
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock('./useCanvasClipPick', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useCanvasClipPick')>();
  return {
    ...actual,
    useCanvasClipPick: (...args: Parameters<typeof actual.useCanvasClipPick>) => {
      counts.preview++;
      return actual.useCanvasClipPick(...args);
    },
  };
});
vi.mock('@apelles/player', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@apelles/player')>();
  return {
    ...actual,
    Player: (props: Parameters<typeof actual.Player>[0]) => {
      counts.player++;
      return actual.Player(props);
    },
  };
});

import { useEditorTimelineStore } from './timelineStore';
import { useHighlightEditStore } from './highlightEditStore';
import { PreviewPane } from './PreviewPane';
import { EditorInspectorPanel } from './EditorInspectorPanel';
import { ClipHighlightsSection } from './ClipHighlightsSection';
import { HighlightOverlay } from './HighlightOverlay';
import { ClipCurveEditor } from './ClipCurveEditor';
import { TransformOverlay } from './TransformOverlay';
import type { Clip, Timeline } from './timeline';

const FPS = 25;
const TICKS = 30;

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return { id, name: id, source_path: `/${id}.mov`, source_start: 0, duration: 2000, source_len: 2000, source_fps: FPS, start_frame: 0, ...extra } as Clip;
}
/** V1: `plain` (no keyframes); V2: `keyed` (scale keyed at 0, 1000, 2000 —
 *  two curve segments, ticks 1..30 stay in the first). */
function fixture(): Timeline {
  return {
    id: 'cost-s10',
    name: 'cost',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: [clip('plain')] },
      {
        kind: 'video',
        clips: [
          clip('keyed', {
            chroma_keyframes: [
              { frame: 0, params: { scale: 1 } },
              { frame: 1000, params: { scale: 1.5 } },
              { frame: 2000, params: { scale: 1 } },
            ],
          }),
        ],
      },
    ],
  } as unknown as Timeline;
}

let restores: Array<() => void> = [];
let objectUrls: ObjectUrlStub;
let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

function select(track: number, id: string) {
  actSync(() => useEditorTimelineStore.setState({ selection: [{ track, id }] }));
}
/** Mount under a Profiler (StrictMode off: it double-renders) and return the
 *  commit list; the count is reset after the mount settles. */
async function mountProfiled(node: React.ReactNode): Promise<number[]> {
  const commits: number[] = [];
  ui = mount(
    React.createElement(React.Profiler, { id: 'cost', onRender: (_id, _phase, d) => void commits.push(d) }, node),
    { strictMode: false },
  );
  await waitFrames(2);
  commits.length = 0;
  counts.preview = 0;
  counts.player = 0;
  return commits;
}
const tick = (from = 1) => {
  for (let i = from; i < from + TICKS; i++) actSync(() => useEditorTimelineStore.setState({ playhead: i }));
};

beforeEach(() => {
  restores = [stubOffsetMetrics(1000, 500), installResizeObserverStub(), installPointerCaptureStub()];
  objectUrls = installObjectUrlStub();
  console_ = captureConsole();
  useHighlightEditStore.setState({ armedClipId: null, selected: null });
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/cost-s10.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
      curveEditor: null,
    }),
  );
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  objectUrls.restore();
  restores.forEach((r) => r());
  console_.restore();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [], playhead: 0 }));
});

describe('D-437 S10 — what a playhead tick costs outside the pane', () => {
  it('PreviewPane renders ZERO times per tick; only its transport (PlayheadPlayer) renders', async () => {
    await mountProfiled(React.createElement(PreviewPane));
    tick();
    expect(counts.preview).toBe(0);
    expect(counts.player).toBe(TICKS);
  });

  it('EditorInspectorPanel: ZERO renders per tick for a clip without keyframes', async () => {
    select(0, 'plain');
    // Parked inside the clip: the Speed section's "add a point here" is
    // enabled and stays so (its flip at the clip's in-point is a real change).
    actSync(() => useEditorTimelineStore.setState({ playhead: 1 }));
    const commits = await mountProfiled(React.createElement(EditorInspectorPanel));
    tick(2);
    expect(commits.length).toBe(0);
  });

  it('EditorInspectorPanel: a keyframed clip still re-renders per tick (its rows show the value AT the playhead)', async () => {
    select(1, 'keyed');
    const commits = await mountProfiled(React.createElement(EditorInspectorPanel));
    tick();
    expect(commits.length).toBe(TICKS);
  });

  it('ClipHighlightsSection: ZERO renders per tick', async () => {
    select(0, 'plain');
    const commits = await mountProfiled(React.createElement(ClipHighlightsSection));
    tick();
    expect(commits.length).toBe(0);
  });

  it('HighlightOverlay (not armed): ZERO renders per tick', async () => {
    select(0, 'plain');
    const commits = await mountProfiled(React.createElement(HighlightOverlay, { container: null }));
    tick();
    expect(commits.length).toBe(0);
  });

  it('TransformOverlay: ZERO renders per tick for a clip without keyframes, once per tick for a keyframed one', async () => {
    select(0, 'plain');
    let commits = await mountProfiled(React.createElement(TransformOverlay, { container: null }));
    tick();
    expect(commits.length).toBe(0);
    ui?.unmount();
    select(1, 'keyed');
    commits = await mountProfiled(React.createElement(TransformOverlay, { container: null }));
    tick(100);
    expect(commits.length).toBe(TICKS);
  });

  it('ClipCurveEditor: ZERO renders per tick inside one segment, and its playhead line still moves', async () => {
    const tl = fixture();
    // Parked just past the first key, so the ticks cross no key (crossing one
    // legitimately re-renders the navigator's neighbours).
    actSync(() => useEditorTimelineStore.setState({ playhead: 1 }));
    const commits = await mountProfiled(
      React.createElement(ClipCurveEditor, {
        clip: tl.tracks[1].clips[0],
        track: 1,
        clipIndex: 0,
        param: 'scale',
        fps: FPS,
        pxPerSec: 100,
        scrollLeft: 0,
        startLeftPx: 32,
        onClose: () => {},
      }),
    );
    const line = () => document.querySelector('[data-chroma-curve-playhead]');
    expect(line()?.getAttribute('x1')).toBe(String(32 + (1 / FPS) * 100));
    tick(2);
    expect(commits.length).toBe(0);
    expect(line()?.getAttribute('x1')).toBe(String(32 + ((1 + TICKS) / FPS) * 100));
  });
});
