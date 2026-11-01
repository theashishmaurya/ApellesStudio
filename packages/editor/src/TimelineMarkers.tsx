/**
 * @apelles/editor — timeline markers: the ruler flag strip, the marker editor
 * popover and the jump-to list (D-222, roadmap item 27).
 *
 * **What it is.** The human half of `Timeline.markers` (`timeline.ts`): a
 * dedicated strip immediately under the ruler's ticks carrying one small
 * coloured flag per marker, plus a popover to retitle/recolour/move/delete
 * one, plus a dropdown listing every marker for jumping between them. The
 * `editor_add_marker`/`_list_markers`/`_set_marker`/`_remove_marker` MCP ops
 * (`useEditorControl.ts`) drive the exact same `add_marker`/`set_marker`/
 * `remove_marker` `EditOp`s these controls do — one write path, per CLAUDE.md.
 *
 * **The visual shape is DaVinci Resolve's, taken from its own screenshot**
 * (`scratch/resolve-reference/markers.jpg`, kept from this session's scrape;
 * CLAUDE.md's "research the real pattern first" rule): small coloured flags on
 * their own strip between the timecode ruler and the first track — not inline
 * diamonds drawn on a track, which is Premiere's per-clip marker treatment and
 * would wrongly imply a marker belongs to the clip beneath it. Its dialog's
 * own fields are Time / Duration / Name / Notes / Keyword / a colour swatch
 * row; this popover carries Time, Duration, Name, Comments and the swatches.
 * Keyword remains deliberately out of scope — see D-222.
 *
 * **D-328 — Duration, and what a ranged marker looks like here.** D-222 built
 * the popover without a Duration field and drew every marker as a pin. Both
 * changed: `Marker.duration_frames` is real, the popover's Time and Duration
 * sit side by side as TIMECODE fields (typed, not frame integers — see
 * `parseTimecode`), and a marker that has a span draws as a BAR across the
 * frames it covers with its flag at the left edge, so the duration is visible
 * on the ruler rather than only inside the popover. A point marker is still
 * exactly the pin D-222 drew. Premiere's own marker dialog orders its fields
 * Duration → colour → Name → Comments and its Markers panel shows in/out for
 * ranged markers (`scratch/premiere-index-reference/`); the field SET is that,
 * the look is this repo's own.
 *
 * **D-432 P3 — the FCP / Resolve look and a drag.** The flag is Phosphor's
 * `BookmarkSimple` shield (11 px, fill, a 14 × 14 hit area, centred on the
 * frame) on a 14 px strip; a ranged marker's bar is 4 px at 55 %. A first
 * click selects the flag (a ring) and jumps; a click on the selected flag,
 * Enter, a double-click or a right-click opens the editor; a drag past 3 px
 * moves the marker (B-348), snapping while Snapping (N) is on, committing one
 * `set_marker`. The editor uses a 64 px label column, Name first.
 *
 * **What it does NOT do.** It owns no state that outlives a gesture: every
 * commit goes straight to `useEditorTimelineStore.applyOp`, so a marker edit
 * is persisted and undoable exactly like any other edit. It computes no
 * timeline geometry of its own either — `pxPerSec`/`scrollLeft`/`startLeftPx`
 * come from `TimelinePane`, which is the one place that math lives.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BookmarkSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@apelles/ui';

import { fmtTimecode, parseTimecode } from '@apelles/player';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

import {
  MARKER_COLORS,
  markerEndFrame,
  markersOf,
  normaliseMarkerDuration,
  type EditOp,
  type Marker,
  type Timeline,
} from './timeline';
import { formatTimecode, RULER_HEIGHT_PX } from './ruler';
import { snapFrame } from './editGesture';

/** Height of the marker strip, in px — the gap between the ruler and the lanes'
 *  first row, which the lanes' scroller leaves for it (`TimelineLanes`' `topPx`).
 *  `TimelinePane`'s `RULER_AND_MARGIN_PX` is `RULER_HEIGHT_PX + this`; the two
 *  must move together, so this is the single definition and both sites derive
 *  from it. D-432 P3: 14 (spec §4.7), was 16. */
export const MARKER_STRIP_HEIGHT = 14;

/** D-432 P3 — the flag glyph (Phosphor `BookmarkSimple`, fill) and its hit
 *  area, px (spec §4.7: an 11 px shield, a 14 × 14 target, centred on the
 *  marker's frame). */
const FLAG_ICON_PX = 11;
const FLAG_HIT_PX = 14;
/** A press on a flag that travels this far is a drag, not a click (the same
 *  3 px threshold the clip drag and the track reorder use, spec §5). */
const MARKER_DRAG_THRESHOLD_PX = 3;
/** Snap reach of a dragged marker, px at any zoom (spec §5's 8 px). */
const MARKER_SNAP_PX = 8;
/** A ranged marker's bar (spec §4.7): 4 px tall, its colour at 55 %. */
const MARKER_BAR_PX = 4;

/** Where a marker's frame sits horizontally, in the edit area's own coordinate
 *  space — the same `startLeft + frame/fps*pxPerSec - scrollLeft` the ruler
 *  ticks, the playhead and every other overlay in `TimelinePane` already use.
 *  The flag is centred on this x (D-432 P3), so "which frame is this marker
 *  on" is the shield's point at any zoom. */
export function markerLeftPx(frame: number, fps: number, pxPerSec: number, scrollLeft: number, startLeftPx: number): number {
  return startLeftPx + (frame / fps) * pxPerSec - scrollLeft;
}

/** How wide a ranged marker's bar is, in px (D-328) — the distance between its
 *  own frame and [`markerEndFrame`], in the same space [`markerLeftPx`] works
 *  in, so the bar's right edge lands exactly on the end frame's own x rather
 *  than on a second, nearly-equal derivation of it.
 *
 *  `0` for a point marker, which is what makes "draw a bar at all?" a single
 *  truthiness check at the call site instead of a duplicated
 *  `duration_frames != null` test. */
export function markerSpanWidthPx(marker: Marker, fps: number, pxPerSec: number): number {
  return ((markerEndFrame(marker) - marker.frame) / fps) * pxPerSec;
}

/** D-432 P3 / B-348 — where a marker dragged `dxPx` from its frame lands: the
 *  frame under the pointer (never before 0), snapped to the nearest target
 *  within `MARKER_SNAP_PX` when snapping is on. Pure, so the drag's rule is
 *  unit-tested without a pointer. */
export function draggedMarkerFrame(
  fromFrame: number,
  dxPx: number,
  fps: number,
  pxPerSec: number,
  snapTargets: readonly number[] | null,
): number {
  const raw = Math.max(0, Math.round(fromFrame + (dxPx / pxPerSec) * fps));
  if (!snapTargets || snapTargets.length === 0) return raw;
  const threshold = Math.max(1, Math.round((MARKER_SNAP_PX / pxPerSec) * fps));
  return snapFrame(raw, snapTargets, threshold, null).frame;
}

/** The `set_marker` patch, as the strip and its popover pass one up. Exactly
 *  the `EditOp`'s own `patch` shape (D-328 added `duration_frames`) — named
 *  rather than repeated inline at the three prop sites that take it, so a
 *  future field is added in one place and the compiler finds the rest. */
export type MarkerPatch = Extract<EditOp, { kind: 'set_marker' }>['patch'];

export interface MarkerStripProps {
  timeline: Timeline;
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  startLeftPx: number;
  /** Jump the playhead to a marker's frame (the store's own `setPlayhead`). */
  onJump: (frame: number) => void;
  /** Commit a `set_marker` patch (the store's own `applyOp`). */
  onPatch: (id: string, patch: MarkerPatch) => void;
  /** Commit a `remove_marker`. */
  onRemove: (id: string) => void;
  /** B-339 — the marker whose editor is open (controlled: the Add Marker
   *  button, the M shortcuts and `editor_add_marker` open it right after
   *  creating the marker, which a strip-local state could not be told). */
  editingId: string | null;
  onEditingIdChange: (id: string | null) => void;
  /** D-432 P3 — what a dragged marker snaps to (clip edges, the playhead, the
   *  other markers), read at the press; `null` while Snapping (N) is off. */
  snapTargets?: (movingId: string) => number[] | null;
}

/**
 * The flag strip itself (D-222; D-432 P3 restyled it and made a flag
 * draggable). A click selects a flag (a 1 px ring) and jumps the playhead to
 * it; a click on the selected flag, a double-click, Enter or a right-click
 * opens its editor; a drag past 3 px moves the marker (one `set_marker` on
 * release, snapping to clip edges / the playhead / the other markers while
 * Snapping is on; Esc cancels).
 *
 * **Why the first click does not open the editor**: this is Resolve's own
 * split (single click positions, double-click opens the Markers dialog), and
 * it is the right one here — a marker's first job is to be a place you jump
 * to while reviewing, and popping a form open on every such jump would make
 * the common gesture the expensive one. Adding a marker does open it (B-339).
 *
 * **Gesture coexistence** (the same question D-137's marquee and D-207's fade
 * handles each had to answer): the strip carries `data-chroma-no-marquee`, the
 * escape hatch `marquee.ts`'s own `MARQUEE_BLOCKING_SELECTOR` already
 * documents for exactly this, and a flag stops its own press. Everything but
 * the flags themselves is `pointer-events-none`, so a press on the empty
 * parts of the strip still falls through to the library underneath.
 *
 * **A drag renders nothing**: each move writes a `transform` on the flag and
 * its bar; the release commits once, and the transforms are dropped in a
 * layout effect on the render that carries the new frame, before paint.
 */
export function MarkerStrip({
  timeline,
  fps,
  pxPerSec,
  scrollLeft,
  startLeftPx,
  onJump,
  onPatch,
  onRemove,
  editingId,
  onEditingIdChange: setEditingId,
  snapTargets,
}: MarkerStripProps) {
  const markers = useMemo(() => markersOf(timeline), [timeline]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Removes the current press's window listeners (one press at a time). */
  const detachRef = useRef<(() => void) | null>(null);
  /** The flag whose drag just ended: its trailing `click` is not a click. */
  const suppressClickRef = useRef<string | null>(null);
  /** Elements whose drag transform must drop on the render that moves them. */
  const pendingResetRef = useRef<HTMLElement[]>([]);

  // A marker deleted (by the popover's own Delete, by an undo, or by an MCP
  // call) while its editor is open must close it rather than leave a popover
  // anchored to nothing.
  const editing = markers.find((m) => m.id === editingId) ?? null;
  useEffect(() => {
    if (editingId !== null && !editing) setEditingId(null);
  }, [editingId, editing]);

  // The render that carries a dragged marker's new frame: its flag is now
  // laid out there, so the drag's transform comes off before paint.
  useLayoutEffect(() => {
    for (const el of pendingResetRef.current) el.style.transform = '';
    pendingResetRef.current = [];
  }, [markers]);

  const onFlagPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, m: Marker) => {
    // The strip sits over the library's own ruler/edit area and inside
    // `TimelinePane`'s edit-area container, both of which have their own
    // press handlers (set the playhead / clear the selection). A press on a
    // flag is this control's, so it stops here.
    e.stopPropagation();
    if (e.button !== 0) return;
    detachRef.current?.();
    const span = e.currentTarget.parentElement?.querySelector<HTMLElement>(
      `[data-chroma-marker-span="${m.id.replace(/["\\]/g, '\\$&')}"]`,
    );
    const els = span ? [e.currentTarget, span] : [e.currentTarget];
    const targets = snapTargets ? snapTargets(m.id) : null;
    const originX = e.clientX;
    const pointerId = e.pointerId;
    let dragging = false;
    let frame = m.frame;
    const end = (commit: boolean) => {
      detach();
      if (!dragging) return;
      suppressClickRef.current = m.id;
      if (commit && frame !== m.frame) {
        pendingResetRef.current = els;
        onPatch(m.id, { frame });
      } else {
        for (const el of els) el.style.transform = '';
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - originX;
      if (!dragging && Math.abs(dx) < MARKER_DRAG_THRESHOLD_PX) return;
      dragging = true;
      frame = draggedMarkerFrame(m.frame, dx, fps, pxPerSec, targets);
      const offset = ((frame - m.frame) / fps) * pxPerSec;
      for (const el of els) el.style.transform = `translate3d(${offset}px, 0, 0)`;
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) end(true);
    };
    const onCancel = () => end(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragging) return;
      ev.stopPropagation();
      end(false);
    };
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      detachRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    detachRef.current = detach;
  };

  // An unmount mid-drag must not leave window listeners behind.
  useEffect(() => () => detachRef.current?.(), []);

  return (
    <div
      data-chroma-marker-strip
      data-chroma-no-marquee
      className="pointer-events-none absolute left-0 right-0 z-(--z-timeline-markers) overflow-hidden bg-timeline-bg"
      style={{ top: RULER_HEIGHT_PX, height: MARKER_STRIP_HEIGHT }}
    >
      {/* D-328 / D-432 P3 — the span bars, drawn BEFORE the flags so a flag
          always sits on top of its own bar. A 4 px bar in the marker's colour
          at 55 % with a 2 px solid end, radius 2. `pointer-events-none`: the
          flag stays the one hit target for the marker. */}
      {markers.map((m) => {
        const width = markerSpanWidthPx(m, fps, pxPerSec);
        if (width <= 0) return null;
        return (
          <div
            key={`${m.id}-span`}
            data-chroma-marker-span={m.id}
            aria-hidden
            className="pointer-events-none absolute bottom-0.5 rounded-xs"
            style={{
              left: markerLeftPx(m.frame, fps, pxPerSec, scrollLeft, startLeftPx),
              width,
              height: MARKER_BAR_PX,
              // `color-mix` keeps this derived from the one stored colour
              // instead of a second palette of washed-out variants (CLAUDE.md's
              // one-token-source reasoning applied to document content, D-222).
              background: `color-mix(in srgb, ${m.color} 55%, transparent)`,
              borderRight: `2px solid ${m.color}`,
            }}
          />
        );
      })}

      {markers.map((m) => {
        const selected = selectedId === m.id;
        return (
          <button
            key={m.id}
            type="button"
            data-chroma-marker={m.id}
            data-chroma-marker-selected={selected ? '' : undefined}
            data-testid={TIMELINE_TEST_IDS.marker}
            // D-328 — a ranged marker says so in both labels: its span is the
            // thing a user most needs confirmed without opening the popover.
            aria-label={`Marker ${m.name ?? ''} at ${formatTimecode(m.frame / fps, fps, 0)}${
              m.duration_frames ? ` lasting ${formatTimecode(m.duration_frames / fps, fps, 0)}` : ''
            }`.replace(/\s+/g, ' ')}
            aria-pressed={selected}
            title={`${m.name ? `${m.name} — ` : ''}${formatTimecode(m.frame / fps, fps, 0)}${
              m.duration_frames
                ? ` → ${formatTimecode(markerEndFrame(m) / fps, fps, 0)} (${formatTimecode(m.duration_frames / fps, fps, 0)})`
                : ''
            }\nClick to jump · click again or double-click to edit · drag to move`}
            className={
              'pointer-events-auto absolute top-0 flex cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ' +
              (selected ? 'ring-1 ring-text-primary' : '')
            }
            style={{
              left: markerLeftPx(m.frame, fps, pxPerSec, scrollLeft, startLeftPx),
              marginLeft: -FLAG_HIT_PX / 2,
              width: FLAG_HIT_PX,
              height: MARKER_STRIP_HEIGHT,
              color: m.color,
            }}
            onPointerDown={(e) => onFlagPointerDown(e, m)}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClickRef.current === m.id) {
                suppressClickRef.current = null;
                return;
              }
              if (selected) {
                setEditingId(m.id);
                return;
              }
              setSelectedId(m.id);
              onJump(m.frame);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              e.stopPropagation();
              setSelectedId(m.id);
              setEditingId(m.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingId(m.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setEditingId(m.id);
            }}
          >
            {/* The shield: Phosphor's own glyph in the marker's colour, with a
                thin dark stroke under the fill so a light colour stays visible
                on the strip. */}
            <BookmarkSimpleIcon
              weight="fill"
              size={FLAG_ICON_PX}
              aria-hidden
              className="pointer-events-none stroke-black/40 [paint-order:stroke] [stroke-width:24px]"
            />
          </button>
        );
      })}

      {/* One popover for whichever marker is being edited, anchored to an
          invisible element at that marker's own x. A single instance rather
          than one per flag: only one can be open at a time, and N mounted
          popovers would be N portals for a purely transient surface. The
          anchor is `pointer-events-none` so it is a position, not a second hit
          target competing with the flag it sits on. */}
      {editing && (
        <Popover
          open
          onOpenChange={(next) => {
            if (!next) setEditingId(null);
          }}
        >
          <PopoverTrigger
            // `nativeButton={false}` because this is not a button: it is a
            // position for the popover to grow from, never pressed (the flag
            // above owns the press). Base UI warns if a trigger rendering a
            // non-`<button>` still claims native button semantics.
            nativeButton={false}
            render={
              <span
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none absolute top-0 block w-0"
                style={{ left: markerLeftPx(editing.frame, fps, pxPerSec, scrollLeft, startLeftPx), height: MARKER_STRIP_HEIGHT }}
              />
            }
          />
          <PopoverContent
            className="w-70 rounded-md border-border-color bg-surface-raised p-3 text-text-primary shadow-popover"
            align="center"
            data-chroma-marker-editor
            data-testid={TIMELINE_TEST_IDS.markerEditor}
          >
            <MarkerEditor
              marker={editing}
              fps={fps}
              onPatch={(patch) => onPatch(editing.id, patch)}
              onRemove={() => {
                onRemove(editing.id);
                setEditingId(null);
              }}
              onDone={() => setEditingId(null)}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

interface MarkerEditorProps {
  marker: Marker;
  fps: number;
  onPatch: (patch: MarkerPatch) => void;
  onRemove: () => void;
  onDone: () => void;
}

/**
 * The marker editor (spec §4.7, D-432 P3 layout; fields D-222 / D-328): a
 * 64 px label column, Name (focused on open, B-339), Time and Duration as
 * timecode (one row each), the colour swatches, Notes; Remove Marker on the left,
 * Done on the right. Enter on Name commits and closes; Esc closes. Same fields
 * as Resolve's dialog minus Keyword; they map 1:1 onto `editor_set_marker`.
 */
function MarkerEditor({ marker, fps, onPatch, onRemove, onDone }: MarkerEditorProps) {
  const [name, setName] = useState(marker.name ?? '');
  const [note, setNote] = useState(marker.note ?? '');
  // D-328 — Time and Duration are TIMECODE text, not frame integers: every
  // NLE's marker dialog uses timecode here. `parseTimecode` still accepts a
  // bare frame count, so nothing the old numeric field took stopped working.
  const [timeText, setTimeText] = useState(fmtTimecode(marker.frame, fps));
  const [durationText, setDurationText] = useState(
    marker.duration_frames ? fmtTimecode(marker.duration_frames, fps) : '',
  );

  // Re-seed whenever the stored marker changes underneath (an undo, an MCP
  // write, a swatch click's own round trip, a drag) so the fields can never
  // show a stale draft — `CaptionInspectorPanel`'s own draft convention.
  useEffect(() => {
    setName(marker.name ?? '');
    setNote(marker.note ?? '');
    setTimeText(fmtTimecode(marker.frame, fps));
    setDurationText(marker.duration_frames ? fmtTimecode(marker.duration_frames, fps) : '');
  }, [marker.id, marker.frame, marker.duration_frames, marker.name, marker.note, fps]);

  const commit = () => {
    const patch: MarkerPatch = {
      name: name.trim() ? name : null,
      note: note.trim() ? note : null,
    };

    // An unreadable timecode leaves the field alone rather than moving the
    // marker somewhere arbitrary — `parseTimecode` returns null for exactly
    // that case, and the re-seed effect above then puts the real value back.
    const frame = parseTimecode(timeText, fps);
    if (frame !== null && frame !== marker.frame) patch.frame = frame;

    // An EMPTY duration field is a real instruction ("make this a point
    // marker"), which is why it is handled separately from an unparseable one:
    // `null` clears, a bad string is ignored.
    const trimmedDuration = durationText.trim();
    if (!trimmedDuration) {
      if (marker.duration_frames !== undefined) patch.duration_frames = null;
    } else {
      const parsed = parseTimecode(trimmedDuration, fps);
      if (parsed !== null) {
        const next = normaliseMarkerDuration(parsed) ?? null;
        if (next !== (marker.duration_frames ?? null)) patch.duration_frames = next;
      }
    }

    onPatch(patch);
  };

  const label = 'text-xs text-text-secondary';
  const row = 'grid grid-cols-[64px_1fr] items-center gap-2';

  return (
    <div className="flex flex-col gap-2.5 text-xs">
      <label className={row}>
        <span className={label}>Name</span>
        <Input
          className="h-7"
          data-chroma-marker-name
          // B-339 — the editor opens to be typed into.
          autoFocus
          placeholder="Marker"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            commit();
            onDone();
          }}
        />
      </label>

      {/* Time and Duration on their own rows: two full timecodes do not fit
          side by side in a 280 px popover without clipping (the spec's
          side-by-side layout, checked on screen). */}
      <label className={row}>
        <span className={label}>Time</span>
        <Input
          className="h-7 text-right font-mono tabular-nums"
          data-chroma-marker-time
          aria-label="Marker time"
          value={timeText}
          onChange={(e) => setTimeText(e.target.value)}
          onBlur={commit}
        />
      </label>
      <label className={row}>
        <span className={label}>Duration</span>
        <Input
          className="h-7 text-right font-mono tabular-nums"
          data-chroma-marker-duration
          aria-label="Marker duration"
          title="Empty for a point marker"
          // An empty field IS the point-marker state, so the placeholder
          // shows what empty means rather than an example value.
          placeholder="00:00:00:00"
          value={durationText}
          onChange={(e) => setDurationText(e.target.value)}
          onBlur={commit}
        />
      </label>
      {marker.duration_frames ? (
        <div className={row}>
          <span />
          <span className="text-2xs tabular-nums text-text-tertiary" data-chroma-marker-endtime>
            ends {fmtTimecode(markerEndFrame(marker), fps)}
          </span>
        </div>
      ) : null}

      <div className={row}>
        <span className={label}>Colour</span>
        <div className="flex flex-wrap gap-1.5">
          {MARKER_COLORS.map((c) => {
            const on = c.hex.toUpperCase() === marker.color.toUpperCase();
            return (
              <button
                key={c.name}
                type="button"
                aria-label={c.name}
                aria-pressed={on}
                title={c.name}
                className={
                  'size-3.5 rounded-xs outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ' +
                  (on ? 'ring-2 ring-text-primary ring-offset-1 ring-offset-surface-raised' : '')
                }
                style={{ background: c.hex }}
                onClick={() => onPatch({ color: c.hex })}
              />
            );
          })}
        </div>
      </div>

      <label className="grid grid-cols-[64px_1fr] items-start gap-2">
        <span className={label + ' pt-1.5'}>Notes</span>
        <Textarea
          className="min-h-16 max-h-32 text-xs"
          rows={3}
          data-chroma-marker-note
          placeholder="Anything worth remembering here"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
        />
      </label>

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="ghost" size="xs" className="h-6 px-2 text-xs text-destructive hover:text-destructive" onClick={onRemove}>
          <TrashIcon className="size-3" />
          Remove Marker
        </Button>
        <Button
          size="xs"
          className="h-6 px-3 text-xs"
          onClick={() => {
            commit();
            onDone();
          }}
        >
          Done
        </Button>
      </div>
    </div>
  );
}

export interface AddMarkerButtonProps {
  /** Called on click; the pane adds the marker AND opens its editor (B-339). */
  onAdd: () => void;
  /** Shown in the tooltip so the `M` shortcut is discoverable from the button. */
  shortcut: string;
}

/** The toolbar's "add a marker at the playhead" action. Not
 *  selection-dependent — like Title and Export beside it, and unlike
 *  Split/Remove: you add a marker to the timeline, not to a clip. */
export function AddMarkerButton({ onAdd, shortcut }: AddMarkerButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" onClick={() => onAdd()} data-testid={TIMELINE_TEST_IDS.addMarker} aria-label="Add marker">
            <BookmarkSimpleIcon />
          </Button>
        }
      />
      <TooltipContent>
        <span className="font-medium">Marker ({shortcut})</span>
        <span className="ml-1.5 text-text-secondary">
          Add a marker at the playhead and edit it (M adds; Alt+M adds and edits) — click a flag to jump to it, click it again to edit it, drag it
          to move it
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
