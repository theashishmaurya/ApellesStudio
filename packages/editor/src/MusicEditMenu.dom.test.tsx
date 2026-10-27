// @vitest-environment jsdom
/**
 * D-408 — "Music dropout here": right-clicking a transcript line in the Index
 * panel opens the music menu for THAT line, and its items cut through the
 * shared `quickMusicEdit` (one `music_edits` op).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  createInvokeStub,
  installElementAnimationsStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({ chroma_timeline_set: () => undefined, chroma_clip_thumbnails: () => [], chroma_media_understanding_load: () => null }),
}));

import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore, type Transcript } from './mediaUnderstandingStore';
import { useMusicEditStore } from './musicEditStore';
import { EditIndexPanel } from './EditIndexPanel';
import type { Timeline } from './timeline';

const SOURCE = '/talk.mov';

function transcript(): Transcript {
  // Two lines: 0-2 s and 3-5 s.
  const w = (word: string, start: number) => ({ word: ` ${word}`, start, end: start + 0.8 });
  const a = [w('it', 0), w('was', 1)];
  const b = [w('skill', 3), w('alone', 4)];
  return {
    text: 'it was skill alone',
    language: 'en',
    model: 't',
    source: SOURCE,
    segments: [
      { start: 0, end: 1.8, text: 'it was', words: a },
      { start: 3, end: 4.8, text: 'skill alone', words: b },
    ],
    words: [...a, ...b],
  };
}

function fixture(): Timeline {
  return {
    id: 'tl',
    name: 'menu',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips: [{ id: 'v', name: 'talk', source_path: SOURCE, source_start: 0, duration: 240, source_len: 240, source_fps: 24, start_frame: 0 }] },
      { kind: 'audio', clips: [{ id: 'bed', name: 'bed', source_path: '/bed.mp3', source_start: 0, duration: 240, source_len: 4000, start_frame: 0 }] },
    ],
  };
}

let mounted: MountedComponent | null = null;

beforeEach(async () => {
  installResizeObserverStub();
  installElementAnimationsStub();
  useMusicEditStore.getState().clear();
  actSync(() =>
    useEditorTimelineStore.setState({ timeline: fixture(), openProjectKey: '/p.chroma', status: 'ready', error: null, playhead: 0 }),
  );
  actSync(() => useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript() } }));
  mounted = mount(React.createElement(EditIndexPanel));
  await waitFrames(2);
  // The Index panel opens on Markers; switch to the transcript.
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => /transcript/i.test(t.textContent ?? ''));
  actSync(() => tab?.click());
  await waitFrames(2);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function rightClickRow(index: number) {
  const row = document.querySelector<HTMLElement>(`[data-chroma-transcript-row="${index}"]`);
  if (!row) throw new Error('no transcript row');
  actSync(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  await waitFrames(3);
}

describe('MusicEditMenu on the Index transcript (D-408)', () => {
  it('cuts a music dropout over the right-clicked line', async () => {
    await rightClickRow(1);
    const item = document.querySelector<HTMLElement>('[data-chroma-music-edit-action="dropout"]');
    expect(item).not.toBeNull();
    actSync(() => item?.click());
    await waitFrames(2);
    const clips = useEditorTimelineStore.getState().timeline?.tracks[1].clips ?? [];
    // Line 2 spans 3.0-4.8 s = frames 72..115.
    expect(clips.map((c) => c.start_frame)).toEqual([0, 115]);
    expect(clips[0].duration).toBe(72);
    expect(document.querySelector('[data-chroma-music-edit-notice="ok"]')?.textContent).toMatch(/Dropout cut into track 1/);
  });

  it('adds the line to the review list instead, when asked', async () => {
    await rightClickRow(0);
    const item = document.querySelector<HTMLElement>('[data-chroma-music-edit-action="review"]');
    actSync(() => item?.click());
    await waitFrames(2);
    const rows = useMusicEditStore.getState().proposals[1]?.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'person', status: 'accepted', text: 'it was', start: 0 });
    expect(useEditorTimelineStore.getState().timeline?.tracks[1].clips).toHaveLength(1);
  });
});
