/**
 * @chroma/editor — the Edit tab's DOCKED library panel (D-263).
 *
 * **What it is.** The content of the left-hand library column while the rail
 * (`EditLibraryRail.tsx`) has one of this tab's own libraries selected:
 * **Titles**, **Effects** (the generated clips — a text title, an adjustment
 * clip) and **Subtitles** (the caption style library, `.srt`/`.vtt` import,
 * and the transcript-driven generator). Every library entry is BOTH a real
 * HTML5 drag source onto the timeline and a click-to-add-at-the-playhead
 * button, exactly as it was before this panel existed.
 *
 * **What changed in D-263, and why the old reason no longer holds.** This
 * content used to live in a `Popover` per rail button. D-248's own comment
 * gave two reasons for that: at these libraries' size a permanent column
 * would be mostly empty chrome, and *"a native HTML5 drag out of a popover
 * keeps the popover open for the whole gesture."* Both were about a
 * STANDALONE floating popover. The owner asked (live, 2026-09-09) for the
 * libraries to open **in the docked panel that already exists** instead — so
 * there is no new column (this is the Sources column, showing something else)
 * and there is no popover left to accidentally close. The drag itself is
 * unaffected: `SourcesPanel` has dragged media out of this very column since
 * D-046 with a plain `draggable` div and `dataTransfer.setData`, no popover
 * and no `DndContext` involved, and `TimelinePane`'s `onDrop` reads the MIME
 * off the event either way. Verified as a real drop, not by inspection —
 * `EditLibraryPanel.dom.test.tsx`.
 *
 * **What it does NOT do.** It owns no timeline state (click-to-add and the
 * drop path both build their clip with `clipFromDraggedGenerator` and commit
 * it with the ordinary `add_clip` `EditOp`, so a dragged title and a clicked
 * one are identical and both are one undo entry); it does not render the
 * media pool (that is `sources` mode, where the shell's own shared
 * `SourcesPanel` shows instead and this component is not mounted at all —
 * see `editLibrary.ts`); and it does not decide whether the column is open
 * (shell state, `useShellStore.sourcesPanelOpen`).
 *
 * **Switching modes unmounts the previous one, deliberately, and that is NOT
 * B-124.** B-124 was Base UI's `Tabs.Panel` hiding a deselected panel behind
 * `useOpenChangeComplete` → `requestAnimationFrame`, which never ticks in a
 * non-frontmost window, so both panels painted at once. The switch here is a
 * plain React conditional: the old subtree is gone in the same commit that
 * renders the new one, with no frame, no animation and no `getAnimations()`
 * in between — the one arrangement that cannot have that class of bug. The
 * caption library inside `subtitles` mode still uses `Tabs`, which carries
 * B-124's own `[&[inert]]:hidden` fix in `@chroma/ui`.
 */
import { useState } from 'react';
import { Type, Wand2 } from 'lucide-react';
import { Button, TooltipProvider } from '@chroma/ui';

import { CaptionLibrary } from './CaptionLibrary';
import { CaptionsFromTranscriptButton } from './CaptionsFromTranscriptButton';
import { EDIT_LIBRARY_MODE_LABELS } from './editLibrary';
import { useEditorTimelineStore } from './timelineStore';
import {
  CHROMA_GENERATOR_DRAG_MIME,
  GENERATOR_LABELS,
  clipFromDraggedGenerator,
  timelineFps,
  videoTrackIndex,
  type DraggedGenerator,
} from './timeline';

interface GeneratorEntry {
  kind: DraggedGenerator['kind'];
  blurb: string;
}

const GENERATORS: Record<'titles' | 'effects', GeneratorEntry> = {
  titles: {
    kind: 'title',
    blurb: 'A text title. Drop it above your video tracks; type into it in the Inspector.',
  },
  effects: {
    kind: 'adjustment',
    blurb: 'A colour correction that applies to every clip beneath it, for the span it covers.',
  },
};

/** One library row: a real HTML5 drag source AND a click-to-add button.
 *
 *  **Both, not one or the other.** The drag is the reference gesture and the
 *  only way to say *where* — Final Cut Pro's own help describes both for the
 *  same title ("Double-click the title" to add it at the playhead, or "Drag
 *  the title from the browser to the edit point between the clips",
 *  `scratch/activity-bar-reference/notes.md`) — but a click that places at the
 *  playhead is also what `editor_add_text_clip` does over MCP, and it is the
 *  faster gesture when the playhead is already where you want the clip. */
function LibraryEntry({
  entry,
  onAdd,
}: {
  entry: GeneratorEntry;
  onAdd: (kind: DraggedGenerator['kind']) => void;
}) {
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
      className="cursor-grab select-none rounded-md border border-border-color bg-bg-primary p-2 text-left transition-colors hover:border-accent active:cursor-grabbing"
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

export function EditLibraryPanel() {
  const mode = useEditorTimelineStore((s) => s.libraryMode);
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const setSelection = useEditorTimelineStore((s) => s.setSelection);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const [error, setError] = useState<string | null>(null);

  /** Place a generator at the playhead on the topmost video track — the exact
   *  behaviour (and the exact ops) the rail's popovers had, moved here with
   *  them.
   *
   *  **Track 0, deliberately.** Track index order is compositing z-order
   *  (D-086, lower index = on top), so the topmost video track is where a
   *  title composites over the picture and where an adjustment clip reaches
   *  everything below it — which is what both reference entries describe
   *  ("above your video tracks" / "on a higher video track over your clips").
   *
   *  `ripple: false`, so it lands where the playhead is and never silently
   *  pushes the rest of the edit around — `add_clip`'s own documented
   *  non-ripple contract. The guard below reports an add the op declined,
   *  rather than leaving it looking like a dead button (B-117), and now that
   *  this is a docked column rather than a 44px rail it reports it as a whole
   *  sentence instead of a red "!" chip.
   *
   *  **B-131** — that guard does NOT fire for the case it names. An
   *  `add_clip` at a frame already covered by a clip on the same track
   *  currently splices in anyway and produces an overlap, which D-104 forbids
   *  the move path from ever creating. The defect is in the op layer, not
   *  here; this is D-248's own code moved verbatim, and it is written up in
   *  `docs/BUGS.md` rather than patched from inside a layout change. */
  const addAtPlayhead = (kind: DraggedGenerator['kind']) => {
    setError(null);
    if (!timeline) return;
    const built = clipFromDraggedGenerator(
      kind === 'title' ? { kind: 'title' } : { kind: 'adjustment' },
      timelineFps(timeline),
    );
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

  // `sources` is the shell's own shared media pool, which this package must
  // not render (`editLibrary.ts`). The composition root does not mount this
  // component in that mode at all; the guard is here so the contract cannot be
  // broken silently from the other side.
  if (mode === 'sources') return null;

  return (
    <TooltipProvider>
      <div
        data-chroma-panel="edit-library"
        data-chroma-library-mode={mode}
        className="flex h-full w-full min-h-0 flex-col bg-surface text-text-primary"
      >
        {/* Same header shape the Sources panel uses, so switching modes reads
            as one column changing what it holds rather than as a different
            kind of panel appearing. */}
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-2 border-b border-border-color">
          <span className="flex-1 text-[11px] font-semibold tracking-wide text-text-secondary">
            {EDIT_LIBRARY_MODE_LABELS[mode].toUpperCase()}
          </span>
        </div>

        {mode === 'titles' && (
          <div className="flex-1 min-h-0 space-y-2 overflow-y-auto p-2">
            <LibraryEntry entry={GENERATORS.titles} onAdd={addAtPlayhead} />
          </div>
        )}

        {mode === 'effects' && (
          <div className="flex-1 min-h-0 space-y-2 overflow-y-auto p-2">
            <LibraryEntry entry={GENERATORS.effects} onAdd={addAtPlayhead} />
          </div>
        )}

        {mode === 'subtitles' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* D-238's transcript-driven generator sits above the library
                proper: it creates a whole subtitle TRACK from the selected
                clip's speech, which is a different act from picking a look,
                and it is the one entry here that has a precondition (a
                selected clip) it reports itself. */}
            <div className="shrink-0 border-b border-border-color p-2">
              <CaptionsFromTranscriptButton />
            </div>
            <div className="min-h-0 flex-1">
              <CaptionLibrary />
            </div>
          </div>
        )}

        {error && (
          // The same dismissible, transient note the timeline's own drop
          // refusals use — a refused add has to say why rather than look like
          // a dead button.
          <button
            type="button"
            data-chroma-library-error
            onClick={() => setError(null)}
            title="Dismiss"
            className="shrink-0 border-t border-border-color bg-red-500/10 px-2.5 py-2 text-left text-[11px] leading-snug text-red-400"
          >
            {error}
          </button>
        )}
      </div>
    </TooltipProvider>
  );
}
