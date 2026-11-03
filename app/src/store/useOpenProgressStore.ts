/**
 * useOpenProgressStore.ts - the live project open, for the branded loader (B-369).
 *
 * What it is: a zustand store over `openProgress.ts`'s reducer, plus the three
 *   calls `useSessionStore`'s `openProject`/`newProject` make around an open:
 *   - `beginOpen` hands out the `openId` the Rust command tags its
 *     `chroma://project-open-progress` events with (`reading`, `media` n/N,
 *     `preview`), and starts listening for them;
 *   - `advanceOpen` moves the open to a frontend phase (`grades`);
 *   - `followOpenToReady` runs after the session is hydrated: `timeline` until
 *     the Edit tab's store holds this project's timeline, `previews` until the
 *     first preview frame is on screen, then ends the open. Each wait is capped
 *     so a stuck pane can never leave the loader up over a usable workspace.
 * What it does: in a debug build, writes one `apelles:open:<phase>` mark per
 *   phase and an `apelles:open:<phase>` measure for each phase's length, plus
 *   `apelles:open:total`, readable through `debug_perf_entries`.
 * What it does NOT do: render (`ProjectOpenOverlay` and the launcher card read
 *   it) or decide phase order and words (the reducer does).
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createSharedStore, sharedValue } from '@apelles/store';
import { nextPreviewFrame, perfMark, perfMeasure, useEditorTimelineStore } from '@apelles/editor';

import {
  INITIAL_OPEN_PROGRESS,
  OPEN_PERF_END,
  OPEN_PERF_PREFIX,
  OPEN_PERF_START,
  isOpenPhase,
  openPhaseMark,
  reduceOpenProgress,
  type OpenKind,
  type OpenPhase,
  type OpenProgressAction,
  type OpenProgressState,
} from './openProgress';

/** The event `app/src-tauri/src/chroma/open_progress.rs` sends. */
export const OPEN_PROGRESS_EVENT = 'chroma://project-open-progress';

/** The longest the loader waits for the Edit tab's timeline after the session is up. */
export const TIMELINE_WAIT_CAP_MS = 15_000;
/** The longest it waits for the first preview frame (an empty timeline has none). */
export const FIRST_FRAME_WAIT_CAP_MS = 4_000;

interface OpenProgressStore extends OpenProgressState {
  dispatch: (action: OpenProgressAction) => void;
}

export const useOpenProgressStore = createSharedStore<OpenProgressStore>('app.openProgress', (set) => ({
  ...INITIAL_OPEN_PROGRESS,
  dispatch: (action) => set((s) => reduceOpenProgress(s, action)),
}));

interface EventPayload {
  openId?: number;
  phase?: string;
  done?: number;
  total?: number;
}

// The phase whose mark was written last, so the next transition can measure it.
const marks = sharedValue<{ phase: OpenPhase | null }>('app.openProgress.marks', () => ({ phase: null }));

function markPhase(phase: OpenPhase): void {
  if (marks.phase === phase) return;
  if (marks.phase) perfMeasure(`${OPEN_PERF_PREFIX}${marks.phase}`, openPhaseMark(marks.phase));
  marks.phase = phase;
  perfMark(openPhaseMark(phase));
}

function dispatch(action: OpenProgressAction): void {
  const before = useOpenProgressStore.getState();
  before.dispatch(action);
  const after = useOpenProgressStore.getState();
  if (after.active && after.phase && after.phase !== before.phase) markPhase(after.phase);
}

const listener = sharedValue<{ p: Promise<UnlistenFn | null> | null }>('app.openProgress.listener', () => ({ p: null }));

/** Listen for the Rust phases once per page. A failed listen costs the Rust
 *  phases' labels only; the frontend phases still show. */
function ensureListening(): Promise<UnlistenFn | null> {
  if (!listener.p) {
    listener.p = listen<EventPayload>(OPEN_PROGRESS_EVENT, (ev) => {
      const { openId, phase, done, total } = ev.payload ?? {};
      if (typeof openId !== 'number' || !isOpenPhase(phase)) return;
      dispatch({ type: 'progress', openId, phase, done, total });
    }).catch((e) => {
      console.error('[openProgress] could not listen for open progress:', e);
      listener.p = null;
      return null;
    });
  }
  return listener.p;
}

/** Start an open; returns the id to pass to `chroma_project_open`/`_new`. */
export async function beginOpen(kind: OpenKind, projectName: string | null): Promise<number> {
  const openId = useOpenProgressStore.getState().openId + 1;
  marks.phase = null;
  perfMark(OPEN_PERF_START);
  dispatch({ type: 'start', openId, kind, projectName });
  markPhase('reading');
  // Listening is in place before the command runs, so no Rust event is missed.
  await ensureListening();
  return openId;
}

export function advanceOpen(openId: number, phase: OpenPhase, done?: number, total?: number): void {
  dispatch({ type: 'progress', openId, phase, done, total });
}

/** End the open (success or not), closing the last phase's measure. */
export function endOpen(openId: number, ok: boolean): void {
  const s = useOpenProgressStore.getState();
  if (s.openId !== openId || !s.active) return;
  if (marks.phase) perfMeasure(`${OPEN_PERF_PREFIX}${marks.phase}`, openPhaseMark(marks.phase));
  marks.phase = null;
  if (ok) {
    perfMark(OPEN_PERF_END);
    perfMeasure(`${OPEN_PERF_PREFIX}total`, OPEN_PERF_START);
  }
  dispatch({ type: ok ? 'finish' : 'fail', openId });
}

/** True while `openId` is still the open on screen. */
const current = (openId: number): boolean => {
  const s = useOpenProgressStore.getState();
  return s.active && s.openId === openId;
};

/** Resolve once the Edit tab's store holds `projectKey`'s timeline (or failed to), or after the cap. */
export function waitForTimeline(projectKey: string, capMs: number = TIMELINE_WAIT_CAP_MS): Promise<boolean> {
  const settled = (): boolean => {
    const s = useEditorTimelineStore.getState();
    return s.openProjectKey === projectKey && (s.status === 'ready' || s.status === 'error');
  };
  if (settled()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, capMs);
    const unsubscribe = useEditorTimelineStore.subscribe(() => {
      if (!settled()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/**
 * The tail of an open, after the session is hydrated: the timeline, then the
 * first picture, then done. Never throws; every wait is capped.
 */
export async function followOpenToReady(openId: number, projectKey: string | null): Promise<void> {
  if (!current(openId)) return;
  if (projectKey) {
    advanceOpen(openId, 'timeline');
    await waitForTimeline(projectKey);
    if (!current(openId)) return;
    const s = useEditorTimelineStore.getState();
    const hasPicture = s.status === 'ready' && !!s.timeline && s.timeline.tracks.some((t) => t.clips.length > 0);
    if (hasPicture) {
      advanceOpen(openId, 'previews');
      await nextPreviewFrame(FIRST_FRAME_WAIT_CAP_MS);
    }
  }
  endOpen(openId, true);
}
