/**
 * @apelles/editor — the Edit tab's left library rail (D-248; rebuilt as a real
 * activity bar by D-263, roadmap item 27).
 *
 * **What it is.** The leftmost strip of the window: one icon button per
 * library — **Sources** (the shared media pool), **Titles**, **Effects** and
 * **Subtitles** — that switches what the docked column immediately to its
 * right is showing, and collapses that column when you click the library
 * already showing. It renders no library content itself; that is
 * `EditLibraryPanel.tsx` (this tab's own three) and `app/`'s `SourcesPanel`
 * (the shared pool, injected into `@apelles/shell`).
 *
 * **This is VS Code's Activity Bar, and Final Cut Pro's browser buttons.**
 * VS Code's own docs: the Activity Bar is on the far left, the Primary Side
 * Bar sits *immediately to its right*, and the Activity Bar "lets you switch
 * between views"; clicking the already-active view collapses the side bar
 * (⌘B toggles it too). Final Cut Pro is the same shape in an NLE: "the Titles
 * and Generators button in the **top-left corner** of the Final Cut Pro
 * window" swaps what the one browser column shows, and a title is then either
 * double-clicked in at the playhead or dragged from the browser to the
 * timeline. Both references, with the quotes, are in
 * `scratch/activity-bar-reference/notes.md` per CLAUDE.md's
 * research-the-real-pattern-first rule; Resolve's own Edit-page copy ("open
 * the effects library at the top left of the screen … drag it into the
 * timeline") is what D-248 built from and is unchanged by this.
 *
 * **Why it moved out of `EditorTab.tsx` (D-263).** The rail used to be the
 * first child of the Edit tab's own panel group, which put it to the RIGHT of
 * the shell-level Sources column — the panel a rail is supposed to be the
 * switcher for. Reordering divs inside one file could not fix that: Sources
 * lives in `Shell.tsx` (D-046/D-116, shared by all three tabs) and the rail is
 * deliberately Edit-tab-local. It is now injected into the shell as the active
 * tab's `libraryRail`, which is precisely the slot D-251 established for a
 * tab-owned node that must sit at a specific place in the shell's own chrome
 * (`headerAction`, the Export button). `Shell` still never imports this
 * package: `Root.tsx` passes the node, exactly as it passes `sourcesPanel` and
 * `launcher`.
 *
 * **What it does NOT do.** It owns no timeline state and no open/closed state
 * of its own: which library is selected is `useEditorTimelineStore`'s
 * `libraryMode`, and whether the column is open at all is the shell's
 * `sourcesPanelOpen` — a flag this package must not import (`@apelles/shell`
 * depends on nothing here and it stays that way), so it arrives as the
 * `dockOpen`/`onDockOpenChange` props the composition root wires up, the same
 * way `MotionTab` gets `onRendered`. It also does not host the transitions
 * palette — a transition's only legal target is a CUT, resolved through the
 * timeline pane's own `DndContext`, so it stays in the timeline toolbar where
 * that context is (D-248).
 */
import { Captions, Film, Type, Wand2, type LucideIcon } from 'lucide-react';
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@apelles/ui';

import {
  EDIT_LIBRARY_MODES,
  EDIT_LIBRARY_MODE_LABELS,
  type EditLibraryMode,
} from './editLibrary';
import { useEditorTimelineStore } from './timelineStore';

/** The rail's width. Fixed by nature — it holds icon buttons and nothing else,
 *  which is the case CLAUDE.md's "every resizable-by-nature panel must
 *  actually be resizable" rule explicitly exempts ("fixed-width panels,
 *  popovers and dialogs that don't need to flex are fine as-is"). The column
 *  it switches is the resizable one (`Shell.tsx`'s `ResizablePanel`). */
const RAIL_WIDTH_PX = 44;

const RAIL_ICONS: Record<EditLibraryMode, LucideIcon> = {
  // `Film` is what the Sources panel labels its own "All media" row with, so
  // the rail button and the thing it opens carry the same mark.
  sources: Film,
  titles: Type,
  effects: Wand2,
  subtitles: Captions,
};

const RAIL_TIPS: Record<EditLibraryMode, string> = {
  sources: 'Sources — the project’s media pool. Drag a clip onto the timeline.',
  titles: 'Titles — drag one onto the timeline, or add it at the playhead',
  effects: 'Effects — drag an adjustment clip onto a track above your picture',
  subtitles: 'Subtitles and captions — apply a caption style, import a file, or generate cues from the transcript',
};

export interface EditLibraryRailProps {
  /** Whether the docked library column is currently shown. Shell state
   *  (`useShellStore.sourcesPanelOpen`), passed in rather than imported —
   *  see this file's module doc. */
  dockOpen: boolean;
  /** Show/hide that column. The SAME setter the shell's own toggle calls, so
   *  the rail and `debug_set_sources_panel` drive one flag, not two. */
  onDockOpenChange: (open: boolean) => void;
}

export function EditLibraryRail({ dockOpen, onDockOpenChange }: EditLibraryRailProps) {
  const mode = useEditorTimelineStore((s) => s.libraryMode);
  const setLibraryMode = useEditorTimelineStore((s) => s.setLibraryMode);

  /** Activity-bar semantics, from the reference: clicking a different library
   *  switches to it (opening the column if it was closed); clicking the one
   *  already showing collapses the column. One button is therefore both the
   *  view switcher and the panel toggle, which is why the shell's own floating
   *  Sources chip (D-120) is not rendered on a tab that has a rail — two
   *  controls for one panel, a step apart, is the exact complaint D-120 was
   *  itself answering. */
  const onPick = (next: EditLibraryMode) => {
    if (dockOpen && next === mode) {
      onDockOpenChange(false);
      return;
    }
    setLibraryMode(next);
    if (!dockOpen) onDockOpenChange(true);
  };

  return (
    <TooltipProvider>
      <div
        data-chroma-panel="edit-library-rail"
        role="tablist"
        aria-label="Edit libraries"
        aria-orientation="vertical"
        style={{ width: RAIL_WIDTH_PX }}
        className="shrink-0 h-full border-r border-border-color bg-surface flex flex-col items-center gap-1 pt-2"
      >
        {EDIT_LIBRARY_MODES.map((m) => {
          const Icon = RAIL_ICONS[m];
          const label = EDIT_LIBRARY_MODE_LABELS[m];
          const showing = dockOpen && m === mode;
          return (
            <Tooltip key={m}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    role="tab"
                    aria-label={label}
                    aria-selected={showing}
                    data-chroma-rail-button={m}
                    onClick={() => onPick(m)}
                    className={
                      'relative h-8 w-8 p-0 ' +
                      (showing ? 'text-accent' : 'text-text-secondary hover:text-text-primary')
                    }
                  >
                    <Icon className="size-4" />
                    {/* The selected marker: an accent bar on the rail's own
                        outer edge, which is how every activity bar in the
                        reference draws it — and Apelles already draws a
                        selected tab as an accent bar (`Shell.tsx`'s tab
                        underline, `TimelineSwitcher`'s), just in the other
                        axis. */}
                    <span
                      className={
                        'absolute left-0 top-1 bottom-1 w-0.5 rounded-full ' +
                        (showing ? 'bg-accent' : 'bg-transparent')
                      }
                    />
                  </Button>
                }
              />
              <TooltipContent side="right">{RAIL_TIPS[m]}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
