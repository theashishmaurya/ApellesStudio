/**
 * @apelles/editor — the seven edit types (D-239, roadmap item 27).
 *
 * **What it is.** The names, order, and human copy of the seven ways a source
 * clip can be edited into the timeline — Insert, Overwrite, Replace, Fit to
 * Fill, Place on Top, Append at End, Ripple Overwrite — plus the pure geometry
 * that turns a pointer position over the preview's edit overlay into one of
 * them. Both interfaces read this one list: the GUI's `EditOverlay` renders it
 * top-to-bottom, and `editor_edit_in` (MCP) validates its `editType` against
 * [`DROP_EDIT_TYPES`].
 *
 * **What it does NOT do.** No timeline arithmetic and no store access — it
 * deliberately imports nothing from `timeline.ts`, which is what lets
 * `timeline.ts` import [`DropEditType`] from here without a cycle. The actual
 * semantics live in ONE place, the `edit_in` `EditOp` in `timeline.ts`, next to
 * every other op's reducer and to `checkEditIn`, its shared precondition check
 * (the same `checkTransition`/`checkLink` pattern this file's neighbours
 * already use).
 *
 * **Reference.** The seven names, their order, and every semantic below are
 * Blackmagic's own, quoted from DaVinci Resolve's Edit-page copy scraped into
 * `scratch/resolve-reference/` (the `edit-timeline` and `edit-seven-ways`
 * sections, and the `timeline.jpg` screenshot of the real edit overlay the
 * roadmap item itself names) — not a guess at "how NLEs generally work". See
 * D-239.
 */

/** The seven edit types, as the `edit_in` `EditOp` and `editor_edit_in` both
 *  spell them. Snake-cased for the wire; [`DROP_EDIT_TYPES`] carries the
 *  display copy. */
export type DropEditType =
  | 'insert'
  | 'overwrite'
  | 'replace'
  | 'fit_to_fill'
  | 'place_on_top'
  | 'append'
  | 'ripple_overwrite';

/** One row of the edit overlay. `blurb` is Blackmagic's own description,
 *  condensed to one line — it is what the overlay shows under the pointer and
 *  what the MCP tool's own docstring repeats, so the human and the agent are
 *  reading the same definition. */
export interface DropEditTypeInfo {
  type: DropEditType;
  label: string;
  blurb: string;
  /** Whether this type needs a clip already on the destination track under
   *  `atFrame` to act on. The overlay greys the row out when there isn't one,
   *  rather than letting the drop silently no-op. */
  needsTarget: boolean;
}

/** In the exact order Resolve's own edit overlay lists them
 *  (`scratch/resolve-reference/timeline.jpg`), which is also the order the
 *  `edit-seven-ways` copy introduces them in. The order is load-bearing: the
 *  overlay resolves a drop by which BAND of its own height the pointer is in,
 *  so re-ordering this array re-orders the targets. */
export const DROP_EDIT_TYPES: readonly DropEditTypeInfo[] = [
  {
    type: 'insert',
    label: 'Insert',
    blurb: 'Splits whatever is under the playhead and pushes everything after it down to make room.',
    needsTarget: false,
  },
  {
    type: 'overwrite',
    label: 'Overwrite',
    blurb: 'Writes over whatever is at the playhead for the new clip’s length. Nothing else moves.',
    needsTarget: false,
  },
  {
    type: 'replace',
    label: 'Replace',
    blurb: 'Swaps the clip at the playhead for this source, kept to the exact same length.',
    needsTarget: true,
  },
  {
    type: 'fit_to_fill',
    label: 'Fit to Fill',
    blurb: 'Like Replace, but speeds the source up or slows it down to fill the slot exactly.',
    needsTarget: true,
  },
  {
    type: 'place_on_top',
    label: 'Place on Top',
    blurb: 'Puts the clip on the next video track above, at the playhead — titles, graphics, PIP.',
    needsTarget: false,
  },
  {
    type: 'append',
    label: 'Append at End',
    blurb: 'Places the clip after the last edit on the track, wherever the playhead is.',
    needsTarget: false,
  },
  {
    type: 'ripple_overwrite',
    label: 'Ripple Overwrite',
    blurb: 'Replaces the clip at the playhead even at a different length, rippling the difference.',
    needsTarget: true,
  },
] as const;

/** `true` for one of the seven, so an MCP payload can be validated without a
 *  cast. */
export function isDropEditType(v: unknown): v is DropEditType {
  return typeof v === 'string' && DROP_EDIT_TYPES.some((t) => t.type === v);
}

/** Total by construction — `DropEditType` is exactly the union of the seven
 *  `type` fields above — so this cannot miss for a typed caller, and
 *  `isDropEditType` guards every untyped one. */
export function dropEditTypeInfo(type: DropEditType): DropEditTypeInfo {
  const found = DROP_EDIT_TYPES.find((t) => t.type === type);
  if (!found) throw new Error(`unknown edit type: ${type}`);
  return found;
}

/** Which overlay row a pointer at `clientY` is over, given the overlay list's
 *  own bounding rect — the whole hit-test, kept pure so it is unit-testable
 *  without a DOM drag.
 *
 *  Bands are equal fractions of `rect.height`, so the list needs no per-row
 *  measurement and a row's own padding cannot open a dead gap between two
 *  targets. Outside the rect vertically clamps to the nearest end rather than
 *  returning `null`: a drag that leaves the strip by two pixels still means
 *  the row it left from, which is how a target list of this size stays usable
 *  with a dragged thumbnail under the cursor. */
export function editTargetIndexAt(rect: { top: number; height: number }, clientY: number): number {
  if (!(rect.height > 0)) return 0;
  const band = rect.height / DROP_EDIT_TYPES.length;
  const raw = Math.floor((clientY - rect.top) / band);
  return Math.min(DROP_EDIT_TYPES.length - 1, Math.max(0, raw));
}
