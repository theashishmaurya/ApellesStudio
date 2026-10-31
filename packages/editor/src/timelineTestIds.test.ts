/**
 * D-434 — the timeline's test-id catalog stays honest.
 *
 * `TIMELINE_LIBRARY_SELECTORS` names elements the timeline LIBRARY renders, by
 * the library's own class names. Those are not ours, so they are pinned here
 * against the installed package's stylesheet: an upgrade that renames one
 * fails this test instead of silently breaking every UI-harness scenario that
 * aims at a trim handle or the ruler.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TIMELINE_LIBRARY_SELECTORS, TIMELINE_TEST_IDS, TIMELINE_VIEW_ATTRS } from './timelineTestIds';

function libraryStylesheet(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@xzdarcy/react-timeline-editor');
  return readFileSync(join(dirname(entry), 'react-timeline-editor.css'), 'utf8');
}

describe('timeline test ids (D-434)', () => {
  it('every library selector names a class the installed library really styles', () => {
    const css = libraryStylesheet();
    for (const [name, selector] of Object.entries(TIMELINE_LIBRARY_SELECTORS)) {
      expect(selector.startsWith('.'), name).toBe(true);
      // A class selector followed by a non-identifier character, so
      // `.timeline-editor-action` does not pass on `.timeline-editor-action-left-stretch`.
      const pattern = new RegExp(`\\${selector}(?![\\w-])`);
      expect(pattern.test(css), `${name} → ${selector}`).toBe(true);
    }
  });

  it('test ids are unique, kebab-case and namespaced', () => {
    const ids = Object.values(TIMELINE_TEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^timeline-[a-z]+(-[a-z]+)*$/);
  });

  it('view attributes are data-chroma-* attributes', () => {
    for (const attr of Object.values(TIMELINE_VIEW_ATTRS)) expect(attr).toMatch(/^data-chroma-[a-z-]+$/);
  });
});
