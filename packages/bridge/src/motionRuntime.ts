/**
 * `@apelles/bridge` — the frontend's single view of Motion's render runtime
 * (D-417).
 *
 * **What it is.** One store over `chroma_motion_runtime_status` /
 * `chroma_motion_runtime_install` / `chroma_motion_runtime_remove` / the
 * `motion-runtime-status` event, plus the pure functions that turn a
 * `MotionRuntimeStatus` into what a surface shows and whether a render
 * control is usable. The Motion tab's banner and its Render / Still / Check
 * buttons and the Settings card all read it, so they can never disagree.
 *
 * **Why here.** Like `aiEnv.ts`: this is the frontend↔backend seam both
 * `app/src` (Settings) and `packages/motion` (the tab) may depend on.
 *
 * **How it differs from `aiEnv.ts` — it DOES gate.** The AI environment's
 * status cannot tell whether a sidecar answers (a developer may run one by
 * hand), so that module never refuses a click. Here the backend's resolver is
 * the one every render path uses (`apelles_motion_runtime::manager::require`),
 * so "not ready" here is exactly "a render would fail now": Render, Still and
 * the component check are disabled with the reason, rather than started and
 * failed. Editing never depends on it.
 *
 * **What it does NOT do:** decide when to download. `useMotionRuntimeAutoInstall`
 * is the Motion tab's "first time it opens" rule (owner decision recorded with
 * D-391); the store only starts an install when asked.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { safeUnlisten } from './tauriListeners';

/** The live status push. Must match `chroma::motion_runtime::STATUS_EVENT` (a Rust
 *  test pins this file's spelling of it). */
export const MOTION_RUNTIME_STATUS_EVENT = 'motion-runtime-status';

/** The first word of a render that failed because the runtime is not ready
 *  (`apelles_motion_runtime::NOT_READY_CODE`). */
export const MOTION_RUNTIME_NOT_READY_CODE = 'motion_runtime_not_ready';

const STATUS_COMMAND = 'chroma_motion_runtime_status';
const INSTALL_COMMAND = 'chroma_motion_runtime_install';
const REMOVE_COMMAND = 'chroma_motion_runtime_remove';

/** `apelles_motion_runtime::manager::State`, camelCase on the wire. */
export type MotionRuntimeState =
  | 'unconfigured'
  | 'ready'
  | 'missing'
  | 'outdated'
  | 'broken'
  | 'installing'
  | 'failed'
  | 'removing';

/** `apelles_motion_runtime::manager::RuntimeStatus`, verbatim. */
export interface MotionRuntimeStatus {
  state: MotionRuntimeState;
  /** One sentence; safe to render verbatim. */
  detail: string;
  source?: 'developer' | 'managed';
  step?: 'downloading' | 'unpacking' | 'finishing';
  label?: string;
  bytesDone: number;
  bytesTotal: number;
  downloadBytes: number;
  installedBytes: number;
  errorKind?: string;
  error?: string;
  node?: string;
  runtimeDir?: string;
  versions: { node: string; chrome: string; remotion: string };
  canInstall: boolean;
  canRemove: boolean;
}

/** What the frontend believes before the backend has answered. */
export const MOTION_RUNTIME_UNKNOWN: MotionRuntimeStatus = {
  state: 'unconfigured',
  detail: 'Checking the Motion runtime',
  bytesDone: 0,
  bytesTotal: 0,
  downloadBytes: 0,
  installedBytes: 0,
  versions: { node: '', chrome: '', remotion: '' },
  canInstall: false,
  canRemove: false,
};

const MB = 1024 * 1024;

/** `"152 MB"`. */
export function formatMegabytes(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / MB))} MB`;
}

/** Renders work now. */
export function motionRuntimeReady(status: MotionRuntimeStatus): boolean {
  return status.state === 'ready';
}

/** 0..100 while downloading, `null` otherwise. */
export function motionRuntimeProgress(status: MotionRuntimeStatus): number | null {
  if (status.state !== 'installing' || status.bytesTotal <= 0) return null;
  return Math.min(100, Math.round((status.bytesDone / status.bytesTotal) * 100));
}

/**
 * Why a render control is disabled right now, or `null` when it is usable.
 * `what` names the action ("Render", "Still", "Run check").
 */
export function motionRuntimeBlockedReason(status: MotionRuntimeStatus, what: string): string | null {
  switch (status.state) {
    case 'ready':
      return null;
    case 'installing': {
      const pct = motionRuntimeProgress(status);
      return `${what} needs Motion's renderer, which is downloading${pct === null ? '' : ` (${pct}%)`}.`;
    }
    case 'failed':
      return `${what} needs Motion's renderer, and its download failed: ${status.error ?? status.detail}`;
    case 'unconfigured':
      return `${what} needs Motion's renderer; checking whether it is installed.`;
    case 'removing':
      return `${what} needs Motion's renderer, which is being removed.`;
    default:
      return `${what} needs Motion's renderer: ${status.detail}`;
  }
}

/** The banner's one line for a state that needs one; `null` when ready. */
export function motionRuntimeHeadline(status: MotionRuntimeStatus): string | null {
  switch (status.state) {
    case 'ready':
      return null;
    case 'installing':
      if (status.step === 'unpacking') return `Installing Motion's renderer — unpacking ${status.label ?? ''}`.trim();
      if (status.step === 'finishing') return "Installing Motion's renderer — finishing";
      return `Downloading Motion's renderer — ${formatMegabytes(status.bytesDone)} of ${formatMegabytes(status.bytesTotal)}`;
    case 'failed':
      return status.errorKind === 'offline'
        ? "Motion's renderer could not be downloaded: no internet connection"
        : status.errorKind === 'diskSpace'
          ? "Motion's renderer could not be installed: not enough disk space"
          : "Motion's renderer could not be installed";
    case 'outdated':
      return "Motion's renderer needs an update for this version of Apelles";
    case 'broken':
      return "Motion's renderer is damaged and needs reinstalling";
    case 'missing':
      return `Motion's renderer is not installed yet (a one-time ${formatMegabytes(status.downloadBytes)} download)`;
    case 'removing':
      return "Removing Motion's renderer";
    case 'unconfigured':
      return null;
  }
}

// ---- the store ---------------------------------------------------------------------

interface MotionRuntimeStoreState {
  status: MotionRuntimeStatus;
  /** `false` until the first status read answers. */
  loaded: boolean;
  /** A request (install / remove) is in flight. */
  busy: boolean;
  /** The last install / remove refusal, shown beside the button. */
  actionError: string | null;
  refresh(): Promise<MotionRuntimeStatus>;
  /** Start the download; resolves `true` when one started. */
  install(): Promise<boolean>;
  /** "Remove Motion runtime". */
  remove(): Promise<boolean>;
}

/** `chroma_motion_runtime_install`'s answer: the status plus `started`. */
type InstallAnswer = MotionRuntimeStatus & { started: boolean };

export const useMotionRuntimeStore = create<MotionRuntimeStoreState>((set, get) => ({
  status: MOTION_RUNTIME_UNKNOWN,
  loaded: false,
  busy: false,
  actionError: null,

  refresh: async () => {
    const status = await invoke<MotionRuntimeStatus>(STATUS_COMMAND);
    set({ status, loaded: true });
    return status;
  },

  install: async () => {
    if (get().busy) return false;
    set({ busy: true, actionError: null });
    try {
      const { started, ...status } = await invoke<InstallAnswer>(INSTALL_COMMAND);
      set({ status, loaded: true });
      return started;
    } catch (e) {
      set({ actionError: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  remove: async () => {
    if (get().busy) return false;
    set({ busy: true, actionError: null });
    try {
      const status = await invoke<MotionRuntimeStatus>(REMOVE_COMMAND);
      set({ status, loaded: true });
      return true;
    } catch (e) {
      set({ actionError: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      set({ busy: false });
    }
  },
}));

// ---- subscription, reference-counted (the aiEnv.ts pattern) ------------------------

let watchers = 0;
let unlisten: Promise<() => void> | null = null;

function noop(): void {
  /* a failed status read is retried by the next event or mount */
}

/** Start watching the runtime; returns the matching stop. Reference-counted. */
export function watchMotionRuntime(): () => void {
  watchers += 1;
  if (watchers === 1) {
    void useMotionRuntimeStore.getState().refresh().catch(noop);
    const registration = listen<MotionRuntimeStatus>(MOTION_RUNTIME_STATUS_EVENT, (event) => {
      useMotionRuntimeStore.setState({ status: event.payload, loaded: true });
    });
    // With no Tauri bridge (a jsdom test) `listen()` rejects at once; handle it
    // now rather than only at teardown.
    registration.catch(noop);
    unlisten = registration;
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
  };
}

/** The runtime state, kept live while the component is mounted. */
export function useMotionRuntime(): MotionRuntimeStoreState {
  useEffect(() => watchMotionRuntime(), []);
  return useMotionRuntimeStore();
}

/** Whether this app session has already started an automatic download. */
let autoInstallAsked = false;

/** States an automatic install is for (never `failed`: a failure waits for Retry). */
const AUTO_INSTALL_STATES: readonly MotionRuntimeState[] = ['missing', 'outdated', 'broken'];

/**
 * The owner's rule (recorded with D-391, built as D-417): the runtime downloads
 * in the background the first time the Motion tab opens. Once per app session,
 * only from a state an install fixes, never after a failure (Retry is a click),
 * and never in a development build that renders with its own Node.
 */
export function shouldAutoInstall(status: MotionRuntimeStatus, alreadyAsked: boolean): boolean {
  return !alreadyAsked && status.canInstall && AUTO_INSTALL_STATES.includes(status.state);
}

/** The Motion tab calls this once mounted. */
export function useMotionRuntimeAutoInstall(): void {
  const { status, loaded, install } = useMotionRuntime();
  useEffect(() => {
    if (!loaded || !shouldAutoInstall(status, autoInstallAsked)) return;
    autoInstallAsked = true;
    void install();
  }, [loaded, status, install]);
}

/** Tests only: forget that this session already auto-installed. */
export function resetMotionRuntimeAutoInstallForTests(): void {
  autoInstallAsked = false;
}
