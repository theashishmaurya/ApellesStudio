/**
 * @apelles/editor — the Edit tab (D-041).
 *
 * The open project's multi-track timeline, its live preview, the media
 * browser and the clip Inspector, laid out in the Final Cut Pro arrangement
 * (D-432 P5, `docs/notes/ui-redesign.md` §4.1): browser | viewer | Inspector in
 * the upper band, the timeline across the full window width beneath them.
 *
 * A project must be open (via the D-037 launcher) for the timeline to have
 * clips.
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
 * **Layout (D-432 P5).** Before P5 the timeline sat in the centre column under
 * the viewer only, the shell drew the media pool as a full-height column to
 * its left, a 44 px icon rail (D-263) sat left of that, and the Inspector took
 * the full height on the right (D-118), so at 1440 px the timeline lost about
 * 600 px of width (§6 #21). Now:
 * - The browser (`EditBrowser`) is this tab's own upper-left panel, with the
 *   rail's eight libraries as its tab bar. The shared media pool node still
 *   comes from the composition root (`mediaPool`, `app/`'s `SourcesPanel`),
 *   and `Shell` draws no docked column for this tab (`ShellTab.
 *   ownsLibraryColumn`).
 * - The Inspector stays Edit-tab-local (D-118's reasoning) and its toggle,
 *   with the browser's, sits in the viewer header (spec §4.11) instead of
 *   floating over the picture.
 * - Every split is a `ResizablePanel` and its released size persists through
 *   `editLayout.ts`.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  BrandedLoader,
  Button,
  PanelErrorBoundary,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type LayoutChangedMeta,
  type PanelImperativeHandle,
  type PanelSize,
} from '@apelles/ui';
import { SidebarSimpleIcon } from '@phosphor-icons/react';

import { EditorInspectorPanel } from './EditorInspectorPanel';
import { EditBrowser } from './EditBrowser';
import { PreviewPane } from './PreviewPane';
import { CaptionInspectorPanel } from './CaptionInspectorPanel';
import { TextClipInspectorPanel } from './TextClipInspectorPanel';
import { AdjustmentClipInspectorPanel } from './AdjustmentClipInspectorPanel';
import { TimelinePane } from './TimelinePane';
import { TimelineSwitcher } from './TimelineSwitcher';
import { TimelineSwitchOverlay } from './TimelineSwitchOverlay';
import { PlayheadTimecode } from './PlayheadTimecode';
import { useEditorTimelineStore } from './timelineStore';
import { useEditorControl } from './useEditorControl';
import {
  BROWSER_WIDTH,
  INSPECTOR_WIDTH,
  TIMELINE_DEFAULT_PERCENT,
  TIMELINE_HEIGHT,
  UPPER_MIN_HEIGHT,
  VIEWER_MIN_WIDTH,
  useEditLayoutStore,
  type EditLayout,
} from './editLayout';
import { registerBrandApplier } from '@apelles/brand';
import { applyBrandToEdit } from './brandEdit';

/** Stable panel ids: `react-resizable-panels` keys its layout by them. */
const PANEL_ID = {
  upper: 'edit-upper',
  timeline: 'edit-timeline',
  browser: 'edit-browser',
  viewer: 'edit-viewer',
  inspector: 'edit-inspector',
} as const;

/** A store write within this many pixels of the live panel is not re-applied
 *  (the store rounds; the panel reports fractions). */
const RESIZE_TOLERANCE_PX = 1;

/** The centre of the timeline toolbar (spec §4.9): the timeline switcher, then
 *  the playhead timecode. Handed to `TimelinePane` as a slot, and drawn as its
 *  own row while the timeline has no tracks (the pane then shows only its
 *  empty state, which has no toolbar). */
function TimelineToolbarCenter() {
  return (
    <div className="flex items-center gap-3">
      <TimelineSwitcher />
      <PlayheadTimecode withDuration />
    </div>
  );
}

/** A 24 px icon toggle in the viewer header (browser / Inspector). */
function PanelToggle({
  label,
  pressed,
  onToggle,
  mirrored,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  mirrored?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={'h-6 w-6 p-0 ' + (pressed ? 'text-accent-text' : 'text-text-secondary hover:text-text-primary')}
    >
      {/* D-300 — Phosphor's one sidebar glyph is left-handed; the Inspector
          toggle mirrors it so each glyph points at its own panel. */}
      <SidebarSimpleIcon className="size-4" mirrored={mirrored} />
    </Button>
  );
}

export interface EditorTabProps {
  /** The shared media pool (`app/`'s `SourcesPanel`), shown on the browser's
   *  Sources tab. Injected by the composition root (`Root.tsx`): this package
   *  must not import `app/` (D-039). */
  mediaPool?: ReactNode;
  /** v0.3.0 — the browser tab row's right end (`EditBrowser.tabRowEnd`): the
   *  root's Import button. */
  browserActions?: ReactNode;
}

export function EditorTab({ mediaPool, browserActions }: EditorTabProps) {
  const load = useEditorTimelineStore((s) => s.load);
  const projectOpen = useEditorTimelineStore((s) => s.openProjectKey !== null);
  const status = useEditorTimelineStore((s) => s.status);
  // D-437 S10 — whether a timeline is loaded, not the timeline itself: the
  // whole object changes on every edit, and selecting it re-rendered this tab
  // (its resizable panel group and every panel's props) on each release.
  const hasTimeline = useEditorTimelineStore((s) => s.timeline !== null);
  const error = useEditorTimelineStore((s) => s.error);
  // D-219 — the Inspector's open/closed flag lives in the store, so the
  // human's toggle and `debug_set_editor_inspector` drive one piece of state.
  const inspectorOpen = useEditorTimelineStore((s) => s.inspectorOpen);
  const setInspectorOpen = useEditorTimelineStore((s) => s.setInspectorOpen);
  const hasTracks = useEditorTimelineStore((s) => (s.timeline?.tracks.length ?? 0) > 0);
  // D-432 P5 — the browser's flag and the persisted split sizes.
  const browserOpen = useEditLayoutStore((s) => s.browserOpen);
  const setBrowserOpen = useEditLayoutStore((s) => s.setBrowserOpen);
  const layout = useLayoutSizes();

  // D-183 — the Edit tab's own control-server surface (see
  // `useEditorControl.ts`'s own module doc comment for the full
  // architecture). Mounted unconditionally here, the same "reachable
  // regardless of which tab has focus" guarantee `useChromaControl()`
  // (`App.tsx`) and `useMotionControl()` (`MotionTab.tsx`) already rely on
  // — `EditorTab`, like every other tab body, stays mounted from boot
  // (B-007). No arguments — see that hook's own doc comment for why.
  useEditorControl();

  // D-416 — this tab's brand applier (captions and titles, one undo step).
  useEffect(() => registerBrandApplier('edit', applyBrandToEdit), []);

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
        {error && <p className="text-xs text-text-tertiary max-w-md break-words">{error}</p>}
        <Button className="mt-2" onClick={() => load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!hasTimeline) {
    // B-369 — the branded loader, the same one a project open shows.
    return (
      <div className="h-full w-full bg-bg-primary">
        <BrandedLoader variant="inline" label="Loading timeline…" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full min-h-0">
      <ResizablePanelGroup
        orientation="vertical"
        className="h-full w-full min-h-0 bg-bg-primary"
        onLayoutChanged={layout.onVerticalLayoutChanged}
      >
        <ResizablePanel
          id={PANEL_ID.upper}
          data-chroma-panel="edit-upper"
          minSize={UPPER_MIN_HEIGHT}
          className="flex min-h-0 flex-col"
        >
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
            onLayoutChanged={layout.onHorizontalLayoutChanged}
          >
            {browserOpen && (
              <>
                <ResizablePanel
                  id={PANEL_ID.browser}
                  // The docked library column's long-standing hook (D-219), kept
                  // for every debug recipe that asks for "sources".
                  data-chroma-panel="sources"
                  panelRef={layout.browserRef}
                  onResize={layout.onBrowserResize}
                  defaultSize={layout.initial.browserWidth}
                  minSize={BROWSER_WIDTH.min}
                  maxSize={BROWSER_WIDTH.max}
                  className="h-full min-h-0 overflow-hidden bg-surface"
                >
                  <EditBrowser mediaPool={mediaPool} tabRowEnd={browserActions} />
                </ResizablePanel>
                <ResizableHandle className="bg-divider" />
              </>
            )}
            <ResizablePanel
              id={PANEL_ID.viewer}
              data-chroma-panel="edit-viewer"
              minSize={VIEWER_MIN_WIDTH}
              className="flex min-h-0 min-w-0 flex-col"
            >
              {/* B-292 — each pane crashes alone. `useEditorControl()` above is
                  deliberately OUTSIDE every pane boundary, so the `editor_*` ops
                  keep answering while a pane shows its fallback. */}
              <PanelErrorBoundary panel="Preview">
                <PreviewPane
                  headerStart={
                    <PanelToggle
                      label={browserOpen ? 'Hide the browser' : 'Show the browser'}
                      pressed={browserOpen}
                      onToggle={() => setBrowserOpen(!browserOpen)}
                    />
                  }
                  headerEnd={
                    // D-118 — the Inspector's opener, now in the viewer header's
                    // right group (spec §4.11) rather than a chip floating over
                    // the picture's corner.
                    <PanelToggle
                      label="Inspector"
                      pressed={inspectorOpen}
                      onToggle={() => setInspectorOpen(!inspectorOpen)}
                      mirrored
                    />
                  }
                />
              </PanelErrorBoundary>
            </ResizablePanel>
            {inspectorOpen && (
              <>
                <ResizableHandle className="bg-divider" />
                <ResizablePanel
                  id={PANEL_ID.inspector}
                  // D-219 — a stable, human-readable hook for `debug_dom_tree`.
                  data-chroma-panel="editor-inspector"
                  panelRef={layout.inspectorRef}
                  onResize={layout.onInspectorResize}
                  defaultSize={layout.initial.inspectorWidth}
                  minSize={INSPECTOR_WIDTH.min}
                  maxSize={INSPECTOR_WIDTH.max}
                  className="h-full overflow-hidden bg-surface"
                >
                  {/* D-211 / D-229 / D-230 — a title's, a caption's or an
                      adjustment clip's own section stacks ABOVE the shared
                      geometry Inspector; each renders `null` for any other
                      selection, and they are mutually exclusive by construction. */}
                  <PanelErrorBoundary panel="Inspector">
                    <div className="flex h-full min-h-0 flex-col">
                      <TextClipInspectorPanel />
                      <CaptionInspectorPanel />
                      <AdjustmentClipInspectorPanel />
                      <div className="min-h-0 flex-1">
                        <EditorInspectorPanel />
                      </div>
                    </div>
                  </PanelErrorBoundary>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle className="bg-divider" />

        <ResizablePanel
          id={PANEL_ID.timeline}
          data-chroma-panel="edit-timeline"
          panelRef={layout.timelineRef}
          onResize={layout.onTimelineResize}
          defaultSize={layout.initial.timelineHeight ?? `${TIMELINE_DEFAULT_PERCENT}%`}
          minSize={TIMELINE_HEIGHT.min}
          className="flex min-h-0 flex-col"
        >
          <PanelErrorBoundary panel="Timeline">
            {!hasTracks && (
              <div className="flex h-9 shrink-0 items-center justify-center border-b border-border-color bg-surface">
                <TimelineToolbarCenter />
              </div>
            )}
            <div className="min-h-0 flex-1">
              <TimelinePane toolbarCenter={<TimelineToolbarCenter />} />
            </div>
          </PanelErrorBoundary>
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* B-369 — the branded loader over the tab while a timeline switch loads. */}
      <TimelineSwitchOverlay />
    </div>
  );
}

/**
 * The bridge between the live panels and `useEditLayoutStore` (D-432 P5).
 *
 * - **Into the store:** each panel's `onResize` records its pixel size in a
 *   ref (no render); the group's `onLayoutChanged` commits those sizes only
 *   when `isUserInteraction` — a released drag or a keyboard resize — so a
 *   mount, a window resize or a panel opening never rewrites the saved sizes.
 * - **Out of the store:** a write that did not come from the user (a debug op,
 *   a late settings hydrate) is applied to the live panels with their
 *   imperative `resize`.
 */
function useLayoutSizes() {
  const browserRef = useRef<PanelImperativeHandle | null>(null);
  const inspectorRef = useRef<PanelImperativeHandle | null>(null);
  const timelineRef = useRef<PanelImperativeHandle | null>(null);
  const live = useRef<{ browser: number | null; inspector: number | null; timeline: number | null }>({
    browser: null,
    inspector: null,
    timeline: null,
  });
  // The sizes a panel mounts at. Selected (not read once) so a panel that
  // opens later mounts at the latest saved size; a write re-renders only this
  // tab's shell, never the panes inside it (they subscribe to nothing here).
  const browserWidth = useEditLayoutStore((s) => s.browserWidth);
  const inspectorWidth = useEditLayoutStore((s) => s.inspectorWidth);
  const timelineHeight = useEditLayoutStore((s) => s.timelineHeight);

  const onBrowserResize = useCallback((size: PanelSize) => {
    live.current.browser = size.inPixels;
  }, []);
  const onInspectorResize = useCallback((size: PanelSize) => {
    live.current.inspector = size.inPixels;
  }, []);
  const onTimelineResize = useCallback((size: PanelSize) => {
    live.current.timeline = size.inPixels;
  }, []);

  const onHorizontalLayoutChanged = useCallback((_layout: unknown, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const patch: Partial<EditLayout> = {};
    if (browserRef.current && live.current.browser !== null) patch.browserWidth = live.current.browser;
    if (inspectorRef.current && live.current.inspector !== null) patch.inspectorWidth = live.current.inspector;
    useEditLayoutStore.getState().setLayout(patch, 'user');
  }, []);
  const onVerticalLayoutChanged = useCallback((_layout: unknown, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction || live.current.timeline === null) return;
    useEditLayoutStore.getState().setLayout({ timelineHeight: live.current.timeline }, 'user');
  }, []);

  useEffect(
    () =>
      useEditLayoutStore.subscribe((next, prev) => {
        if (next.revision === prev.revision || next.lastSource === 'user') return;
        const apply = (ref: PanelImperativeHandle | null, px: number | null) => {
          if (!ref || px === null) return;
          if (Math.abs(ref.getSize().inPixels - px) > RESIZE_TOLERANCE_PX) ref.resize(px);
        };
        apply(browserRef.current, next.browserWidth);
        apply(inspectorRef.current, next.inspectorWidth);
        // `null` = back to the default share (a debug reset).
        if (next.timelineHeight === null && prev.timelineHeight !== null) {
          timelineRef.current?.resize(`${TIMELINE_DEFAULT_PERCENT}%`);
        } else {
          apply(timelineRef.current, next.timelineHeight);
        }
      }),
    [],
  );

  return {
    browserRef,
    inspectorRef,
    timelineRef,
    initial: { browserWidth, inspectorWidth, timelineHeight },
    onBrowserResize,
    onInspectorResize,
    onTimelineResize,
    onHorizontalLayoutChanged,
    onVerticalLayoutChanged,
  };
}
