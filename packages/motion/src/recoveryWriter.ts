/**
 * @apelles/motion — the Motion tab's unsaved-edit recovery writer (D-415).
 *
 * What it is: a small scheduler in front of the recovery copy
 *   (`apelles_motion::recovery`, `<project>/motion/manifest.recovery.json`).
 *   `useMotionManifest` tells it what the unsaved manifest text is; it writes
 *   that behind a short debounce, and removes the copy when the text is saved,
 *   undone back to the saved document or discarded.
 * What it does: debounces writes (`RECOVERY_DEBOUNCE_MS`, so a drag does not
 *   write per pointer move), runs every backend call through ONE promise chain
 *   (a write can never land after the clear that followed it), `flush`es a
 *   pending write now (the page is being hidden, or the tab unmounts), and
 *   reports a failed write through `onError` instead of throwing.
 * What it does NOT do: read or apply a recovery (that is the hook's one-time
 *   restore), touch the saved manifest, or know what a manifest is. The
 *   backend is injected, so the unit tests need no Tauri.
 */

/** How long after the last change the recovery copy is written. Short on
 *  purpose: it is the window a killed web content process can still cost. */
export const RECOVERY_DEBOUNCE_MS = 250;

export interface RecoveryBackend {
  write(text: string): Promise<void>;
  clear(): Promise<void>;
}

export interface RecoveryTimers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface RecoveryWriter {
  /** Remember `text` as the unsaved manifest; written after the debounce. */
  schedule(text: string): void;
  /** Write a pending text now. No-op when nothing is pending. */
  flush(): void;
  /** Drop any pending text and remove the copy. */
  clear(): void;
  /** Resolves once every call made so far has reached the backend. */
  settled(): Promise<void>;
}

const BROWSER_TIMERS: RecoveryTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle),
};

export function createRecoveryWriter(
  backend: RecoveryBackend,
  onError: (error: unknown) => void,
  timers: RecoveryTimers = BROWSER_TIMERS,
  delayMs: number = RECOVERY_DEBOUNCE_MS,
): RecoveryWriter {
  let pending: string | null = null;
  let timer: number | null = null;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>) => {
    tail = tail.then(op).catch(onError);
  };
  const cancelTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  const flush = () => {
    cancelTimer();
    if (pending === null) return;
    const text = pending;
    pending = null;
    enqueue(() => backend.write(text));
  };

  return {
    schedule(text) {
      pending = text;
      cancelTimer();
      timer = timers.set(flush, delayMs);
    },
    flush,
    clear() {
      cancelTimer();
      pending = null;
      enqueue(() => backend.clear());
    },
    settled: () => tail,
  };
}
