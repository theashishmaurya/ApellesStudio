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
