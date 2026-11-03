// B-296 — which Colorist bridge ops answer with their own result only (no grade,
// histogram or rendered frame attached).
import { describe, expect, it } from 'vitest';

import { isResultOnlyOp, wantsGrade } from './bridgeOpClasses';

describe('isResultOnlyOp', () => {
  it('covers close_project, which leaves the project and has no frame to return (B-356)', () => {
    expect(isResultOnlyOp('close_project')).toBe(true);
  });

  it('covers save_project, which writes the project and touches no grade (B-296)', () => {
    expect(isResultOnlyOp('save_project')).toBe(true);
  });

  it('still covers the cross-tab history ops (B-248)', () => {
    expect(isResultOnlyOp('undo')).toBe(true);
    expect(isResultOnlyOp('redo')).toBe(true);
  });

  it('covers list_projects (B-319): a list of projects, not a grade', () => {
    expect(isResultOnlyOp('list_projects')).toBe(true);
  });

  it('answers open_project / new_project compactly unless include_grade asks for the grade (B-319)', () => {
    for (const op of ['open_project', 'new_project']) {
      expect(isResultOnlyOp(op, {})).toBe(true);
      expect(isResultOnlyOp(op)).toBe(true);
      expect(isResultOnlyOp(op, { include_grade: false })).toBe(true);
      expect(isResultOnlyOp(op, { include_grade: true })).toBe(false);
    }
    expect(wantsGrade({ includeGrade: true })).toBe(true);
    expect(wantsGrade(undefined)).toBe(false);
    // the flag means nothing to an op that is not a project switch
    expect(isResultOnlyOp('get_state', { include_grade: false })).toBe(false);
  });

  it('leaves grade ops on the rendered-frame path', () => {
    for (const op of ['get_state', 'set_primary', 'inspect_color', 'set_project_settings']) {
      expect(isResultOnlyOp(op)).toBe(false);
    }
  });
});
