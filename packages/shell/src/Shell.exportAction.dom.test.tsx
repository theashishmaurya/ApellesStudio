// @vitest-environment jsdom
/**
 * @apelles/shell — real-DOM coverage for D-251's chrome-bar `headerAction`
 * slot, using the SAME real consumer `Root.tsx` wires in production
 * (`@apelles/editor`'s `EditorExportDialog`) rather than a stand-in.
 *
 * Why the real component and not a fake. The owner's own ask was explicit:
 * "the real button/dialog lives in `WindowChrome.tsx`/`Shell.tsx` now, not
 * tab-local." A fake `<button>` standing in for `headerAction` would only
 * prove `Shell`'s own plumbing renders *something*; it would not prove the
 * thing the owner actually asked to see moved — the real Export trigger and
 * the real dialog it opens — actually lands there. So this file takes on
 * `@apelles/editor` as a **devDependency only** (`package.json`): the
 * package's own runtime `dependencies` are unchanged (still just
 * react + zustand + Tauri, per this package's module doc / `Shell.tsx`'s own
 * "Per-tab chrome-bar action" note), and `Shell.tsx`'s source never imports
 * `@apelles/editor` — only this test does, mirroring exactly what the real
 * composition root (`app/src/Root.tsx`) does at runtime: build the tabs
 * array with `@apelles/shell` and `@apelles/editor` both in scope, hand
 * `Shell` a `headerAction` node it never has to know the insides of.
 *
 * Three properties pinned:
 * 1. The Export trigger renders inside `Shell`'s own chrome bar (not inside
 *    any tab's `element`) while the Edit tab is active.
 * 2. Clicking it opens the SAME `EditorExportDialog` — asserted by its own
 *    dialog title text actually appearing in the document.
 * 3. Switching the active tab away from Edit removes the trigger from the
 *    chrome bar; switching back restores it — proving the slot is genuinely
 *    keyed off which tab is active, not a permanent chrome fixture.
 *
 * Tier and its honest limit: jsdom, so this proves DOM structure and click
 * wiring, not real window chrome/pixels — same limit every other `.dom.test`
 * in this codebase discloses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';

// Same flag `packages/editor/src/testUtils/pointerHarness.ts` sets, for the
// same reason: without it React logs "not configured to support act(...)"
// around every `act()` call in this file even though the call is correct.
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

// `EditorExportDialog` imports these; nothing in the assertions below drives
// an actual export, but the module-level imports must resolve under jsdom
// with no real Tauri backend.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve(undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: () => Promise.resolve(null),
}));

import { Shell, type ShellTab } from './Shell';
import { useShellStore } from './store';
import { EditorExportDialog } from '@apelles/editor';

/** Same stub `packages/editor/src/testUtils/pointerHarness.ts` installs for
 *  the identical reason: jsdom has no real layout engine, and
 *  `react-resizable-panels` (`Shell.tsx`'s own `ResizablePanelGroup`) expects
 *  `ResizeObserver` to exist. */
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

/** Same stub as `installElementAnimationsStub` in that file — Base UI's
 *  `Dialog`/`ScrollArea` call `Element.getAnimations`, which jsdom doesn't
 *  implement, from a timer outside this test's own `act()`, so an unstubbed
 *  call throws after the test body has already finished. */
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
});

afterEach(() => {
  restoreResizeObserver();
  restoreElementAnimations();
});

// A stable array reference (module-level, not rebuilt per render) — matches
// how `Root.tsx` builds it once per render of the composition root, and
// avoids the header-action subtree remounting on every unrelated re-render.
const tabs: ShellTab[] = [
  {
    id: 'edit',
    label: 'Edit',
    element: React.createElement('div', { 'data-testid': 'edit-body' }, 'Edit tab body'),
    headerAction: React.createElement(EditorExportDialog),
  },
  { id: 'motion', label: 'Motion', element: React.createElement('div', null, 'Motion tab body') },
  { id: 'colorist', label: 'Colorist', element: React.createElement('div', null, 'Colorist tab body') },
];

function mountShell() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(
      React.createElement(Shell, {
        projectOpen: true,
        launcher: React.createElement('div', null, 'launcher'),
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

function exportTrigger(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Export"]');
}

describe('Shell chrome-bar headerAction slot (D-251)', () => {
  it('renders the real Export trigger in the chrome bar while Edit is active, and it opens the real dialog', () => {
    const { container, unmount } = mountShell();
    try {
      const trigger = exportTrigger(container);
      expect(trigger).not.toBeNull();

      // It's in the chrome bar, not inside the Edit tab's own body.
      const editBody = container.querySelector('[data-testid="edit-body"]');
      expect(editBody?.contains(trigger)).toBe(false);

      expect(container.textContent).not.toContain('Export timeline');
      act(() => {
        trigger!.click();
      });
      // The SAME EditorExportDialog's own dialog title — proof this is the
      // real component, not a stand-in that merely looks the part.
      expect(document.body.textContent).toContain('Export timeline');
    } finally {
      unmount();
    }
  });

  it('hides the Export trigger when a different tab is active, and restores it when switching back', () => {
    const { container, unmount } = mountShell();
    try {
      expect(exportTrigger(container)).not.toBeNull();

      act(() => {
        useShellStore.getState().setActiveTab('motion');
      });
      expect(exportTrigger(container)).toBeNull();
      expect(container.textContent).toContain('Motion tab body');

      act(() => {
        useShellStore.getState().setActiveTab('colorist');
      });
      expect(exportTrigger(container)).toBeNull();

      act(() => {
        useShellStore.getState().setActiveTab('edit');
      });
      expect(exportTrigger(container)).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('never shows the trigger for Motion or Colorist, which register no headerAction of their own', () => {
    const { container, unmount } = mountShell();
    try {
      for (const id of ['motion', 'colorist'] as const) {
        act(() => {
          useShellStore.getState().setActiveTab(id);
        });
        expect(exportTrigger(container)).toBeNull();
      }
    } finally {
      unmount();
    }
  });
});
