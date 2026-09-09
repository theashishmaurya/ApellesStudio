/**
 * @apelles/history — the shell-level global undo/redo stack (D-051).
 *
 * A generic "here's an action that happened, here's how to undo/redo it"
 * record — `{ tab, label, undo(), redo(), ts }` — with no knowledge of any
 * tab's actual data shape. Any tab pushes an entry when it performs an
 * undoable edit; `@apelles/shell` owns the Cmd/Ctrl+Z / Cmd/Ctrl+Y keybinding
 * and calls `undo()`/`redo()` here regardless of which tab is active (see
 * `Shell.tsx`).
 *
 * Two independent stacks, standard undo/redo semantics: `undo()` pops the
 * top of `undoStack`, calls its `.undo()`, and moves it to `redoStack`;
 * `redo()` does the mirror image. Pushing a new entry (`push()`) always
 * clears `redoStack` — a fresh edit invalidates whatever redo branch existed,
 * same convention as every other undo stack (and as the Colorist's own
 * pre-existing `useEditorStore` history it bridges — see
 * `app/src/store/coloristHistoryBridge.ts`).
 *
 * Does NOT itself know how to undo/redo anything — every entry carries its
 * own closures. Does NOT persist across restarts (in-memory only, cleared on
 * close — deliberate for this pass, see D-051).
 */

import { create } from 'zustand';

/** One undoable action, from any tab. */
export interface HistoryEntry {
  /** unique id, auto-generated on push if not supplied */
  id: string;
  /** which tab this entry belongs to — a plain string (not `ShellTabId`) so
   *  this package never depends on `@apelles/shell`; the shell validates it
   *  against its own known tab ids when deciding whether/how to switch. */
  tab: string;
  /** human-readable one-liner, e.g. "Trim clip (start)" or "primary: exposure +0.35" */
  label: string;
  ts: number;
  undo: () => void;
  redo: () => void;
}

/** What a caller passes to `push()` — `id`/`ts` are optional, auto-filled. */
export type PushableEntry = Omit<HistoryEntry, 'id' | 'ts'> & Partial<Pick<HistoryEntry, 'id' | 'ts'>>;

/** Cap on each stack, mirroring the Colorist's own 50-deep `useEditorStore`
 *  history (see D-051) but a bit more generous since this stack spans 3
 *  tabs' worth of activity, not one image's grade knobs. */
export const MAX_HISTORY_ENTRIES = 100;

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface HistoryState {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  /** Record a new undoable action. Clears the redo stack. */
  push: (entry: PushableEntry) => void;
  /** Undo the most recent action (any tab). Returns the entry undone, or
   *  `null` if the undo stack is empty. */
  undo: () => HistoryEntry | null;
  /** Redo the most recently undone action. Returns the entry redone, or
   *  `null` if the redo stack is empty. */
  redo: () => HistoryEntry | null;
  /** Drop everything — both stacks. Not currently called by app code (no
   *  "clear history" UI this pass); exposed for tests and future use. */
  clear: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Top of each stack without popping — for a future "Undo <label>" menu
   *  item / tooltip; unused by the keybinding itself. */
  peekUndo: () => HistoryEntry | null;
  peekRedo: () => HistoryEntry | null;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],

  push: (entry) =>
    set((s) => {
      const full: HistoryEntry = {
        id: entry.id ?? makeId(),
        ts: entry.ts ?? Date.now(),
        tab: entry.tab,
        label: entry.label,
        undo: entry.undo,
        redo: entry.redo,
      };
      const undoStack = [...s.undoStack, full];
      if (undoStack.length > MAX_HISTORY_ENTRIES) undoStack.shift();
      return { undoStack, redoStack: [] };
    }),

  undo: () => {
    const { undoStack, redoStack } = get();
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return null;
    entry.undo();
    set({ undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, entry] });
    return entry;
  },

  redo: () => {
    const { undoStack, redoStack } = get();
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return null;
    entry.redo();
    set({ redoStack: redoStack.slice(0, -1), undoStack: [...undoStack, entry] });
    return entry;
  },

  clear: () => set({ undoStack: [], redoStack: [] }),
  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
  peekUndo: () => get().undoStack[get().undoStack.length - 1] ?? null,
  peekRedo: () => get().redoStack[get().redoStack.length - 1] ?? null,
}));
