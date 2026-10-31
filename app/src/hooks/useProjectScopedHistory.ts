/**
 * useProjectScopedHistory.ts — undo history belongs to one project (B-343).
 *
 * What it is: a composition-root hook that empties the shared `@apelles/history`
 *   stacks whenever the open project's identity changes (open, new, close,
 *   Save-as of an Untitled session). It is called once, from `Root`, next to
 *   every other store that follows `selectProjectKey` (the Edit timeline, the
 *   media pool, ...): the one place a project switch is observed.
 *
 * Why: the stack is global, capped at 100, and its entries hold closures over
 *   the project they were made in. Left alone, project A's entries sat on top
 *   of project B's, so Cmd+Z in B popped A's (a wasted press that reports
 *   "could not undo ... no longer in this project"), and 100 edits in A evicted
 *   B's own history. Undo is also not persisted: reopening A starts with an
 *   empty stack, as Final Cut Pro and DaVinci Resolve do per project. Every way
 *   to undo — Cmd+Z, the MCP `undo`/`redo` tools — reads this one stack
 *   (`stepHistory`), so clearing it here covers all of them.
 *
 * What it does NOT do: touch the first render (mounting on a project is not a
 *   switch) or any per-tab state; it only drops history entries.
 */

import { useEffect, useRef } from 'react';
import { useHistoryStore } from '@apelles/history';

export function useProjectScopedHistory(projectKey: string | null): void {
  const previous = useRef(projectKey);
  useEffect(() => {
    if (previous.current === projectKey) return;
    previous.current = projectKey;
    useHistoryStore.getState().clear();
  }, [projectKey]);
}
