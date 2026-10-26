// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the Inspector's Highlights section
 * (D-396/D-397): the human half of `editor_set_clip_highlights` and
 * `editor_suggest_clip_highlights`. Through the real `EditorInspectorPanel`,
 * the real section and the real `timelineStore.applyOp`; Tauri `invoke` is
 * stubbed (the OCR command returns a fixed headline). Proves the authoring
 * contract — what ends up in `Clip.highlights` — not what is drawn (that is the
 * compositor and ffmpeg parity tests).
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

const ocrLines = [
  {
    text: 'Breach exposed customer passwords',
    bbox: [0.1, 0.3, 0.9, 0.36],
    confidence: 0.9,
    words: ['Breach', 'exposed', 'customer', 'passwords'].map((text, i) => ({
      text,
      bbox: [0.1 + i * 0.2, 0.3, 0.1 + i * 0.2 + 0.18, 0.36],
      confidence: 0.9,
    })),
  },
];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_set') return null;
    if (cmd === 'chroma_ocr_media') return ocrLines;
    if (cmd === 'chroma_timeline_clip_geometry') {
      return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
    }
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { useHighlightEditStore } = await import('./highlightEditStore');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
import type { Clip, Timeline } from './timeline';

const CLIP_ID = 'page';

function fixture(withHighlight = false): Timeline {
  const clip: Clip = {
    id: CLIP_ID,
    name: 'article.png',
    source_path: '/media/article.png',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
    ...(withHighlight ? { highlights: [{ box: [0.1, 0.3, 0.5, 0.4], at: 10, dur: 12 }] } : {}),
  };
  return { id: 'tl', name: 'Timeline', rate: { num: 24, den: 1 }, tracks: [{ kind: 'video', clips: [clip] }] } as Timeline;
}

const currentClip = (): Clip => {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
};

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;

function setup(withHighlight = false) {
  useEditorTimelineStore.setState({
    timeline: fixture(withHighlight),
    status: 'ready',
    error: null,
    playhead: 48,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    inspectorTab: 'video',
  });
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  useHighlightEditStore.setState({ armedClipId: null, selected: null });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
});

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

const button = (selector: string): HTMLButtonElement => {
  const el = mounted?.container.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el as HTMLButtonElement;
};

function click(el: HTMLElement) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('the Inspector Highlights section (D-396)', () => {
  it('opening the panel on a clip with none writes nothing', async () => {
    setup();
    await render();
    expect(currentClip().highlights).toBeUndefined();
    expect(button('[data-highlight-add]')).toBeTruthy();
  });

  it('"Add at playhead" stores one highlight at the playhead’s source frame and arms the boxes', async () => {
    setup();
    await render();
    click(button('[data-highlight-add]'));
    const stored = currentClip().highlights;
    expect(stored).toHaveLength(1);
    expect(stored?.[0].at).toBe(48); // playhead 48, clip starts at 0, source_start 0
    expect(stored?.[0].dur).toBe(14); // 0.6 s at 24 fps, rounded
    expect(useHighlightEditStore.getState().armedClipId).toBe(CLIP_ID);
  });

  it('removing a row clears the key entirely when it was the last one', async () => {
    setup(true);
    await render();
    click(button('button[aria-label="Remove highlight 1"]'));
    expect('highlights' in currentClip()).toBe(false);
  });

  it('"Suggest from transcript" applies the suggestion through the same op (headline fallback here)', async () => {
    setup();
    await render();
    click(button('[data-highlight-suggest]'));
    await waitFrames(4);
    const stored = currentClip().highlights;
    expect(stored).toHaveLength(1);
    expect(stored?.[0].box[1]).toBeLessThan(0.3);
    expect(stored?.[0].at).toBe(0);
    expect(mounted?.container.textContent).toContain('largest line');
  });

  it('is absent for a title clip', async () => {
    setup();
    useEditorTimelineStore.setState({
      timeline: {
        ...fixture(),
        tracks: [
          {
            kind: 'video',
            clips: [
              {
                ...fixture().tracks[0].clips[0],
                source_path: '',
                text: { content: 'Hi', font: 'Inter', size: 0.1, color: '#ffffff' },
              },
            ],
          },
        ],
      } as Timeline,
    });
    await render();
    expect(mounted?.container.querySelector('[data-highlight-add]')).toBeNull();
  });
});
