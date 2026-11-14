/**
 * @apelles/editor — the timeline pane's toolbar row (B-377 / D-461; extracted
 * verbatim from `TimelinePane.tsx`, whose own doc holds the provenance of every
 * button here: D-261's trim palette, D-222's marker, D-226's transitions,
 * D-128's unlink, D-138's link, D-105/B-236's close gap, D-080's "Move to",
 * D-413's beat grid, D-432 P3's view toggles and §4.9's three-column grouping).
 *
 * What it is: a `memo`'d component that subscribes to the store slices the
 * toolbar's own buttons need — and to NOTHING else. Every prop it takes is a
 * primitive or the pane's fixed-identity `actions` object, so a render of the
 * ~4500-line pane does not re-render it, and an edit that leaves the selection
 * alone (a trim, a move, a drag release) renders it ZERO times. That is the
 * whole point: before B-377 the pane subscribed to the whole timeline and this
 * row — a few dozen Base UI tooltips, buttons and popovers — was rebuilt on
 * every edit. `TimelinePane.editRenders.dom.test.tsx` fails if the subscription
 * is ever hoisted back up.
 *
 * What it does NOT do: own any state, or decide what an action means. The gates
 * below (`linkGate`, `gapGate`) are pure functions over the store's own data —
 * the same `checkLink` / `checkRemoveGap` the ops and the MCP tools run — so the
 * button, the key and the agent can never disagree, and they stay movable into a
 * headless engine later (CLAUDE.md).
 */
import { memo, useMemo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowsInLineHorizontalIcon,
  ArrowsLeftRightIcon,
  // D-138 — the A/V-link action's own icon. Deliberately `Link`, not
  // `LinkSimpleHorizontal`: that one is the track header's sync-lock-ON icon
  // (`TrackHeader.tsx`), and sync-lock and an A/V link are different
  // relationships, so they must not share an icon.
  LinkIcon,
  // D-128 — the A/V-unlink action. Deliberately `LinkBreak`, not the header's
  // `LinkSimpleHorizontalBreak` sync-lock toggle, for the same reason.
  LinkBreakIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  SplitHorizontalIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@apelles/ui';

import { AddMarkerButton } from './TimelineMarkers';
import { TimelineBeatControl } from './TimelineBeatControl';
import { TransitionsPaletteButton } from './TimelineTransitions';
import { TIMELINE_TEST_IDS } from './timelineTestIds';
import { TimelineZoomSlider, ClipAppearanceButton, SnapSkimToggles } from './TimelineViewControls';
import { TrimToolbar } from './TrimToolbar';
import { trackLabels } from './trackOps';
import { useEditorTimelineStore, type Selection } from './timelineStore';
import { useTimelineViewStore } from './timelineView';
import { trimModeLabel, type TrimMode, type TrimTool } from './trimMode';
import {
  checkLink,
  checkRemoveGap,
  timelineFps,
  type LinkTarget,
  type Timeline,
} from './timeline';

/** What the toolbar's buttons ask the pane to do. Every method is forwarded
 *  through `useStableActions`, so this object's identity never changes. */
export type TimelineToolbarActions = {
  selectTrimTool: (tool: TrimTool) => void;
  /** Split every selected clip at the playhead. */
  split: () => void;
  /** Drop (or open) a marker at the playhead. */
  addMarker: () => void;
  /** Remove every selected clip, with its linked audio. */
  remove: () => void;
  unlink: () => void;
  link: () => void;
  /** Close the selected gap. */
  removeGap: () => void;
  moveToTrack: (toTrack: number) => void;
  dismissDropError: () => void;
  snapCutsToBeats: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** The zoom slider: an absolute px-per-second, anchored like the +/- buttons. */
  zoomTo: (pxPerSec: number) => void;
};

export interface TimelineToolbarProps {
  /** D-432 P5 — what the Edit tab centres in this row (switcher + timecode). */
  center?: ReactNode;
  /** D-235 — Alt/Option is held right now (the trim-mode hint shows). */
  trimArmed: boolean;
  /** The trim mode under the pointer, while armed. */
  hoverTrimMode: TrimMode | null;
  /** The last refused drop, in words, dismissable. */
  dropError: string | null;
  /** D-413 — the beat grid: whether a track has one, and its readout. */
  beatActive: boolean;
  beatReadout: string | null;
  beatReadoutTitle?: string;
  /** The last "Snap cuts to beats" outcome, in words. */
  beatNotice: string | null;
  /** A "Snap cuts to beats" run is in flight. */
  snappingCuts: boolean;
  actions: TimelineToolbarActions;
}

/** The separator used between the row's groups. */
const GROUP_SEPARATOR = <Separator orientation="vertical" className="mx-1 h-4" />;

/** `trackLabels` joined into one string, so the toolbar can subscribe to the
 *  track NAMES without re-rendering whenever a clip changes. No label can
 *  contain it (`trackLabels` returns the person's own name or `Video 2`). */
const LABEL_SEP = '\u0000';

/** D-138 — the Link button's gate: exactly two clips selected, resolved to real
 *  `{track, clip}` locations, run through `checkLink` (the SAME precondition
 *  check `applyOp`'s `link` case uses). `shown: false` for any other selection
 *  shape, so the button is hidden rather than shown-and-always-refused.
 *  Flat (three primitives) so a `useShallow` subscription is exact. */
export function linkGate(
  timeline: Timeline | null,
  selection: readonly Selection[],
): { shown: boolean; ok: boolean; reason?: string } {
  if (!timeline || selection.length !== 2) return { shown: false, ok: false };
  const locate = (sel: Selection): LinkTarget | null => {
    const clip = timeline.tracks[sel.track]?.clips.findIndex((c) => (c.id || '') === sel.id) ?? -1;
    return clip < 0 ? null : { track: sel.track, clip };
  };
  const a = locate(selection[0]);
  const b = locate(selection[1]);
  if (!a || !b) return { shown: false, ok: false };
  const result = checkLink(timeline, a, b);
  return { shown: true, ok: result.ok, reason: result.reason };
}

/** B-236 — whether the selected gap can actually be closed, from the SAME
 *  `checkRemoveGap` that `applyOp`'s `remove_gap` case and `editor_remove_gap`
 *  both run, so the button, the Delete key and the agent can never disagree.
 *  `shown: false` when no gap is selected. */
export function gapGate(
  timeline: Timeline | null,
  gap: { track: number; frame: number } | null,
): { shown: boolean; ok: boolean; reason?: string } {
  if (!timeline || !gap) return { shown: false, ok: false };
  const result = checkRemoveGap(timeline, gap.track, gap.frame, timelineFps(timeline));
  return result.ok ? { shown: true, ok: true } : { shown: true, ok: false, reason: result.reason };
}

/** Whether anything in the selection is A/V-linked — gates Unlink, which is
 *  meaningless (and a no-op) otherwise. */
export function selectionIsLinked(timeline: Timeline | null, selection: readonly Selection[]): boolean {
  return selection.some((s) => !!timeline?.tracks[s.track]?.clips.find((c) => c.id === s.id)?.link_group);
}

export const TimelineToolbar = memo(function TimelineToolbar({
  center,
  trimArmed,
  hoverTrimMode,
  dropError,
  beatActive,
  beatReadout,
  beatReadoutTitle,
  beatNotice,
  snappingCuts,
  actions,
}: TimelineToolbarProps) {
  // Every subscription here is a primitive or a shallow-compared flat object:
  // an edit that does not change the selection changes none of them, so this
  // component does not render (B-377).
  const selectionCount = useEditorTimelineStore((s) => s.selection.length);
  /** The one selected clip's track, or `null` unless exactly one is selected
   *  (Multi-select Phase 1, D-107 — "Move to" and "Snap cuts" stay single-clip). */
  const primaryTrack = useEditorTimelineStore((s) => (s.selection.length === 1 ? s.selection[0].track : null));
  const trackCount = useEditorTimelineStore((s) => s.timeline?.tracks.length ?? 0);
  const labelsKey = useEditorTimelineStore((s) => (s.timeline ? trackLabels(s.timeline).join(LABEL_SEP) : ''));
  const labels = useMemo(() => (labelsKey === '' ? [] : labelsKey.split(LABEL_SEP)), [labelsKey]);
  const isLinked = useEditorTimelineStore((s) => selectionIsLinked(s.timeline, s.selection));
  const link = useEditorTimelineStore(useShallow((s) => linkGate(s.timeline, s.selection)));
  const gap = useEditorTimelineStore(useShallow((s) => gapGate(s.timeline, s.selectedGap)));
  const beatSnap = useEditorTimelineStore((s) => s.beatSnap);
  const setBeatSnap = useEditorTimelineStore((s) => s.setBeatSnap);
  const trimTool = useTimelineViewStore((s) => s.trimTool);
  const snapping = useTimelineViewStore((s) => s.snapping);
  const pxPerSec = useTimelineViewStore((s) => s.pxPerSec);

  const otherTracks = useMemo(
    () =>
      primaryTrack === null
        ? []
        : Array.from({ length: trackCount }, (_, i) => i).filter((i) => i !== primaryTrack),
    [primaryTrack, trackCount],
  );

  return (
    <TooltipProvider>
      {/* v0.3.0 (B-354 / B-359 item 4) — the mockup's grouping, in three
          columns so the centre is truly centred (a `1fr auto 1fr` grid,
          the mock's `.ttool`): tools | Split, Marker, Transitions |
          contextual actions · switcher + timecode · Snapping, Skimming, Beat
          grid, Clip Appearance | the zoom slider. */}
      <div
        data-chroma-timeline-toolbar=""
        className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border-color bg-surface px-2 text-text-primary"
      >
        <div data-chroma-toolbar-group="left" className="flex min-w-0 items-center gap-1 overflow-hidden">
          {/* D-261 — the trim palette. It sits here, first among the actions
              that operate on the clips already in the timeline, because unlike
              every other button in this row it is MODAL: it changes what the
              next drag means rather than doing something once. A separator
              keeps that distinction visible instead of letting five icon
              buttons read as five more one-shot actions. See `TrimToolbar.tsx`
              for the icon choices and their provenance. */}
          <TrimToolbar active={trimTool} onSelect={actions.selectTrimTool} />
          {GROUP_SEPARATOR}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={actions.split}
                  disabled={selectionCount === 0}
                  data-testid={TIMELINE_TEST_IDS.split}
                  aria-label="Split at playhead"
                >
                  <SplitHorizontalIcon />
                </Button>
              }
            />
            <TooltipContent>
              <span className="font-medium">Split</span>
              <span className="ml-1.5 text-text-secondary">Split every selected clip at the playhead</span>
            </TooltipContent>
          </Tooltip>
          {/* D-222 — markers. A marker annotates a POSITION in this timeline,
              so the add button belongs in this toolbar. The owner removed the
              toolbar's marker list / counter (2026-11-01): markers are listed,
              jumped to and deleted in the Index panel, and on the flag's own
              editor (B-114's delete stays reachable from both). */}
          <AddMarkerButton onAdd={actions.addMarker} shortcut="M" />
          {/* D-226 — the transitions library. Beside Marker for the same reason
              those sit together: both are "bring something new into the edit",
              neither is scoped to the current selection. The drag itself starts
              inside its popover — see `TimelineTransitions.tsx`. */}
          <TransitionsPaletteButton />
          {/* D-235 — the context-sensitive trim tool's readout. Resolve tells
              you which of the four trims you are about to get by swapping the
              cursor (`scratch/resolve-reference/trim.jpg`); this names it. Only
              present while Alt/Option is actually held, so it is a hint during
              the gesture rather than permanent toolbar furniture — and it says
              the arm key when nothing is hovered yet, which is the only
              discoverability this feature has. */}
          {trimArmed && (
            <span
              data-chroma-trim-hint=""
              role="status"
              className="rounded border border-border-color bg-surface px-2 py-1 text-[10px] text-text-secondary"
            >
              {hoverTrimMode ? (trimModeLabel(hoverTrimMode) ?? 'Trim') : 'Trim: hover a clip'}
            </span>
          )}
          {dropError && (
            <button
              type="button"
              onClick={actions.dismissDropError}
              className="max-w-[26rem] truncate rounded border border-border-color bg-surface px-2 py-1 text-left text-[10px] text-text-secondary"
              title={`${dropError} (click to dismiss)`}
            >
              {dropError}
            </button>
          )}
          {/* v0.3.0 (B-354) — Remove is contextual, like Unlink / Link / Close
              Gap: shown while a clip is selected. §4.9 drops it from the
              toolbar, but the clip has no context menu yet, so this stays the
              pointer's way to delete (the Delete key is the other). */}
          {selectionCount > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={actions.remove}
                    data-testid={TIMELINE_TEST_IDS.delete}
                    aria-label="Remove clip"
                  >
                    <TrashIcon />
                  </Button>
                }
              />
              <TooltipContent>
                <span className="font-medium">Remove</span>
                <span className="ml-1.5 text-text-secondary">Remove every selected clip (with its linked audio)</span>
              </TooltipContent>
            </Tooltip>
          )}
          {/* D-128 — only shown when the selection is actually linked: an
              Unlink button that's permanently present but almost always inert
              would be noise, and its whole meaning is "this clip HAS a linked
              half." Both reference NLEs put unlink on the clip's own context
              menu; this toolbar is where every other per-clip action in this
              pane already lives, so it goes here for consistency. */}
          {isLinked && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={actions.unlink}
                    data-testid={TIMELINE_TEST_IDS.unlink}
                    aria-label="Unlink audio and video"
                  >
                    <LinkBreakIcon />
                  </Button>
                }
              />
              <TooltipContent>
                <span className="font-medium">Unlink</span>
                <span className="ml-1.5 text-text-secondary">
                  Break the A/V link so the picture and its audio can be trimmed and moved apart (an L-cut)
                </span>
              </TooltipContent>
            </Tooltip>
          )}

          {/* D-138 — the manual counterpart to Unlink: shown only when the
              selection is actually shaped like a link candidate (exactly two
              clips, see `linkGate`) — same "don't show an action that's almost
              always inert" reasoning as Unlink above. Unlike Unlink, whether
              it's ENABLED can still say no (wrong track kind, already linked, a
              locked track) — the button stays visible but disabled in that
              case, with the refusal's own reason in the tooltip, so the reason
              is surfaced rather than the button just silently vanishing (the
              owner's own ask). */}
          {link.shown && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={actions.link}
                    disabled={!link.ok}
                    data-testid={TIMELINE_TEST_IDS.link}
                    aria-label="Link audio and video"
                  >
                    <LinkIcon />
                  </Button>
                }
              />
              <TooltipContent>
                <span className="font-medium">Link</span>
                <span className="ml-1.5 text-text-secondary">
                  {link.ok
                    ? 'Link these two clips so they move, trim, split and delete together'
                    : link.reason}
                </span>
              </TooltipContent>
            </Tooltip>
          )}

          {/* D-105 — the mirror-image toolbar action for a selected GAP (empty
              track space, not a clip): closes it, rippling everything after it
              earlier. A separate button rather than overloading "Remove" —
              a distinct label/icon makes clear this closes the space rather
              than deleting something, matching the real, different underlying
              operation (`remove_gap` ripples; `remove` deliberately doesn't).
              The same Delete/Backspace keybinding covers both.
              B-236 — disabled, with the refusal's own reason in the tooltip,
              when `checkRemoveGap` says no: the same treatment the Link button
              (D-138) already gets. */}
          {gap.shown && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={actions.removeGap}
                    disabled={!gap.ok}
                    data-testid={TIMELINE_TEST_IDS.removeGap}
                    aria-label="Close gap"
                  >
                    <ArrowsInLineHorizontalIcon />
                  </Button>
                }
              />
              <TooltipContent>
                <span className="font-medium">Close Gap</span>
                <span className="ml-1.5 text-text-secondary">
                  {gap.ok ? 'Close the selected gap — everything after it shifts left' : gap.reason}
                </span>
              </TooltipContent>
            </Tooltip>
          )}

          {/* D-080: cross-track move — see `TimelinePane.tsx`'s module doc for
              why this is a dropdown and not a drag gesture. */}
          {primaryTrack !== null && otherTracks.length > 0 && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="icon-sm" aria-label="Move to another track">
                          <ArrowsLeftRightIcon />
                        </Button>
                      }
                    />
                  }
                />
                <TooltipContent>
                  <span className="font-medium">Move to</span>
                  <span className="ml-1.5 text-text-secondary">Move the selected clip to another track</span>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start">
                {otherTracks.map((i) => (
                  <DropdownMenuItem key={i} onClick={() => actions.moveToTrack(i)}>
                    {labels[i]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div data-chroma-toolbar-group="center" className="flex shrink-0 items-center justify-center px-1">
          {center}
        </div>
        <div data-chroma-toolbar-group="right" className="flex min-w-0 items-center justify-end gap-1">
          {/* D-432 P3 — Snapping (N) and Skimming (S); v0.3.0 — then the Beat
              grid (its tempo, beat snapping and "Snap cuts to beats" in one
              popover, where the readout and two buttons used to sit loose in
              this row), Clip Appearance, and the zoom slider (§4.9). */}
          <SnapSkimToggles />
          <TimelineBeatControl
            active={beatActive}
            readout={beatReadout}
            readoutTitle={beatReadoutTitle}
            notice={beatNotice}
            beatSnap={beatSnap}
            snapping={snapping}
            onBeatSnapChange={setBeatSnap}
            canSnapCuts={primaryTrack !== null && !snappingCuts}
            onSnapCuts={actions.snapCutsToBeats}
          />
          <ClipAppearanceButton />
          {GROUP_SEPARATOR}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={actions.zoomOut}
                  data-testid={TIMELINE_TEST_IDS.zoomOut}
                  aria-label="Zoom out"
                >
                  <MagnifyingGlassMinusIcon />
                </Button>
              }
            />
            <TooltipContent>Zoom out (−, or ctrl/pinch-scroll over the timeline)</TooltipContent>
          </Tooltip>
          <TimelineZoomSlider
            className="w-24"
            pxPerSec={pxPerSec}
            testId={TIMELINE_TEST_IDS.toolbarZoomSlider}
            // The playhead (or the view centre) holds still, as the +/- buttons
            // do: the same `zoomBy` with no pointer anchor.
            onZoom={actions.zoomTo}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={actions.zoomIn}
                  data-testid={TIMELINE_TEST_IDS.zoomIn}
                  aria-label="Zoom in"
                >
                  <MagnifyingGlassPlusIcon />
                </Button>
              }
            />
            <TooltipContent>Zoom in (=, or ctrl/pinch-scroll over the timeline)</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
});
