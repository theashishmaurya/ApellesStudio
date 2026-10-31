/**
 * D-434 — the timeline's test-id catalog stays honest.
 *
 * Every harness target and DOM suite addresses the timeline by `TIMELINE_TEST_IDS` (D-437
 * S6 retired the library-class selectors). That every id is on a real render is pinned in
 * `TimelinePane.testIds.dom.test.tsx`; here the catalog's own shape.
 */
import { describe, expect, it } from 'vitest';

import { TIMELINE_TEST_IDS, TIMELINE_VIEW_ATTRS } from './timelineTestIds';

describe('timeline test ids (D-434)', () => {
  it('test ids are unique, kebab-case and namespaced', () => {
    const ids = Object.values(TIMELINE_TEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^timeline-[a-z]+(-[a-z]+)*$/);
  });

  it('view attributes are data-chroma-* attributes', () => {
    for (const attr of Object.values(TIMELINE_VIEW_ATTRS)) expect(attr).toMatch(/^data-chroma-[a-z-]+$/);
  });
});
