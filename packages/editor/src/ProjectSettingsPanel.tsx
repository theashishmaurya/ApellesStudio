/**
 * @apelles/editor — the Edit tab's docked Project Settings panel (D-274,
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
 * **No "Canvas" collapsible.** The first cut wrapped the form in
 * `@apelles/ui`'s `CollapsibleSection` (matching the reference screenshot's
 * own section title), but with exactly one section, `canToggleVisibility={
 * false}`, and this panel's own "Project Settings" header already sitting
 * right above it, the section title/chevron said nothing the header didn't
 * already say — pure chrome around content that can't usefully collapse.
 * Flagged live (owner, 2026-09-10) as part of the docked panel reading as
 * busier than it needed to, with dead space below it once removed. The form
 * now renders directly under the panel's own header, no wrapper.
 *
 * **D-411 Phase 0 — "This timeline".** Under the project's own spec sits the
 * OPEN timeline's own output size (`TimelineOutputForm`): follow the project,
 * or a preset / custom size of its own. The project settings stay the default
 * every timeline without one uses.
 */
import { InspectorEmptyState } from '@apelles/inspector';

import { ProjectSettingsForm } from './ProjectSettingsForm';
import { TimelineOutputForm } from './TimelineOutputForm';
import { useEditorTimelineStore } from './timelineStore';
import { useProjectSettings } from './useProjectSettings';

export function ProjectSettingsPanel() {
  const { settings, error, saving, save } = useProjectSettings();
  // D-411 Phase 0 — the open timeline's own size section. Keyed by timeline
  // id so its mode pills re-seed from the document on a timeline switch.
  const timelineId = useEditorTimelineStore((s) => s.timeline?.id ?? null);
  const timelineName = useEditorTimelineStore((s) => s.timeline?.name ?? '');

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
        {settings !== null && <ProjectSettingsForm settings={settings} onChange={save} disabled={saving} />}
        {timelineId !== null && (
          // D-411 Phase 0 — Resolve's per-timeline "Use Project Settings": a
          // short can be 9:16 while the project (and its long-form) is 16:9.
          <div className="mt-4 flex flex-col gap-2 border-t border-border-color pt-3">
            <div className="text-text-primary font-medium">
              This timeline <span className="text-text-secondary font-normal">· {timelineName || 'Untitled'}</span>
            </div>
            <TimelineOutputForm key={timelineId} />
          </div>
        )}
      </div>
    </div>
  );
}
