/**
 * @chroma/shell — the tab store (D-039).
 *
 * One tiny zustand store holding which of the 3 tabs is active, persisted to
 * localStorage under `chroma.activeTab`. Kept separate from the app's stores on
 * purpose: the shell must not depend on `@chroma/bridge` or the colorist app.
 *
 * `wgpuSurfaceActive` (B-006, 2026-09-02): session-only flag, not persisted. A
 * tab (the Colorist app) that draws its own content directly onto the native
 * window via a wgpu surface — bypassing the webview entirely, see
 * `app/src-tauri/src/gpu_processing.rs`'s `WgpuDisplay` — sets this true while
 * that surface should be visible. The shell root must go transparent in that
 * window too, or its own opaque background blocks the transparent "hole" the
 * tab punches for the surface to show through (see `Shell.tsx`'s root class).
 */

import { create } from 'zustand';

export type ShellTabId = 'edit' | 'motion' | 'colorist';

const STORAGE_KEY = 'chroma.activeTab';
const DEFAULT_TAB: ShellTabId = 'edit';
const VALID: readonly ShellTabId[] = ['edit', 'motion', 'colorist'];

function readPersisted(): ShellTabId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (VALID as readonly string[]).includes(raw)) {
      return raw as ShellTabId;
    }
  } catch {
    /* localStorage unavailable (private mode, etc.) — fall through */
  }
  return DEFAULT_TAB;
}

function persist(tab: ShellTabId): void {
  try {
    localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    /* ignore */
  }
}

interface ShellStore {
  activeTab: ShellTabId;
  setActiveTab: (tab: ShellTabId) => void;
  wgpuSurfaceActive: boolean;
  setWgpuSurfaceActive: (active: boolean) => void;
}

export const useShellStore = create<ShellStore>((set) => ({
  activeTab: readPersisted(),
  setActiveTab: (tab) => {
    persist(tab);
    set({ activeTab: tab });
  },
  wgpuSurfaceActive: false,
  setWgpuSurfaceActive: (active) => set({ wgpuSurfaceActive: active }),
}));

/** Convenience selector hook — returns just the active tab id. */
export const useActiveTab = (): ShellTabId => useShellStore((s) => s.activeTab);
