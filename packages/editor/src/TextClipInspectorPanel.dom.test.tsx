// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the Title Inspector's Bold/Italic
 * toggle buttons (D-240, roadmap item 27).
 *
 * `textFonts.test.ts` proves `composeFontStyleKey`/`fontStyleOf` in
 * isolation; this proves the half a human actually touches — that the
 * buttons render pressed/unpressed for the CURRENT `TextLayer.font`, that
 * clicking one writes the composed key through the real `set_text_clip` op
 * (not a second, parallel field), that changing FAMILY keeps whatever
 * Bold/Italic was already on, and that a family with no italic/bold sibling
 * (Impact) disables both buttons rather than silently doing nothing on
 * click.
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
const { TextClipInspectorPanel } = await import('./TextClipInspectorPanel');
const { __setTextFontsForTest } = await import('./textFonts');
import { newTextClipFields, newTextLayer, type Clip, type Timeline } from './timeline';
import type { TextFont } from './textFonts';

/** The same catalogue shape `chroma_text_fonts` resolves on a real machine
 *  (D-240): four `sans` siblings, one standalone `impact` with no italic. */
const FONTS: TextFont[] = [
  { key: 'sans', label: 'Sans', path: '/fonts/Arial.ttf', group: 'sans', bold: false, italic: false },
  { key: 'sans-bold', label: 'Sans Bold', path: '/fonts/Arial Bold.ttf', group: 'sans', bold: true, italic: false },
  { key: 'sans-italic', label: 'Sans Italic', path: '/fonts/Arial Italic.ttf', group: 'sans', bold: false, italic: true },
  {
    key: 'sans-bold-italic',
    label: 'Sans Bold Italic',
    path: '/fonts/Arial Bold Italic.ttf',
    group: 'sans',
    bold: true,
    italic: true,
  },
  { key: 'impact', label: 'Impact', path: '/fonts/Impact.ttf', group: null, bold: false, italic: false },
];

const CLIP_ID = 'title-1';

function fixture(font = 'sans'): Timeline {
  const layer = newTextLayer({ content: 'HELLO', font });
  if ('error' in layer) throw new Error(layer.error);
  const clip: Clip = { ...newTextClipFields(layer, 48), id: CLIP_ID, start_frame: 0 };
  return { id: 'tl', name: 'Timeline', tracks: [{ kind: 'video', clips: [clip] }] } as unknown as Timeline;
}

function currentClip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
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
  mounted = mount(React.createElement(TextClipInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

describe('the Title Inspector’s Bold/Italic toggles (D-240)', () => {
  it('reads pressed/unpressed off the CURRENT font, not a separate stored field', async () => {
    useEditorTimelineStore.setState({ timeline: fixture('sans-bold-italic') });
    await render();
    expect(boldButton().getAttribute('aria-pressed')).toBe('true');
    expect(italicButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking Bold composes the sibling key and writes it through set_text_clip', async () => {
    await render(); // starts on plain "sans"
    expect(currentClip().text?.font).toBe('sans');
    click(boldButton());
    expect(currentClip().text?.font).toBe('sans-bold');
    // The layer itself never grew a `bold` field — `font` is still the ONE
    // stored key (D-212/D-240).
    expect(Object.keys(currentClip().text ?? {})).not.toContain('bold');
  });

  it('Bold and Italic compose together, in either click order', async () => {
    await render();
    click(boldButton());
    click(italicButton());
    expect(currentClip().text?.font).toBe('sans-bold-italic');
  });

  it('toggling Bold back off returns to plain "sans", keeping Italic if it was on', async () => {
    useEditorTimelineStore.setState({ timeline: fixture('sans-bold-italic') });
    await render();
    click(boldButton());
    expect(currentClip().text?.font).toBe('sans-italic');
  });

  it('a family with no italic/bold sibling (Impact) disables both toggles', async () => {
    useEditorTimelineStore.setState({ timeline: fixture('impact') });
    await render();
    expect(boldButton().disabled).toBe(true);
    expect(italicButton().disabled).toBe(true);
  });
});
