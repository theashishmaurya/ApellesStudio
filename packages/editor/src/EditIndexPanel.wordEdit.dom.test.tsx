// @vitest-environment jsdom
/**
 * D-420 — edit by text in the Index panel's transcript, real DOM: select words
 * and delete them, fillers highlighted for one-click review.
 *
 * Asserted, through the real `EditIndexPanel` and the real timeline store:
 * 1. a plain click on a word still seeks and selects nothing; ⇧-click selects
 *    from it to another word; Delete in the transcript cuts them as ONE undo
 *    step, and the transcript re-reads without them;
 * 2. ⌘-click toggles one word in and out of a selection;
 * 3. "Fillers" highlights uh/um and a repeat (solid) and "like" (dotted);
 *    "Select fillers" picks only the solid ones; deselecting one keeps it; the
 *    bar's Delete cuts the rest and says how much;
 * 4. Esc clears a selection without cutting.
 *
 * **Tier.** jsdom; the Rust word view is a stand-in (words by midpoint, the
 * `index_pieces` rule). The cut frames themselves are pinned in
 * `cutWords.test.ts` and `editByText.e2e.dom.test.tsx`; this is the wiring.
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

type Seg = { start: number; end: number; words: Array<{ word: string; start: number; end: number }> };

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_timeline_set: () => undefined,
    chroma_retake_word_view: (args) => {
      const sources = (args?.sources ?? []) as Array<{ path: string; segments: Seg[] }>;
      const pieces = (args?.pieces ?? []) as Array<{ source: number; startSecs: number; endSecs: number }>;
      const words: Array<{ text: string; start: number; end: number; piece: number }> = [];
      pieces.forEach((p, piece) => {
        for (const w of sources[p.source].segments.flatMap((s) => s.words)) {
          const mid = (w.start + w.end) / 2;
          if (mid >= p.startSecs && mid < p.endSecs) words.push({ text: w.word.trim(), start: w.start, end: w.end, piece });
        }
      });
      return {
        viewId: `v-${JSON.stringify(pieces)}-${words.length}`,
        totalWords: words.length,
        offset: 0,
        returned: words.length,
        nextOffset: null,
        text: '',
        ...(args?.includeWords ? { words } : {}),
      };
    },
  }),
}));

import { useHistoryStore } from '@apelles/history';
import { EditIndexPanel } from './EditIndexPanel';
import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore, type Transcript } from './mediaUnderstandingStore';
import { endFrame, type Timeline } from './timeline';

const SOURCE = '/media/vo.wav';

// "So um I like the the plan uh today" — one word every half second.
const WORDS = ['So', 'um', 'I', 'like', 'the', 'the', 'plan', 'uh', 'today'];

function transcript(): Transcript {
  const words = WORDS.map((w, i) => ({ word: ` ${w}`, start: 0.5 + i * 0.5, end: 0.5 + i * 0.5 + 0.3 }));
  return {
    text: WORDS.join(' '),
    language: 'en',
    model: 't',
    source: SOURCE,
    segments: [{ start: words[0].start, end: words[words.length - 1].end, text: WORDS.join(' '), words }],
    words,
  };
}

function fixture(): Timeline {
  return {
    id: 't',
    name: 'T',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'audio',
        clips: [{ id: 'vo', name: 'vo', source_path: SOURCE, source_start: 0, duration: 144, source_len: 2400, source_fps: 24, start_frame: 0 }],
        gain: 1,
        sync_locked: true,
      },
    ],
    markers: [],
  } as unknown as Timeline;
}

let ui: MountedComponent | null = null;
let restoreResizeObserver: () => void;
let console_: ReturnType<typeof captureConsole>;

const wordButtons = () => Array.from(document.querySelectorAll<HTMLElement>('[data-chroma-transcript-word]'));
const wordTexts = () => wordButtons().map((b) => b.textContent);
const clipEnd = () => {
  const tl = useEditorTimelineStore.getState().timeline as Timeline;
  return Math.max(...tl.tracks[0].clips.map((c) => endFrame(c, 24)));
};

function click(el: HTMLElement, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
  });
}

async function settle() {
  // The cut awaits the (stubbed) word view; let the promise chain and React flush.
  for (let i = 0; i < 4; i += 1) await waitFrames(2);
}

beforeEach(async () => {
  restoreResizeObserver = installResizeObserverStub();
  console_ = captureConsole();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/vo.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  actSync(() => useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript() } }));
  ui = mount(React.createElement(EditIndexPanel), { strictMode: false });
  await waitFrames(2);
  const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent?.includes('Transcript'));
  if (!tab) throw new Error('no Transcript tab');
  actSync(() => tab.click());
  await waitFrames(2);
});

afterEach(() => {
  console_.restore();
  ui?.unmount();
  ui = null;
  restoreResizeObserver();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [], playhead: 0 }));
  useMediaUnderstandingStore.getState().clear();
});

describe('Index panel transcript — edit by text (D-420)', () => {
  it('plain click seeks; shift-click selects a range; Delete cuts it as one undo step', async () => {
    expect(wordTexts()).toEqual(WORDS);
    click(wordButtons()[2]); // "I": seeks, selects nothing
    expect(useEditorTimelineStore.getState().playhead).toBe(36); // 1.5 s
    expect(document.querySelector('[data-chroma-transcript-word-selected]')).toBeNull();

    click(wordButtons()[3], { shiftKey: true }); // "I like"
    const selected = () => wordButtons().filter((b) => b.hasAttribute('data-chroma-transcript-word-selected')).map((b) => b.textContent);
    expect(selected()).toEqual(['I', 'like']);
    expect(document.querySelector('[data-chroma-transcript-selected-count]')?.textContent).toBe('2 selected');

    const depth = useHistoryStore.getState().undoStack.length;
    const before = clipEnd();
    actSync(() => {
      wordButtons()[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(wordTexts()).toEqual(['So', 'um', 'the', 'the', 'plan', 'uh', 'today']);
    expect(clipEnd()).toBeLessThan(before);
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    expect(document.querySelector('[data-chroma-transcript-edit-notice]')?.textContent).toMatch(/^Cut 2 words/);
  });

  it('cmd-click toggles single words; Esc clears without cutting', () => {
    click(wordButtons()[0], { metaKey: true });
    click(wordButtons()[6], { metaKey: true });
    click(wordButtons()[0], { metaKey: true });
    const selected = () => wordButtons().filter((b) => b.hasAttribute('data-chroma-transcript-word-selected')).map((b) => b.textContent);
    expect(selected()).toEqual(['plan']);
    actSync(() => {
      wordButtons()[6].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(selected()).toEqual([]);
    expect(wordTexts()).toEqual(WORDS);
  });

  it('highlights fillers, selects the solid ones for review, and the bar cuts what stays selected', async () => {
    const toggle = document.querySelector<HTMLElement>('[data-chroma-transcript-fillers-toggle]')!;
    expect(toggle.textContent).toBe('Fillers 4');
    click(toggle);
    const marks = wordButtons()
      .filter((b) => b.hasAttribute('data-chroma-transcript-word-filler'))
      .map((b) => [b.textContent, b.getAttribute('data-chroma-transcript-word-filler')]);
    expect(marks).toEqual([
      ['um', 'filler'],
      ['like', 'maybe'],
      ['the', 'repeat'],
      ['uh', 'filler'],
    ]);

    click(document.querySelector<HTMLElement>('[data-chroma-transcript-select-fillers]')!);
    const selected = () => wordButtons().filter((b) => b.hasAttribute('data-chroma-transcript-word-selected')).map((b) => b.textContent);
    expect(selected()).toEqual(['um', 'the', 'uh']); // "like" is only highlighted
    click(wordButtons()[7], { metaKey: true }); // review: keep this "uh"
    expect(selected()).toEqual(['um', 'the']);

    click(document.querySelector<HTMLElement>('[data-chroma-transcript-cut]')!);
    await settle();
    expect(wordTexts()).toEqual(['So', 'I', 'like', 'the', 'plan', 'uh', 'today']);
    expect(document.querySelector('[data-chroma-transcript-edit-notice]')?.textContent).toMatch(/^Cut 2 words \(\d+\.\d\ds\)/);
  });
});
