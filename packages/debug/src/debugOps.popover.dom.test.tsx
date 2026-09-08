// @vitest-environment jsdom
/**
 * debugOps.popover.dom.test.tsx (D-251) — the real-DOM proof that
 * `debug_set_popover_open` actually opens/closes a real popover, not just a
 * store flag nothing renders off of.
 *
 * Every other test in this package (`domTree.test.ts`, `uiState.test.ts`)
 * checks pure functions or a hand-built `document.body.innerHTML` fixture.
 * That is the wrong level for THIS op: its entire point is driving the SAME
 * store action a real component's real click handler calls
 * (`panelRegistry.ts`'s `usePanelOpen`, `docs/notes/debug-tooling.md`'s
 * standing rule that a debug write is a store action, never a synthesised
 * click) — so the only test that actually proves it is one that mounts the
 * real component and watches its real popover appear.
 *
 * `CaptionPanel` is this repo's motivating case (the owner's ask this landed
 * for): its preset library was reachable only via a real mouse click before
 * this op existed, which is exactly the wall a headless agent hits with no
 * Accessibility/Screen-Recording permission on the native window.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: async () => null,
}));

const { useEditorTimelineStore, CaptionPanel } = await import('@chroma/editor');
const { DEBUG_OPS } = await import('./debugOps');

if (typeof globalThis !== 'undefined') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

/** jsdom has no `ResizeObserver`; Base UI's `Popover` positioning needs SOME
 *  implementation present, not a real one — nothing in this test resizes.
 *  Same stub `CaptionPanel.dom.test.tsx` uses, kept local rather than shared
 *  across the package boundary (D-039: a test-only helper is not worth a new
 *  export). */
function installResizeObserverStub(): () => void {
  const g = globalThis as { ResizeObserver?: unknown };
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

/** jsdom has no Web Animations API; Base UI's `ScrollAreaViewport` (inside
 *  the caption preset library) calls `Element.getAnimations` from a timer.
 *  Same stub `CaptionPanel.dom.test.tsx` uses. */
function installElementAnimationsStub(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a jsdom global with no type of its own to widen against, same shape the harness this mirrors uses
  const proto = (globalThis as any).Element?.prototype as Record<string, unknown> | undefined;
  if (!proto || typeof proto.getAnimations === 'function') return () => {};
  proto.getAnimations = () => [];
  return () => {
    delete proto.getAnimations;
  };
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function waitFrames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

interface Mounted {
  container: HTMLElement;
  unmount(): void;
}

function mount(element: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

let mounted: Mounted | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreAnimations: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  restoreAnimations = installElementAnimationsStub();
  useEditorTimelineStore.setState({
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a minimal Timeline fixture, same shape CaptionPanel.dom.test.tsx uses
    } as any,
    status: 'ready',
    error: null,
    // D-251 — the popover's open flag lives here now; must start closed
    // explicitly rather than inheriting whatever a previous test left.
    openPanels: {},
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreAnimations?.();
  restoreAnimations = null;
});

function popoverInDom(): boolean {
  return document.querySelector('[data-testid="caption-panel"]') !== null;
}

describe('debug_set_popover_open', () => {
  it('opens the real CaptionPanel popover through the op, not a synthesised click', async () => {
    mounted = mount(React.createElement(CaptionPanel));
    await waitFrames(2);
    expect(popoverInDom(), 'closed before the op runs').toBe(false);

    const result = await DEBUG_OPS.debug_set_popover_open({ id: 'caption-panel', open: true });
    await waitFrames(2);

    expect(result).toEqual({ ok: true, id: 'caption-panel', open: true });
    expect(popoverInDom(), 'the op must actually open the real popover').toBe(true);
    // Not a stand-in: the real preset library content (the Styles tab, shown
    // by default) is what rendered, not an empty shell.
    expect(document.querySelector('[data-testid^="caption-preset-"]')).not.toBeNull();
  });

  it('closes it again the same way', async () => {
    mounted = mount(React.createElement(CaptionPanel));
    await waitFrames(2);
    await DEBUG_OPS.debug_set_popover_open({ id: 'caption-panel', open: true });
    await waitFrames(2);
    expect(popoverInDom()).toBe(true);

    const result = await DEBUG_OPS.debug_set_popover_open({ id: 'caption-panel', open: false });
    await waitFrames(2);

    expect(result).toEqual({ ok: true, id: 'caption-panel', open: false });
    expect(popoverInDom()).toBe(false);
  });

  it('refuses an unknown panel id by name, per D-216, rather than silently no-op-ing', async () => {
    mounted = mount(React.createElement(CaptionPanel));
    await waitFrames(2);

    const result = await DEBUG_OPS.debug_set_popover_open({ id: 'no-such-panel', open: true });

    expect(result).toEqual({
      error: `unknown panel "no-such-panel" — expected one of caption-panel, canvas-settings, export-dialog`,
    });
    expect(popoverInDom(), 'a refused op must not have opened anything').toBe(false);
  });

  it('refuses a missing `open` argument', async () => {
    const result = await DEBUG_OPS.debug_set_popover_open({ id: 'caption-panel' });
    expect(result).toEqual({ error: "'open' is required (true or false)" });
  });
});
