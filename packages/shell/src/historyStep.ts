/**
 * historyStep.ts — the ONE implementation of "step the global history and
 * follow it" (D-051, D-383).
 *
 * What it is: `stepHistory('undo' | 'redo')` pops the top of the shared
 *   `@apelles/history` stack (whichever tab the entry belongs to), and then
 *   switches the shell to that entry's tab, so the change is visible where it
 *   happened (D-051's "switch tabs rather than apply silently").
 *
 * Who calls it: the Cmd/Ctrl+Z / Cmd/Ctrl+Y shortcuts in `Shell.tsx` and the
 *   `undo` / `redo` control ops in `app/src/hooks/useChromaControl.ts`. Both go
 *   through here so the human and the agent can never drift apart on what
 *   "undo" means.
 *
 * What it does NOT do: know what any entry's `undo()` does, or push anything.
 *   The `tabs` argument is the registry the caller renders; an entry for a tab
 *   that is not in it is still undone, but the shell does not switch to it.
 */

import { useHistoryStore, type HistoryEntry } from '@apelles/history';
import { useShellStore, type ShellTabId } from './store';

export type HistoryDirection = 'undo' | 'redo';

/** Every tab the shell can show — used when the caller has no registry of its
 *  own to pass (the control bridge runs outside React). */
export const SHELL_TAB_IDS: readonly ShellTabId[] = ['edit', 'motion', 'colorist'];

/** What a step did, in the shape the control op reports. */
export interface HistoryStepResult {
  /** The entry undone/redone, or `null` when that stack was empty. */
  entry: Pick<HistoryEntry, 'tab' | 'label'> | null;
  activeTab: ShellTabId;
  canUndo: boolean;
  canRedo: boolean;
  /** Labels of what the NEXT undo / redo would act on. */
  undoLabel: string | null;
  redoLabel: string | null;
}

export function stepHistory(
  direction: HistoryDirection,
  tabs: readonly string[] = SHELL_TAB_IDS,
): HistoryStepResult {
  const history = useHistoryStore.getState();
  const entry = direction === 'undo' ? history.undo() : history.redo();
  const shell = useShellStore.getState();
  if (entry && tabs.includes(entry.tab) && entry.tab !== shell.activeTab) {
    shell.setActiveTab(entry.tab as ShellTabId);
  }
  const after = useHistoryStore.getState();
  return {
    entry: entry ? { tab: entry.tab, label: entry.label } : null,
    activeTab: useShellStore.getState().activeTab,
    canUndo: after.canUndo(),
    canRedo: after.canRedo(),
    undoLabel: after.peekUndo()?.label ?? null,
    redoLabel: after.peekRedo()?.label ?? null,
  };
}
