// @vitest-environment jsdom
/**
 * @apelles/editor — the Index panel: real-DOM behaviour, and what a playhead
 * tick costs it (D-328, D-329).
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
 * 2. **The Transcript view** shows the WHOLE timeline with nothing selected
 *    (D-329 — it previously refused without a selection), lists each segment,
 *    and seeks to a segment's own TIMELINE frame (not its source seconds — the
 *    conversion is the part that can silently be wrong, and a test is the only
 *    thing that would catch a clip whose `source_start`/`start_frame` differ).
 *
 * 2b. **Many clips and many files** (D-329) — the realistic post-cut shape: two
 *    clips from ONE file with a cut-out gap between their source ranges, plus a
 *    clip from a second file spliced between them. Asserted: the rows come out
 *    in TIMELINE order across all three, speech inside the cut-out gap does not
 *    appear at all, the fetch list is deduped per FILE (two jobs for three
 *    clips), a done file renders while another is still running, a failure
 *    reports its reason and offers a retry, and selecting a clip accents its
 *    rows without filtering anything out. The exact frame arithmetic is pinned
 *    separately and more thoroughly in `timelineTranscript.test.ts`, which
 *    needs no DOM; these cases are about the WIRING reaching it.
 *
 * 2c. **Word level** (D-329) — one real `<button>` per word with the model's
 *    own spacing preserved, clicking a word seeks to THAT word's remapped
 *    timeline frame (asserted on a word from the second file, so a pass cannot
 *    come from the click merely bubbling to the row), clicking the row still
 *    seeks to the row's start, the word under the playhead highlights, a pause
 *    between words highlights the row and no word, and a transcript with no
 *    word timings degrades to plain text with row-level seek intact.
 *
 * 3. **The playhead cost** — the D-325/B-146 constraint, and the reason this
 *    file borrows `TimelinePane.playheadCost.dom.test.tsx`'s instrument rather
 *    than eyeballing it. A transcript list is exactly the per-row render body
 *    that must not run on every displayed frame. The property asserted is
 *    sharper than TimelinePane's own: ticks that stay INSIDE one segment must
 *    cost **zero** commits, and only a genuine boundary crossing may cost one.
 *    D-329 asserts the same property one level down, for the WORD highlight:
 *    ticks inside one word cost zero, a word boundary costs exactly one. That
 *    pair is what proves the word highlight rides the SAME store subscription
 *    as the row highlight rather than adding a second one — a second reactive
 *    selector would score `TICKS` on the steady-state loop.
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
  // `clear()` deliberately leaves the IN-FLIGHT flags alone — a real job's own
  // `finally` is what removes them, and clearing a flag out from under a
  // running promise would make the store claim a job had stopped when it had
  // not. Tests here seed `transcribing` synthetically (no promise behind it),
  // so the test has to undo its own fixture rather than the store changing to
  // suit it.
  useMediaUnderstandingStore.setState({ transcribing: {} } as never);
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

describe('Index panel — Transcript view (D-328, widened to the whole timeline by D-329)', () => {
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

  it('7. shows the timeline’s transcript with NOTHING selected (the D-329 ask)', async () => {
    // The behaviour this whole change exists for. Before D-329 this rendered
    // "Select one clip on the timeline…" and nothing else.
    seedTranscript();
    setUp(fixture());
    await mountPanel();
    await showView('Transcript');

    expect(document.body.textContent).not.toContain('Select one clip');
    expect(document.querySelectorAll('[data-chroma-transcript-row]').length).toBe(2);
  });

  it('8. offers to transcribe the files that have no transcript yet', async () => {
    setUp(fixture());
    await mountPanel();
    await showView('Transcript');

    const button = document.querySelector('[data-chroma-index-transcribe]');
    expect(button).toBeTruthy();
    // One file on this timeline, so one job offered — and the progress line
    // says so rather than showing an opaque spinner.
    expect(button!.textContent).toContain('1');
    expect(document.body.textContent).toContain('0 of 1 file');
  });

  it('9. lists the segments with their text and a duration badge', async () => {
    seedTranscript();
    setUp(fixture());
    await mountPanel();
    await showView('Transcript');

    const rows = Array.from(document.querySelectorAll('[data-chroma-transcript-row]'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('first thing said');
    expect(rows[1].textContent).toContain('second thing said');
    // 3.0 → 6.0 is a 3-second segment, and it is 3.0s on the timeline too
    // (this clip is not speed-ramped).
    expect(rows[1].textContent).toContain('3.0s');
    // Everything is transcribed, so the progress header is gone entirely.
    expect(document.querySelector('[data-chroma-transcript-progress]')).toBeNull();
  });

  it('10. clicking a row seeks to the segment’s TIMELINE frame, not its source seconds', async () => {
    seedTranscript();
    setUp(fixture());
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
    setUp(fixture());
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

describe('Index panel — Transcript across many clips and files (D-329)', () => {
  const OTHER = '/media/broll.mov';

  /** A realistic post-cut timeline: two clips from the SAME file (a silence cut
   *  removed the middle), with a clip from a DIFFERENT file spliced between
   *  them. This is the fixture the whole D-329 data mapping exists for. */
  function multiClip(): Timeline {
    return {
      id: 't1',
      name: 'T',
      rate: { num: FPS, den: 1 },
      tracks: [
        {
          kind: 'video',
          clips: [
            // timeline 0..48   <- SOURCE seconds 0..2
            { id: 'a1', name: 'a1', source_path: SOURCE, source_start: 0, duration: 48, source_len: 2400, start_frame: 0 },
            // timeline 48..96  <- OTHER seconds 0..2
            { id: 'b1', name: 'b1', source_path: OTHER, source_start: 0, duration: 48, source_len: 2400, start_frame: 48 },
            // timeline 96..144 <- SOURCE seconds 5..7 (the gap 2..5 was cut)
            { id: 'a2', name: 'a2', source_path: SOURCE, source_start: 120, duration: 48, source_len: 2400, start_frame: 96 },
          ],
        },
      ],
      markers: [],
    } as unknown as Timeline;
  }

  function seedBoth(): void {
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE]: {
          text: '', language: 'en', model: 'test', source: SOURCE,
          segments: [
            { start: 0.0, end: 2.0, text: 'opening line', words: [] },
            // Inside the cut-out gap: on the file, NOT on the timeline.
            { start: 3.0, end: 4.0, text: 'the bit that got cut', words: [] },
            { start: 5.0, end: 7.0, text: 'closing line', words: [] },
          ],
        },
        [OTHER]: {
          text: '', language: 'en', model: 'test', source: OTHER,
          segments: [{ start: 0.0, end: 2.0, text: 'broll voiceover', words: [] }],
        },
      },
    } as never);
  }

  it('15. stitches many clips and two files into ONE continuous, timeline-ordered list', async () => {
    seedBoth();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    const rows = Array.from(document.querySelectorAll('[data-chroma-transcript-row]'));
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('opening line'),
      expect.stringContaining('broll voiceover'),
      expect.stringContaining('closing line'),
    ]);
    // The speech inside the cut-out gap is on the FILE but not on the TIMELINE,
    // so it must not appear — listing it would seek to material that is not in
    // the edit.
    expect(document.body.textContent).not.toContain('the bit that got cut');
    // Each row reports the clip it plays from, so the three rows come from
    // three different clips rather than one file read three times.
    expect(rows.map((r) => r.getAttribute('data-chroma-transcript-clip'))).toEqual(['a1', 'b1', 'a2']);
  });

  it('16. seeks to the right TIMELINE frame for a row from the SECOND clip of the same file', async () => {
    seedBoth();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    const closing = document.querySelector<HTMLElement>('[data-chroma-transcript-row="2"]')!;
    actSync(() => closing.click());

    // 'closing line' starts at SOURCE second 5.0 = source frame 120, which is
    // clip a2's own in-point, and a2 sits at timeline frame 96. So: 96.
    // Reading the file's transcript without remapping would have said 120.
    expect(useEditorTimelineStore.getState().playhead).toBe(96);
  });

  it('17. counts many clips from ONE file as one transcription, not one per clip', async () => {
    // Nothing seeded: both files are untranscribed. SOURCE backs two clips and
    // OTHER backs one, so the offer must be TWO jobs, not three.
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    expect(document.body.textContent).toContain('0 of 2 files');
    expect(document.querySelector('[data-chroma-index-transcribe]')!.textContent).toContain('2');
    // The per-file progress list says which files, and that one of them is
    // shared by two clips.
    const sources = Array.from(document.querySelectorAll('[data-chroma-transcript-source]'));
    expect(sources.map((s) => s.getAttribute('data-chroma-transcript-source'))).toEqual([SOURCE, OTHER]);
    expect(sources[0].textContent).toContain('2 clips');
  });

  it('18. renders the file that IS done while another is still running', async () => {
    // The partial-progress case the owner asked for: no blocking on the slowest
    // file, and real per-file state rather than one opaque spinner.
    useMediaUnderstandingStore.setState({
      transcripts: {
        [OTHER]: {
          text: '', language: 'en', model: 'test', source: OTHER,
          segments: [{ start: 0.0, end: 2.0, text: 'broll voiceover', words: [] }],
        },
      },
      transcribing: { [SOURCE]: true },
    } as never);
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    // The done file's row is already readable…
    const rows = Array.from(document.querySelectorAll('[data-chroma-transcript-row]'));
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('broll voiceover');
    // …while the other reports its own in-flight state, by name.
    const pendingRow = document.querySelector(`[data-chroma-transcript-source="${SOURCE}"]`)!;
    expect(pendingRow.getAttribute('data-chroma-transcript-phase')).toBe('running');
    expect(pendingRow.textContent).toContain('transcribing');
    expect(document.body.textContent).toContain('1 of 2 files');
    // Nothing is startable, so no button is offered.
    expect(document.querySelector('[data-chroma-index-transcribe]')).toBeNull();
  });

  it('19. reports a failed file as failed, with its reason, and offers a retry', async () => {
    useMediaUnderstandingStore.setState({
      transcriptErrors: { [SOURCE]: 'sidecar not running', [OTHER]: 'sidecar not running' },
    } as never);
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    expect(
      document.querySelector(`[data-chroma-transcript-source="${SOURCE}"]`)!.getAttribute('data-chroma-transcript-phase'),
    ).toBe('error');
    expect(document.body.textContent).toContain('sidecar not running');
    // A failure is not sticky in the store, so the button is the retry.
    expect(document.querySelector('[data-chroma-index-transcribe]')).toBeTruthy();
  });

  it('20. the Transcribe button starts one job per FILE', async () => {
    const started: string[] = [];
    const real = useMediaUnderstandingStore.getState().startTranscript;
    useMediaUnderstandingStore.setState({
      startTranscript: (path: string) => {
        started.push(path);
        return 'running' as const;
      },
    } as never);

    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');
    actSync(() => document.querySelector<HTMLElement>('[data-chroma-index-transcribe]')!.click());

    // Two files, three clips — two jobs. The dedupe is the point.
    expect(started).toEqual([SOURCE, OTHER]);
    useMediaUnderstandingStore.setState({ startTranscript: real } as never);
  });

  it('21. accents the selected clip’s rows without filtering anything out', async () => {
    seedBoth();
    setUp(multiClip(), { selection: [{ track: 0, id: 'a2' }] });
    await mountPanel();
    await showView('Transcript');

    // Selection is a LOCATOR, not a gate and not a filter: all three rows are
    // still listed.
    const rows = Array.from(document.querySelectorAll('[data-chroma-transcript-row]'));
    expect(rows.length).toBe(3);
    expect(rows[2].getAttribute('data-chroma-transcript-clip')).toBe('a2');
    expect(rows[2].className).toContain('border-accent');
    expect(rows[0].className).not.toContain('border-accent');
  });

  /** The same multi-clip timeline, but with real per-word timings — the shape
   *  `wordTimestamps: true` produces, and what the word highlight needs. */
  function seedWords(): void {
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE]: {
          text: '', language: 'en', model: 'test', source: SOURCE,
          segments: [
            {
              start: 0.0, end: 2.0, text: 'opening line',
              words: [
                { word: 'opening', start: 0.0, end: 1.0 },  // timeline 0..24
                { word: ' line', start: 1.5, end: 2.0 },    // timeline 36..48
              ],
            },
          ],
        },
        [OTHER]: {
          text: '', language: 'en', model: 'test', source: OTHER,
          segments: [
            {
              start: 0.0, end: 2.0, text: 'broll voiceover',
              words: [
                { word: 'broll', start: 0.0, end: 1.0 },      // timeline 48..72
                { word: ' voiceover', start: 1.0, end: 2.0 }, // timeline 72..96
              ],
            },
          ],
        },
      },
    } as never);
  }

  it('23. renders one clickable button per WORD, keeping the model’s own spacing', async () => {
    seedWords();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    const firstRow = document.querySelector('[data-chroma-transcript-row="0"]')!;
    const words = Array.from(firstRow.querySelectorAll('[data-chroma-transcript-word]'));
    // The button holds the WORD; its leading space sits outside it, so the
    // active-word highlight box hugs the word instead of butting against the
    // previous one (a real-Chromium finding — see the component's own note).
    expect(words.map((w) => w.textContent)).toEqual(['opening', 'line']);
    // Every word is a real focusable button, not a span with a click handler.
    expect(words.every((w) => w.tagName === 'BUTTON')).toBe(true);
    // …and the spacing still survives, so the line reads as prose.
    expect(firstRow.textContent).toContain('opening line');
  });

  it('24. clicking a WORD seeks to that word’s own timeline frame', async () => {
    seedWords();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    // ' line' is source second 1.5 on clip a1 (source_start 0, start_frame 0):
    // 1.5 x 24 = frame 36. Clicking the ROW would have said 0, so this also
    // proves the word click is not just bubbling up to the row handler.
    const word = document
      .querySelector('[data-chroma-transcript-row="0"]')!
      .querySelectorAll<HTMLElement>('[data-chroma-transcript-word]')[1];
    actSync(() => word.click());

    expect(useEditorTimelineStore.getState().playhead).toBe(36);
  });

  it('25. clicking a word on the SECOND file seeks through that clip’s own offset', async () => {
    seedWords();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    // ' voiceover' is source second 1.0 of OTHER, on clip b1 which sits at
    // timeline frame 48: 48 + 24 = 72. Reading the file's own transcript
    // without remapping would have said 24.
    const word = document
      .querySelector('[data-chroma-transcript-row="1"]')!
      .querySelectorAll<HTMLElement>('[data-chroma-transcript-word]')[1];
    actSync(() => word.click());

    expect(useEditorTimelineStore.getState().playhead).toBe(72);
  });

  it('26. clicking the row still seeks to the row’s start', async () => {
    seedWords();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');
    actSync(() => useEditorTimelineStore.setState({ playhead: 999 }));

    const rowSeek = document.querySelector<HTMLElement>('[data-chroma-transcript-row-seek="1"]')!;
    actSync(() => rowSeek.click());

    // Row 1 is the broll clip, which starts at timeline frame 48.
    expect(useEditorTimelineStore.getState().playhead).toBe(48);
  });

  it('27. highlights the single WORD under the playhead, not just its row', async () => {
    seedWords();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    // Frame 40 is inside ' line' (36..48) of row 0.
    actSync(() => useEditorTimelineStore.setState({ playhead: 40 }));
    await waitFrames(1);

    const words = document
      .querySelector('[data-chroma-transcript-row="0"]')!
      .querySelectorAll('[data-chroma-transcript-word]');
    expect(words[1].hasAttribute('data-chroma-transcript-word-active')).toBe(true);
    expect(words[0].hasAttribute('data-chroma-transcript-word-active')).toBe(false);
    // …and the containing row is highlighted too — the two are not exclusive.
    expect(
      document.querySelector('[data-chroma-transcript-row="0"]')!.hasAttribute('data-chroma-transcript-active'),
    ).toBe(true);
  });

  it('28. highlights the row but NO word during a pause between words', async () => {
    seedWords();
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    // Frame 30 is inside row 0 (0..48) but between 'opening' (ends 24) and
    // ' line' (starts 36). Highlighting a word there would be a lie.
    actSync(() => useEditorTimelineStore.setState({ playhead: 30 }));
    await waitFrames(1);

    expect(
      document.querySelector('[data-chroma-transcript-row="0"]')!.hasAttribute('data-chroma-transcript-active'),
    ).toBe(true);
    expect(document.querySelectorAll('[data-chroma-transcript-word-active]').length).toBe(0);
  });

  it('29. falls back to plain text when the transcript has no word timings', async () => {
    seedBoth(); // these fixtures carry `words: []`
    setUp(multiClip());
    await mountPanel();
    await showView('Transcript');

    const firstRow = document.querySelector('[data-chroma-transcript-row="0"]')!;
    expect(firstRow.querySelectorAll('[data-chroma-transcript-word]').length).toBe(0);
    expect(firstRow.textContent).toContain('opening line');
    // Row-level seek still works without word timings.
    actSync(() => document.querySelector<HTMLElement>('[data-chroma-transcript-row-seek="0"]')!.click());
    expect(useEditorTimelineStore.getState().playhead).toBe(0);
  });

  it('22. says the timeline has nothing to transcribe rather than showing an empty list', async () => {
    setUp({ ...multiClip(), tracks: [{ kind: 'video', clips: [] }] } as Timeline);
    await mountPanel();
    await showView('Transcript');

    expect(document.querySelectorAll('[data-chroma-transcript-row]').length).toBe(0);
    expect(document.body.textContent).toContain('Nothing to transcribe yet');
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
    setUp(fixture());
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
    setUp(fixture());
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

  it('30. ticks that stay inside one WORD cost ZERO commits (D-329)', async () => {
    // The word highlight raises how OFTEN the highlight legitimately moves —
    // once per spoken word instead of once per sentence — but must not change
    // the property that a tick which moves nothing costs nothing. Two long
    // words with a wide gap, so the ticks below stay inside the first.
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE]: {
          text: '', language: 'en', model: 'test', source: SOURCE,
          segments: [
            {
              start: 1.0, end: 21.0, text: 'a long uninterrupted take',
              words: [
                // source 1..11s -> timeline 48..288 on the fixture clip.
                { word: 'first', start: 1.0, end: 11.0 },
                { word: ' second', start: 11.0, end: 21.0 },
              ],
            },
          ],
        },
      },
    } as never);
    setUp(fixture());
    const commits = await mountProfiled();
    await showView('Transcript');

    // Park well inside the first word, then tick without leaving it.
    actSync(() => useEditorTimelineStore.setState({ playhead: 100 }));
    commits.length = 0;

    for (let i = 1; i <= TICKS; i++) {
      actSync(() => useEditorTimelineStore.setState({ playhead: 100 + i }));
    }
    expect(commits.length).toBe(0);
  });

  it('31. a tick that crosses a WORD boundary costs exactly one commit (D-329)', async () => {
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE]: {
          text: '', language: 'en', model: 'test', source: SOURCE,
          segments: [
            {
              start: 1.0, end: 21.0, text: 'a long uninterrupted take',
              words: [
                { word: 'first', start: 1.0, end: 11.0 },   // timeline 48..288
                { word: ' second', start: 11.0, end: 21.0 }, // timeline 288..528
              ],
            },
          ],
        },
      },
    } as never);
    setUp(fixture());
    const commits = await mountProfiled();
    await showView('Transcript');

    actSync(() => useEditorTimelineStore.setState({ playhead: 287 }));
    commits.length = 0;

    // Crossing from 'first' into ' second' — the ROW does not change here, so
    // this is specifically the word boundary being detected, and it proves the
    // word highlight rides the SAME subscription rather than a second one
    // (a second reactive selector would score TICKS on the loop below).
    actSync(() => useEditorTimelineStore.setState({ playhead: 288 }));
    expect(commits.length).toBe(1);

    commits.length = 0;
    for (let i = 289; i < 289 + TICKS; i++) {
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
