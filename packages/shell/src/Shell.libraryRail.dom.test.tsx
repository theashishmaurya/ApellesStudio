// @vitest-environment jsdom
/**
 * @chroma/shell — real-DOM coverage for D-263's per-tab `libraryRail` /
 * `libraryPanel` slots, using the SAME real consumers `Root.tsx` wires in
 * production (`@chroma/editor`'s `EditLibraryRail` and `EditLibraryPanel`)
 * and the same composition, for the same reason `Shell.exportAction.dom.
 * test.tsx` uses the real `EditorExportDialog`: the owner's ask was about
 * where the REAL rail sits relative to the REAL docked column, and a stand-in
 * `<div>` would only prove `Shell` renders *something* in a slot.
 *
 * `@chroma/editor` is a **devDependency** of this package (`package.json`) and
 * is imported only by these tests. `Shell.tsx` itself imports nothing from it;
 * the harness below mirrors what `Root.tsx` does at runtime — hold both
 * stores, hand `Shell` two nodes it never has to know the insides of.
 *
 * The four properties pinned, all of them the owner's own words:
 * 1. The rail is the LEFTMOST thing in the content area — before the docked
 *    column in document order ("this panel should be to the left of the open
 *    panel, not the other way around").
 * 2. Picking a library switches what the DOCKED COLUMN shows, in place ("it
 *    should be opening in this panel only as we switch") — and the shared
 *    Sources panel stays MOUNTED but hidden while it does, so its own state
 *    survives.
 * 3. Picking the library already showing collapses the column (VS Code
 *    activity-bar semantics), and the rail survives to reopen it.
 * 4. A tab with a rail does not also get the shell's floating Sources chip;
 *    a tab without one still does.
 *
 * Tier and its honest limit: jsdom, so this proves DOM structure, document
 * order and click wiring — not painted geometry. "Left of" is asserted as
 * document order inside the same horizontal `ResizablePanelGroup`, which is
 * what decides left-to-right here; real pixels are the owner/live check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: () => 'macos',
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    close: () => {},
    minimize: () => {},
    setFullscreen: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve(undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: () => Promise.resolve(null),
  open: () => Promise.resolve(null),
}));

import { Shell, type ShellTab } from './Shell';
import { useShellStore } from './store';
import { EditLibraryPanel, EditLibraryRail, useEditorTimelineStore } from '@chroma/editor';

/** jsdom has no layout engine, and `react-resizable-panels` expects a
 *  `ResizeObserver`; Base UI's tooltip/tabs reach for `getAnimations`. Same
 *  two stubs `Shell.exportAction.dom.test.tsx` installs, for the same reasons. */
function installResizeObserverStub(): () => void {
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  const had = 'ResizeObserver' in g;
  const original = g.ResizeObserver;
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  return () => {
    if (had) g.ResizeObserver = original;
    else delete g.ResizeObserver;
  };
}

function installElementAnimationsStub(): () => void {
  const proto = (globalThis as unknown as { Element?: { prototype: Record<string, unknown> } }).Element
    ?.prototype;
  if (!proto || typeof proto.getAnimations === 'function') return () => {};
  proto.getAnimations = () => [];
  return () => {
    delete proto.getAnimations;
  };
}

let restoreResizeObserver: () => void;
let restoreElementAnimations: () => void;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  restoreElementAnimations = installElementAnimationsStub();
  useShellStore.setState({ activeTab: 'edit', sourcesPanelOpen: true });
  useEditorTimelineStore.setState({
    libraryMode: 'sources',
    timeline: {
      id: 'tl',
      name: 'Timeline',
      rate: 24,
      tracks: [
        {
          kind: 'video',
          clips: [
            {
              id: 'v1',
              name: 'shot.mp4',
              source_path: '/media/shot.mp4',
              source_start: 0,
              duration: 240,
              source_len: 240,
              source_fps: 24,
              start_frame: 0,
            },
          ],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a minimal Timeline fixture, the same shape the editor package's own DOM suites use
    } as any,
    status: 'ready',
    playhead: 0,
    selection: [],
  });
});

afterEach(() => {
  restoreResizeObserver();
  restoreElementAnimations();
});

/** Exactly what `Root.tsx` does: the shell owns whether the column is OPEN,
 *  `@chroma/editor` owns WHICH library it shows, and the composition root is
 *  the only place that holds both. */
function Harness(): React.ReactElement {
  const sourcesPanelOpen = useShellStore((s) => s.sourcesPanelOpen);
  const setSourcesPanelOpen = useShellStore((s) => s.setSourcesPanelOpen);
  const libraryMode = useEditorTimelineStore((s) => s.libraryMode);

  const tabs: ShellTab[] = [
    {
      id: 'edit',
      label: 'Edit',
      element: React.createElement('div', { 'data-testid': 'edit-body' }, 'Edit tab body'),
      libraryRail: React.createElement(EditLibraryRail, {
        dockOpen: sourcesPanelOpen,
        onDockOpenChange: setSourcesPanelOpen,
      }),
      libraryPanel: libraryMode === 'sources' ? undefined : React.createElement(EditLibraryPanel),
    },
    { id: 'motion', label: 'Motion', element: React.createElement('div', null, 'Motion tab body') },
    { id: 'colorist', label: 'Colorist', element: React.createElement('div', null, 'Colorist body') },
  ];

  return React.createElement(Shell, {
    projectOpen: true,
    launcher: React.createElement('div', null, 'launcher'),
    sourcesPanel: React.createElement('div', { 'data-testid': 'sources-body' }, 'media pool'),
    tabs,
  });
}

function mountShell() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(React.createElement(Harness));
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const rail = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-chroma-panel="edit-library-rail"]');
const dock = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-chroma-panel="sources"]');
const railButton = (c: HTMLElement, mode: string) =>
  c.querySelector<HTMLElement>(`[data-chroma-rail-button="${mode}"]`);
/** `Shell`'s OWN floating opener (D-120), not the rail's Sources button —
 *  which is the whole point of this assertion, and which also carries
 *  `aria-label="Sources"`. */
const shellSourcesChip = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('button[aria-label="Sources"]:not([data-chroma-rail-button])');

describe('Shell per-tab library rail + docked library column (D-263)', () => {
  it('renders the rail to the LEFT of the docked column, both inside the content area', () => {
    const { container, unmount } = mountShell();
    try {
      const railEl = rail(container);
      const dockEl = dock(container);
      expect(railEl, 'the Edit tab registered a rail').not.toBeNull();
      expect(dockEl, 'the docked column is open').not.toBeNull();

      // DOCUMENT_POSITION_FOLLOWING (4) means the dock comes after the rail —
      // i.e. the rail is first in the row, which is what puts it on the left.
      // This is the exact inversion the owner reported: before D-263 the rail
      // was rendered inside the Edit tab's own panel group, which is a SIBLING
      // of this column and always after it.
      const order = railEl!.compareDocumentPosition(dockEl!);
      expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // …and the rail is not inside the tab's own body any more.
      expect(container.querySelector('[data-testid="edit-body"]')?.contains(railEl!)).toBe(false);
    } finally {
      unmount();
    }
  });

  it('switches what the docked column shows, in place, and keeps Sources mounted while it does', () => {
    const { container, unmount } = mountShell();
    try {
      expect(container.querySelector('[data-testid="sources-body"]')).not.toBeNull();
      expect(container.querySelector('[data-chroma-panel="edit-library"]')).toBeNull();

      act(() => railButton(container, 'titles')!.click());

      const library = container.querySelector<HTMLElement>('[data-chroma-panel="edit-library"]');
      expect(library, 'the Titles library replaced the media pool').not.toBeNull();
      expect(library!.getAttribute('data-chroma-library-mode')).toBe('titles');
      // In the SAME column — not a second panel beside it.
      expect(dock(container)!.contains(library!)).toBe(true);

      // The shared media pool is still mounted (its search text, open bin and
      // scroll survive the trip), just hidden — with a plain `hidden` class,
      // never a Base UI primitive whose hide waits on a rAF that a
      // non-frontmost window never fires (B-124).
      const sourcesBody = container.querySelector('[data-testid="sources-body"]');
      expect(sourcesBody, 'still mounted').not.toBeNull();
      expect(sourcesBody!.parentElement!.className).toContain('hidden');

      // Switching again swaps the content and leaves exactly one library
      // panel behind — no stacking.
      act(() => railButton(container, 'subtitles')!.click());
      expect(container.querySelectorAll('[data-chroma-panel="edit-library"]')).toHaveLength(1);
      expect(
        container
          .querySelector('[data-chroma-panel="edit-library"]')!
          .getAttribute('data-chroma-library-mode'),
      ).toBe('subtitles');

      // …and back to Sources shows the pool again, un-hidden.
      act(() => railButton(container, 'sources')!.click());
      expect(container.querySelector('[data-chroma-panel="edit-library"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="sources-body"]')!.parentElement!.className,
      ).not.toContain('hidden');
    } finally {
      unmount();
    }
  });

  it('collapses the column when the library already showing is clicked again, and reopens it', () => {
    const { container, unmount } = mountShell();
    try {
      expect(dock(container)).not.toBeNull();

      act(() => railButton(container, 'sources')!.click());
      expect(dock(container), 'clicking the active library collapses the column').toBeNull();
      expect(rail(container), 'the rail itself survives, so it can be reopened').not.toBeNull();

      act(() => railButton(container, 'titles')!.click());
      expect(dock(container), 'a different library reopens it').not.toBeNull();
      expect(
        container.querySelector('[data-chroma-panel="edit-library"]')!.getAttribute('data-chroma-library-mode'),
      ).toBe('titles');
    } finally {
      unmount();
    }
  });

  it('drops the shell’s own floating Sources chip on a tab that has a rail, and keeps it on one that does not', () => {
    const { container, unmount } = mountShell();
    try {
      expect(
        shellSourcesChip(container),
        'the rail is this column’s opener now — a second one a step to its right is the very thing D-120 fixed',
      ).toBeNull();

      act(() => {
        useShellStore.getState().setActiveTab('motion');
      });
      expect(
        shellSourcesChip(container),
        'Motion has no rail, so it keeps the chip',
      ).not.toBeNull();
      expect(rail(container), 'and no rail of its own').toBeNull();
    } finally {
      unmount();
    }
  });
});
