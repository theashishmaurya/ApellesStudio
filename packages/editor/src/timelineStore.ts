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
 * B-088 — **the optimistic timeline and the backend's timeline are two
 * different documents for the length of that debounce, and `savedVersion`
 * is the second one's clock.** Anything that re-runs a backend *read* of
 * this timeline (`chroma_timeline_frame`, above all — the live preview
 * renders the persisted manifest, never anything handed to it) must key off
 * `savedVersion`, not off `timeline`'s identity; see that field's own doc
 * for the full failure mode.
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
 * one input.** `openProjectKey` is pushed in from the composition root
 * (`setOpenProject`, the app's own source of truth); `status`
 * (`idle`/`loading`/`ready`/`error`) says only what the *fetch* is doing.
 * Nothing in this package infers "no project is open" from a failed fetch any
 * more — that conflation is what let five separate, genuinely different
 * faults (B-004, B-025, B-031, B-032, and this one) all surface as the same
 * false "No project open" screen, each time looking like a regression of the
 * last. Supporting guarantees, all of them things the previous shape lacked:
 * `load()` carries a monotonic token so a slow stale failure can never
 * overwrite a newer success; the fetch has a timeout so a dropped IPC
 * response can't strand the tab forever; and opening a project runs a
 * short bounded retry ladder (superseding D-085's unexplained 500ms one-shot)
 * that gives up into a real, honest error state rather than a lie.
 *
 * B-083/D-203 — **that one input carries the project's identity, not just a
 * boolean.** It used to be `setProjectOpen(open: boolean)`, which cannot tell
 * "no project → project A" apart from "project A → project B" — and the
 * `open_project`/`new_project` paths (GUI and MCP alike) switch projects
 * without ever closing the first. So this store never heard that the active
 * project had changed underneath it and kept serving — and letting the MCP
 * layer edit — project A's timeline for the rest of the session. A changed
 * key is now a real switch: everything here belongs to the outgoing project,
 * so it is all dropped and re-read.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { useHistoryStore } from '@chroma/history';

import {
  applyOp as applyOpPure,
  labelForOp,
  timelineDuration,
  type ClipKeyframeParam,
  type EditOp,
  type Timeline,
} from './timeline';
import { clampPreviewView, FIT_VIEW, type PreviewView } from './previewZoom';

const SAVE_DEBOUNCE_MS = 400;

/** B-034/D-112 — a `chroma_timeline_get` that never settles must not be able
 *  to strand the Edit tab. Tauri's IPC drops a pending invoke's callback if
 *  the page reloads underneath it (its own console warning: "Couldn't find
 *  callback id N…"), leaving the promise permanently unresolved; without this
 *  ceiling `load()` would simply never finish and no later attempt could
 *  supersede it. Generous — a cold manifest read is milliseconds, so anything
 *  past this is a lost request, not a slow one. */
const LOAD_TIMEOUT_MS = 8000;

/** B-034/D-112 — bounded automatic recovery after a project is opened.
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

/**
 * Which clip's animation the timeline curve editor is open on, and which of
 * its properties is being plotted (D-233).
 *
 * `track` + `id` addresses the clip the same way [`Selection`] does — by the
 * clip's own stable id, not its index, so an edit elsewhere on the track
 * (a ripple delete, an insert) does not silently repoint the editor at a
 * different clip. `param` is the property whose curve is drawn; a clip can
 * animate nine of them, and Resolve's own editor likewise shows one lane at a
 * time under the clip.
 *
 * UI state, deliberately — exactly like `selection` and `previewView`, and for
 * D-216's reasons: it is not part of `Timeline`, so it never reaches
 * `project.json`, and `cmd-Z` after opening a curve must undo the last real
 * EDIT rather than the act of looking at one.
 */
export interface CurveEditorTarget {
  track: number;
  id: string;
  param: ClipKeyframeParam;
}

/** B-034/D-112 — the Edit tab's real load state, as an explicit machine.
 *  Previously this was inferred from a `loaded: boolean` + `timeline: null`
 *  pair, which cannot tell "no project is open" apart from "a project is open
 *  and its timeline failed to load" — the conflation that made five unrelated
 *  faults all render as the same false "No project open" screen. */
export type TimelineLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface EditorTimelineState {
  timeline: Timeline | null;
  /** **Which** project is open — the composition root's own identity key for
   *  it (`app/src/store/useSessionStore.ts`'s `selectProjectKey`: the `.chroma`
   *  directory path, or an `untitled:` marker for an in-memory session) —
   *  and `null` when none is. Pushed down from the composition root
   *  (`app/src/Root.tsx` → `setOpenProject`). This store must never *infer* it
   *  from a failed fetch — see `TimelineLoadStatus`. The dependency direction
   *  stays app → tabs (D-039): `@chroma/editor` is told, it never reaches up
   *  into `useSessionStore` to ask.
   *
   *  B-083/D-203 — this was a bare `projectOpen: boolean` until 2026-09-07,
   *  which cannot tell "no project → project A" apart from "project A →
   *  project B". Both leave it `true`, and `open_project`/`new_project` switch
   *  projects without ever closing the first, so this store stayed on project
   *  A's timeline for the rest of the session with no error of any kind.
   *  Consumers wanting the plain boolean read `openProjectKey !== null`; it is
   *  deliberately NOT also kept as its own field, so the two cannot drift. */
  openProjectKey: string | null;
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
  /** D-233 — the timeline curve editor's target, or `null` when the lane is
   *  closed. See [`CurveEditorTarget`]. */
  curveEditor: CurveEditorTarget | null;
  /** D-218 — the preview pane's VIEWPORT zoom + pan (`previewZoom.ts`).
   *
   *  UI state, exactly like `selection` above and for exactly D-216's
   *  reasons: it is not part of `Timeline`, so it never reaches
   *  `project.json`, D-051's whole-`Timeline` undo snapshots have never
   *  carried it, and a `cmd-Z` after zooming must undo the user's last real
   *  EDIT, not their last look at the picture. It lives in the store rather
   *  than in `PreviewPane`'s own `useState` for the same reason `selection`
   *  was lifted here: more than one surface needs it (the pane, its three
   *  overlays, and `editor_set_preview_zoom` over MCP), and a module-level
   *  zustand store is reachable from the control bridge without any ref
   *  plumbing (`useEditorControl.ts`'s own module doc).
   *
   *  Nothing here is a clip's `scale`/`position_*` — see `previewZoom.ts`. */
  previewView: PreviewView;
  /** D-219 — whether the Edit tab's Inspector column is shown. Lifted out of
   *  `EditorTab.tsx`'s own `useState` for exactly the reason `selection`
   *  above was lifted out of `TimelinePane`'s: something other than that one
   *  component now needs to read and write it — the debug UI-state op
   *  `debug_set_editor_inspector`, which runs outside React and so has no way
   *  to reach a component's local state, and which must drive the SAME state
   *  the human's toggle button drives rather than simulate a click on it.
   *
   *  Deliberately NOT cleared by `setOpenProject`, unlike every other field
   *  here: it describes this session's chrome, not the open project. And
   *  deliberately not an `EditOp` (D-216's rule): it is store state, never
   *  part of `Timeline`, so it is neither persisted nor undoable. */
  inspectorOpen: boolean;
  /** D-232 — whether the viewer shows its audio waveform strip (`ScrubWaveform`,
   *  the "waveform toggle" half of roadmap item 27).
   *
   *  Here rather than in `PreviewPane`'s own `useState` for exactly the reason
   *  `inspectorOpen` above is: something outside that component has to read and
   *  write it — `editor_set_waveform_view` over MCP, which runs outside React
   *  and must drive the SAME state the human's toggle button drives rather than
   *  simulate a click on it (CLAUDE.md's "one op/store action under both
   *  interfaces").
   *
   *  Session chrome, not project data: deliberately NOT cleared by
   *  `setOpenProject`, not persisted, and not undoable (D-216's rule — it is
   *  store state, never part of `Timeline`). Defaults OFF: the strip costs real
   *  vertical space in the viewer, and a user who has not asked for it should
   *  get the picture. */
  waveformView: boolean;
  /** B-088 — a monotonic counter bumped **only** when the BACKEND's copy of
   *  the active timeline is known to have changed: a `chroma_timeline_set`
   *  that actually resolved, or a `chroma_timeline_get` that actually
   *  landed. Never bumped by the optimistic `set({ timeline })` in
   *  `applyOp`.
   *
   *  It exists because the two are genuinely different facts and one
   *  consumer needs the second one. Every backend renderer of this timeline
   *  — `chroma_timeline_frame` above all — reads the project's **persisted**
   *  manifest off disk, not anything passed in; but `applyOp` persists on a
   *  {@link SAVE_DEBOUNCE_MS} debounce, so for ~400 ms after every edit the
   *  in-memory `timeline` and the timeline those commands render are two
   *  different documents. A consumer that re-invokes such a command on
   *  `timeline`'s identity therefore asks for a frame of a state the backend
   *  does not have yet, gets the pre-edit picture, and — since nothing
   *  changes identity again once the save finally lands — keeps showing it
   *  forever. That was B-088. Depend on this instead of on `timeline`
   *  whenever the thing being re-run is a backend read of the timeline. */
  savedVersion: number;

  /** The one signal that starts and stops this store's work: the key of the
   *  project that is open now, or `null` for none. Idempotent *per key* — the
   *  composition root's effect may re-run with an unchanged value — but a
   *  DIFFERENT key is a real project switch and reloads everything (B-083). */
  setOpenProject: (key: string | null) => void;
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
  /** D-233 — open the curve editor on one clip property, or close it with
   *  `null`. The one writer for the timeline's own curve button, the
   *  Inspector's per-property one, and `editor_set_curve_editor` over MCP —
   *  the same human-and-agent pairing CLAUDE.md requires of every feature. */
  setCurveEditor: (target: CurveEditorTarget | null) => void;
  /** D-218 — set the preview viewport's zoom/pan. Always clamped through
   *  `clampPreviewView`, so no caller (the toolbar buttons, the wheel
   *  gesture, or `editor_set_preview_zoom` over MCP) can leave the picture
   *  out of range or panned off into nothing. Accepts a `useState`-style
   *  updater as well as a value, matching `setSelection` above — the wheel
   *  and button handlers each derive the next view from the current one. */
  setPreviewView: (view: PreviewView | ((prev: PreviewView) => PreviewView)) => void;
  /** D-219 — show/hide the Inspector column. The one writer for both the
   *  human's toggle button (`EditorTab.tsx`) and the debug op. */
  setInspectorOpen: (open: boolean) => void;
  /** D-232 — show/hide the viewer's waveform strip. The one writer for both the
   *  human's toggle button (`Player`, via `PreviewPane`) and
   *  `editor_set_waveform_view`. */
  setWaveformView: (open: boolean) => void;
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
 *  Bumped by every `setOpenProject` transition so a retry ladder queued for a
 *  previous project (or for a project since closed) cannot fire into a newer
 *  one — including, since B-083/D-203, a switch straight from one open project
 *  to another. */
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
  openProjectKey: null,
  status: 'idle',
  error: null,
  playhead: 0,
  playing: false,
  timelines: [],
  selection: [],
  selectedGap: null,
  curveEditor: null,
  previewView: FIT_VIEW,
  // D-118 shipped the Inspector open; keep that default now the flag lives here.
  inspectorOpen: true,
  // D-232 — off by default; see the field's own doc.
  waveformView: false,
  savedVersion: 0,

  setOpenProject: (key) => {
    if (get().openProjectKey === key) return;
    cancelRetries();
    const generation = ++openGeneration;
    loadToken += 1; // orphan any fetch still in flight from the old generation

    // B-083 — every other field in this store describes the *outgoing*
    // project (its timeline, its timeline list, its selection, a playhead
    // measured against its own duration), so a switch drops all of it rather
    // than leaving project A's state on screen under project B's name. That
    // includes the pending debounced save: `_flushSave` reads `timeline` at
    // FIRE time, and the backend already points at the incoming project by
    // the time we hear about the switch, so letting it fire would write A's
    // timeline into B. Cancelling it means an edit made in the last
    // `SAVE_DEBOUNCE_MS` before a project switch is dropped — the same race
    // B-080 already tracks for a *timeline* switch; dropping it is the safe
    // half of that trade, and closing it properly (flush before the switch
    // proceeds) is B-080's own scoped fix, not this one's.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      openProjectKey: key,
      timeline: null,
      status: key === null ? 'idle' : 'loading',
      error: null,
      playing: false,
      playhead: 0,
      timelines: [],
      selection: [],
      selectedGap: null,
      // D-218 — a project switch resets the preview view, for the same reason
      // it resets the playhead just above: the zoom/pan the user left behind
      // was a look at a DIFFERENT composition (possibly a different aspect
      // ratio entirely), so carrying it over would open the new project
      // already magnified into a corner of a frame nobody has seen yet. It
      // deliberately does NOT reset on a selection change or a timeline
      // switch within one project — a viewer zoom is a persistent viewing
      // preference in every reference NLE, and losing it on every clip click
      // would make it useless for the inspection it exists for.
      previewView: FIT_VIEW,
    });

    if (key === null) return;

    // Attempt, then re-attempt on a short bounded ladder while the fetch is
    // still failing. Every rung re-checks the generation, so closing the
    // project (or opening a different one) cancels the ladder cleanly.
    const attempt = (rung: number): void => {
      void get()
        .load()
        .then(() => {
          if (generation !== openGeneration) return;
          const s = get();
          if (s.status === 'ready') {
            // B-083 — the switcher's tab strip is per-project too, and
            // `TimelineSwitcher` only fetches it once on its own mount (it
            // stays mounted across a project switch, B-007), so the list has
            // to be re-read from here or it stays empty after a switch.
            void get().loadList();
            return;
          }
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
        // B-088 — this timeline came FROM the backend, so the backend
        // demonstrably holds it: a real `savedVersion` change. Covers the
        // window-`focus` refetch, the timeline switcher, and
        // `restoreSnapshot`'s own trailing reconcile (which is why undo/redo
        // needs no bump of its own).
        savedVersion: s.savedVersion + 1,
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
  setCurveEditor: (target) => set({ curveEditor: target }),

  setPreviewView: (view) =>
    set((s) => ({
      previewView: clampPreviewView(typeof view === 'function' ? view(s.previewView) : view),
    })),

  setInspectorOpen: (open) => set({ inspectorOpen: open }),

  setWaveformView: (open) => set({ waveformView: open }),

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
        // D-233 — the curve editor follows its clip by id through a prune,
        // exactly as `selection` does above, and closes if that clip is gone.
        // Leaving a stale `track` here would point the lane at a different
        // clip's animation while still letting the user drag its handles.
        curveEditor: s.curveEditor
          ? locate(s.curveEditor.id) >= 0
            ? { ...s.curveEditor, track: locate(s.curveEditor.id) }
            : null
          : null,
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
  //
  // B-088 — the save's *resolution* is a real event with a real consumer now
  // (see `savedVersion`'s own doc): it is the moment the backend starts
  // rendering this edit rather than the one before it. Bumping on `.then`
  // rather than optimistically alongside the `set` above is the whole point
  // — an optimistic bump would reintroduce exactly the race it closes.
  _flushSave: () => {
    const timeline = get().timeline;
    if (!timeline) return;
    invoke('chroma_timeline_set', { timeline })
      .then(() => set((s) => ({ savedVersion: s.savedVersion + 1 })))
      .catch((e) => set({ error: String(e) }));
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
