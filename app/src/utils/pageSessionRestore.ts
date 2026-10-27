/**
 * Putting the window back after the page reloads (B-277, D-410).
 *
 * **What it is.** The page (the webview's JS) can be replaced while the Rust
 * process keeps running: macOS terminating the web content process (B-274,
 * `chroma::webview_lifecycle` reloads it) or a dev full reload. The backend
 * still knows which project was open and which tab was showing
 * (`chroma::page_session`); the new page used to ignore that and land on the
 * launcher, so the Edit journal's recovered edits (D-402) only appeared once
 * the user reopened the project by hand.
 *
 * **What it does.** [`restorePageSession`] asks `chroma_page_session_get` once
 * at start-up. With a project remembered and none open in this page, it shows
 * the remembered tab and reopens the project through the session store's own
 * `openProject` (the action the launcher and `open_project` use). That sets the
 * open project's identity, which `Root.tsx` already hands to the Edit timeline
 * store, whose first load replays the journal and raises "Restored N changes".
 * A project that cannot be reopened (moved or deleted meanwhile) clears the
 * backend's binding and reports why, so the caller can say so over the
 * launcher. [`reportActiveTab`] keeps the backend's copy of the tab current.
 *
 * **What it does NOT do.** Reopen anything on a cold launch: the backend's
 * session lives in process memory only, so a fresh start has nothing to restore
 * (B-007: the tab is session-only). Restore an in-memory "Untitled" session,
 * which has no project on disk. Restore the Motion tab's unsaved manifest text,
 * which lives in that tab's component state and is not journaled (roadmap).
 */
import type { ShellTabId } from '@apelles/shell';

/** Mirrors `chroma::page_session::PageSession`. */
export interface PageSession {
  project: { name: string; path: string } | null;
  activeTab: ShellTabId | null;
}

export interface PageSessionDeps {
  /** The Tauri bridge (`invoke` from `@tauri-apps/api/core`). */
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** Whether this page already has a project open (an `open_project` that
   *  landed first wins; the restore never replaces it). */
  isProjectOpen: () => boolean;
  /** The session store's `openProject`. */
  openProject: (path: string) => Promise<{ ok: boolean; error?: string }>;
  activeTab: () => ShellTabId;
  setActiveTab: (tab: ShellTabId) => void;
  /** The tabs this build shows (Motion is absent from the beta, D-391). */
  availableTabs: readonly ShellTabId[];
}

export type RestoreOutcome =
  /** a cold launch, or the previous page had closed its project */
  | { kind: 'nothing' }
  /** this page opened a project before the restore could */
  | { kind: 'already-open' }
  | { kind: 'reopened'; project: { name: string; path: string }; tab: ShellTabId }
  | { kind: 'failed'; project: { name: string; path: string }; error: string };

const SESSION_READ_FAILED = 'could not read the page session from the backend';

/** Restore the previous page's project and tab, if there was one. Never
 *  throws: a backend that cannot answer restores nothing. */
export async function restorePageSession(deps: PageSessionDeps): Promise<RestoreOutcome> {
  let session: PageSession;
  try {
    session = await deps.invoke<PageSession>('chroma_page_session_get');
  } catch (e) {
    console.error(`[page-session] ${SESSION_READ_FAILED}: ${String(e)}`);
    return { kind: 'nothing' };
  }
  const project = session?.project;
  if (!project) return { kind: 'nothing' };
  if (deps.isProjectOpen()) return { kind: 'already-open' };

  // The tab first: the launcher covers it until the project is open, so the
  // project appears straight on the tab it was left on.
  const previousTab = deps.activeTab();
  const tab =
    session.activeTab && deps.availableTabs.includes(session.activeTab) ? session.activeTab : previousTab;
  deps.setActiveTab(tab);

  const opened = await deps.openProject(project.path);
  if (opened.ok) return { kind: 'reopened', project, tab };

  deps.setActiveTab(previousTab);
  const error = opened.error ?? 'unknown error';
  // Clear the backend's binding only if nothing else has opened a project
  // meanwhile and it still names the one that failed: a concurrent
  // `open_project` (which made ours fail on the session lock) must keep its own.
  if (!deps.isProjectOpen()) {
    try {
      const now = await deps.invoke<PageSession>('chroma_page_session_get');
      if (now?.project?.path === project.path) await deps.invoke('chroma_project_close');
    } catch (e) {
      console.error(`[page-session] could not clear the unreachable project: ${String(e)}`);
    }
  }
  return { kind: 'failed', project, error };
}

const RESTORE_CACHE = Symbol.for('apelles.page.sessionRestore');

/** [`restorePageSession`] ONCE per page load, the promise cached on `target`
 *  (the window), so React StrictMode's double-mounted effect and a hot-updated
 *  module share one restore instead of opening the project twice. */
export function restorePageSessionOnce(target: object, deps: PageSessionDeps): Promise<RestoreOutcome> {
  const cache = target as { [RESTORE_CACHE]?: Promise<RestoreOutcome> };
  cache[RESTORE_CACHE] ??= restorePageSession(deps);
  return cache[RESTORE_CACHE];
}

/** Tell the backend which tab is showing, for the next page. Best-effort: a
 *  failure costs only the tab after a reload. */
export function reportActiveTab(
  invoke: PageSessionDeps['invoke'],
  tab: ShellTabId,
): Promise<void> {
  return invoke('chroma_page_session_set_tab', { tab }).then(
    () => undefined,
    (e: unknown) => {
      console.error(`[page-session] could not record the active tab: ${String(e)}`);
    },
  );
}

/** What the user is told when the project cannot come back. */
export function restoreFailureMessage(outcome: Extract<RestoreOutcome, { kind: 'failed' }>): string {
  return `The project that was open, "${outcome.project.name}", could not be reopened after the window reloaded: ${outcome.error}. It may have been moved or deleted. Open it again from the launcher.`;
}
