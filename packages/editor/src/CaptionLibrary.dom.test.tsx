// @vitest-environment jsdom
/**
 * @apelles/editor — the caption library's real behaviour (D-243; docked by
 * D-263, which is why this file is no longer `CaptionPanel.dom.test.tsx`).
 *
 * `captionPresets.test.ts` proves the preset DATA is sane and
 * `captionAnim.test.ts` proves the model's arithmetic. What neither can catch
 * is the wiring: a library tile that renders but applies nothing, or applies
 * the wrong preset, or drops a caption onto a video track. Those are only
 * visible by mounting the thing and clicking it, which is what this file does.
 *
 * The placement path itself (`applyCaptionPreset`) is exercised here through
 * the UI rather than being stubbed, deliberately: it is the SAME function
 * `editor_add_caption_preset` calls, so proving it through the library proves
 * it for the agent surface too (CLAUDE.md's human-AND-AI rule).
 *
 * **What D-263 changed for these tests.** There is no trigger to click and no
 * popover to open: the library is docked content now, so it is in the DOM as
 * soon as it is mounted, and it stays there after a pick (which is the point —
 * a second look can be tried straight after the first). Every assertion below
 * about what the library DOES is unchanged.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  installElementAnimationsStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: async () => null,
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { CaptionLibrary } = await import('./CaptionLibrary');
const { useMediaUnderstandingStore } = await import('./mediaUnderstandingStore');
const { captionWithPreset, DEFAULT_PRESET_CAPTION_TEXT } = await import('./captionPresetAction');
const { CAPTION_PRESETS } = await import('./captionPresets');
const { captionAnimationOf } = await import('./captionAnim');
import type { Clip, Timeline } from './timeline';
import type { Transcript } from './mediaUnderstandingStore';

function fixture(): Timeline {
  const videoClip: Clip = {
    id: 'v1',
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  } as Clip;
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [videoClip] }],
  } as unknown as Timeline;
}

const SHOT = '/media/shot.mp4';

/** A word-timed transcript for `SHOT`: two sentences, so two cues. */
function transcript(): Transcript {
  const words = [
    { word: ' Hello', start: 0.0, end: 0.4 },
    { word: ' there', start: 0.4, end: 0.8 },
    { word: ' friends.', start: 0.8, end: 1.4 },
    { word: ' Welcome', start: 3.0, end: 3.5 },
    { word: ' back.', start: 3.5, end: 4.0 },
  ];
  return {
    text: 'Hello there friends. Welcome back.',
    language: 'en',
    model: 'test',
    source: SHOT,
    segments: [
      { start: 0, end: 1.4, text: 'Hello there friends.', words: words.slice(0, 3) },
      { start: 3, end: 4, text: 'Welcome back.', words: words.slice(3) },
    ],
    words,
  };
}

function resetTranscripts() {
  useMediaUnderstandingStore.setState({ transcripts: {}, transcribing: {}, transcriptErrors: {} });
}

/** The transcription for `SHOT` is running (so no sidecar job is started). */
function markTranscribing() {
  useMediaUnderstandingStore.setState({ transcribing: { [SHOT]: true } });
}

function land() {
  useMediaUnderstandingStore.setState({ transcripts: { [SHOT]: transcript() }, transcribing: {} });
}

function subtitleTracks() {
  return (useEditorTimelineStore.getState().timeline?.tracks ?? []).filter((t) => t.kind === 'subtitle');
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreAnimations: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  // Base UI's `Tabs` reaches for `Element.getAnimations` — absent in jsdom
  // (see the stub).
  restoreAnimations = installElementAnimationsStub();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
  });
  resetTranscripts();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreAnimations?.();
  restoreAnimations = null;
});

async function render() {
  mounted = mount(React.createElement(CaptionLibrary), { strictMode: true });
  await waitFrames(2);
}

function q(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

describe('the caption library', () => {
  /** B-121 — the styles were once behind a button labelled like the file-picker
   *  button it had replaced, and the owner could not find them. D-263 removed
   *  the button entirely: selecting Subtitles on the library rail puts the
   *  styled tiles on screen, on the Styles tab, with nothing to click first.
   *  That is the same property, pinned at its new (stronger) location. */
  it('shows the styled preset tiles immediately, with no trigger to find first', async () => {
    await render();
    expect(q('[data-testid="caption-library"]'), 'the library is docked content').not.toBeNull();
    expect(
      q('[data-testid="caption-preset-caption-highlight"]'),
      'a real preset tile, on the default (Styles) tab',
    ).not.toBeNull();
  });

  it('renders a tile with a live thumbnail for every preset in the library', async () => {
    await render();
    for (const preset of CAPTION_PRESETS) {
      expect(q(`[data-testid="caption-preset-${preset.id}"]`), `${preset.id} tile`).not.toBeNull();
      // The thumbnail is the preset's own style in CSS — its absence would
      // mean the library shows names with no indication of what they look
      // like, which is the whole point of a library.
      expect(
        q(`[data-testid="caption-preset-thumb-${preset.id}"]`),
        `${preset.id} thumbnail`,
      ).not.toBeNull();
    }
  });

  it('offers the D-229 import path as its own tab', async () => {
    await render();
    const importTab = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Import',
    );
    expect(importTab, 'an Import tab').toBeDefined();
    importTab!.click();
    await waitFrames(3);
    expect(q('[data-testid="caption-import"]')).not.toBeNull();
  });

  describe('B-361 - a click captions the video, not a placeholder', () => {
    it('case 2: with a transcript, generates captions from it in the preset style', async () => {
      land();
      await render();
      const preset = CAPTION_PRESETS.find((p) => p.id === 'caption-highlight')!;
      (q(`[data-testid="caption-preset-${preset.id}"]`) as HTMLElement).click();
      await waitFrames(3);

      const subs = subtitleTracks();
      expect(subs).toHaveLength(1);
      expect(subs[0].clips.map((c) => c.caption?.text)).toEqual([
        'Hello there friends.',
        'Welcome back.',
      ]);
      expect(subs[0].caption_style?.color).toBe(preset.style.color);
      expect(captionAnimationOf(subs[0].caption_style).kind).toBe('highlight');
      // The placeholder is nowhere.
      expect(subs[0].clips.some((c) => c.caption?.text === DEFAULT_PRESET_CAPTION_TEXT)).toBe(false);
      expect(q('[data-testid="caption-library-error"]')).toBeNull();
    });

    it('case 1: captions already there are restyled - nothing added, no error', async () => {
      land();
      await render();
      (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
      await waitFrames(3);
      const before = subtitleTracks()[0].clips.map((c) => c.id);

      (q('[data-testid="caption-preset-caption-kinetic-slam"]') as HTMLElement).click();
      await waitFrames(3);

      const subs = subtitleTracks();
      expect(subs, 'a second preset reuses the track').toHaveLength(1);
      expect(subs[0].clips.map((c) => c.id), 'same captions, none added').toEqual(before);
      // The style is REPLACED, not merged.
      expect(captionAnimationOf(subs[0].caption_style).kind).toBe('slam');
      expect(captionAnimationOf(subs[0].caption_style).active_box_color).toBeNull();
      expect(q('[data-testid="caption-library-error"]'), 'no "did not fit" error').toBeNull();
    });

    it('case 1 holds even when a caption sits under the playhead', async () => {
      // The original bug: a caption at the playhead made the placeholder fail.
      useEditorTimelineStore.getState().applyOp({
        kind: 'import_subtitles',
        cues: [{ id: 'c1', start_frame: 0, duration: 48, text: 'Already here' }],
      });
      await render();
      (q('[data-testid="caption-preset-plain-subtitle"]') as HTMLElement).click();
      await waitFrames(3);
      expect(q('[data-testid="caption-library-error"]')).toBeNull();
      expect(subtitleTracks()[0].clips).toHaveLength(1);
      expect(captionAnimationOf(subtitleTracks()[0].caption_style).kind).toBe('none');
    });

    it('case 3: with no transcript yet, waits visibly and generates when it lands', async () => {
      markTranscribing();
      await render();
      (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
      await waitFrames(3);

      const status = q('[data-testid="caption-pending"]');
      expect(status, 'a visible waiting state').not.toBeNull();
      expect(status?.textContent).toContain("Transcribing... captions will appear when it's done");
      expect(subtitleTracks(), 'nothing is added while waiting').toHaveLength(0);

      land();
      await waitFrames(3);

      expect(q('[data-testid="caption-pending"]'), 'the wait ended').toBeNull();
      const subs = subtitleTracks();
      expect(subs).toHaveLength(1);
      expect(subs[0].clips).toHaveLength(2);
      expect(captionAnimationOf(subs[0].caption_style).kind).toBe('highlight');
    });

    it('case 3: Cancel stops the wait and adds nothing when the transcript lands', async () => {
      markTranscribing();
      await render();
      (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
      await waitFrames(3);
      (q('[data-testid="caption-pending-cancel"]') as HTMLElement).click();
      await waitFrames(3);
      expect(q('[data-testid="caption-pending"]')).toBeNull();

      land();
      await waitFrames(3);
      expect(subtitleTracks(), 'a cancelled preset does not appear later').toHaveLength(0);
    });

    it('case 3: a failed transcription is reported in words, once', async () => {
      markTranscribing();
      await render();
      (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
      await waitFrames(3);

      useMediaUnderstandingStore.setState({
        transcribing: {},
        transcriptErrors: { [SHOT]: 'the AI environment is not ready' },
      });
      await waitFrames(3);

      expect(q('[data-testid="caption-pending"]')).toBeNull();
      expect(q('[data-testid="caption-library-error"]')?.textContent).toContain(
        'the AI environment is not ready',
      );
      expect(subtitleTracks()).toHaveLength(0);
    });

    it('with no speech on the timeline it says so instead of dropping a placeholder', async () => {
      useEditorTimelineStore.setState({
        timeline: { id: 'tl', name: 'T', rate: 24, tracks: [{ kind: 'video', clips: [] }] } as unknown as Timeline,
      });
      await render();
      (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
      await waitFrames(3);
      expect(q('[data-testid="caption-library-error"]')?.textContent).toContain('no speech');
      expect(subtitleTracks()).toHaveLength(0);
    });

    it('case 4: "Preview with sample text" is the explicit way to get the placeholder', async () => {
      await render();
      (q('[data-testid="caption-sample-toggle"]') as HTMLElement).click();
      await waitFrames(2);
      (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
      await waitFrames(3);

      const subs = subtitleTracks();
      expect(subs).toHaveLength(1);
      expect(subs[0].clips).toHaveLength(1);
      expect(subs[0].clips[0].caption?.text).toBe(DEFAULT_PRESET_CAPTION_TEXT);
      expect(q('[data-testid="caption-pending"]'), 'sample needs no transcript').toBeNull();
    });
  });

  describe('captionWithPreset (the op the MCP tool calls)', () => {
    it('restyles existing captions', () => {
      useEditorTimelineStore.getState().applyOp({
        kind: 'import_subtitles',
        cues: [{ id: 'c1', start_frame: 0, duration: 48, text: 'Hi' }],
      });
      const r = captionWithPreset({ presetId: 'caption-kinetic-slam' });
      expect(r).toMatchObject({ ok: true, outcome: 'restyled', cues: 1 });
    });

    it('answers "transcribing" while the transcript is pending, then generates', () => {
      markTranscribing();
      const pending = captionWithPreset({ presetId: 'caption-highlight' });
      expect(pending).toMatchObject({ ok: true, outcome: 'transcribing', pending: 1, total: 1 });
      expect(subtitleTracks()).toHaveLength(0);
      land();
      const done = captionWithPreset({ presetId: 'caption-highlight' });
      expect(done).toMatchObject({ ok: true, outcome: 'generated', cues: 2 });
    });

    it('mode "sample" and a given text keep the placeholder path', () => {
      expect(captionWithPreset({ presetId: 'caption-highlight', mode: 'sample' })).toMatchObject({
        ok: true,
        outcome: 'sample',
      });
      expect(captionWithPreset({ presetId: 'plain-subtitle', text: 'Mine' })).toMatchObject({
        ok: true,
        outcome: 'sample',
      });
    });

    it('placeCaption false styles the track and adds nothing', () => {
      const r = captionWithPreset({ presetId: 'caption-highlight', placeCaption: false });
      expect(r).toMatchObject({ ok: true, outcome: 'styled' });
      expect(subtitleTracks()[0].clips).toHaveLength(0);
    });

    it('refuses an unknown mode and an unknown preset in words', () => {
      expect(captionWithPreset({ presetId: 'caption-highlight', mode: 'x' as 'auto' })).toEqual({
        error: 'mode must be "auto" or "sample"',
      });
      expect(captionWithPreset({ presetId: 'nope' })).toMatchObject({ error: expect.stringContaining('unknown caption preset') });
    });
  });

  it('a static preset applies with no animation at all', async () => {
    land();
    await render();
    (q('[data-testid="caption-preset-plain-subtitle"]') as HTMLElement).click();
    await waitFrames(3);

    const tl = useEditorTimelineStore.getState().timeline!;
    const subIndex = tl.tracks.findIndex((t) => t.kind === 'subtitle');
    expect(captionAnimationOf(tl.tracks[subIndex].caption_style).kind).toBe('none');
  });
});
