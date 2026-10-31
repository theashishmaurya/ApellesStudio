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
 *
 * **Who did it (D-298).** Every entry carries a `source`: `'user'` (the
 * default), `'agent'`, or `'harness'` (D-434 — the UI test harness's own
 * fixture ops; the activity feed lists only `'agent'`, so they never show). An MCP op dispatcher wraps its handler in
 * [`runAsAgent`], and every `push` that happens inside that window is stamped
 * `'agent'` — so the Edit and Motion tabs need no per-op instrumentation at
 * all, only one wrapper each at the point where an MCP request is dispatched.
 * That is what lets the agent activity feed report work done on ANY tab
 * (D-298) instead of only Colorist grade changes (D-032), without a second
 * cross-tab record to keep in step with this one.
 *
 * The scope is a plain depth counter, not async-context tracking: JS is
 * single-threaded, and a `push` that happens synchronously inside a handler —
 * which every `applyOp` does — is inside the window by construction. The
 * honest limit is a push that lands after an `await` in the middle of two
 * *interleaved* MCP ops, where it could be attributed to the wrong one; it is
 * still attributed to an agent, and this is a feed label, never state, so a
 * mislabel costs a wrong row and nothing else.
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
  /** D-298 — who caused this: the person at the keyboard, or an agent through
   *  the MCP bridge. Set automatically from [`runAsAgent`]'s scope, so a
   *  caller never passes it. Drives the cross-tab agent activity feed. */
  source: EntrySource;
  ts: number;
  undo: () => void;
  redo: () => void;
  /** D-432 (P4) — entries pushed back to back with the SAME key (and source)
   *  fold into one: the first entry's `undo` is kept, the latest `redo` and
   *  label win. This is how a scrub gesture that applies an op per frame
   *  stays ONE undo step. The caller owns key uniqueness per gesture. */
  coalesceKey?: string;
}

/** Who caused an entry — see `HistoryEntry.source`. */
export type EntrySource = 'user' | 'agent' | 'harness';

/** What a caller passes to `push()` — `id`/`ts` are optional and auto-filled,
 *  `source` is not passed at all (it comes from [`runAsAgent`]'s scope). */
export type PushableEntry = Omit<HistoryEntry, 'id' | 'ts' | 'source'> &
  Partial<Pick<HistoryEntry, 'id' | 'ts'>>;

// --------------------------------------------------------------------------- //
// D-298 — the agent scope
// --------------------------------------------------------------------------- //

/** The attribution scopes currently open, innermost last. Empty = a person. */
const scopes: Exclude<EntrySource, 'user'>[] = [];

async function runInScope<T>(source: Exclude<EntrySource, 'user'>, fn: () => T | Promise<T>): Promise<T> {
  scopes.push(source);
  try {
    return await fn();
  } finally {
    scopes.pop();
  }
}

/** Run `fn` with every [`useHistoryStore`] `push` inside it stamped
 *  `source: 'agent'`. Re-entrant (a nested call keeps the stamp), and the
 *  scope is unwound in a `finally` so a throwing handler cannot leave the
 *  whole app permanently attributing edits to an agent.
 *
 *  Wrap the **dispatcher**, not each op: one call site per tab's MCP bridge is
 *  the whole instrumentation, which is exactly why this shape was chosen over
 *  threading a flag through every op handler. */
export function runAsAgent<T>(fn: () => T | Promise<T>): Promise<T> {
  return runInScope('agent', fn);
}

/** D-434 / H1 — the dispatcher entry point: run `fn` as the agent, unless the
 *  request itself says (`source: 'harness'`, set by the control server only for
 *  the UI harness's own fixture ops) that it is the test harness's. Anything
 *  else a request carries in `source` is ignored, so only the harness can
 *  name itself, and an unknown value is an agent request as before. */
export function runForRequest<T>(request: object | null | undefined, fn: () => T | Promise<T>): Promise<T> {
  return runInScope((request as { source?: unknown } | null | undefined)?.source === 'harness' ? 'harness' : 'agent', fn);
}

/** Whether a `push` right now would be attributed to an agent (or the test
 *  harness — anything that is not a person). Exported for tests and for a
 *  caller that needs to make the same distinction without pushing. */
export function isAgentScope(): boolean {
  return scopes.length > 0;
}

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
  /** Drop everything — both stacks. Called when a project opens, is created
   *  or closes (B-343: an undo must never reach across projects). */
  clear: () => void;
  /** Drop every entry a given source pushed, from both stacks, leaving the
   *  rest in order. The UI harness calls it with `'harness'` after each
   *  scenario so its fixture ops never linger in a person's undo history. */
  clearSource: (source: EntrySource) => void;
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
        source: scopes[scopes.length - 1] ?? 'user',
        undo: entry.undo,
        redo: entry.redo,
        coalesceKey: entry.coalesceKey,
      };
      const last = s.undoStack[s.undoStack.length - 1];
      if (full.coalesceKey !== undefined && last?.coalesceKey === full.coalesceKey && last.source === full.source) {
        const folded: HistoryEntry = { ...last, redo: full.redo, label: full.label, ts: full.ts };
        return { undoStack: [...s.undoStack.slice(0, -1), folded], redoStack: [] };
      }
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
  clearSource: (source) =>
    set((s) => ({
      undoStack: s.undoStack.filter((e) => e.source !== source),
      redoStack: s.redoStack.filter((e) => e.source !== source),
    })),
  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
  peekUndo: () => get().undoStack[get().undoStack.length - 1] ?? null,
  peekRedo: () => get().redoStack[get().redoStack.length - 1] ?? null,
}));
