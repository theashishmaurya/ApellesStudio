/**
 * Test helpers for the Inspector's collapsible sections (owner, 2026-11-01:
 * every section starts collapsed). A suite that queries a field inside a
 * section opens it first, through the store's real `setInspectorSectionOpen`
 * (the same call a click makes), before it renders.
 *
 * Import `./timelineStore` only AFTER the suite's `vi.mock` calls, as the
 * suites already do; these helpers take the store as a parameter for that
 * reason.
 */
import type { useEditorTimelineStore } from '../timelineStore';

type TimelineStore = typeof useEditorTimelineStore;

/** Every collapsible `EditorSection` id the editor renders. */
export const ALL_INSPECTOR_SECTION_IDS = [
  'transform',
  'compositing',
  'crop',
  'dynamic-zoom',
  'speed',
  'fade',
  'keyframes',
  'highlights',
  'audio',
  'eq',
  'project-settings',
  'timeline-settings',
] as const;

/** Open the named sections (and leave every other one as it is). */
export function openInspectorSections(store: TimelineStore, ...ids: string[]): void {
  for (const id of ids) store.getState().setInspectorSectionOpen(id, true);
}

/** Open every section. */
export function openAllInspectorSections(store: TimelineStore): void {
  openInspectorSections(store, ...ALL_INSPECTOR_SECTION_IDS);
}

/** Forget every remembered choice: a fresh store, every section collapsed. */
export function resetInspectorSections(store: TimelineStore): void {
  store.setState({ inspectorSections: {} });
  try {
    globalThis.localStorage?.removeItem('apelles.editor.inspectorSections');
  } catch {
    // no storage in this environment: nothing was persisted
  }
}
