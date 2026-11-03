// @vitest-environment jsdom
/**
 * v0.3.0 — `debug_set_inspector_section` opens or collapses one Inspector
 * section through the store action the section header's click calls, reports
 * it back through `debug_get_ui_state`, and refuses an unknown id by name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
  convertFileSrc: (p: string) => p,
}));

const { DEBUG_OPS } = await import('./debugOps');
const { useEditorTimelineStore, INSPECTOR_SECTION_IDS } = await import('@apelles/editor');

beforeEach(() => {
  useEditorTimelineStore.setState({ inspectorSections: {} });
});

describe('debug_set_inspector_section', () => {
  it('opens and collapses a section in the store the header writes, reported by debug_get_ui_state', () => {
    expect(DEBUG_OPS.debug_set_inspector_section({ id: 'compositing', open: true })).toEqual({ ok: true, id: 'compositing', open: true });
    expect(useEditorTimelineStore.getState().inspectorSections.compositing).toBe(true);
    expect(DEBUG_OPS.debug_get_ui_state({}).editor.inspectorSections).toMatchObject({ compositing: true });
    expect(DEBUG_OPS.debug_set_inspector_section({ id: 'Compositing ', open: false })).toEqual({ ok: true, id: 'compositing', open: false });
    expect(useEditorTimelineStore.getState().inspectorSections.compositing).toBe(false);
  });

  it('refuses an unknown id with the list, and a non-boolean open', () => {
    const bad = DEBUG_OPS.debug_set_inspector_section({ id: 'colour', open: true });
    expect(bad.error).toMatch(/unknown section/);
    for (const id of INSPECTOR_SECTION_IDS) expect(bad.error).toContain(id);
    expect(DEBUG_OPS.debug_set_inspector_section({ id: 'crop', open: 'yes' }).error).toBeTruthy();
  });
});
