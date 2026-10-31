/**
 * @apelles/editor — the timeline's global CSS (D-432 P2, D-437 S4).
 * jsdom applies no stylesheet, so these rules are pinned as text.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TIMELINE_LIBRARY_ALIAS_CLASSES } from './timelineTestIds';

const css = readFileSync(new URL('./timeline-overrides.css', import.meta.url), 'utf8');
/** The stylesheet minus its comments: only the rules count. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('timeline-overrides.css', () => {
  it('never styles a library-era alias class (D-437 S4: the aliases are selectors only)', () => {
    // A rule here would land on our own lanes and playhead: `.timeline-editor-cursor-top`
    // would move the head, `.timeline-editor-edit-area` would shift the scroller.
    for (const cls of Object.values(TIMELINE_LIBRARY_ALIAS_CLASSES)) {
      expect(rules, cls).not.toContain(`.${cls}`);
    }
    expect(rules).not.toMatch(/\.timeline-editor/);
  });

  it('shows the arrow, not the role=button hand, on the clip body only (B-351)', () => {
    expect(rules).toMatch(/\n\[data-chroma-clip-drag\]\s*\{\s*cursor:\s*default;/);
  });

  it('keeps the edit gesture cursor over everything under the pointer (D-432 P2)', () => {
    expect(rules).toMatch(/\[data-chroma-edit-gesture\]\s*\*\s*\{\s*cursor:\s*inherit\s*!important;/);
  });
});
