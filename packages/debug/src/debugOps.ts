/**
 * debugOps.ts — the `debug_*` frontend op registry (D-219).
 *
 * What it is: the fourth control-server op registry, alongside Colorist's
 *   (`app/src/hooks/useChromaControl.ts`), Motion's and the Edit tab's — same
 *   `chroma://request` / `chroma://response/<id>` event pair, same
 *   namespaced-prefix opt-in convention (`debug_`), same "read back what you
 *   just wrote" reply shape. It holds the ops that DRIVE and INSPECT the
 *   running UI itself rather than any document: which tab is showing, which
 *   panels are open, what the real DOM looks like, and how fast the Edit-tab
 *   preview is actually painting.
 *
 * What it does NOT do: edit a timeline, a grade or a manifest — an op that
 *   changes the user's work belongs in its own tab's registry, not here. Its
 *   STATE setters never synthesise a click, a keypress or a pointer event:
 *   each calls the SAME store action the human's own control calls, which is
 *   the honest way to put the UI into a state. The one deliberate exception is
 *   D-434's `debug_pointer` / `debug_key` (`input/inputOps.ts`), which exist to
 *   test the INPUT HANDLING itself — hit zones, drag thresholds, the keymap —
 *   that a store action skips; on the real app they deliver trusted native
 *   events, not page-made ones.
 *
 * **This whole module is debug-only and never reaches a production build.**
 *   Nothing imports it statically: `useDebugControl.ts` reaches it through a
 *   `import()` inside an `import.meta.env.APELLES_DEBUG_TOOLS` branch, so a production
 *   `vite build` constant-folds that branch away and Rollup drops this module
 *   and its chunk entirely. That is the frontend's equivalent of the
 *   `#[cfg(debug_assertions)]` gate on the Rust half (D-219, B-100), and it is
 *   verified by grepping the built bundle rather than assumed.
 *
 * Ops:
 *   `debug_get_ui_state`          — read every UI-state flag below, plus the
 *                                   open dialogs the DOM actually has,
 *                                   (B-282) the Motion player's custom-layer
 *                                   proxy states and (B-292) every panel
 *                                   showing its crash fallback.
 *   `debug_set_active_tab`        — Edit / Motion / Colorist.
 *   `debug_set_sources_panel`     — the shell's docked Sources column, shown on
 *                                   the Motion and Colorist tabs. The Edit tab
 *                                   lays out its own browser (D-432 P5) and
 *                                   draws no shell column.
 *   `debug_set_library_mode`      — which library the Edit tab's browser shows
 *                                   (its tab bar, which replaced D-263's rail:
 *                                   sources / titles / effects / subtitles /
 *                                   recut / music / clipper / index) AND shows
 *                                   the browser, so the panel is visible.
 *   `debug_set_editor_inspector`  — the Edit tab's Inspector column.
 *   `debug_set_editor_layout`     — D-432 P5. The Edit tab's split sizes
 *                                   (browser / Inspector width, timeline
 *                                   height) and whether the browser shows;
 *                                   reported as `editor.layout`.
 *   `debug_set_inspector_tab`     — that Inspector's Video/Audio/Speed/Info tab (D-246, v0.3.0).
 *   `debug_set_inspector_section` — open / collapse one Inspector section (v0.3.0).
 *   `debug_set_popover_open`      — any registered Edit-tab popover/dialog by
 *                                   id (D-252, `@apelles/editor`'s
 *                                   `panelRegistry.ts`) — the canvas-size
 *                                   popover, the export dialog, and whatever
 *                                   the next one registers, through ONE op
 *                                   rather than a new bespoke op per popover.
 *                                   (D-252's original `caption-panel` id went
 *                                   away with its popover in D-263, which
 *                                   docked that library.) Also the id
 *                                   `agent-activity` (B-341): the chrome-bar
 *                                   Agent activity popover, whose flag lives
 *                                   in the shell store. And `sources-folders`
 *                                   (D-436): the Sources panel's folder list.
 *   `debug_dom_tree`              — bounded DOM dump (see `domTree.ts`).
 *   `debug_frame_timing`          — the Edit-tab preview's real paint
 *                                   intervals, and since D-290 the per-phase
 *                                   COSTS behind them (see `@apelles/editor`'s
 *                                   `previewTiming.ts`). D-330 added an
 *                                   optional `windowMs`, so the same numbers
 *                                   can be read over the same recent window
 *                                   the on-screen overlay displays.
 *   `debug_pointer`               — D-434. Real pointer input (move / down /
 *                                   up / click / double-click / drag along a
 *                                   path / wheel / pinch) at a DOM target or
 *                                   CSS point, with what was hit, what the page
 *                                   received, and optional perf + per-frame
 *                                   rects (`input/inputOps.ts`).
 *   `debug_key`                   — D-434. Real key presses / combos / text.
 *   `debug_overlay_check`         — D-434. Is a fixed overlay over these parts?
 *   `debug_clear_harness_history` — D-434. Drop the harness's own undo entries.
 *   `debug_perf_entries`          — B-347 / D-434. The app's own `performance`
 *                                   marks for the edit gestures (preview /
 *                                   commit-rendered / commit-painted), plus an
 *                                   optional wait for the page to go idle
 *                                   (`perfEntries.ts`).
 *   `debug_set_fps_overlay`       — D-330. Burn that live paint/raf readout
 *                                   into the window itself, so a screenshot
 *                                   or a `debug_record_video` recording
 *                                   carries its own measurement in-frame.
 *                                   Formats the SAME buffers `debug_frame_
 *                                   timing` reads — never a second, parallel
 *                                   fps number (see `fpsOverlay.ts`).
 *   `debug_native_preview_stats`  — D-451 / D-454. The Edit preview's
 *                                   presenter and playback loop: presents
 *                                   and new frames per second, the drawable
 *                                   wait, the engine's draw, the A/V offset
 *                                   against the audio clock, the native
 *                                   view's AppKit frame.
 *
 * NOT here, deliberately: the Colorist tab's own panel/visibility/settings
 * state. It lives in `app/src/store/useUIStore.ts` — inside the vendored
 * RapidRAW fork, i.e. the app layer — and a package reaching up into the app
 * would invert D-039's one-way dependency direction. Tracked as the remaining
 * piece-2 gap in `docs/notes/debug-tooling.md`.
 */

import { useHistoryStore } from '@apelles/history';
import { useShellStore } from '@apelles/shell';
import { getPanelCrashes } from '@apelles/ui';
import {
  useEditorTimelineStore,
  previewTimingReport,
  resetPreviewTiming,
  CLIP_INSPECTOR_TABS,
  parseClipInspectorTab,
  INSPECTOR_SECTION_IDS,
  parseInspectorSectionId,
  PANEL_IDS,
  parsePanelId,
  EDIT_LIBRARY_MODES,
  parseEditLibraryMode,
  useEditLayoutStore,
  editLayoutSnapshot,
} from '@apelles/editor';
import { previewSurfaceStats } from '@apelles/bridge';
import { customProxyStore } from '@apelles/motion/src/customProxyStore';

import { describeOpenDialogs, serializeDomTree } from './domTree';
import { armReleaseTrace } from './releaseTrace';
import {
  fpsOverlayState,
  OVERLAY_CORNERS,
  parseOverlayCorner,
  setFpsOverlay,
  type OverlayCorner,
} from './fpsOverlay';
import { isParseError, parseBool, parseShellTab, SHELL_TABS } from './uiState';
import { debugKey, debugPointer } from './input/inputOps';
import { findOverlays } from './input/overlay';
import { browserIdleDeps, DEFAULT_PERF_PREFIX, readPerfEntries, waitForIdle } from './perfEntries';

/** One op's arguments, straight off the untyped `chroma://request` payload —
 *  the same `any` every other registry in this repo uses for the same reason
 *  (it is a JSON object from an HTTP client, with no compile-time shape). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpArgs = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpResult = any;
export type OpHandler = (args: OpArgs) => OpResult | Promise<OpResult>;

/** Everything `debug_get_ui_state` reports, and the shape every write op
 *  echoes back so a caller never needs a second round trip to confirm. */
function uiStateSnapshot() {
  const shell = useShellStore.getState();
  const editor = useEditorTimelineStore.getState();
  return {
    shell: {
      activeTab: shell.activeTab,
      tabs: SHELL_TABS,
      sourcesPanelOpen: shell.sourcesPanelOpen,
      // B-341 — the chrome bar's Agent activity popover (drive it with
      // `debug_set_popover_open {id: 'agent-activity'}`).
      agentActivityOpen: shell.agentActivityOpen,
      // D-436 — the Sources panel's folder list (drive it with
      // `debug_set_popover_open {id: 'sources-folders'}`).
      sourcesFoldersOpen: shell.sourcesFoldersOpen,
      wgpuSurfaceActive: shell.wgpuSurfaceActive,
    },
    editor: {
      inspectorOpen: editor.inspectorOpen,
      // D-246 — the tab the user last chose. The tab actually SHOWING can
      // differ for a clip that has no such tab (a title has no audio); the
      // panel resolves that at render time without writing here, so this is
      // the choice, not the resolution — `debug_dom_tree` on
      // `[data-chroma-panel="clip-inspector"]` is what answers the latter.
      inspectorTab: editor.inspectorTab,
      inspectorTabs: CLIP_INSPECTOR_TABS,
      // D-432 (P4) — the sections the user has deliberately opened or closed,
      // by id; a section with no entry is showing its own default. The DOM
      // (`[data-chroma-section]` + `aria-expanded`) is what answers "what is
      // open right now", this is the remembered choice.
      inspectorSections: editor.inspectorSections,
      // D-252 — every registered popover/dialog's open flag; a panel with no
      // entry yet is closed (see `usePanelOpen`'s `?? false`), so this is
      // filled in lazily and `panelIds` is the reference for what CAN appear.
      openPanels: editor.openPanels,
      panelIds: PANEL_IDS,
      // D-263 / D-432 P5 — which library the Edit tab's browser is showing
      // (`sources` = the shared media pool). Reported because it changes what
      // a screenshot of that panel MEANS; `layout.browserOpen` below says
      // whether the browser is shown at all.
      libraryMode: editor.libraryMode,
      libraryModes: EDIT_LIBRARY_MODES,
      // D-432 P5 — the Edit tab's split sizes in CSS px and whether the
      // browser shows (`timelineHeight: null` = never resized, the default
      // 42 % share). Set with `debug_set_editor_layout`.
      layout: editLayoutSnapshot(),
      projectOpen: editor.openProjectKey !== null,
      timelineStatus: editor.status,
      selection: editor.selection,
      selectedGap: editor.selectedGap,
      playing: editor.playing,
      playhead: editor.playhead,
    },
    // Read off the document, not off a store — see `describeOpenDialogs`.
    openDialogs: describeOpenDialogs(),
    // D-330 — whether the live fps readout is currently burned into the
    // window, and with what settings. Reported here because it changes what
    // a screenshot or a `debug_record_video` of this app CONTAINS, which is
    // the same reason `libraryMode` above is reported; `mounted` is read off
    // the real document, not a flag, so a hand-removed node shows as gone.
    fpsOverlay: fpsOverlayState(),
    motion: {
      // B-282 — every custom layer's live-player proxy (D-409): its component
      // and props, `waiting` / `rendering` / `ready` / `error`, how many
      // mounted layers show it, and its frame count + folder or its error.
      // "Is the player drawing this custom layer's frames, and if not, why",
      // answered without reading a screenshot.
      customProxies: customProxyStore.snapshot(),
    },
    // B-292 — every panel currently showing its "This panel crashed" fallback
    // (`PanelErrorBoundary`): which one, the error, React's component stack,
    // when, and how many times since it last rendered cleanly. Empty when
    // nothing is down. Answers "why is this part of the window blank" without
    // reading a screenshot, and tells an agent which panel to ask the human to
    // reload.
    crashedPanels: getPanelCrashes(),
  };
}

/** B-341 — the shell-level Agent activity popover's id for
 *  `debug_set_popover_open`; every other id is an Edit-tab `PANEL_IDS` entry. */
const AGENT_ACTIVITY_PANEL_ID = 'agent-activity';

/** D-436 — the Sources panel's folder list; also a shell-store flag. */
const SOURCES_FOLDERS_PANEL_ID = 'sources-folders';

export const DEBUG_OPS: Record<string, OpHandler> = {
  debug_get_ui_state: () => uiStateSnapshot(),

  debug_set_active_tab: (a) => {
    const tab = parseShellTab(a?.tab);
    if (isParseError(tab)) return tab;
    // The same action the tab button's `onClick` calls (`Shell.tsx`).
    useShellStore.getState().setActiveTab(tab.value);
    return { ok: true, activeTab: useShellStore.getState().activeTab };
  },

  debug_set_sources_panel: (a) => {
    const open = parseBool(a?.open, 'open');
    if (isParseError(open)) return open;
    // The same action the Sources toggle's `onClick` calls (`Shell.tsx`).
    useShellStore.getState().setSourcesPanelOpen(open.value);
    return { ok: true, sourcesPanelOpen: useShellStore.getState().sourcesPanelOpen };
  },

  debug_set_library_mode: (a) => {
    const mode = parseEditLibraryMode(a?.mode);
    // D-216's rule: recognise or refuse by name — never accept a typo, do
    // nothing and answer `ok`.
    if (mode === null) {
      return { error: `unknown mode ${JSON.stringify(a?.mode)} — expected one of ${EDIT_LIBRARY_MODES.join(', ')}` };
    }
    // The same action the browser's tab bar calls, plus the browser's own
    // open flag: a mode chosen while the browser is hidden would otherwise
    // change nothing anyone can see.
    useEditorTimelineStore.getState().setLibraryMode(mode);
    useEditLayoutStore.getState().setLayout({ browserOpen: true }, 'debug');
    return {
      ok: true,
      libraryMode: useEditorTimelineStore.getState().libraryMode,
      browserOpen: useEditLayoutStore.getState().browserOpen,
    };
  },

  debug_set_editor_layout: (a) => {
    // D-432 P5 — every field optional, at least one required; sizes are CSS
    // px, clamped to each split's bounds (the same clamp a drag is held to),
    // and the reply is the layout as it now stands. `timelineHeight: null`
    // goes back to the default share. The same store action a released split
    // calls, so the live panels move (`EditorTab` applies non-user writes).
    const keys = ['browserOpen', 'browserWidth', 'inspectorWidth', 'timelineHeight'] as const;
    const given = keys.filter((k) => a?.[k] !== undefined);
    if (given.length === 0) return { error: `give at least one of ${keys.join(', ')}` };
    if (a.browserOpen !== undefined && typeof a.browserOpen !== 'boolean') {
      return { error: "'browserOpen' must be true or false" };
    }
    for (const k of ['browserWidth', 'inspectorWidth'] as const) {
      if (a[k] !== undefined && (typeof a[k] !== 'number' || !Number.isFinite(a[k]))) {
        return { error: `'${k}' must be a number of CSS pixels` };
      }
    }
    if (
      a.timelineHeight !== undefined &&
      a.timelineHeight !== null &&
      (typeof a.timelineHeight !== 'number' || !Number.isFinite(a.timelineHeight))
    ) {
      return { error: "'timelineHeight' must be a number of CSS pixels, or null for the default" };
    }
    const patch: Record<string, unknown> = {};
    for (const k of given) patch[k] = a[k];
    useEditLayoutStore.getState().setLayout(patch, 'debug');
    return { ok: true, layout: editLayoutSnapshot() };
  },

  debug_set_editor_inspector: (a) => {
    const open = parseBool(a?.open, 'open');
    if (isParseError(open)) return open;
    // The same action the Inspector toggle's `onClick` calls (`EditorTab.tsx`).
    useEditorTimelineStore.getState().setInspectorOpen(open.value);
    return { ok: true, inspectorOpen: useEditorTimelineStore.getState().inspectorOpen };
  },

  debug_set_inspector_tab: (a) => {
    const tab = parseClipInspectorTab(a?.tab);
    // D-216's rule: recognise or refuse by name — never accept a typo, do
    // nothing and answer `ok`.
    if (tab === null) {
      return { error: `unknown tab ${JSON.stringify(a?.tab)} — expected one of ${CLIP_INSPECTOR_TABS.join(', ')}` };
    }
    // The same action the tab button's own click calls (`ClipInspectorPanel`).
    useEditorTimelineStore.getState().setInspectorTab(tab);
    return { ok: true, inspectorTab: useEditorTimelineStore.getState().inspectorTab };
  },

  debug_set_inspector_section: (a) => {
    const id = parseInspectorSectionId(a?.id);
    if (id === null) {
      return { error: `unknown section ${JSON.stringify(a?.id)} — expected one of ${INSPECTOR_SECTION_IDS.join(', ')}` };
    }
    const open = parseBool(a?.open, 'open');
    if (isParseError(open)) return open;
    // The same action the section header's own click calls (`EditorSection`).
    useEditorTimelineStore.getState().setInspectorSectionOpen(id, open.value);
    return { ok: true, id, open: useEditorTimelineStore.getState().inspectorSections[id] ?? false };
  },

  debug_set_popover_open: (a) => {
    // B-341 — the one shell-level popover: the Agent activity feed, owned by
    // `useShellStore` (the shell is where this package may look), not by the
    // Edit tab's `openPanels` map.
    if (a?.id === AGENT_ACTIVITY_PANEL_ID) {
      const open = parseBool(a?.open, 'open');
      if (isParseError(open)) return open;
      // The same action the button's `onOpenChange` calls (`AgentActivityDock`).
      useShellStore.getState().setAgentActivityOpen(open.value);
      return { ok: true, id: AGENT_ACTIVITY_PANEL_ID, open: useShellStore.getState().agentActivityOpen };
    }
    if (a?.id === SOURCES_FOLDERS_PANEL_ID) {
      const open = parseBool(a?.open, 'open');
      if (isParseError(open)) return open;
      // The same action the folders caret's `onClick` calls (`SourcesPanel`).
      useShellStore.getState().setSourcesFoldersOpen(open.value);
      return { ok: true, id: SOURCES_FOLDERS_PANEL_ID, open: useShellStore.getState().sourcesFoldersOpen };
    }
    const id = parsePanelId(a?.id);
    if (id === null) {
      return {
        error: `unknown panel ${JSON.stringify(a?.id)} — expected one of ${[...PANEL_IDS, AGENT_ACTIVITY_PANEL_ID, SOURCES_FOLDERS_PANEL_ID].join(', ')}`,
      };
    }
    const open = parseBool(a?.open, 'open');
    if (isParseError(open)) return open;
    // The same action that panel's own trigger's `onOpenChange`/`onClick`
    // calls (`usePanelOpen`, `panelRegistry.ts`) — never a synthesised click.
    useEditorTimelineStore.getState().setPanelOpen(id, open.value);
    return { ok: true, id, open: useEditorTimelineStore.getState().openPanels[id] ?? false };
  },

  debug_dom_tree: (a) => {
    try {
      return serializeDomTree({
        selector: a?.selector,
        maxDepth: a?.maxDepth,
        maxNodes: a?.maxNodes,
        styles: Array.isArray(a?.styles) ? a.styles.map(String) : undefined,
        includeHidden: a?.includeHidden === true,
        text: a?.text !== false,
      });
    } catch (e) {
      // A malformed selector is a real, actionable answer of its own, and a
      // different one from "nothing matched" (which comes back as
      // `root: null`) — `querySelector` throws only for the former.
      return { error: `invalid selector: ${String((e as Error)?.message ?? e)}` };
    }
  },

  debug_frame_timing: (a) => {
    // D-330 — an optional time window. Omitted, this is byte-for-byte the
    // pre-D-330 whole-ring-buffer report; given, it narrows every channel to
    // the last `windowMs` so an agent can read exactly the number the
    // on-screen overlay is displaying beside it.
    let windowMs: number | null = null;
    if (a?.windowMs !== undefined) {
      const n = Math.round(Number(a.windowMs));
      if (!Number.isFinite(n) || n < 1) {
        return { error: "'windowMs' must be a positive integer number of milliseconds" };
      }
      windowMs = n;
    }
    if (a?.reset === true) {
      resetPreviewTiming();
      return { ok: true, reset: true, ...previewTimingReport(undefined, windowMs) };
    }
    const limit = a?.limit === undefined ? undefined : Math.round(Number(a.limit));
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return { error: "'limit' must be a positive integer" };
    }
    return previewTimingReport(limit, windowMs);
  },

  // D-434 — the UI harness's input tools. Async: they resolve once the
  // gesture has been delivered and the page has settled.
  debug_pointer: (a) => debugPointer(a),
  debug_key: (a) => debugKey(a),

  // D-434 / H1 — the UI harness's fixture ops are stamped `source: 'harness'`
  // (so the Agent activity dock never lists them); this drops what they left
  // on the shared undo/redo stacks once a scenario is torn down. Harness-only:
  // no MCP tool, because an agent has no reason to call it.
  // D-434 / H1 — pre-flight: does a `position: fixed` overlay sit over any of
  // the given parts (CSS selectors)? Reads only; the harness fails a scenario
  // up front, naming the overlay, instead of three presses in.
  debug_overlay_check: (a) => {
    const parts = Array.isArray(a?.parts) ? a.parts.map(String) : null;
    if (!parts?.length) return { error: "'parts' must be a non-empty list of CSS selectors" };
    const overlays = findOverlays(parts);
    return { ok: overlays.length === 0, overlays };
  },

  debug_clear_harness_history: () => {
    const before = useHistoryStore.getState();
    const cleared = [...before.undoStack, ...before.redoStack].filter((e) => e.source === 'harness').length;
    before.clearSource('harness');
    return { ok: true, cleared };
  },

  // B-347 / D-434 - exact per-phase edit-gesture numbers (the marks
  // `@apelles/editor`'s `editPerf.ts` writes) and an idle wait for the harness.
  // `build.dev` says whether the web bundle is a development one: a production
  // bundle writes no marks, and the harness labels its report accordingly.
  debug_perf_entries: async (a) => {
    const prefix = a?.prefix === undefined || a.prefix === null ? DEFAULT_PERF_PREFIX : String(a.prefix);
    let idle: { waitedMs: number; reached: boolean } | undefined;
    if (a?.waitIdleMs !== undefined && a.waitIdleMs !== null) {
      const ms = Math.round(Number(a.waitIdleMs));
      if (!Number.isFinite(ms) || ms < 0) return { error: "'waitIdleMs' must be a non-negative number of milliseconds" };
      idle = await waitForIdle(browserIdleDeps(), ms);
    }
    let trace: ReturnType<typeof armReleaseTrace> | undefined;
    if (a?.traceReleaseMs !== undefined && a.traceReleaseMs !== null) {
      const ms = Math.round(Number(a.traceReleaseMs));
      if (!Number.isFinite(ms) || ms < 0) return { error: "'traceReleaseMs' must be a non-negative number of milliseconds" };
      trace = armReleaseTrace(ms);
    }
    const entries = readPerfEntries(performance, prefix, a?.clear === true);
    return { ok: true, prefix, entries, ...(trace ? { trace } : {}), build: { dev: import.meta.env.DEV, perfMarks: import.meta.env.APELLES_PERF_MARKS === 'true', debugTools: import.meta.env.APELLES_DEBUG_TOOLS === 'true' }, ...(idle ? { idle } : {}) };
  },

  debug_set_fps_overlay: (a) => {
    const enabled = parseBool(a?.enabled, 'enabled');
    if (isParseError(enabled)) return enabled;

    let corner: OverlayCorner | undefined;
    if (a?.corner !== undefined) {
      const parsed = parseOverlayCorner(a.corner);
      // D-216's rule — recognise or refuse by name. A typo'd corner must not
      // silently land the readout somewhere else in a recording.
      if (parsed === null) {
        return {
          error: `unknown corner ${JSON.stringify(a.corner)} — expected one of ${OVERLAY_CORNERS.join(', ')}`,
        };
      }
      corner = parsed;
    }

    // `updateMs` is CLAMPED rather than refused (see `clampUpdateMs`), and the
    // echoed state reports what was actually applied, so a caller that asked
    // for 2 ms can see it got 16.
    const state = setFpsOverlay(enabled.value, {
      corner,
      updateMs: a?.updateMs === undefined ? undefined : a.updateMs,
    });
    return { ok: true, ...state };
  },

  // D-451 / D-454 — the Edit preview's measurements: presents and new frames
  // per second and their intervals, the drawable wait, the engine's draw, the
  // A/V offset against the audio clock, and where AppKit has the native view.
  debug_native_preview_stats: async (a) => previewSurfaceStats(a?.reset === true),
};

/** Every op name this registry answers — used by the Colorist registry's own
 *  "not mine" skip and by the MCP tool docs, so the list has one source. */
export const DEBUG_OP_NAMES: readonly string[] = Object.keys(DEBUG_OPS);
