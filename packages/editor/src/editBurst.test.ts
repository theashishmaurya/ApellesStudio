// B-274 — a burst of edits on a big timeline keeps what it retains bounded.
//
// The Black October session (~490 clips, 14 tracks, 803 s and 580 s music beds)
// grew the Edit webview to ~18 GB under a few hundred `editor_*` ops. This is
// the measurable half that does not need a webview: 200 `set_clip_audio` ops
// through the real store, then what the store and the shared undo history are
// holding. (The waveform canvas half is `waveformWindow.test.ts`.)
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve(undefined) }));

import { MAX_HISTORY_ENTRIES, useHistoryStore } from '@apelles/history';
import { useEditorTimelineStore } from './timelineStore';
import type { Clip, Timeline } from './timeline';

const AUDIO_LANES = 7;
const CLIPS_PER_LANE = 40;
const VIDEO_CLIPS = 280;
const BURST = 200;

function bigTimeline(): Timeline {
  const clip = (id: string, startFrame: number, seconds: number): Clip => ({
    id,
    name: id,
    source_path: `/media/${id}.wav`,
    source_start: 0,
    duration: seconds * 30,
    source_len: seconds * 30,
    start_frame: startFrame,
  });
  const audio = Array.from({ length: AUDIO_LANES }, (_, lane) => ({
    kind: 'audio' as const,
    // Lane 0 and 1 carry the long music beds (803 s and 580 s), the rest SFX.
    clips:
      lane === 0
        ? [clip('bed-a', 0, 803)]
        : lane === 1
          ? [clip('bed-b', 0, 580)]
          : Array.from({ length: CLIPS_PER_LANE }, (_, i) => clip(`sfx-${lane}-${i}`, i * 200, 3)),
  }));
  const video = {
    kind: 'video' as const,
    clips: Array.from({ length: VIDEO_CLIPS }, (_, i) => clip(`v-${i}`, i * 120, 4)),
  };
  return { id: 't', name: 'Burst', rate: null, tracks: [video, ...audio] } as unknown as Timeline;
}

beforeEach(() => {
  useHistoryStore.getState().clear();
  useEditorTimelineStore.setState({ timeline: bigTimeline(), status: 'ready', openProjectKey: 'burst' });
});

describe('a burst of 200 set_clip_audio ops on a ~490-clip timeline (B-274)', () => {
  it('applies every op and keeps the undo history at its cap', () => {
    const clipCount = useEditorTimelineStore.getState().timeline?.tracks.reduce((n, t) => n + t.clips.length, 0) ?? 0;
    expect(clipCount).toBeGreaterThan(450);

    const started = performance.now();
    for (let i = 0; i < BURST; i++) {
      useEditorTimelineStore.getState().applyOp({
        kind: 'set_clip_audio',
        track: 3 + (i % (AUDIO_LANES - 2)),
        clip: i % CLIPS_PER_LANE,
        volume: 0.15 + (i % 7) / 100,
      });
    }
    const perOpMs = (performance.now() - started) / BURST;

    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.tracks[3].clips[0].volume).toBeDefined();
    expect(useHistoryStore.getState().undoStack.length).toBeLessThanOrEqual(MAX_HISTORY_ENTRIES);
    // Not an assertion on speed (machines differ): printed so the cost of one
    // snapshot-per-op is on record next to the cap that bounds it.
    console.info(`[B-274] ${BURST} set_clip_audio ops on ${clipCount} clips: ${perOpMs.toFixed(2)} ms/op, undo depth ${useHistoryStore.getState().undoStack.length}`);
  });
});
