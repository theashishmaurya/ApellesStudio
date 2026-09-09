// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the "Captions from Transcript"
 * button (D-238).
 *
 * **Why a DOM test.** `captionsFromTranscript.test.ts` already proves the
 * grouping/rounding logic in isolation; it proves nothing about the actual
 * trigger a human clicks — that the button reads the real selection, resolves
 * the real clip's `source_path`, drives the real `useMediaUnderstandingStore`,
 * and lands a real `import_subtitles` op on the real `useEditorTimelineStore`.
 * That chain only exists once it runs through the real component, so it can
 * only be asserted here. Same tier as `ClipInspectorPanel.eq.dom.test.tsx`:
 * jsdom, the real component, the real stores, a stubbed Tauri `invoke`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import { actSync, createInvokeStub, mount, waitMs, type MountedComponent } from './testUtils/pointerHarness';

// Not actually hit in the "transcript already cached" tests below (the store
// returns the cached result without a round trip), but stubbed the same way
// every other `.dom.test.tsx` in this package stubs Tauri, so a future test
// that DOES miss the cache fails on a real assertion rather than "invoke is
// not a function".
vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({}),
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { useMediaUnderstandingStore } = await import('./mediaUnderstandingStore');
const { CaptionsFromTranscriptButton } = await import('./CaptionsFromTranscriptButton');
import type { Clip, Timeline } from './timeline';
import type { Transcript } from './mediaUnderstandingStore';

const CLIP_ID = 'clip-1';
const SOURCE_PATH = '/media/shot.mp4';

function fixtureTimeline(): Timeline {
  const clip: Clip = {
    id: CLIP_ID,
    name: 'shot.mp4',
    source_path: SOURCE_PATH,
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  };
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [clip] }],
  } as unknown as Timeline;
}

function fixtureTranscript(): Transcript {
  return {
    text: 'We always visit this beach.',
    language: 'en',
    model: 'large-v3',
    source: SOURCE_PATH,
    segments: [
      {
        start: 0,
        end: 1.4,
        text: 'We always visit this beach.',
        words: [
          { word: ' We', start: 0.0, end: 0.2 },
          { word: ' always', start: 0.2, end: 0.5 },
          { word: ' visit', start: 0.5, end: 0.8 },
          { word: ' this', start: 0.8, end: 1.0 },
          { word: ' beach.', start: 1.0, end: 1.4 },
        ],
      },
    ],
    words: [],
  };
}

let mounted: MountedComponent | null = null;

beforeEach(() => {
  useEditorTimelineStore.setState({
    timeline: fixtureTimeline(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
  });
  useMediaUnderstandingStore.setState({
    transcripts: {},
    analyses: {},
    transcribing: {},
    analyzing: {},
    transcriptErrors: {},
    analysisErrors: {},
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function click(el: HTMLElement) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function button(): HTMLButtonElement {
  const el = mounted?.container.querySelector('button');
  if (!el) throw new Error('no button rendered');
  return el as HTMLButtonElement;
}

describe('CaptionsFromTranscriptButton (D-238)', () => {
  it('generates a subtitle track from the selected clip’s cached transcript', async () => {
    // Pre-populated cache — `useMediaUnderstandingStore.getTranscript` returns
    // it with no sidecar round trip, exactly as it does for a real repeat ask
    // (D-189's own "cached by path" contract).
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE_PATH]: fixtureTranscript() } });
    mounted = mount(React.createElement(CaptionsFromTranscriptButton));

    click(button());
    await waitMs(20);

    const tl = useEditorTimelineStore.getState().timeline!;
    expect(tl.tracks).toHaveLength(2);
    const captionTrack = tl.tracks[1];
    expect(captionTrack.kind).toBe('subtitle');
    expect(captionTrack.clips).toHaveLength(1);
    expect(captionTrack.clips[0].caption?.text).toBe('We always visit this beach.');
    // 1.4 s at 24 fps = frame 34 (round(1.4*24) = round(33.6) = 34).
    expect(captionTrack.clips[0].start_frame).toBe(0);
    expect(captionTrack.clips[0].duration).toBe(34);
    expect(mounted.container.textContent).not.toMatch(/select exactly one clip/);
  });

  it('refuses with a real message when nothing is selected', async () => {
    useEditorTimelineStore.setState({ selection: [] });
    mounted = mount(React.createElement(CaptionsFromTranscriptButton));

    click(button());
    await waitMs(5);

    expect(mounted.container.textContent).toMatch(/select exactly one clip/);
    // No track was added — the refusal is a pure no-op.
    expect(useEditorTimelineStore.getState().timeline!.tracks).toHaveLength(1);
  });

  it('refuses when the transcript has no word-level timestamps', async () => {
    useMediaUnderstandingStore.setState({
      transcripts: {
        [SOURCE_PATH]: {
          text: 'untimed',
          language: 'en',
          model: 'large-v3',
          source: SOURCE_PATH,
          segments: [{ start: 0, end: 2, text: 'untimed', words: [] }],
        },
      },
    });
    mounted = mount(React.createElement(CaptionsFromTranscriptButton));

    click(button());
    await waitMs(20);

    expect(mounted.container.textContent).toMatch(/no word-level timestamps/);
    expect(useEditorTimelineStore.getState().timeline!.tracks).toHaveLength(1);
  });
});
