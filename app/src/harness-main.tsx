/**
 * Chroma — the isolated pointer-gesture browser harness (D-142).
 *
 * **What it is.** This exact kind of scratch entry point — mount one real
 * component standalone in a real browser tab, seed a hand-built store
 * fixture, stub Tauri's `invoke`, drive it with real `PointerEvent`s over
 * CDP — has been built from scratch and thrown away at least five times in
 * this repo (D-095, D-096, D-098, D-100, D-137), always as `app/harness.html`
 * + `app/src/harness-main.tsx`, always deleted right after use, never
 * committed. This file is that pattern made PERMANENT: the next
 * pointer-gesture feature (or bug report) gets to open a real Chromium tab
 * against this immediately, instead of re-deriving the whole setup —
 * `window.__TAURI_INTERNALS__` stubbing, sidestepping the full app's deep
 * Tauri-IPC boot chain, a seedable fixture, StrictMode — for a sixth time.
 *
 * **Why `TimelinePane` alone, not the full app.** D-095 tried loading the
 * real app in a plain Chrome tab first and it crashed immediately in
 * `<WindowControls>` reading Tauri window metadata that doesn't exist outside
 * the native shell; stubbing enough of `window.__TAURI_INTERNALS__` to reach
 * a real open project turned out to be a much deeper rabbit hole than the
 * timeline UI itself, not worth it for verifying a pointer gesture.
 * `TimelinePane` is now a real, intentional export of `@chroma/editor`
 * (alongside `EditorTab`, see that package's `index.ts`) specifically so this
 * file can mount it without reaching past the package's public API.
 *
 * **How to use this for a NEW pointer-gesture check**, without editing this
 * file's own defaults: everything below is reachable from a CDP session via
 * `window.__chromaHarness` (see the bottom of this file) — reseed the store,
 * flip StrictMode, or just read `window.__chromaHarness.timeline` to confirm
 * state. Use `packages/editor/src/testUtils/pointerHarness.ts`'s own
 * `firePointerEvent`/`dragPointer`-equivalent event construction directly via
 * `evaluate_script` (that module isn't bundled into this page — it's a
 * vitest-side utility — but its documented event-construction shape,
 * `new PointerEvent(type, {bubbles:true, cancelable:true, ...})`, is exactly
 * what to replicate in an `evaluate_script` call; real
 * `requestAnimationFrame` waits between events remain the one real,
 * non-negotiable rule — see that file's own module doc for why).
 *
 * **What this file does NOT do.** It does not run in CI and does not
 * substitute for `TimelinePane.marquee.dom.test.tsx`'s own jsdom-tier
 * regression coverage (`packages/editor`, runs on every `npm test`). This is
 * the STRONGER, manual tier: real layout, real paint, real dnd-kit rect
 * measurement against real geometry — the things jsdom's own zero-layout
 * environment cannot check (see that test file's own header). It is still
 * not the real Tauri/WKWebView window (every entry since D-125 discloses
 * this the same way) — Chromium driven by real `PointerEvent`s is a
 * meaningfully stronger check than jsdom, but WKWebView is a different
 * rendering/DnD engine, and this repo's own history is "looked fine in code,
 * broke on real pointer input." Treat a clean run here as strong evidence,
 * not as the owner's own hands-on check in the real app.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { TimelinePane, useEditorTimelineStore, type Timeline } from '@chroma/editor';
import '../src/styles.css';

function setStatus(text: string): void {
  const el = document.getElementById('harness-status');
  if (el) el.textContent = text;
}

/** A stand-in for `@tauri-apps/api/core`'s `invoke` — the real signature is
 *  `window.__TAURI_INTERNALS__.invoke(cmd, args)`, so this stubs exactly
 *  that global rather than the module (this page never runs inside Tauri,
 *  so there's no real one to conflict with). Every command `TimelinePane`
 *  (or its `Filmstrip`/`Waveform` children) can call is listed explicitly —
 *  an unlisted command rejects loudly, matching
 *  `testUtils/pointerHarness.ts`'s own `createInvokeStub` contract (kept in
 *  sync by hand; this file can't import that vitest-side module directly
 *  since it isn't part of this app's own dependency graph). */
function installInvokeStub(): void {
  const handlers: Record<string, (args: unknown) => unknown> = {
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
    chroma_timeline_get: () => useEditorTimelineStore.getState().timeline,
    // D-198 — `EditorExportDialog`'s own composition-size default fetch
    // (`chroma_timeline_clip_geometry`, D-193's existing command) and its
    // "Add to queue" -> `chroma_run_ffmpeg` path, both now reachable from
    // `TimelinePane`'s own toolbar. A real fixed size (matching this
    // fixture's own clips' notional aspect) is enough for the dialog to
    // show real defaults instead of erroring; `chroma_run_ffmpeg` reports a
    // real-looking success/failure DTO — this harness never actually spawns
    // ffmpeg, and doesn't need to for a dialog/queue-state pointer-gesture
    // check (queue transitions are unit-tested for real in
    // `exportQueueStore.test.ts`; this is for SEEING the dialog/queue).
    chroma_timeline_clip_geometry: () => ({ compWidth: 1080, compHeight: 1920, naturalWidth: 1, naturalHeight: 1 }),
    chroma_run_ffmpeg: () => ({ ok: true, stdout_tail: '', stderr_tail: '' }),
    'plugin:dialog|save': () => '/tmp/harness-export.mp4',
  };
  (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      const h = handlers[cmd];
      if (!h) {
        const msg = `harness: no invoke stub for "${cmd}"`;
        console.error(msg);
        throw new Error(msg);
      }
      return h(args);
    },
  };
}

/** The same 3-track fixture `TimelinePane.marquee.dom.test.tsx` (D-142) uses
 *  — kept in sync by hand for the same reason `installInvokeStub`'s handler
 *  list is: this file and that one live in different packages and can't
 *  share a fixture module without a new cross-package dependency neither
 *  needs for anything else. Reseed a different one from a CDP session via
 *  `window.__chromaHarness.seed(fixture)`. */
function defaultFixture(): Timeline {
  return {
    id: 'harness-tl',
    name: 'harness',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'a', name: 'A', source_path: '/a.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 0 },
          { id: 'b', name: 'B', source_path: '/b.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 240 },
        ],
      },
      {
        kind: 'video',
        clips: [{ id: 'c', name: 'C', source_path: '/c.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 24 }],
      },
      {
        kind: 'video',
        clips: [{ id: 'd', name: 'D', source_path: '/d.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 120 }],
      },
    ],
  };
}

function seed(timeline: Timeline): void {
  useEditorTimelineStore.setState({
    timeline,
    projectOpen: true,
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
  });
}

let strict = true;
let root: ReturnType<typeof createRoot> | null = null;

function render(): void {
  const container = document.getElementById('root')!;
  if (!root) root = createRoot(container);
  const el = React.createElement(TimelinePane);
  root.render(strict ? React.createElement(React.StrictMode, null, el) : el);
  setStatus(`mounted (strictMode=${strict}) — window.__chromaHarness`);
}

installInvokeStub();
seed(defaultFixture());
render();

// CDP-reachable control surface — see this file's own header for the
// `evaluate_script` recipe. Kept intentionally small: this is a mount +
// fixture + StrictMode toggle point, not a second copy of
// `testUtils/pointerHarness.ts`'s event-dispatch helpers (those construct
// plain `PointerEvent`s with no dependency on this page at all — replicate
// the same `new PointerEvent(...)` calls directly in `evaluate_script`).
(window as unknown as { __chromaHarness: unknown }).__chromaHarness = {
  seed,
  defaultFixture,
  get timeline() {
    return useEditorTimelineStore.getState().timeline;
  },
  get selection() {
    return useEditorTimelineStore.getState().selection;
  },
  setStrictMode(next: boolean) {
    strict = next;
    render();
  },
  reset() {
    seed(defaultFixture());
  },
};
