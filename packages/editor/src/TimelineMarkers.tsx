/**
 * @chroma/editor — timeline markers: the ruler flag strip, the marker editor
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
 * row; this popover carries Time, Name, Notes and the swatches. Duration
 * (range markers) and Keyword are deliberately out of scope — see D-222.
 *
 * **What it does NOT do.** It owns no state that outlives a gesture: every
 * commit goes straight to `useEditorTimelineStore.applyOp`, so a marker edit
 * is persisted and undoable exactly like any other edit. It computes no
 * timeline geometry of its own either — `pxPerSec`/`scrollLeft`/`startLeftPx`
 * come from `TimelinePane`, which is the one place that math lives.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Flag, Trash2 } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@chroma/ui';

import { MARKER_COLORS, markersOf, type Marker, type Timeline } from './timeline';
import { formatTimecode, RULER_HEIGHT_PX } from './ruler';

/** Height of the marker strip, in px — and, because the strip lives in the
 *  gap the timeline library leaves between its 32px ruler and its edit area,
 *  also the `margin-top` `timeline-overrides.css` gives
 *  `.timeline-editor-edit-area` (the library's own default is 10px, which is
 *  too short for a legible flag). `TimelinePane`'s `RULER_AND_MARGIN_PX` is
 *  `32 + this`; the two must move together, so this is the single definition
 *  and both sites derive from it. */
export const MARKER_STRIP_HEIGHT = 16;

/** Flag glyph size. Narrow enough that two markers a second apart at the
 *  default zoom still read as two, tall enough to fill the strip. */
const FLAG_WIDTH = 9;

/** Resolve's own marker glyph — a pennant/shield: square shoulders, a notched
 *  point at the bottom. Drawn with `clip-path` rather than an SVG per flag so
 *  a timeline with a hundred markers paints a hundred plain divs. */
const FLAG_CLIP_PATH = 'polygon(0 0, 100% 0, 100% 62%, 50% 100%, 0 62%)';

/** Where a marker's flag sits horizontally, in the edit area's own coordinate
 *  space — the same `startLeft + frame/fps*pxPerSec - scrollLeft` the ruler
 *  ticks, the playhead and every other overlay in `TimelinePane` already use.
 *  The flag's LEFT edge is the frame (like the playhead's own line), not its
 *  centre, so "which frame is this marker on" is unambiguous at any zoom. */
export function markerLeftPx(frame: number, fps: number, pxPerSec: number, scrollLeft: number, startLeftPx: number): number {
  return startLeftPx + (frame / fps) * pxPerSec - scrollLeft;
}

export interface MarkerStripProps {
  timeline: Timeline;
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  startLeftPx: number;
  /** Jump the playhead to a marker's frame (the store's own `setPlayhead`). */
  onJump: (frame: number) => void;
  /** Commit a `set_marker` patch (the store's own `applyOp`). */
  onPatch: (id: string, patch: { frame?: number; color?: string; name?: string | null; note?: string | null }) => void;
  /** Commit a `remove_marker`. */
  onRemove: (id: string) => void;
}

/**
 * The flag strip itself. Click a flag to jump the playhead there; double-click
 * or right-click one to open its editor.
 *
 * **Why click ≠ open**, unlike most small controls: this is Resolve's own
 * split (single click positions, double-click opens the Markers dialog), and
 * it is the right one here — a marker's first job is to be a place you jump
 * to while reviewing, and popping a form open on every such jump would make
 * the common gesture the expensive one.
 *
 * **Gesture coexistence** (the same question D-137's marquee and D-207's fade
 * handles each had to answer): the strip carries `data-chroma-no-marquee`, the
 * escape hatch `marquee.ts`'s own `MARQUEE_BLOCKING_SELECTOR` already
 * documents for exactly this — "anything later rendered into the edit area
 * that owns its own press" — so no marquee can start from a press on a flag,
 * with no change to that module. Everything but the flags themselves is
 * `pointer-events-none`, so a press on the empty parts of the strip still
 * falls through to the library underneath.
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
}: MarkerStripProps) {
  const markers = useMemo(() => markersOf(timeline), [timeline]);
  const [editingId, setEditingId] = useState<string | null>(null);

  // A marker deleted (by the popover's own Delete, by an undo, or by an MCP
  // call) while its editor is open must close it rather than leave a popover
  // anchored to nothing.
  const editing = markers.find((m) => m.id === editingId) ?? null;
  useEffect(() => {
    if (editingId !== null && !editing) setEditingId(null);
  }, [editingId, editing]);

  return (
    <div
      data-chroma-marker-strip
      data-chroma-no-marquee
      className="pointer-events-none absolute left-0 right-0 z-40 overflow-hidden"
      style={{ top: RULER_HEIGHT_PX, height: MARKER_STRIP_HEIGHT }}
    >
      {markers.map((m) => (
        <button
          key={m.id}
          type="button"
          data-chroma-marker={m.id}
          aria-label={`Marker ${m.name ?? ''} at ${formatTimecode(m.frame / fps, fps, 0)}`.replace(/\s+/g, ' ')}
          title={`${m.name ? `${m.name} — ` : ''}${formatTimecode(m.frame / fps, fps, 0)}\nClick to jump · double-click to edit`}
          className="pointer-events-auto absolute top-0.5 cursor-pointer border-0 p-0 outline-none focus-visible:ring-1 focus-visible:ring-accent"
          style={{
            left: markerLeftPx(m.frame, fps, pxPerSec, scrollLeft, startLeftPx),
            width: FLAG_WIDTH,
            height: MARKER_STRIP_HEIGHT - 4,
            background: m.color,
            clipPath: FLAG_CLIP_PATH,
          }}
          // The strip sits over the library's own ruler/edit area and inside
          // `TimelinePane`'s edit-area container, both of which have their own
          // click handlers (set the playhead / clear the selection). A press on
          // a flag is this control's, so it stops there — the same
          // distinct-hit-target discipline every other gesture on this surface
          // uses.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onJump(m.frame);
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
        />
      ))}

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
                className="pointer-events-none absolute top-0 block h-4 w-0"
                style={{ left: markerLeftPx(editing.frame, fps, pxPerSec, scrollLeft, startLeftPx) }}
              />
            }
          />
          <PopoverContent
            className="w-72 bg-surface border-border-color text-text-primary"
            align="start"
            data-chroma-marker-editor
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
  onPatch: (patch: { frame?: number; color?: string; name?: string | null; note?: string | null }) => void;
  onRemove: () => void;
  onDone: () => void;
}

/**
 * The marker's own form — Resolve's Markers dialog, minus the fields D-222
 * scoped out (Duration, Keyword).
 *
 * Name/Notes are **local until Done/blur**, the colour swatches commit on
 * click. That split is the same one D-207's fade handles make and for the same
 * reason: `applyOp` snapshots the whole timeline onto the undo stack per call,
 * so committing per keystroke would be one undo entry per character, while a
 * swatch click is already a single discrete decision.
 */
function MarkerEditor({ marker, fps, onPatch, onRemove, onDone }: MarkerEditorProps) {
  const [name, setName] = useState(marker.name ?? '');
  const [note, setNote] = useState(marker.note ?? '');
  const [frameText, setFrameText] = useState(String(marker.frame));

  const commit = () => {
    const frame = Math.round(Number(frameText));
    onPatch({
      name: name.trim() ? name : null,
      note: note.trim() ? note : null,
      ...(Number.isFinite(frame) && frame !== marker.frame ? { frame } : {}),
    });
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">Marker</span>
        <span className="tabular-nums text-text-secondary">{formatTimecode(marker.frame / fps, fps, 0)}</span>
      </div>

      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-text-secondary">Frame</span>
        <Input
          type="number"
          min={0}
          className="h-7 text-right"
          value={frameText}
          onChange={(e) => setFrameText(e.target.value)}
          onBlur={commit}
        />
      </label>

      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-text-secondary">Name</span>
        <Input
          className="h-7"
          placeholder="e.g. cut here"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-text-secondary">Notes</span>
        <Textarea
          className="min-h-14 text-xs"
          placeholder="Anything worth remembering about this frame"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
        />
      </label>

      <div className="flex flex-wrap gap-1">
        {MARKER_COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            aria-label={c.name}
            title={c.name}
            className="relative size-4 rounded-sm border border-border-color/60 outline-none focus-visible:ring-1 focus-visible:ring-accent"
            style={{ background: c.hex }}
            onClick={() => onPatch({ color: c.hex })}
          >
            {c.hex.toUpperCase() === marker.color.toUpperCase() && (
              <Check className="absolute inset-0 m-auto size-3 text-black/70" />
            )}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="ghost" size="xs" className="h-6 px-2 text-[11px] text-red-400" onClick={onRemove}>
          <Trash2 className="size-3" />
          Delete
        </Button>
        <Button
          size="xs"
          className="h-6 px-3 text-[11px]"
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

export interface MarkerListMenuProps {
  timeline: Timeline | null;
  fps: number;
  onJump: (frame: number) => void;
  /** B-114 — commit a `remove_marker` for the row's own trash button. The
   *  same `onRemove` the strip's popover takes, so both delete affordances
   *  drive one `EditOp`. */
  onRemove: (id: string) => void;
}

/**
 * The toolbar's marker list — Resolve's own marker list alongside the ruler
 * strip, as a `DropdownMenu` rather than a permanent panel: at this feature's
 * size a docked panel would cost real timeline height to show a handful of
 * one-line rows, and every other list-of-things action in this toolbar
 * ("Move to ▾") is already a dropdown.
 *
 * Rendered by `TimelinePane` only when there is at least one marker — an
 * always-present, almost-always-empty menu is noise, the same call D-128's
 * Unlink button made.
 *
 * **B-114 — each row carries its own Delete.** D-222 did ship a real delete
 * (the strip popover's `Trash2`), but the ONLY way to reach it was a
 * double-click or right-click on the flag itself — a 9×12px glyph on a 16px
 * strip. The owner, testing live with a marker placed, reported "no way to
 * remove a marker once placed": they had found this list (it is the visible,
 * labelled, count-bearing control in the toolbar) and it offered jump and
 * nothing else. A destructive action being *reachable* is not the same as it
 * being *findable*, and the list is where someone who wants to manage markers
 * actually looks. The row's own click still jumps — the delete is a distinct
 * hit target inside the row that stops the event, exactly the way the
 * Sources panel's per-card hover trash (D-061) sits inside a card whose body
 * click does something else.
 */
export function MarkerListMenu({ timeline, fps, onJump, onRemove }: MarkerListMenuProps) {
  const markers = markersOf(timeline);
  if (markers.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" aria-label="Markers">
            <Flag />
            {markers.length}
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {markers.map((m) => (
          <DropdownMenuItem
            key={m.id}
            data-chroma-marker-list-item={m.id}
            className="gap-2 pr-1"
            onClick={() => onJump(m.frame)}
          >
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: m.color }} />
            <span className="tabular-nums text-text-secondary">{formatTimecode(m.frame / fps, fps, 0)}</span>
            <span className="min-w-0 flex-1 truncate">{m.name ?? 'Marker'}</span>
            {/* Not a `<Button>`: this row is already a menu item, and Base UI's
                `DropdownMenuItem` renders a focusable element — nesting a
                second `<button>` inside it would put an interactive control in
                an interactive control. A `<span role="button">` is the same
                escape hatch `MarkerStrip`'s own popover anchor uses for the
                mirror-image reason. */}
            <span
              role="button"
              tabIndex={-1}
              data-chroma-marker-list-remove={m.id}
              aria-label={`Delete marker at ${formatTimecode(m.frame / fps, fps, 0)}`}
              title="Delete this marker"
              className="shrink-0 cursor-pointer rounded-sm p-1 text-text-secondary hover:bg-red-500/15 hover:text-red-400"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                // The row's own handler jumps the playhead; deleting must not
                // also jump to the marker being deleted.
                e.stopPropagation();
                e.preventDefault();
                onRemove(m.id);
              }}
            >
              <Trash2 className="size-3" />
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface AddMarkerButtonProps {
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
          <Button variant="ghost" size="sm" onClick={onAdd} aria-label="Add marker">
            <Flag />
            Marker
          </Button>
        }
      />
      <TooltipContent>
        Add a marker at the playhead ({shortcut}) — click a flag on the ruler to jump to it, double-click to
        rename, recolour or delete it
      </TooltipContent>
    </Tooltip>
  );
}
