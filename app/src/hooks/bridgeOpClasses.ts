/**
 * How the Colorist bridge (`useChromaControl`) shapes an op's reply (B-248, B-296).
 *
 * Most Colorist ops settle the canvas and answer with the rendered frame,
 * histogram and adjustments beside their result; read-only ones answer with the
 * adjustments and histogram without re-rendering. A third class answers with its
 * own `{ok, error, result}` ONLY: ops that are not about the grade at all, so
 * attaching it (~30 KB) is noise an agent pays for on every call.
 *
 * This module is the one place that class is listed. It does NOT decide
 * anything else about an op.
 */

/** Ops answered with their own result only — and never logged to the agent
 *  activity feed. `undo` / `redo` (B-248: cross-tab, they step the shared
 *  history); `save_project` (B-296: writes the project to disk, touches no
 *  grade); `close_project` (B-356: leaves the project, so there is no frame or
 *  grade to attach). */
export const RESULT_ONLY_OPS: ReadonlySet<string> = new Set([
  'undo',
  'redo',
  'save_project',
  'close_project',
  // B-319 — a project list is a list of projects, not a grade.
  'list_projects',
]);

/** B-319 — the project-SWITCH ops: result-only by default (a compact summary of
 *  what is now open), but a caller that wants the new project's first shot
 *  rendered and its grade attached opts in with `include_grade`. */
const PROJECT_SWITCH_OPS: ReadonlySet<string> = new Set(['open_project', 'new_project']);

/** Whether the caller asked a project-switch op to also answer with the active
 *  shot's rendered frame, histogram and grade. */
export function wantsGrade(args: Record<string, unknown> | undefined): boolean {
  return args?.include_grade === true || args?.includeGrade === true;
}

export function isResultOnlyOp(op: string, args?: Record<string, unknown>): boolean {
  if (RESULT_ONLY_OPS.has(op)) return true;
  return PROJECT_SWITCH_OPS.has(op) && !wantsGrade(args);
}

/** D-439 (B-369) — Colorist ops that do not need the active shot's frame on the
 *  canvas: they pick, list or replace shots and projects, step the shared
 *  history, or ask the human. Every OTHER op this bridge answers first decodes
 *  the frame a project open left for its first use (`ensureColoristFrame`). */
const COLORIST_FRAME_FREE_OPS: ReadonlySet<string> = new Set([
  'open',
  'list_shots',
  'set_active_shot',
  'add_shots',
  'list_projects',
  'open_project',
  'new_project',
  'close_project',
  'save_project',
  'set_project_settings',
  'request_human',
  'undo',
  'redo',
  'export_progress',
]);

/** Whether `op` needs the Colorist frame decoded BEFORE it runs. */
export function needsColoristFrameBefore(op: string): boolean {
  return !COLORIST_FRAME_FREE_OPS.has(op);
}

/** Whether `op` needs it AFTER it runs: a project switch asked to answer with
 *  the new project's rendered frame (`include_grade`), which only exists once
 *  the switch has happened. */
export function needsColoristFrameAfter(op: string, args?: Record<string, unknown>): boolean {
  return PROJECT_SWITCH_OPS.has(op) && wantsGrade(args);
}
