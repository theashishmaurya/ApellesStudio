// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the Recut library (D-318).
 *
 * **Why this tier.** The interesting claims about this panel are not about the
 * detectors — those are `apelles-speech`'s 33 Rust tests and its live model
 * check. They are about what the panel does with what it is handed: that
 * nothing is ticked by default, that a retake group's suggested keeper is
 * *excluded* from a bulk tick rather than included, that the Cut button says
 * how many ranges it will remove, and that cutting produces exactly ONE store
 * op (and therefore one undo entry) no matter how many candidates were ticked.
 * Those are all only true of the wired-up component, so this mounts the real
 * thing with the real store and drives it with real clicks.
 *
 * **Tier and its honest limits.** jsdom, with `invoke` stubbed to return fixed
 * detector payloads: it proves the handlers, the candidate list and the op that
 * comes out of them. It does not prove a real WKWebView delivers the click, and
 * it does not prove the VAD found the right spans — the stub decides those.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { actSync, captureConsole, createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const SOURCE = '/fixtures/talk.mov';

/** Two silences inside a 20s clip, in absolute SOURCE seconds. */
const SILENCES = {
  silences: [
    { start_secs: 4.0, end_secs: 6.0, duration_secs: 2.0 },
    { start_secs: 12.0, end_secs: 13.5, duration_secs: 1.5 },
  ],
};

/** One group of three takes of the same line; the LAST is the suggested keep. */
const RETAKES = {
  groups: [
    {
      keep: 2,
      similarity: 0.93,
      members: [
        { index: 0, start_secs: 1.0, end_secs: 2.5, text: 'The cat sat—' },
        { index: 1, start_secs: 3.0, end_secs: 5.0, text: 'The cat sat on the mat.' },
        { index: 2, start_secs: 6.0, end_secs: 8.0, text: 'The cat sat on the mat!' },
      ],
    },
  ],
};

/** D-382 — what the stubbed coverage gate answers for every detector group.
 *  `accepted` by default, so the pre-D-382 tests see the list they always did;
 *  a test that sets a refusal sees the gate's refusal reach the row. */
const gate = vi.hoisted(() => ({
  answer: { verdict: 'accepted', takeWords: [] } as Record<string, unknown>,
  calls: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_detect_silences: () => SILENCES,
    chroma_detect_retakes: () => RETAKES,
    chroma_gate_detected_retakes: (args) => {
      gate.calls += 1;
      return { groups: ((args?.groups ?? []) as unknown[]).map(() => gate.answer) };
    },
    chroma_timeline_set: () => undefined,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useEditorTimelineStore } from './timelineStore';
import {
  darkKey,
  recoveryKey,
  useMediaUnderstandingStore,
} from './mediaUnderstandingStore';
import { RecutPanel } from './RecutPanel';
import { recoveryWindows } from './darkRegions';
import { spanToFrames } from './recut';
import { buildWordViewInput, viewBasisKey } from './retakeWordView';
import type { ProposalGroupView, ProposalStatus, ProposalTake, RetakeProposalSet } from './retakeProposals';

/** One 480-frame (20s @24fps) talking-head clip on one video track. */
function fixture() {
  return {
    id: 'tl',
    name: 'recut fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'a',
            name: 'talk',
            source_path: SOURCE,
            source_start: 0,
            duration: 480,
            source_len: 480,
            source_fps: 24,
            start_frame: 0,
          },
        ],
        gain: 1,
        sync_locked: false,
      },
    ],
    markers: [],
  };
}

let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

const panel = () => document.querySelector<HTMLElement>('[data-chroma-panel="edit-recut"]');
const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-chroma-recut-candidate]'));
const boxes = () =>
  rows().map((r) => r.querySelector<HTMLInputElement>('input[type="checkbox"]')!);

async function click(el: Element | null): Promise<void> {
  expect(el, 'the element being clicked exists').not.toBeNull();
  actSync(() => (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await waitFrames(2);
}

async function mountPanel(
  selected: boolean,
  timeline: unknown = fixture(),
  selectedId = 'a',
): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: timeline as never,
      openProjectKey: '/projects/recut.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: selected ? [{ track: 0, id: selectedId }] : [],
      selectedGap: null,
    }),
  );
  ui = mount(React.createElement(RecutPanel), { strictMode: true });
  await waitFrames(2);
}

beforeEach(() => {
  console_ = captureConsole();
  gate.answer = { verdict: 'accepted', takeWords: [] };
  gate.calls = 0;
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  ui?.unmount();
  ui = null;
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
    }),
  );
  useMediaUnderstandingStore.getState().clear();
  expect(errors, `console.error fired:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

describe('RecutPanel (D-318)', () => {
  /** **Changed deliberately by D-342 (fixes B-216).** This used to assert
   *  "Select one clip" and a hidden detector — which was the human half of the
   *  same hole: a panel that only ever scans the clip you are looking at is
   *  how whole stretches of a 75-clip timeline go unchecked. With nothing
   *  selected and exactly ONE video track there is no ambiguity about which
   *  track a scan would mean, so the panel offers it in `track` scope instead
   *  of refusing. The refusal is kept for the case that is genuinely
   *  ambiguous, which the next test covers. */
  it('1. with nothing selected and one video track, scans the WHOLE track rather than refusing', async () => {
    await mountPanel(false);
    expect(panel()).not.toBeNull();
    expect(q('[data-chroma-recut-find-silences]')).not.toBeNull();
    expect(q('[data-chroma-recut-scope-option="track"]')?.getAttribute('aria-checked')).toBe('true');
    // …and "this clip" is not offered, because there is no clip to mean.
    expect(q('[data-chroma-recut-scope-option="clip"]')).toHaveProperty('disabled', true);
  });

  /** Two video tracks and no selection IS ambiguous — a scan would have to
   *  guess which one, and guessing where to cut is not a thing this panel
   *  does. */
  it('1b. still asks for a selection when which track to scan is genuinely ambiguous', async () => {
    const tl = fixture();
    tl.tracks.push({ kind: 'video', clips: [], gain: 1, sync_locked: false });
    await mountPanel(false, tl);
    expect(panel()!.textContent).toContain('Select a clip');
    expect(q('[data-chroma-recut-find-silences]')).toBeNull();
  });

  it('2. offers both detectors once exactly one clip is selected', async () => {
    await mountPanel(true);
    expect(q('[data-chroma-recut-find-silences]')).not.toBeNull();
    expect(q('[data-chroma-recut-find-retakes]')).not.toBeNull();
  });

  it('3. lists the detected silences, and ticks NONE of them by default', async () => {
    await mountPanel(true);
    await click(q('[data-chroma-recut-find-silences]'));

    expect(rows()).toHaveLength(2);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    // Nothing ticked means nothing to cut, and the button says so.
    expect(q('[data-chroma-recut-cut]')!.textContent).toContain('Nothing ticked');
    expect((q('[data-chroma-recut-cut]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('4. cuts only the ticked range, as ONE op, and converts seconds to the right frames', async () => {
    await mountPanel(true);
    await click(q('[data-chroma-recut-find-silences]'));

    actSync(() => boxes()[0].click());
    await waitFrames(2);
    expect(q('[data-chroma-recut-cut]')!.textContent).toContain('Cut 1 range');

    await click(q('[data-chroma-recut-cut]'));

    // 4.0s–6.0s at 24fps is timeline frames 96–144, so 48 frames come out of a
    // 480-frame clip and the remainder ripples up to meet it.
    const clips = useEditorTimelineStore.getState().timeline!.tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips[0].start_frame).toBe(0);
    expect(clips[0].duration).toBe(96);
    expect(clips[1].start_frame).toBe(96);
    expect(clips[1].source_start).toBe(144);
  });

  it('5. cutting several ticked ranges is still a single history entry', async () => {
    await mountPanel(true);
    await click(q('[data-chroma-recut-find-silences]'));

    actSync(() => {
      boxes()[0].click();
      boxes()[1].click();
    });
    await waitFrames(2);
    expect(q('[data-chroma-recut-cut]')!.textContent).toContain('Cut 2 ranges');

    const { useHistoryStore } = await import('@apelles/history');
    const before = useHistoryStore.getState().undoStack.length;
    await click(q('[data-chroma-recut-cut]'));
    const after = useHistoryStore.getState().undoStack.length;

    expect(after - before, 'two ranges, one undo entry').toBe(1);
  });

  it('6. shows each retake take with its words and marks the suggested keeper', async () => {
    await mountPanel(true);
    actSync(() =>
      useMediaUnderstandingStore.setState({
        transcripts: {
          [SOURCE]: {
            text: 'x',
            language: 'en',
            model: 'test',
            source: SOURCE,
            segments: [
              { start: 1.0, end: 2.5, text: 'The cat sat—', words: [] },
              { start: 3.0, end: 5.0, text: 'The cat sat on the mat.', words: [] },
              { start: 6.0, end: 8.0, text: 'The cat sat on the mat!', words: [] },
            ],
          },
        },
      } as never),
    );
    await click(q('[data-chroma-recut-find-retakes]'));

    expect(rows()).toHaveLength(3);
    const text = panel()!.textContent ?? '';
    expect(text).toContain('The cat sat—');
    expect(text).toContain('Take 1 of 3');
    expect(text).toContain('suggested keep');
  });

  it('7. "tick all suggested" EXCLUDES the keeper — it never proposes deleting every take', async () => {
    await mountPanel(true);
    actSync(() =>
      useMediaUnderstandingStore.setState({
        transcripts: {
          [SOURCE]: {
            text: 'x',
            language: 'en',
            model: 'test',
            source: SOURCE,
            segments: [
              { start: 1.0, end: 2.5, text: 'The cat sat—', words: [] },
              { start: 3.0, end: 5.0, text: 'The cat sat on the mat.', words: [] },
              { start: 6.0, end: 8.0, text: 'The cat sat on the mat!', words: [] },
            ],
          },
        },
      } as never),
    );
    await click(q('[data-chroma-recut-find-retakes]'));
    await click(q('[data-chroma-recut-tick-suggested]'));

    const checked = boxes().map((b) => b.checked);
    expect(checked, 'the last take is the keeper and must stay').toEqual([true, true, false]);
  });

  it('8. says so rather than guessing when no transcript exists yet', async () => {
    await mountPanel(true);
    // A transcript already in flight — the state this notice is about. (Set
    // directly rather than letting the panel start one, so the assertion is
    // about the panel and not about the sidecar stub.)
    actSync(() => useMediaUnderstandingStore.setState({ transcribing: { [SOURCE]: true } } as never));
    await click(q('[data-chroma-recut-find-retakes]'));

    expect(rows()).toHaveLength(0);
    expect(q('[data-chroma-recut-notice]')!.textContent).toContain('Transcribing');
  });

  // B-188/D-321 — the panel used to stop dead here and tell the human to come
  // back and click again, which is a poll implemented by a person. The run now
  // survives the wait and finishes itself.
  it('8b. picks a waiting retake run back up when the transcript finally lands', async () => {
    await mountPanel(true);
    actSync(() => useMediaUnderstandingStore.setState({ transcribing: { [SOURCE]: true } } as never));
    await click(q('[data-chroma-recut-find-retakes]'));
    expect(rows(), 'nothing to show while the words are still coming').toHaveLength(0);

    actSync(() =>
      useMediaUnderstandingStore.setState({
        transcribing: {},
        transcripts: {
          [SOURCE]: {
            text: 'x',
            language: 'en',
            model: 'test',
            source: SOURCE,
            segments: [
              { start: 1.0, end: 2.5, text: 'The cat sat—', words: [] },
              { start: 3.0, end: 5.0, text: 'The cat sat on the mat.', words: [] },
              { start: 6.0, end: 8.0, text: 'The cat sat on the mat!', words: [] },
            ],
          },
        },
      } as never),
    );
    await waitFrames(3);

    expect(rows(), 'the run resumed on its own — no second click').toHaveLength(3);
  });

  // B-188/D-321 — the defect that made this whole pass necessary: a detection
  // that outlives the caller waiting on it must leave its answer somewhere
  // retrievable. Here the store holds it and the panel reads it back.
  it('8c. a detection that finishes after the panel gave up is still retrievable', async () => {
    await mountPanel(true);
    await click(q('[data-chroma-recut-find-silences]'));
    await waitFrames(2);
    const key = Object.keys(useMediaUnderstandingStore.getState().silences)[0];

    expect(key, 'the finished detection is held in the store, keyed').toBeTruthy();
    expect(
      useMediaUnderstandingStore.getState().silenceDetectionStatus(key),
      'and reports done with its result, for any later poller',
    ).toMatchObject({ phase: 'done' });
  });


  // D-349 (fixes the transcription half of B-216) — the panel's half of the
  // dark-region recovery. Two claims, and the second is the one that matters
  // for trust: the grouping reads the speech the ASR silently dropped, and the
  // panel SAYS it did. Content appearing in a recut list that was not in the
  // transcript five minutes ago is exactly the thing a human must not be
  // blindsided by.
  it('8d. scans for dropped speech, groups the recovered lines, and says it did', async () => {
    await mountPanel(true);

    // A transcript WITH word timings — the detector is defined against words,
    // so this is what makes a scan possible at all (the fixtures above have
    // none, which is why they take the degrade path and never scan).
    const words = [
      { word: ' The', start: 1.0, end: 1.4 },
      { word: ' cat', start: 1.4, end: 1.8 },
      { word: ' sat', start: 6.0, end: 6.4 },
      { word: ' down', start: 6.4, end: 6.8 },
    ];
    const regions = [
      {
        start_secs: 9,
        end_secs: 11,
        duration_secs: 2,
        stretch_start_secs: 6.8,
        stretch_end_secs: 14.0,
        stretch_speech_secs: 3,
        rms_peak: 0.2,
      },
      // D-387 — a second region in the same stretch that the re-read puts no
      // words over: the panel must say where the transcript is still blind.
      {
        start_secs: 12.5,
        end_secs: 13.5,
        duration_secs: 1,
        stretch_start_secs: 6.8,
        stretch_end_secs: 14.0,
        stretch_speech_secs: 3,
        rms_peak: 0.2,
      },
    ];
    // Planned by the real planner, so the window plan can change without this
    // test silently missing the cache.
    const [window] = recoveryWindows(regions, 0, 20);
    actSync(() =>
      useMediaUnderstandingStore.setState({
        transcripts: {
          [SOURCE]: {
            text: 'The cat sat down',
            language: 'en',
            model: 'test',
            source: SOURCE,
            segments: [
              { start: 1.0, end: 1.8, text: 'The cat', words: words.slice(0, 2) },
              { start: 6.0, end: 6.8, text: 'sat down', words: words.slice(2) },
            ],
            words,
          },
        },
        // The scan's answer and the re-read's, both already landed — this test
        // is about what the PANEL does with them, not about the poll loops,
        // which `darkRecovery.test.ts` and the store cover.
        dark: {
          [darkKey({
            path: SOURCE,
            startSecs: 0,
            durationSecs: 20,
            words: words.map((w) => ({ start: w.start, end: w.end })),
          })]: {
            source: SOURCE,
            start_secs: 0,
            duration_secs: 20,
            analysed_secs: 20,
            min_dark_secs: 1.2,
            max_word_secs: 2.0,
            model: 'silero_vad_v6.2.1.onnx',
            regions,
            rms_floor: 0.1,
            calibration_spans: 4,
            gated_out: 0,
            speech_secs: 12,
            covered_secs: 8,
          },
        },
        recoveries: {
          [recoveryKey(SOURCE, window)]: {
            window,
            segments: [
              {
                start: 9.2,
                end: 11.5,
                text: 'The cat sat on the mat.',
                words: [{ word: ' The', start: 9.2, end: 9.6 }],
              },
            ],
          },
        },
      } as never),
    );

    await click(q('[data-chroma-recut-find-retakes]'));

    // The grouping ran (the stub returns the same three takes either way) and
    // the panel volunteers where the extra line came from.
    expect(rows()).toHaveLength(3);
    const notice = q('[data-chroma-recut-notice]')!.textContent ?? '';
    expect(notice, `the panel must disclose the splice: ${notice}`).toContain('Recovered 1 line');
    expect(notice).toContain('silently skipped');
    expect(notice).toContain('1 stretch of speech-like sound could not be read by any pass (source 0:12.5–0:13.5)');
  });

  /** The degrade path, which every clip on a pre-D-349 cached transcript takes:
   *  no word timings means no scan is possible, and that must cost the human
   *  nothing — the retakes still come back. */
  it('8e. still groups normally when the transcript has no word timings to scan against', async () => {
    await mountPanel(true);
    actSync(() =>
      useMediaUnderstandingStore.setState({
        transcripts: {
          [SOURCE]: {
            text: 'x',
            language: 'en',
            model: 'test',
            source: SOURCE,
            segments: [{ start: 1.0, end: 2.5, text: 'The cat sat—', words: [] }],
          },
        },
      } as never),
    );
    await click(q('[data-chroma-recut-find-retakes]'));

    expect(rows()).toHaveLength(3);
    expect(q('[data-chroma-recut-notice]')?.textContent ?? '').not.toContain('Recovered');
  });

  it('9. clears stale candidates after a cut, since their frame numbers moved', async () => {
    await mountPanel(true);
    await click(q('[data-chroma-recut-find-silences]'));
    actSync(() => boxes()[0].click());
    await waitFrames(2);
    await click(q('[data-chroma-recut-cut]'));

    expect(rows()).toHaveLength(0);
    expect(q('[data-chroma-recut-notice]')!.textContent).toContain('one undo reverses all of it');
  });

  it('10. refuses on a locked track and says why, without touching the timeline', async () => {
    await mountPanel(true);
    await click(q('[data-chroma-recut-find-silences]'));
    actSync(() => boxes()[0].click());
    await waitFrames(2);

    actSync(() => {
      const tl = structuredClone(useEditorTimelineStore.getState().timeline);
      tl!.tracks[0].locked = true;
      useEditorTimelineStore.setState({ timeline: tl });
    });
    const before = useEditorTimelineStore.getState().timeline;

    await click(q('[data-chroma-recut-cut]'));

    expect(useEditorTimelineStore.getState().timeline).toBe(before);
    expect(q('[data-chroma-recut-error]')!.textContent).toContain('locked');
  });

  /** D-342 (fixes B-216) — the human half of the whole-track sweep. The claim
   *  worth testing is not that a loop runs, but that a scan the user started
   *  from ONE selected clip covers the clips they did not select, labels which
   *  clip each candidate came from, and cuts them all as one edit. */
  describe('whole-track scope (D-342, fixes B-216)', () => {
    /** Three back-to-back 5s clips off one source, the shape a first silence
     *  pass leaves behind — the shape B-216 was found on.
     *
     *  The stub VAD answers with the SAME absolute source spans whatever range
     *  it is handed (4.0-6.0s and 12.0-13.5s), and `spanToFrames` clamps each
     *  to the clip it came from, so exactly one of the two lands inside each
     *  of these three windows: clip 0 (0-5s) keeps 4-5, clip 1 (5-10s) keeps
     *  5-6, clip 2 (10-15s) keeps 12-13.5. One candidate per clip, which is
     *  what makes "did the clips I never selected get asked about?" readable
     *  straight off the row count. */
    function multiClip() {
      const tl = fixture();
      tl.tracks[0].clips = [0, 1, 2].map((i) => ({
        id: `c${i}`,
        name: `take ${i}`,
        source_path: SOURCE,
        source_start: i * 120,
        duration: 120,
        source_len: 360,
        source_fps: 24,
        start_frame: i * 120,
      }));
      return tl;
    }

    it('scans every clip on the track, not only the selected one', async () => {
      await mountPanel(true, multiClip(), 'c0');
      await click(q('[data-chroma-recut-scope-option="track"]'));
      await click(q('[data-chroma-recut-find-silences]'));

      // One candidate from each of the three clips — including the two the
      // user never selected, which is the whole of B-216.
      expect(rows()).toHaveLength(3);
      expect(rows().map((r) => r.textContent!.match(/#(\d+)/)?.[1])).toEqual(['0', '1', '2']);
    });

    it('names the clip each candidate came from, so a reviewer knows where a cut lands', async () => {
      await mountPanel(true, multiClip(), 'c0');
      await click(q('[data-chroma-recut-scope-option="track"]'));
      await click(q('[data-chroma-recut-find-silences]'));

      expect(rows()[0].textContent).toContain('take 0');
      expect(rows().at(-1)!.textContent).toContain('take 2');
    });

    it('still scans only the selected clip when the scope is left alone (the default is unchanged)', async () => {
      await mountPanel(true, multiClip(), 'c1');
      await click(q('[data-chroma-recut-find-silences]'));

      expect(rows()).toHaveLength(1);
      expect(rows()[0].textContent).toContain('#1');
    });

    /** Cutting across several clips is still ONE op and therefore one undo —
     *  the invariant test 5 pins for one clip, which a multi-clip scan must
     *  not quietly break. */
    it('cuts ranges from several clips as a single op, on the scanned track', async () => {
      await mountPanel(true, multiClip(), 'c0');
      await click(q('[data-chroma-recut-scope-option="track"]'));
      await click(q('[data-chroma-recut-find-silences]'));

      actSync(() => {
        boxes()[0].click();
        boxes()[2].click();
      });
      await waitFrames(2);

      const before = useEditorTimelineStore.getState().timeline;
      await click(q('[data-chroma-recut-cut]'));
      const after = useEditorTimelineStore.getState().timeline;

      expect(after).not.toBe(before);
      expect(q('[data-chroma-recut-notice]')!.textContent).toContain('Cut 2 ranges');
      expect(q('[data-chroma-recut-notice]')!.textContent).toContain('one undo');
    });

    /** A generated clip has no audio; it must be skipped rather than failing
     *  the scan — the same `sweepTargets` rule the MCP sweep follows. */
    it('skips a generated clip without failing the whole scan', async () => {
      const tl = multiClip();
      tl.tracks[0].clips.splice(1, 0, {
        id: 'title',
        name: 'Title',
        source_path: null,
        source_start: 0,
        duration: 48,
        source_len: 48,
        start_frame: 360,
      });
      await mountPanel(true, tl, 'c0');
      await click(q('[data-chroma-recut-scope-option="track"]'));
      await click(q('[data-chroma-recut-find-silences]'));

      // All three real clips answered; the title contributed nothing and broke
      // nothing — and the indices skip over it rather than renumbering.
      expect(rows().map((r) => r.textContent!.match(/#(\d+)/)?.[1])).toEqual(['0', '2', '3']);
      expect(q('[data-chroma-recut-error]')).toBeNull();
    });
  });
});

/**
 * D-380 step 2 — the MCP client's proposals, reviewed in this same list. The
 * store is seeded the way `editor_propose_retakes` writes it; what is on
 * trial is the review surface: client rows arrive unticked, a refused group
 * cannot be ticked until a listener unlocks it, an AI-confirmed group shows
 * the AI's reasons with the words marked, "tick all suggested" takes only
 * verified groups, a cut is one op, and a timeline that moved since the AI
 * read it locks the rows behind a banner.
 */
describe('RecutPanel — client proposals (D-380 step 2)', () => {
  const WORDS = 'final bin final bill the cat sat the cat sat'.split(' ');

  /** One untrimmed clip's transcript, a word every 0.5 s. */
  function seedTranscript(): void {
    const words = WORDS.map((word, i) => ({ word: ` ${word}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
    actSync(() =>
      useMediaUnderstandingStore.setState({
        transcripts: {
          [SOURCE]: {
            text: WORDS.join(' '),
            language: 'en',
            model: 'test',
            source: SOURCE,
            segments: [{ start: 0, end: words[words.length - 1].end, text: WORDS.join(' '), words }],
            words,
          },
        },
      } as never),
    );
  }

  const clip = () => fixture().tracks[0].clips[0] as never;

  function take(first: number, last: number, keep: boolean): ProposalTake {
    const span = spanToFrames(clip(), first * 0.5, last * 0.5 + 0.4, 24);
    const seg = [{ clip: 0, clipId: 'a', span }];
    return {
      first,
      last,
      keep,
      text: WORDS.slice(first, last + 1).join(' '),
      words: WORDS.slice(first, last + 1).map((word, i) => ({ index: first + i, word })),
      startSecs: first * 0.5,
      endSecs: last * 0.5 + 0.4,
      segments: seg,
      extent: seg,
    };
  }

  function group(
    index: number,
    status: ProposalStatus,
    takes: ProposalTake[],
    extra: Partial<ProposalGroupView> = {},
  ): ProposalGroupView {
    return {
      group: index,
      status,
      keep: takes.findIndex((t) => t.keep),
      takes,
      offending: [],
      justifications: {},
      unlockable: false,
      ...extra,
    };
  }

  /** The set the store would hold after one submission against the CURRENT
   *  view of the fixture — its basis key computed exactly as the op does. */
  function seedProposals(groups: ProposalGroupView[]): void {
    const st = useMediaUnderstandingStore.getState();
    const input = buildWordViewInput(
      useEditorTimelineStore.getState().timeline as never,
      0,
      st.transcripts,
      st.recoveriesFor,
    );
    if ('error' in input) throw new Error(input.error);
    const set: RetakeProposalSet = {
      track: 0,
      viewId: 'v1',
      basisKey: viewBasisKey(input),
      receivedAt: 0,
      groups,
    };
    actSync(() => useMediaUnderstandingStore.getState().setRetakeProposals(0, set));
  }

  const verified = () => group(0, 'verified', [take(4, 6, false), take(7, 9, true)]);
  const refused = () =>
    group(1, 'refused', [take(0, 1, false), take(2, 3, true)], {
      reason: { kind: 'content_absent_from_kept_take' },
      reasonText: 'a deleted take has words the kept take does not',
      offending: [{ index: 1, word: 'bin' }],
      unlockable: true,
    });
  const confirmed = () =>
    group(1, 'ai_confirmed', [take(0, 1, false), take(2, 3, true)], {
      offending: [{ index: 1, word: 'bin' }],
      justifications: { 1: 'misheard: the speaker says "bill" both times' },
    });

  const row = (id: string) => q<HTMLElement>(`[data-chroma-recut-candidate="${id}"]`);
  const box = (id: string) => row(id)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

  it('client rows join the list unticked, with their status', async () => {
    await mountPanel(false);
    seedTranscript();
    seedProposals([verified(), refused()]);
    await waitFrames(2);

    expect(q('[data-chroma-recut-client]')!.textContent).toContain('1 verified');
    expect(row('cli-0-0-0')!.getAttribute('data-chroma-recut-status')).toBe('verified');
    expect(row('cli-0-1-0')!.getAttribute('data-chroma-recut-source')).toBe('client');
    expect(rows().every((r) => !r.querySelector<HTMLInputElement>('input')!.checked)).toBe(true);
    expect(row('cli-0-0-1')!.textContent).toContain('keep');
  });

  it('a refused take cannot be ticked until a listener unlocks it, and says why', async () => {
    await mountPanel(false);
    seedTranscript();
    seedProposals([refused()]);
    await waitFrames(2);

    expect(box('cli-0-1-0').disabled).toBe(true);
    expect(row('cli-0-1-0')!.querySelector('[data-chroma-recut-reason]')!.textContent).toContain(
      'kept take does not',
    );
    expect(row('cli-0-1-0')!.querySelector('[data-chroma-recut-flagged="1"]')!.textContent).toBe('bin');
    await click(q('[data-chroma-recut-unlock="cli-0-1"]'));
    expect(box('cli-0-1-0').disabled).toBe(false);
  });

  it('every AI-confirmed reason is labelled word-then-index, even for words outside the take (B-251)', async () => {
    await mountPanel(false);
    seedTranscript();
    // Two offending "masses" (indices 1 and 3): index 3 is not in take 0's words.
    seedProposals([
      group(1, 'ai_confirmed', [take(0, 1, false), take(2, 3, true)], {
        offending: [
          { index: 1, word: ' masses' },
          { index: 3, word: ' masses' },
        ],
        justifications: { 1: 'first reason', 3: 'second reason' },
      }),
    ]);
    await waitFrames(2);

    const lines = [
      ...row('cli-0-1-0')!.querySelectorAll('[data-chroma-recut-justifications] > span'),
    ].map((l) => l.textContent);
    expect(lines).toEqual(['“masses” (#1) — first reason', '“masses” (#3) — second reason']);
  });

  it('an AI-confirmed take shows the reasons, marks the words, and is not bulk-ticked', async () => {
    await mountPanel(false);
    seedTranscript();
    seedProposals([verified(), confirmed()]);
    await waitFrames(2);

    const r = row('cli-0-1-0')!;
    expect(r.querySelector('[data-chroma-recut-justifications]')!.textContent).toContain('misheard');
    expect(r.querySelector('[data-chroma-recut-flagged="1"]')).not.toBeNull();
    expect(box('cli-0-1-0').disabled).toBe(false);

    await click(q('[data-chroma-recut-tick-suggested]'));
    expect(box('cli-0-0-0').checked, 'the verified deletion is ticked').toBe(true);
    expect(box('cli-0-0-1').checked, 'never the keeper').toBe(false);
    expect(box('cli-0-1-0').checked, 'never an AI-confirmed take in bulk').toBe(false);
  });

  it('cutting ticked client takes is ONE op, and the applied proposals are cleared', async () => {
    await mountPanel(false);
    seedTranscript();
    seedProposals([verified(), confirmed()]);
    await waitFrames(2);

    await click(q('[data-chroma-recut-tick-suggested]'));
    await click(box('cli-0-1-0'));
    expect(q('[data-chroma-recut-cut]')!.textContent).toContain('Cut 2 ranges');

    const { useHistoryStore } = await import('@apelles/history');
    const before = useHistoryStore.getState().undoStack.length;
    await click(q('[data-chroma-recut-cut]'));
    expect(useHistoryStore.getState().undoStack.length - before, 'one undo entry').toBe(1);
    expect(useMediaUnderstandingStore.getState().retakeProposals[0]).toBeUndefined();
    expect(q('[data-chroma-recut-notice]')!.textContent).toContain('Cut 2 ranges');
  });

  it('a timeline that moved since the AI read it locks the rows behind a banner', async () => {
    await mountPanel(false);
    seedTranscript();
    seedProposals([verified()]);
    await waitFrames(2);
    expect(q('[data-chroma-recut-client-stale]')).toBeNull();

    const tl = fixture();
    tl.tracks[0].clips[0].duration = 240; // trimmed: the view the AI read is gone
    actSync(() => useEditorTimelineStore.setState({ timeline: tl as never }));
    await waitFrames(2);

    expect(q('[data-chroma-recut-client-stale]')!.textContent).toContain('re-read');
    expect(box('cli-0-0-0').disabled).toBe(true);
  });
});

/** D-382 — the deterministic detector's groups go through the same gate. */
describe('RecutPanel — the detector behind the coverage gate (D-382)', () => {
  function seedSegments(): void {
    actSync(() =>
      useMediaUnderstandingStore.setState({
        transcripts: {
          [SOURCE]: {
            text: 'x',
            language: 'en',
            model: 'test',
            source: SOURCE,
            segments: [
              { start: 1.0, end: 2.5, text: 'The cat sat—', words: [] },
              { start: 3.0, end: 5.0, text: 'The cat sat on the mat.', words: [] },
              { start: 6.0, end: 8.0, text: 'The cat sat on the mat!', words: [] },
            ],
          },
        },
      } as never),
    );
  }

  it('a refused detector group is shown with its reason, untickable, and never bulk-ticked', async () => {
    gate.answer = {
      verdict: 'refused',
      takeWords: [],
      reason: { kind: 'content_absent_from_kept_take' },
      reasonText: 'a deleted take has words the kept take does not',
      offending: [{ index: 4, word: 'mat.' }],
      waivable: true,
    };
    await mountPanel(true);
    seedSegments();
    await click(q('[data-chroma-recut-find-retakes]'));

    expect(gate.calls).toBe(1);
    expect(rows()).toHaveLength(3);
    expect(rows().every((r) => r.getAttribute('data-chroma-recut-status') === 'refused')).toBe(true);
    expect(boxes().every((b) => b.disabled)).toBe(true);
    expect(rows()[0].querySelector('[data-chroma-recut-reason]')!.textContent).toContain('kept take does not');

    await click(q('[data-chroma-recut-tick-suggested]'));
    expect(boxes().every((b) => !b.checked)).toBe(true);

    // A person who listened may unlock it and tick it by hand.
    await click(q('[data-chroma-recut-unlock="ret-0-0"]'));
    expect(boxes()[0].disabled).toBe(false);
  });

  it('a verified detector group behaves as it always did, with its badge', async () => {
    await mountPanel(true);
    seedSegments();
    await click(q('[data-chroma-recut-find-retakes]'));
    expect(rows().every((r) => r.getAttribute('data-chroma-recut-status') === 'verified')).toBe(true);
    await click(q('[data-chroma-recut-tick-suggested]'));
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
  });
});
