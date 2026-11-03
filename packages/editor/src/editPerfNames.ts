/**
 * editPerfNames.ts - the names of the edit-gesture `performance` marks (B-347).
 *
 * Pure constants, no `import.meta.env`, so the Node-side UI harness can import
 * them without pulling Vite's types in. `editPerf.ts` writes the marks;
 * `debug_perf_entries` and the harness read them back by these names.
 */

/**
 * Every mark / measure name, under one prefix so one read takes them all. The
 * names are plain string literals, not template literals: a bundler can then drop
 * the unused table whole in a release build (a template is not provably pure).
 */
export const EDIT_PERF_PREFIX = 'apelles:edit:';

export const EDIT_PERF = {
  /** mark: the press claimed an edit gesture. */
  press: 'apelles:edit:press',
  /** mark: a preview started. */
  previewStart: 'apelles:edit:preview:start',
  /** measure: one preview (the op on a copy plus the style writes). */
  preview: 'apelles:edit:preview',
  /** mark: the release is about to call the op. */
  commit: 'apelles:edit:commit',
  /** measure: commit -> React has rendered the result (layout effects). */
  commitRendered: 'apelles:edit:commit-rendered',
  /** measure: commit -> the pane's passive effects have run. */
  commitEffects: 'apelles:edit:commit-effects',
  /** measure: commit -> the start of the next frame (rAF; before that frame's style/layout/paint). */
  commitFrame: 'apelles:edit:commit-frame',
  /** measure: commit -> after the next frame has rendered (rAF, then a posted task). */
  commitPainted: 'apelles:edit:commit-painted',
} as const;

/**
 * B-369 — the timeline LOAD's marks (a project open, a timeline switch): the
 * fetch, the first paint after it, and when the first preview frame, the first
 * filmstrip window, the first waveform and the last of the requests the load
 * queued have arrived. Every measure runs from `fetch`. Written by
 * `loadPerf.ts`; the app's own open phases are `apelles:open:*`.
 */
export const LOAD_PERF_PREFIX = 'apelles:load:';

export const LOAD_PERF = {
  /** mark: `load()` sent `chroma_timeline_get`. */
  fetch: 'apelles:load:fetch',
  /** measure: fetch -> the timeline is in the store. */
  hydrated: 'apelles:load:hydrated',
  /** measure: fetch -> the frame after the hydrated timeline has rendered. */
  painted: 'apelles:load:painted',
  /** measure: fetch -> the first preview frame is on screen. */
  firstFrame: 'apelles:load:first-frame',
  /** measure: fetch -> the first filmstrip window arrived. */
  firstFilmstrip: 'apelles:load:first-filmstrip',
  /** measure: fetch -> the first waveform arrived. */
  firstPeaks: 'apelles:load:first-peaks',
  /** measure: fetch -> no filmstrip or waveform request is outstanding (the last one wins). */
  previewsSettled: 'apelles:load:previews-settled',
} as const;
