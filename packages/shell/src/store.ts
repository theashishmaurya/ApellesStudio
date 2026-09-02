/**
 * @chroma/shell — the tab store (D-039).
 *
 * One tiny zustand store holding which of the 3 tabs is active. Kept separate
 * from the app's stores on purpose: the shell must not depend on
 * `@chroma/bridge` or the colorist app.
 *
 * `activeTab` is deliberately session-only, not persisted (B-007, 2026-09-02).
 * It was persisted to localStorage at first, but that meant "Edit opens by
 * default" (explicit owner request) only held on a machine that had never
 * clicked another tab — every real session immediately overrode it back to
 * whatever was last open, which read as the default never having taken effect
 * at all. Every launch now starts on `DEFAULT_TAB`; switching tabs still works
 * normally within a session, it just doesn't carry across a restart.
 *
 * `wgpuSurfaceActive` (B-006, 2026-09-02): also session-only. A tab (the
 * Colorist app) that draws its own content directly onto the native window
 * via a wgpu surface — bypassing the webview entirely, see
 * `app/src-tauri/src/gpu_processing.rs`'s `WgpuDisplay` — sets this true while
 * that surface should be visible. The shell root must go transparent in that
 * window too, or its own opaque background blocks the transparent "hole" the
 * tab punches for the surface to show through (see `Shell.tsx`'s root class).
 */

import { create } from 'zustand';

export type ShellTabId = 'edit' | 'motion' | 'colorist';

const DEFAULT_TAB: ShellTabId = 'edit';

interface ShellStore {
  activeTab: ShellTabId;
  setActiveTab: (tab: ShellTabId) => void;
  wgpuSurfaceActive: boolean;
  setWgpuSurfaceActive: (active: boolean) => void;
}

export const useShellStore = create<ShellStore>((set) => ({
  activeTab: DEFAULT_TAB,
  setActiveTab: (tab) => set({ activeTab: tab }),
  wgpuSurfaceActive: false,
  setWgpuSurfaceActive: (active) => set({ wgpuSurfaceActive: active }),
}));

/** Convenience selector hook — returns just the active tab id. */
export const useActiveTab = (): ShellTabId => useShellStore((s) => s.activeTab);
