/**
 * @apelles/editor — the timeline's global CSS (D-432 P2, D-437 S4).
 * jsdom applies no stylesheet, so these rules are pinned as text.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./timeline.css', import.meta.url), 'utf8');
/** The stylesheet minus its comments: only the rules count. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('timeline.css', () => {
  it('styles nothing by a library-era class (the library is gone, D-437 S5)', () => {
    expect(rules).not.toMatch(/\.timeline-editor/);
  });

  it('shows the arrow, not the role=button hand, on the clip body only (B-351)', () => {
    expect(rules).toMatch(/\n\[data-chroma-clip-drag\]\s*\{\s*cursor:\s*default;/);
  });

  it('has no rule that restyles every descendant of the edit area on a press or release (B-374)', () => {
    // The gesture's cursor is a layer (`gestureCursor.ts`); a `[data-chroma-edit-gesture]`
    // rule would make toggling the marker restyle all 300 clips again.
    expect(rules).not.toMatch(/data-chroma-edit-gesture/);
  });
});
