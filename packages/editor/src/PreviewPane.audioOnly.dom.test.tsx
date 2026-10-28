// @vitest-environment jsdom
/**
 * @apelles/editor — B-290: an audio-only timeline (no video track at all: a cut
 * voiceover, a podcast) previews and plays like any other.
 *
 * **What this pins, and what it cannot.** B-290's causes were all in Rust: the
 * frame command and the audio session both refused a timeline with no video
 * track ("timeline has no video track"), so the viewer showed that error and
 * Play was silent. Those are reproduced and fixed by
 * `chroma::edit::audio_only_preview_tests`,
 * `chroma::audio`'s `resolve_sources_at_a_timeline_with_no_video_track_plays_its_audio`
 * and `chroma::edit_render`'s `an_audio_only_timeline_exports_a_black_picture_and_its_sound`.
 * This file is the other half of the claim: that nothing on THIS side of the
 * IPC depends on a video track either. The play clock is wall-clock (D-049),
 * not driven by decoded frames, so an audio-only timeline must still: show the
 * frame the backend answers with, start `chroma_audio_play` from the playhead
 * on Play, advance the playhead while playing, and stop the session on Pause.
 * It passed before the fix as well — it guards against a frontend regression
 * reintroducing the dependency, not against the Rust bug.
 *
 * jsdom: no layout and no audio device, so this proves the commands and the
 * transport state, never that a human hears the right thing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installCanvasContextStub,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  waitMs,
  type CanvasContextStub,
  type MountedComponent,
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 25;
/** 40 s of voiceover — long enough that playback cannot reach the end here. */
const VO_FRAMES = 1000;

const calls = vi.hoisted(() => ({
  log: [] as { cmd: string; args: Record<string, unknown> }[],
}));

const record = vi.hoisted(
  () =>
    (cmd: string, answer: unknown = undefined) =>
    (args: Record<string, unknown> | undefined) => {
      calls.log.push({ cmd, args: args ?? {} });
      return answer;
    },
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    // What the fixed backend answers for an audio-only timeline: a black frame
    // at the composition size (the bytes are irrelevant in jsdom).
    chroma_timeline_frame: record('chroma_timeline_frame', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer),
    chroma_timeline_composition_size: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      naturalWidth: 1,
      naturalHeight: 1,
    }),
    chroma_timeline_clip_geometry: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      naturalWidth: 1,
      naturalHeight: 1,
    }),
    chroma_project_get_settings: () => ({ width: CANVAS_W, height: CANVAS_H }),
    chroma_audio_play: record('chroma_audio_play'),
    chroma_audio_stop: record('chroma_audio_stop'),
    chroma_audio_set_volume: () => undefined,
    chroma_audio_scrub_begin: record('chroma_audio_scrub_begin'),
    chroma_audio_scrub_update: record('chroma_audio_scrub_update'),
    chroma_audio_scrub_end: record('chroma_audio_scrub_end'),
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import type { Timeline } from './timeline';

/** The owner's shape: one audio track of voiceover, no video track at all. */
function voiceoverTimeline(): Timeline {
  return {
    id: 'vo-tl',
    name: 'Five Levels — Voiceover',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'audio',
        clips: [
          {
            id: 'vo',
            name: 'vo',
            source_path: '/media/vo.m4a',
            source_start: 0,
            duration: VO_FRAMES,
            source_len: VO_FRAMES,
            source_fps: FPS,
            start_frame: 0,
          },
        ],
      },
    ],
  };
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let objectUrls: ObjectUrlStub;
let canvas: CanvasContextStub;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

function named(cmd: string): { cmd: string; args: Record<string, unknown> }[] {
  return calls.log.filter((c) => c.cmd === cmd);
}

function button(label: string): HTMLElement {
  const el = mounted?.container.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;
  if (!el) throw new Error(`no button with aria-label="${label}"`);
  return el;
}

async function mountPane(): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: voiceoverTimeline(),
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
      waveformView: false,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  canvas = installCanvasContextStub(600);
  console_ = captureConsole();
  calls.log.length = 0;
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  actSync(() => useEditorTimelineStore.setState({ playing: false }));
  mounted?.unmount();
  mounted = null;
  canvas.restore();
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  expect(errors).toEqual([]);
});

describe('B-290: an audio-only timeline in the viewer', () => {
  it('shows the frame the backend answers with, not a preview error', async () => {
    await mountPane();

    expect(named('chroma_timeline_frame').length).toBeGreaterThan(0);
    expect(mounted?.container.textContent ?? '').not.toContain('preview error');
    expect(mounted?.container.querySelector('[data-preview-surface] img')).not.toBeNull();
  });

  it('Play starts the audio session from the playhead and the playhead runs; Pause stops it', async () => {
    await mountPane();
    calls.log.length = 0;

    await act(async () => {
      button('Play').click();
    });
    await waitMs(400);

    const plays = named('chroma_audio_play');
    expect(plays).toHaveLength(1);
    expect(plays[0].args).toMatchObject({ startFrame: 0, rate: 1 });
    expect(named('chroma_audio_scrub_begin')).toHaveLength(0);

    const { playhead, playing } = useEditorTimelineStore.getState();
    expect(playing).toBe(true);
    expect(playhead).toBeGreaterThan(0);
    expect(playhead).toBeLessThan(VO_FRAMES);
    // The picture side of playback keeps asking for frames as it goes.
    expect(named('chroma_timeline_frame').some((c) => c.args.playing === true)).toBe(true);

    await act(async () => {
      button('Pause').click();
    });
    await waitFrames(3);

    expect(useEditorTimelineStore.getState().playing).toBe(false);
    expect(named('chroma_audio_stop').length).toBeGreaterThan(0);
  });
});
