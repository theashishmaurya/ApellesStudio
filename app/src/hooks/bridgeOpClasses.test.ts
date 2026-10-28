// B-296 — which Colorist bridge ops answer with their own result only (no grade,
// histogram or rendered frame attached).
import { describe, expect, it } from 'vitest';

import { isResultOnlyOp } from './bridgeOpClasses';

describe('isResultOnlyOp', () => {
  it('covers save_project, which writes the project and touches no grade (B-296)', () => {
    expect(isResultOnlyOp('save_project')).toBe(true);
  });

  it('still covers the cross-tab history ops (B-248)', () => {
    expect(isResultOnlyOp('undo')).toBe(true);
    expect(isResultOnlyOp('redo')).toBe(true);
  });

  it('leaves grade ops on the rendered-frame path', () => {
    for (const op of ['get_state', 'set_primary', 'inspect_color', 'set_project_settings']) {
      expect(isResultOnlyOp(op)).toBe(false);
    }
  });
});
