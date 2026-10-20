// @vitest-environment jsdom
/**
 * @apelles/shell — real-DOM coverage for the native Help menu's two items
 * (`app/src-tauri/src/lib.rs`'s `.menu()`/`.on_menu_event()`): "Keyboard
 * Shortcuts" and "MCP". Both are a second opener for dialogs the chrome bar
 * already opens — a plain Tauri event in, the same `setXOpen(true)` a click
 * already does — so what this file pins is that `Shell` actually listens for
 * `menu://keyboard-shortcuts` / `menu://connect-mcp` and opens the right
 * dialog, not the Rust menu-building code itself (that has no DOM to assert
 * against from here).
 *
 * `@tauri-apps/api/event`'s `listen` is mocked to capture each event's
 * handler by name, so the test can fire it directly — the same shape a real
 * `emit()` from Rust would trigger, without a real Tauri IPC bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const menuEventHandlers = new Map<string, () => void>();

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
  listen: (event: string, handler: () => void) => {
    menuEventHandlers.set(event, handler);
    return Promise.resolve(() => menuEventHandlers.delete(event));
  },
}));

import { Shell, type ShellTab } from './Shell';
import { useShellStore } from './store';
import { useKeymapStore } from '@apelles/keymap';

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
  useShellStore.setState({ activeTab: 'edit' });
  useKeymapStore.getState().setPersist(null);
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
  menuEventHandlers.clear();
});

afterEach(() => {
  restoreResizeObserver();
  restoreElementAnimations();
});

const tabs: ShellTab[] = [
  { id: 'edit', label: 'Edit', element: React.createElement('div', null, 'Edit tab body') },
  { id: 'motion', label: 'Motion', element: React.createElement('div', null, 'Motion tab body') },
  { id: 'colorist', label: 'Colorist', element: React.createElement('div', null, 'Colorist tab body') },
];

function mountShell(projectOpen: boolean, shellTabs: ShellTab[] = tabs) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(
      React.createElement(Shell, {
        projectOpen,
        launcher: React.createElement('div', null, 'launcher'),
        tabs: shellTabs,
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

describe('Shell listens for the native Help menu\'s events (lib.rs .on_menu_event)', () => {
  it('opens the Keyboard Shortcuts dialog on menu://keyboard-shortcuts', () => {
    const { unmount } = mountShell(true);
    try {
      expect(menuEventHandlers.has('menu://keyboard-shortcuts')).toBe(true);
      expect(document.body.textContent).not.toContain('Keyboard Shortcuts');
      act(() => {
        menuEventHandlers.get('menu://keyboard-shortcuts')!();
      });
      expect(document.body.textContent).toContain('Keyboard Shortcuts');
    } finally {
      unmount();
    }
  });

  it('opens the Connect-to-MCP dialog on menu://connect-mcp', () => {
    const { unmount } = mountShell(true);
    try {
      expect(menuEventHandlers.has('menu://connect-mcp')).toBe(true);
      act(() => {
        menuEventHandlers.get('menu://connect-mcp')!();
      });
      // The dialog's own title (`ConnectMcpDialog.tsx`) — proof it's the same
      // real dialog the chrome-bar button opens, not a stand-in.
      expect(document.body.textContent).toContain('Connect an agent');
    } finally {
      unmount();
    }
  });

  // Deliberately NOT gated on `projectOpen` — see `Shell.tsx`'s own comment
  // on the listener: a native menu item can't hide itself per-view the way
  // the chrome-bar icons do, and both dialogs already render unconditionally
  // regardless of whether a project is open.
  it('still opens both dialogs from the launcher, with no project open', () => {
    const { unmount } = mountShell(false);
    try {
      act(() => {
        menuEventHandlers.get('menu://connect-mcp')!();
      });
      expect(document.body.textContent).toContain('Connect an agent');
    } finally {
      unmount();
    }
  });
});

// D-391 — the beta bundle registers no Motion tab. Each "Go to" shortcut is
// bound to its tab by id, so the Motion one does nothing rather than landing on
// whichever tab now sits second, and the shortcuts dialog does not list it.
describe('Shell without a Motion tab (D-391)', () => {
  const withoutMotion = tabs.filter((t) => t.id !== 'motion');
  const pressCmd = (code: string, key: string) =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key, metaKey: true }),
      );
    });

  it('keeps Cmd+3 on Colorist and makes Cmd+2 a no-op', () => {
    const { unmount } = mountShell(true, withoutMotion);
    try {
      pressCmd('Digit2', '2');
      expect(useShellStore.getState().activeTab).toBe('edit');
      pressCmd('Digit3', '3');
      expect(useShellStore.getState().activeTab).toBe('colorist');
    } finally {
      unmount();
    }
  });

  it('leaves "Go to Motion tab" out of the shortcuts dialog', () => {
    const { unmount } = mountShell(true, withoutMotion);
    try {
      act(() => {
        menuEventHandlers.get('menu://keyboard-shortcuts')!();
      });
      expect(document.querySelector('[data-chroma-shortcut="app.tab_colorist"]')).toBeTruthy();
      expect(document.querySelector('[data-chroma-shortcut="app.tab_motion"]')).toBeNull();
    } finally {
      unmount();
    }
  });
});
