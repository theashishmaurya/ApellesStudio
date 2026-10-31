// @vitest-environment jsdom
/**
 * @apelles/editor — D-432 P5's Final Cut arrangement of the Edit tab, on real
 * DOM: browser | viewer | Inspector share the upper band, the timeline spans
 * the full width beneath them, every split is a real resizable separator, the
 * viewer header's two toggles show and hide the side panels, the timeline
 * toolbar's centre holds the switcher and timecode, and the panels mount at
 * the persisted sizes.
 *
 * jsdom has no layout: "full width" is asserted structurally (the timeline
 * panel is a direct child of the outer vertical group, a sibling of the upper
 * band, not inside a column of it). The pixels are `app/harness.html?mode=edit`
 * in Chromium (`scratch/ui-redesign-p5/`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === 'chroma_text_fonts' ? [] : null),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock('./TimelinePane', () => ({
  TimelinePane: ({ toolbarCenter }: { toolbarCenter?: ReactNode }) =>
    React.createElement('div', { 'data-testid': 'timeline-pane' }, React.createElement('div', { 'data-testid': 'toolbar-center' }, toolbarCenter)),
}));
vi.mock('./PreviewPane', () => ({
  PreviewPane: ({ headerStart, headerEnd }: { headerStart?: ReactNode; headerEnd?: ReactNode }) =>
    React.createElement('div', { 'data-testid': 'preview-pane' }, headerStart, headerEnd),
}));
vi.mock('./TimelineSwitcher', () => ({
  TimelineSwitcher: () => React.createElement('span', { 'data-testid': 'timeline-switcher' }),
}));
vi.mock('./EditorInspectorPanel', () => ({ EditorInspectorPanel: () => null }));
vi.mock('./TextClipInspectorPanel', () => ({ TextClipInspectorPanel: () => null }));
vi.mock('./CaptionInspectorPanel', () => ({ CaptionInspectorPanel: () => null }));
vi.mock('./AdjustmentClipInspectorPanel', () => ({ AdjustmentClipInspectorPanel: () => null }));
vi.mock('./EditLibraryPanel', () => ({ EditLibraryPanel: () => null }));

import { installResizeObserverStub, stubOffsetMetrics } from './testUtils/pointerHarness';
import { EditorTab } from './EditorTab';
import { useEditorTimelineStore } from './timelineStore';
import { DEFAULT_EDIT_LAYOUT, useEditLayoutStore } from './editLayout';
import type { Timeline } from './timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const timeline = (tracks = true): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: 24, den: 1 },
  tracks: tracks
    ? [
        {
          kind: 'video',
          clips: [{ id: 'a', name: 'a', source_path: '/a.mov', source_start: 0, duration: 48, source_len: 48, start_frame: 0 }],
        },
      ]
    : [],
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);

let root: Root | null = null;
let restores: Array<() => void> = [];

beforeEach(() => {
  restores = [installResizeObserverStub(), stubOffsetMetrics()];
  useEditLayoutStore.setState({ ...DEFAULT_EDIT_LAYOUT, revision: 0, lastSource: 'hydrate' });
  useEditLayoutStore.getState().setPersist(null);
  useEditorTimelineStore.setState({
    timeline: timeline(),
    openProjectKey: '/projects/layout.chroma',
    status: 'ready',
    error: null,
    selection: [],
    selectedGap: null,
    inspectorOpen: true,
    libraryMode: 'sources',
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  restores.forEach((restore) => restore());
  useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' });
});

async function mountTab(): Promise<void> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(<EditorTab mediaPool={<div data-testid="media-pool" />} />);
  });
}

describe('D-432 P5 — the Final Cut arrangement', () => {
  it('spans the timeline across the full width beneath the three upper panels', async () => {
    await mountTab();
    const upper = q('[data-chroma-panel="edit-upper"]')!;
    const timelinePanel = q('[data-chroma-panel="edit-timeline"]')!;
    expect(upper).not.toBeNull();
    expect(timelinePanel).not.toBeNull();
    // Siblings in ONE vertical group: the timeline is not inside any column.
    expect(upper.parentElement).toBe(timelinePanel.parentElement);
    expect(upper.parentElement!.getAttribute('aria-orientation') ?? 'vertical').toBe('vertical');
    expect(upper.contains(timelinePanel)).toBe(false);
    expect(timelinePanel.contains(q('[data-testid="timeline-pane"]'))).toBe(true);

    // The upper band, left to right: browser, viewer, Inspector.
    const order = ['sources', 'edit-viewer', 'editor-inspector'].map((id) =>
      upper.querySelector<HTMLElement>(`[data-chroma-panel="${id}"]`),
    );
    expect(order.every(Boolean)).toBe(true);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The browser holds its tab bar and the injected media pool.
    expect(order[0]!.querySelector('[data-chroma-browser-tab="sources"]')).not.toBeNull();
    expect(order[0]!.querySelector('[data-testid="media-pool"]')).not.toBeNull();
  });

  it('makes every split a real resizable separator (browser, Inspector, upper / timeline)', async () => {
    await mountTab();
    const seps = document.querySelectorAll('[role="separator"]');
    expect(seps).toHaveLength(3);
    // The two in the upper band resize widths; the outer one resizes height.
    const orientations = [...seps].map((s) => s.getAttribute('aria-orientation'));
    expect(orientations.filter((o) => o === 'vertical')).toHaveLength(2);
    expect(orientations.filter((o) => o === 'horizontal')).toHaveLength(1);
  });

  it('hides and shows the browser and the Inspector from the viewer header toggles', async () => {
    await mountTab();
    const browserToggle = q('[aria-label="Hide the browser"]')!;
    act(() => browserToggle.click());
    expect(q('[data-chroma-panel="sources"]')).toBeNull();
    expect(useEditLayoutStore.getState().browserOpen).toBe(false);
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(2);
    act(() => q('[aria-label="Show the browser"]')!.click());
    expect(q('[data-chroma-panel="sources"]')).not.toBeNull();

    act(() => q('[aria-label="Inspector"]')!.click());
    expect(q('[data-chroma-panel="editor-inspector"]')).toBeNull();
    expect(useEditorTimelineStore.getState().inspectorOpen).toBe(false);
  });

  // A released drag committing to the store needs the library's real layout
  // pass (a ResizeObserver callback jsdom never fires); that half is checked
  // in Chromium on `app/harness.html?mode=edit` (ui-redesign.md, P5 as built).
  it('does not write the store on mount (a mount is not the user resizing)', async () => {
    useEditLayoutStore.getState().hydrate({ browserWidth: 333 });
    const before = useEditLayoutStore.getState().revision;
    await mountTab();
    expect(useEditLayoutStore.getState().revision).toBe(before);
    expect(useEditLayoutStore.getState().browserWidth).toBe(333);
  });

  it('centres the timeline switcher and timecode in the timeline toolbar', async () => {
    await mountTab();
    const centre = q('[data-testid="toolbar-center"]')!;
    expect(centre.querySelector('[data-testid="timeline-switcher"]')).not.toBeNull();
    expect(centre.querySelector('[data-chroma-timecode="timeline"]')).not.toBeNull();
  });

  it('gives an empty timeline (no tracks) its own switcher row, as the pane has no toolbar then', async () => {
    useEditorTimelineStore.setState({ timeline: timeline(false) });
    await mountTab();
    const switchers = document.querySelectorAll('[data-testid="timeline-switcher"]');
    expect(switchers).toHaveLength(2); // the row above, and the (empty) slot the pane ignores
    expect(q('[data-chroma-panel="edit-timeline"]')!.firstElementChild!.querySelector('[data-testid="timeline-switcher"]')).not.toBeNull();
  });
});
