/**
 * @apelles/editor — a collapsible Inspector section whose open state lives in
 * the timeline store (D-432, P4).
 *
 * **What it is.** `@apelles/inspector`'s `InspectorSection` (collapsible mode)
 * bound to `timelineStore.inspectorSections[id]`: the panel remounts on every
 * selection, so local state would forget what the user opened; the store
 * remembers it, persists it per user, and `debug_get_ui_state` reports it.
 *
 * **What it does NOT do.** It does not decide what is inside a section or
 * which sections a clip has — the panels do. A section with no remembered
 * choice starts collapsed.
 *
 * v0.3.0 — `INSPECTOR_SECTION_IDS` is the one list of section ids, for
 * `@apelles/debug`'s `debug_set_inspector_section` (which recognises or
 * refuses an id by name) and the tests.
 */
import type { ReactNode } from 'react';
import { InspectorSection } from '@apelles/inspector';

import { useEditorTimelineStore } from './timelineStore';

/** Every collapsible section id the editor renders. */
export const INSPECTOR_SECTION_IDS = [
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

export type InspectorSectionId = (typeof INSPECTOR_SECTION_IDS)[number];

/** Parse an untyped section id (the debug op's argument), or `null`. */
export function parseInspectorSectionId(raw: unknown): InspectorSectionId | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return (INSPECTOR_SECTION_IDS as readonly string[]).includes(id) ? (id as InspectorSectionId) : null;
}

/** Every section starts collapsed (owner, 2026-11-01); a remembered choice in
 *  `timelineStore.inspectorSections` wins. */
export function EditorSection({
  id,
  label,
  meta,
  actions,
  children,
}: {
  id: InspectorSectionId;
  label: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const open = useEditorTimelineStore((s) => s.inspectorSections[id]) ?? false;
  const setOpen = useEditorTimelineStore((s) => s.setInspectorSectionOpen);
  return (
    <InspectorSection id={id} label={label} meta={meta} actions={actions} open={open} onOpenChange={(v) => setOpen(id, v)}>
      {children}
    </InspectorSection>
  );
}
