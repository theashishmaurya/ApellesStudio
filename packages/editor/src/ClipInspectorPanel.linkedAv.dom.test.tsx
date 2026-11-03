// @vitest-environment jsdom
/**
 * @apelles/editor — an A/V-linked pair acts as ONE clip in the Inspector
 * (B-334, D-430).
 *
 * **The bug.** Every Inspector section read the SELECTED clip. On a linked pair
 * (D-129) that is two different clips: selecting the picture and opening the
 * Audio tab showed the picture half's own `volume` (a stray 10.6 nothing ever
 * mixes — the video clip's embedded stream is suppressed) while the audible
 * level, on the audio partner, was 0.55 and keyframed. Selecting the audio
 * half and opening the Video tab edited a transform nothing draws.
 *
 * **What this pins.** Both selection orders × both tabs: the Audio tab always
 * reads and writes the audio partner (level, pan, EQ, keyframes), the Video tab
 * always the picture, neither shows a value the other half owns, and an edit
 * lands on the half the tab belongs to. Same tier and limits as
 * `ClipInspectorPanel.tabs.dom.test.tsx`: jsdom, real components, a real store,
 * a stubbed Tauri `invoke`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  actSync,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_get') return null;
    if (cmd === 'chroma_timeline_set') return null;
    if (cmd === 'chroma_timeline_clip_geometry') {
      return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
    }
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { openAllInspectorSections } = await import('./testUtils/inspectorSections');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
const { useHistoryStore } = await import('@apelles/history');
import type { Clip, Timeline } from './timeline';
import { typeNumber } from './testUtils/numberField';
import { fieldByLabel, sectionTitles, tabByLabel, tabLabels as tabLabelsOf } from './testUtils/inspectorDom';

const VIDEO_ID = 'hook-v';
const AUDIO_ID = 'hook-a';
/** The stray level the owner saw on the picture half — never mixed. */
const STRAY_VIDEO_VOLUME = 10.6;
/** The audible level on the audio partner. */
const AUDIO_VOLUME = 0.55;

function base(id: string, extra: Partial<Clip>): Clip {
  return {
    id,
    name: 'C01 hook demo',
    source_path: '/media/hook.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
    link_group: 'lg-hook',
    ...extra,
  } as unknown as Clip;
}

function fixture(): Timeline {
  const video = base(VIDEO_ID, {
    // The stray fields: set on the picture half, read by nothing.
    volume: STRAY_VIDEO_VOLUME,
    pan: -0.9,
    scale: 1.5,
    position_x: 0.2,
  });
  const audio = base(AUDIO_ID, {
    volume: 1,
    pan: 0.25,
    // The audible level is automated: 0.55 at the playhead, ramping down.
    chroma_keyframes: [
      { frame: 0, params: { volume: AUDIO_VOLUME } },
      { frame: 120, params: { volume: 0.2 } },
    ],
  });
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [
      { kind: 'video', clips: [video] },
      { kind: 'audio', clips: [audio] },
    ],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreOffsetMetrics: (() => void) | null = null;

function select(track: number, id: string) {
  actSync(() => useEditorTimelineStore.setState({ selection: [{ track, id }] }));
}

beforeEach(() => {
  // every Inspector section starts collapsed; these suites query inside them
  openAllInspectorSections(useEditorTimelineStore);
  restoreResizeObserver = installResizeObserverStub();
  restoreOffsetMetrics = stubOffsetMetrics(280, 92);
  useHistoryStore.getState().clear();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
    inspectorTab: 'video',
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreOffsetMetrics?.();
  restoreOffsetMetrics = null;
});

async function render(track: number, id: string, tabLabel: 'Video' | 'Audio') {
  select(track, id);
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
  const el = tabByLabel(mounted.container, tabLabel);
  if (!el) throw new Error(`no ${tabLabel} tab`);
  actSync(() => el.click());
  await waitFrames(2);
}

function field(label: string): HTMLInputElement {
  const input = fieldByLabel(mounted?.container, label);
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input as HTMLInputElement;
}

function keyframeToggle(label: string): HTMLElement {
  const el = mounted?.container.querySelector(`[aria-label="Toggle ${label} keyframes"]`);
  if (!el) throw new Error(`no keyframe toggle for ${label}`);
  return el as HTMLElement;
}

function type(input: HTMLInputElement, value: number) {
  typeNumber(input, value);
}

function clipAt(track: number): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[track].clips[0];
}

const SELECTIONS = [
  { name: 'the picture half', track: 0, id: VIDEO_ID },
  { name: 'the audio half', track: 1, id: AUDIO_ID },
] as const;

describe.each(SELECTIONS)('with $name selected (B-334)', ({ track, id }) => {
  it('the Audio tab shows the audible level, pan and keyframe — never the picture half’s stray 10.6', async () => {
    await render(track, id, 'Audio');
    expect(field('Volume').value).toBe(String(AUDIO_VOLUME));
    expect(field('Volume').value).not.toBe(String(STRAY_VIDEO_VOLUME));
    // The audio partner's own pan, not the picture half's -0.9.
    expect(field('Pan').value).toBe('0.25');
    // Volume is keyframed on the audio half, and the row says so.
    expect(keyframeToggle('Volume').getAttribute('aria-pressed')).toBe('true');
    expect(keyframeToggle('Pan').getAttribute('aria-pressed')).toBe('false');
  });

  it('editing the Audio tab writes the audio partner and leaves the picture half untouched', async () => {
    await render(track, id, 'Audio');
    type(field('Pan'), -0.5);
    await waitFrames(2);
    expect(clipAt(1).pan).toBe(-0.5);
    // The picture half keeps its legacy stray fields exactly as they were.
    expect(clipAt(0).pan).toBe(-0.9);
    expect(clipAt(0).volume).toBe(STRAY_VIDEO_VOLUME);

    // An animated property's edit lands on ITS keyframe at the playhead — on
    // the audio half's own key list.
    type(field('Volume'), 0.8);
    await waitFrames(2);
    expect(clipAt(1).chroma_keyframes?.find((k) => k.frame === 0)?.params.volume).toBe(0.8);
    expect(clipAt(0).chroma_keyframes ?? []).toEqual([]);
  });

  it('the EQ edits the audio partner’s bands', async () => {
    await render(track, id, 'Audio');
    // Band 1's Gain is the first "Gain" row.
    const gain = fieldByLabel(mounted?.container, 'Gain') as HTMLInputElement;
    type(gain, 6);
    await waitFrames(2);
    expect(clipAt(1).eq_bands?.[0]?.gain_db).toBe(6);
    expect(clipAt(0).eq_bands).toBeUndefined();
  });

  it('the Video tab shows the picture half’s transform and writes it there', async () => {
    await render(track, id, 'Video');
    expect(field('Scale').value).toBe('1.5');
    expect(field('Position X').value).toBe('0.2');
    type(field('Scale'), 2);
    await waitFrames(2);
    expect(clipAt(0).scale).toBe(2);
    // The audio half never grows a transform it would never draw.
    expect(clipAt(1).scale).toBeUndefined();
  });

  it('shows no Audio-only controls on the Video tab and no picture controls on the Audio tab', async () => {
    await render(track, id, 'Video');
    const headings = sectionTitles(mounted?.container);
    expect(headings).toContain('Transform');
    expect(headings).not.toContain('Audio');
    expect(headings).not.toContain('EQ');
  });
});

describe('a linked picture whose audio half is gone', () => {
  it('has no Audio tab — it is silent, so there is no level to show (D-129)', async () => {
    const tl = fixture();
    tl.tracks[1].clips = [];
    actSync(() => useEditorTimelineStore.setState({ timeline: tl }));
    select(0, VIDEO_ID);
    mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
    await waitFrames(2);
    const labels = [...mounted.container.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('aria-label'));
    expect(labels).not.toContain('Audio');
    expect(labels).toEqual(['Video', 'Speed', 'Info']);
  });
});

describe('an unlinked clip is unchanged', () => {
  it('a video clip with its own embedded audio still edits its own volume', async () => {
    const tl = fixture();
    tl.tracks[0].clips[0].link_group = null;
    tl.tracks[1].clips = [];
    actSync(() => useEditorTimelineStore.setState({ timeline: tl }));
    await render(0, VIDEO_ID, 'Audio');
    expect(field('Volume').value).toBe(String(STRAY_VIDEO_VOLUME));
  });
});
