/**
 * @chroma/editor — pointerHarness: the reusable real-DOM pointer-gesture test
 * harness (D-142, roadmap item 12 follow-up).
 *
 * **What it is.** This exact kind of harness — mount a real component into a
 * real DOM, drive it with real, correctly-sequenced `PointerEvent`s (not
 * React synthetic events, and not a native-`DragEvent`-driving tool that
 * can't reach a `PointerSensor`), under `<React.StrictMode>`, with real
 * `requestAnimationFrame` waits between steps — has been built from scratch
 * at least five separate times in this repo (D-095, D-096, D-098, D-100,
 * D-137), every time as a scratch Vite entry (`app/harness.html` +
 * `app/src/harness-main.tsx`), and every time deleted afterward, never
 * committed. Each of those decisions independently re-derived the same real
 * lessons — a synthetic `DataTransfer`/native-drag tool can't drive dnd-kit's
 * `PointerSensor` at all (D-098); firing a whole gesture synchronously in one
 * script call never lets dnd-kit's or React's own measurement/commit effects
 * run, so real `requestAnimationFrame` waits between events are required, not
 * optional (D-098); `window.blur` plus a real synthetic `pointercancel` (not
 * just resetting local state) is the only way to correctly release both this
 * app's state AND dnd-kit's own internal per-`pointerId` sensor state
 * (D-100); StrictMode's double-invoke is a real, distinct thing to verify
 * under, not an incidental detail (D-098/D-100/D-137). This file is that
 * common pattern, extracted for real instead of rebuilt a sixth time.
 *
 * **What it does NOT do.** It does not replace the interactive, real-Chromium
 * verification this repo's pointer-gesture decisions have always leaned on
 * (`mcp__chrome-devtools__*` driving `app/harness.html`, kept permanently now
 * instead of scratch-deleted — see that file's own header). This module's DOM
 * primitives (`firePointerEvent`/`dragPointer`/`waitFrames`/`captureConsole`)
 * work identically in a real browser or in jsdom, but `mount` and
 * `stubOffsetMetrics`/`installResizeObserverStub`/`createInvokeStub` below
 * are the pieces that make a permanent, CI-runnable jsdom test possible —
 * and jsdom has no real layout engine (`getBoundingClientRect`/
 * `offsetWidth`/`clientWidth` on an unstubbed element are always zero,
 * there's no real paint, and dnd-kit's own rect-based collision detection
 * measures against that same fake zero geometry, so cross-track/track-reorder
 * *drop-target resolution* cannot be trusted the way it can against a real
 * Chromium paint). A jsdom-driven test built on this file is a real,
 * permanent, stronger-than-pure-logic regression check (real DOM, real
 * `PointerEvent`s, real event bubbling/capture, the real component tree) —
 * but it is not a substitute for the real-browser tier when what's being
 * verified is pixel geometry or a dnd-kit drop-target decision. Say which
 * tier a given check is when you use this file; don't blur the two.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';

// `act()` only suppresses React's "not wrapped in act" warning when the
// current environment is flagged as an act-aware test environment — true
// under vitest's jsdom environment, not generally assumed here.
if (typeof globalThis !== 'undefined') {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// ---------------------------------------------------------------------------
// Real PointerEvent dispatch
// ---------------------------------------------------------------------------

export interface PointerPoint {
  x: number;
  y: number;
}

export interface PointerEventOptions {
  pointerId?: number;
  button?: number;
  buttons?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** D-235 — Alt/Option, the modifier that arms the context-sensitive trim
   *  tool (`trimMode.ts`). Added here rather than worked around in the test:
   *  a gesture whose whole meaning comes from a modifier cannot be covered by
   *  a harness that silently drops it. */
  altKey?: boolean;
  pointerType?: string;
}

const DEFAULT_BUTTONS_FOR: Record<string, number> = {
  pointerdown: 1,
  pointermove: 1,
  pointerup: 0,
  pointercancel: 0,
};

/** Dispatch one real `PointerEvent` — a genuine DOM event constructed via the
 *  real `PointerEvent` constructor and sent through `dispatchEvent`, not a
 *  React synthetic event. This is the exact distinction D-098 found matters:
 *  a tool that only drives native `DragEvent`s (or that calls React's
 *  `simulate`-style synthetic dispatch) never reaches a `PointerSensor`'s own
 *  `onPointerDown`, because dnd-kit deliberately doesn't listen for the
 *  events that class of tool produces.
 *
 *  Wrapped in `act()`: the state update a listener makes happens
 *  SYNCHRONOUSLY inside `dispatchEvent` itself, before this function
 *  returns — a later `await nextFrame()`'s own `act()` wrap is too late to
 *  retroactively cover it (React's act-environment warns about the update
 *  the instant it happens, not about whether it's eventually flushed). This
 *  matters most for this app's own window-level marquee/dnd-kit listeners
 *  (`TimelinePane.tsx`'s own doc: registered on `window`, not via React
 *  props, precisely so mid-drag pointer capture can't retarget hit-testing)
 *  — a plain native `addEventListener` callback is invisible to React's
 *  batching unless the dispatch that triggers it is itself act-wrapped. */
export function firePointerEvent(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  point: PointerPoint,
  opts: PointerEventOptions = {},
): void {
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: opts.pointerId ?? 1,
    button: opts.button ?? 0,
    buttons: opts.buttons ?? DEFAULT_BUTTONS_FOR[type],
    clientX: point.x,
    clientY: point.y,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    pointerType: opts.pointerType ?? 'mouse',
    isPrimary: true,
  };
  const event = new PointerEvent(type, init);
  // D-235 — jsdom leaves `pageX`/`pageY` at 0 no matter what `clientX`/
  // `clientY` are set to; a real browser always derives them (`clientX +
  // scrollX`). That gap is not cosmetic: `interact.js`, which drives the
  // timeline library's own edge-resize handles, reads the page coordinates
  // when it computes a drag's delta, so under an unpatched jsdom every resize
  // gesture looks like it never moved. Defined here so a synthetic pointer
  // event carries the same coordinate pair a real one would. The page has no
  // scroll in these tests, so `page === client` exactly.
  Object.defineProperty(event, 'pageX', { value: point.x, configurable: true });
  Object.defineProperty(event, 'pageY', { value: point.y, configurable: true });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** One real animation-frame tick, wrapped in React's own `act()` — D-098's
 *  own methodology finding is that firing a gesture's events back-to-back in
 *  the same script call never lets dnd-kit's (or React's) measurement/commit
 *  effects run between them, which is a synthetic-test artifact, not
 *  something real pointer input would ever hit (a human moving a real mouse
 *  takes many multiples of one frame to get anywhere). The `act()` wrap is a
 *  jsdom-test-only concern layered on top of that real timing requirement:
 *  it is what lets an unrelated async effect elsewhere in the tree (e.g.
 *  `Waveform`/`Filmstrip`'s own `invoke(...).then(setState)`) settle within
 *  a scope React recognizes, instead of firing a spurious "not wrapped in
 *  act" warning for a component this test isn't even about. */
export async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

export async function waitFrames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

/** Real wall-clock time, wrapped in `act()` — the same jsdom concern
 *  [`nextFrame`] handles, for the cases where what a test is waiting on is a
 *  real `setTimeout` rather than a frame. Animation frames are useless for
 *  those: a debounce measured in hundreds of milliseconds (`timelineStore`'s
 *  own `SAVE_DEBOUNCE_MS`, B-088) will not fire inside any realistic number
 *  of `waitFrames` calls, and the state updates its callback eventually
 *  makes would land outside `act` and warn.
 *
 *  Deliberately real timers, not `vi.useFakeTimers()`: the sequences these
 *  tests cover interleave timers with promise resolutions (the debounce
 *  fires → `invoke` resolves → a `.then` sets state → an effect re-runs and
 *  invokes again), and faking one of those two clocks while the other stays
 *  real is precisely how a test starts asserting an ordering the real app
 *  never has. */
export async function waitMs(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

/** Run `fn` (a store `setState`, or any other out-of-band mutation a test
 *  wants React to see) inside `act()`, so components subscribed to it
 *  re-render — and their event handlers close over the NEW value — before
 *  this returns. Without this, a store update made directly from a test body
 *  (bypassing the app's own UI) can race a handler's stale closure: real,
 *  not theoretical — this is exactly what a bare `store.setState(...)`
 *  outside `act()` produces. */
export function actSync(fn: () => void): void {
  act(fn);
}

/** A real press → (N intermediate moves, one real frame apart) → release,
 *  matching the exact event sequence and timing discipline D-098/D-100/D-137
 *  each verified live pointer gestures with. `press`/`release` target the
 *  element the real gesture would actually receive those events on;
 *  `moveTarget` defaults to `window` because this app's own marquee/dnd-kit
 *  move+up listeners are registered at `window` level (`TimelinePane.tsx`'s
 *  own doc: pointer capture would retarget hit-testing mid-drag, which this
 *  codebase has already been burned by), not on the element the gesture
 *  started on. Returns after the release event and one settle frame, so any
 *  effect the release triggers has had a chance to commit. */
export async function dragPointer(
  press: EventTarget,
  path: PointerPoint[],
  opts: PointerEventOptions & { moveTarget?: EventTarget; release?: EventTarget } = {},
): Promise<void> {
  if (path.length < 1) throw new Error('dragPointer needs at least one point (the press point)');
  const moveTarget = opts.moveTarget ?? (typeof window !== 'undefined' ? window : press);
  const releaseTarget = opts.release ?? moveTarget;
  firePointerEvent(press, 'pointerdown', path[0], opts);
  await nextFrame();
  for (let i = 1; i < path.length; i++) {
    firePointerEvent(moveTarget, 'pointermove', path[i], opts);
    await nextFrame();
  }
  firePointerEvent(releaseTarget, 'pointerup', path[path.length - 1], opts);
  await nextFrame();
}

/** A straight-line path from `from` to `to` in `steps` even increments
 *  (inclusive of both ends) — the common case for a plain drag. */
export function linearPath(from: PointerPoint, to: PointerPoint, steps = 4): PointerPoint[] {
  const pts: PointerPoint[] = [from];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// jsdom geometry stand-ins
// ---------------------------------------------------------------------------

/** jsdom implements no real layout engine: every element's `offsetWidth`/
 *  `offsetHeight`/`clientWidth`/`clientHeight` is `0` unless stubbed, which
 *  is exactly the value `react-virtualized`'s `AutoSizer` (used inside
 *  `@xzdarcy/react-timeline-editor`) treats as "nothing to render." Stubbing
 *  these on `HTMLElement.prototype` to one fixed, disclosed size is what lets
 *  the REAL `TimelinePane` — including its real virtualized clip rows, not a
 *  stand-in — actually paint real `[data-chroma-clip-drag]` DOM nodes under
 *  jsdom. This is a documented, common jsdom+react-virtualized technique, not
 *  a hidden hack: every consumer of this file gets the same fixed viewport,
 *  and callers needing a different size pass one in. Returns a restore
 *  function; always call it in `afterEach`/`finally`, since this mutates a
 *  shared prototype for the whole test file. */
export function stubOffsetMetrics(width = 1200, height = 600): () => void {
  const proto = HTMLElement.prototype as any;
  const keys = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const;
  const original = keys.map((k) => Object.getOwnPropertyDescriptor(proto, k));
  keys.forEach((k) => {
    Object.defineProperty(proto, k, {
      configurable: true,
      get() {
        return k === 'offsetWidth' || k === 'clientWidth' ? width : height;
      },
    });
  });
  return () => {
    keys.forEach((k, i) => {
      if (original[i]) Object.defineProperty(proto, k, original[i]!);
      else delete proto[k];
    });
  };
}

/** D-235 — the companion to [`stubOffsetMetrics`] for `getBoundingClientRect`,
 *  which jsdom answers with an all-zero rect for every element because it has
 *  no layout engine.
 *
 *  Needed because the context-sensitive trim tool reads a real box: which half
 *  of a clip's row a press landed in is what separates a slip from a slide
 *  (`trimMode.ts`), and against a zero-height rect every press is at ratio 0
 *  and every gesture resolves to slip — a test on that geometry would pass
 *  while proving nothing.
 *
 *  The rect is DERIVED, not invented: `@xzdarcy/react-timeline-editor`
 *  absolutely-positions each clip with real inline `left`/`width`/`height`
 *  styles (verified on the rendered DOM, e.g. `height: 52px; left: 20px;
 *  width: 180px`), which is exactly what a browser's own layout would turn
 *  into that element's rect. An element with no inline box of its own — the
 *  library's own edge-resize handles, which are CSS-positioned inside their
 *  clip — inherits the nearest ancestor that has one, which is the same box
 *  the browser would give it modulo its own inset. `top` is taken from inline
 *  `top` when present and 0 otherwise, so a test that cares about the vertical
 *  band should use the first track's row; this helper does not attempt to
 *  reconstruct the whole stacked-row layout, and says so rather than pretending.
 *
 *  Opt-in per test file (it mutates a shared prototype) and returns a restore
 *  function; always call it in `afterEach`. */
export function stubBoundingRectsFromInlineStyle(): () => void {
  const proto = Element.prototype;
  const original = proto.getBoundingClientRect;
  const px = (v: string): number => {
    const n = Number.parseFloat(v);
    return v.endsWith('px') && Number.isFinite(n) ? n : Number.NaN;
  };
  /** The nearest self-or-ancestor with an inline width AND height, or null. */
  const boxFor = (el: Element): { left: number; top: number; width: number; height: number } | null => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const width = px(node.style.width);
      const height = px(node.style.height);
      if (Number.isNaN(width) || Number.isNaN(height)) continue;
      const left = px(node.style.left);
      const top = px(node.style.top);
      return {
        left: Number.isNaN(left) ? 0 : left,
        top: Number.isNaN(top) ? 0 : top,
        width,
        height,
      };
    }
    return null;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const box = boxFor(this);
    if (!box) return original.call(this);
    const { left, top, width, height } = box;
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }),
    } as DOMRect;
  };
  return () => {
    proto.getBoundingClientRect = original;
  };
}

/** jsdom has no `ResizeObserver` at all. `TimelinePane.tsx`'s own D-128
 *  effect (`new ResizeObserver(() => setViewportWidth(el.clientWidth))`)
 *  just needs SOME implementation present so the effect doesn't throw; it
 *  doesn't need to ever actually fire for jsdom's fixed-stub geometry above
 *  (nothing resizes in a test), so this is deliberately a no-op observer,
 *  not a polyfill that tries to detect real layout changes jsdom can't
 *  produce anyway. Returns a restore function. */
export function installResizeObserverStub(): () => void {
  const g = globalThis as any;
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

/** jsdom implements no Web Animations API, so `Element.getAnimations` is
 *  simply absent (D-243).
 *
 *  Base UI's `ScrollAreaViewport` calls it from a timer to decide whether a
 *  scroll is still animating. With it missing, the call throws AFTER the test
 *  body has finished — an uncaught exception vitest attributes to whichever
 *  test happened to be running, which is both noise and a real CI failure
 *  waiting to happen, and it is entirely an artefact of the environment rather
 *  than of the component.
 *
 *  A no-op returning "no animations in flight" is the honest stub: jsdom never
 *  animates anything, so the true answer is always the empty list. Returns a
 *  restore function, like every other stub here.
 *
 *  Needed by any test mounting a component that contains a `ScrollArea` —
 *  `CaptionLibrary.dom.test.tsx` (D-243's own suite, renamed by D-263) is the
 *  first. */
export function installElementAnimationsStub(): () => void {
  const proto = (globalThis as any).Element?.prototype;
  if (!proto || typeof proto.getAnimations === 'function') return () => {};
  proto.getAnimations = function getAnimations(): unknown[] {
    return [];
  };
  return () => {
    delete proto.getAnimations;
  };
}

/** What an installed object-URL stub gives a test back (D-217). */
export interface ObjectUrlStub {
  /** The `Blob` a given `blob:` URL was minted from, or `undefined` if that
   *  URL was never created here or has since been revoked. */
  blobFor(url: string): Blob | undefined;
  /** URLs created and not yet revoked — a leak check, since `PreviewPane`
   *  mints one object URL per displayed frame during playback. */
  live(): string[];
  restore(): void;
}

/** jsdom implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`
 *  (confirmed against the installed jsdom, not assumed), and since D-217
 *  `PreviewPane` shows every preview frame through one — the backend hands it
 *  the JPEG's raw bytes now, not a `data:` URL.
 *
 *  This is a real stub, not a no-op: it keeps the `Blob` each URL was minted
 *  from, so a test can still assert on the frame's actual CONTENT the way it
 *  could when the `<img>`'s `src` was a data URL carrying the bytes inline
 *  (`await stub.blobFor(img.src)!.text()`), and can check that revocation
 *  really happens rather than leaking a buffer per played frame. Returns the
 *  handle; call `restore()` in teardown. */
export function installObjectUrlStub(): ObjectUrlStub {
  const had = {
    create: 'createObjectURL' in URL,
    revoke: 'revokeObjectURL' in URL,
  };
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const blobs = new Map<string, Blob>();
  let n = 0;
  (URL as any).createObjectURL = (blob: Blob): string => {
    const url = `blob:chroma-test/${++n}`;
    blobs.set(url, blob);
    return url;
  };
  (URL as any).revokeObjectURL = (url: string): void => {
    blobs.delete(url);
  };
  return {
    blobFor: (url) => blobs.get(url),
    live: () => [...blobs.keys()],
    restore() {
      if (had.create) (URL as any).createObjectURL = original.create;
      else delete (URL as any).createObjectURL;
      if (had.revoke) (URL as any).revokeObjectURL = original.revoke;
      else delete (URL as any).revokeObjectURL;
      blobs.clear();
    },
  };
}

/** One `fillRect` a stubbed 2D context recorded — enough to assert *what was
 *  drawn where* without a rasteriser. */
export interface RecordedFill {
  x: number;
  y: number;
  w: number;
  h: number;
  fillStyle: string;
  globalAlpha: number;
}

export interface CanvasContextStub {
  /** Every `fillRect` on every canvas since the stub was installed, newest
   *  last. */
  fills(): RecordedFill[];
  restore(): void;
}

/** jsdom implements no canvas rendering at all: `HTMLCanvasElement
 *  .getContext()` is a hard "Not implemented" that jsdom reports through
 *  `console.error` (confirmed against the installed jsdom, not assumed). Every
 *  canvas-drawing component in this package therefore trips the zero-console-
 *  error bar every DOM suite here sets, even though nothing is wrong.
 *
 *  This is a real recorder, not a no-op: it captures each `fillRect`'s
 *  rectangle plus the `fillStyle`/`globalAlpha` in force at the time, so a
 *  jsdom-tier test can still assert the geometry a component *asked* for — e.g.
 *  that `ScrubWaveform` drew its playhead at the fraction it computed — without
 *  pretending this tier can check pixels. Everything else on the context is a
 *  no-op; `setTransform`/`clearRect`/gradients have nothing to record.
 *
 *  Returns the handle; call `restore()` in teardown. */
export function installCanvasContextStub(width = 600, height = 44): CanvasContextStub {
  const proto = HTMLCanvasElement.prototype as any;
  const original = proto.getContext;
  const recorded: RecordedFill[] = [];

  proto.getContext = function (kind: string): unknown {
    if (kind !== '2d') return null;
    const ctx: any = {
      canvas: this,
      fillStyle: '#000',
      strokeStyle: '#000',
      globalAlpha: 1,
      lineWidth: 1,
      font: '',
      setTransform: () => {},
      resetTransform: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      scale: () => {},
      clearRect: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillText: () => {},
      getPropertyValue: () => '',
      fillRect(x: number, y: number, w: number, h: number) {
        recorded.push({ x, y, w, h, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha });
      },
    };
    return ctx;
  };

  // A canvas laid out by CSS reports 0 for `clientWidth` in jsdom, which makes
  // every measured-width drawing component draw nothing at all. Give the
  // measurement a real, fixed answer, the same way `stubOffsetMetrics` does for
  // the preview surface.
  const owned = ['clientWidth', 'clientHeight'] as const;
  const previous = owned.map((k) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, k));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-scrub-waveform') ? width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-scrub-waveform') ? height : 0;
    },
  });

  return {
    fills: () => recorded,
    restore() {
      proto.getContext = original;
      owned.forEach((k, i) => {
        if (previous[i]) Object.defineProperty(HTMLElement.prototype, k, previous[i]!);
        else delete (HTMLElement.prototype as any)[k];
      });
      recorded.length = 0;
    },
  };
}

/** jsdom implements no Pointer Events *capture* API at all —
 *  `setPointerCapture`/`releasePointerCapture`/`hasPointerCapture` are simply
 *  absent from `Element.prototype` (confirmed directly against the installed
 *  jsdom, not assumed). dnd-kit's `PointerSensor` activator calls
 *  `setPointerCapture` as part of starting to track a press, so without a
 *  stub every real `pointerdown` on a `useDraggable` node throws inside
 *  dnd-kit's own listener. No-op stubs (not a real capture implementation —
 *  jsdom has no hit-testing to retarget anyway) are enough: this repo's own
 *  gesture code never actually depends on capture *behaviour* under test,
 *  only on the calls not throwing (`TimelinePane.tsx`'s own marquee gesture
 *  deliberately does NOT use pointer capture at all — see its module doc —
 *  so this is purely for dnd-kit's benefit). */
export function installPointerCaptureStub(): () => void {
  const proto = Element.prototype as any;
  const keys = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const;
  const original = keys.map((k) => proto[k]);
  proto.setPointerCapture = function (): void {};
  proto.releasePointerCapture = function (): void {};
  proto.hasPointerCapture = function (): boolean {
    return false;
  };
  return () => {
    keys.forEach((k, i) => {
      if (original[i]) proto[k] = original[i];
      else delete proto[k];
    });
  };
}

// ---------------------------------------------------------------------------
// Tauri invoke stub
// ---------------------------------------------------------------------------

export type InvokeHandler = (args: Record<string, unknown> | undefined) => unknown | Promise<unknown>;

/** A stand-in for `@tauri-apps/api/core`'s `invoke`, matching D-095's own
 *  established pattern ("stubbing enough of `window.__TAURI_INTERNALS__`").
 *  `handlers` maps a Tauri command name to a canned response (or a function
 *  of its args); anything not listed rejects loudly rather than hanging —
 *  a silent `undefined` response for an un-stubbed command is exactly the
 *  kind of thing that produces a confusing failure three effects downstream
 *  instead of a clear one at the call site. Wire this into a real test via
 *  `vi.mock('@tauri-apps/api/core', () => ({ invoke: createInvokeStub({...}) }))`
 *  (jsdom/vitest) — module mocks must be set up before the mocked module is
 *  imported, which is why this returns a plain function rather than doing
 *  the mocking itself. For the real-browser harness (`app/harness.html`),
 *  the equivalent hookup is `window.__TAURI_INTERNALS__ = { invoke: (cmd,
 *  args) => Promise.resolve(createInvokeStub({...})(cmd, args)) }` before any
 *  app module that calls `invoke` is imported. */
export function createInvokeStub(handlers: Record<string, InvokeHandler>) {
  return async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const h = handlers[cmd];
    if (!h) throw new Error(`pointerHarness: no invoke stub registered for "${cmd}"`);
    return h(args);
  };
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export interface MountedComponent {
  container: HTMLElement;
  unmount(): void;
}

/** Mount `element` into a real, attached (`document.body`-appended) DOM node
 *  via `react-dom/client`'s real `createRoot` — not a detached fragment, so
 *  `document.activeElement`/focus-dependent behaviour and real event
 *  bubbling to `window` both work the way they do in a real page.
 *
 *  `strictMode` defaults to `true` — D-098's own instruction was not to
 *  declare a pointer-gesture change done "off the Chromium harness alone
 *  again" without verifying under `<React.StrictMode>` specifically, since
 *  double-invoke is what surfaces a whole class of effect bug this repo has
 *  hit more than once, and `app/src/main.tsx`'s real root already wraps in
 *  it. Pass `strictMode: false` only when a test is deliberately isolating
 *  non-StrictMode behaviour.
 *
 *  Caller owns awaiting `waitFrames()` after mount if the component's own
 *  effects need a frame to settle (most do) — not folded in here, since some
 *  callers want to assert on the pre-effect DOM first. */
export function mount(element: React.ReactElement, opts: { strictMode?: boolean } = {}): MountedComponent {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  const strict = opts.strictMode ?? true;
  act(() => {
    root.render(strict ? React.createElement(React.StrictMode, null, element) : element);
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

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

export interface ConsoleCapture {
  errors: unknown[][];
  warnings: unknown[][];
  restore(): void;
}

/** Every prior harness's own bar for "clean" was explicitly "zero console
 *  errors/warnings, checked" (D-098's live StrictMode verification, D-137's
 *  own final check) — not "the test didn't throw." This makes that assertion
 *  real and reusable instead of an ad hoc `console.error = vi.fn()` at each
 *  call site. Restores the original `console.error`/`warn` on `restore()`;
 *  always call it, including on a failing test (`try/finally`), since this
 *  mutates the shared global `console`. */
export function captureConsole(): ConsoleCapture {
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  return {
    errors,
    warnings,
    restore() {
      console.error = origError;
      console.warn = origWarn;
    },
  };
}
