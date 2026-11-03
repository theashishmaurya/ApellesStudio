/**
 * openProgress.ts - the project open's phases, as one pure reducer (B-369).
 *
 * What it is: the model behind the branded loader and `editor_get_state`'s
 *   `openProgress`. An open walks these phases in order:
 *
 *   | phase      | who reports it | what is happening                                   |
 *   |------------|----------------|-----------------------------------------------------|
 *   | `reading`  | Rust event     | `project.json` read, timeline ensured, grade migration |
 *   | `media`    | Rust event     | each video clip's source checked + probed (n of N)   |
 *   | `preview`  | Rust event     | the active clip's first frame decoded               |
 *   | `grades`   | `openProject`  | the shot list + every shot's grade loaded            |
 *   | `timeline` | the follow     | the Edit tab's timeline fetched and hydrated         |
 *   | `previews` | the follow     | the first Edit preview frame on screen              |
 *
 *   The Rust half arrives on `chroma://project-open-progress`
 *   (`app/src-tauri/src/chroma/open_progress.rs`), tagged with the `openId` this
 *   side handed to `chroma_project_open`, so a late event from an older open is
 *   dropped by its id, never by arrival order.
 * What it does: `reduceOpenProgress` (state + action -> state; phases only move
 *   forward, counts only grow within a phase) and `openProgressView` (the words
 *   and the 0..1 fraction a person sees).
 * What it does NOT do: listen, time, or render. `useOpenProgressStore.ts` wires
 *   it to Tauri and the stores; `@apelles/ui`'s `BrandedLoader` draws it.
 */

export const OPEN_PHASES = ['reading', 'media', 'preview', 'grades', 'timeline', 'previews'] as const;
export type OpenPhase = (typeof OPEN_PHASES)[number];

export type OpenKind = 'open' | 'new';

export interface OpenProgressState {
  /** The current (or last) open's token; 0 before the first. */
  openId: number;
  /** True from `start` until `finish`/`fail`. */
  active: boolean;
  kind: OpenKind;
  /** The project's name, for the loader's title; null when not known yet. */
  projectName: string | null;
  phase: OpenPhase | null;
  /** Items done in `phase` (only `media` counts today); 0 when the phase has no count. */
  done: number;
  total: number;
}

export type OpenProgressAction =
  | { type: 'start'; openId: number; kind: OpenKind; projectName: string | null }
  | { type: 'progress'; openId: number; phase: OpenPhase; done?: number; total?: number }
  | { type: 'finish'; openId: number }
  | { type: 'fail'; openId: number };

export const INITIAL_OPEN_PROGRESS: OpenProgressState = {
  openId: 0,
  active: false,
  kind: 'open',
  projectName: null,
  phase: null,
  done: 0,
  total: 0,
};

const phaseIndex = (p: OpenPhase | null): number => (p === null ? -1 : OPEN_PHASES.indexOf(p));

export function isOpenPhase(v: unknown): v is OpenPhase {
  return typeof v === 'string' && (OPEN_PHASES as readonly string[]).includes(v);
}

const count = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function reduceOpenProgress(state: OpenProgressState, action: OpenProgressAction): OpenProgressState {
  switch (action.type) {
    case 'start':
      return { openId: action.openId, active: true, kind: action.kind, projectName: action.projectName, phase: 'reading', done: 0, total: 0 };
    case 'progress': {
      if (!state.active || action.openId !== state.openId) return state;
      const next = phaseIndex(action.phase);
      const cur = phaseIndex(state.phase);
      if (next < cur) return state;
      const total = count(action.total);
      const done = Math.min(count(action.done), total);
      if (next === cur) {
        // the same phase: a throttled event can arrive behind a newer one
        if (done <= state.done && total === state.total) return state;
        return { ...state, done: Math.max(done, state.done), total: Math.max(total, state.total) };
      }
      return { ...state, phase: action.phase, done, total };
    }
    case 'finish':
    case 'fail':
      if (action.openId !== state.openId || !state.active) return state;
      return { ...state, active: false };
  }
}

/** What a person (and an agent) is told for one phase. */
export function openPhaseLabel(phase: OpenPhase, done: number, total: number, kind: OpenKind = 'open'): string {
  switch (phase) {
    case 'reading':
      return kind === 'new' ? 'Creating project…' : 'Reading project…';
    case 'media':
      return total > 0 ? `Checking media (${done}/${total})…` : 'Checking media…';
    case 'preview':
      return 'Decoding the first frame…';
    case 'grades':
      return 'Loading grades…';
    case 'timeline':
      return 'Building timeline…';
    case 'previews':
      return 'Preparing previews…';
  }
}

export interface OpenProgressView {
  phase: OpenPhase;
  label: string;
  /** 0..1 within the phase when its count is known, else null (indeterminate). */
  fraction: number | null;
  done: number;
  total: number;
  /** 1-based position of `phase` and the number of phases, for "step 2 of 6". */
  step: number;
  steps: number;
}

export function openProgressView(state: OpenProgressState): OpenProgressView | null {
  if (!state.active || state.phase === null) return null;
  return {
    phase: state.phase,
    label: openPhaseLabel(state.phase, state.done, state.total, state.kind),
    fraction: state.total > 0 ? state.done / state.total : null,
    done: state.done,
    total: state.total,
    step: phaseIndex(state.phase) + 1,
    steps: OPEN_PHASES.length,
  };
}

/** The `performance` mark written when an open enters `phase` (debug builds only). */
export const OPEN_PERF_PREFIX = 'apelles:open:';
export const openPhaseMark = (phase: OpenPhase): string => `${OPEN_PERF_PREFIX}${phase}`;
export const OPEN_PERF_START = `${OPEN_PERF_PREFIX}start`;
export const OPEN_PERF_END = `${OPEN_PERF_PREFIX}ready`;
