/**
 * @apelles/editor — the timeline toolbar's Beat grid control (D-413 controls,
 * regrouped for v0.3.0: B-354 / B-359 item 4, `docs/notes/ui-redesign.md`
 * §4.9 and §6e).
 *
 * **What it is.** One 24 × 24 `Metronome` toggle in the toolbar's right group,
 * where the approved mockup has "Beat grid", opening a popover that holds
 * everything the beat grid had spread across the toolbar before: the tempo
 * readout ("128 BPM", "analysing beats…", "beats failed"), the beat-snapping
 * switch and the "Snap cuts to beats" action, plus the result of the last
 * snap. The icon is accent while a track's beats are on.
 *
 * **What it does NOT do.** Own any state or run any edit: every value and
 * action is the pane's (`TimelinePane`'s `useTimelineBeats`, the store's
 * `beatSnap`, `snapCutsToBeats` — the same op `editor_snap_cuts_to_beats`
 * runs), handed in as props. Turning a track's beat grid on stays where it is
 * (the track header's Show beats toggle, and `editor_set_beat_grid`); the popover says so
 * when no track has one.
 */
import { MetronomeIcon } from '@phosphor-icons/react';
import { Button, Popover, PopoverContent, PopoverTrigger, Switch, Tooltip, TooltipContent, TooltipTrigger } from '@apelles/ui';

import { TIMELINE_TEST_IDS } from './timelineTestIds';

export interface TimelineBeatControlProps {
  /** A track's beat grid is on. */
  active: boolean;
  /** "128 BPM" / "analysing beats…" / "beats failed"; `null` when inactive. */
  readout: string | null;
  /** The analysis errors, one per line, for the readout's tooltip. */
  readoutTitle?: string;
  /** The last "Snap cuts to beats" result, if any. */
  notice: string | null;
  beatSnap: boolean;
  /** The general Snapping toggle (N): beat snapping is one of its targets. */
  snapping: boolean;
  onBeatSnapChange: (on: boolean) => void;
  /** A clip is selected (its track's cuts are what snap) and no snap runs. */
  canSnapCuts: boolean;
  onSnapCuts: () => void;
}

export function TimelineBeatControl({
  active,
  readout,
  readoutTitle,
  notice,
  beatSnap,
  snapping,
  onBeatSnapChange,
  canSnapCuts,
  onSnapCuts,
}: TimelineBeatControlProps) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={
                    'size-6 rounded-sm [&_svg]:size-4 data-[popup-open]:bg-bg-secondary ' +
                    (active ? 'bg-bg-secondary text-accent-text' : 'text-text-secondary')
                  }
                  aria-label="Beat grid"
                  data-testid={TIMELINE_TEST_IDS.beatGrid}
                  data-chroma-active={active ? '' : undefined}
                >
                  <MetronomeIcon />
                </Button>
              }
            />
          }
        />
        <TooltipContent>
          <span className="font-medium">Beat grid</span>
          <span className="ml-1.5 text-text-secondary">{active && readout ? readout : 'Off'}</span>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-3 text-xs" data-testid={TIMELINE_TEST_IDS.beatGridPopover}>
        {active ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-text-secondary">Tempo</span>
              <span data-chroma-beat-readout className="font-mono tabular-nums text-text-primary" title={readoutTitle}>
                {readout}
              </span>
            </div>
            <label className="flex items-center justify-between">
              <span className="text-text-secondary">Snap to beats</span>
              <Switch size="sm" checked={beatSnap} onCheckedChange={(on: boolean) => onBeatSnapChange(on)} aria-label="Snap to beats" />
            </label>
            {beatSnap && !snapping && (
              <p className="-mt-2 text-2xs leading-snug text-text-tertiary">Snapping (N) is off, so nothing snaps yet.</p>
            )}
            <div className="flex flex-col gap-1">
              <Button
                variant="secondary"
                size="sm"
                className="h-7 justify-center text-xs"
                disabled={!canSnapCuts}
                onClick={onSnapCuts}
                data-testid={TIMELINE_TEST_IDS.snapCutsToBeats}
              >
                Snap cuts to beats
              </Button>
              <span className="text-2xs leading-snug text-text-tertiary">
                Rolls every cut on the selected clip&apos;s track onto its nearest beat (one undo).
              </span>
            </div>
            {notice && (
              <p role="status" className="text-2xs leading-snug text-text-secondary">
                {notice}
              </p>
            )}
          </div>
        ) : (
          <p className="text-2xs leading-snug text-text-secondary">
            No beat grid. Turn one on with a music track header&apos;s Show beats toggle; its beats are then
            drawn on the timeline and edits can snap to them.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
