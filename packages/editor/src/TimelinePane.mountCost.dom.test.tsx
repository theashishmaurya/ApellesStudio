// @vitest-environment jsdom
/**
 * @apelles/editor — what MOUNTING `TimelinePane` costs, and how much per-clip
 * IPC it fans out (D-334, B-204).
 *
 * **Why this file exists, and why it is not the playhead one.**
 * `TimelinePane.playheadCost.dom.test.tsx` (D-325) measures the STEADY-STATE
 * cost of a playhead tick on an already-mounted pane, and deliberately stubs
 * `chroma_audio_waveform`/`chroma_clip_thumbnails` to `[]` so that what it
 * measures is React overhead alone. That stub is correct for its question and
 * it is exactly what hid this one: the owner's "opening a project takes
 * forever, the timeline takes forever" report is dominated by the *fan-out
 * itself* — how many backend round trips one mount starts — which a stub that
 * answers instantly cannot show.
 *
 * So this file counts the calls rather than timing them. The count is the
 * honest thing to assert at this tier: in jsdom every `invoke` resolves on a
 * microtask, so the wall-clock here says nothing about the real app, while the
 * NUMBER of decodes a mount asks a real backend for is the same number in
 * jsdom and in production, and it is the number the fix changes.
 *
 * **The defect this pins (B-204).** `Filmstrip` self-culls — `requestWindow`
 * returns `null` for a clip scrolled entirely out of the viewport, which is
 * "what stops a 40-clip timeline from requesting 40 windows when two are
 * visible" (`Filmstrip.tsx`'s own words, D-128). `Waveform` had no equivalent:
 * its fetch effect fired on mount for every clip in the tree regardless of
 * horizontal scroll position, because the library
 * (`@xzdarcy/react-timeline-editor`) virtualizes ROWS vertically but does not
 * virtualize ACTIONS horizontally at all — every clip on a track is mounted no
 * matter where the viewport is. On the owner's real `2026-09-12-c040` (75
 * video + 75 audio clips over one 686 s 4K source, ~7 clips of which fit the
 * viewport at the default zoom) that is ~150 `chroma_audio_waveform` round
 * trips at mount where ~14 would do, each one a `symphonia` decode on a cold
 * cache.
 *
 * **Tier and its honest limits.** jsdom — the same caveats as every sibling
 * `*.dom.test.tsx` here: no real layout (geometry is stubbed), no real paint,
 * no real IPC. This proves the fan-out is bounded by what is VISIBLE rather
 * than by the clip count, which is the regression that actually matters. It
 * cannot say what that is worth in real milliseconds; the live measurement
 * against a running app is what D-334's decision entry records for that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

/** Every `invoke` this mount makes, in order, so a test can count by command.
 *  Declared before the `vi.mock` factory because the factory is hoisted above
 *  the imports and must not close over anything initialised later. */
const invokeCalls: string[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    invokeCalls.push(cmd);
    // Every command this component tree reaches for at mount answers with the
    // "nothing to draw" shape its real counterpart uses for a silent/absent
    // source, so the stub can never be the reason a branch is skipped.
    if (cmd === 'chroma_audio_waveform' || cmd === 'chroma_clip_thumbnails') return [];
    return undefined;
  },
}));

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import type { Timeline, Clip } from './timeline';

const FPS = 24;
/** The real viewport `stubOffsetMetrics` reports, and what `viewportWidth`
 *  therefore becomes — the pane reads it off the edit area's `clientWidth`. */
const AREA = { left: 0, top: 0, width: 1200, height: 600 };

/** The owner's real `2026-09-12-c040` shape, which is what the report was
 *  about: a silence/retake recut of ONE long 4K source into many short linked
 *  A/V pairs. 64 frames ≈ 2.67 s, so at the default 90 px/s each clip is
 *  ~240 px wide and about five fit the 1200 px viewport. */
const CLIP_FRAMES = 64;

/** A source path unique to every MOUNT in this file.
 *
 *  **Not cosmetic — this is test isolation, and it bit twice.** `Waveform`'s
 *  `getPeaks` cache is a module-level `Map` keyed on
 *  `(path, start, duration, buckets)`, so it survives unmount, `afterEach`,
 *  and the next test in the file. Sharing one path across the cases first made
 *  a larger mount count only what a smaller earlier one had not already
 *  cached (understating the fan-out); keying it per fixture SIZE then still
 *  left the remount case re-using the first test's warm entries and counting
 *  zero. A counter is the only thing that actually guarantees a cold cache per
 *  mount, which is the state a real project open is in. */
let mountSerial = 0;
function sourceFor(pairs: number, serial: number): string {
  return `/Users/someone/Downloads/A001_09122356_C040_${pairs}_${serial}.MOV`;
}

function clip(i: number, kind: 'video' | 'audio', source: string): Clip {
  return {
    id: `clip-${kind}-${i}`,
    media_id: 'media-0',
    link_group: `lg-${i}`,
    name: 'A001_09122356_C040.MOV',
    source_path: source,
    // A recut takes each clip from a DIFFERENT point in the one source, which
    // is why the backend's per-range waveform cache gets a distinct key per
    // clip and a cold open pays a distinct decode for each.
    source_start: i * CLIP_FRAMES,
    duration: CLIP_FRAMES,
    source_len: 16475,
    source_fps: FPS,
    start_frame: i * CLIP_FRAMES,
  } as Clip;
}

/** `pairs` linked video+audio clips, i.e. `pairs * 2` clips in total. Each
 *  call takes a fresh source identity — see `sourceFor`. */
function fixture(pairs: number): Timeline {
  const source = sourceFor(pairs, (mountSerial += 1));
  return {
    id: 'mount-cost-fixture',
    name: 'mount cost fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: Array.from({ length: pairs }, (_, i) => clip(i, 'video', source)) },
      { kind: 'audio', clips: Array.from({ length: pairs }, (_, i) => clip(i, 'audio', source)) },
    ],
    markers: [],
  } as unknown as Timeline;
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

async function mountPane(pairs: number): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(pairs),
      openProjectKey: '/projects/mount-cost.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  invokeCalls.length = 0;
  ui = mount(React.createElement(TimelinePane), { strictMode: false });
  await waitFrames(2);
  stubEditAreaRect();
  // The pane learns its real viewport from a ResizeObserver/`clientWidth` read
  // that lands after first paint, and the visibility window is only meaningful
  // once it has. Settle before counting, so what is counted is the steady
  // state rather than the first, viewport-less render.
  await waitFrames(3);
}

function countOf(cmd: string): number {
  return invokeCalls.filter((c) => c === cmd).length;
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
  invokeCalls.length = 0;
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

describe('B-204 — a mount asks for as many waveforms as are VISIBLE, not as many as exist', () => {
  /** How many clips can actually be seen at the default zoom: 1200 px of
   *  viewport over ~240 px per clip, so roughly five pairs, plus the overscan
   *  a scroll bucket rounds in. A linked pair costs ONE fetch, not two — the
   *  video clip's short waveform and the audio clip's full-height one resolve
   *  to the same `(path, start, duration, buckets)` cache key, which is why
   *  the pre-fix baseline for the owner's 150-clip project was 75 and not 150.
   *  Generous on purpose: this is an upper bound that must not scale with the
   *  fixture, not a tight fit that would flap on a layout tweak. */
  const VISIBLE_CEILING = 24;

  for (const pairs of [4, 75, 150]) {
    it(`pairs=${pairs} (${pairs * 2} clips): waveform fan-out stays bounded`, async () => {
      await mountPane(pairs);

      const waveforms = countOf('chroma_audio_waveform');
      // eslint-disable-next-line no-console
      console.log(
        `pairs=${pairs} clips=${pairs * 2}: chroma_audio_waveform=${waveforms} ` +
          `chroma_clip_thumbnails=${countOf('chroma_clip_thumbnails')} ` +
          `total_invokes=${invokeCalls.length}`,
      );

      // The regression, stated as the property rather than as a number: a
      // timeline with 150 clips must not ask the backend to decode 150 audio
      // ranges to draw a viewport that can show about ten of them. Before the
      // D-334 fix this was one call per clip, so `pairs=150` produced ~300.
      expect(waveforms).toBeLessThanOrEqual(VISIBLE_CEILING);
    }, 30000);
  }

  it('fan-out does not grow between a small and a large timeline', async () => {
    await mountPane(4);
    const small = countOf('chroma_audio_waveform');
    ui?.unmount();
    ui = null;

    await mountPane(150);
    const large = countOf('chroma_audio_waveform');

    // eslint-disable-next-line no-console
    console.log(`waveform fan-out: 8 clips -> ${small}, 300 clips -> ${large}`);

    // **Guard against passing for the wrong reason.** An earlier version of
    // this test reported `0 -> 0` and went green: the remount left the pane
    // with no measured viewport, everything culled, and a test that asserts
    // "not many" trivially satisfied by "none at all". A culling fix is
    // exactly the kind of change that can make a counting test vacuous, so
    // the small case must first prove it fetched something real.
    expect(small).toBeGreaterThan(0);

    // The clip count went up 37×. What the viewport can show did not, so what
    // the mount asks for must not either. Stated as "no worse than the small
    // case plus the same visible ceiling" rather than "equal", because the
    // small fixture is shorter than the viewport and so legitimately shows
    // all of itself.
    expect(large).toBeLessThanOrEqual(small + VISIBLE_CEILING);
  }, 60000);
});
