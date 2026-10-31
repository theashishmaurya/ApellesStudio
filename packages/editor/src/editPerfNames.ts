/**
 * editPerfNames.ts - the names of the edit-gesture `performance` marks (B-347).
 *
 * Pure constants, no `import.meta.env`, so the Node-side UI harness can import
 * them without pulling Vite's types in. `editPerf.ts` writes the marks;
 * `debug_perf_entries` and the harness read them back by these names.
 */

/** Every mark / measure name, under one prefix so one read takes them all. */
export const EDIT_PERF_PREFIX = 'apelles:edit:';

export const EDIT_PERF = {
  /** mark: the press claimed an edit gesture. */
  press: `${EDIT_PERF_PREFIX}press`,
  /** mark: a preview started. */
  previewStart: `${EDIT_PERF_PREFIX}preview:start`,
  /** measure: one preview (the op on a copy plus the style writes). */
  preview: `${EDIT_PERF_PREFIX}preview`,
  /** mark: the release is about to call the op. */
  commit: `${EDIT_PERF_PREFIX}commit`,
  /** measure: commit -> React has rendered the result. */
  commitRendered: `${EDIT_PERF_PREFIX}commit-rendered`,
  /** measure: commit -> the frame after it. */
  commitPainted: `${EDIT_PERF_PREFIX}commit-painted`,
} as const;
