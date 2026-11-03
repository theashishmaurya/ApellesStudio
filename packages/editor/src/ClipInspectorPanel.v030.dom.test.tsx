// @vitest-environment jsdom
/**
 * @apelles/editor — the clip Inspector's v0.3.0 gap closure against the
 * approved mockup (B-359 items 1 and 2; `docs/notes/ui-redesign.md` §6e):
 *
 * - the header shows the clip's duration on the timeline, as timecode;
 * - four icon tabs, Video / Audio / Speed / Info, Speed holding the retime and
 *   Info a read-only page of the media's probed facts and the clip's in / out;
 * - Position X / Y on one paired row behind one keyframe slot;
 * - Scale / Rotation / Opacity with an inline slider beside the value, a slider
 *   drag being ONE undo entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  nextFrame,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';
import { fieldByLabel, sectionTitles, tabByLabel, tabLabels } from './testUtils/inspectorDom';

const backend = vi.hoisted(() => ({ timeline: null as unknown }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_get') return backend.timeline;
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
const { useMediaPoolStore } = await import('@apelles/bridge');
import type { Clip, Timeline } from './timeline';

const CLIP_ID = 'clip-1';

function fixture(over: Partial<Clip> = {}): Timeline {
  const clip: Clip = {
    id: CLIP_ID,
    name: 'Broll_street_03',
    source_path: '/media/Broll_street_03.mov',
    media_id: 'm1',
    source_start: 24,
    duration: 168,
    source_len: 480,
    source_fps: 24,
    start_frame: 48,
    ...over,
  } as unknown as Clip;
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [clip] }],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restore: Array<() => void> = [];

beforeEach(() => {
  openAllInspectorSections(useEditorTimelineStore);
  restore.push(installResizeObserverStub(), installPointerCaptureStub());
  useHistoryStore.getState().clear();
  backend.timeline = fixture();
  useMediaPoolStore.setState({
    items: [
      {
        id: 'm1',
        sourcePath: '/media/Broll_street_03.mov',
        name: 'Broll_street_03.mov',
        added: '2026-11-03T00:00:00Z',
        offline: false,
        video: { width: 3840, height: 2160, fps: 24, frameCount: 480, durationSecs: 20, hasAudio: true, audioChannels: 2 },
      },
    ],
  });
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 48,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    inspectorTab: 'video',
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  for (const r of restore) r();
  restore = [];
  useMediaPoolStore.setState({ items: [] });
});

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(3);
}

function clip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
}

function click(el: Element) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('the header (B-359 item 1)', () => {
  it('shows the name and, on the right, the clip duration as timecode', async () => {
    await render();
    const dur = mounted?.container.querySelector('[data-chroma-inspector-duration]');
    // 168 source frames at 24 fps on a 24 fps timeline = 7 s.
    expect(dur?.textContent).toBe('00:00:07:00');
    expect(dur?.previousElementSibling?.textContent).toBe('Broll_street_03');
  });
});

describe('the four tabs (B-359 item 1)', () => {
  it('a media clip has Video / Audio / Speed / Info, in that order, as icon tabs', async () => {
    await render();
    expect(tabLabels(mounted?.container)).toEqual(['Video', 'Audio', 'Speed', 'Info']);
    for (const t of ['Video', 'Audio', 'Speed', 'Info']) {
      expect(tabByLabel(mounted?.container, t)?.querySelector('svg')).toBeTruthy();
    }
  });

  it('Speed holds the retime and the Video tab no longer does', async () => {
    await render();
    expect(sectionTitles(mounted?.container)).not.toContain('Speed');
    click(tabByLabel(mounted?.container, 'Speed') as HTMLElement);
    await waitFrames(2);
    expect(useEditorTimelineStore.getState().inspectorTab).toBe('speed');
    expect(sectionTitles(mounted?.container)).toEqual(['Speed']);
  });

  it('Info is read-only: the media facts from the pool probe and the clip in / out', async () => {
    useEditorTimelineStore.setState({ inspectorTab: 'info' });
    await render();
    const info = mounted?.container.querySelector('[data-chroma-panel="clip-info"]');
    const row = (label: string) =>
      info?.querySelector(`[data-chroma-info-row="${label}"] span:last-child`)?.textContent ?? null;
    expect(row('Name')).toBe('Broll_street_03.mov');
    expect(row('Format')).toBe('MOV');
    expect(row('Resolution')).toBe('3840 × 2160');
    expect(row('Frame rate')).toBe('24 fps');
    expect(row('Length')).toBe('00:00:20:00');
    expect(row('Audio')).toBe('Stereo');
    expect(row('Path')).toBe('/media/Broll_street_03.mov');
    expect(row('In')).toBe('00:00:01:00');
    expect(row('Out')).toBe('00:00:08:00');
    expect(row('Start')).toBe('00:00:02:00');
    expect(row('End')).toBe('00:00:09:00');
    expect(row('Duration')).toBe('00:00:07:00');
    // Nothing to type into.
    expect(info?.querySelectorAll('input, button, textarea').length).toBe(0);
    // No invented codec: the probe has none.
    expect(row('Codec')).toBeNull();
  });

  it('a title has Video and Info only, and its Info shows its kind and timeline place', async () => {
    const title = fixture({ source_path: '', media_id: null, text: { content: 'AFTER' } } as unknown as Partial<Clip>);
    useEditorTimelineStore.setState({ timeline: title, inspectorTab: 'info' });
    await render();
    expect(tabLabels(mounted?.container)).toEqual(['Video', 'Info']);
    const info = mounted?.container.querySelector('[data-chroma-panel="clip-info"]');
    expect(info?.querySelector('[data-chroma-info-row="Kind"] span:last-child')?.textContent).toBe('Title');
    expect(info?.querySelector('[data-chroma-info-row="Path"]')).toBeNull();
  });
});

describe('rows (B-359 item 2)', () => {
  it('Position X / Y share one row with one keyframe slot', async () => {
    await render();
    const labels = [...(mounted?.container.querySelectorAll('[data-slot="inspector-label"]') ?? [])].map(
      (l) => l.textContent,
    );
    expect(labels).toContain('Position');
    expect(labels).not.toContain('Position X');
    const row = [...(mounted?.container.querySelectorAll('[data-slot="inspector-row"]') ?? [])].find(
      (r) => r.querySelector('[data-slot="inspector-label"]')?.textContent === 'Position',
    ) as HTMLElement;
    const fields = [...row.querySelectorAll('[data-slot="number-scrubber"] input')].map((i) => i.getAttribute('aria-label'));
    expect(fields).toEqual(['Position X', 'Position Y']);
    expect(row.querySelectorAll('button[aria-label="Toggle Position keyframes"]')).toHaveLength(1);
  });

  it('the Position diamond animates both halves in one undo step, and stops both', async () => {
    await render();
    const diamond = mounted?.container.querySelector('button[aria-label="Toggle Position keyframes"]') as HTMLElement;
    click(diamond);
    await waitFrames(2);
    const params = (clip().chroma_keyframes ?? []).flatMap((k) => Object.keys((k as { params?: object }).params ?? {}));
    expect(params).toEqual(expect.arrayContaining(['position_x', 'position_y']));
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    click(mounted?.container.querySelector('button[aria-label="Toggle Position keyframes"]') as HTMLElement);
    await waitFrames(2);
    const after = (clip().chroma_keyframes ?? []).flatMap((k) => Object.keys((k as { params?: object }).params ?? {}));
    expect(after).not.toContain('position_x');
    expect(after).not.toContain('position_y');
  });

  it('Scale, Rotation, Opacity and Corner radius have an inline slider with a detent at the default', async () => {
    await render();
    const rowOf = (label: string) =>
      [...(mounted?.container.querySelectorAll('[data-slot="inspector-row"]') ?? [])].find(
        (r) => r.querySelector('[data-slot="inspector-label"]')?.textContent === label,
      ) as HTMLElement;
    // v0.3.0 (D-443) — the approved mockup gives Corner radius a slider too.
    for (const label of ['Scale', 'Rotation', 'Opacity', 'Corner radius']) {
      expect(rowOf(label).querySelector('[data-slot="inline-slider"]'), label).toBeTruthy();
      expect(rowOf(label).querySelector('[data-slot="inline-slider-detent"]'), label).toBeTruthy();
    }
  });

  it('a slider drag is ONE undo entry, and one undo restores the start', async () => {
    const track = { left: 100, width: 200 };
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute('data-slot') === 'inline-slider-track' || this.parentElement?.getAttribute('data-slot') === 'inline-slider') {
        return { x: track.left, y: 0, left: track.left, top: 0, width: track.width, height: 12, right: track.left + track.width, bottom: 12, toJSON: () => ({}) } as DOMRect;
      }
      return original.call(this);
    };
    restore.push(() => {
      HTMLElement.prototype.getBoundingClientRect = original;
    });
    await render();
    const opacity = fieldByLabel(mounted?.container, 'Opacity') as HTMLInputElement;
    const control = opacity
      .closest('[data-slot="slider-field"]')
      ?.querySelector('[data-slot="inline-slider"]')?.firstElementChild as HTMLElement;
    firePointerEvent(control, 'pointerdown', { x: track.left + 100, y: 6 });
    await nextFrame();
    for (const x of [90, 80, 60, 40]) {
      firePointerEvent(document, 'pointermove', { x: track.left + x, y: 6 });
      await nextFrame();
    }
    firePointerEvent(document, 'pointerup', { x: track.left + 40, y: 6 });
    firePointerEvent(window, 'pointerup', { x: track.left + 40, y: 6 });
    await waitFrames(2);
    expect(clip().opacity).toBeLessThan(1);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    await useHistoryStore.getState().undo();
    await waitFrames(2);
    expect(clip().opacity ?? 1).toBe(1);
  });
});
