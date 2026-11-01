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
 */
import type { ReactNode } from 'react';
import { InspectorSection } from '@apelles/inspector';

import { useEditorTimelineStore } from './timelineStore';

/** Every section starts collapsed (owner, 2026-11-01); a remembered choice in
 *  `timelineStore.inspectorSections` wins. */
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
  const open = useEditorTimelineStore((s) => s.inspectorSections[id]) ?? false;
  const setOpen = useEditorTimelineStore((s) => s.setInspectorSectionOpen);
  return (
    <InspectorSection id={id} label={label} meta={meta} actions={actions} open={open} onOpenChange={(v) => setOpen(id, v)}>
      {children}
    </InspectorSection>
  );
}
