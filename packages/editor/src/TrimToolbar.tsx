/**
 * @chroma/editor — the timeline's trim-tool palette (D-261).
 *
 * **What it is.** The row of five icon buttons in `TimelinePane`'s toolbar that
 * chooses which edit a drag on a clip performs: Select, Ripple, Roll, Slip,
 * Slide. Picking one is the primary, discoverable way to reach the four smart
 * trims that D-235 shipped behind a held Alt/Option key and that D-250 could
 * only label once the key was already down — the owner's own report from live
 * use was *"for roll slip etc, instead of alt lets have icons for all of them
 * :) much better."*
 *
 * **What it does NOT do.** It holds no state, knows nothing about the timeline,
 * and performs no edit. It renders [`TRIM_TOOLS`] and reports clicks; the
 * active tool lives in `TimelinePane` (which captures it at pointer-down, with
 * the modifiers) and the rule that turns tool + zone into an `EditOp` is
 * `trimMode.ts`, pure and unit-tested. Adding a tool means adding it to
 * `TRIM_TOOLS` and giving it an icon in [`TRIM_TOOL_ICONS`] — never a new
 * branch in here.
 *
 * **Reference.** Adobe's own Premiere Pro Tools panel, scraped into
 * `scratch/premiere-tools-reference/` for this pass (`premiere-tools-panel
 * .json`, plus Adobe's own labelled screenshot of the real panel) the same way
 * D-239 scraped Resolve's Edit page for the seven edit types. Three things
 * about the shape below are taken from it directly rather than invented:
 *
 *   - **Icon-only buttons, names in the tooltip.** Adobe: "Let the cursor hover
 *     over a tool to see its name and keyboard shortcut." Five labelled buttons
 *     would not fit a toolbar that already carries Split, markers, transitions,
 *     Remove and the zoom control.
 *   - **The active tool is a FILLED button**, every other one a plain ghost —
 *     in Adobe's own screenshot the Selection tool is the one solid blue chip
 *     in an otherwise flat strip.
 *   - **Adobe's shortcuts, unchanged**: V/B/N/Y/U. Handled by `TimelinePane`'s
 *     own `onKeyDown` (this component is presentational), and shown here so the
 *     tooltip teaches them.
 *
 * The one deliberate divergence: Adobe's panel is a vertical strip docked to
 * the timeline's edge, and this is a horizontal group inside the existing
 * toolbar row. That follows this app's own convention — every other timeline
 * action (Split, Close Gap, Link/Unlink, Move to) is already a button in that
 * one row, and Adobe's own page notes the panel can be oriented either way.
 */

import { GalleryHorizontal, MousePointer2, MoveHorizontal, SeparatorVertical, UnfoldHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@chroma/ui';

import { TRIM_TOOLS, type TrimTool } from './trimMode';

/**
 * The glyph for each tool, chosen against the two references' REAL icons —
 * `scratch/premiere-tools-reference/premiere-tools-panel.jpg` (Adobe's own
 * labelled Tools panel) and `scratch/resolve-reference/trim.jpg` (literally the
 * four cursors Resolve swaps between) — not from a guess at what a trim icon
 * looks like. Chroma cannot use either product's artwork, so each is the
 * closest glyph in the icon set this app already uses:
 *
 *   - **Select → `MousePointer2`.** Adobe's Selection tool is an arrow pointer;
 *     so is this. Exact match.
 *   - **Ripple → `UnfoldHorizontal`.** Adobe's Ripple Edit glyph is arrows
 *     pushing outward from a centre bar, which is what a ripple does: trim this
 *     edge, push everything after it along. It is also the exact complement of
 *     `FoldHorizontal`, which this same toolbar already uses for Close Gap (a
 *     ripple inward) — so the pair reads as one idea in two directions.
 *   - **Roll → `SeparatorVertical`.** A single vertical line with a chevron on
 *     each side: the cut in the middle, movable both ways. That is Adobe's
 *     Rolling Edit glyph and Resolve's roll cursor, near enough to identical.
 *   - **Slip → `GalleryHorizontal`.** Two fixed outer rails with a card sliding
 *     between them — Adobe's own `|↔|` slip glyph, and a literal picture of the
 *     edit: the clip's boundaries stay put while what is inside them moves.
 *   - **Slide → `MoveHorizontal`.** A plain horizontal double arrow: the clip
 *     itself travels. Adobe: "a slide edit shifts a clip in time."
 *
 * Keyed by tool so the compiler requires an icon for every member of
 * [`TrimTool`] — a new tool cannot be added without one.
 */
export const TRIM_TOOL_ICONS: Record<TrimTool, LucideIcon> = {
  select: MousePointer2,
  ripple: UnfoldHorizontal,
  roll: SeparatorVertical,
  slip: GalleryHorizontal,
  slide: MoveHorizontal,
};

export interface TrimToolbarProps {
  active: TrimTool;
  onSelect: (tool: TrimTool) => void;
}

/** The palette. `role="group"` with `aria-pressed` per button rather than a
 *  radiogroup: these are toolbar toggle buttons in a real toolbar, which is
 *  what the WAI-ARIA toolbar pattern uses, and it keeps each one reachable by
 *  its own accessible name (which is how the DOM tests drive them). */
export function TrimToolbar({ active, onSelect }: TrimToolbarProps) {
  return (
    <div role="group" aria-label="Trim tool" className="flex items-center gap-0.5" data-chroma-trim-toolbar="">
      {TRIM_TOOLS.map(({ tool, label, shortcut, blurb }) => {
        const Icon = TRIM_TOOL_ICONS[tool];
        const isActive = tool === active;
        return (
          <Tooltip key={tool}>
            <TooltipTrigger
              render={
                <Button
                  // Adobe's own active state: the chosen tool is the one filled
                  // chip in an otherwise flat strip.
                  variant={isActive ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  aria-pressed={isActive}
                  aria-label={`${label} tool (${shortcut})`}
                  data-chroma-trim-tool={tool}
                  onClick={() => onSelect(tool)}
                >
                  <Icon />
                </Button>
              }
            />
            <TooltipContent>
              <span className="font-medium">
                {label} ({shortcut})
              </span>
              <span className="ml-1.5 text-text-secondary">{blurb}</span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
