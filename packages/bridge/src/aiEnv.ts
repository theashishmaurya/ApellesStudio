/**
 * `@apelles/bridge` — the frontend's single view of the AI-environment
 * bootstrap (D-315).
 *
 * **What it is.** One store over `chroma_ai_env_status` / `chroma_ai_env_retry`
 * / the `ai-env-status` event, plus the small set of pure functions that turn
 * an `AiEnvStatus` into the words a surface shows. Every consumer — the
 * Settings card, each masking/relight control, the Edit tab's caption button —
 * reads from here.
 *
 * **Why one shared piece and not an `invoke` + `listen` in each component.**
 * Tauri events are not buffered (see `app/src-tauri/src/chroma/control.rs`'s
 * module doc): a listener that registers after an event was emitted never sees
 * it. So *every* consumer has to do the same two-step — read the current state
 * once with `chroma_ai_env_status`, then keep up via `listen('ai-env-status')`
 * — and five hand-written copies of that would be five chances to get the
 * ordering, the teardown or the "unknown means not-yet-reported" rule wrong.
 * Here it is written once, reference-counted, and torn down when the last
 * consumer unmounts.
 *
 * **Why it lives in `@apelles/bridge`.** This is the frontend↔backend seam
 * (D-039), the one layer both `app/src` (masking, relight, Settings) and
 * `packages/editor` (captions, media understanding) are allowed to depend on.
 * `app/src/hooks/` would have been the obvious home for the app-side consumers
 * and is unusable for the editor ones, since `packages/*` sits below `app/` in
 * the layer order and cannot import from it.
 *
 * **Why it polls as well as listening.** Two fields move without a state
 * change to announce them: `elapsedSecs` is refreshed by the supervisor's own
 * 250 ms ticker *under the lock*, with no notify, and `retryInSecs` is written
 * exactly once when an attempt fails and then never decremented. So a purely
 * event-driven UI would show a frozen "0s so far" through a five-minute
 * download and a "retry in 45s" that stays at 45 forever. The fix is one 1 s
 * tick, live only while somebody is watching AND the phase is one that
 * actually changes: it re-reads the snapshot during a working phase and counts
 * the retry down locally while `failed`. Nothing polls once the phase is
 * `ready`, `unavailable` or `unknown`.
 *
 * **What it does NOT do — and this is the important one: it never refuses a
 * call.** It reports a *state* ([`aiEnvIsBuilding`]) and supplies the sentence
 * to show for it ([`aiEnvNotice`]); every control that reads it stays enabled.
 * A pre-flight gate here would be wrong, not merely cautious: whether a sidecar
 * answers is not knowable from this status. A developer who started one by hand,
 * or set `CHROMA_SIDECAR_PYTHON`, has a working feature while this reports
 * `installingPackages`, and refusing would break exactly them. The app already
 * turns a call that genuinely fails into the `ai_env_not_ready` explanation,
 * reactively, at the single sidecar call site
 * (`apelles_ai::ai_env::explain_unreachable`). This module is the other half of
 * that: the part that can show the state *before* anyone clicks, which a
 * call-site explanation structurally cannot.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { safeUnlisten } from './tauriListeners';

/** The live status push. Must match `chroma::ai_env::STATUS_EVENT` (Rust has a
 *  test pinning that string for exactly this reason). */
export const AI_ENV_STATUS_EVENT = 'ai-env-status';

const STATUS_COMMAND = 'chroma_ai_env_status';
const RETRY_COMMAND = 'chroma_ai_env_retry';

/** How often the tick below runs while a phase is still moving. */
const TICK_MS = 1000;

/** `apelles_ai::ai_env::Phase`, `camelCase` on the wire. */
export type AiEnvPhase =
  | 'unknown'
  | 'checking'
  | 'installingPython'
  | 'creatingVenv'
  | 'installingPackages'
  | 'repairing'
  | 'ready'
  | 'failed'
  | 'unavailable';

/** `apelles_ai::ai_env::AiEnvStatus`, verbatim. Field docs are on the Rust
 *  struct; the two that a UI most easily gets wrong are repeated here. */
export interface AiEnvStatus {
  phase: AiEnvPhase;
  /** One human sentence for the current phase — safe to render verbatim. */
  detail?: string;
  packagesDone: number;
  packagesTotal: number;
  attempt: number;
  /** Seconds until the next *automatic* attempt. Only ever present on
   *  `failed`; `unavailable` deliberately has none, because nothing about
   *  waiting would change it. */
  retryInSecs?: number;
  lastError?: string;
  venv?: string;
  elapsedSecs: number;
}

/** What the frontend believes before the backend has said anything. */
const UNKNOWN: AiEnvStatus = {
  phase: 'unknown',
  packagesDone: 0,
  packagesTotal: 0,
  attempt: 0,
  elapsedSecs: 0,
};

/** The phases a user is expected to wait out. Mirrors `Phase::is_working()`. */
const WORKING_PHASES: readonly AiEnvPhase[] = [
  'checking',
  'installingPython',
  'creatingVenv',
  'installingPackages',
  'repairing',
];

export function aiEnvIsWorking(phase: AiEnvPhase): boolean {
  return WORKING_PHASES.includes(phase);
}

/**
 * Is the shared environment still being built, or did its build fail?
 *
 * `true` for the working phases and for `failed` — the two states in which an
 * AI feature is *likely* (not certainly) to fail, and in which a surface should
 * say so before anyone clicks.
 *
 * **This is a state, not a gate.** Nothing in this file refuses a call. Whether
 * a sidecar actually answers is not knowable from here: a developer may have
 * started one by hand, or pointed `CHROMA_SIDECAR_PYTHON` at their own
 * interpreter, and either works perfectly while this reports `installingPackages`.
 * Refusing up front would break exactly those setups. The app already turns a
 * call that genuinely fails into the `ai_env_not_ready` explanation, reactively,
 * at the one sidecar call site (`apelles_ai::ai_env::explain_unreachable`); what
 * that cannot do — and what everything here exists for — is put the state on
 * screen *before* the click.
 *
 * `false` for `unavailable` (the state a hand-built venv sits in — see
 * [`aiEnvWarning`], which says so in its own words) and for `unknown` (the
 * supervisor thread has not reported yet, true for the first milliseconds of
 * every launch).
 */
export function aiEnvIsBuilding(status: AiEnvStatus): boolean {
  return aiEnvIsWorking(status.phase) || status.phase === 'failed';
}

/** `"142 of 163 packages"`, or `null` when uv has not said a total yet. */
export function aiEnvProgressLabel(status: AiEnvStatus): string | null {
  if (status.packagesTotal <= 0) return null;
  return `${status.packagesDone} of ${status.packagesTotal} packages`;
}

const PHASE_LABELS: Record<AiEnvPhase, string> = {
  unknown: 'Checking the AI environment',
  checking: 'Checking the AI environment',
  installingPython: 'Downloading Python for the AI environment',
  creatingVenv: 'Creating the AI environment',
  installingPackages: 'Installing AI packages',
  repairing: 'Repairing the AI environment',
  ready: 'AI environment ready',
  failed: 'AI environment setup failed',
  unavailable: 'Automatic AI setup unavailable',
};

/** A short title for the current state — the Settings card's heading. */
export function aiEnvHeadline(status: AiEnvStatus): string {
  const label = PHASE_LABELS[status.phase];
  const progress = status.phase === 'installingPackages' ? aiEnvProgressLabel(status) : null;
  return progress ? `${label} — ${progress}` : label;
}

/**
 * What to tell someone looking at a named AI control right now — or `null` when
 * there is nothing to say.
 *
 * The whole point of D-315's GUI half: the one-time 1.6 GB environment build is
 * visible, with real progress, at the control that depends on it, *before* it is
 * clicked. Phrased as information rather than refusal, because it is: the
 * control stays enabled (see [`aiEnvIsBuilding`]), and a click that does fail
 * comes back with the agent half's `ai_env_not_ready` explanation rather than a
 * raw connection error.
 */
export function aiEnvNotice(status: AiEnvStatus, feature: string): string | null {
  if (!aiEnvIsBuilding(status)) return null;
  if (status.phase === 'failed') {
    const why = status.lastError ? ` (${status.lastError})` : '';
    return `${feature} needs the AI environment, and its one-time setup failed${why}. Retry it in Settings › AI Environment.`;
  }
  const progress = aiEnvProgressLabel(status);
  const where = progress ? ` — ${progress}` : '';
  return `${feature} needs the AI environment, which is still setting up${where}. This runs once; it will work as soon as it finishes (Settings › AI Environment shows progress).`;
}

/** The note for `unavailable`, where nothing is scheduled and the environment
 *  only exists if somebody built it by hand. `null` otherwise. */
export function aiEnvWarning(status: AiEnvStatus): string | null {
  if (status.phase !== 'unavailable') return null;
  const why = status.detail ? ` ${status.detail}` : '';
  return `Automatic AI setup is unavailable on this build, so AI features only work if the Python environment was installed by hand.${why}`;
}

// ---- the store ---------------------------------------------------------------------

interface AiEnvState {
  status: AiEnvStatus;
  /** `false` until the first `chroma_ai_env_status` answers — distinct from
   *  `phase: 'unknown'`, which is a real answer meaning "not reported yet". */
  loaded: boolean;
  /** Seconds until the next automatic attempt, ticked down locally. `null`
   *  unless the phase is `failed`, which is the only phase that has one. */
  retryIn: number | null;
  /** A "Retry now" click is in flight. */
  retrying: boolean;
  /** Set when `chroma_ai_env_retry` declined (returned `false`) — there was
   *  nothing to retry. Cleared by the next status change. */
  retryDeclined: boolean;
  /** Read the current snapshot. Cheap: a mutex read on the Rust side. */
  refresh(): Promise<AiEnvStatus>;
  /** Interrupt the backoff and try again now — and, on `ready`, re-verify a
   *  cached answer (a venv deleted after the app started would otherwise be
   *  reported healthy until a restart). Resolves `false` only when the backend
   *  declined: an attempt already in flight, or `unavailable`, where there is
   *  no supervisor thread left to wake (B-174). */
  retry(): Promise<boolean>;
}

function applyStatus(status: AiEnvStatus): Partial<AiEnvState> {
  return {
    status,
    loaded: true,
    retryIn: status.phase === 'failed' ? (status.retryInSecs ?? null) : null,
    retryDeclined: false,
  };
}

export const useAiEnvStore = create<AiEnvState>((set, get) => ({
  status: UNKNOWN,
  loaded: false,
  retryIn: null,
  retrying: false,
  retryDeclined: false,

  refresh: async () => {
    const status = await invoke<AiEnvStatus>(STATUS_COMMAND);
    // Keep a running countdown running: re-reading the snapshot must not reset
    // `retryIn` back to the backend's static `retryInSecs` on every tick.
    const previous = get();
    const keepCountdown =
      previous.status.phase === 'failed' &&
      status.phase === 'failed' &&
      status.attempt === previous.status.attempt &&
      previous.retryIn !== null;
    set(keepCountdown ? { status, loaded: true } : applyStatus(status));
    return status;
  },

  retry: async () => {
    if (get().retrying) return false;
    set({ retrying: true, retryDeclined: false });
    try {
      const accepted = await invoke<boolean>(RETRY_COMMAND);
      set({ retryDeclined: !accepted });
      // The supervisor emits its own status the moment it wakes; this just
      // stops the countdown from ticking on in the meantime.
      if (accepted) set({ retryIn: 0 });
      return accepted;
    } finally {
      set({ retrying: false });
    }
  },
}));

// ---- subscription, reference-counted -----------------------------------------------

let watchers = 0;
let unlisten: Promise<() => void> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const { status, retryIn } = useAiEnvStore.getState();
  if (aiEnvIsWorking(status.phase)) {
    // `elapsedSecs` and the package counts move without an event; re-read them.
    void useAiEnvStore.getState().refresh().catch(noop);
  } else if (status.phase === 'failed' && retryIn !== null) {
    useAiEnvStore.setState({ retryIn: Math.max(0, retryIn - 1) });
  }
}

function noop(): void {
  /* a failed status read is not worth a console line every second */
}

/**
 * Start watching the bootstrap, and return the matching stop.
 *
 * Reference-counted so N mounted consumers share one listener and one timer,
 * and React 19's double-invoked effects in development do not leave a
 * registration behind.
 */
export function watchAiEnv(): () => void {
  watchers += 1;
  if (watchers === 1) {
    // Read once, because the event stream cannot tell a late listener what it
    // missed, and then keep up from the event.
    void useAiEnvStore.getState().refresh().catch(noop);
    const registration = listen<AiEnvStatus>(AI_ENV_STATUS_EVENT, (event) => {
      useAiEnvStore.setState(applyStatus(event.payload));
    });
    // Caught here and not only in the teardown's `safeUnlisten`: with no Tauri
    // bridge on `window` at all (a jsdom component test, a browser preview)
    // `listen()` rejects immediately, and a rejection that only gets a handler
    // when the component unmounts is an unhandled rejection until then — which
    // vitest reports as a failure of whatever test happened to be running.
    registration.catch(noop);
    unlisten = registration;
    ticker = setInterval(tick, TICK_MS);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers -= 1;
    if (watchers > 0) return;
    if (unlisten) {
      safeUnlisten(unlisten);
      unlisten = null;
    }
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/** The bootstrap state, kept live for as long as the component is mounted. */
export function useAiEnv(): AiEnvState {
  useEffect(() => watchAiEnv(), []);
  return useAiEnvStore();
}
