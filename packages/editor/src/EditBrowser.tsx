/**
 * @apelles/editor — the Edit tab's media browser (D-432 P5; replaces D-263's
 * left icon rail).
 *
 * **What it is.** The upper-left panel of the Final Cut Pro arrangement
 * (`docs/notes/ui-redesign.md` §4.1, §4.12): a tab bar of icons, one per
 * library — Sources (the shared media pool), Titles, Effects, Subtitles, Recut,
 * Music edits, Clipper, Index — over the library it selects. Final Cut's own
 * browser switches between Libraries, Photos and Audio, and Titles and
 * Generators, with buttons at the top of that same panel; D-263's rail did the
 * same job from a separate 44 px strip at the window's left edge, which the
 * redesign removes so the browser, the viewer and the Inspector share one band
 * above a full-width timeline.
 *
 * **What it does NOT do.** It owns no library content: the media pool is
 * `app/`'s `SourcesPanel`, handed in as `mediaPool` by the composition root
 * (`Root.tsx` → `EditorTab`), because this package must not import `app/`; the
 * other libraries are `EditLibraryPanel`. Which library is selected is
 * `useEditorTimelineStore.libraryMode`, the state `debug_set_library_mode`
 * drives; whether the browser is shown at all is `useEditLayoutStore.
 * browserOpen`. Clicking the selected tab does nothing (D-263's rail collapsed
 * the column then); the viewer header's browser toggle shows and hides it.
 *
 * The media pool stays MOUNTED, hidden, while another library shows, so its
 * search text, open bin and scroll survive a trip through Titles — the same
 * `hidden`-class swap (never a Base UI deferred hide, B-124) D-263 used.
 */
import type { ReactNode } from 'react';
import {
  ClosedCaptioningIcon,
  FilmSlateIcon,
  FilmStripIcon,
  ListBulletsIcon,
  MagicWandIcon,
  MusicNotesMinusIcon,
  ScissorsIcon,
  TextTIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import {
  PanelErrorBoundary,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@apelles/ui';

import { EditLibraryPanel } from './EditLibraryPanel';
import { EDIT_LIBRARY_MODES, EDIT_LIBRARY_MODE_LABELS, parseEditLibraryMode, type EditLibraryMode } from './editLibrary';
import { useEditorTimelineStore } from './timelineStore';

/** One glyph per library; the provenance of each is D-263 / the mode's own D-NNN. */
export const BROWSER_TAB_ICONS: Record<EditLibraryMode, PhosphorIcon> = {
  // The Sources panel labels its own "All media" row with `FilmStrip`.
  sources: FilmStripIcon,
  titles: TextTIcon,
  effects: MagicWandIcon,
  subtitles: ClosedCaptioningIcon,
  // D-318 — the one library that cuts rather than adds.
  recut: ScissorsIcon,
  // D-408 — takes music out on story beats.
  music: MusicNotesMinusIcon,
  // D-411 — makes new pieces (shorts) out of a long one.
  clipper: FilmSlateIcon,
  // D-328 — reads the edit back as a list.
  index: ListBulletsIcon,
};

const BROWSER_TAB_TIPS: Record<EditLibraryMode, string> = {
  sources: 'The project’s media pool. Drag a clip onto the timeline.',
  titles: 'Drag one onto the timeline, or add it at the playhead',
  effects: 'Drag an adjustment clip onto a track above your picture',
  subtitles: 'Apply a caption style, import a file, or generate cues from the transcript',
  recut: 'Find the silences and the retakes in the selected clip, then cut the ones you accept',
  music: 'Dropouts, stop-time breaths and dry sections cut into the music bed on story beats',
  clipper: 'Shorts from a long video or timeline: analyse it, let your AI agent pick the moments, then build them',
  index: 'Every marker on the timeline and the selected clip’s transcript. Click a row to jump there.',
};

export interface EditBrowserProps {
  /** The shared media pool (`app/`'s `SourcesPanel`), shown on the Sources
   *  tab. Omitted (a harness, a test) → the Sources tab shows nothing. */
  mediaPool?: ReactNode;
  /** v0.3.0 (B-359 item 3) — what sits at the right end of the tab row: the
   *  composition root's `+ Import` (`app/`'s `SourcesImportButton`), where
   *  the mockup puts it, instead of a "SOURCES · Select · Import" row of its
   *  own above the grid. Injected for the reason `mediaPool` is. */
  tabRowEnd?: ReactNode;
}

export function EditBrowser({ mediaPool, tabRowEnd }: EditBrowserProps) {
  const mode = useEditorTimelineStore((s) => s.libraryMode);
  const setLibraryMode = useEditorTimelineStore((s) => s.setLibraryMode);

  return (
    <div data-chroma-panel="edit-browser" className="flex h-full min-h-0 flex-col bg-surface">
      <TooltipProvider>
        <Tabs
          value={mode}
          onValueChange={(value) => {
            const next = parseEditLibraryMode(value);
            if (next) setLibraryMode(next);
          }}
          // `@container` — the Import button shows its word only when the row
          // is wide enough to keep the eight tabs readable beside it.
          className="@container shrink-0 flex-row data-horizontal:flex-row items-center gap-1.5 border-b border-border-color px-2 py-1.5"
          data-chroma-browser-tabrow=""
        >
          <TabsList
            aria-label="Browser libraries"
            className="h-7 min-w-0 flex-1 gap-0.5 rounded-sm bg-bg-secondary p-0.5"
          >
            {EDIT_LIBRARY_MODES.map((m) => {
              const Icon = BROWSER_TAB_ICONS[m];
              const label = EDIT_LIBRARY_MODE_LABELS[m];
              return (
                <Tooltip key={m}>
                  <TooltipTrigger
                    render={
                      <TabsTrigger
                        value={m}
                        aria-label={label}
                        data-chroma-browser-tab={m}
                        className="h-6 min-w-0 rounded-xs px-0 text-text-secondary hover:text-text-primary data-active:bg-card-active data-active:text-accent-text data-active:shadow-none"
                      >
                        <Icon className="size-4" />
                      </TabsTrigger>
                    }
                  />
                  <TooltipContent side="bottom">
                    <span className="font-medium">{label}</span>
                    <span className="ml-1.5 text-text-secondary">{BROWSER_TAB_TIPS[m]}</span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </TabsList>
          {tabRowEnd}
        </Tabs>
      </TooltipProvider>
      {/* `overflow-x-hidden` is a guard, not the fix: each library keeps its own
          content inside the column (B-362 — a Select trigger that would not
          shrink, a row that would not wrap). A panel that regresses is clipped
          here rather than growing a horizontal scrollbar. */}
      <div className="relative min-h-0 flex-1 overflow-x-hidden">
        <div className={mode === 'sources' ? 'h-full' : 'hidden'}>
          <PanelErrorBoundary panel="Sources">{mediaPool}</PanelErrorBoundary>
        </div>
        {mode !== 'sources' && (
          <PanelErrorBoundary panel="Library">
            <EditLibraryPanel />
          </PanelErrorBoundary>
        )}
      </div>
    </div>
  );
}
