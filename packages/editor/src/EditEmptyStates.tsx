/**
 * @apelles/editor — the Edit tab's designed empty states (D-432 §4.13, v0.3.0
 * gap closure, B-354 / B-359 item 8; `docs/notes/ui-redesign.md` §6e).
 *
 * **What it is.** The four "nothing here yet" surfaces, drawn from the spec
 * with Phosphor icons and the token palette only:
 * - `TimelineEmptyState` — a timeline with no tracks: two placeholder lanes
 *   (V1 over A1, at the default height, with the `lane-alt` banding) so the
 *   panel already reads as a timeline, and one centred line with the import
 *   action. Replaces the dashed 2 px box.
 * - `TimelineNoClipsHint` — tracks but no clips: the same line, centred over
 *   the lanes, clicks passing through everywhere but the button.
 * - `NoProjectState` — the Edit tab with no project open (copy unchanged,
 *   restyled to the type scale).
 * - The browser's empty media pool lives in `app/`'s `SourcesPanel` (it owns
 *   the pool), and the Inspector's no-selection view is the Timeline /
 *   project settings panel (§4.13: "never a blank panel"), so neither is here.
 *
 * **What it does NOT do.** Import anything or handle a drop: the import
 * button is injected by the composition root (`app/`'s `SourcesImportButton`,
 * the same one the browser's tab row shows), and the timeline pane keeps its
 * own drop handlers on the wrapper it renders these inside.
 */
import type { ReactNode } from 'react';
import { FolderOpenIcon } from '@phosphor-icons/react';

import { DEFAULT_TRACK_HEIGHT } from './trackHeight';

/** The one-line instruction. There is no append-from-the-browser key yet, so
 *  the line names the gesture that exists (a drag); §4.13's "press E to
 *  append" returns when that key does. */
export const TIMELINE_EMPTY_LINE = 'Drag media here from the browser to start editing';

function EmptyLine({ action }: { action?: ReactNode }) {
  return (
    <div className="@container pointer-events-auto flex flex-col items-center gap-2 text-center">
      <p className="text-sm text-text-secondary">{TIMELINE_EMPTY_LINE}</p>
      {action}
    </div>
  );
}

/** A timeline with no tracks: placeholder V1 / A1 lanes and the line. */
export function TimelineEmptyState({ action, dragOver }: { action?: ReactNode; dragOver: boolean }) {
  const rows = [
    { badge: 'V1', name: 'Video 1', strip: 'bg-clip-video', band: 'bg-timeline-bg' },
    { badge: 'A1', name: 'Audio 1', strip: 'bg-clip-audio', band: 'bg-lane-alt' },
  ];
  return (
    <div
      data-chroma-empty-state="timeline"
      className={
        'relative flex h-full w-full flex-col bg-timeline-bg ' + (dragOver ? 'ring-2 ring-inset ring-accent' : '')
      }
    >
      {/* No toolbar row here: the Edit tab draws the switcher row above a
          timeline with no tracks (`EditorTab`). */}
      <div className="flex min-h-0 flex-1 flex-col" aria-hidden>
        {rows.map((r) => (
          <div key={r.badge} className="flex border-b border-border-color/60" style={{ height: DEFAULT_TRACK_HEIGHT }}>
            <div className="flex w-[136px] shrink-0 items-center gap-1.5 border-r border-divider bg-surface opacity-60">
              <span className={'h-full w-[3px] shrink-0 ' + r.strip} />
              <span className="flex h-4 w-5 items-center justify-center rounded-xs bg-bg-secondary font-mono text-2xs font-semibold text-text-secondary">
                {r.badge}
              </span>
              <span className="truncate text-xs text-text-secondary">{r.name}</span>
            </div>
            <div className={'min-w-0 flex-1 ' + r.band} />
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
        <EmptyLine action={action} />
      </div>
    </div>
  );
}

/** Tracks but no clips: the same line over the lanes. */
export function TimelineNoClipsHint({ action }: { action?: ReactNode }) {
  return (
    <div
      data-chroma-empty-state="no-clips"
      className="pointer-events-none absolute inset-0 z-(--z-timeline-overlay) flex items-center justify-center px-6"
    >
      <EmptyLine action={action} />
    </div>
  );
}

/** The Edit tab with no project open. */
export function NoProjectState() {
  return (
    <div
      data-chroma-empty-state="no-project"
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-bg-primary px-6 text-center"
    >
      <FolderOpenIcon className="size-8 text-text-tertiary" aria-hidden />
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold text-text-primary">No project open</h1>
        <p className="max-w-md text-sm text-text-secondary">
          Open a project in the Colorist tab — its shots become the Edit timeline.
        </p>
      </div>
    </div>
  );
}
