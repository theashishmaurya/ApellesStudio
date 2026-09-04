/**
 * @chroma/editor — the Edit-tab timeline store (D-041, timeline switcher D-046
 * pass 3, undo/redo D-051).
 *
 * Kept in `@chroma/editor` for now; a `@chroma/bridge` extraction (shared
 * stores + typed Tauri bindings) is a separate later task (D-039 step 6).
 *
 * State: the `chroma-timeline` model for the **active** timeline, the
 * playhead (timeline frame), a play flag, and — D-046 pass 3 — the project's
 * full timeline list for the switcher UI (`TimelineSwitcher.tsx`). `load()`
 * fetches (`chroma_timeline_get`, always the active one); `applyOp()` mutates
 * optimistically then persists in the background (`chroma_timeline_set`,
 * debounced) — **no refetch after a plain save** (perf fix, 2026-09-04:
 * `chroma_timeline_set` stores whatever is sent verbatim, so a refetch after
 * it can only ever return what was already just applied locally — see
 * `_flushSave`'s own comment). `loadList()`/`createTimeline()`/
 * `setActiveTimeline()` wrap the D-045 `chroma_timeline_list`/`_create`/
 * `_set_active` commands that had no UI consumer until this pass.
 *
 * D-051: every real (non-no-op) `applyOp` call pushes a `{tab:'edit', ...}`
 * before/after snapshot pair onto `@chroma/history`'s shared undo stack —
 * whole-`Timeline` snapshots (not inverse deltas), because every op here is
 * already whole-document replace/persist, so restoring a snapshot is exactly
 * what a normal edit does. `restoreSnapshot()` is what the history entries'
 * `undo()`/`redo()` closures call: set state to the given `Timeline`,
 * cancelling any pending debounced save, then persist immediately (undo/redo
 * are discrete user actions — no reason to debounce them) and refetch to
 * reconcile — kept intentionally more conservative than `_flushSave` since
 * it's a rare, deliberate action, not a rapid edit stream.
 *
 * B-034/D-112 — **readiness is a real state machine now, and it has exactly
 * one input.** `projectOpen` is pushed in from the composition root
 * (`setProjectOpen`, the app's own source of truth); `status`
 * (`idle`/`loading`/`ready`/`error`) says only what the *fetch* is doing.
 * Nothing in this package infers "no project is open" from a failed fetch any
 * more — that conflation is what let five separate, genuinely different
 * faults (B-004, B-025, B-031, B-032, and this one) all surface as the same
 * false "No project open" screen, each time looking like a regression of the
 * last. Supporting guarantees, all of them things the previous shape lacked:
 * `load()` carries a monotonic token so a slow stale failure can never
 * overwrite a newer success; the fetch has a timeout so a dropped IPC
 * response can't strand the tab forever; and `setProjectOpen(true)` runs a
 * short bounded retry ladder (superseding D-085's unexplained 500ms one-shot)
 * that gives up into a real, honest error state rather than a lie.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { useHistoryStore } from '@chroma/history';

import { applyOp as applyOpPure, labelForOp, timelineDuration, type EditOp, type Timeline } from './timeline';

const SAVE_DEBOUNCE_MS = 400;

/** B-034/D-112 — a `chroma_timeline_get` that never settles must not be able
 *  to strand the Edit tab. Tauri's IPC drops a pending invoke's callback if
 *  the page reloads underneath it (its own console warning: "Couldn't find
 *  callback id N…"), leaving the promise permanently unresolved; without this
 *  ceiling `load()` would simply never finish and no later attempt could
 *  supersede it. Generous — a cold manifest read is milliseconds, so anything
 *  past this is a lost request, not a slow one. */
const LOAD_TIMEOUT_MS = 8000;

/** B-034/D-112 — bounded automatic recovery after `setProjectOpen(true)`.
 *  Replaces D-085's single 500ms one-shot retry (which, by its own admission,
 *  never proved the race it was guarding). Backoff is deliberately short and
 *  finite: a genuinely broken backend should end up on a real error screen
 *  with a Retry button, not in a silent forever-loop. */
const OPEN_RETRY_DELAYS_MS = [250, 750, 2000];

/** Mirrors `chroma::edit::TimelineSummary` (serde camelCase). */
export interface TimelineSummary {
  id: string;
  name: string;
  duration: number;
  active: boolean;
}

/** A selected clip, by track + id (D-107 multi-select — an array, not a
 *  singular selection). Lifted here (was `TimelinePane`-local `useState`)
 *  so `EditorInspectorPanel` — now a sibling of `TimelinePane`, not nested
 *  inside it, per the owner's "full height, not squeezed into the timeline"
 *  panel move — can read the same selection without prop-drilling through
 *  components that don't otherwise need it. */
export interface Selection {
  track: number;
  id: string;
}

/** A selected *gap* (D-105) — mutually exclusive with `Selection`, tracked
 *  as its own field for the same reason it was kept a separate `useState`
 *  in `TimelinePane` originally: a gap isn't a clip, folding it into
 *  `Selection` would force every clip-selection consumer to handle a
 *  clip-shaped-or-not union for no real benefit. */
export interface SelectedGap {
  track: number;
  frame: number;
}

/** B-034/D-112 — the Edit tab's real load state, as an explicit machine.
 *  Previously this was inferred from a `loaded: boolean` + `timeline: null`
 *  pair, which cannot tell "no project is open" apart from "a project is open
 *  and its timeline failed to load" — the conflation that made five unrelated
 *  faults all render as the same false "No project open" screen. */
export type TimelineLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface EditorTimelineState {
  timeline: Timeline | null;
  /** The app-level "a project is genuinely open" signal, pushed down from the
   *  composition root (`app/src/main.tsx` → `setProjectOpen`). This store must
   *  never *infer* it from a failed fetch — see `TimelineLoadStatus`. The
   *  dependency direction stays app → tabs (D-039): `@chroma/editor` is told,
   *  it never reaches up into `useSessionStore` to ask. */
  projectOpen: boolean;
  /** Where the active timeline's fetch actually stands. */
  status: TimelineLoadStatus;
  /** The real backend error behind `status === 'error'`; null otherwise. */
  error: string | null;
  playhead: number;
  playing: boolean;
  /** every timeline in the open project, for the switcher (D-046 pass 3) */
  timelines: TimelineSummary[];
  /** the current clip selection (D-107 multi-select) — see `Selection`'s doc */
  selection: Selection[];
  /** the current gap selection (D-105), mutually exclusive with `selection` */
  selectedGap: SelectedGap | null;

  /** The one signal that starts and stops this store's work. Idempotent —
   *  the composition root's effect may re-run with an unchanged value. */
  setProjectOpen: (open: boolean) => void;
  load: () => Promise<void>;
  setPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  /** Accepts a value or a `useState`-style updater — `TimelinePane.tsx`'s
   *  own call sites (shift-click range extend, cmd-click toggle, etc., all
   *  predating this store lift) use the functional form to read the
   *  in-flight `prev` selection, so this stays a drop-in replacement for
   *  the `useState` setter it used to be rather than forcing every call
   *  site to be rewritten to close over the store's `get()` instead. */
  setSelection: (selection: Selection[] | ((prev: Selection[]) => Selection[])) => void;
  setSelectedGap: (gap: SelectedGap | null) => void;
  applyOp: (op: EditOp) => void;
  /** D-051 — restore a full `Timeline` snapshot (an undo/redo target),
   *  bypassing the debounced save so it lands immediately. */
  restoreSnapshot: (timeline: Timeline) => void;
  _flushSave: () => void;

  /** re-read the project's timeline list (id/name/duration/active per one) */
  loadList: () => Promise<void>;
  /** create a new empty timeline, make it active, and reload both the list
   *  and the (now-empty) active timeline */
  createTimeline: (name: string) => Promise<{ ok: boolean; error?: string }>;
  /** switch the active timeline by id, then reload both */
  setActiveTimeline: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** B-034/D-112 — monotonic request token. `load()` is called from several
 *  independent places (the tab's own mount, every OS window `focus`, the
 *  composition-root bridge, the retry ladder, timeline create/switch) and
 *  nothing ever serialised them, so two fetches could be in flight at once
 *  and the *slower* one won by writing last. A stale failure landing after a
 *  fresh success is exactly how a transient hiccup became a permanent "No
 *  project open". Only the newest token may write. */
let loadToken = 0;

/** B-034/D-112 — token identifying the current open-project "generation".
 *  Bumped by every `setProjectOpen` transition so a retry ladder queued for a
 *  previous project (or for a project since closed) cannot fire into a newer
 *  one. */
let openGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRetries(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** `invoke`, but rejecting rather than hanging forever if the IPC response is
 *  lost (see `LOAD_TIMEOUT_MS`). */
function invokeWithTimeout<T>(cmd: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${cmd} did not respond within ${timeoutMs}ms (lost IPC response)`)),
      timeoutMs,
    );
    invoke<T>(cmd).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export const useEditorTimelineStore = create<EditorTimelineState>((set, get) => ({
  timeline: null,
  projectOpen: false,
  status: 'idle',
  error: null,
  playhead: 0,
  playing: false,
  timelines: [],
  selection: [],
  selectedGap: null,

  setProjectOpen: (open) => {
    if (get().projectOpen === open) return;
    cancelRetries();
    const generation = ++openGeneration;
    loadToken += 1; // orphan any fetch still in flight from the old generation

    if (!open) {
      set({
        projectOpen: false,
        timeline: null,
        status: 'idle',
        error: null,
        playing: false,
        playhead: 0,
        timelines: [],
        selection: [],
        selectedGap: null,
      });
      return;
    }

    set({ projectOpen: true, status: 'loading', error: null });

    // Attempt, then re-attempt on a short bounded ladder while the fetch is
    // still failing. Every rung re-checks the generation, so closing the
    // project (or opening a different one) cancels the ladder cleanly.
    const attempt = (rung: number): void => {
      void get()
        .load()
        .then(() => {
          if (generation !== openGeneration) return;
          const s = get();
          if (s.status === 'ready') return;
          const delay = OPEN_RETRY_DELAYS_MS[rung];
          if (delay === undefined) return; // ladder exhausted — the error state stands
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (generation === openGeneration) attempt(rung + 1);
          }, delay);
        });
    };
    attempt(0);
  },

  load: async () => {
    const token = ++loadToken;
    // Don't flash the error screen away on a background refetch that may
    // itself fail; `status` only moves to 'loading' when there's nothing good
    // on screen to preserve.
    if (get().status !== 'ready') set({ status: 'loading' });
    try {
      const timeline = await invokeWithTimeout<Timeline>('chroma_timeline_get', LOAD_TIMEOUT_MS);
      if (token !== loadToken) return; // superseded — a newer load owns the state
      const dur = timelineDuration(timeline);
      set((s) => ({
        timeline,
        error: null,
        status: 'ready',
        playhead: Math.min(s.playhead, Math.max(0, dur - 1)),
      }));
    } catch (e) {
      if (token !== loadToken) return; // superseded — never clobber a newer result
      set({ timeline: null, error: String(e), status: 'error', playing: false });
    }
  },

  setPlayhead: (frame) => {
    const dur = timelineDuration(get().timeline);
    const max = Math.max(0, dur - 1);
    set({ playhead: Math.min(Math.max(Math.round(frame), 0), max) });
  },

  setPlaying: (playing) => set({ playing }),

  setSelection: (selection) =>
    set((s) => ({
      selection: typeof selection === 'function' ? selection(s.selection) : selection,
      selectedGap: null,
    })),

  setSelectedGap: (gap) => set({ selectedGap: gap, selection: gap ? [] : get().selection }),

  applyOp: (op) => {
    const before = get().timeline;
    if (!before) return;
    const after = applyOpPure(before, op);
    if (after === before) return; // no-op (clamped away)
    const dur = timelineDuration(after);
    set((s) => ({ timeline: after, playhead: Math.min(s.playhead, Math.max(0, dur - 1)) }));

    // Auto-decommission (owner, live) — `applyOpPure` may have just pruned
    // one or more emptied tracks for `remove`/cross-track `move` (see
    // `pruneIfEmptyTrack`'s own doc), which renumbers every later track.
    //
    // D-129 — this used to derive the ONE pruned index from the op itself
    // (`op.track` for `remove`, `op.fromTrack` for a cross-track `move`).
    // That stopped being sufficient the moment a `remove` could delete a
    // whole A/V link group: deleting a linked pair can empty — and so prune
    // — TWO tracks at once, at indices the op never names. Rather than
    // extend the index arithmetic to a list, selection is remapped by each
    // clip's own **stable id**, which is correct however many tracks were
    // pruned, without knowing what the op did: find where that clip lives
    // now, or drop it if it's gone. `selectedGap` has no id to follow, so
    // it's simply cleared — a gap selection is transient and trivially
    // re-made, and a silently-wrong track index is far worse than none.
    //
    // Gated on the track list SHRINKING, not merely changing: every
    // track-ADDING path appends (`add_track`, and D-129's
    // `ensureAudioTrackWithRoom` for a dropped clip's audio half), so a
    // growing list renumbers nothing and neither selection needs touching.
    if (after.tracks.length < before.tracks.length) {
      const locate = (id: string): number => after.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
      set((s) => ({
        selection: s.selection.map((sel) => ({ ...sel, track: locate(sel.id) })).filter((sel) => sel.track >= 0),
        selectedGap: null,
      }));
    }

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      get()._flushSave();
    }, SAVE_DEBOUNCE_MS);

    // D-051 — one shared-history entry per applied op, snapshot-based (see
    // module doc comment). `before`/`after` are already independent trees
    // (`applyOpPure` clones rather than mutating), so closing over them
    // directly is safe even though `timeline` keeps changing underneath.
    useHistoryStore.getState().push({
      tab: 'edit',
      label: labelForOp(op, before),
      undo: () => get().restoreSnapshot(before),
      redo: () => get().restoreSnapshot(after),
    });
  },

  restoreSnapshot: (timeline) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const dur = timelineDuration(timeline);
    set((s) => ({ timeline, playhead: Math.min(s.playhead, Math.max(0, dur - 1)) }));
    invoke('chroma_timeline_set', { timeline })
      .then(() => get().load())
      .catch((e) => set({ error: String(e) }));
  },

  // Perf finding, 2026-09-04: this used to `.then(() => get().load())` — a
  // full `chroma_timeline_get` refetch (IPC round-trip + manifest re-read/
  // re-parse) after every single debounced save. `chroma_timeline_set`'s own
  // contract is "stores whatever is sent verbatim, no server-side clamping"
  // (see its Rust doc comment), so there's nothing a refetch could learn
  // that isn't already sitting in `timeline` right here — the round-trip was
  // pure redundant latency on the most common hot path in this file, worse
  // under any real system load. `restoreSnapshot` (undo/redo, a rare,
  // deliberate action, not a rapid edit stream) keeps its own refetch as the
  // more conservative choice — the cost there is negligible either way.
  _flushSave: () => {
    const timeline = get().timeline;
    if (!timeline) return;
    invoke('chroma_timeline_set', { timeline }).catch((e) => set({ error: String(e) }));
  },

  loadList: async () => {
    try {
      const timelines = await invoke<TimelineSummary[]>('chroma_timeline_list');
      set({ timelines });
    } catch {
      // no project open — leave whatever list (likely empty) is already there
    }
  },

  createTimeline: async (name) => {
    try {
      await invoke<Timeline>('chroma_timeline_create', { name });
      await Promise.all([get().load(), get().loadList()]);
      set({ playhead: 0 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  setActiveTimeline: async (id) => {
    try {
      await invoke('chroma_timeline_set_active', { id });
      await Promise.all([get().load(), get().loadList()]);
      set({ playhead: 0 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));
