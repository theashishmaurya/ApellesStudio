// @vitest-environment jsdom
/**
 * D-432 P5 — the Edit tab's layout through the debug ops: `debug_get_ui_state`
 * reports `editor.layout`, `debug_set_editor_layout` writes the same store a
 * released split writes (clamped, persisted, refused when wrong), and
 * `debug_set_library_mode` shows the browser — the old rail's column flag is
 * no longer what makes a library visible on the Edit tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
  convertFileSrc: (p: string) => p,
}));

const { DEBUG_OPS } = await import('./debugOps');
const { useEditLayoutStore, DEFAULT_EDIT_LAYOUT, BROWSER_WIDTH, useEditorTimelineStore } = await import('@apelles/editor');

let persisted: unknown[] = [];

beforeEach(() => {
  persisted = [];
  useEditLayoutStore.setState({ ...DEFAULT_EDIT_LAYOUT });
  useEditLayoutStore.getState().setPersist((layout) => persisted.push(layout));
});

describe('debug_set_editor_layout', () => {
  it('is reported by debug_get_ui_state', () => {
    expect(DEBUG_OPS.debug_get_ui_state({}).editor.layout).toEqual(DEFAULT_EDIT_LAYOUT);
  });

  it('writes sizes, clamps them to the split bounds, persists, and echoes the layout', () => {
    const res = DEBUG_OPS.debug_set_editor_layout({ browserWidth: 9999, inspectorWidth: 300, timelineHeight: 400 });
    expect(res.ok).toBe(true);
    expect(res.layout).toEqual({
      browserOpen: true,
      browserWidth: BROWSER_WIDTH.max,
      inspectorWidth: 300,
      timelineHeight: 400,
    });
    expect(useEditLayoutStore.getState().lastSource).toBe('debug');
    expect(persisted).toEqual([res.layout]);
  });

  it('null timeline height goes back to the default share', () => {
    DEBUG_OPS.debug_set_editor_layout({ timelineHeight: 400 });
    expect(DEBUG_OPS.debug_set_editor_layout({ timelineHeight: null }).layout.timelineHeight).toBeNull();
  });

  it('hides and shows the browser', () => {
    expect(DEBUG_OPS.debug_set_editor_layout({ browserOpen: false }).layout.browserOpen).toBe(false);
  });

  it('refuses an empty call and wrong types by name, changing nothing', () => {
    expect(DEBUG_OPS.debug_set_editor_layout({}).error).toContain('browserOpen');
    expect(DEBUG_OPS.debug_set_editor_layout({ browserOpen: 'yes' }).error).toContain('browserOpen');
    expect(DEBUG_OPS.debug_set_editor_layout({ browserWidth: 'wide' }).error).toContain('browserWidth');
    expect(DEBUG_OPS.debug_set_editor_layout({ timelineHeight: 'tall' }).error).toContain('timelineHeight');
    expect(persisted).toEqual([]);
  });
});

describe('debug_set_library_mode on the Edit tab browser', () => {
  it('selects the library and shows the browser', () => {
    useEditLayoutStore.getState().setLayout({ browserOpen: false }, 'user');
    const res = DEBUG_OPS.debug_set_library_mode({ mode: 'recut' });
    expect(res).toEqual({ ok: true, libraryMode: 'recut', browserOpen: true });
    expect(useEditorTimelineStore.getState().libraryMode).toBe('recut');
  });
});
