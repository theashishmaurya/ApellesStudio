/**
 * Chroma — the isolated Motion-tab browser harness (D-165).
 *
 * **What it is.** The Motion-tab sibling of D-142's `app/harness.html` +
 * `app/src/harness-main.tsx` (which mounts `@chroma/editor`'s `TimelinePane`
 * standalone) — same shape, same reasons, applied to `@chroma/motion`'s
 * `MotionTab` instead: a real component, mounted standalone in a real
 * browser tab, against a stubbed `window.__TAURI_INTERNALS__.invoke` and a
 * hand-seeded manifest, driven with real `PointerEvent`s over CDP. Built
 * because D-150 through D-164 (the whole visual-builder/keyframe-timeline
 * initiative — canvas click-select/drag/resize/snap/multi-select/marquee,
 * per-layer keyframes, and a full per-row keyframe timeline with drag/
 * box-select/nudge/a bezier curve editor) shipped with every single decision
 * entry disclosing the same gap: "not seen in the assembled Tauri app — this
 * sandbox cannot launch it." This file exists to close as much of that gap
 * as a plain Chromium tab can, the same way D-142 did for `TimelinePane`.
 *
 * **Why `MotionTab` alone, not the full app.** Identical reasoning to
 * `harness-main.tsx`'s own doc comment: the full app crashes outside the
 * native Tauri shell (`<WindowControls>` reads real window metadata that
 * doesn't exist in a plain tab), and stubbing enough of
 * `window.__TAURI_INTERNALS__` to reach a real open project is a much
 * deeper rabbit hole than the Motion tab itself. `MotionTab` and
 * `useMotionProjectStore` are both real, intentional exports of
 * `@chroma/motion` (`index.ts`) specifically so this file can mount it
 * without reaching past the package's public API.
 *
 * **The fixture.** `defaultFixture()` below is `packages/motion-engine/src/
 * engine/sample.ts`'s own `sample` manifest (the one every byte-for-byte
 * `remotion still` check this whole initiative ran was verified against) —
 * not reinvented — with three additions so a single seed exercises
 * everything D-155 through D-164 built: an authored `ease` on the "hook"
 * scene's zoom-in camera key (curve-editor target), `transform.keys` on the
 * "hook" scene's text layer (a layer-row target for the keyframe timeline —
 * drag-a-key, box-select, nudge), and a second keyed layer (the "stack"
 * scene's `layers` primitive) so the timeline has more than one row to
 * prove per-row lanes actually separate. `sample` itself is imported, not
 * copied, so this fixture can never silently drift from what the render-
 * level checks already verified.
 *
 * **How to use this for a NEW check**, without editing this file's own
 * defaults: `window.__chromaMotionHarness` (bottom of this file) exposes
 * `seed`/`reset`/`setStrictMode`/live `manifest`/`selections` getters,
 * mirroring `harness-main.tsx`'s own `__chromaHarness` shape. Construct real
 * `PointerEvent`s directly via `evaluate_script` — `new PointerEvent(type,
 * {bubbles:true, cancelable:true, ...})` — with real `requestAnimationFrame`
 * waits between steps, the same non-negotiable rule `testUtils/
 * pointerHarness.ts` documents (this package has no vitest-side copy of that
 * module yet — `@chroma/motion` cannot depend on `@chroma/editor`'s, per the
 * house rule D-160's own research pass confirmed — replicate the shape
 * directly in `evaluate_script`, or build `packages/motion/src/testUtils/
 * pointerHarness.ts` as a real follow-up if permanent jsdom regression
 * coverage for this tab is wanted later, the same way D-142 did for the
 * Edit tab).
 *
 * **What this file does NOT do.** Does not run in CI, does not substitute
 * for a real jsdom-tier regression test (none exists yet for this tab — see
 * above). Real layout, real paint, real pointer-capture, real `dnd`-free
 * native listener gestures (`MotionCanvasOverlay.tsx`/`KeyframeTimeline.tsx`
 * use no drag library at all, D-160's own confirmed verdict) — the things a
 * unit test cannot check. Still not the real Tauri/WKWebView window — same
 * disclosed constraint every entry since D-125 states.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionTab, useMotionProjectStore } from '@chroma/motion';
import { sample } from '@chroma/motion-engine/src/engine/sample';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';
import '../src/styles.css';

function setStatus(text: string): void {
  const el = document.getElementById('harness-status');
  if (el) el.textContent = text;
}

/** In-memory "saved manifest" this stub reads/writes — lets a Save in the
 *  harness round-trip through a reload the same way the real backend would,
 *  without a real `.chroma` project on disk. */
let savedManifest: unknown = null;

/** A stand-in for `@tauri-apps/api/core`'s `invoke`, stubbing exactly
 *  `window.__TAURI_INTERNALS__.invoke` — same contract as `harness-main.tsx`'s
 *  own `installInvokeStub`. Every command `MotionTab` can call
 *  (`packages/motion/src/manifestIO.ts`) is listed explicitly; an unlisted
 *  command rejects loudly rather than silently returning `undefined`. */
function installInvokeStub(): void {
  const handlers: Record<string, (args: unknown) => unknown> = {
    chroma_motion_get_manifest: () => savedManifest,
    chroma_motion_save_manifest: (args) => {
      savedManifest = (args as { manifest: unknown }).manifest;
      return '/harness/fake-project.chroma/motion/manifest.json';
    },
    chroma_motion_render: () => ({
      outputPath: '/harness/fake-project.chroma/motion/render.mp4',
      stdoutTail: '(harness stub — no real render ran)',
    }),
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

/** `sample` (`@chroma/motion-engine`) plus three additions exercising every
 *  piece of D-155–D-164 in one seed — see this file's own header for why
 *  each one is here. */
function defaultFixture(): Manifest {
  const m = structuredClone(sample);
  const hook = m.scenes[0];
  const stack = m.scenes[1];

  // Curve-editor target: an authored, non-default ease on the zoom-in key.
  const zoomKey = hook.camera?.[2];
  if (zoomKey) (zoomKey as { ease?: readonly [number, number, number, number] }).ease = [0.34, 1.56, 0.64, 1];

  // Keyframe-timeline row #1: the "hook" scene's text layer gets real
  // transform.keys (fades/slides in, matching the delta-on-static-x/y rule
  // D-159 established).
  const text = hook.layers?.[0] as { transform?: unknown } | undefined;
  if (text) {
    text.transform = {
      keys: [
        { at: 0, x: -120, y: 0, opacity: 0 },
        { at: 0.6, x: 0, y: 0, opacity: 1, ease: [0.22, 1, 0.36, 1] },
      ],
    };
  }

  // Keyframe-timeline row #2: the "stack" scene's `layers` primitive gets a
  // simple opacity fade too, so the timeline shows more than one row and
  // per-row lanes (D-162) actually separate.
  const layersPrim = stack.layers?.[1] as { transform?: unknown } | undefined;
  if (layersPrim) {
    layersPrim.transform = {
      keys: [
        { at: 0, opacity: 0 },
        { at: 0.5, opacity: 1 },
      ],
    };
  }

  return m;
}

function seed(manifest: Manifest): void {
  savedManifest = manifest;
  useMotionProjectStore.setState({
    openProjectPath: '/harness/fake.chroma',
    status: 'ready',
    error: null,
    loaded: { generation: Date.now(), manifest },
  });
}

let strict = true;
let root: ReturnType<typeof createRoot> | null = null;

function render(): void {
  const container = document.getElementById('root')!;
  if (!root) root = createRoot(container);
  const el = React.createElement(MotionTab);
  root.render(strict ? React.createElement(React.StrictMode, null, el) : el);
  setStatus(`mounted (strictMode=${strict}) — window.__chromaMotionHarness`);
}

installInvokeStub();
seed(defaultFixture());
render();

// CDP-reachable control surface — see this file's own header for the
// `evaluate_script` recipe. Mirrors `harness-main.tsx`'s own
// `__chromaHarness` shape.
(window as unknown as { __chromaMotionHarness: unknown }).__chromaMotionHarness = {
  seed,
  defaultFixture,
  get manifest() {
    return useMotionProjectStore.getState().loaded?.manifest ?? null;
  },
  get savedManifest() {
    return savedManifest;
  },
  setStrictMode(next: boolean) {
    strict = next;
    render();
  },
  reset() {
    seed(defaultFixture());
  },
};
