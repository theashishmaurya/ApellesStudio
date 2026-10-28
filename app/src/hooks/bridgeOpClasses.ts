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
 *  grade). */
export const RESULT_ONLY_OPS: ReadonlySet<string> = new Set(['undo', 'redo', 'save_project']);

export function isResultOnlyOp(op: string): boolean {
  return RESULT_ONLY_OPS.has(op);
}
