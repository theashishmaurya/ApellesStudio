// @vitest-environment jsdom
/**
 * D-408 / D-444 — the Music edits panel in a real DOM: an agent's suggestions
 * render as reviewable rows, Approve / Skip drive the shared store, a row that
 * cannot land shows why and cannot be approved, Apply cuts the approved ones as
 * one undo step; with nothing marked the empty state's breath cuts a second
 * before the playhead; making one reads its range from the timeline's In / Out
 * marks, the kind pills change the sentence, the fade dots drag (one store
 * write per frame), and Preview hands the edited document to the audio path
 * without touching the timeline or the history (B-364).
 *
 * Tier: jsdom. It proves the wiring between the panel, the store and the one
 * `music_edits` op; layout and the resizable split are checked live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  createInvokeStub,
  dragPointer,
  installPointerCaptureStub,
  installElementAnimationsStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

const previewCalls = vi.hoisted(() => [] as unknown[]);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_set: () => undefined,
    chroma_audio_preview_set: (a) => {
      previewCalls.push((a as { timeline: unknown }).timeline);
    },
  }),
}));

import { useHistoryStore } from '@apelles/history';
import { useEditorTimelineStore } from './timelineStore';
import { useMusicEditStore } from './musicEditStore';
import { MusicEditsPanel } from './MusicEditsPanel';
import type { Timeline } from './timeline';
import type { MusicEditRow } from './musicEdits';

function fixture(): Timeline {
  return {
    id: 'tl',
    name: 'music panel',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips: [{ id: 'v', name: 'talk', source_path: '/t.mov', source_start: 0, duration: 480, source_len: 480, start_frame: 0 }] },
      { kind: 'audio', clips: [{ id: 'bed', name: 'bed', source_path: '/bed.mp3', source_start: 0, duration: 480, source_len: 4000, start_frame: 0 }] },
    ],
  };
}

const row = (id: string, start: number, end: number, extra: Partial<MusicEditRow> = {}): MusicEditRow => ({
  id,
  kind: 'dropout',
  origin: 'ai',
  status: 'pending',
  start,
  end,
  fadeOutFrames: 6,
  fadeInFrames: 8,
  mode: 'continuous',
  ...extra,
});

let mounted: MountedComponent | null = null;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = (sel: string) => {
  const el = $(sel);
  if (!el) throw new Error(`no element ${sel}`);
  actSync(() => (el as HTMLElement).click());
};
const bed = () => useEditorTimelineStore.getState().timeline?.tracks[1].clips ?? [];

beforeEach(async () => {
  installResizeObserverStub();
  installElementAnimationsStub();
  useMusicEditStore.getState().clear();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/p.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
    }),
  );
  useMusicEditStore.getState().setProposals(1, {
    timelineId: 'tl',
    track: 1,
    receivedAt: 0,
    nextId: 0,
    rows: [
      row('a0', 48, 72, { text: 'entirely skill', reason: 'the reveal plays dry' }),
      row('a1', 200, 224, { kind: 'breath' }),
      row('a2', 900, 950, { kind: 'dry_cta' }),
    ],
  });
  mounted = mount(React.createElement(MusicEditsPanel));
  await waitFrames(2);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('MusicEditsPanel (D-408)', () => {
  it('renders the proposals with their words, reasons and problems', () => {
    expect(document.querySelectorAll('[data-chroma-music-edit-row]')).toHaveLength(3);
    expect($('[data-chroma-music-edit-row="a0"]')?.textContent).toContain('entirely skill');
    expect($('[data-chroma-music-edit-row="a0"]')?.textContent).toContain('the reveal plays dry');
    expect($('[data-chroma-music-edit-problem="a2"]')?.textContent).toMatch(/no music clip/);
    expect($<HTMLButtonElement>('[data-chroma-music-edit-accept="a2"]')?.disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-chroma-music-edits-apply="1"]')?.disabled).toBe(true);
  });

  it('applies what was accepted, as one undo step, and leaves the rest', async () => {
    click('[data-chroma-music-edit-accept="a0"]');
    click('[data-chroma-music-edit-reject="a1"]');
    await waitFrames(1);
    expect($('[data-chroma-music-edit-row="a0"]')?.getAttribute('data-chroma-music-edit-status')).toBe('accepted');
    const depth = useHistoryStore.getState().undoStack.length;
    click('[data-chroma-music-edits-apply="1"]');
    await waitFrames(1);
    expect(bed().map((c) => c.start_frame)).toEqual([0, 72]);
    expect(useHistoryStore.getState().undoStack.length - depth).toBe(1);
    expect($('[data-chroma-music-edits-notice="ok"]')?.textContent).toMatch(/1 music edit applied/);
    expect(useMusicEditStore.getState().proposals[1].rows.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('with nothing marked or suggested, the empty state cuts a breath before the playhead', async () => {
    actSync(() => {
      useMusicEditStore.getState().clear();
      useEditorTimelineStore.setState({ playhead: 120 });
    });
    await waitFrames(1);
    expect($('[data-chroma-music-edits-empty]')).not.toBeNull();
    click('[data-chroma-music-edits-breath]');
    await waitFrames(1);
    expect(bed().map((c) => [c.start_frame, c.duration])).toEqual([
      [0, 96],
      [120, 360],
    ]);
  });
});

describe('making one (D-444)', () => {
  beforeEach(async () => {
    installPointerCaptureStub();
    previewCalls.length = 0;
    actSync(() => {
      useMusicEditStore.getState().clear();
      useEditorTimelineStore.setState({ playhead: 48, inPoint: null, outPoint: null });
    });
    await waitFrames(1);
  });

  it('starts from the playhead, takes its range from the In / Out marks, and Apply cuts it and clears them', async () => {
    click('[data-chroma-music-edits-start]');
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().inPoint).toBe(48);
    expect($('[data-chroma-music-edits-maker]')).not.toBeNull();
    expect($<HTMLButtonElement>('[data-chroma-music-edits-cut]')?.disabled).toBe(true);
    actSync(() => useEditorTimelineStore.setState({ playhead: 72 }));
    click('[data-chroma-music-edits-mark-out]');
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().outPoint).toBe(72);
    expect($('[data-chroma-music-edits-maker]')?.textContent).toContain('0:02.00');
    expect($('[data-chroma-music-edits-maker]')?.textContent).toContain('0:03.00');

    click('[data-chroma-music-edits-kind="breath"]');
    await waitFrames(1);
    expect($('[data-chroma-music-edits-kind-hint]')?.textContent).toContain('About 1 s of silence');
    expect($('[data-chroma-music-edits-kind="breath"]')?.getAttribute('aria-checked')).toBe('true');

    click('[data-chroma-music-edits-mode-option="pause"]');
    expect(useMusicEditStore.getState().defaults.mode).toBe('pause');

    click('[data-chroma-music-edits-cut]');
    await waitFrames(1);
    expect(bed().map((c) => c.start_frame)).toEqual([0, 72]);
    expect($('[data-chroma-music-edits-notice="ok"]')?.textContent).toMatch(/Breath cut into track 1/);
    expect(useEditorTimelineStore.getState().inPoint).toBeNull();
  });

  it('drags the fade-out dot on the diagram, writing the defaults in frames', async () => {
    actSync(() => useEditorTimelineStore.setState({ inPoint: 48, outPoint: 72 }));
    await waitFrames(1);
    const dot = $('[data-chroma-music-fade-handle="out"]')!;
    const before = useMusicEditStore.getState().defaults.fadeOutFrames;
    // Dragging the fade-out dot LEFT lengthens the fade out.
    await dragPointer(dot, [{ x: 100, y: 18 }, { x: 90, y: 18 }, { x: 80, y: 18 }], { moveTarget: dot, release: dot });
    const after = useMusicEditStore.getState().defaults.fadeOutFrames;
    expect(after).toBeGreaterThan(before);
    expect(dot.getAttribute('aria-valuetext')).toBe(`${(after / 24).toFixed(2)} s`);
    // And the keyboard: one frame per arrow.
    actSync(() => dot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(useMusicEditStore.getState().defaults.fadeOutFrames).toBe(after - 1);
  });

  it('Preview hands the edited document to the audio path and plays, without touching the timeline or the history', async () => {
    actSync(() => useEditorTimelineStore.setState({ inPoint: 48, outPoint: 72 }));
    await waitFrames(1);
    const tlBefore = useEditorTimelineStore.getState().timeline;
    const depth = useHistoryStore.getState().undoStack.length;
    click('[data-chroma-music-edits-preview]');
    await waitFrames(2);
    expect(previewCalls).toHaveLength(1);
    const preview = previewCalls[0] as Timeline;
    expect(preview.tracks[1].clips.map((c) => c.start_frame)).toEqual([0, 72]);
    expect(useEditorTimelineStore.getState().timeline).toBe(tlBefore);
    expect(useHistoryStore.getState().undoStack.length).toBe(depth);
    expect(useEditorTimelineStore.getState().playing).toBe(true);
    expect(useEditorTimelineStore.getState().playhead).toBe(0); // 2 s of pre-roll, clamped at 0
    expect($('[data-chroma-music-edits-preview]')?.getAttribute('aria-label')).toBe('Stop the preview');
    // Stopping playback ends the preview: the override is cleared.
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
    await waitFrames(1);
    expect(previewCalls).toEqual([preview, null]);
  });
});
