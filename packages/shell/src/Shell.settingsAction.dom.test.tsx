// @vitest-environment jsdom
/**
 * @apelles/shell — real-DOM coverage for the chrome bar's `settingsAction`
 * slot (B-396).
 *
 * Why it exists: Settings had no button anywhere in the app, on any tab, and
 * its one shortcut was `colorist`-scoped, so from Edit or Motion there was no
 * way in at all. The fix added this slot beside the two sibling openers
 * (Keyboard shortcuts, Connect to MCP) and filled it from `app/src`. Nothing
 * pinned the slot, so a refactor of the chrome bar could drop it again and
 * every suite would still pass.
 *
 * Three properties pinned: the slot renders in the chrome bar and not inside
 * the active tab's body; it is there on ALL THREE tabs, which is the half of
 * B-396 that was specifically broken; and it is gated on a project being open,
 * like its neighbours.
 *
 * What it does NOT do: use the real gear. `SettingsButton` lives in `app/src`
 * (the flag it sets is in that layer's UI store) and `@apelles/shell` must not
 * depend on the app, so the node here is a stand-in — this proves the slot,
 * and `app/src/components/chroma/SettingsButton.dom.test.tsx` proves the
 * button. Tier: jsdom, so DOM structure and wiring, not pixels.
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
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { Shell, type ShellTab } from './Shell';
import { useShellStore } from './store';

/** Same stub the other `.dom.test` files in this package install: jsdom has no
 *  layout engine and `react-resizable-panels` expects `ResizeObserver`. */
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
let opened = 0;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  opened = 0;
  useShellStore.setState({ activeTab: 'edit' });
});

afterEach(() => {
  restoreResizeObserver();
});

const tabs: ShellTab[] = [
  {
    id: 'edit',
    label: 'Edit',
    element: React.createElement('div', { 'data-testid': 'edit-body' }, 'Edit tab body'),
  },
  { id: 'motion', label: 'Motion', element: React.createElement('div', null, 'Motion tab body') },
  { id: 'colorist', label: 'Colorist', element: React.createElement('div', null, 'Colorist tab body') },
];

function settingsNode(): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      'aria-label': 'Settings',
      onClick: () => {
        opened += 1;
      },
    },
    'Settings',
  );
}

function mountShell(projectOpen: boolean) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(
      React.createElement(Shell, {
        projectOpen,
        launcher: React.createElement('div', null, 'launcher'),
        settingsAction: settingsNode(),
        tabs,
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

const trigger = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');

describe('Shell chrome-bar settingsAction slot (B-396)', () => {
  it('renders the opener in the chrome bar, not inside the active tab, and it fires', () => {
    const { container, unmount } = mountShell(true);
    try {
      const button = trigger(container);
      expect(button).not.toBeNull();
      expect(container.querySelector('[data-testid="edit-body"]')?.contains(button)).toBe(false);
      act(() => button!.click());
      expect(opened).toBe(1);
    } finally {
      unmount();
    }
  });

  it('is there on all three tabs — the half of B-396 that was broken', () => {
    const { container, unmount } = mountShell(true);
    try {
      for (const tab of ['edit', 'motion', 'colorist'] as const) {
        act(() => {
          useShellStore.getState().setActiveTab(tab);
        });
        expect(trigger(container), `Settings must be reachable from the ${tab} tab`).not.toBeNull();
      }
    } finally {
      unmount();
    }
  });

  it('is gated on a project being open, like its two sibling openers', () => {
    const { container, unmount } = mountShell(false);
    try {
      expect(trigger(container)).toBeNull();
    } finally {
      unmount();
    }
  });
});
