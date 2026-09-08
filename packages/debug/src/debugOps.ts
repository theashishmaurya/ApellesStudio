/**
 * debugOps.ts — the `debug_*` frontend op registry (D-218).
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
 *   changes the user's work belongs in its own tab's registry, not here. It
 *   also never synthesises a click, a keypress or a pointer event: every write
 *   below calls the SAME store action the human's own control calls, which is
 *   the whole point (a simulated click proves the simulation works; a store
 *   action proves the app works).
 *
 * **This whole module is debug-only and never reaches a production build.**
 *   Nothing imports it statically: `useDebugControl.ts` reaches it through a
 *   `import()` inside an `if (import.meta.env.DEV)` branch, so a production
 *   `vite build` constant-folds that branch away and Rollup drops this module
 *   and its chunk entirely. That is the frontend's equivalent of the
 *   `#[cfg(debug_assertions)]` gate on the Rust half (D-218, B-099), and it is
 *   verified by grepping the built bundle rather than assumed.
 *
 * Ops:
 *   `debug_get_ui_state`          — read every UI-state flag below, plus the
 *                                   open dialogs the DOM actually has.
 *   `debug_set_active_tab`        — Edit / Motion / Colorist.
 *   `debug_set_sources_panel`     — the shell's docked Sources column.
 *   `debug_set_editor_inspector`  — the Edit tab's Inspector column.
 *   `debug_dom_tree`              — bounded DOM dump (see `domTree.ts`).
 *   `debug_frame_timing`          — the Edit-tab preview's real paint
 *                                   intervals (see `@chroma/editor`'s
 *                                   `previewTiming.ts`).
 *
 * NOT here, deliberately: the Colorist tab's own panel/visibility/settings
 * state. It lives in `app/src/store/useUIStore.ts` — inside the vendored
 * RapidRAW fork, i.e. the app layer — and a package reaching up into the app
 * would invert D-039's one-way dependency direction. Tracked as the remaining
 * piece-2 gap in `docs/notes/debug-tooling.md`.
 */

import { useShellStore } from '@chroma/shell';
import { useEditorTimelineStore, previewTimingReport, resetPreviewTiming } from '@chroma/editor';

import { describeOpenDialogs, serializeDomTree } from './domTree';
import { isParseError, parseBool, parseShellTab, SHELL_TABS } from './uiState';

/** One op's arguments, straight off the untyped `chroma://request` payload —
 *  the same `any` every other registry in this repo uses for the same reason
 *  (it is a JSON object from an HTTP client, with no compile-time shape). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpArgs = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpResult = any;
export type OpHandler = (args: OpArgs) => OpResult;

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
      wgpuSurfaceActive: shell.wgpuSurfaceActive,
    },
    editor: {
      inspectorOpen: editor.inspectorOpen,
      projectOpen: editor.openProjectKey !== null,
      timelineStatus: editor.status,
      selection: editor.selection,
      selectedGap: editor.selectedGap,
      playing: editor.playing,
      playhead: editor.playhead,
    },
    // Read off the document, not off a store — see `describeOpenDialogs`.
    openDialogs: describeOpenDialogs(),
  };
}

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

  debug_set_editor_inspector: (a) => {
    const open = parseBool(a?.open, 'open');
    if (isParseError(open)) return open;
    // The same action the Inspector toggle's `onClick` calls (`EditorTab.tsx`).
    useEditorTimelineStore.getState().setInspectorOpen(open.value);
    return { ok: true, inspectorOpen: useEditorTimelineStore.getState().inspectorOpen };
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
    if (a?.reset === true) {
      resetPreviewTiming();
      return { ok: true, reset: true, ...previewTimingReport() };
    }
    const limit = a?.limit === undefined ? undefined : Math.round(Number(a.limit));
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return { error: "'limit' must be a positive integer" };
    }
    return previewTimingReport(limit);
  },
};

/** Every op name this registry answers — used by the Colorist registry's own
 *  "not mine" skip and by the MCP tool docs, so the list has one source. */
export const DEBUG_OP_NAMES: readonly string[] = Object.keys(DEBUG_OPS);
