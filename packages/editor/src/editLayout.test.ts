/**
 * D-432 P5 — the Edit tab's layout store: every write is clamped, a write
 * that changes nothing is not one, and only user / debug writes reach the
 * persistence sink (a hydrate must not write the saved value straight back).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_WIDTH,
  DEFAULT_EDIT_LAYOUT,
  INSPECTOR_WIDTH,
  TIMELINE_HEIGHT,
  mergeEditLayout,
  useEditLayoutStore,
  type EditLayout,
} from './editLayout';

let persisted: EditLayout[] = [];

beforeEach(() => {
  persisted = [];
  useEditLayoutStore.setState({ ...DEFAULT_EDIT_LAYOUT, revision: 0, lastSource: 'hydrate' });
  useEditLayoutStore.getState().setPersist((l) => persisted.push(l));
});

describe('mergeEditLayout', () => {
  it('clamps each size to its split bounds and rounds', () => {
    const l = mergeEditLayout(DEFAULT_EDIT_LAYOUT, { browserWidth: 10, inspectorWidth: 9000, timelineHeight: 300.6 });
    expect(l.browserWidth).toBe(BROWSER_WIDTH.min);
    expect(l.inspectorWidth).toBe(INSPECTOR_WIDTH.max);
    expect(l.timelineHeight).toBe(301);
    expect(mergeEditLayout(DEFAULT_EDIT_LAYOUT, { timelineHeight: 1 }).timelineHeight).toBe(TIMELINE_HEIGHT.min);
  });

  it('ignores wrong types and junk rather than throwing', () => {
    expect(mergeEditLayout(DEFAULT_EDIT_LAYOUT, { browserWidth: 'x', browserOpen: 1, other: true })).toEqual(
      DEFAULT_EDIT_LAYOUT,
    );
    expect(mergeEditLayout(DEFAULT_EDIT_LAYOUT, null)).toEqual(DEFAULT_EDIT_LAYOUT);
    expect(mergeEditLayout(DEFAULT_EDIT_LAYOUT, 'nope')).toEqual(DEFAULT_EDIT_LAYOUT);
    expect(mergeEditLayout(DEFAULT_EDIT_LAYOUT, { browserWidth: Number.NaN })).toEqual(DEFAULT_EDIT_LAYOUT);
  });

  it('treats an explicit null timeline height as the default share', () => {
    const base = { ...DEFAULT_EDIT_LAYOUT, timelineHeight: 400 };
    expect(mergeEditLayout(base, { timelineHeight: null }).timelineHeight).toBeNull();
    expect(mergeEditLayout(base, {}).timelineHeight).toBe(400);
  });
});

describe('useEditLayoutStore', () => {
  it('a user write persists the whole layout and bumps the revision', () => {
    useEditLayoutStore.getState().setLayout({ browserWidth: 300 }, 'user');
    const s = useEditLayoutStore.getState();
    expect(s.browserWidth).toBe(300);
    expect(s.lastSource).toBe('user');
    expect(s.revision).toBe(1);
    expect(persisted).toEqual([{ ...DEFAULT_EDIT_LAYOUT, browserWidth: 300 }]);
  });

  it('a write that changes nothing is dropped (no revision, no persist)', () => {
    useEditLayoutStore.getState().setLayout({ browserWidth: DEFAULT_EDIT_LAYOUT.browserWidth }, 'user');
    expect(useEditLayoutStore.getState().revision).toBe(0);
    expect(persisted).toEqual([]);
  });

  it('hydrate applies the saved layout without writing it back', () => {
    useEditLayoutStore.getState().hydrate({ browserWidth: 350, timelineHeight: 420, browserOpen: false });
    const s = useEditLayoutStore.getState();
    expect([s.browserWidth, s.timelineHeight, s.browserOpen]).toEqual([350, 420, false]);
    expect(s.lastSource).toBe('hydrate');
    expect(persisted).toEqual([]);
  });

  it('setBrowserOpen is a user write', () => {
    useEditLayoutStore.getState().setBrowserOpen(false);
    expect(useEditLayoutStore.getState().browserOpen).toBe(false);
    expect(persisted).toHaveLength(1);
  });
});
