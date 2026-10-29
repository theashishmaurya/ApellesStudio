// @vitest-environment jsdom
/**
 * @apelles/editor — a seek DURING playback keeps playing from the new frame
 * (B-326). The play loop and the audio session each free-run against a clock
 * baselined at the playhead when Play started, so a plain `setPlayhead` was
 * overwritten by the loop's next tick (the click "did nothing") while audio
 * kept going from the old spot. `seekPlayhead` re-baselines both.
 *
 * jsdom: no decode, no audio device — asserts the playhead and the
 * `chroma_audio_play` IPC boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

const FPS = 25;
const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const invoked = vi.hoisted(() => ({ play: [] as Record<string, unknown>[] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_frame: () => STUB_FRAME,
    chroma_timeline_composition_size: () => ({ compWidth: 1000, compHeight: 500, naturalWidth: 1, naturalHeight: 1 }),
    chroma_timeline_clip_geometry: () => ({ compWidth: 1000, compHeight: 500, naturalWidth: 1, naturalHeight: 1 }),
    chroma_project_get_settings: () => ({ width: 1000, height: 500 }),
    chroma_audio_play: (args: Record<string, unknown> | undefined) => {
      invoked.play.push(args ?? {});
      return undefined;
    },
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: () => undefined,
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => undefined),
  emit: () => Promise.resolve(),
}));

import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import type { Timeline } from './timeline';

const timeline: Timeline = {
  id: 'seek-tl',
  name: 'seek',
  rate: { num: FPS, den: 1 },
  tracks: [
    {
      kind: 'video',
      clips: [
        { id: 'a', name: 'A', source_path: '/a.mov', source_start: 0, duration: 5000, source_len: 5000, source_fps: FPS, start_frame: 0 },
      ],
    },
  ],
};

let restores: (() => void)[] = [];
let mounted: MountedComponent | null = null;
let objectUrls: ObjectUrlStub;
let console_: ReturnType<typeof captureConsole>;

beforeEach(() => {
  restores = [stubOffsetMetrics(1000, 500), installResizeObserverStub(), installPointerCaptureStub()];
  objectUrls = installObjectUrlStub();
  console_ = captureConsole();
  invoked.play.length = 0;
});

afterEach(() => {
  console_.restore();
  mounted?.unmount();
  mounted = null;
  objectUrls.restore();
  restores.forEach((r) => r());
  actSync(() => useEditorTimelineStore.setState({ timeline: null, playing: false, playhead: 0 }));
});

async function startPlaying(): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline,
      openProjectKey: 'seek-project',
      status: 'ready',
      error: null,
      playhead: 100,
      playing: false,
      playbackRate: 1,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: false });
  await waitFrames(3);
  actSync(() => useEditorTimelineStore.getState().setPlaying(true));
  await waitFrames(3);
}

describe('seeking while playing (B-326)', () => {
  it('seekPlayhead keeps playing from the new frame and restarts audio there', async () => {
    await startPlaying();
    expect(invoked.play.at(-1)?.startFrame).toBe(100);

    actSync(() => useEditorTimelineStore.getState().seekPlayhead(3000));
    await waitFrames(6);

    const s = useEditorTimelineStore.getState();
    expect(s.playing).toBe(true);
    expect(s.playhead).toBeGreaterThanOrEqual(3000);
    expect(s.playhead).toBeLessThan(3000 + FPS * 5);
    expect(invoked.play.at(-1)?.startFrame).toBe(3000);
  });

  it('a plain setPlayhead is the bug: the loop clock overwrites it', async () => {
    await startPlaying();
    actSync(() => useEditorTimelineStore.getState().setPlayhead(3000));
    await waitFrames(6);
    expect(useEditorTimelineStore.getState().playhead).toBeLessThan(3000);
  });
});
