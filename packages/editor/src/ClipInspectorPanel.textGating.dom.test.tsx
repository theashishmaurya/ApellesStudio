// @vitest-environment jsdom
/**
 * @apelles/editor — a text/title clip's Inspector hides the rows that don't
 * do anything for it (a follow-up to D-211, filed live in this repo's own
 * roadmap right after that feature shipped).
 *
 * `resolve_text_clip_transform` (Rust) pins `scale`/`rotation`/crop/box size
 * to their identity values for a text clip regardless of what's stored, and
 * `editor_set_clip_transform` refuses a non-default write to any of them —
 * only `opacity`/`position_x`/`position_y` actually move anything for a
 * title. This proves the Inspector doesn't render the dead rows: a real
 * user (or an agent reading `debug_screenshot`) would otherwise see Scale/
 * Rotation/Crop/Width/Height fields that silently do nothing when edited.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  actSync,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_set') return null;
    if (cmd === 'chroma_timeline_clip_geometry') {
      return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
    }
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
import type { Clip, Timeline } from './timeline';
import { DEFAULT_TEXT_FONT } from './timeline';

const VIDEO_CLIP_ID = 'clip-1';
const TEXT_CLIP_ID = 'title-1';

function fixture(): Timeline {
  const videoClip: Clip = {
    id: VIDEO_CLIP_ID,
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  };
  const textClip: Clip = {
    id: TEXT_CLIP_ID,
    name: 'AFTER',
    source_path: '',
    source_start: 0,
    duration: 120,
    source_len: 120,
    start_frame: 0,
    text: { content: 'AFTER', font: DEFAULT_TEXT_FONT, size: 0.12, color: '#FFFFFF' },
  };
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [videoClip, textClip] }],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;

function selectClip(id: string) {
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id }],
    selectedGap: null,
    // D-246 — start every case on the Video tab. The Inspector's tab is
    // deliberately STICKY across selections (see the store field's own doc), so
    // a case that clicked over to Audio would otherwise leak that choice into
    // the next one.
    inspectorTab: 'video',
  });
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
});

function labelExists(label: string): boolean {
  const spans = [...(mounted?.container.querySelectorAll('span') ?? [])];
  return spans.some((s) => s.textContent === label);
}

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

/** D-246 — click the real Audio tab, the same button a human clicks. The
 *  text-clip cases below deliberately never call this: a title has no Audio
 *  tab at all, which is what `tabExists('Audio')` asserts instead. */
async function showAudioTab() {
  const tab = [...(mounted?.container.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === 'Audio',
  );
  if (!tab) throw new Error('no Audio tab');
  actSync(() => tab.click());
  await waitFrames(2);
}

function tabExists(label: string): boolean {
  return [...(mounted?.container.querySelectorAll('button') ?? [])].some(
    (b) => b.textContent === label,
  );
}

describe("a text clip's Inspector hides rows that do nothing for it", () => {
  it('an ordinary video clip gets every row: Scale, Rotation, Width, Height, and the Crop section', async () => {
    selectClip(VIDEO_CLIP_ID);
    await render();
    for (const label of ['Opacity', 'Position X', 'Position Y', 'Scale', 'Rotation', 'Width', 'Height', 'Left', 'Right', 'Top', 'Bottom']) {
      expect(labelExists(label)).toBe(true);
    }
    // D-223 — and its own audio level, which a media clip really has (its
    // embedded sound) even on a video track. D-246 — on the Audio tab now,
    // which is the point of this second half: the rows did not disappear, they
    // moved, and a video clip really does have that tab to move them to.
    for (const label of ['Volume', 'Pan']) {
      expect(labelExists(label)).toBe(false);
    }
    await showAudioTab();
    for (const label of ['Volume', 'Pan']) {
      expect(labelExists(label)).toBe(true);
    }
  });

  it('a text clip keeps Opacity/Position X/Position Y but loses Scale, Rotation, Width, Height, and the whole Crop section', async () => {
    selectClip(TEXT_CLIP_ID);
    await render();
    for (const label of ['Opacity', 'Position X', 'Position Y']) {
      expect(labelExists(label)).toBe(true);
    }
    for (const label of ['Scale', 'Rotation', 'Width', 'Height', 'Left', 'Right', 'Top', 'Bottom']) {
      expect(labelExists(label)).toBe(false);
    }
    // D-223 — a generated title has no audio stream at all, so its Volume and
    // Pan rows would be two more controls that visibly do nothing. Hidden for
    // the same reason, and by the same `!clip.text` gate, as Crop.
    for (const label of ['Volume', 'Pan']) {
      expect(labelExists(label)).toBe(false);
    }
    // D-246 — and there is no Audio TAB to go looking for them on either: the
    // gate is stated once now, in `clipInspectorTabs`, and with only one tab
    // left the bar itself is not drawn — a title's Inspector is exactly the
    // single scrolling column it was before tabs existed.
    expect(tabExists('Audio')).toBe(false);
    expect(tabExists('Video')).toBe(false);
  });

  it('switching selection from a text clip back to a video clip brings the hidden rows back', async () => {
    selectClip(TEXT_CLIP_ID);
    await render();
    expect(labelExists('Rotation')).toBe(false);

    actSync(() => {
      useEditorTimelineStore.setState({ selection: [{ track: 0, id: VIDEO_CLIP_ID }] });
    });
    await waitFrames(2);
    expect(labelExists('Rotation')).toBe(true);
  });
});
