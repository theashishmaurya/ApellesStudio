/**
 * @apelles/editor — the Edit tab's DOCKED library panel (D-263).
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
 * B-124's own `[&[inert]]:hidden` fix in `@apelles/ui`.
 */
import { useState } from 'react';
import { Type, Wand2 } from 'lucide-react';
import { Button, TooltipProvider } from '@apelles/ui';

import { CaptionLibrary } from './CaptionLibrary';
import { CaptionsFromTranscriptButton } from './CaptionsFromTranscriptButton';
import { EDIT_LIBRARY_MODE_LABELS } from './editLibrary';
import { useEditorTimelineStore } from './timelineStore';
import {
  CHROMA_GENERATOR_DRAG_MIME,
  GENERATOR_LABELS,
  clipFromDraggedGenerator,
  timelineFps,
  type DraggedGenerator,
} from './timeline';

interface GeneratorEntry {
  kind: DraggedGenerator['kind'];
  blurb: string;
}

const GENERATORS: Record<'titles' | 'effects', GeneratorEntry> = {
  titles: {
    kind: 'title',
    blurb: 'A text title. Adding it makes a new video track above your picture; type into it in the Inspector.',
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

  /** Place a generator at the playhead on a **brand-new video track above
   *  everything else** (`onNewVideoTrack`, one atomic op — see that field's own
   *  doc on the `add_clip` op). D-263 moved this here from the rail unchanged;
   *  the behaviour itself is D-262's (B-129), and the two landed the same
   *  night, so this is that code in its new home, not a second copy of it.
   *
   *  **B-129 — this used to target `videoTrackIndex(timeline)`, the first
   *  EXISTING video track,** and that was the bug the owner hit: on any real
   *  project that track is full of footage, so a title either landed in a gap
   *  between two shots — where it renders over BLACK rather than over the
   *  picture — or was refused outright for want of room. Their words: "it
   *  should be added on a new timeline meaning a new track instead of adding on
   *  top of other."
   *
   *  A new track is also what both reference entries describe ("drag it into
   *  the timeline **above your video tracks**" for a title; "place it on a
   *  **higher** video track over your clips" for an adjustment clip), and it
   *  removes a whole failure mode: an empty track always has room, so this
   *  button can no longer refuse to place anything.
   *
   *  Placement is still `ripple: false` — an overlay is added ALONGSIDE the
   *  edit, never by pushing it around. The error surface below stays because
   *  `clipFromDraggedGenerator` can still refuse (B-117: a refused add has to
   *  say why rather than look like a dead button), and now that this is a
   *  docked column rather than a 44px rail it says so as a whole sentence
   *  instead of a red "!" chip. */
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
    applyOp({ kind: 'add_clip', track: 0, clip: built, startFrame: playhead, onNewVideoTrack: true });
    // The new track is index 0 by construction, so the clip is always there —
    // but this reads it back rather than asserting, for the same reason
    // `selectDroppedGenerator` does: pointing the Inspector at a clip that was
    // never created is worse than leaving the selection alone.
    const after = useEditorTimelineStore.getState().timeline;
    if (after?.tracks[0]?.clips.some((c) => c.id === built.id)) {
      setSelection([{ track: 0, id: built.id }]);
    } else {
      setError(`Could not add the ${GENERATOR_LABELS[kind].toLowerCase()} — the timeline refused the edit.`);
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
