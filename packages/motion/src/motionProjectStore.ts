/**
 * @chroma/motion — the Motion tab's readiness state machine (B-058 / D-150).
 *
 * What it is: the one place that knows (a) whether a real `.chroma` project is
 *   open and (b) where the read of that project's motion manifest actually
 *   stands. Deliberately a store, not the tab's own `useState`, for the same
 *   reason `@chroma/editor`'s `timelineStore` is one: the "a project is open"
 *   signal comes from *outside* this package (the composition root,
 *   `app/src/main.tsx`, which owns `useSessionStore`) and the tab stays mounted
 *   from boot, so the signal has to be pushable into state that outlives any
 *   one render — D-039's layer direction (app → tabs) forbids reaching upward
 *   for it from here.
 * What it does: `setProjectOpen` (idempotent, the only input) starts and stops
 *   this store's work; `load()` reads the project's saved manifest, guarded by
 *   a monotonic token so a slow stale read can never overwrite a newer one.
 * What it does NOT do: no manifest text/parse/save/render state — that stays
 *   component-local in `useMotionManifest`, which seeds itself from `loaded`.
 *   No retry ladder and no IPC timeout (`@chroma/editor`'s store has both):
 *   those exist there for faults that were actually observed on that path
 *   (B-004's IPC corruption on cold boot), and speculating machinery here for
 *   faults this path has never shown would be exactly the kind of "fix" B-058
 *   is a lesson against.
 *
 * B-058 — **this tab used to infer "no project is open" from a failed read**,
 * the identical structural fault B-034/D-112 removed from `@chroma/editor`
 * after it had produced a false "No project open" screen five separate times
 * from five unrelated causes. A read that fails while a project is genuinely
 * open now says so (`status: 'error'` + the real backend text), and the only
 * thing that can produce the "No project open" screen is `projectOpen` being
 * false — the app's own source of truth, not a guess made from an error string.
 */
import { create } from 'zustand';

import { getSavedManifest } from './manifestIO';

/** Where the read of the project's manifest sidecar stands. Says nothing about
 *  whether a project is open — that is `projectOpen`, and only `projectOpen`. */
export type ManifestLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface LoadedManifest {
  /** Bumped on every fresh successful read. `useMotionManifest` seeds its
   *  editor text from a *new* generation only, so a re-render (or a second
   *  load that happens to return an identical manifest) can never silently
   *  throw away whatever the owner has typed since. */
  generation: number;
  /** The project's saved manifest, or `null` if it has never saved one (a
   *  fresh project — the tab falls back to the engine's sample). */
  manifest: unknown | null;
}

interface MotionProjectState {
  /** Pushed in from the composition root (`app/src/main.tsx`). True only for a
   *  real `.chroma` project on disk — see `setProjectOpen`'s doc. */
  projectOpen: boolean;
  status: ManifestLoadStatus;
  /** The real backend error behind `status === 'error'`; null otherwise. */
  error: string | null;
  loaded: LoadedManifest | null;

  /** The one signal that starts and stops this store's work. Idempotent — the
   *  composition root's effect may re-run with an unchanged value.
   *
   *  Note this is a *narrower* signal than the shell's own `projectOpen` (which
   *  is also true for an in-memory "Untitled" loose-clip session): the manifest
   *  sidecar lives at `<project>.chroma/motion/manifest.json`, so with no
   *  project directory on disk there is genuinely nowhere for Motion to read or
   *  write, and saying "no project open" then is the truth rather than a lie. */
  setProjectOpen: (open: boolean) => void;
  load: () => Promise<void>;
}

/** Monotonic request token. `load()` can be called from the composition-root
 *  bridge, a window `focus` recheck and the tab's own Retry button, and nothing
 *  serialises them — only the newest may write. (`@chroma/editor`'s store has
 *  the same guard, for the same reason: a stale failure landing after a fresh
 *  success is how a transient hiccup becomes a permanent wrong screen.) */
let loadToken = 0;
let loadGeneration = 0;

export const useMotionProjectStore = create<MotionProjectState>((set, get) => ({
  projectOpen: false,
  status: 'idle',
  error: null,
  loaded: null,

  setProjectOpen: (open) => {
    if (get().projectOpen === open) return;
    loadToken += 1; // orphan any read still in flight from the old project

    if (!open) {
      set({ projectOpen: false, status: 'idle', error: null, loaded: null });
      return;
    }

    set({ projectOpen: true, status: 'loading', error: null, loaded: null });
    void get().load();
  },

  load: async () => {
    // Never ask the backend while the app says no project is open. This is the
    // structural half of B-058: with no call there is no error to misread, and
    // the "No project open" screen has exactly one cause again.
    if (!get().projectOpen) return;

    const token = ++loadToken;
    if (get().status !== 'ready') set({ status: 'loading', error: null });
    try {
      const manifest = await getSavedManifest();
      if (token !== loadToken) return; // superseded — a newer load owns the state
      set({
        loaded: { generation: ++loadGeneration, manifest },
        status: 'ready',
        error: null,
      });
    } catch (e) {
      if (token !== loadToken) return; // superseded — never clobber a newer result
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
