/**
 * @chroma/shell — the 3-tab layout + window chrome (D-039).
 *
 * The top bar is the window title bar (the app runs `decorations: false`):
 * left = macOS traffic lights + the CHROMA wordmark; centre = the tabs
 * (Edit / Motion / Colorist), absolutely centred; right = Windows/Linux window
 * controls (a matching spacer on macOS so the centre stays true). The bar is a
 * `data-tauri-drag-region` except the buttons and tabs. See `WindowChrome.tsx`
 * for the ported platform logic.
 *
 * Tab content is injected by the caller through the `tabs` registry prop, so
 * this package depends only on react + zustand + Tauri (the shell owns the
 * chrome now) — never on the colorist app or the editor/motion packages.
 *
 * Layout contract: the shell is a flex column filling its parent. The tab bar
 * is `shrink-0` (h-10); the content area is `flex-1 min-h-0 overflow-hidden`.
 * Every tab stays mounted (state is preserved across switches); inactive tabs
 * are `hidden`. A tab whose content assumes it owns the whole window (the
 * Colorist app) should size its root with `h-full`, not `h-screen`.
 *
 * On macOS, windowed, the shell root carries `.macos-window-shell` (14px
 * rounded corners + clip) — before D-039 that class was on the Colorist app
 * root; the whole window is the shell's now.
 *
 * Keyboard: Cmd/Ctrl+1 / +2 / +3 switch tabs (only while a project is open).
 *
 * Global undo/redo (D-051): Cmd/Ctrl+Z undoes, Cmd/Ctrl+Y **or**
 * Cmd/Ctrl+Shift+Z redoes (the codebase's existing Colorist-only keybind
 * already used Ctrl+Y — `app/src/utils/keyboardUtils.ts` — kept as the
 * primary redo combo for consistency; Cmd+Shift+Z accepted too since it's
 * the platform convention on macOS and costs nothing to also support). Both
 * pop `@chroma/history`'s shared stack regardless of which tab is active,
 * and — the real UX decision here, see D-051 — **switch the active tab** to
 * whichever tab the undone/redone entry belongs to, so the user always sees
 * the effect of the undo/redo they just triggered rather than it applying
 * silently behind a different tab. Skipped while a text input/textarea/
 * contenteditable has focus, so native text-field undo isn't hijacked.
 *
 * Project gating (D-039): the shell renders `launcher` (passed in — the shell
 * never imports the D-037 `ProjectLauncher`, dependency direction is app →
 * shell) full-window whenever `projectOpen` is false, with the tab buttons
 * hidden — just traffic lights + wordmark + window controls in the chrome bar.
 * Once a project opens, the tabs appear plus a "‹ Projects" button that calls
 * `onCloseProject`. Tab panels stay mounted underneath the launcher (hidden) so
 * the Colorist app's MCP control bridge keeps running.
 *
 * Docked Sources panel (D-046 pass 3; moved to the left + made resizable,
 * D-116): same injection pattern as `launcher` — the shell renders whatever
 * `sourcesPanel` node is passed in (never imports the D-046 `SourcesPanel`
 * itself, for the same app → shell dependency-direction reason), as a real
 * resizable column (`@chroma/ui`'s `ResizablePanelGroup`, matching this
 * project's standing "every resizable-by-nature panel must actually be
 * resizable" rule) to the **left** of the tab content, toggled by a button
 * anchored to the content area's own top-left corner (D-120 — moved off the
 * chrome bar, which read as disconnected from the panel once it sat on the
 * opposite side from its own opener). Collapsed by default so it never disrupts Colorist's
 * own left/right panel system or Editor's timeline pane — it's a sibling of
 * the tab content area, not layered over it, and its own opaque background
 * means it plays fine alongside the wgpu-transparent root (B-006). Left
 * placement matches the convention every professional NLE reference uses
 * (Premiere, Resolve, Final Cut, Palmier Pro all dock the media bin left) —
 * each tab's own properties/inspector panel already anchors to *its own*
 * right edge (Colorist's `ControlsPanel`, Edit's `ClipInspectorPanel`,
 * Motion's `InspectorPanel`), so moving Sources out of the shell's
 * right-most slot to the left-most one is the only shell-level change
 * needed — those panels were never positioned relative to Sources itself
 * (verified: no `SOURCES_PANEL_WIDTH`/`sourcesPanelOpen` reference exists
 * outside this package), so they naturally read as "on the right" once
 * Sources vacates that slot.
 *
 * Per-tab library rail (D-263): each `ShellTab` may also carry a
 * `libraryRail` node and a `libraryPanel` node. The rail renders as the
 * LEFTMOST column of the content area — left of the docked column above — and
 * the panel renders INSIDE that column in place of `sourcesPanel`, both only
 * while that tab is active. This is the same injection slot, with the same
 * reasoning, as `headerAction` below: the Edit tab's library rail
 * (`@chroma/editor`'s `EditLibraryRail`) is tab-local content that has to sit
 * at a specific position relative to a panel the SHELL owns, which reordering
 * anything inside `EditorTab.tsx` could never achieve — it was rendering to
 * the right of the very column it switches. `Shell` still imports nothing from
 * the tab packages and learns nothing about what a tab's libraries are: it
 * renders the nodes it is handed, and "no `libraryPanel` this render" simply
 * means the shared Sources panel shows. The docked column keeps its
 * `data-chroma-panel="sources"` hook (same column, same name every doc and
 * debug recipe already uses) and the shared `sourcesPanel` stays MOUNTED but
 * hidden while a tab's own library shows, so its search/bin state survives.
 *
 * Per-tab chrome-bar action (D-251): each `ShellTab` may carry a
 * `headerAction` node, rendered in the top bar's own right-hand cluster
 * (left of the window controls) ONLY while that tab is the active one. This
 * is a deliberate, owner-directed narrowing of D-118's "`Shell` stays
 * tab-agnostic" rule, not a silent reversal of it — the owner asked, live,
 * for Export to sit at the very top, beside the tab switcher, after seeing
 * D-249 land it in the Edit tab's own top strip instead. D-118 kept the
 * Inspector toggle tab-local specifically because making it shell-level
 * would need `Shell` to know which tab is active just to decide whether to
 * render it; `Shell` already has to know that regardless (it is exactly how
 * the tab **content** below is switched, `tabs.map` + `hidden` below), so
 * this is `Shell` finally acting on information it already held, for the
 * one case the owner explicitly asked to see there. The injected node itself
 * is still owned entirely by whichever package built it (`@chroma/editor`'s
 * `EditorExportDialog` today) and supplied by the composition root
 * (`Root.tsx`) exactly like `launcher`/`sourcesPanel` above — `Shell` never
 * imports `@chroma/editor` itself, so the "shell depends only on
 * react + zustand + Tauri" boundary this package's own `package.json`
 * describes is unchanged; only the *behavioral* tab-agnostic rule narrows,
 * and only for this one slot. Colorist and Motion have no export action of
 * their own today (checked directly: no "Export" UI anywhere in `app/src`
 * outside Colorist's own per-image `ExportDialog`/`ExportPanel`, which are
 * unrelated, differently-scoped actions triggered from Colorist's own
 * toolbar/BottomBar — and none at all in `packages/motion`), so only the
 * `edit` tab entry populates `headerAction` for now; the field stays generic
 * (keyed by whichever tab is active) so Motion/Colorist can grow their own
 * later without another `Shell` change.
 */

import { useEffect, type ReactNode } from 'react';
import { ChevronLeft, PanelLeft } from 'lucide-react';
import { Button, ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@chroma/ui';
import { useHistoryStore } from '@chroma/history';
import { useShellStore, type ShellTabId } from './store';
import { useWindowChrome, MacTrafficLights, WindowControls } from './WindowChrome';

export interface ShellTab {
  id: ShellTabId;
  label: string;
  icon?: ReactNode;
  element: ReactNode;
  /** D-251 — rendered in the chrome bar's own right-hand cluster, beside the
   *  window controls, ONLY while this tab is active. See this file's own
   *  module doc ("Per-tab chrome-bar action") for why this exists and why it
   *  doesn't reopen `@chroma/shell`'s "never imports the tab packages" rule.
   *  Omit for a tab with no such action (Motion/Colorist today). */
  headerAction?: ReactNode;
  /** D-263 — this tab's own icon rail, rendered as the LEFTMOST column of the
   *  content area (left of the docked library column), ONLY while this tab is
   *  active. Same injection slot and same reasoning as `headerAction` above;
   *  see this file's "Per-tab library rail" doc section. A tab that supplies
   *  one owns the docked column's toggle itself, so the shell's own floating
   *  Sources chip is not drawn for it. Omit for a tab with no rail
   *  (Motion/Colorist today). */
  libraryRail?: ReactNode;
  /** D-263 — content this tab puts in the docked library column INSTEAD of
   *  the shared `sourcesPanel`, while this tab is active.
   *
   *  Supply the node only while the tab is actually taking the column over:
   *  `undefined` means "show the shared media pool", which is what the Edit
   *  tab's `sources` library mode is. `Root.tsx` (which owns both the mode and
   *  both nodes) is where that choice is made — the shell deliberately does
   *  not learn what a tab's library modes are called. */
  libraryPanel?: ReactNode;
}

export interface ShellProps {
  tabs: ShellTab[];
  /** true once a project (or Untitled session) is open — the tabs + content
   *  show; false renders `launcher` full-window with no tab buttons. */
  projectOpen: boolean;
  /** the D-037 project launcher, injected by the caller (app → shell only). */
  launcher: ReactNode;
  /** "‹ Projects" — close the current project, back to the launcher. */
  onCloseProject?: () => void;
  /** the D-046 Sources/Library panel, injected by the caller (app → shell
   *  only, same reasoning as `launcher`). Docked to the right of the tab
   *  content, toggled via a chrome-bar button; omit to run without one. */
  sourcesPanel?: ReactNode;
}

// D-116: default/min/max for the Sources column's `ResizablePanel` — same
// default width the old fixed column used (288), a min that keeps the
// media grid usable (a poster-frame thumbnail + label needs real room), a
// max that stops it from swallowing the tab content on a wide window.
const SOURCES_PANEL_DEFAULT_WIDTH = 288;
const SOURCES_PANEL_MIN_WIDTH = 220;
const SOURCES_PANEL_MAX_WIDTH = 480;

export function Shell({ tabs, projectOpen, launcher, onCloseProject, sourcesPanel }: ShellProps) {
  const activeTab = useShellStore((s) => s.activeTab);
  const setActiveTab = useShellStore((s) => s.setActiveTab);
  const wgpuSurfaceActive = useShellStore((s) => s.wgpuSurfaceActive);
  const sourcesPanelOpen = useShellStore((s) => s.sourcesPanelOpen);
  const setSourcesPanelOpen = useShellStore((s) => s.setSourcesPanelOpen);
  const chrome = useWindowChrome();

  // If persisted/default tab isn't in the registry, fall back to the first tab.
  const active = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0]?.id;
  const activeTabEntry = projectOpen ? tabs.find((t) => t.id === active) : undefined;
  // D-251 — the active tab's own chrome-bar action, if it registered one.
  // `undefined` renders nothing (Motion/Colorist today), and switching tabs
  // switches which node (if any) shows here, same as the tab content below.
  const activeHeaderAction = activeTabEntry?.headerAction;
  // D-263 — the same, for the active tab's left icon rail and for the content
  // it puts in the docked library column in place of the shared media pool.
  const activeLibraryRail = activeTabEntry?.libraryRail;
  const activeLibraryPanel = activeTabEntry?.libraryPanel;

  useEffect(() => {
    if (!projectOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const idx = { '1': 0, '2': 1, '3': 2 }[e.key];
      if (idx === undefined) return;
      const tab = tabs[idx];
      if (!tab) return;
      e.preventDefault();
      setActiveTab(tab.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tabs, setActiveTab, projectOpen]);

  // D-051 — global undo/redo, see the module doc comment above.
  useEffect(() => {
    if (!projectOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;

      const key = e.key.toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      if (!isUndo && !isRedo) return;

      const el = document.activeElement;
      const isTextInput =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (isTextInput) return;

      e.preventDefault();
      const entry = isUndo ? useHistoryStore.getState().undo() : useHistoryStore.getState().redo();
      if (entry && tabs.some((t) => t.id === entry.tab) && entry.tab !== active) {
        setActiveTab(entry.tab as ShellTabId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tabs, active, setActiveTab, projectOpen]);

  return (
    <div
      className={
        'flex flex-col h-full w-full text-text-primary overflow-hidden ' +
        // B-006: a tab (Colorist) drawing straight onto the native window via a
        // wgpu surface needs this root to go transparent too, or its own opaque
        // background sits in front of the surface and blocks it from ever
        // showing through the tab's own transparent "hole". The tab bar and the
        // launcher overlay below both paint their own explicit backgrounds, so
        // they stay opaque either way.
        (wgpuSurfaceActive ? 'bg-transparent' : 'bg-bg-primary') +
        ' ' +
        (chrome.useMacWindowShell ? 'macos-window-shell' : '')
      }
    >
      <div
        data-tauri-drag-region
        className="shrink-0 h-10 flex items-center gap-1 px-2 bg-surface border-b border-border-color select-none relative"
      >
        {/* left: traffic lights (mac) + wordmark */}
        <MacTrafficLights show={chrome.isMac && !chrome.isMobile} />
        <div className="flex items-center pr-2 text-[11px] font-semibold tracking-wide text-text-secondary/70 pointer-events-none">
          CHROMA
        </div>

        {/* left (project open): back to the launcher */}
        {projectOpen && onCloseProject && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onCloseProject}
            title="Close project — back to all projects"
            className="h-6 gap-1 text-text-secondary hover:text-text-primary"
          >
            <ChevronLeft className="size-3" /> Projects
          </Button>
        )}

        {/* centre: the tabs, absolutely centred (only while a project is open) */}
        {projectOpen && (
          <div
            role="tablist"
            aria-label="Chroma tabs"
            className="absolute left-1/2 -translate-x-1/2 flex items-stretch h-full gap-1"
          >
            {tabs.map((tab) => {
              const isActive = tab.id === active;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  type="button"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.id)}
                  className={
                    'relative flex items-center gap-1.5 px-3 text-xs font-medium transition-colors ' +
                    (isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary')
                  }
                >
                  {tab.icon}
                  {tab.label}
                  <span
                    className={
                      'absolute left-2 right-2 bottom-0 h-0.5 rounded-full transition-colors ' +
                      (isActive ? 'bg-accent' : 'bg-transparent')
                    }
                  />
                </button>
              );
            })}
          </div>
        )}

        {/* right: the active tab's own header action (D-251, e.g. Edit's
            Export), then win/linux controls / mac spacer. The Sources toggle
            used to live here too, but D-116 moved the panel itself to the
            left without moving its opener — leaving it stranded on the
            opposite side from the panel it controls (owner: "the opener
            should be with the source pane"). It's now rendered below, in the
            same top-left corner of the content area the panel actually
            occupies, matching the spatial pattern D-118 established for the
            Inspector's own toggle (opposite corner, same idea). */}
        <div className="ml-auto flex items-center h-full gap-1">
          {activeHeaderAction}
          <WindowControls chrome={chrome} />
        </div>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 overflow-hidden relative">
        {/* D-263 — the active tab's icon rail, LEFTMOST, immediately left of
            the column it switches. A plain fixed-width sibling of the
            resizable columns, not a `ResizablePanel`: whatever a tab puts here
            holds icon buttons and nothing else, exactly the case CLAUDE.md's
            resizable-panels rule exempts. Rendered whether or not that column
            is open — collapsing it is one of the rail's own jobs. */}
        {activeLibraryRail}

        {/* docked library column (D-046's Sources panel; left + resizable,
            D-116; content switchable per-tab, D-263) — a sibling column, never
            layered over the tab content, so it can't fight Colorist's own
            panels or Editor's timeline pane for space. A real
            `ResizablePanel`, not a fixed width, per this project's own
            "resizable-by-nature panels must actually be resizable" rule. */}
        {projectOpen && sourcesPanel && sourcesPanelOpen && (
          <>
            <ResizablePanel
              // D-219 — same stable hook the Edit tab's Inspector carries, so
              // the debug DOM-tree dump can be pointed at this column by name
              // rather than by a Tailwind class string. Still `sources` after
              // D-263 made the column switchable: it is the same column, the
              // name is what every existing doc and debug recipe says, and the
              // Edit tab's own content inside it carries its own
              // `data-chroma-panel="edit-library"` hook.
              data-chroma-panel="sources"
              defaultSize={SOURCES_PANEL_DEFAULT_WIDTH}
              minSize={SOURCES_PANEL_MIN_WIDTH}
              maxSize={SOURCES_PANEL_MAX_WIDTH}
              className="shrink-0 h-full border-r border-border-color bg-surface overflow-hidden"
            >
              {/* D-263 — the shared media pool stays MOUNTED while a tab shows
                  its own library here, hidden rather than unmounted, so its
                  search text, open bin and scroll position survive a trip
                  through the Titles library. Hidden with the same
                  `hidden`-class swap on a wrapper with no other `display`
                  utility that the tab panels below use — never a Base UI
                  primitive that defers the hide to a `requestAnimationFrame`
                  that a non-frontmost window never fires (B-124). */}
              <div className={activeLibraryPanel ? 'hidden' : 'h-full'}>{sourcesPanel}</div>
              {activeLibraryPanel}
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}

        <ResizablePanel className="min-h-0 flex flex-col overflow-hidden relative">
          {/* Sources' own opener (moved here, D-120): sits in the content
              area's top-left corner — right where the Sources panel itself
              lands when open, immediately to this button's left — instead
              of the chrome bar's top-right, which read as disconnected from
              the panel once D-116 moved Sources to the left. Absolutely
              positioned so it's reachable whether the panel is open or
              closed, same as the Inspector's own top-right opener
              (`EditorTab.tsx`, D-118) — the two now form a matching pair in
              opposite corners of the content area, not the "two openers"
              the owner previously found both crowded into one corner. Stays
              here in `Shell.tsx`, not duplicated per-tab, because Sources is
              genuinely shell-level (all three tabs), unlike the Inspector.

              D-263 — NOT drawn on a tab that supplies its own `libraryRail`:
              that rail's own Sources button both selects the media pool and
              collapses the column (VS Code activity-bar semantics, see
              `EditLibraryRail.tsx`), so this chip would be a second control
              for the same panel sitting one step to its right — the exact
              disconnected-opener complaint D-120 exists to answer. Motion and
              Colorist have no rail, so they keep it. */}
          {projectOpen && sourcesPanel && !activeLibraryRail && (
            // A floating control positioned relative to the whole tab-content
            // area (deliberately, D-120 — reachable regardless of which tab
            // is active) will always land directly on top of *some* tab's
            // own top-left content — the Edit tab's `Player` title strip
            // ("Timeline") starts flush at that same corner, and a
            // background-less `ghost` button reads as crowding/overlapping
            // whatever's underneath rather than floating above it. A real
            // elevated chip (background + border + shadow) makes it legible
            // against any tab's content instead of blending into it.
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setSourcesPanelOpen(!sourcesPanelOpen)}
              title="Sources"
              aria-label="Sources"
              aria-pressed={sourcesPanelOpen}
              className={
                'absolute top-2 left-2 h-6 w-6 p-0 z-10 rounded-md border border-border-color bg-surface/90 shadow-sm backdrop-blur-sm ' +
                (sourcesPanelOpen ? 'text-accent' : 'text-text-secondary hover:text-text-primary')
              }
            >
              <PanelLeft className="size-3.5" />
            </Button>
          )}
          {/* tab panels — always mounted (state + the Colorist MCP bridge persist);
              all hidden while the launcher is up. */}
          {tabs.map((tab) => {
            const isActive = projectOpen && tab.id === active;
            return (
              <div key={tab.id} role="tabpanel" className={isActive ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                {tab.element}
              </div>
            );
          })}

          {!projectOpen && <div className="absolute inset-0 flex flex-col bg-bg-primary">{launcher}</div>}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
