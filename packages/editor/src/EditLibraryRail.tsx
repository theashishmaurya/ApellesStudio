/**
 * @chroma/editor — the Edit tab's left library rail (D-246, roadmap item 27).
 *
 * **What it is.** A vertical strip of icon buttons down the left edge of the
 * Edit tab, each opening a small library popover: **Titles** and **Effects**
 * (the generated clips — a text title, an adjustment clip), and **Subtitles**
 * (the two caption entry points). Every library entry is BOTH a real
 * drag source onto the timeline and a click-to-add-at-the-playhead button.
 *
 * **This is DaVinci Resolve's own effects library, in its own place.** Its
 * Edit-page copy is explicit about all three: *"click the effects library icon
 * at the **top left of the page**"* (`edit-transitions`); *"open the effects
 * library at the **top left of the screen**, find the text generator … and
 * **drag it into the timeline** above your video tracks"* (`edit-titles`);
 * *"**drag** a new adjustment clip **from the effects library** and place it on
 * a higher video track over your clips"* (`edit-adjustments`) — all in
 * `scratch/resolve-reference/resolve-edit-features.json`, per CLAUDE.md's
 * research-the-real-pattern-first rule. So: a left-edge icon that opens a
 * library, and a DRAG out of it, not a toolbar button that teleports a clip to
 * the playhead. Before this, dragging a title did nothing at all (B-116) —
 * there was no drag source anywhere in the app for one.
 *
 * **The rail shape is this repo's own, not a new one.** The Colorist tab has
 * had a real vertical icon rail since it was RapidRAW — `PanelSwitcher.tsx`'s
 * column of icon buttons that open panels. This is the same idea with this
 * package's own `@chroma/ui` primitives (D-042 shadcn/Base UI) instead of that
 * file's framer-motion/clsx stack, which is Colorist-local.
 *
 * **Native HTML5 drag, deliberately** (`CHROMA_GENERATOR_DRAG_MIME`), not the
 * `@dnd-kit` drag the transitions palette (D-226) uses: that palette renders
 * *inside* `TimelinePane`'s own `DndContext`, and this rail is a sibling of the
 * entire timeline pane, where a `useDraggable` would simply not be a drag. It
 * is the same package boundary the Sources panel crosses, so it uses the
 * mechanism the Sources panel already crosses it with — proven in this app's
 * WKWebView (D-098's native-drag trouble was specifically the cross-track clip
 * MOVE, a gesture that starts and ends inside one component; a panel→timeline
 * drop has worked since D-046).
 *
 * **What it does NOT do.** It owns no timeline state: click-to-add and the
 * drop path both build their clip with `clipFromDraggedGenerator` and commit
 * it with the ordinary `add_clip` `EditOp`, so a dragged title and a clicked
 * one are identical and both are one undo entry. It does not host the
 * transitions palette — a transition's only legal target is a CUT, resolved
 * through the timeline pane's own `DndContext`, so it stays in the timeline
 * toolbar where that context is (see D-246).
 */
import { useState } from 'react';
import { Captions, Type, Wand2, type LucideIcon } from 'lucide-react';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@chroma/ui';

import { CaptionPanel } from './CaptionPanel';
import { CaptionsFromTranscriptButton } from './CaptionsFromTranscriptButton';
import { useEditorTimelineStore } from './timelineStore';
import {
  CHROMA_GENERATOR_DRAG_MIME,
  GENERATOR_LABELS,
  clipFromDraggedGenerator,
  timelineFps,
  videoTrackIndex,
  type DraggedGenerator,
} from './timeline';

/** The rail's width. Fixed by nature — it holds icon buttons and nothing else,
 *  which is the case CLAUDE.md's "every resizable-by-nature panel must
 *  actually be resizable" rule explicitly exempts ("fixed-width panels,
 *  popovers and dialogs that don't need to flex are fine as-is"). The real
 *  content it opens lives in popovers; the resizable panes on this tab (the
 *  Sources column, the preview/timeline split, the Inspector) are all
 *  unchanged. */
const RAIL_WIDTH_PX = 44;

/**
 * `@chroma/shell`'s Sources toggle is `absolute top-2 left-2 h-6 w-6`
 * (`Shell.tsx`) and D-120 floats it over the tab CONTENT area's top-left
 * corner on purpose, so it is reachable whichever tab is active — which means
 * it lands on this rail's own top-left corner. `pt-10` (40px) clears that
 * chip's 32px bottom edge with an 8px gap: exactly the reservation B-051/D-131
 * made on `Player`'s title strip (`pl-10`) for the same chip, for the same
 * reason, in the other axis.
 */
const RAIL_TOP_CLEARANCE = 'pt-10';

interface GeneratorEntry {
  kind: DraggedGenerator['kind'];
  blurb: string;
}

/** One library row: a real HTML5 drag source AND a click-to-add button.
 *
 *  **Both, not one or the other.** The drag is the reference gesture and the
 *  only way to say *where* — but a click that places at the playhead is what
 *  the Title/Adjust toolbar buttons did before this rail existed, it is what
 *  `editor_add_text_clip` does over MCP, and it is the faster gesture when the
 *  playhead is already where you want the clip. Removing it while adding the
 *  drag would have traded one missing half for another. */
function LibraryEntry({ entry, onAdd }: { entry: GeneratorEntry; onAdd: (kind: DraggedGenerator['kind']) => void }) {
  const label = GENERATOR_LABELS[entry.kind];
  return (
    <div
      draggable
      data-chroma-library-entry={entry.kind}
      aria-label={`${label} — drag onto the timeline`}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(
          CHROMA_GENERATOR_DRAG_MIME,
          JSON.stringify({ kind: entry.kind } satisfies DraggedGenerator),
        );
      }}
      className="cursor-grab select-none rounded-md border border-border-color bg-surface p-2 text-left transition-colors hover:border-accent active:cursor-grabbing"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
        {entry.kind === 'title' ? <Type className="size-3.5 shrink-0" /> : <Wand2 className="size-3.5 shrink-0" />}
        {label}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-text-secondary">{entry.blurb}</p>
      <Button
        variant="ghost"
        size="xs"
        className="mt-1.5 h-6 w-full justify-center px-2 text-[11px]"
        aria-label={`Add ${label.toLowerCase()} at the playhead`}
        onClick={() => onAdd(entry.kind)}
      >
        Add at playhead
      </Button>
    </div>
  );
}

/** One rail button + the popover it opens. A `Popover` rather than a docked
 *  panel for the same reason D-226's transitions palette is one: at these
 *  libraries' size a permanent column would be mostly empty chrome, and a
 *  native HTML5 drag out of a popover keeps the popover open for the whole
 *  gesture (the press never becomes a click, so its dismiss handling never
 *  fires). */
function RailButton({
  icon: Icon,
  label,
  tip,
  children,
}: {
  icon: LucideIcon;
  label: string;
  tip: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={label}
                  data-chroma-rail-button={label.toLowerCase()}
                  className="h-8 w-8 p-0 text-text-secondary hover:text-text-primary"
                >
                  <Icon className="size-4" />
                </Button>
              }
            />
          }
        />
        <TooltipContent side="right">{tip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="right" className="w-60 space-y-2 p-2">
        {children}
      </PopoverContent>
    </Popover>
  );
}

const GENERATORS: GeneratorEntry[] = [
  {
    kind: 'title',
    blurb: 'A text title. Drop it above your video tracks; type into it in the Inspector.',
  },
  {
    kind: 'adjustment',
    blurb: 'A colour correction that applies to every clip beneath it, for the span it covers.',
  },
];

export function EditLibraryRail() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const setSelection = useEditorTimelineStore((s) => s.setSelection);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const [error, setError] = useState<string | null>(null);

  /** Place a generator at the playhead on the topmost video track — the exact
   *  behaviour (and the exact ops) the Title/Adjust toolbar buttons had, moved
   *  here with them.
   *
   *  **Track 0, deliberately.** Track index order is compositing z-order
   *  (D-086, lower index = on top), so the topmost video track is where a
   *  title composites over the picture and where an adjustment clip reaches
   *  everything below it — which is what both reference entries describe
   *  ("above your video tracks" / "on a higher video track over your clips").
   *
   *  `ripple: false`, so it lands in whatever space is there and simply does
   *  not place if that space is occupied — `add_clip`'s own documented
   *  non-ripple contract, never silently pushing the edit around. That refusal
   *  used to be SILENT (the pre-rail toolbar button just did nothing, which is
   *  half of what the owner hit when a title "didn't place properly"); it now
   *  says so. */
  const addAtPlayhead = (kind: DraggedGenerator['kind']) => {
    setError(null);
    if (!timeline) return;
    const built = clipFromDraggedGenerator(kind === 'title' ? { kind: 'title' } : { kind: 'adjustment' }, timelineFps(timeline));
    if ('error' in built) {
      setError(built.error);
      return;
    }
    const track = Math.max(videoTrackIndex(timeline), 0);
    applyOp({ kind: 'add_clip', track, clip: built, startFrame: playhead });
    const after = useEditorTimelineStore.getState().timeline;
    if (after?.tracks[track]?.clips.some((c) => c.id === built.id)) {
      setSelection([{ track, id: built.id }]);
    } else {
      setError(
        `There is already a clip at the playhead on the top video track — move the playhead, or drag the ${GENERATOR_LABELS[
          kind
        ].toLowerCase()} onto an empty spot.`,
      );
    }
  };

  return (
    <TooltipProvider>
      <div
        data-chroma-panel="edit-library-rail"
        style={{ width: RAIL_WIDTH_PX }}
        className={`shrink-0 h-full border-r border-border-color bg-surface flex flex-col items-center gap-1 ${RAIL_TOP_CLEARANCE}`}
      >
        <RailButton
          icon={Type}
          label="Titles"
          tip="Titles — drag one onto the timeline, or add it at the playhead"
        >
          <p className="px-1 text-[10px] uppercase tracking-wide text-text-secondary">Titles</p>
          <LibraryEntry entry={GENERATORS[0]} onAdd={addAtPlayhead} />
        </RailButton>

        <RailButton
          icon={Wand2}
          label="Effects"
          tip="Effects — drag an adjustment clip onto a track above your picture"
        >
          <p className="px-1 text-[10px] uppercase tracking-wide text-text-secondary">Effects</p>
          <LibraryEntry entry={GENERATORS[1]} onAdd={addAtPlayhead} />
        </RailButton>

        {/* D-243/D-238 moved here from the cramped inline strip above the
            timeline (see D-246). Both of these create a whole subtitle TRACK,
            which is a library-shaped action, not a per-clip toolbar one — and
            the owner named this rail as where they wanted them ("add caption
            from transcript / subtitle here"). Rendered as the components
            themselves, unchanged: their own popovers/behaviour are already
            right, they were only in the wrong place. */}
        <RailButton
          icon={Captions}
          label="Subtitles"
          tip="Subtitles and captions — import a file, apply a caption style, or generate cues from the transcript"
        >
          <p className="px-1 text-[10px] uppercase tracking-wide text-text-secondary">Subtitles</p>
          <div className="flex flex-col items-stretch gap-1">
            <CaptionPanel />
            <CaptionsFromTranscriptButton />
          </div>
        </RailButton>

        {error && (
          // Same transient, dismissible note the timeline toolbar's own drop
          // refusals use — a refused add has to say why rather than look like
          // a dead button.
          <button
            type="button"
            data-chroma-rail-error
            onClick={() => setError(null)}
            title={`${error} (click to dismiss)`}
            className="mx-1 rounded-sm bg-red-500/15 p-1 text-[10px] leading-tight text-red-400"
          >
            !
          </button>
        )}
      </div>
    </TooltipProvider>
  );
}
