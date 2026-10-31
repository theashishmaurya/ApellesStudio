// @vitest-environment jsdom
// B-267 — a timeline mounted while hidden measures its real width once it is shown.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useViewportWidth } from './useViewportWidth';

let observers: Array<() => void> = [];

class FakeResizeObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe() {
    observers.push(this.cb);
  }
  disconnect() {
    observers = observers.filter((o) => o !== this.cb);
  }
  unobserve() {}
}

let host: HTMLDivElement;
let root: Root;
let el: HTMLDivElement;
let widthPx = 0;
let latest = 0;

function Probe({ target }: { target: HTMLElement | null }): null {
  latest = useViewportWidth(target);
  return null;
}

async function mountWith(initialWidth: number) {
  widthPx = initialWidth;
  await act(async () => {
    root.render(React.createElement(Probe, { target: el }));
  });
}

async function resizeTo(next: number) {
  widthPx = next;
  await act(async () => {
    observers.forEach((o) => o());
  });
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  observers = [];
  widthPx = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { get: () => widthPx });
  root = createRoot(host);
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('useViewportWidth (B-267)', () => {
  it('reports 0 for an element mounted hidden, then its real width when it is shown', async () => {
    await mountWith(0);
    expect(latest).toBe(0);
    await resizeTo(1200);
    expect(latest).toBe(1200);
    await resizeTo(900); // an ordinary panel drag afterwards
    expect(latest).toBe(900);
  });

  it('follows a hide and a re-show', async () => {
    await mountWith(1200);
    expect(latest).toBe(1200);
    await resizeTo(0); // hidden later (a tab switch)
    expect(latest).toBe(0);
    await resizeTo(800);
    expect(latest).toBe(800);
  });
});
