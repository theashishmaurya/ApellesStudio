// @vitest-environment jsdom
/**
 * D-408 — the Music edits panel in a real DOM: an agent's proposals render as
 * reviewable rows, Accept / Reject drive the shared store, a row that cannot
 * land shows why and cannot be accepted, Apply cuts the accepted ones as one
 * undo step, and the breath button cuts a second before the playhead.
 *
 * Tier: jsdom. It proves the wiring between the panel, the store and the one
 * `music_edits` op; layout and the resizable split are checked live.
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
  invoke: createInvokeStub({ chroma_timeline_set: () => undefined }),
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

  it('cuts a stop-time breath before the playhead', async () => {
    actSync(() => useEditorTimelineStore.setState({ playhead: 120 }));
    click('[data-chroma-music-edits-breath]');
    await waitFrames(1);
    expect(bed().map((c) => [c.start_frame, c.duration])).toEqual([
      [0, 96],
      [120, 360],
    ]);
  });
});
