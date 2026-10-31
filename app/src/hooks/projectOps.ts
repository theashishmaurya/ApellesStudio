/**
 * projectOps.ts — the project-lifecycle ops the bridge answers that need more than
 * a one-line store call (B-356).
 *
 * What it is: `closeProjectOp`, the `close_project` MCP op. It runs the SAME store
 *   action the "‹ Projects" button runs (`useSessionStore.closeProject`, from
 *   `Root.tsx`'s `onCloseProject`), so an agent and a person leave a project the
 *   same way.
 *
 * Unsaved work: the GUI button does not prompt. `closeProject` flushes the Edit
 *   tab's debounced timeline save, then saves a dirty, named project (best effort,
 *   so a failing save can never make the button un-clickable, B-132/D-268). The op
 *   inherits exactly that — nothing is silently lost that the button would keep.
 *   An unsaved `Untitled` session is discarded, as it is by the button.
 *
 * What it does NOT do: open or create a project, or delete anything on disk.
 */

import { useSessionStore } from '../store/useSessionStore';

export interface CloseProjectResult {
  /** The path of the project that was open, or `null` when nothing was (a no-op). */
  closed: string | null;
}

export async function closeProjectOp(): Promise<CloseProjectResult> {
  const closed = useSessionStore.getState().projectPath;
  if (!closed) return { closed: null };
  await useSessionStore.getState().closeProject();
  return { closed };
}
