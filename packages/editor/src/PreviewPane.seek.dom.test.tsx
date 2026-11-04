// @vitest-environment jsdom
/**
 * @apelles/editor — a seek DURING playback keeps playing from the new frame
 * (B-326). Since D-454 the picture's play loop runs in Rust (clocked by the
 * display, following the audio clock) and reports each frame it shows; the
 * webview restarts it, and the audio session, from the playhead on a
 * `seekPlayhead`. A plain `setPlayhead` restarts neither, so the loop's next
 * reported frame puts the playhead back where playback is.
 *
 * jsdom: no presenter, no audio device — asserts the `chroma_preview_surface_
 * play` / `chroma_audio_play` IPC boundary, and plays the loop's part by firing
 * its frame event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  PREVIEW_SURFACE_STUBS,
  actSync,
  captureConsole,
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';
import { fireEvent, resetEventBus } from './testUtils/eventBus';

const FPS = 25;
const invoked = vi.hoisted(() => ({ play: [] as Record<string, unknown>[], video: [] as Record<string, unknown>[] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    ...PREVIEW_SURFACE_STUBS,
    chroma_preview_surface_play: (args: Record<string, unknown> | undefined) => {
      invoked.video.push((args?.args as Record<string, unknown>) ?? {});
      return undefined;
    },
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

vi.mock('@tauri-apps/api/event', async () => (await import('./testUtils/eventBus')).eventModule);

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
let console_: ReturnType<typeof captureConsole>;

beforeEach(() => {
  restores = [stubOffsetMetrics(1000, 500), installResizeObserverStub(), installPointerCaptureStub()];
  console_ = captureConsole();
  invoked.play.length = 0;
  invoked.video.length = 0;
});

afterEach(() => {
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restores.forEach((r) => r());
  resetEventBus();
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

/** The loop reports a frame it showed. */
function loopShows(frame: number): void {
  actSync(() => fireEvent('chroma://preview-playhead', { frame, ended: false }));
}

describe('seeking while playing (B-326)', () => {
  it('Play hands the loop to Rust from the playhead, with the audio session', async () => {
    await startPlaying();
    expect(invoked.video.at(-1)).toMatchObject({ playing: true, from: 100, fps: FPS, rate: 1, end: 5000 });
    expect(invoked.play.at(-1)?.startFrame).toBe(100);
    loopShows(112);
    expect(useEditorTimelineStore.getState().playhead).toBe(112);
  });

  it('seekPlayhead keeps playing from the new frame and restarts the loop and the audio there', async () => {
    await startPlaying();
    actSync(() => useEditorTimelineStore.getState().seekPlayhead(3000));
    await waitFrames(3);

    const s = useEditorTimelineStore.getState();
    expect(s.playing).toBe(true);
    expect(s.playhead).toBe(3000);
    expect(invoked.video.at(-1)).toMatchObject({ playing: true, from: 3000 });
    expect(invoked.play.at(-1)?.startFrame).toBe(3000);
  });

  it('a plain setPlayhead restarts nothing: the loop puts the playhead back where playback is', async () => {
    await startPlaying();
    const calls = invoked.video.length;
    actSync(() => useEditorTimelineStore.getState().setPlayhead(3000));
    await waitFrames(3);
    expect(invoked.video.length).toBe(calls);
    loopShows(140);
    expect(useEditorTimelineStore.getState().playhead).toBe(140);
  });

  it('the end of the timeline stops the transport on the last frame', async () => {
    await startPlaying();
    actSync(() => fireEvent('chroma://preview-playhead', { frame: 4999, ended: true }));
    const s = useEditorTimelineStore.getState();
    expect(s.playing).toBe(false);
    expect(s.playhead).toBe(4999);
  });
});
