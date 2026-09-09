// @vitest-environment jsdom
/**
 * @apelles/editor — permanent real-DOM coverage for the viewer transport's own
 * audio commands (D-232's scrub gesture beside D-049/D-130's play/stop), and
 * the regression guard for B-110.
 *
 * **Why this asserts on the invoke stream and not on the store.** Every bug
 * this file exists for is a bug about *which Rust command was sent, with what
 * arguments, in what order* — a store assertion cannot see any of that. So the
 * real `PreviewPane` is mounted (in StrictMode, like `app/src/main.tsx` runs
 * it), the real `<Player>` transport renders inside it, buttons are pressed
 * through real DOM `click()`, and the assertions are on what crossed the IPC
 * boundary.
 *
 * Two distinct properties are pinned here.
 *
 * 1. **Pressing Play starts PLAYBACK and nothing else.** D-232 wired the
 *    position bar — the control immediately above the Play button, in the same
 *    transport component — to `beginScrub`/`endScrub` through Base UI's
 *    `onValueChange`/`onValueCommitted`. A scrub claims the SAME single Rust
 *    transport playback uses (`apelles_media::scrub`'s own module doc), so a
 *    stray `chroma_audio_scrub_begin` fired by a press on the neighbouring
 *    button would take the transport away from the play that press was for,
 *    and the picture would run in silence. That failure mode was investigated
 *    live against a "first play is silent" report and **ruled out** — this test
 *    is what keeps it ruled out, rather than leaving the next person to
 *    re-derive it from the same symptom.
 *
 * 2. **A scrub carries the level the timeline actually has (B-110).** See
 *    `scrubSource.ts`'s `ScrubSource.gain`.
 *
 * Tier and its honest limit: jsdom, so there is no layout engine and no audio
 * device. This proves the command and its arguments, never that a human hears
 * the right thing — that remains the env-gated `cpal` rms/peak proxy in
 * `app/src-tauri/src/chroma/audio.rs`, and ultimately an ear.
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
  type CanvasContextStub,
  type MountedComponent,
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 25;
/** The music bed's own track fader, and the clip volume under it — the shape of
 *  the owner's real reel, which is where B-110 was found. */
const TRACK_GAIN = 0.4;
const CLIP_VOLUME = 0.5;

const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

/** Every audio-transport invoke the tree made, in order — the actual boundary
 *  each of these bugs crosses. */
const calls = vi.hoisted(() => ({
  audio: [] as { cmd: string; args: Record<string, unknown> }[],
}));

const record = vi.hoisted(
  () => (cmd: string) => (args: Record<string, unknown> | undefined) => {
    // `chroma_audio_waveform` is the strip's own read, not a transport command;
    // it is deliberately not recorded so the ordering assertions stay readable.
    calls.audio.push({ cmd, args: args ?? {} });
    return undefined;
  },
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_frame: () => STUB_FRAME,
    chroma_timeline_composition_size: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...NATURAL_FULL_FRAME,
    }),
    chroma_timeline_clip_geometry: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...NATURAL_FULL_FRAME,
    }),
    chroma_project_get_settings: () => ({ width: CANVAS_W, height: CANVAS_H }),
    chroma_audio_play: record('chroma_audio_play'),
    chroma_audio_stop: record('chroma_audio_stop'),
    chroma_audio_set_volume: record('chroma_audio_set_volume'),
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
import { beginScrub, endScrub, updateScrub } from './scrubAudio';
import type { Timeline } from './timeline';

/** One video track carrying the picture, and a music bed on a faded audio
 *  track under it — the two-source shape B-110 is about. */
function fixtureTimeline(): Timeline {
  return {
    id: 'tl',
    name: 'T',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'v',
            name: 'V',
            source_path: '/media/v.mov',
            source_start: 0,
            duration: 1000,
            source_len: 1000,
            source_fps: FPS,
            start_frame: 0,
          },
        ],
      },
      {
        kind: 'audio',
        gain: TRACK_GAIN,
        clips: [
          {
            id: 'a',
            name: 'music',
            source_path: '/media/music.mp3',
            source_start: 0,
            duration: 1000,
            source_len: 1000,
            source_fps: FPS,
            start_frame: 0,
            volume: CLIP_VOLUME,
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

/** Just the transport commands, in issue order. */
function transport(): { cmd: string; args: Record<string, unknown> }[] {
  return calls.audio.filter((c) => c.cmd !== 'chroma_audio_set_volume');
}

function names(): string[] {
  return transport().map((c) => c.cmd);
}

function button(label: string): HTMLElement {
  const el = mounted?.container.querySelector(
    `button[aria-label="${label}"]`,
  ) as HTMLElement | null;
  if (!el) throw new Error(`no button with aria-label="${label}"`);
  return el;
}

async function mountPane(playhead = 125): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixtureTimeline(),
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead,
      playing: false,
      selection: [],
      selectedGap: null,
      waveformView: false,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
  calls.audio.length = 0; // drop the mount-time stop(s) — each test owns its own window
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  canvas = installCanvasContextStub(600);
  console_ = captureConsole();
  calls.audio.length = 0;
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  // A gesture left live would leak `scrubAudio`'s module state into the next
  // test — it is deliberately module-level (see that file's own doc).
  endScrub();
  mounted?.unmount();
  mounted = null;
  canvas.restore();
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  expect(errors).toEqual([]);
});

describe('the viewer transport’s audio commands', () => {
  /**
   * **The regression guard for the ruled-out cause of "the first play is
   * silent".** A press on Play must produce exactly one `chroma_audio_play` and
   * must not touch the scrub transport at all — if it ever did, that scrub
   * would take the session away from the play and the picture would run mute.
   */
  it('a real click on Play starts playback and never starts a scrub', async () => {
    await mountPane(125);

    await act(async () => {
      button('Play').click();
    });
    await waitFrames(3);

    expect(names()).toEqual(['chroma_audio_play']);
    expect(transport()[0].args).toMatchObject({ startFrame: 125 });
  });

  /**
   * Play → Pause → Play, the sequence the "silent first play, then it works"
   * report describes. Every command must carry a `seq` strictly above every
   * command before it: Rust's `begin_request` drops anything at or below the
   * newest stamp it has accepted (D-130), so a play that did not out-rank the
   * stop before it would be silently discarded and there would be no sound.
   */
  it('stamps every transport command above the one before it, across play/stop/play', async () => {
    await mountPane(125);

    await act(async () => {
      button('Play').click();
    });
    await waitFrames(3);
    await act(async () => {
      button('Pause').click();
    });
    await waitFrames(3);
    await act(async () => {
      button('Play').click();
    });
    await waitFrames(3);

    const issued = transport();
    expect(issued.filter((c) => c.cmd === 'chroma_audio_play')).toHaveLength(2);
    expect(issued.some((c) => c.cmd === 'chroma_audio_stop')).toBe(true);
    expect(issued.every((c) => typeof c.args.seq === 'number')).toBe(true);

    const seqs = issued.map((c) => c.args.seq as number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // The last command standing must be the play — otherwise the session it
    // started has already been superseded by the time Rust sees it.
    expect(issued[issued.length - 1].cmd).toBe('chroma_audio_play');
  });

  /**
   * **B-110.** The scrub used to send a path and a source second and nothing
   * else, so every monitored source played at unity while `chroma_audio_play`
   * mixed it at its real level — a music bed faded to 0.4 was monitored 8 dB
   * hot. Both the claim and every steer now carry the resolved level.
   */
  it('a scrub gesture carries the source’s real level, not unity', async () => {
    await mountPane(125);

    act(() => {
      beginScrub(125);
    });
    act(() => {
      updateScrub(200);
    });
    act(() => {
      endScrub();
    });
    await waitFrames(2);

    expect(names()).toEqual([
      'chroma_audio_scrub_begin',
      'chroma_audio_scrub_update',
      'chroma_audio_scrub_end',
    ]);

    const expected = TRACK_GAIN * CLIP_VOLUME;
    expect(transport()[0].args).toMatchObject({
      sourcePath: '/media/music.mp3',
      gain: expected,
    });
    expect(transport()[1].args).toMatchObject({
      sourcePath: '/media/music.mp3',
      gain: expected,
    });
  });

  /**
   * A position with nothing audible under it is an ordinary state that must
   * read as silence — a `null` path — rather than as an error or as the last
   * grain repeating. The level sent alongside it is irrelevant but must still
   * be a real number, since Rust deserializes it as `f32`.
   */
  it('sends a null path, not an error, where nothing is audible', async () => {
    await mountPane(0);
    actSync(() =>
      useEditorTimelineStore.setState({
        timeline: { id: 'tl', name: 'T', rate: { num: FPS, den: 1 }, tracks: [] },
      }),
    );
    await waitFrames(2);
    calls.audio.length = 0;

    act(() => {
      beginScrub(10);
    });
    await waitFrames(2);

    expect(transport()[0].cmd).toBe('chroma_audio_scrub_begin');
    expect(transport()[0].args).toMatchObject({ sourcePath: null });
    expect(typeof transport()[0].args.gain).toBe('number');
  });
});
