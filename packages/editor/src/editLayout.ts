/**
 * @apelles/editor — the Edit tab's panel layout (D-432 P5).
 *
 * **What it is.** The sizes of the Edit tab's resizable splits in the Final Cut
 * Pro arrangement (`docs/notes/ui-redesign.md` §4.1): the media browser's width,
 * the Inspector's width, the timeline's height under the three upper panels,
 * and whether the browser is shown. A small zustand store plus the pure clamp
 * that every write goes through.
 *
 * **Who writes it.** Three callers drive the same `setLayout` action, so a
 * human and an agent move one piece of state (CLAUDE.md, human + AI):
 * - `EditorTab` when the user releases a split (`onLayoutChanged` with
 *   `isUserInteraction`, so a mount or a window resize never writes);
 * - the debug op `debug_set_editor_layout` (`@apelles/debug`);
 * - `hydrate`, once the app's settings have loaded.
 * `EditorTab` applies a store change it did not make itself to the live panels
 * through their imperative `resize`, so a debug write or a late hydrate moves
 * the splits on screen.
 *
 * **Persistence is injected, not owned** — the `@apelles/keymap` pattern
 * (D-273). This package must not depend on Tauri, so the app calls
 * {@link EditLayoutStore.setPersist} with a sink that writes
 * `appSettings.editLayout` (`app_settings.rs`, the repo's one per-user
 * preference file; there is no `localStorage` in this app by design), and
 * {@link EditLayoutStore.hydrate} with what it read back. Only a user or debug
 * write calls the sink; hydrating does not write the value straight back.
 *
 * **What it does NOT hold.** Whether the Inspector is open stays in
 * `useEditorTimelineStore.inspectorOpen` (D-219), where `debug_set_editor_
 * inspector` and the toggle already meet. Which library the browser shows is
 * `useEditorTimelineStore.libraryMode` (D-263). The timeline's own view
 * settings (zoom, clip height) are `timelineView.ts`.
 */

import { create } from 'zustand';

/** Pixel bounds of one split. `null` default = the panel's own default rule. */
interface SizeLimits {
  readonly min: number;
  readonly max: number;
  readonly defaultPx: number;
}

/** Spec §4.12: the browser is 280 px, 220–480. */
export const BROWSER_WIDTH: SizeLimits = { min: 220, max: 480, defaultPx: 280 };

/** Spec §4.10 says 300 (260–440). The default stays 320 until P4 rebuilds the
 *  Inspector rows: D-208's keyframe buttons do not fit a 300 px row today. */
export const INSPECTOR_WIDTH: SizeLimits = { min: 264, max: 440, defaultPx: 320 };

/** Spec §4.1: the timeline is at least 180 px tall; its default is a share of
 *  the tab ({@link TIMELINE_DEFAULT_PERCENT}), so `defaultPx` only bounds a
 *  stored value. The max keeps the upper band's own minimum reachable on a
 *  very tall window; the group enforces the real relation through
 *  {@link UPPER_MIN_HEIGHT}. */
export const TIMELINE_HEIGHT: SizeLimits = { min: 180, max: 2000, defaultPx: 360 };

/** The timeline's default share of the tab's height (spec §4.1: 42 %). */
export const TIMELINE_DEFAULT_PERCENT = 42;

/** The upper band (browser | viewer | Inspector) is never shorter than this. */
export const UPPER_MIN_HEIGHT = 260;

/** The viewer column is never narrower than this. */
export const VIEWER_MIN_WIDTH = 320;

/** Everything persisted. `timelineHeight: null` = never resized, use the
 *  {@link TIMELINE_DEFAULT_PERCENT} share. */
export interface EditLayout {
  browserOpen: boolean;
  browserWidth: number;
  inspectorWidth: number;
  timelineHeight: number | null;
}

export const DEFAULT_EDIT_LAYOUT: EditLayout = {
  browserOpen: true,
  browserWidth: BROWSER_WIDTH.defaultPx,
  inspectorWidth: INSPECTOR_WIDTH.defaultPx,
  timelineHeight: null,
};

function clampSize(raw: unknown, limits: SizeLimits): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.round(Math.min(limits.max, Math.max(limits.min, raw)));
}

/**
 * Merge an untrusted partial layout (a saved settings blob, a debug op's
 * arguments) onto `base`, clamping each size to its bounds. Unknown fields and
 * values of the wrong type are ignored, never thrown on: a settings file
 * written by another version must not stop the Edit tab from opening.
 */
export function mergeEditLayout(base: EditLayout, patch: unknown): EditLayout {
  if (patch === null || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  const timelineHeight =
    p.timelineHeight === null ? null : (clampSize(p.timelineHeight, TIMELINE_HEIGHT) ?? base.timelineHeight);
  return {
    browserOpen: typeof p.browserOpen === 'boolean' ? p.browserOpen : base.browserOpen,
    browserWidth: clampSize(p.browserWidth, BROWSER_WIDTH) ?? base.browserWidth,
    inspectorWidth: clampSize(p.inspectorWidth, INSPECTOR_WIDTH) ?? base.inspectorWidth,
    timelineHeight,
  };
}

function sameLayout(a: EditLayout, b: EditLayout): boolean {
  return (
    a.browserOpen === b.browserOpen &&
    a.browserWidth === b.browserWidth &&
    a.inspectorWidth === b.inspectorWidth &&
    a.timelineHeight === b.timelineHeight
  );
}

/** Where a write came from: `user` (a split released), `debug` (an agent), or
 *  `hydrate` (settings loaded). `EditorTab` re-applies non-`user` writes to the
 *  live panels; only `user` and `debug` writes are persisted. */
export type EditLayoutSource = 'user' | 'debug' | 'hydrate';

export interface EditLayoutStore extends EditLayout {
  /** The source of the last write that changed anything. */
  lastSource: EditLayoutSource;
  /** Bumped on every changing write, so a subscriber can tell two identical
   *  debug writes in a row from no write. */
  revision: number;
  setLayout: (patch: Partial<EditLayout>, source: EditLayoutSource) => void;
  setBrowserOpen: (open: boolean) => void;
  hydrate: (saved: unknown) => void;
  setPersist: (sink: ((layout: EditLayout) => void) | null) => void;
}

let persistSink: ((layout: EditLayout) => void) | null = null;

function layoutOf(s: EditLayout): EditLayout {
  return {
    browserOpen: s.browserOpen,
    browserWidth: s.browserWidth,
    inspectorWidth: s.inspectorWidth,
    timelineHeight: s.timelineHeight,
  };
}

export const useEditLayoutStore = create<EditLayoutStore>((set, get) => ({
  ...DEFAULT_EDIT_LAYOUT,
  lastSource: 'hydrate',
  revision: 0,
  setLayout: (patch, source) => {
    const current = layoutOf(get());
    const next = mergeEditLayout(current, patch);
    if (sameLayout(current, next)) return;
    set({ ...next, lastSource: source, revision: get().revision + 1 });
    if (source !== 'hydrate') persistSink?.(next);
  },
  setBrowserOpen: (open) => get().setLayout({ browserOpen: open }, 'user'),
  hydrate: (saved) => get().setLayout(mergeEditLayout(DEFAULT_EDIT_LAYOUT, saved), 'hydrate'),
  setPersist: (sink) => {
    persistSink = sink;
  },
}));

/** The current layout as a plain object (for `debug_get_ui_state`). */
export function editLayoutSnapshot(): EditLayout {
  return layoutOf(useEditLayoutStore.getState());
}
