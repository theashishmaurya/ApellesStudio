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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_detect_silences: () => SILENCES,
    chroma_detect_retakes: () => RETAKES,
    chroma_timeline_set: () => undefined,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { RecutPanel } from './RecutPanel';

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

async function mountPanel(selected: boolean): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture() as never,
      openProjectKey: '/projects/recut.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: selected ? [{ track: 0, id: 'a' }] : [],
      selectedGap: null,
    }),
  );
  ui = mount(React.createElement(RecutPanel), { strictMode: true });
  await waitFrames(2);
}

beforeEach(() => {
  console_ = captureConsole();
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
  it('1. asks for a selection before it will do anything', async () => {
    await mountPanel(false);
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('Select one clip');
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
    await click(q('[data-chroma-recut-find-retakes]'));

    expect(rows()).toHaveLength(0);
    expect(q('[data-chroma-recut-notice]')!.textContent).toContain('Transcribing');
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
});
