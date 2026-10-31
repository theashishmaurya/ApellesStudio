/**
 * @apelles/editor — the timeline toolbar's view controls (D-432 P3,
 * `docs/notes/ui-redesign.md` §4.9): the Snapping (N) and Skimming (S)
 * toggles, and the Clip Appearance popover (FCP's: zoom, the waveform /
 * filmstrip balance, the clip height S / M / L / XL, clip names and badges).
 *
 * What it does: reads and writes `useTimelineViewStore` (`timelineView.ts`) —
 * the same store `editor_set_timeline_view` writes and `editor_get_state`
 * reports, so the GUI and the agent are two views of one setting.
 *
 * What it does NOT do: anchor a zoom (the popover's slider sets `pxPerSec`
 * directly, as the MCP tool does; the toolbar's +/- buttons and the wheel
 * anchor on the playhead / cursor in `TimelinePane`), or decide anything a
 * setting means (snapping is read by the gestures, skimming by the pane, the
 * appearance by `clipAnatomy`).
 */

import type { ReactNode } from 'react';
import { HandSwipeRightIcon, MagnetIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@apelles/ui';

import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from './ruler';
import { BAND_RATIO_STOPS, timelineZoomPct, useTimelineViewStore } from './timelineView';
import { TIMELINE_TEST_IDS } from './timelineTestIds';
import { TRACK_HEIGHT_PRESET_NAMES, TRACK_HEIGHT_PRESETS } from './trackHeight';

/** The band-ratio stops' labels, in `BAND_RATIO_STOPS` order. */
const BAND_RATIO_LABELS = ['Filmstrip', 'Balanced', 'Audio+', 'Waveform'] as const;

/** A 24 × 24 toolbar toggle (§4.9): an active one has the accent icon on
 *  `bg-secondary`. */
function ToolbarToggle({
  on,
  label,
  shortcut,
  hint,
  testId,
  onToggle,
  children,
}: {
  on: boolean;
  label: string;
  shortcut: string;
  hint: string;
  testId: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={'size-6 rounded-sm [&_svg]:size-4 ' + (on ? 'bg-bg-secondary text-accent-text' : 'text-text-secondary')}
            onClick={onToggle}
            aria-pressed={on}
            aria-label={label}
            data-testid={testId}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>
        <span className="font-medium">
          {label} ({shortcut})
        </span>
        <span className="ml-1.5 text-text-secondary">{hint}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The Snapping (N) and Skimming (S) toggles. */
export function SnapSkimToggles() {
  const snapping = useTimelineViewStore((s) => s.snapping);
  const skimming = useTimelineViewStore((s) => s.skimming);
  const setView = useTimelineViewStore((s) => s.setView);
  return (
    <>
      <ToolbarToggle
        on={snapping}
        label="Snapping"
        shortcut="N"
        hint={snapping ? 'On: drags, trims and the playhead snap to edges, the playhead and markers (hold ⌘ to suspend)' : 'Off: everything lands exactly where you release'}
        testId={TIMELINE_TEST_IDS.snappingToggle}
        onToggle={() => setView({ snapping: !snapping })}
      >
        <MagnetIcon />
      </ToolbarToggle>
      <ToolbarToggle
        on={skimming}
        label="Skimming"
        shortcut="S"
        hint={skimming ? 'On: the viewer shows the frame under the pointer; the playhead stays put' : 'Off: hover the timeline without changing the viewer'}
        testId={TIMELINE_TEST_IDS.skimmingToggle}
        onToggle={() => setView({ skimming: !skimming })}
      >
        <HandSwipeRightIcon />
      </ToolbarToggle>
    </>
  );
}

/** A segmented row of buttons (the popover's height and balance pickers). */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  attr,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  attr: string;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex h-6 rounded-sm bg-bg-secondary p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          {...{ [attr]: String(o.value) }}
          className={
            'flex-1 rounded-xs px-1 text-2xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ' +
            (o.value === value ? 'bg-card-active text-text-primary' : 'text-text-secondary hover:text-text-primary')
          }
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The slider's zoom is logarithmic: one notch means the same ratio at every
 *  zoom, as the +/- buttons' fixed factor does. */
const LOG_MIN = Math.log(MIN_PX_PER_SEC);
const LOG_MAX = Math.log(MAX_PX_PER_SEC);
const ZOOM_SLIDER_STEPS = 1000;

/** The Clip Appearance popover (FCP's): zoom, waveform / filmstrip balance,
 *  clip height, names and badges. */
export function ClipAppearanceButton() {
  const pxPerSec = useTimelineViewStore((s) => s.pxPerSec);
  const clipHeight = useTimelineViewStore((s) => s.clipHeight);
  const bandRatio = useTimelineViewStore((s) => s.bandRatio);
  const showNames = useTimelineViewStore((s) => s.showNames);
  const showBadges = useTimelineViewStore((s) => s.showBadges);
  const setView = useTimelineViewStore((s) => s.setView);
  const zoomSlider = Math.round(((Math.log(pxPerSec) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * ZOOM_SLIDER_STEPS);
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
                  className="size-6 rounded-sm text-text-secondary [&_svg]:size-4 data-[popup-open]:bg-bg-secondary data-[popup-open]:text-accent-text"
                  aria-label="Clip appearance"
                  data-testid={TIMELINE_TEST_IDS.clipAppearance}
                >
                  <SlidersHorizontalIcon />
                </Button>
              }
            />
          }
        />
        <TooltipContent>Clip appearance: zoom, clip height, waveform and filmstrip, names</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-3 text-xs" data-testid={TIMELINE_TEST_IDS.clipAppearancePopover}>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-text-secondary">
              Zoom <span className="font-mono text-text-tertiary">{timelineZoomPct(pxPerSec)}%</span>
            </span>
            <Slider
              min={0}
              max={ZOOM_SLIDER_STEPS}
              value={[zoomSlider]}
              aria-label="Timeline zoom"
              data-testid={TIMELINE_TEST_IDS.zoomSlider}
              onValueChange={(v: number | readonly number[]) => {
                const n = Array.isArray(v) ? v[0] : v;
                if (typeof n !== 'number') return;
                setView({ pxPerSec: Math.exp(LOG_MIN + (n / ZOOM_SLIDER_STEPS) * (LOG_MAX - LOG_MIN)) });
              }}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-text-secondary">Waveform and filmstrip</span>
            <Segmented
              label="Waveform and filmstrip"
              attr="data-chroma-band-ratio"
              value={BAND_RATIO_STOPS.reduce((best, s) => (Math.abs(s - bandRatio) < Math.abs(best - bandRatio) ? s : best), BAND_RATIO_STOPS[0])}
              options={BAND_RATIO_STOPS.map((s, i) => ({ value: s, label: BAND_RATIO_LABELS[i] }))}
              onChange={(v) => setView({ bandRatio: v })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-text-secondary">Clip height</span>
            <Segmented
              label="Clip height"
              attr="data-chroma-clip-height"
              value={TRACK_HEIGHT_PRESET_NAMES.find((p) => TRACK_HEIGHT_PRESETS[p] === clipHeight) ?? ('custom' as string)}
              options={TRACK_HEIGHT_PRESET_NAMES.map((p) => ({ value: p as string, label: p, title: `${TRACK_HEIGHT_PRESETS[p]} px` }))}
              onChange={(p) => setView({ clipHeight: TRACK_HEIGHT_PRESETS[p as keyof typeof TRACK_HEIGHT_PRESETS] })}
            />
            <span className="text-2xs leading-snug text-text-tertiary">
              Every track without its own height. Drag a track&apos;s bottom edge to size it alone.
            </span>
          </div>
          <label className="flex items-center justify-between">
            <span className="text-text-secondary">Clip names</span>
            <Switch size="sm" checked={showNames} onCheckedChange={(on: boolean) => setView({ showNames: on })} data-testid={TIMELINE_TEST_IDS.showClipNames} />
          </label>
          <label className="flex items-center justify-between">
            <span className="text-text-secondary">Badges</span>
            <Switch size="sm" checked={showBadges} onCheckedChange={(on: boolean) => setView({ showBadges: on })} data-testid={TIMELINE_TEST_IDS.showClipBadges} />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
