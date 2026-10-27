// @vitest-environment jsdom
/**
 * B-292 — `debug_get_ui_state` reports every panel that is showing its crash
 * fallback, so an agent learns "the Timeline panel crashed: …" from one call
 * instead of from a screenshot of a blank-ish pane.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
  convertFileSrc: (p: string) => p,
}));

const { DEBUG_OPS } = await import('./debugOps');
const { clearPanelCrash, reportPanelCrash } = await import('@apelles/ui');

describe('debug_get_ui_state reports crashed panels', () => {
  it('lists a crashed panel with its error, and drops it once the panel is reloaded', () => {
    expect(DEBUG_OPS.debug_get_ui_state({}).crashedPanels).toEqual([]);
    reportPanelCrash({
      panel: 'Timeline',
      message: 'boom',
      stack: 'Error: boom',
      componentStack: '\n    at TimelinePane',
      at: '2026-10-28T00:11:15.000Z',
    });
    expect(DEBUG_OPS.debug_get_ui_state({}).crashedPanels).toEqual([
      {
        panel: 'Timeline',
        message: 'boom',
        stack: 'Error: boom',
        componentStack: '\n    at TimelinePane',
        at: '2026-10-28T00:11:15.000Z',
        count: 1,
      },
    ]);
    clearPanelCrash('Timeline');
    expect(DEBUG_OPS.debug_get_ui_state({}).crashedPanels).toEqual([]);
  });
});
