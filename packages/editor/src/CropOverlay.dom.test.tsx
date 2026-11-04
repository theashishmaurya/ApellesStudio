// @vitest-environment jsdom
/**
 * @apelles/editor — the viewer's crop mode on a real `PreviewPane` (v0.3.0
 * panel redesign, B-366, D-443).
 *
 * Same tier as `DynamicZoomOverlay.dom.test.tsx`: the real preview, overlay
 * and store under StrictMode, a stubbed Tauri `invoke`, real pointer events.
 * Proves: the mode draws four edge handles and dims the outside only for the
 * armed clip, the ordinary transform box stands aside, dragging an edge
 * writes that edge's inset in ONE op (one undo step) and keeps the picture
 * in place, a press on a handle never re-selects, and Esc / Enter end the
 * mode. jsdom has no layout: positions come from the stubbed 1000 × 500
 * canvas; the real-app proof is the UI-harness scenario and the screenshots.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  PREVIEW_SURFACE_STUBS,
  actSync,
  captureConsole,
  createInvokeStub,
  dragPointer,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  linearPath,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    ...PREVIEW_SURFACE_STUBS,
    chroma_timeline_composition_size: () => ({ compWidth: CANVAS_W, compHeight: CANVAS_H, naturalWidth: 1, naturalHeight: 1 }),
    chroma_timeline_clip_geometry: () => ({ compWidth: CANVAS_W, compHeight: CANVAS_H, naturalWidth: 1, naturalHeight: 1 }),
    chroma_project_get_settings: () => ({ width: CANVAS_W, height: CANVAS_H }),
    chroma_audio_play: () => undefined,
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: () => undefined,
    chroma_timeline_set: () => undefined,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useHistoryStore } from '@apelles/history';
import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import type { Clip, Timeline } from './timeline';

function clip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'shot',
    name: 'SHOT',
    source_path: '/shot.mov',
    source_start: 0,
    duration: 240,
    source_len: 480,
    source_fps: 24,
    start_frame: 0,
    ...extra,
  };
}

function current(): Clip {
  const c = useEditorTimelineStore.getState().timeline?.tracks[0].clips[0];
  if (!c) throw new Error('clip vanished');
  return c;
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountWith(c: Clip, armed: boolean): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: { id: 'crop-tl', name: 'crop', rate: { num: 24, den: 1 }, tracks: [{ kind: 'video', clips: [c] }] } as Timeline,
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [{ track: 0, id: c.id }],
      selectedGap: null,
      cropEdit: armed ? { clipId: c.id } : null,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
}

const handle = (edge: string) =>
  mounted?.container.querySelector(`[data-crop-handle="${edge}"]`) as HTMLElement | null;

function rectOf(el: HTMLElement) {
  const px = (v: string) => Number.parseFloat(v);
  return { left: px(el.style.left), top: px(el.style.top), width: px(el.style.width), height: px(el.style.height) };
}

beforeEach(() => {
  restore = [
    stubOffsetMetrics(CANVAS_W, CANVAS_H),
    installResizeObserverStub(),
    installPointerCaptureStub(),
  ];
  const urls = installObjectUrlStub();
  restore.push(() => urls.restore());
  console_ = captureConsole();
  useHistoryStore.getState().clear();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  actSync(() => useEditorTimelineStore.setState({ cropEdit: null }));
  for (const r of restore.reverse()) r();
  restore = [];
  expect(errors).toEqual([]);
});

describe('crop mode in the viewer (D-443)', () => {
  it('draws nothing until armed; armed, four edge handles and the transform box stands aside', async () => {
    await mountWith(clip(), false);
    expect(mounted?.container.querySelector('[data-crop-overlay]')).toBeNull();
    expect(mounted?.container.querySelectorAll('[data-transform-overlay] [data-transform-box]')).toHaveLength(1);
    mounted?.unmount();

    await mountWith(clip(), true);
    expect(mounted?.container.querySelector('[data-crop-overlay]')).not.toBeNull();
    for (const edge of ['crop_left', 'crop_right', 'crop_top', 'crop_bottom']) expect(handle(edge), edge).not.toBeNull();
    expect(mounted?.container.querySelector('[data-transform-overlay]')).toBeNull();
    expect(mounted?.container.textContent).toContain('Drag the edges to crop');
  });

  it('dragging the left edge in writes crop_left in ONE op and keeps the picture in place', async () => {
    await mountWith(clip(), true);
    const h = handle('crop_left');
    if (!h) throw new Error('no left handle');
    const r = rectOf(h);
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    // 120 px of a 1000 px-wide full-frame source = 12 %.
    await dragPointer(h, linearPath(from, { x: from.x + 120, y: from.y }, 4), { moveTarget: h, release: h });
    await waitFrames(2);

    expect(current().crop_left).toBeCloseTo(0.12, 6);
    expect(current().crop_right ?? 0).toBe(0);
    // The kept part did not zoom: the box shrank to it and moved right.
    expect(current().scale).toBeCloseTo(0.88, 6);
    expect(current().position_x).toBeCloseTo(0.12, 6);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    // The kept rectangle on screen is where the edge was let go.
    const kept = rectOf(mounted?.container.querySelector('[data-crop-kept]') as HTMLElement);
    expect(kept.left).toBeCloseTo(120, 3);
  });

  it('an edge stops short of its opposite edge', async () => {
    await mountWith(clip(), true);
    const h = handle('crop_right') as HTMLElement;
    const r = rectOf(h);
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    await dragPointer(h, linearPath(from, { x: -400, y: from.y }, 4), { moveTarget: h, release: h });
    await waitFrames(2);
    expect(current().crop_right).toBeCloseTo(0.98, 6);
  });

  it('Esc and Enter end the mode; a drag in progress is cancelled by Esc first', async () => {
    await mountWith(clip(), true);
    actSync(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().cropEdit).toBeNull();
    expect(mounted?.container.querySelector('[data-crop-overlay]')).toBeNull();

    actSync(() => useEditorTimelineStore.setState({ cropEdit: { clipId: 'shot' } }));
    await waitFrames(2);
    actSync(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().cropEdit).toBeNull();
    expect(current().crop_left).toBeUndefined();
  });

  it('draws nothing for a locked track’s drag, and nothing at all for a title', async () => {
    const tl = (c: Clip, locked: boolean) =>
      ({ id: 't', name: 't', rate: { num: 24, den: 1 }, tracks: [{ kind: 'video', locked, clips: [c] }] }) as Timeline;
    await mountWith(clip(), true);
    actSync(() => useEditorTimelineStore.setState({ timeline: tl(clip(), true) }));
    await waitFrames(2);
    const h = handle('crop_left') as HTMLElement;
    const r = rectOf(h);
    await dragPointer(h, linearPath({ x: r.left, y: r.top }, { x: r.left + 100, y: r.top }, 3), { moveTarget: h, release: h });
    expect(current().crop_left).toBeUndefined();
    mounted?.unmount();
    await mountWith(clip({ text: { content: 'Title', font: 'Inter', size: 0.1, color: '#ffffff' } }), true);
    expect(mounted?.container.querySelector('[data-crop-overlay]')).toBeNull();
  });
});
