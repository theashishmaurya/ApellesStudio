/**
 * @apelles/editor — the Edit tab's docked Project Settings panel (D-272,
 * `docs/04-roadmap.md`'s "Project Settings: same feature, better UX").
 *
 * **What it is.** Fills the clip Inspector column's own "nothing selected"
 * slot (`EditorInspectorPanel.tsx`'s own render branch, when `selection` is
 * empty) with the project's D-038 output spec — Resolution, Frame Rate,
 * Colour Space — via the shared `ProjectSettingsForm`, the SAME component
 * the Colorist tab's `ProjectSettingsModal.tsx` renders inside its dialog.
 * Open at rest, not behind a trigger — the owner's own reference screenshot
 * (`scratch/project-settings-sidepanel-reference.png`) and roadmap ask.
 *
 * **Why a docked panel owns its own IO.** `EditorInspectorPanel.tsx` derives
 * everything else in this column from `useEditorTimelineStore` (timeline
 * data), but project settings are not timeline data — they are the D-038
 * manifest field `useCompositionSize.ts`/`CanvasSettingsPopover.tsx` already
 * read directly via `chroma_project_get_settings`/`_set_settings`. This
 * panel does the same, through `useProjectSettings` (this package's own live
 * view of that field — see that hook's own doc for why it cannot instead
 * read `app/src`'s `useSessionStore`).
 *
 * **The "Canvas" collapsible** is `@apelles/ui`'s existing `CollapsibleSection`
 * (RapidRAW's own accordion, already used by Colorist's `ControlsPanel` and
 * friends) — the canonical component for exactly this shape, not a
 * hand-rolled chevron. Open by default (`useState(true)`), matching "open at
 * rest rather than behind a trigger"; `canToggleVisibility={false}` because
 * this section's own "disable it" affordance has no meaning for project
 * settings. The open/closed flag is local, ephemeral UI state (not
 * persisted) — the same category `ClipInspectorPanel`'s own `ratioLocked`
 * is, for the same reason: which way the user last left one accordion open
 * carries no information a future session needs back.
 */
import { useState } from 'react';
import { CollapsibleSection } from '@apelles/ui';
import { InspectorEmptyState } from '@apelles/inspector';

import { ProjectSettingsForm } from './ProjectSettingsForm';
import { useProjectSettings } from './useProjectSettings';

export function ProjectSettingsPanel() {
  const { settings, error, saving, save } = useProjectSettings();
  const [canvasOpen, setCanvasOpen] = useState(true);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-0 text-xs" data-chroma-panel="project-settings">
      {/* Same header treatment `ClipInspectorPanel`'s own clip-name block
          uses (border-bottom, `p-3 pb-2`) — this column always opens on
          SOME fixed header over a scrolling body, whichever content is
          showing. */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-border-color p-3 pb-2">
        <div className="text-text-primary font-medium">Project Settings</div>
        <p className="text-text-secondary/60 text-[10px] leading-snug">
          Select a clip to edit its properties — or set the project&apos;s own output spec here.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {settings === null && !error && <InspectorEmptyState>Loading project settings…</InspectorEmptyState>}
        {error && <p className="pb-2 text-[11px] text-red-400">Could not load project settings: {error}</p>}
        {settings !== null && (
          <CollapsibleSection
            title="Canvas"
            isOpen={canvasOpen}
            onToggle={() => setCanvasOpen((v) => !v)}
            canToggleVisibility={false}
          >
            <ProjectSettingsForm settings={settings} onChange={save} disabled={saving} />
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}
