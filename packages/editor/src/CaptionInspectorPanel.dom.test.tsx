// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for the Caption Inspector's Bold/Italic
 * toggle buttons (D-239, roadmap item 27).
 *
 * The same rule `TextClipInspectorPanel.dom.test.tsx` proves for a title's
 * `TextLayer.font`, proved here for a subtitle TRACK's `CaptionStyle.font` —
 * a different store op (`set_caption_style`), the same shared
 * `composeFontStyleKey`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { actSync, installResizeObserverStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_set') return null;
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { CaptionInspectorPanel } = await import('./CaptionInspectorPanel');
const { __setTextFontsForTest } = await import('./textFonts');
import { newCaptionClipFields, type Clip, type Timeline } from './timeline';
import type { TextFont } from './textFonts';

const FONTS: TextFont[] = [
  { key: 'sans', label: 'Sans', path: '/f/Arial.ttf', group: 'sans', bold: false, italic: false },
  { key: 'sans-bold', label: 'Sans Bold', path: '/f/Arial Bold.ttf', group: 'sans', bold: true, italic: false },
  { key: 'sans-italic', label: 'Sans Italic', path: '/f/Arial Italic.ttf', group: 'sans', bold: false, italic: true },
  {
    key: 'sans-bold-italic',
    label: 'Sans Bold Italic',
    path: '/f/Arial Bold Italic.ttf',
    group: 'sans',
    bold: true,
    italic: true,
  },
  { key: 'impact', label: 'Impact', path: '/f/Impact.ttf', group: null, bold: false, italic: false },
];

const CLIP_ID = 'cue-1';

function fixture(trackFont = 'sans'): Timeline {
  const clip: Clip = { ...newCaptionClipFields('Hello', 48, CLIP_ID), start_frame: 0 };
  return {
    id: 'tl',
    name: 'Timeline',
    tracks: [{ kind: 'subtitle', clips: [clip], caption_style: { font: trackFont } }],
  } as unknown as Timeline;
}

function currentTrackStyle() {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].caption_style;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  __setTextFontsForTest(FONTS);
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  __setTextFontsForTest(null);
});

function boldButton(): HTMLButtonElement {
  const el = [...(mounted?.container.querySelectorAll('button') ?? [])].find((b) => b.title === 'Bold');
  if (!el) throw new Error('no Bold button');
  return el as HTMLButtonElement;
}

function italicButton(): HTMLButtonElement {
  const el = [...(mounted?.container.querySelectorAll('button') ?? [])].find((b) => b.title === 'Italic');
  if (!el) throw new Error('no Italic button');
  return el as HTMLButtonElement;
}

function click(el: HTMLElement) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function render() {
  mounted = mount(React.createElement(CaptionInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

describe('the Caption Inspector’s Bold/Italic toggles (D-239)', () => {
  it('reads pressed/unpressed off the TRACK style’s current font', async () => {
    useEditorTimelineStore.setState({ timeline: fixture('sans-bold') });
    await render();
    expect(boldButton().getAttribute('aria-pressed')).toBe('true');
    expect(italicButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking Italic composes the sibling key onto the TRACK style, via set_caption_style', async () => {
    await render(); // starts on plain "sans"
    expect(currentTrackStyle()?.font).toBe('sans');
    click(italicButton());
    expect(currentTrackStyle()?.font).toBe('sans-italic');
  });

  it('a family with no italic/bold sibling (Impact) disables both toggles', async () => {
    useEditorTimelineStore.setState({ timeline: fixture('impact') });
    await render();
    expect(boldButton().disabled).toBe(true);
    expect(italicButton().disabled).toBe(true);
  });
});
