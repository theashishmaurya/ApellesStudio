/**
 * @apelles/editor — the Edit tab (D-041).
 *
 * MVP: a single-video-track timeline of the open project's shots, scrub + play
 * with a live preview, and basic edits (reorder / trim / split / remove).
 * Deferred (later tracked steps): multi-track, audio, transitions, transcript
 * cut, GPU compositing, grade-in-preview, OTIO export, MCP tools.
 *
 * A project must be open (via the Colorist tab's D-037 launcher) for the
 * timeline to have shots.
 *
 * B-034/D-112 — **this screen used to lie, and that is why the same bug kept
 * "coming back."** It rendered "No project open" for *any* failed
 * `chroma_timeline_get`, because the only state it had was `loaded && !
 * timeline`. So four genuinely different underlying faults (B-004's IPC
 * corruption on cold boot, B-025's double-click/refetch gap, B-031's silently
 * aborted `open_manifest`, B-032's HMR-broken listener teardown) plus this
 * one all produced the identical, confidently-wrong sentence — while the
 * shell right above it was simultaneously showing the tab bar, which only
 * appears *because a project is open*. Whether a project is open is now
 * `openProjectKey` (B-083/D-203: which project, not merely whether one is
 * open), pushed down from the app's own source of truth, and it is
 * the only thing that can produce that message; a fetch that fails while a
 * project is genuinely open says so instead, with the real backend error and
 * a Retry. Recovery from a transient failure is automatic (the store's retry
 * ladder), so Retry is a last resort rather than the only way out.
 *
 * D-118 — the Inspector (`EditorInspectorPanel`, wrapping `ClipInspector
 * Panel`) is now a real sibling of the preview+timeline column, in its own
 * full-height `ResizablePanel`, not a third pane nested inside
 * `TimelinePane.tsx`'s own split (which was capped at the timeline row's
 * height, `h-[46%]` below). Same architectural treatment `@apelles/shell`'s
 * D-116 gave the Sources panel on the left — a real resizable column, not a
 * fixed width, spanning the full tab. Toggled by a local button in this
 * tab's own preview-area toolbar (not a `Shell.tsx` chrome-bar button like
 * Sources' toggle): `Shell` is deliberately tab-agnostic (its own doc:
 * "never on the colorist app or the editor/motion packages"), and unlike
 * Sources — one real, shared media pool used identically by all three tabs
 * — this Inspector is Edit-tab-specific content (Colorist has its own
 * `ControlsPanel`, Motion its own `InspectorPanel`, neither toggleable
 * today), so a shell-level toggle would need `Shell` to become aware of
 * which tab is active just to know whether to show it — a real layering
 * violation for what a tab-local button delivers just as well.
 */

import { useEffect } from 'react';
import { Button, ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@apelles/ui';
import { PanelRight } from 'lucide-react';

import { EditorInspectorPanel } from './EditorInspectorPanel';
import { PreviewPane } from './PreviewPane';
import { CaptionInspectorPanel } from './CaptionInspectorPanel';
import { TextClipInspectorPanel } from './TextClipInspectorPanel';
import { AdjustmentClipInspectorPanel } from './AdjustmentClipInspectorPanel';
import { TimelinePane } from './TimelinePane';
import { TimelineSwitcher } from './TimelineSwitcher';
import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';

// D-208 — widened from 280/220: every Transform and Crop row now carries its
// own keyframe nav + stopwatch diamond + reset (four `icon-xs` buttons, 96px)
// alongside its label and number field, which no longer fits the old default
// without the field itself being squeezed. Still fully user-resizable, and
// the max is unchanged.
const INSPECTOR_DEFAULT_WIDTH = 320;
const INSPECTOR_MIN_WIDTH = 264;
const INSPECTOR_MAX_WIDTH = 420;

// Roadmap 25 — the preview/timeline split was a fixed `h-[46%]` flex row, not
// a real `ResizablePanel`, in violation of this repo's own standing rule
// ("every resizable-by-nature panel/pane/sidebar must actually be
// resizable" — CLAUDE.md) and reported live by the owner ("the timeline
// panel is also not resizable"). Same vertical-`PanelGroup` convention
// `MotionTab.tsx` already uses for its own preview/timeline split, same
// pixel-based sizing this file already uses for the Inspector column.
const PREVIEW_MIN_HEIGHT = 200;
const TIMELINE_DEFAULT_HEIGHT = 320;
const TIMELINE_MIN_HEIGHT = 180;

export function EditorTab() {
  const load = useEditorTimelineStore((s) => s.load);
  const projectOpen = useEditorTimelineStore((s) => s.openProjectKey !== null);
  const status = useEditorTimelineStore((s) => s.status);
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const error = useEditorTimelineStore((s) => s.error);
  // D-219 — the Inspector's open/closed flag lives in the store now, not in a
  // `useState` here, so the human's toggle below and the debug UI-state op
  // `debug_set_editor_inspector` drive one piece of state rather than two.
  const inspectorOpen = useEditorTimelineStore((s) => s.inspectorOpen);
  const setInspectorOpen = useEditorTimelineStore((s) => s.setInspectorOpen);

  // D-183 — the Edit tab's own control-server surface (see
  // `useEditorControl.ts`'s own module doc comment for the full
  // architecture). Mounted unconditionally here, the same "reachable
  // regardless of which tab has focus" guarantee `useChromaControl()`
  // (`App.tsx`) and `useMotionControl()` (`MotionTab.tsx`) already rely on
  // — `EditorTab`, like every other tab body, stays mounted from boot
  // (B-007). No arguments — see that hook's own doc comment for why.
  useEditorControl();

  // Re-check when the window regains focus — the project may have changed
  // out from under us. Safe to fire freely now: `load()` is token-guarded, so
  // a focus-triggered refetch that fails can no longer clobber good state.
  useEffect(() => {
    const onFocus = () => {
      if (useEditorTimelineStore.getState().openProjectKey !== null) void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  if (!projectOpen) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">No project open</h1>
        <p className="text-sm text-text-secondary max-w-md">
          Open a project in the Colorist tab — its shots become the Edit timeline.
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">Couldn’t load the timeline</h1>
        <p className="text-sm text-text-secondary max-w-md">
          The project is open, but reading its timeline failed. Retrying didn’t help either.
        </p>
        {error && <p className="text-[11px] text-text-secondary/60 max-w-md break-words">{error}</p>}
        <Button className="mt-2" onClick={() => load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!timeline) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <p className="text-sm text-text-secondary">Loading timeline…</p>
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full w-full min-h-0 bg-bg-primary">
      {/* D-263 — the library rail used to be rendered here, as this group's
          first child, which put it to the RIGHT of the shell-level Sources
          column it is supposed to switch. It is now injected into the shell as
          this tab's `libraryRail` (`Root.tsx` → `Shell.tsx`), so the whole
          left edge reads rail → library column → this tab's content, and it
          stays owned by this package. See `EditLibraryRail.tsx`'s module doc
          and D-263 for why that slot rather than a `Shell` import. */}
      <ResizablePanel className="min-w-0 flex flex-col min-h-0">
        <ResizablePanelGroup orientation="vertical" className="flex-1 min-h-0">
          <ResizablePanel minSize={PREVIEW_MIN_HEIGHT} className="flex flex-col min-h-0">
            <div className="flex-1 min-h-0 flex flex-col relative">
              {/* D-249 put Export in this pane's own top strip (`Player`'s
                  `menu` slot via `PreviewPane`'s now-removed `headerActions`
                  prop); D-251 moved it again, out of this tab entirely, to
                  `@apelles/shell`'s chrome bar beside the tab switcher — see
                  `Root.tsx`'s `headerAction` wiring and `Shell.tsx`'s own
                  module doc. Nothing left in this tab renders it. */}
              <PreviewPane />
              {/* D-118 — the Inspector's own opener: tab-local (see this file's
                  module doc for why it isn't a `Shell.tsx` chrome-bar button
                  like Sources'), placed at the preview's top-right so it reads
                  as "the same corner Sources' own toggle lives in," just scoped
                  to this tab. A real elevated chip, not a transparent `ghost`
                  button — it floats directly over the `Player`'s own title
                  strip ("Timeline"), and Shell's matching Sources toggle hit the
                  identical crowding problem for the same reason (see its own
                  comment in `Shell.tsx`). */}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setInspectorOpen(!inspectorOpen)}
                title="Inspector"
                aria-label="Inspector"
                aria-pressed={inspectorOpen}
                className={
                  'absolute top-2 right-2 h-6 w-6 p-0 z-10 rounded-md border border-border-color bg-surface/90 shadow-sm backdrop-blur-sm ' +
                  (inspectorOpen ? 'text-accent' : 'text-text-secondary hover:text-text-primary')
                }
              >
                <PanelRight className="size-3.5" />
              </Button>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel
            defaultSize={TIMELINE_DEFAULT_HEIGHT}
            minSize={TIMELINE_MIN_HEIGHT}
            className="shrink-0 border-t border-border-color flex flex-col min-h-0"
          >
            {/* D-229/D-243 held the Captions panel and D-238's
                transcript-driven alternative here, in a bare strip beside the
                timeline switcher. D-248 moved both into the left library
                rail's Subtitles entry: they create a whole subtitle TRACK,
                which is a library-shaped action rather than a per-timeline
                one, and the owner asked for exactly that ("add caption from
                transcript / subtitle here", drawn on the left edge). What is
                left is the timeline switcher itself, which really is a
                property of this pane. */}
            <div className="flex shrink-0 items-center justify-between gap-2">
              <TimelineSwitcher />
            </div>
            <div className="flex-1 min-h-0">
              <TimelinePane />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>

      {inspectorOpen && (
        <>
          <ResizableHandle />
          <ResizablePanel
            // D-219 — a stable, human-readable hook for the debug DOM-tree
            // dump (`debug_dom_tree {selector}`) and for any future
            // targeted query. Not a test-only artefact: it is the one thing
            // that lets a tool ask about "the Inspector" without matching on
            // a Tailwind class string that changes whenever the styling does.
            data-chroma-panel="editor-inspector"
            defaultSize={INSPECTOR_DEFAULT_WIDTH}
            minSize={INSPECTOR_MIN_WIDTH}
            maxSize={INSPECTOR_MAX_WIDTH}
            className="shrink-0 h-full border-l border-border-color bg-surface overflow-hidden"
          >
            {/* D-211 — a TEXT clip's own Title section (content/font/size/
                colour) stacks ABOVE the geometry Inspector rather than being
                folded into it: different fields, a different write op
                (`set_text_clip`), and only ever relevant for one kind of
                clip. Stacking is also what keeps the shared half genuinely
                shared — a title's Opacity and Position rows, with their
                D-208 keyframe diamonds, are `ClipInspectorPanel`'s existing
                rows rendered underneath, not a second copy. Renders `null`
                for any other selection, so it costs nothing when no title is
                selected. */}
            <div className="flex h-full flex-col min-h-0">
              <TextClipInspectorPanel />
              {/* D-229 — mounted unconditionally; renders null unless the
                  selection is exactly one caption, exactly like the title
                  panel above it. */}
              <CaptionInspectorPanel />
              {/* D-230 — the same stacking, for the same reasons, for an
                  adjustment clip's correction. The two are mutually exclusive
                  by construction (a clip cannot be both), so only ever one of
                  them renders anything. */}
              <AdjustmentClipInspectorPanel />
              <div className="flex-1 min-h-0">
                <EditorInspectorPanel />
              </div>
            </div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
