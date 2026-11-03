// @vitest-environment jsdom
/**
 * D-431 — the platform safe-area guide, end to end in a real DOM: the toolbar
 * menu, the overlay it mounts, its tracking of the viewport zoom, the MCP ops
 * (`editor_get_safe_areas`, `editor_set_safe_area_view`) driving the same
 * store value, and the guarantee that a guide never reaches an export.
 *
 * Tier and honest limit: jsdom, so no layout engine — `stubOffsetMetrics`
 * fixes the preview surface at 1000x500 and the assertions are on the pixel
 * geometry the overlay ASKED for, not on painted pixels. Placement against a
 * real picture is a live check (see D-431's verification note).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import {
  PREVIEW_SURFACE_STUBS,
  actSync,
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

const COMP = vi.hoisted(() => ({ w: 1080, h: 1920 }));
const SURFACE_W = 1000;
const SURFACE_H = 500;
const FPS = 25;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    ...PREVIEW_SURFACE_STUBS,
    chroma_timeline_composition_size: () => ({
      compWidth: COMP.w,
      compHeight: COMP.h,
      naturalWidth: 1,
      naturalHeight: 1,
    }),
    chroma_timeline_clip_geometry: () => ({
      compWidth: COMP.w,
      compHeight: COMP.h,
      naturalWidth: 1,
      naturalHeight: 1,
    }),
    chroma_project_get_settings: () => ({ width: COMP.w, height: COMP.h }),
    chroma_audio_play: () => undefined,
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: () => undefined,
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

const bus = vi.hoisted(() => ({
  listeners: new Map<string, Set<(ev: { payload: unknown }) => unknown>>(),
  emitted: [] as { event: string; payload: unknown }[],
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => unknown) => {
    const set = bus.listeners.get(event) ?? new Set();
    set.add(handler);
    bus.listeners.set(event, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
  emit: (event: string, payload: unknown) => {
    bus.emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';
import { PreviewPane } from './PreviewPane';
import { compileEditorExportArgs } from './editorExport';
import type { Timeline } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `safe-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

function fixtureTimeline(): Timeline {
  return {
    id: 'safe-tl',
    name: 'safe',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'a',
            name: 'A',
            source_path: '/a.mov',
            source_start: 0,
            duration: 500,
            source_len: 500,
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
let mounted: MountedComponent | null = null;

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement(PreviewPane);
}

async function mountHarness(w = 1080, h = 1920): Promise<void> {
  COMP.w = w;
  COMP.h = h;
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixtureTimeline(),
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 10,
      playing: false,
      selection: [],
      selectedGap: null,
      safeAreaView: 'off',
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(5);
}

const overlay = (): HTMLElement | null =>
  (mounted?.container.querySelector('[data-safe-area-overlay]') as HTMLElement | null) ?? null;
const trigger = (): HTMLElement | null =>
  (mounted?.container.querySelector('[data-safe-area-trigger]') as HTMLElement | null) ?? null;

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(SURFACE_W, SURFACE_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  bus.emitted.length = 0;
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({ safeAreaView: 'off' }));
  document.body.innerHTML = '';
});

describe('the safe-area guide (D-431)', () => {
  it('draws nothing by default, and the toolbar offers the menu', async () => {
    await mountHarness();
    expect(overlay()).toBeNull();
    expect(trigger()).not.toBeNull();
    expect(trigger()!.getAttribute('aria-pressed')).toBe('false');
    // A 9:16 timeline hints that the check is available, without switching it on.
    expect(mounted!.container.querySelector('[data-safe-area-hint]')).not.toBeNull();
  });

  it('shows no hint dot on a landscape timeline', async () => {
    await mountHarness(1920, 1080);
    expect(mounted!.container.querySelector('[data-safe-area-hint]')).toBeNull();
  });

  it('the menu picks a preset and the overlay appears; Off removes it', async () => {
    await mountHarness();
    await act(async () => {
      trigger()!.click();
    });
    await waitFrames(3);
    const items = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
    const labels = items.map((i) => i.textContent);
    expect(labels).toEqual([
      'Off',
      'All vertical platforms',
      'YouTube Shorts',
      'Instagram Reels',
      'TikTok',
      'Title + Action safe',
    ]);
    await act(async () => {
      items[4].click();
    });
    await waitFrames(3);
    expect(useEditorTimelineStore.getState().safeAreaView).toBe('tiktok');
    expect(overlay()?.getAttribute('data-safe-area-overlay')).toBe('tiktok');
    expect(trigger()!.getAttribute('aria-pressed')).toBe('true');

    actSync(() => useEditorTimelineStore.getState().setSafeAreaView('off'));
    await waitFrames(2);
    expect(overlay()).toBeNull();
  });

  it('is pointer-events none, so it never swallows a transform drag', async () => {
    await mountHarness();
    actSync(() => useEditorTimelineStore.getState().setSafeAreaView('vertical-union'));
    await waitFrames(3);
    expect(overlay()!.className).toContain('pointer-events-none');
  });

  it('draws the TikTok safe rect proportionally inside the picture box, and tracks zoom', async () => {
    await mountHarness();
    actSync(() => useEditorTimelineStore.getState().setSafeAreaView('tiktok'));
    await waitFrames(3);
    const root = overlay()!;
    const rect = root.querySelector('[data-safe-area-rect="safe"]') as HTMLElement;
    const boxW = parseFloat(root.style.width);
    const boxH = parseFloat(root.style.height);
    // 120/1080 of the width from the left; 240/1920 of the height from the top.
    expect(parseFloat(rect.style.left) / boxW).toBeCloseTo(120 / 1080, 3);
    expect(parseFloat(rect.style.top) / boxH).toBeCloseTo(240 / 1920, 3);
    expect(parseFloat(rect.style.height) / boxH).toBeCloseTo((1920 - 240 - 660) / 1920, 3);

    actSync(() => useEditorTimelineStore.getState().setPreviewView({ zoom: 2, panX: 0, panY: 0 }));
    await waitFrames(3);
    const zoomed = overlay()!;
    expect(parseFloat(zoomed.style.width)).toBeCloseTo(boxW * 2, 1);
    expect(parseFloat(zoomed.style.height)).toBeCloseTo(boxH * 2, 1);
    const zrect = zoomed.querySelector('[data-safe-area-rect="safe"]') as HTMLElement;
    expect(parseFloat(zrect.style.left) / parseFloat(zoomed.style.width)).toBeCloseTo(120 / 1080, 3);
  });

  it('broadcast draws two nested rectangles', async () => {
    await mountHarness(1000, 500);
    actSync(() => useEditorTimelineStore.getState().setSafeAreaView('broadcast'));
    await waitFrames(3);
    expect(overlay()!.querySelectorAll('[data-safe-area-rect]')).toHaveLength(2);
  });

  it('never reaches an export: the compiled argv is identical with the guide on', async () => {
    await mountHarness();
    const args = { outPath: '/tmp/out.mp4', width: 1080, height: 1920 };
    const off = compileEditorExportArgs(args, fixtureTimeline());
    actSync(() => useEditorTimelineStore.getState().setSafeAreaView('vertical-union'));
    const on = compileEditorExportArgs(args, fixtureTimeline());
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });
});

describe('editor_get_safe_areas / editor_set_safe_area_view (D-431) — the agent-side half', () => {
  it('reports every preset as pixel rectangles on the active 1080x1920 timeline', async () => {
    await mountHarness();
    const env = await callOp('editor_get_safe_areas');
    expect(env.ok).toBe(true);
    expect(env.result.frame).toEqual({ width: 1080, height: 1920 });
    expect(env.result.active).toBe('off');
    expect(env.result.suggested[0]).toBe('vertical-union');
    expect(env.result.recommended.rect).toMatchObject({ x: 120, y: 288, width: 768, height: 960 });
    const tiktok = env.result.presets.find((p: { id: string }) => p.id === 'tiktok');
    expect(tiktok.regions[0]).toMatchObject({ x: 120, y: 240, width: 840, height: 1020 });
    expect(tiktok.source).toMatch(/upload-post/);
  });

  it('answers in the timeline pixels of a 3840x2160 frame too', async () => {
    await mountHarness(3840, 2160);
    const env = await callOp('editor_get_safe_areas');
    const broadcast = env.result.presets.find((p: { id: string }) => p.id === 'broadcast');
    expect(broadcast.regions[1]).toMatchObject({ id: 'title', x: 384, y: 216, width: 3072, height: 1728 });
    expect(env.result.recommended.preset).toBe('broadcast');
  });

  it('set_safe_area_view mounts the same overlay the menu does, and the state reports it', async () => {
    await mountHarness();
    const env = await callOp('editor_set_safe_area_view', { preset: 'instagram-reels' });
    await waitFrames(3);
    expect(env.ok).toBe(true);
    expect(env.result.safeAreaView).toBe('instagram-reels');
    expect(overlay()?.getAttribute('data-safe-area-overlay')).toBe('instagram-reels');
    expect(trigger()!.getAttribute('aria-pressed')).toBe('true');
    expect((await callOp('editor_get_safe_areas')).result.active).toBe('instagram-reels');

    const off = await callOp('editor_set_safe_area_view', { enabled: false });
    await waitFrames(3);
    expect(off.result.safeAreaView).toBe('off');
    expect(overlay()).toBeNull();
  });

  it('enabled:true alone switches on the suggested guide for the frame', async () => {
    await mountHarness();
    const env = await callOp('editor_set_safe_area_view', { enabled: true });
    expect(env.result.safeAreaView).toBe('vertical-union');
  });

  it('rejects an empty call and an unknown preset', async () => {
    await mountHarness();
    expect((await callOp('editor_set_safe_area_view', {})).ok).toBe(false);
    const bad = await callOp('editor_set_safe_area_view', { preset: 'snapchat' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/unknown preset/);
  });
});
