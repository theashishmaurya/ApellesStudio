/**
 * projectSummary.ts - the compact answer `open_project` / `new_project` give
 * instead of the grade (B-319).
 *
 * What it is: how many shots the project that is now open holds and its
 *   timelines (id, name, active). Both ops switch the whole app; what the caller
 *   needs back is "what is open now", not the active shot's grade document
 *   (~10 KB) and histogram. `include_grade` on those ops opts back in
 *   (`bridgeOpClasses.wantsGrade`).
 *
 * What it does NOT do: open anything, or touch a store (two read-only backend calls).
 */

import { invoke } from '@tauri-apps/api/core';

/** The timelines a project lists, as the bridge reports them. */
export interface ProjectSummary {
  shotCount: number;
  timelines: Array<{ id: string; name: string; active: boolean }>;
}

interface TimelineListRow {
  id: string;
  name: string;
  active: boolean;
}

export async function projectSummary(): Promise<ProjectSummary> {
  const [session, timelines] = await Promise.all([
    invoke<{ count: number }>('chroma_session_list'),
    invoke<TimelineListRow[]>('chroma_timeline_list').catch((): TimelineListRow[] => []),
  ]);
  return {
    shotCount: session.count,
    timelines: timelines.map((t) => ({ id: t.id, name: t.name, active: t.active })),
  };
}
