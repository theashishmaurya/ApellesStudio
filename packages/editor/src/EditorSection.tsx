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
 * choice shows `defaultOpen`.
 */
import type { ReactNode } from 'react';
import { InspectorSection } from '@apelles/inspector';

import { useEditorTimelineStore } from './timelineStore';

/** Sections that start closed because they are secondary and/or heavy; every
 *  other section starts open. One list, so the defaults are not scattered
 *  across call sites. */
const CLOSED_BY_DEFAULT: ReadonlySet<string> = new Set(['dynamic-zoom', 'highlights']);

/** Whether a section with this id is open when the user has not chosen. */
export function sectionDefaultOpen(id: string): boolean {
  return !CLOSED_BY_DEFAULT.has(id);
}

export function EditorSection({
  id,
  label,
  meta,
  actions,
  children,
}: {
  id: string;
  label: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const open = useEditorTimelineStore((s) => s.inspectorSections[id]) ?? sectionDefaultOpen(id);
  const setOpen = useEditorTimelineStore((s) => s.setInspectorSectionOpen);
  return (
    <InspectorSection id={id} label={label} meta={meta} actions={actions} open={open} onOpenChange={(v) => setOpen(id, v)}>
      {children}
    </InspectorSection>
  );
}
