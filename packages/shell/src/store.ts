/**
 * @chroma/shell — the tab store (D-039).
 *
 * One tiny zustand store holding which of the 3 tabs is active, persisted to
 * localStorage under `chroma.activeTab`. Kept separate from the app's stores on
 * purpose: the shell must not depend on `@chroma/bridge` or the colorist app.
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
}

export const useShellStore = create<ShellStore>((set) => ({
  activeTab: readPersisted(),
  setActiveTab: (tab) => {
    persist(tab);
    set({ activeTab: tab });
  },
}));

/** Convenience selector hook — returns just the active tab id. */
export const useActiveTab = (): ShellTabId => useShellStore((s) => s.activeTab);
