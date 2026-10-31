/**
 * `@apelles/bridge` — the frontend's view of the AI-video-understanding flag
 * (D-432).
 *
 * **What it is.** One store over `chroma_video_understanding_status` /
 * `chroma_set_video_understanding` / the `video-understanding-status` event, plus
 * the pure functions that turn a status into the words a surface shows. The
 * Settings card and the Edit tab's analysis entry points read it from here.
 *
 * **Why it lives in `@apelles/bridge`.** Same reason as `aiEnv`: the seam both
 * `app/src` (Settings) and `packages/editor` (media understanding) may depend on.
 *
 * **What it does NOT do.** It is not the gate. The refusal that actually stops an
 * analysis lives in Rust (`chroma_analyze_video`), so a surface that forgets to
 * read this cannot start one; this store only lets a surface say so *before* a
 * click, and flip the setting. The flag itself persists in `settings.json`, not
 * here.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { safeUnlisten } from './tauriListeners';

/** Must match `chroma::video_understanding::STATUS_EVENT`. */
export const VIDEO_UNDERSTANDING_STATUS_EVENT = 'video-understanding-status';

const STATUS_COMMAND = 'chroma_video_understanding_status';
const SET_COMMAND = 'chroma_set_video_understanding';

/** Below this much installed RAM the warning shows. Mirrors Rust's
 *  `LOW_MEMORY_BYTES`; the backend also reports `lowMemory`, which wins. */
export const LOW_MEMORY_GB = 16;

const BYTES_PER_GB = 1024 ** 3;

/** `chroma::video_understanding::VideoUnderstandingStatus`, `camelCase` on the wire. */
export interface VideoUnderstandingStatus {
  enabled: boolean;
  /** Installed RAM, or `null` when it could not be read. */
  totalMemoryBytes: number | null;
  lowMemory: boolean;
  /** The user-facing refusal while disabled; `null` while enabled. */
  refusal: string | null;
  howToEnable: string;
}

/** `"24 GB"`, or `null` when the RAM is unknown. */
export function formatRam(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  return `${Math.round(bytes / BYTES_PER_GB)} GB`;
}

/** The warning for a small Mac, or `null`. */
export function lowMemoryWarning(status: VideoUnderstandingStatus): string | null {
  if (!status.lowMemory) return null;
  const ram = formatRam(status.totalMemoryBytes);
  return `This Mac has ${ram ?? `under ${LOW_MEMORY_GB} GB`} of memory. Video understanding can use up to ~9 GB while it runs, which may slow or stall other apps. You can still turn it on.`;
}

interface VideoUnderstandingState {
  /** `null` until the first answer. */
  status: VideoUnderstandingStatus | null;
  refresh(): Promise<VideoUnderstandingStatus>;
  setEnabled(enabled: boolean): Promise<VideoUnderstandingStatus>;
}

export const useVideoUnderstandingStore = create<VideoUnderstandingState>((set) => ({
  status: null,

  refresh: async () => {
    const status = await invoke<VideoUnderstandingStatus>(STATUS_COMMAND);
    set({ status });
    return status;
  },

  setEnabled: async (enabled) => {
    const status = await invoke<VideoUnderstandingStatus>(SET_COMMAND, { enabled });
    set({ status });
    return status;
  },
}));

function noop(): void {
  /* a failed read is not worth a console line */
}

let watchers = 0;
let unlisten: Promise<() => void> | null = null;

/** Start watching the flag; returns the matching stop. Reference-counted. */
export function watchVideoUnderstanding(): () => void {
  watchers += 1;
  if (watchers === 1) {
    void useVideoUnderstandingStore.getState().refresh().catch(noop);
    const registration = listen<VideoUnderstandingStatus>(
      VIDEO_UNDERSTANDING_STATUS_EVENT,
      (event) => useVideoUnderstandingStore.setState({ status: event.payload }),
    );
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

/** The flag's state, kept live while the component is mounted. */
export function useVideoUnderstanding(): VideoUnderstandingState {
  useEffect(() => watchVideoUnderstanding(), []);
  return useVideoUnderstandingStore();
}
