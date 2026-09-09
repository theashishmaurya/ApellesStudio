/**
 * @apelles/editor — the timeline's `@dnd-kit` payload contract (B-122).
 *
 * **What it is.** The named types for every drag source and drop target that
 * shares `TimelinePane`'s one `DndContext`, and the four narrowing functions
 * that turn an untyped `active.data.current` / `over.data.current` into
 * something safe to use.
 *
 * **Why it exists — the bug it is the fix for.** `dnd-kit` types `data.current`
 * as `Record<string, unknown> | undefined`, so every reader has to assert a
 * shape. `TimelinePane` did that inline, six times, each site asserting the
 * shape it happened to want:
 *
 * ```ts
 * const overData = event.over?.data.current as { type: 'track'; track: number } | undefined;
 * if (!overData || overData.type !== 'track') { ... }
 * const toTrack = overData.track;            // trusted, never checked
 * ```
 *
 * Two DIFFERENT droppables answered to `type: 'track'` — the sortable track
 * HEADER (`{ type, index }`, in the left column) and the track LANE
 * (`{ type, track }`, the row itself) — because every `useSortable` item is a
 * droppable too. So dropping a clip on a header passed the discriminator check
 * and produced `toTrack === undefined`, `tracks[undefined] === undefined`, and
 * an unhandled `TypeError: undefined is not an object (evaluating 'dest.clips')`
 * inside `resolveClipLanding` that took the render tree and the dev server with
 * it. A `as` cast is a promise, not a check; six independent promises about one
 * shared namespace is how they end up contradicting each other.
 *
 * **What these functions do that a cast cannot.** They validate at runtime —
 * the discriminator AND the field it implies AND, where a track index is
 * involved, that the index names a track that actually exists. So a caller
 * cannot receive an index it then has to remember to bounds-check; there is no
 * "valid shape, impossible value" state to forget about.
 *
 * **What it does NOT do.** No DOM, no React, no store — it takes the values
 * dnd-kit hands over and answers questions about them. Where a drop should
 * LAND (an insertion boundary, a snapped frame) is `TimelinePane`'s own
 * geometry and stays there. The transitions palette's `TransitionDragData`
 * (D-226) deliberately lives with that feature in `TimelineTransitions.tsx`;
 * this module holds the two that were confusable with each other.
 */

/** The sortable track header in the left column — the track-REORDER drag
 *  source, and (because every sortable is also a droppable) the drop target a
 *  reorder resolves against. `index` is its position in `Timeline.tracks`. */
export interface TrackHeaderDragData {
  type: 'track-header';
  index: number;
}

/** A clip body being dragged (D-098/D-100) — the move/slip/slide gesture. */
export interface ClipDragData {
  type: 'clip';
  track: number;
  clipId: string;
}

/** A track's full-width row in the edit area: the drop target that answers
 *  "which track is the pointer over" for a clip or transition drag. Purely a
 *  hit-testing target — it paints nothing (D-113). */
export interface TrackLaneDropData {
  type: 'track-lane';
  track: number;
}

/** dnd-kit's own type for a `data.current`. Untyped by construction, which is
 *  the whole reason the functions below exist. */
type Payload = Record<string, unknown> | undefined | null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A real, existing track index — not merely a number. */
function isTrackIndex(v: unknown, trackCount: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < trackCount;
}

/** The dragged clip, or `null` if this drag is not a clip drag. */
export function asClipDrag(active: Payload): ClipDragData | null {
  if (!isRecord(active) || active.type !== 'clip') return null;
  if (typeof active.track !== 'number' || typeof active.clipId !== 'string') return null;
  return { type: 'clip', track: active.track, clipId: active.clipId };
}

/** The dragged track header, or `null` if this drag is not a track reorder. */
export function asTrackHeaderDrag(active: Payload): TrackHeaderDragData | null {
  if (!isRecord(active) || active.type !== 'track-header') return null;
  if (typeof active.index !== 'number') return null;
  return { type: 'track-header', index: active.index };
}

/**
 * The destination TRACK INDEX for a drop over a track lane, or `null`.
 *
 * `null` covers every non-landing in one answer, which is the point: not over
 * anything, over a track HEADER rather than a lane (the B-122 crash), over a
 * lane whose payload is malformed, or over a lane naming a track that no
 * longer exists (a track removed mid-drag by an undo or an MCP call — dnd-kit
 * caches droppable data for the duration of a gesture, so this is reachable
 * without any bug at all). Callers treat `null` as "resolve this some other
 * way, or cancel" and can never index `tracks` with it.
 */
export function laneDropTrack(over: Payload, trackCount: number): number | null {
  if (!isRecord(over) || over.type !== 'track-lane') return null;
  return isTrackIndex(over.track, trackCount) ? over.track : null;
}

/**
 * The destination index for a drop over a track header (a reorder), or `null`
 * — the mirror of [`laneDropTrack`], and the reason both are needed: these two
 * questions look identical at the call site and have different right answers.
 */
export function headerDropIndex(over: Payload, trackCount: number): number | null {
  if (!isRecord(over) || over.type !== 'track-header') return null;
  return isTrackIndex(over.index, trackCount) ? over.index : null;
}
