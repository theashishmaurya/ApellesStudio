// @vitest-environment jsdom
/**
 * @apelles/editor — the playhead is grabbed by its head only (B-349, B-346).
 *
 * jsdom has no hit testing, so this applies the REAL `timeline-overrides.css` to
 * the REAL rendered pane and asks what the pointer can reach: the 1 px line the
 * library makes its interact.js drag target must be pointer-transparent (a press
 * exactly on it falls through to the clip beneath), while the head and the band
 * under the ruler, its two descendants, must still take the pointer so the
 * library's ancestry-based drag still starts from them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
}));

import { useKeymapStore } from '@apelles/keymap';
import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import type { Timeline } from './timeline';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

const fixture: Timeline = {
  id: 'grab-tl',
  name: 'grab',
  rate: { num: 24, den: 1 },
  tracks: [
    {
      kind: 'video',
      clips: [{ id: 'a', name: 'A', source_path: '/a.mp4', source_start: 0, duration: 100, source_len: 100, start_frame: 0 }],
    },
  ],
};

let restores: (() => void)[] = [];
let mounted: MountedComponent | null = null;
let style: HTMLStyleElement;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restores = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub()];
  console_ = captureConsole();
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: { ...fixture, tracks: [{ kind: 'video', clips: [...fixture.tracks[0].clips] }] },
      openProjectKey: '/projects/grab.chroma',
      status: 'ready',
      error: null,
      playhead: 30,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  style = document.createElement('style');
  style.textContent = readFileSync(join(import.meta.dirname, 'timeline-overrides.css'), 'utf8');
  document.head.appendChild(style);
  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
});

afterEach(() => {
  console_.restore();
  mounted?.unmount();
  mounted = null;
  style.remove();
  restores.forEach((r) => r());
  actSync(() =>
    useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', playing: false, selection: [] }),
  );
});

/** `pointer-events` as the cascade resolves it, walking up like the inherited property does. */
function effectivePointerEvents(el: Element | null): string {
  for (let n = el; n; n = n.parentElement) {
    const v = getComputedStyle(n).pointerEvents;
    if (v && v !== 'auto' && v !== 'inherit') return v;
    if (v === 'auto' && n.matches('.timeline-editor-cursor-top, .timeline-editor-cursor-area')) return 'auto';
  }
  return 'auto';
}

describe('the playhead line does not grab (B-349)', () => {
  it('the 1 px line is pointer-transparent, so a press on it reaches the clip under it', () => {
    const line = mounted!.container.querySelector('.timeline-editor-cursor');
    const clip = mounted!.container.querySelector(`[data-testid="${TIMELINE_TEST_IDS.clip}"]`);
    expect(line).not.toBeNull();
    expect(clip).not.toBeNull();
    expect(getComputedStyle(line!).pointerEvents).toBe('none');
    expect(effectivePointerEvents(clip)).not.toBe('none');
  });

  it('the head and the band under the ruler still take the pointer and are inside the drag target', () => {
    const line = mounted!.container.querySelector('.timeline-editor-cursor');
    const head = line!.querySelector('.timeline-editor-cursor-top');
    const band = line!.querySelector('.timeline-editor-cursor-area');
    expect(head).not.toBeNull();
    expect(band).not.toBeNull();
    expect(getComputedStyle(head!).pointerEvents).toBe('auto');
    expect(getComputedStyle(band!).pointerEvents).toBe('auto');
  });
});
