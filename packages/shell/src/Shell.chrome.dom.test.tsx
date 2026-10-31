// @vitest-environment jsdom
/**
 * @apelles/shell — real-DOM coverage for D-432 P5's chrome and the tab-owned
 * library column (this replaces D-263's `Shell.libraryRail` suite: the rail
 * slots it covered are gone with the rail).
 *
 * Pinned:
 * 1. The top bar is the spec §4.2 bar: a `Projects / <name>` breadcrumb whose
 *    `Projects` closes the project, the three tabs as a centred segmented
 *    control (`role="tab"`, the active one `aria-selected`), Export last on
 *    the right.
 * 2. A tab with `ownsLibraryColumn` (the Edit tab) gets neither the docked
 *    library column nor the floating Sources chip — it lays its browser out
 *    itself, so the timeline can run full width beneath it — while Motion and
 *    Colorist keep both.
 *
 * Tier: jsdom — DOM structure, order and click wiring, not painted geometry;
 * `app/harness.html?mode=edit` in Chromium is the visual check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos' }));
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
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

import { Shell, type ShellTab } from './Shell';
import { useShellStore } from './store';

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

let restoreResizeObserver: () => void;
let closed = 0;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  closed = 0;
  useShellStore.setState({ activeTab: 'edit', sourcesPanelOpen: true });
});

afterEach(() => {
  restoreResizeObserver();
});

const TABS: ShellTab[] = [
  {
    id: 'edit',
    label: 'Edit',
    element: React.createElement('div', { 'data-testid': 'edit-body' }, 'Edit tab body'),
    ownsLibraryColumn: true,
  },
  { id: 'motion', label: 'Motion', element: React.createElement('div', null, 'Motion tab body') },
  { id: 'colorist', label: 'Colorist', element: React.createElement('div', null, 'Colorist body') },
];

function mountShell(projectName?: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(
      React.createElement(Shell, {
        projectOpen: true,
        projectName,
        onCloseProject: () => {
          closed += 1;
        },
        launcher: React.createElement('div', null, 'launcher'),
        sourcesPanel: React.createElement('div', { 'data-testid': 'sources-body' }, 'media pool'),
        headerAction: React.createElement('button', { 'aria-label': 'Export', type: 'button' }, 'Export'),
        activityAction: React.createElement('button', { 'aria-label': 'Agent activity', type: 'button' }),
        tabs: TABS,
      }),
    );
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const dock = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-chroma-panel="sources"]');
const sourcesChip = (c: HTMLElement) => c.querySelector<HTMLElement>('button[aria-label="Sources"]');

describe('D-432 P5 — the top bar', () => {
  it('shows the Projects / name breadcrumb, and Projects closes the project', () => {
    const { container, unmount } = mountShell('Five Levels of AI');
    try {
      const crumb = container.querySelector('nav[aria-label="Breadcrumb"]')!;
      expect(crumb.textContent).toContain('Projects');
      expect(crumb.querySelector('[data-chroma-project-name]')!.textContent).toBe('Five Levels of AI');
      act(() => crumb.querySelector<HTMLButtonElement>('button')!.click());
      expect(closed).toBe(1);
    } finally {
      unmount();
    }
  });

  it('omits the name (and its slash) when none is known', () => {
    const { container, unmount } = mountShell();
    try {
      expect(container.querySelector('[data-chroma-project-name]')).toBeNull();
      expect(container.querySelector('nav[aria-label="Breadcrumb"]')!.textContent!.trim()).toBe('Projects');
    } finally {
      unmount();
    }
  });

  it('draws the tabs as one segmented control and switches on click', () => {
    const { container, unmount } = mountShell('P');
    try {
      const list = container.querySelector('[role="tablist"][aria-label="Apelles tabs"]')!;
      const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      expect(tabs.map((t) => t.textContent)).toEqual(['Edit', 'Motion', 'Colorist']);
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');
      expect(tabs[0].className).toContain('bg-card-active');
      act(() => tabs[1].click());
      expect(useShellStore.getState().activeTab).toBe('motion');
      expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    } finally {
      unmount();
    }
  });

  it('puts Export last in the right group, after the icon buttons', () => {
    const { container, unmount } = mountShell('P');
    try {
      const exportBtn = container.querySelector('button[aria-label="Export"]')!;
      const group = exportBtn.parentElement!;
      const labels = [...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
      expect(labels.indexOf('Export')).toBe(labels.length - 1);
      expect(labels).toEqual(expect.arrayContaining(['Agent activity', 'Keyboard shortcuts', 'Connect to MCP']));
    } finally {
      unmount();
    }
  });
});

describe('D-432 P5 — a tab that owns its library column', () => {
  it('gets no docked column and no floating Sources chip; Motion keeps both', () => {
    const { container, unmount } = mountShell('P');
    try {
      expect(dock(container), 'the Edit tab lays its browser out itself').toBeNull();
      expect(sourcesChip(container)).toBeNull();
      expect(container.querySelector('[data-testid="sources-body"]')).toBeNull();

      act(() => useShellStore.getState().setActiveTab('motion'));
      expect(dock(container), 'Motion keeps the shell column').not.toBeNull();
      expect(sourcesChip(container)).not.toBeNull();
      expect(container.querySelector('[data-testid="sources-body"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });
});
