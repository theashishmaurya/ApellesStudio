/**
 * loadPerf.ts - what happens after a timeline load, measured and signalled (B-369).
 *
 * What it is: two small things the timeline load shares with the panes that
 * fill in after it.
 *   1. Debug-only `apelles:load:*` performance measures (`LOAD_PERF`): the fetch,
 *      the hydrate, the first paint, and when the first preview frame, the first
 *      filmstrip window, the first waveform and the last of the requests the
 *      load queued arrived. Compiled out of a release build by the same
 *      `APELLES_PERF_MARKS` define as `editPerf.ts` (D-437 S0a).
 *   2. `nextPreviewFrame()`: a promise for the next preview frame that reaches
 *      the screen. The app's open follow (`useOpenProgressStore.ts`) waits on it
 *      to end the branded loader's "Preparing previews…" step, so the loader
 *      lifts when there is a picture, not on a guess. Always compiled in: it is
 *      a product signal, not a measurement.
 *
 * What it does NOT do: fetch, render or decide anything. `timelineStore.load`
 * calls `loadPerfBegin`/`loadPerfHydrated`, `PreviewPane` calls
 * `notifyPreviewFrameShown`, `clipThumbs`/`Waveform` wrap their requests in
 * `trackLoadRequest`.
 */

/// <reference path="./perfMarks.d.ts" />
import { sharedValue } from '@apelles/store';

import { perfMark, perfMeasure, perfMeasureAfterPaint } from './editPerf';
import { LOAD_PERF as LOAD_PERF_NAMES } from './editPerfNames';

const marksOn = import.meta.env.APELLES_PERF_MARKS === 'true';
/** Folded to `{}` in a release build, like `EDIT_PERF`. */
const LOAD_PERF = (marksOn ? LOAD_PERF_NAMES : {}) as typeof LOAD_PERF_NAMES;

export type LoadRequestKind = 'filmstrip' | 'peaks';

interface LoadPerfState {
  /** A load has started and its "first" measures have not all been written. */
  armed: boolean;
  firstFrame: boolean;
  first: Record<LoadRequestKind, boolean>;
  pending: number;
  /** Resolvers waiting for the next preview frame on screen. */
  frameWaiters: Set<() => void>;
}

// HMR-safe (a dev re-evaluation keeps the one instance the panes already hold).
const state = sharedValue<LoadPerfState>('editor.loadPerf', () => ({
  armed: false,
  firstFrame: false,
  first: { filmstrip: false, peaks: false },
  pending: 0,
  frameWaiters: new Set(),
}));

/** `load()` is about to fetch the timeline. */
export function loadPerfBegin(): void {
  if (!marksOn) return;
  state.armed = true;
  state.firstFrame = false;
  state.first = { filmstrip: false, peaks: false };
  perfMark(LOAD_PERF.fetch);
}

/** The fetched timeline is in the store. */
export function loadPerfHydrated(): void {
  if (!marksOn || !state.armed) return;
  perfMeasure(LOAD_PERF.hydrated, LOAD_PERF.fetch);
  perfMeasureAfterPaint(LOAD_PERF.painted, LOAD_PERF.fetch);
}

/** A preview frame has just been put on screen. Cheap when nobody is waiting. */
export function notifyPreviewFrameShown(): void {
  if (marksOn && state.armed && !state.firstFrame) {
    state.firstFrame = true;
    perfMeasure(LOAD_PERF.firstFrame, LOAD_PERF.fetch);
  }
  if (state.frameWaiters.size === 0) return;
  const waiters = [...state.frameWaiters];
  state.frameWaiters.clear();
  for (const resolve of waiters) resolve();
}

/** Resolves `true` on the next preview frame shown, `false` after `timeoutMs`. */
export function nextPreviewFrame(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onFrame = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      state.frameWaiters.delete(onFrame);
      resolve(false);
    }, timeoutMs);
    state.frameWaiters.add(onFrame);
  });
}

/**
 * Wrap one filmstrip/waveform request so its arrival is measured. Returns the
 * request's own promise. A no-op wrapper in a release build.
 */
export function trackLoadRequest<T>(kind: LoadRequestKind, request: Promise<T>): Promise<T> {
  if (!marksOn) return request;
  state.pending += 1;
  const settle = () => {
    state.pending = Math.max(0, state.pending - 1);
    if (!state.armed) return;
    if (!state.first[kind]) {
      state.first[kind] = true;
      perfMeasure(kind === 'filmstrip' ? LOAD_PERF.firstFilmstrip : LOAD_PERF.firstPeaks, LOAD_PERF.fetch);
    }
    if (state.pending === 0) perfMeasure(LOAD_PERF.previewsSettled, LOAD_PERF.fetch);
  };
  request.then(settle, settle);
  return request;
}
