// @vitest-environment jsdom
/**
 * @apelles/editor — what a playhead tick costs the components D-330 took off
 * the per-frame path (B-146).
 *
 * **Why this file exists.** D-290 found eight components subscribed to
 * `playhead` reactively, so each one re-rendered on every displayed frame of
 * playback. D-325 fixed `TimelinePane`, D-328 fixed `EditLibraryPanel` and
 * added `useActiveTranscriptRow`; D-330 fixes the next three and pins them here.
 * The instrument is the one those two decisions established — a `React.Profiler`
 * counting COMMITS across a run of playhead ticks — because correctness tests
 * pass on both the fast and the slow implementation, which is precisely how this
 * regression got in twice already.
 *
 * **The property, per component:**
 *
 * 1. `CaptionLibrary` and `CaptionsFromTranscriptButton` read the playhead only
 *    inside a click handler, to decide where to drop what they import. So a
 *    tick must cost **zero** commits, always — there is no boundary at which
 *    they legitimately re-render.
 *
 * 2. `useCanvasClipPick` is called from `PreviewPane`, so its re-render IS the
 *    preview's. What it needs during render is the SET of clips on screen, which
 *    changes at a cut. So ticks inside one clip cost **zero** commits, and
 *    crossing a real clip boundary costs **one**.
 *
 * **Verified to fail on the forbidden implementation first**, the same
 * discipline D-325 and D-328 used. Restoring the reactive
 * `useEditorTimelineStore((s) => s.playhead)` selector in each of the three
 * scores **30 commits where this scores 0** (measured 2026-09-15, TICKS = 30).
 *
 * **Tier and its honest limits.** jsdom — no real layout, no real paint, no real
 * IPC. This proves the commit COUNT, not milliseconds; the real-app number is
 * `debug_frame_timing`'s job and is recorded in D-330.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_timeline_set: () => undefined,
    chroma_timeline_clip_geometry: () => ({ naturalWidth: 1920, naturalHeight: 1080 }),
    chroma_caption_geometry: () => null,
  }),
}));

import { CaptionLibrary } from './CaptionLibrary';
import { CaptionTransformOverlay } from './CaptionTransformOverlay';
import { CaptionsFromTranscriptButton } from './CaptionsFromTranscriptButton';
import { useCanvasClipPick } from './useCanvasClipPick';
import { useEditorTimelineStore } from './timelineStore';
import type { Timeline } from './timeline';

const FPS = 24;
const TICKS = 30;

/** Two butted clips on one video track, so there is a real cut to cross at
 *  frame 120 — the boundary `useCanvasClipPick` legitimately re-renders at —
 *  plus a subtitle track carrying one cue over frames 0..60, which is what
 *  `CaptionTransformOverlay`'s on/off-screen boundary is measured against. */
function fixture(): Timeline {
  return {
    id: 't1',
    name: 'T',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'subtitle',
        clips: [
          {
            id: 'cue1',
            name: 'cue',
            source_path: '',
            source_start: 0,
            duration: 60,
            source_len: 60,
            start_frame: 0,
            caption: { text: 'hello', style: null },
          },
        ],
      },
      {
        kind: 'video',
        clips: [
          {
            id: 'c1',
            name: 'a',
            source_path: '/media/a.mov',
            source_start: 0,
            duration: 120,
            source_len: 2400,
            start_frame: 0,
          },
          {
            id: 'c2',
            name: 'b',
            source_path: '/media/b.mov',
            source_start: 600,
            duration: 120,
            source_len: 2400,
            start_frame: 120,
          },
        ],
      },
    ],
    markers: [],
  } as unknown as Timeline;
}

let ui: MountedComponent | null = null;
let restoreResizeObserver: () => void;
let console_: ReturnType<typeof captureConsole>;

function setUp(): void {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/cost.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
}

/** Mount `node` under a Profiler and return the array commits are pushed into.
 *  `strictMode: false` is mandatory — StrictMode double-renders would corrupt
 *  the count. Same harness as `EditIndexPanel.dom.test.tsx`. */
async function mountProfiled(node: React.ReactNode): Promise<number[]> {
  const commits: number[] = [];
  const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    commits.push(actualDuration);
  };
  ui = mount(
    React.createElement(React.Profiler, { id: 'cost', onRender }, node),
    { strictMode: false },
  );
  await waitFrames(2);
  return commits;
}

/** A host for the hook, which renders nothing of its own — so every commit the
 *  Profiler sees is one the hook caused. */
function ClipPickHost() {
  useCanvasClipPick(null, { width: 1920, height: 1080 });
  return null;
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  console_ = captureConsole();
  setUp();
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  restoreResizeObserver();
  console_.restore();
});

describe('what a playhead tick costs (D-330, B-146)', () => {
  it('CaptionLibrary: a tick costs ZERO commits', async () => {
    const commits = await mountProfiled(React.createElement(CaptionLibrary));
    commits.length = 0; // steady-state ticks only, not mount

    for (let i = 1; i <= TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: i }));
    }

    // The reactive selector this replaced scores TICKS here.
    expect(commits.length).toBe(0);
  });

  it('CaptionsFromTranscriptButton: a tick costs ZERO commits', async () => {
    const commits = await mountProfiled(React.createElement(CaptionsFromTranscriptButton));
    commits.length = 0;

    for (let i = 1; i <= TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: i }));
    }

    expect(commits.length).toBe(0);
  });

  it('useCanvasClipPick: ticks INSIDE one clip cost ZERO commits', async () => {
    const commits = await mountProfiled(React.createElement(ClipPickHost));
    actSync(() => useEditorTimelineStore.setState({ playhead: 10 }));
    await waitFrames(2);
    commits.length = 0;

    // 10 → 40, all inside clip `c1` (frames 0..119).
    for (let i = 1; i <= TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: 10 + i }));
    }

    expect(commits.length).toBe(0);
  });

  it('CaptionTransformOverlay: ticks that do not change on/off screen cost ZERO commits', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'cue1' }] }));
    const commits = await mountProfiled(
      React.createElement(CaptionTransformOverlay, {
        container: null,
        size: { width: 1920, height: 1080 },
      }),
    );
    actSync(() => useEditorTimelineStore.setState({ playhead: 10 }));
    await waitFrames(2);
    commits.length = 0;

    // 10 → 40, all inside the cue's own span (frames 0..59), so `onScreen`
    // stays true throughout and nothing about the box changes.
    for (let i = 1; i <= TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: 10 + i }));
    }

    expect(commits.length).toBe(0);
  });

  it('useCanvasClipPick: crossing a real cut costs exactly ONE commit', async () => {
    const commits = await mountProfiled(React.createElement(ClipPickHost));
    actSync(() => useEditorTimelineStore.setState({ playhead: 119 }));
    await waitFrames(2);
    commits.length = 0;

    // 119 → 120 is the cut from `c1` to `c2`: the visible set really changes,
    // so the geometry fetch downstream has to be given the new clip.
    actSync(() => useEditorTimelineStore.setState({ playhead: 120 }));
    const synchronous = commits.length;
    await waitFrames(2);

    // ONE commit for the visible set changing...
    expect(synchronous).toBe(1);
    // ...and one more when `useClipGeometries`' fetch for the newly visible
    // clip resolves a frame later. That second one is real work with a real
    // cause — a clip that has just come on screen has a natural size nothing
    // has measured yet — and it is charged per CUT, not per frame, which is the
    // property this file exists to pin. (Measured, not assumed: the count
    // immediately after the tick is 1, and only settles at 2 once the stubbed
    // `chroma_timeline_clip_geometry` promise lands.)
    expect(commits.length).toBe(2);
  });
});
