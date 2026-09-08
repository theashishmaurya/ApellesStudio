/**
 * @chroma/editor — the transitions library: the browsable palette, the
 * drag-onto-a-cut source, the on-timeline badges, and the per-transition editor
 * popover (D-224, roadmap item 27).
 *
 * **What it is.** The human half of `Track.transitions` (`timeline.ts`). Three
 * pieces, deliberately in one module the way `TimelineMarkers.tsx` keeps the
 * marker strip, its popover and its jump list together:
 * `TransitionsPaletteButton` (the toolbar's Effects-Library equivalent),
 * `TransitionBadges` (what a transition looks like on the track), and
 * `TransitionEditorPopover` (its duration / alignment / colour, and Remove).
 * The `editor_add_transition` / `_list_transitions` / `_set_transition` /
 * `_remove_transition` MCP ops (`useEditorControl.ts`) drive the exact same
 * `add_transition`/`set_transition`/`remove_transition` `EditOp`s these controls
 * do — one write path, per CLAUDE.md's human+AI parity rule.
 *
 * **The interaction is DaVinci Resolve's own, from its own copy** (the Edit
 * page's "Transitions and Effects Library" section, `scratch/resolve-reference/`
 * — CLAUDE.md's "research the real pattern first" rule, cited in D-224):
 * *"click the effects library icon at the top left of the page to open it,
 * select the effect you want and drag it onto a clip in the timeline or onto
 * the cut point between clips … Transition duration can be changed by dragging
 * the edges of the transition in the timeline or by changing it in the
 * inspector."* So: a browsable panel, a drag onto the cut, and a duration you
 * can retype. **Dragging the transition's own edges to re-time it is
 * deliberately NOT built in this pass** — see D-225 for that scope call; the
 * duration field in this popover is the other half of Resolve's own sentence
 * and does the same job.
 *
 * **What it does NOT do.** It owns no state that outlives a gesture: every
 * commit goes straight to `useEditorTimelineStore.applyOp`, so a transition edit
 * is persisted and undoable like any other. It computes no timeline geometry of
 * its own either — `pxPerSec`/`scrollLeft`/`startLeftPx`/`rowHeight` come from
 * `TimelinePane`, which is the one place that math lives.
 */
import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Blend, Trash2, Wand2 } from 'lucide-react';
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@chroma/ui';

import {
  DEFAULT_TRANSITION_FRAMES,
  MARKER_COLORS,
  TRANSITION_ALIGNMENTS,
  TRANSITION_KINDS,
  transitionWindow,
  transitionsOf,
  type Timeline,
  type Track,
  type Transition,
  type TransitionAlignment,
  type TransitionKind,
} from './timeline';

/** D-224 — the `@dnd-kit` drag id and `data.type` a palette entry carries.
 *  A third drag "kind" sharing `TimelinePane`'s one `DndContext` alongside
 *  `track` and `clip`, disambiguated by `data.current.type` exactly as those
 *  two already are (D-098's own convention, not a new mechanism). */
export interface TransitionDragData {
  type: 'transition';
  kind: TransitionKind;
}

export function transitionDragId(kind: TransitionKind): string {
  return `transition:${kind}`;
}

/** D-224 — how close (in px) a drop has to land to a real cut for it to count
 *  as being ON that cut. Matches `TimelinePane`'s own `INSERT_SNAP_PX`
 *  intent — a drop gesture is never frame-accurate, and the target here is a
 *  single frame, so without a real snap radius the gesture would essentially
 *  never land. Generous, because there is exactly one legal target per
 *  neighbourhood: the nearest cut, or nothing. */
export const TRANSITION_SNAP_PX = 24;

/** One palette entry: a real `@dnd-kit` drag source. */
function PaletteEntry({ kind, label, blurb }: { kind: TransitionKind; label: string; blurb: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: transitionDragId(kind),
    data: { type: 'transition', kind } satisfies TransitionDragData,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`cursor-grab select-none rounded-md border border-border-color bg-surface p-2 text-left transition-colors hover:border-accent ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
        <Blend className="size-3.5 shrink-0" />
        {label}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-text-secondary">{blurb}</p>
    </div>
  );
}

/** D-224 — the toolbar's Transitions library. A popover rather than a docked
 *  panel: with two entries a permanent column would be mostly empty chrome, and
 *  the drag still starts from inside it either way (the popover stays open for
 *  the whole gesture because `@dnd-kit`'s pointer sensor captures the pointer,
 *  so the press never reaches the popover's own dismiss handling). */
export function TransitionsPaletteButton() {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button variant="ghost" size="sm" aria-label="Transitions">
                  <Wand2 />
                  Transitions
                </Button>
              }
            />
          }
        />
        <TooltipContent>
          Drag a transition onto a cut between two clips on the same video track
        </TooltipContent>
      </Tooltip>
      <PopoverContent className="w-64 space-y-2 p-2">
        <p className="px-1 text-[10px] uppercase tracking-wide text-text-secondary">Video transitions</p>
        {TRANSITION_KINDS.map((k) => (
          <PaletteEntry key={k.value} kind={k.value} label={k.label} blurb={k.blurb} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** D-224 — a transition drawn on its track: a hatched band spanning its own
 *  `[start, end)` window, centred on the cut it belongs to, with an X through
 *  it (the mark every reference NLE uses for a dissolve). Click to open its
 *  editor.
 *
 *  Positioned with exactly the `startLeft + frame/fps*pxPerSec - scrollLeft`
 *  arithmetic every other overlay in `TimelinePane` uses — this component does
 *  no geometry of its own. */
export function TransitionBadges({
  tracks,
  fps,
  pxPerSec,
  scrollLeft,
  scrollTop,
  startLeftPx,
  rowHeight,
  rulerAndMarginPx,
  onChange,
  onRemove,
}: {
  tracks: Track[];
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  scrollTop: number;
  startLeftPx: number;
  rowHeight: number;
  rulerAndMarginPx: number;
  onChange: (track: number, id: string, patch: TransitionPatch) => void;
  onRemove: (track: number, id: string) => void;
}) {
  const badges = useMemo(
    () =>
      tracks.flatMap((tr, trackIndex) =>
        tr.kind !== 'video'
          ? []
          : transitionsOf(tr).map((t) => {
              const { start, end } = transitionWindow(t);
              return { trackIndex, transition: t, start, end };
            }),
      ),
    [tracks],
  );

  return (
    <>
      {badges.map(({ trackIndex, transition, start, end }) => {
        const left = startLeftPx + (start / fps) * pxPerSec - scrollLeft;
        const width = Math.max(6, ((end - start) / fps) * pxPerSec);
        return (
          <Popover key={`${trackIndex}:${transition.id}`}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Transition at frame ${transition.at_frame}`}
                  className="absolute z-30 cursor-pointer rounded-sm border border-accent bg-accent/25 hover:bg-accent/40"
                  style={{
                    left,
                    width,
                    top: rulerAndMarginPx + trackIndex * rowHeight - scrollTop + rowHeight * 0.15,
                    height: rowHeight * 0.7,
                    // The dissolve X, drawn as two gradients rather than an SVG
                    // so a timeline full of transitions paints plain divs — the
                    // same reasoning `TimelineMarkers`' `clip-path` flag uses.
                    backgroundImage:
                      'linear-gradient(to top right, transparent calc(50% - 0.5px), currentColor calc(50% - 0.5px), currentColor calc(50% + 0.5px), transparent calc(50% + 0.5px)), linear-gradient(to bottom right, transparent calc(50% - 0.5px), currentColor calc(50% - 0.5px), currentColor calc(50% + 0.5px), transparent calc(50% + 0.5px))',
                  }}
                />
              }
            />
            <PopoverContent className="w-60 p-3">
              <TransitionEditor
                transition={transition}
                onChange={(patch) => onChange(trackIndex, transition.id, patch)}
                onRemove={() => onRemove(trackIndex, transition.id)}
              />
            </PopoverContent>
          </Popover>
        );
      })}
    </>
  );
}

/** The patch shape the `set_transition` op takes — re-declared here rather than
 *  imported from the op union so this component's props do not depend on
 *  `EditOp`'s own shape. */
export interface TransitionPatch {
  kind?: TransitionKind;
  duration?: number;
  alignment?: TransitionAlignment;
  color?: string | null;
}

/** D-224 — one transition's own editor: the type, its duration in frames, its
 *  alignment to the cut, and (for a dip) its colour. Resolve's own listed
 *  affordances for a placed transition, minus edge-dragging (D-225).
 *
 *  Duration is committed on blur/Enter rather than per keystroke: every commit
 *  is a real undo entry, and a three-digit number typed a digit at a time would
 *  otherwise be three of them — the same reasoning the marker popover's own
 *  fields already follow. */
function TransitionEditor({
  transition,
  onChange,
  onRemove,
}: {
  transition: Transition;
  onChange: (patch: TransitionPatch) => void;
  onRemove: () => void;
}) {
  const [draftDuration, setDraftDuration] = useState(String(transition.duration));
  const commitDuration = () => {
    const n = Math.round(Number(draftDuration));
    if (Number.isFinite(n) && n >= 1 && n !== transition.duration) onChange({ duration: n });
    else setDraftDuration(String(transition.duration));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-text-secondary">Type</label>
        <Select
          value={transition.kind}
          onValueChange={(v: string | null) => {
            if (v) onChange({ kind: v as TransitionKind });
          }}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSITION_KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-text-secondary">Duration (frames)</label>
        <Input
          className="h-7 text-xs"
          inputMode="numeric"
          value={draftDuration}
          onChange={(e) => setDraftDuration(e.target.value)}
          onBlur={commitDuration}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitDuration();
            if (e.key === 'Escape') setDraftDuration(String(transition.duration));
          }}
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-text-secondary">Alignment</label>
        <Select
          value={transition.alignment ?? 'center_at_cut'}
          onValueChange={(v: string | null) => {
            if (v) onChange({ alignment: v as TransitionAlignment });
          }}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSITION_ALIGNMENTS.map((a) => (
              <SelectItem key={a.value} value={a.value}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {transition.kind === 'dip_to_color' && (
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wide text-text-secondary">Dip colour</label>
          <div className="flex flex-wrap gap-1">
            {/* Black first — "dip to black" is the overwhelmingly common case
                and the model's own default (an absent `color`), so it has to be
                reachable, not only the initial state. The rest is the marker
                palette, reused rather than duplicated: one named colour source
                in this app (see `MARKER_COLORS`' own doc for why literals). */}
            {[{ name: 'black', hex: '#000000' }, ...MARKER_COLORS].map((c) => {
              const selected = (transition.color ?? '#000000').toUpperCase() === c.hex.toUpperCase();
              return (
                <button
                  key={c.name}
                  type="button"
                  aria-label={c.name}
                  onClick={() => onChange({ color: c.hex === '#000000' ? null : c.hex })}
                  className={`size-4 rounded-sm border ${selected ? 'border-accent ring-1 ring-accent' : 'border-border-color'}`}
                  style={{ backgroundColor: c.hex }}
                />
              );
            })}
          </div>
        </div>
      )}

      <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onRemove}>
        <Trash2 />
        Remove transition
      </Button>
    </div>
  );
}

/** D-224 — the nearest real cut on `track` to `frame`, within `snapFrames`, or
 *  `null`. The drop gesture's whole target resolution: a transition can only
 *  live on a cut, so a drop that is not near one is refused rather than snapped
 *  to something arbitrary.
 *
 *  Exported so `TimelinePane`'s drop handler and its live drag preview resolve
 *  the identical target — the same "one resolution, two callers" split
 *  `computeInsertion`/`resolveClipLanding` already use for a clip drop. */
export function nearestCut(cuts: number[], frame: number, snapFrames: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const c of cuts) {
    const d = Math.abs(c - frame);
    if (d <= snapFrames && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/** D-224 — the default duration for a newly-dropped transition, clamped so it
 *  cannot swallow either neighbouring clip whole. [`DEFAULT_TRANSITION_FRAMES`]
 *  (one second at the default rate, Resolve's own default) unless one of the two
 *  clips is shorter than that, in which case a drop still produces a real,
 *  legal transition rather than a refusal the user has to decode. */
export function defaultTransitionFrames(
  tl: Timeline,
  track: number,
  atFrame: number,
  fps: number,
  clipLength: (clip: Track['clips'][number]) => number,
): number {
  const tr = tl.tracks[track];
  if (!tr) return DEFAULT_TRANSITION_FRAMES;
  const lengths = tr.clips
    .filter((c) => c.start_frame === atFrame || clipLength(c) + c.start_frame === atFrame)
    .map(clipLength);
  const shortest = lengths.length > 0 ? Math.min(...lengths) : DEFAULT_TRANSITION_FRAMES;
  // Halved: a CENTRED transition of length `d` reaches `d/2` into each clip, and
  // `checkTransition` refuses one that runs past a neighbour's far edge.
  return Math.max(1, Math.min(DEFAULT_TRANSITION_FRAMES, shortest * 2 - 2, shortest));
}
