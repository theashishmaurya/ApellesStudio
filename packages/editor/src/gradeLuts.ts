/**
 * @apelles/editor — the Edit tab's export pre-flight for each clip's
 * **Colorist grade** (D-256, D-448, D-450).
 *
 * **What it is:** one call, [`warmGradeLuts`], to `chroma_timeline_grade_luts`
 * — the backend reading every graded clip's `grade.json` into the memo the
 * render engine grades from (`app/src-tauri/src/chroma/grade_pass.rs`, which
 * runs the Colorist's own shader on each frame), and naming what each grade
 * does not carry yet (a mask, the Colorist crop / geometry, relight; D-450).
 *
 * **Why it runs before an export is queued:** a grade that cannot be read is a
 * refusal, not a silent ungraded file — `prepareEditorExport` turns the
 * rejection into a named error — and what a grade cannot carry is shown in the
 * Export panel before the person presses Export (`EditorExportDialog.tsx`).
 *
 * **What it does NOT do:** no grade maths. The grade never enters the
 * frontend, and no `.cube` file is written (D-448).
 */
import { invoke } from '@tauri-apps/api/core';

import type { Timeline } from './timeline';

/** Mirrors `chroma::grade_pass::GradeCheck` (serde `camelCase`). */
export interface GradeCheck {
  /** The clips with a real, non-identity grade. */
  graded: string[];
  /** What the grade does not carry yet, already prefixed with the clip id. */
  warnings: string[];
}

function clipIdsOf(tl: Timeline): string[] {
  const ids: string[] = [];
  for (const track of tl.tracks) {
    for (const clip of track.clips) {
      // A generated clip (title, adjustment, dip plate) has no source pixels to
      // grade and can never have a grade file; asking about it would just make
      // the backend stat a path that cannot exist.
      if (clip.text || clip.adjustment) continue;
      ids.push(clip.id);
    }
  }
  return ids.sort();
}

/**
 * Read (or reuse) the grade of every graded clip on `tl` and return what the
 * export does not carry of them.
 *
 * Cheap and idempotent: the backend memoises each grade on its file's own
 * (mtime, len), and reading one touches no GPU.
 *
 * Throws if a clip's grade could not be read — deliberately, so the export
 * fails loudly rather than shipping without the grade.
 */
export async function warmGradeLuts(tl: Timeline): Promise<GradeCheck> {
  return await invoke<GradeCheck>('chroma_timeline_grade_luts', { clipIds: clipIdsOf(tl) });
}
