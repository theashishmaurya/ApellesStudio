// @vitest-environment jsdom
/**
 * @apelles/editor — the Index panel: real-DOM behaviour, and what a playhead
 * tick costs it (D-328).
 *
 * **What is asserted, and why each one is here.**
 *
 * 1. **The Markers view** lists every marker in frame order, shows a ranged
 *    marker's in → out but a point marker's single time, seeks the playhead on
 *    a row click, writes a real `set_marker` op from the inline comment box,
 *    and a real `remove_marker` from the row's delete. These are the whole
 *    feature; each goes through the same `applyOp` the ruler popover uses, and
 *    that "one write path" claim is only worth anything if it is checked.
 *
 * 2. **The Transcript view** refuses gracefully with no selection, lists the
 *    selected clip's segments, and seeks to a segment's own TIMELINE frame
 *    (not its source seconds — the conversion is the part that can silently be
 *    wrong, and a test is the only thing that would catch a clip whose
 *    `source_start`/`start_frame` differ).
 *
 * 3. **The playhead cost** — the D-325/B-146 constraint, and the reason this
 *    file borrows `TimelinePane.playheadCost.dom.test.tsx`'s instrument rather
 *    than eyeballing it. A transcript list is exactly the per-row render body
 *    that must not run on every displayed frame. The property asserted is
 *    sharper than TimelinePane's own: ticks that stay INSIDE one segment must
 *    cost **zero** commits, and only a genuine boundary crossing may cost one.
 *    **Verified to fail on the forbidden implementation first**, the same
 *    discipline D-325 used: temporarily swapping `useActiveTranscriptRow` for a
 *    reactive `useEditorTimelineStore((s) => s.playhead)` selector scores
 *    **30 commits where this scores 0** on both cost tests (measured
 *    2026-09-15). Note that test 11 — the highlight is on the right row —
 *    passes on BOTH implementations, which is the point: correctness alone
 *    would not have caught the regression, so the cost is asserted separately.
 *
 * **Tier and its honest limits.** jsdom — no real layout, no real paint, no
 * real IPC (`chroma_clip_thumbnails` is stubbed, so the row thumbnails resolve
 * to nothing and are not asserted on; they are a real-app concern). This proves
 * the wiring, the ops and the commit COUNT, not how it looks or how many real
 * milliseconds it costs.
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
  }),
}));

import { EditIndexPanel } from './EditIndexPanel';
import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { newMarker, type Marker, type Timeline } from './timeline';

const FPS = 24;
const SOURCE = '/media/interview.mov';

/** A one-video-track timeline whose single clip starts at timeline frame 48 and
 *  is trimmed to start 24 source frames in. Both offsets are deliberately
 *  non-zero and different from each other: a source-seconds → timeline-frame
 *  conversion that ignored either one would still pass on a 0/0 fixture. */
function fixture(markers: Marker[] = []): Timeline {
  return {
    id: 't1',
    name: 'T',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'c1',
            name: 'interview',
            source_path: SOURCE,
            source_start: 24,
            duration: 480,
            source_len: 2400,
            start_frame: 48,
          },
        ],
      },
    ],
    markers,
  } as Timeline;
}

function mk(id: string, frame: number, over: Partial<Marker> = {}): Marker {
  const m = newMarker(frame, 'red', `marker ${id}`, null);
  if ('error' in m) throw new Error(m.error);
  return { ...m, id, ...over };
}

let ui: MountedComponent | null = null;
let restoreResizeObserver: () => void;
let console_: ReturnType<typeof captureConsole>;

function setUp(timeline: Timeline, extra: Record<string, unknown> = {}): void {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline,
      openProjectKey: '/projects/index.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
      ...extra,
    }),
  );
}

async function mountPanel(): Promise<void> {
  ui = mount(React.createElement(EditIndexPanel), { strictMode: false });
  await waitFrames(2);
}

/** Switch to a sub-view by clicking its real tab trigger, rather than reaching
 *  into component state — the tab wiring is part of what this file covers. */
async function showView(name: 'Markers' | 'Transcript'): Promise<void> {
  const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) =>
    t.textContent?.includes(name),
  );
  if (!tab) throw new Error(`no ${name} tab`);
  actSync(() => tab.click());
  await waitFrames(2);
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  console_ = captureConsole();
});

afterEach(() => {
  console_.restore();
  ui?.unmount();
  ui = null;
  restoreResizeObserver();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
      playhead: 0,
    }),
  );
  useMediaUnderstandingStore.getState().clear();
});

describe('Index panel — Markers view (D-328)', () => {
  it('1. lists every marker in frame order', async () => {
    setUp(fixture([mk('b', 300), mk('a', 100)]));
    await mountPanel();

    const rows = Array.from(document.querySelectorAll('[data-chroma-marker-index-item]'));
    expect(rows.map((r) => r.getAttribute('data-chroma-marker-index-item'))).toEqual(['a', 'b']);
  });

  it('2. shows a point marker’s single time and a ranged marker’s in → out', async () => {
    setUp(fixture([mk('point', 48), mk('ranged', 96, { duration_frames: 48 })]));
    await mountPanel();

    const point = document.querySelector('[data-chroma-marker-index-item="point"]')!;
    const ranged = document.querySelector('[data-chroma-marker-index-item="ranged"]')!;

    // 48 frames at 24fps is 00:00:02:00; the ranged one runs 96 → 144, i.e.
    // 00:00:04:00 → 00:00:06:00.
    expect(point.textContent).toContain('00:00:02:00');
    expect(point.textContent).not.toContain('→');
    expect(ranged.textContent).toContain('00:00:04:00');
    expect(ranged.textContent).toContain('00:00:06:00');
    expect(ranged.textContent).toContain('→');
  });

  it('3. clicking a row seeks the playhead to that marker', async () => {
    setUp(fixture([mk('a', 100), mk('b', 260)]));
    await mountPanel();
    expect(useEditorTimelineStore.getState().playhead).toBe(0);

    const seek = document
      .querySelector('[data-chroma-marker-index-item="b"]')!
      .querySelector<HTMLElement>('[data-chroma-marker-index-seek]')!;
    actSync(() => seek.click());

    expect(useEditorTimelineStore.getState().playhead).toBe(260);
  });

  it('4. the inline comment box writes a real set_marker op on blur', async () => {
    setUp(fixture([mk('a', 100)]));
    await mountPanel();

    const input = document
      .querySelector('[data-chroma-marker-index-item="a"]')!
      .querySelector<HTMLInputElement>('[data-chroma-marker-index-note]')!;

    actSync(() => {
      // React 19 controlled input: set through the native setter so the
      // synthetic onChange actually fires.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'client wants this trimmed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // React delegates blur as `focusout` (it has bubbled since React 17), so a
    // non-bubbling `blur` event would never reach the synthetic handler.
    actSync(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

    const after = useEditorTimelineStore.getState().timeline!.markers!.find((m) => m.id === 'a');
    expect(after!.note).toBe('client wants this trimmed');
  });

  it('5. the row’s delete writes a real remove_marker op', async () => {
    setUp(fixture([mk('a', 100), mk('b', 260)]));
    await mountPanel();

    const del = document
      .querySelector('[data-chroma-marker-index-item="a"]')!
      .querySelector<HTMLElement>('[data-chroma-marker-index-remove]')!;
    actSync(() => del.click());

    const ids = useEditorTimelineStore.getState().timeline!.markers!.map((m) => m.id);
    expect(ids).toEqual(['b']);
  });

  it('6. says so rather than rendering an empty list when there are no markers', async () => {
    setUp(fixture([]));
    await mountPanel();
    expect(document.querySelectorAll('[data-chroma-marker-index-item]').length).toBe(0);
    expect(document.body.textContent).toContain('No markers yet');
  });
});

describe('Index panel — Transcript view (D-328)', () => {
  /** Segments in absolute SOURCE seconds, which is what the transcript store
   *  holds. The clip starts 24 source frames (1s) in, so a segment at 1.0s is
   *  the clip's own first frame. */
  function seedTranscript(): void {
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE]: {
          text: 'one two',
          language: 'en',
          model: 'test',
          source: SOURCE,
          segments: [
            { start: 1.0, end: 3.0, text: 'first thing said', words: [] },
            { start: 3.0, end: 6.0, text: 'second thing said', words: [] },
          ],
        },
      },
    } as never);
  }

  it('7. asks for a selection rather than showing an empty list', async () => {
    setUp(fixture());
    await mountPanel();
    await showView('Transcript');
    expect(document.body.textContent).toContain('Select one clip');
  });

  it('8. offers to transcribe when the clip has no transcript yet', async () => {
    setUp(fixture(), { selection: [{ track: 0, id: 'c1' }] });
    await mountPanel();
    await showView('Transcript');
    expect(document.querySelector('[data-chroma-index-transcribe]')).toBeTruthy();
  });

  it('9. lists the selected clip’s segments with their text and a duration badge', async () => {
    seedTranscript();
    setUp(fixture(), { selection: [{ track: 0, id: 'c1' }] });
    await mountPanel();
    await showView('Transcript');

    const rows = Array.from(document.querySelectorAll('[data-chroma-transcript-row]'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('first thing said');
    expect(rows[1].textContent).toContain('second thing said');
    // 3.0 → 6.0 is a 3-second segment.
    expect(rows[1].textContent).toContain('3.0s');
  });

  it('10. clicking a row seeks to the segment’s TIMELINE frame, not its source seconds', async () => {
    seedTranscript();
    setUp(fixture(), { selection: [{ track: 0, id: 'c1' }] });
    await mountPanel();
    await showView('Transcript');

    const second = document.querySelector<HTMLElement>('[data-chroma-transcript-row="1"]')!;
    actSync(() => second.click());

    // The segment starts at source second 3.0 = source frame 72. The clip is
    // trimmed to start at source frame 24 and sits at timeline frame 48, so it
    // lands at 48 + (72 - 24) = 96. A naive "source seconds × fps" would have
    // said 72, and a naive "ignore the trim" would have said 120 — this is the
    // conversion the assertion exists to pin.
    expect(useEditorTimelineStore.getState().playhead).toBe(96);
  });

  it('11. highlights the segment the playhead is inside', async () => {
    seedTranscript();
    setUp(fixture(), { selection: [{ track: 0, id: 'c1' }] });
    await mountPanel();
    await showView('Transcript');

    // Timeline frame 100 is inside the second segment (96 ..< 120).
    actSync(() => useEditorTimelineStore.setState({ playhead: 100 }));
    await waitFrames(1);

    expect(
      document.querySelector('[data-chroma-transcript-row="1"]')!.hasAttribute('data-chroma-transcript-active'),
    ).toBe(true);
    expect(
      document.querySelector('[data-chroma-transcript-row="0"]')!.hasAttribute('data-chroma-transcript-active'),
    ).toBe(false);
  });
});

describe('Index panel — what a playhead tick costs it (D-328, the D-325/B-146 constraint)', () => {
  const TICKS = 30;

  /** Mount with a Profiler so commits can be counted, exactly the instrument
   *  `TimelinePane.playheadCost.dom.test.tsx` established. */
  async function mountProfiled(): Promise<number[]> {
    const commits: number[] = [];
    const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      commits.push(actualDuration);
    };
    ui = mount(
      React.createElement(
        React.Profiler,
        { id: 'edit-index-panel', onRender },
        React.createElement(EditIndexPanel),
      ),
      { strictMode: false },
    );
    await waitFrames(2);
    return commits;
  }

  it('12. ticks that stay inside one segment cost ZERO commits', async () => {
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE]: {
          text: 'one',
          language: 'en',
          model: 'test',
          source: SOURCE,
          // One long segment covering the whole clip, so every tick below stays
          // inside it and the active row never has to change.
          segments: [{ start: 1.0, end: 21.0, text: 'a long uninterrupted take', words: [] }],
        },
      },
    } as never);
    setUp(fixture(), { selection: [{ track: 0, id: 'c1' }] });
    const commits = await mountProfiled();
    await showView('Transcript');

    // Park the playhead INSIDE the segment first. Starting from frame 0 — which
    // is before the clip and therefore in no segment at all — the first tick
    // would legitimately cross a boundary (-1 → 0) and cost its one commit;
    // that is the behaviour test 13 covers, and measuring it here would hide
    // the property this test is actually about.
    actSync(() => useEditorTimelineStore.setState({ playhead: 100 }));
    commits.length = 0; // measure steady-state ticks only, not mount/tab-switch

    for (let i = 1; i <= TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: 100 + i }));
    }

    // The whole point of `useActiveTranscriptRow`'s design. A reactive
    // `useEditorTimelineStore((s) => s.playhead)` selector scores TICKS here.
    expect(commits.length).toBe(0);
  });

  it('13. a tick that crosses a segment boundary costs exactly one commit', async () => {
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE]: {
          text: 'one two',
          language: 'en',
          model: 'test',
          source: SOURCE,
          segments: [
            { start: 1.0, end: 3.0, text: 'first', words: [] },
            { start: 3.0, end: 6.0, text: 'second', words: [] },
          ],
        },
      },
    } as never);
    setUp(fixture(), { selection: [{ track: 0, id: 'c1' }] });
    const commits = await mountProfiled();
    await showView('Transcript');

    // Sit inside the first segment (48 ..< 96), then step across into the
    // second (96 ..< 120).
    actSync(() => useEditorTimelineStore.setState({ playhead: 90 }));
    commits.length = 0;

    actSync(() => useEditorTimelineStore.setState({ playhead: 96 }));
    expect(commits.length).toBe(1);

    // …and staying put in the new segment costs nothing again.
    commits.length = 0;
    for (let i = 97; i < 97 + TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: i }));
    }
    expect(commits.length).toBe(0);
  });

  it('14. the Markers view does not re-render on a playhead tick at all', async () => {
    setUp(fixture([mk('a', 100), mk('b', 260)]));
    const commits = await mountProfiled();
    commits.length = 0;

    for (let i = 1; i <= TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: i }));
    }

    // Nothing in the Markers view depends on the playhead, so the correct cost
    // is flatly zero — a guard against someone later adding a "scroll the list
    // to the playhead" feature with a reactive selector.
    expect(commits.length).toBe(0);
  });
});
