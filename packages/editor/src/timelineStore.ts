/**
 * @apelles/editor — the Edit-tab timeline store (D-041, timeline switcher D-046
 * pass 3, undo/redo D-051).
 *
 * Kept in `@apelles/editor` for now; a `@apelles/bridge` extraction (shared
 * stores + typed Tauri bindings) is a separate later task (D-039 step 6).
 *
 * State: the `apelles-timeline` model for the **active** timeline, the
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
 * D-411 Phase 0 added `renameTimeline()`/`setTimelineOutput()`/
 * `duplicateTimeline()`/`deleteTimeline()`, the one set of actions both the
 * switcher's menus and the `editor_*_timeline*` MCP ops call. The OPEN
 * timeline is renamed/resized through `applyOp` (this store is its one writer,
 * so the change is undoable and journalled); any other through a by-id
 * command. B-283: an undo/redo snapshot of another timeline switches to that
 * timeline before it is restored.
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
 * before/after snapshot pair onto `@apelles/history`'s shared undo stack —
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
 * B-080 — **a pending debounced save is state this store OWES the backend, and
 * every action that changes where that save would land has to settle it
 * first.** `chroma_timeline_set` writes onto whichever timeline is ACTIVE when
 * it arrives — it does not carry, or match on, the id of the timeline it was
 * built from. So a save still sitting on the {@link SAVE_DEBOUNCE_MS} timer
 * when the active timeline (or the open project) changes is not merely late:
 * it is addressed to a document that is no longer there, and `load()` has
 * already overwritten the only in-memory copy of the edit it carried. The edit
 * was silently gone, from disk and from memory both. `flushPendingSave()` is
 * the fix and the rule — `createTimeline`/`setActiveTimeline` await it before
 * issuing their own command, and the project axis awaits it one layer up, in
 * `app/src/store/useSessionStore.ts`'s open/new/close (this store only hears
 * about a project switch after the backend has already made it, so it can only
 * cancel — see `setOpenProject`).
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
// D-358/B-217 — this store is a process-wide singleton and must survive a Vite
// dev-mode module re-evaluation as ONE instance; `createSharedStore` is plain
// `create()` in production and under vitest. It also announces which project it
// is holding, so an MCP op is refused rather than run against the wrong one if
// this store and `useSessionStore` ever diverge. See `packages/store/README.md`.
import { createSharedStore, registerProjectIdentityParticipant } from '@apelles/store';
import { useHistoryStore } from '@apelles/history';

import {
  applyOp as applyOpPure,
  labelForOp,
  timelineDuration,
  checkTimelineOutput,
  type ClipKeyframeParam,
  type EditOp,
  type EaseCurve,
  type OutputSpec,
  type Timeline,
  type TimelineOrigin,
} from './timeline';
import { clampPreviewView, FIT_VIEW, type PreviewView } from './previewZoom';
// D-280 — the transport's playback-rate model lives with the transport
// component (`@apelles/player`), which renders the control; this store only
// holds the value and clamps it. See that module's own doc.
import { clampPlaybackRate, DEFAULT_PLAYBACK_RATE } from '@apelles/player';
import { DEFAULT_CLIP_INSPECTOR_TAB, type ClipInspectorTab } from './clipInspectorTabs';
import { DEFAULT_EDIT_LIBRARY_MODE, type EditLibraryMode } from './editLibrary';
import { isJournalEntry, replayJournal, type EditJournalEntry, type EditJournalState } from './editJournal';

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
  /** D-411 Phase 0 — the timeline's own output size; `null`/absent = the
   *  project's. */
  output?: OutputSpec | null;
  /** D-411 Phase 0 — build provenance; `null`/absent for a hand-made timeline. */
  origin?: TimelineOrigin | null;
}

/** What every timeline-management action resolves to: never a rejection (the
 *  switcher and the MCP ops both report `error` in words), plus the timeline a
 *  create or duplicate produced. */
export interface TimelineActionResult {
  ok: boolean;
  error?: string;
  timeline?: Timeline;
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
   *  stays app → tabs (D-039): `@apelles/editor` is told, it never reaches up
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
  /** D-246 — which of the clip Inspector's tabs (Video / Audio) is showing.
   *
   *  In the store rather than in `ClipInspectorPanel`'s own `useState` for
   *  two independent reasons, either of which would be enough. First, the
   *  same one `inspectorOpen` above has: `debug_set_inspector_tab` drives it
   *  from outside React and must drive the SAME state the human's own click
   *  drives rather than simulate a click. Second, that panel is deliberately
   *  remounted on every clip selection (`key={clip.id}` in
   *  `EditorInspectorPanel.tsx`, D-193), so component-local state here would
   *  reset the tab on every selection change — the panel would silently jump
   *  back to Video every time the user picked a different clip while working
   *  through a mix.
   *
   *  Session chrome, not project data: never persisted, never undoable
   *  (D-216's rule), and not cleared by `setOpenProject`. A tab this clip has
   *  no content for is resolved away at render time by
   *  `resolveClipInspectorTab` WITHOUT writing here, so the user's own choice
   *  survives selecting a title (which has no Audio tab) and comes back when
   *  they select a clip that does. */
  inspectorTab: ClipInspectorTab;
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
  /** D-266 — the viewer's MASTER MONITORING volume (`0..1`) and mute flag: the
   *  `volume` multiplier `chroma_audio_set_volume` applies in the real `cpal`
   *  output callback, and whether the transport's speaker button is currently
   *  muting it. `volume` is the last non-zero level, remembered across a mute
   *  toggle so unmuting restores it rather than resetting to unity.
   *
   *  **Monitoring, not project data** (D-126's original framing, unchanged by
   *  the lift): it is entirely separate from any track's `gain` or any clip's
   *  `volume`, changes nothing about what an export renders, and is not part of
   *  `Timeline`. Session chrome under D-216's rule — never persisted, never
   *  undoable, and not cleared by `setOpenProject`.
   *
   *  Here rather than in `PreviewPane`'s own `useState` (where D-126 put it)
   *  for precisely the reason `waveformView` above is: something outside that
   *  component now has to read and write it — `editor_set_audio_monitor` over
   *  MCP, which runs outside React and must drive the SAME state the human's
   *  speaker button and volume slider drive, rather than simulate a click on
   *  them (CLAUDE.md's "one op/store action under both interfaces"). */
  monitorVolume: number;
  monitorMuted: boolean;
  /** D-280 — the preview's PLAYBACK RATE: how many timeline seconds the
   *  transport plays per real second. `1` is ordinary playback; `3` reviews the
   *  cut three times as fast, with pitch-preserved audio (see
   *  `apelles_media::timestretch`).
   *
   *  **Transport state, not project data — and this is the field's whole
   *  point.** It is emphatically NOT a clip's Speed/Retime property (D-236):
   *  that one lives on the `Clip`, is persisted, is undoable, changes the
   *  clip's real duration on the timeline, and is baked into every export. This
   *  changes how fast you WATCH, and nothing else — an export while the preview
   *  is at 4x renders exactly what an export at 1x renders. Session chrome
   *  under D-216's rule, like `waveformView` and `monitorVolume` above: never
   *  persisted, never undoable, never part of `Timeline`.
   *
   *  Clamped to `playbackRate.ts`'s bounds by `setPlaybackRate`, so no surface
   *  can leave an impossible value here for the rAF loop or the audio session
   *  to find.
   *
   *  In the store rather than in `PreviewPane`'s own `useState` for the reason
   *  `waveformView` and `monitorVolume` are: `editor_set_playback_rate` runs
   *  outside React and must drive the SAME state the human's transport control
   *  drives, not a parallel copy (CLAUDE.md's "one op/store action under both
   *  interfaces"). */
  playbackRate: number;
  /** D-234 — which clip's DYNAMIC ZOOM boxes the viewer is showing, and the
   *  ease the next bake will use. `null` (the default) = the ordinary
   *  single-box transform overlay.
   *
   *  UI state, for the same D-216 reasons `previewView` and `waveformView`
   *  above are: it is an authoring MODE, not part of `Timeline`, so it is
   *  never persisted and never undoable — the KEYFRAMES a dynamic zoom bakes
   *  are the persisted, undoable artifact, and arming or disarming the mode
   *  writes nothing at all. In the store rather than in the Inspector's own
   *  `useState` because two surfaces need it (the Inspector section that arms
   *  it, and `PreviewPane`'s overlay that draws it), which is exactly the
   *  "lift it" case `selection` set the precedent for.
   *
   *  `clipId`, not a track/index pair: an index moves under a clip when
   *  anything is inserted before it, and the mode must follow the CLIP. The
   *  overlay resolves it against the current selection and simply draws
   *  nothing when they disagree.
   *
   *  `curve` is authoring-only and is deliberately NOT recoverable from a
   *  clip: the baked keys ARE the curve (see `dynamicZoom.ts`'s module doc),
   *  so re-arming the mode always starts at `linear`. */
  dynamicZoom: { clipId: string; curve: EaseCurve } | null;
  /** D-252 — which popovers/dialogs from `panelRegistry.ts`'s `PANEL_IDS` are
   *  currently open, keyed by panel id. A panel with no entry reads as closed
   *  via `usePanelOpen`'s `?? false`, so this map only ever needs writing,
   *  never pre-seeding.
   *
   *  Generalises `inspectorOpen` (D-219) to any number of popovers instead of
   *  one bespoke boolean field per popover: `usePanelOpen(id)` is the one
   *  writer for both a human's click on that popover's own trigger and the
   *  debug op `debug_set_popover_open`, exactly the "same store action under
   *  both interfaces" pairing `inspectorOpen`/`debug_set_editor_inspector`
   *  already established — see `panelRegistry.ts`'s module doc for why a map
   *  rather than one field per popover.
   *
   *  Session chrome, not project data: never persisted, never undoable
   *  (D-216's rule) and, like `inspectorOpen`/`waveformView`, deliberately NOT
   *  cleared by `setOpenProject` — closing a popover on a project switch would
   *  be a surprise mid-edit, and none of today's registered panels hold data
   *  that belongs to one project over another. */
  openPanels: Record<string, boolean>;
  /** D-263 — which library the Edit tab's docked left-hand column is showing:
   *  the shared media pool (`sources`), or one of this tab's own libraries
   *  (`titles` / `effects` / `subtitles`). The rail (`EditLibraryRail.tsx`)
   *  writes it, the docked panel (`EditLibraryPanel.tsx`) renders off it, and
   *  the composition root reads it to decide whether the Edit tab is taking
   *  the shell's docked column over at all (`Root.tsx` → `Shell`'s
   *  `libraryPanel`).
   *
   *  In the store rather than in the rail's own `useState` for the reason
   *  `inspectorOpen` above is: more than one component needs it — the rail
   *  that sets it, the panel that renders it, and `Root` — and it is also what
   *  `debug_get_ui_state` reports so an agent looking at a screenshot can tell
   *  which library is actually on screen.
   *
   *  Session chrome, not project data: never persisted, never undoable
   *  (D-216's rule), and deliberately NOT cleared by `setOpenProject` — same
   *  treatment `inspectorOpen`/`inspectorTab`/`openPanels` get, for the same
   *  reason (which library is open belongs to this session, not to a project).
   *
   *  Whether that column is SHOWN at all is separate and shell-level
   *  (`useShellStore.sourcesPanelOpen`) — this package must not depend on
   *  `@apelles/shell`, so the rail takes that flag and its setter as props. */
  libraryMode: EditLibraryMode;
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
  /** B-274/D-402 — how many journalled edits the last first-load of this
   *  project replayed on top of `project.json` (edits a previous page made but
   *  did not get to save, typically because macOS terminated its web content
   *  process). `0` when there was nothing to replay. The composition root tells
   *  the user when it is non-zero. */
  recoveredEdits: number;

  /** The one signal that starts and stops this store's work: the key of the
   *  project that is open now, or `null` for none. Idempotent *per key* — the
   *  composition root's effect may re-run with an unchanged value — but a
   *  DIFFERENT key is a real project switch and reloads everything (B-083). */
  setOpenProject: (key: string | null) => void;
  /** Fetch the backend's copy of the active timeline into the store.
   *
   *  **B-272 — it never replaces a newer local edit with an older backend copy.**
   *  `applyOp` changes the store at once and persists ~{@link SAVE_DEBOUNCE_MS}
   *  later, so for that window (and while a save is in flight) the backend is
   *  BEHIND the store. A window-`focus` refetch landing then used to overwrite
   *  the store with the older copy and the debounced save then persisted it:
   *  62 `editor_set_clip_audio` calls read back at 0.15, minutes later 39 were
   *  at 0.35 again, with nothing on the undo stack. A fetched copy is therefore
   *  DISCARDED when the store owed the backend a write at any point between the
   *  request and its answer. `afterOwnSave` is for the one caller that has just
   *  finished its own save (`restoreSnapshot`'s reconcile): the save in flight
   *  is that very one, so only a NEWER edit makes the answer stale. */
  load: (opts?: { afterOwnSave?: boolean }) => Promise<void>;
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
  /** D-246 — switch the clip Inspector's Video/Audio tab. The one writer for
   *  both the human's tab click (`ClipInspectorPanel`) and the debug op. */
  setInspectorTab: (tab: ClipInspectorTab) => void;
  /** D-232 — show/hide the viewer's waveform strip. The one writer for both the
   *  human's toggle button (`Player`, via `PreviewPane`) and
   *  `editor_set_waveform_view`. */
  setWaveformView: (open: boolean) => void;
  /** D-266 — set the monitoring volume and/or the mute flag. Either half may
   *  be omitted to leave it alone, so the speaker button and the slider each
   *  write only what they own. A `volume` outside `0..1` is CLAMPED rather
   *  than rejected, matching `chroma_audio_set_volume`'s own contract, and a
   *  volume of exactly 0 is stored as 0 without implying `muted` — the two are
   *  independent facts (a muted transport still remembers where the slider
   *  was). */
  setAudioMonitor: (next: { volume?: number; muted?: boolean }) => void;
  /** D-280 — set the preview playback rate. The one writer for both the human's
   *  transport control (`Player`, via `PreviewPane`) and
   *  `editor_set_playback_rate`. Clamps rather than rejects, matching
   *  `setAudioMonitor`'s own contract and the Rust command's; nonsense reads as
   *  ordinary playback. Writes nothing to the project. */
  setPlaybackRate: (rate: number) => void;
  /** D-234 — arm/disarm the viewer's dynamic-zoom boxes, or change the ease
   *  the next bake uses. The one writer for both the human's Inspector toggle
   *  and `editor_set_dynamic_zoom`'s own arming. Writes no keyframes: a bake
   *  is always an explicit `applyOp` by whoever committed a box. */
  setDynamicZoom: (mode: { clipId: string; curve: EaseCurve } | null) => void;
  /** D-252 — open/close one registered popover/dialog by id. The one writer
   *  for both that popover's own trigger and `debug_set_popover_open`. */
  setPanelOpen: (id: string, open: boolean) => void;
  /** D-263 — switch which library the docked left column shows. The one
   *  writer for both the human's rail button (`EditLibraryRail.tsx`) and any
   *  future op that needs to drive it. */
  setLibraryMode: (mode: EditLibraryMode) => void;
  applyOp: (op: EditOp) => void;
  /** D-051 — restore a full `Timeline` snapshot (an undo/redo target),
   *  bypassing the debounced save so it lands immediately. */
  restoreSnapshot: (timeline: Timeline) => void;
  /** Persist `timeline` now. Resolves `true` once `chroma_timeline_set` has
   *  actually returned, `false` if it rejected (with the reason already in
   *  `error`) — the *resolution* is what {@link flushPendingSave} needs, so
   *  this is awaitable rather than fire-and-forget. */
  _flushSave: () => Promise<boolean>;
  /** B-080 — settle every save this store still owes the backend, and resolve
   *  only once the last one has actually landed.
   *
   *  Cancels the {@link SAVE_DEBOUNCE_MS} timer and runs its save immediately,
   *  then waits out any `chroma_timeline_set` already in flight. Resolves
   *  `true` when the backend demonstrably holds the current `timeline`,
   *  `false` if a save failed (the reason is in `error`, and the edit is still
   *  in memory to retry).
   *
   *  **Call this before ANY action that changes which timeline or project
   *  `chroma_timeline_set` would write into** — that command writes onto
   *  whichever timeline is ACTIVE at the moment it arrives, so a save left
   *  pending across a switch is not merely late, it is addressed to the wrong
   *  document and gets dropped. See `createTimeline`/`setActiveTimeline`
   *  below, and `useSessionStore`'s project open/new/close for the other
   *  axis. A no-op (resolving `true`) when nothing is pending, so calling it
   *  defensively costs nothing. */
  flushPendingSave: () => Promise<boolean>;

  /** re-read the project's timeline list (id/name/duration/active per one) */
  loadList: () => Promise<void>;
  /** create a new empty timeline and reload the list. Active by default (and
   *  then the now-empty active timeline is reloaded too); D-411 Phase 0 adds
   *  its own output size and `activate: false`, so an agent can create
   *  several shorts without the view jumping each time. */
  createTimeline: (
    name: string,
    opts?: { output?: OutputSpec | null; activate?: boolean },
  ) => Promise<TimelineActionResult>;
  /** switch the active timeline by id, then reload both */
  setActiveTimeline: (id: string) => Promise<TimelineActionResult>;
  /** D-411 Phase 0 — rename any timeline. The ACTIVE one goes through the
   *  `set_timeline_name` op (this store is its one writer, so a backend write
   *  would be overwritten by the next save; as an op it is also undoable);
   *  any other through `chroma_timeline_rename`. */
  renameTimeline: (id: string, name: string) => Promise<TimelineActionResult>;
  /** D-411 Phase 0 — set (`output`) or clear (`null`) any timeline's own
   *  output size; routed exactly like `renameTimeline`. */
  setTimelineOutput: (id: string, output: OutputSpec | null) => Promise<TimelineActionResult>;
  /** D-411 Phase 0 — duplicate any timeline (an independent copy, grades
   *  copied; see `apelles_project::timeline::duplicate_timeline`). Flushes
   *  first when `id` is the active timeline, so the copy holds the edit on
   *  screen. Not activated unless asked. */
  duplicateTimeline: (id: string, opts?: { name?: string; activate?: boolean }) => Promise<TimelineActionResult>;
  /** D-411 Phase 0 — delete any timeline but the last. Not undoable (a
   *  project-level action); the GUI confirms first. Deleting the active one
   *  flushes it, then reloads whichever neighbour the backend activated. */
  deleteTimeline: (id: string) => Promise<TimelineActionResult>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** B-272 — counts every local write to the active timeline (`applyOp`,
 *  `restoreSnapshot`). `load()` compares it across its fetch: if it moved, the
 *  answer was computed before an edit the store now holds and is stale. */
let localEditGeneration = 0;

/** B-274/D-402 — the write-ahead journal's numbering for the open project
 *  (`editJournal.ts`). `journalSeq` is the last number this page handed out;
 *  `journalOn` is whether this page may journal at all, which it only may once
 *  its first load has read the journal and continued the numbering from the
 *  highest number on disk (two pages must never hand out the same number). A
 *  backend that cannot answer the read leaves it off, and the store saves
 *  exactly as it did before the journal existed. */
let journalSeq = 0;
let journalOn = false;

/** Append one entry. Fire-and-forget by design: the point is that the message
 *  leaves this page NOW. A failed append is logged and costs only the crash
 *  protection of that edit; the debounced save still carries it. */
function appendJournal(entry: EditJournalEntry): void {
  invoke('chroma_edit_journal_append', { entry }).catch((e: unknown) => {
    console.error(`[edit-journal] append #${entry.seq} failed: ${String(e)}`);
  });
}

/** The `chroma_timeline_set` arguments for `timeline`: with the journal on, the
 *  sequence it includes (every number handed out so far, since `applyOp` and
 *  the journal advance together synchronously). */
function saveArgs(timeline: Timeline): { timeline: Timeline; journalSeq?: number } {
  return journalOn ? { timeline, journalSeq } : { timeline };
}

/** Read the open project's journal for a first load. `null` when the backend
 *  cannot answer in the expected shape (journal stays off). */
async function readJournal(): Promise<EditJournalState | null> {
  try {
    const raw = await invoke<unknown>('chroma_edit_journal_read');
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as { savedSeq?: unknown; entries?: unknown };
    if (!Array.isArray(r.entries)) return null;
    const savedSeq = typeof r.savedSeq === 'number' && Number.isInteger(r.savedSeq) ? r.savedSeq : null;
    return { savedSeq, entries: r.entries.filter(isJournalEntry) };
  } catch (e) {
    console.error(`[edit-journal] read failed, journal off for this project: ${String(e)}`);
    return null;
  }
}

/** B-080 — the `chroma_timeline_set` currently in flight, or `null`.
 *
 *  A cleared {@link saveTimer} is NOT the same fact as "the backend holds this
 *  edit": between the timer firing and the invoke resolving there is a real
 *  window in which the save is neither pending-as-a-timer nor done. A switch
 *  that only cancelled the timer would race straight through that window, and
 *  `chroma_timeline_set` writes onto whichever timeline is ACTIVE when it
 *  arrives — so the in-flight save must be waited out too, not just the
 *  scheduled one. Self-clearing: every flush replaces this with its own
 *  promise and drops it again on settle (identity-checked, so a later flush's
 *  promise is never cleared by an earlier one finishing). */
let inFlightSave: Promise<boolean> | null = null;

/** B-080 — register one `chroma_timeline_set` round trip as {@link
 *  inFlightSave} for as long as it is unresolved, so {@link
 *  EditorTimelineState.flushPendingSave} can wait it out. Used by BOTH write
 *  paths (`_flushSave` and `restoreSnapshot`) — an undo's immediate save is
 *  addressed to the active timeline exactly like a debounced one is, so a
 *  switch racing it has the identical failure mode. */
function trackSave(p: Promise<boolean>): Promise<boolean> {
  const tracked = p.finally(() => {
    if (inFlightSave === tracked) inFlightSave = null;
  });
  inFlightSave = tracked;
  return tracked;
}

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

/** B-080 — why a timeline switch REFUSES rather than proceeds when the flush
 *  it forced could not be persisted.
 *
 *  The edit is still in `timeline` at that point, so declining the switch is
 *  the only outcome that keeps it reachable: `setActiveTimeline`'s own `load()`
 *  overwrites `timeline` with the incoming timeline's content, and once that
 *  has happened the unsaved edit exists nowhere — not on disk, not in memory.
 *  That is exactly the silent loss this bug was, just with a failed backend
 *  instead of a pending timer as the cause. A refusal is visible, and the user
 *  can retry the switch once whatever broke the save is fixed. */
function unflushedError(error: string | null): string {
  return `could not save the current timeline first, so the switch was cancelled to avoid losing that edit: ${
    error ?? 'chroma_timeline_set failed'
  }`;
}

export const useEditorTimelineStore = createSharedStore<EditorTimelineState>('edit.timeline', (set, get) => ({
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
  // D-246 — Video: the tab every clip type has, and where the geometry a
  // user reaches for first lives. Sticky from there; see the field's doc.
  inspectorTab: DEFAULT_CLIP_INSPECTOR_TAB,
  // D-232 — off by default; see the field's own doc.
  waveformView: false,
  // D-126/D-266 — unity and unmuted: monitoring starts at "what the mix says".
  monitorVolume: 1,
  monitorMuted: false,
  // D-280 — ordinary playback. Deliberately NOT sticky across a project switch
  // in `setOpenProject` either: unlike a viewer zoom, a shuttle rate is
  // something you set to skim a specific take and would be startled to find
  // still running on the next project you open. See `setOpenProject`.
  playbackRate: DEFAULT_PLAYBACK_RATE,
  // D-234 — disarmed by default; the viewer shows the ordinary transform box.
  dynamicZoom: null,
  // D-252 — nothing open by default; see the field's own doc.
  openPanels: {},
  // D-263 — the shared media pool, which is what this column showed before
  // the rail could switch it at all (D-046) and what an edit starts from.
  libraryMode: DEFAULT_EDIT_LIBRARY_MODE,
  savedVersion: 0,
  recoveredEdits: 0,

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
    // timeline into B. Cancelling it is therefore still the right thing to do
    // HERE — but it is no longer the whole answer.
    //
    // B-080 — the flush that keeps the edit now happens one layer up, at the
    // only place that still runs while the OUTGOING project is the active one:
    // `useSessionStore`'s `openProject`/`newProject`/`saveUntitledAs`/
    // `closeProject` each `await useEditorTimelineStore.getState()
    // .flushPendingSave()` before invoking the Rust command that switches. By
    // the time this setter is called the switch has already happened, so a
    // flush from here would write into the wrong project — the cancel below is
    // the correct behaviour at this point, not a compromise. It is the second
    // line of defence: if some future caller switches projects without
    // flushing first, that edit is dropped rather than misfiled.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // B-274/D-402 — the journal's numbering belongs to the outgoing project;
    // the incoming one's first load reads its own and turns journalling on.
    journalOn = false;
    journalSeq = 0;
    set({
      openProjectKey: key,
      recoveredEdits: 0,
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
      // D-234 — the armed clip belongs to the outgoing project, so the mode
      // goes with it rather than leaving two boxes over a picture that has
      // nothing to do with them.
      dynamicZoom: null,
      // D-280 — a shuttle rate is set to skim ONE take, not as a viewing
      // preference (which is the argument `previewView` above makes for
      // itself). Opening a different project already playing at 4x, with no
      // memory of having asked for it, is the surprise this avoids.
      playbackRate: DEFAULT_PLAYBACK_RATE,
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

  load: async (opts) => {
    const token = ++loadToken;
    // B-272 — what this fetch can safely replace. A save pending on its timer or
    // in flight means the backend is behind the store right now.
    const generationAtStart = localEditGeneration;
    // B-274/D-402 — the first load of a project in this page is the one that
    // reads the journal: it replays what the previous page did not save and
    // continues the numbering.
    const firstLoad = get().timeline === null;
    const owedAtStart = saveTimer !== null || (inFlightSave !== null && opts?.afterOwnSave !== true);
    // Don't flash the error screen away on a background refetch that may
    // itself fail; `status` only moves to 'loading' when there's nothing good
    // on screen to preserve.
    if (get().status !== 'ready') set({ status: 'loading' });
    try {
      const timeline = await invokeWithTimeout<Timeline>('chroma_timeline_get', LOAD_TIMEOUT_MS);
      if (token !== loadToken) return; // superseded — a newer load owns the state
      // B-272 — the store holds an edit this answer predates: keep the store.
      // Its own pending save brings the backend level (and bumps
      // `savedVersion` when it lands).
      // (With no timeline in the store there is nothing to preserve, so a first
      // load always lands.)
      if (
        get().timeline !== null &&
        (owedAtStart || generationAtStart !== localEditGeneration || saveTimer !== null)
      ) {
        return;
      }
      let landed = timeline;
      let recovered = 0;
      if (firstLoad && !journalOn) {
        const journal = await readJournal();
        if (token !== loadToken) return;
        if (journal) {
          const out = replayJournal(timeline, journal);
          journalSeq = out.lastSeq;
          journalOn = true;
          if (out.applied > 0) {
            landed = out.timeline;
            recovered = out.applied;
            console.warn(
              `[edit-journal] replayed ${out.applied} unsaved edit(s) onto the saved timeline (journal #${journal.savedSeq ?? 0}..#${out.lastSeq})`,
            );
          }
          if (out.skipped > 0) {
            console.warn(`[edit-journal] ${out.skipped} journalled edit(s) no longer apply and were dropped`);
          }
        }
      }
      if (recovered > 0) localEditGeneration += 1; // B-272: a local write the backend lacks
      const dur = timelineDuration(landed);
      set((s) => ({
        timeline: landed,
        error: null,
        status: 'ready',
        playhead: Math.min(s.playhead, Math.max(0, dur - 1)),
        // B-088 — this timeline came FROM the backend, so the backend
        // demonstrably holds it: a real `savedVersion` change. Covers the
        // window-`focus` refetch, the timeline switcher, and
        // `restoreSnapshot`'s own trailing reconcile (which is why undo/redo
        // needs no bump of its own). A replayed timeline is NOT what the
        // backend holds yet; its save below bumps it when it lands.
        savedVersion: recovered > 0 ? s.savedVersion : s.savedVersion + 1,
        ...(firstLoad ? { recoveredEdits: recovered } : {}),
      }));
      // B-274/D-402 — persist the replayed edits now, which also records their
      // sequence and compacts the journal.
      if (recovered > 0) void get()._flushSave();
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

  setInspectorTab: (tab) => set({ inspectorTab: tab }),

  setWaveformView: (open) => set({ waveformView: open }),

  setAudioMonitor: (next) =>
    set((s) => ({
      monitorVolume:
        next.volume === undefined || !Number.isFinite(next.volume)
          ? s.monitorVolume
          : Math.min(1, Math.max(0, next.volume)),
      monitorMuted: next.muted === undefined ? s.monitorMuted : next.muted,
    })),

  setPlaybackRate: (rate) => set({ playbackRate: clampPlaybackRate(rate) }),

  setDynamicZoom: (mode) => set({ dynamicZoom: mode }),

  setPanelOpen: (id, open) => set((s) => ({ openPanels: { ...s.openPanels, [id]: open } })),

  setLibraryMode: (mode) => set({ libraryMode: mode }),

  applyOp: (op) => {
    const before = get().timeline;
    if (!before) return;
    const after = applyOpPure(before, op);
    if (after === before) return; // no-op (clamped away)
    localEditGeneration += 1; // B-272
    // B-274/D-402 — written ahead of the debounced save, the moment the edit
    // exists, so a web process killed inside the debounce loses nothing.
    if (journalOn) appendJournal({ seq: ++journalSeq, timelineId: after.id, kind: 'op', op });
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
    // Gated on the track list CHANGING LENGTH at all. This used to be
    // "shrinking", on the reasoning that every track-ADDING path appends
    // (`add_track`, and D-129's `ensureAudioTrackWithRoom` for a dropped clip's
    // audio half) so a growing list renumbers nothing — true until D-239, whose
    // `place_on_top` inserts a brand-new video track at index 0 (a LOWER index
    // is on top, D-086) and therefore renumbers every track below it. Remapping
    // by stable clip id is already index-agnostic, so widening the guard is
    // strictly safer than the old one and a genuine no-op for every appending
    // path: an unchanged index resolves back to itself.
    if (after.tracks.length !== before.tracks.length) {
      const locate = (id: string): number => after.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
      set((s) => ({
        selection: s.selection.map((sel) => ({ ...sel, track: locate(sel.id) })).filter((sel) => sel.track >= 0),
        // A gap selection has no id to follow, so it is simply cleared: a
        // silently-wrong track index is far worse than none, and that applies
        // to an INSERTED track (D-239's `place_on_top` at index 0) exactly as
        // it does to a pruned one. A gap selection is transient and trivially
        // re-made; the alternative — deciding case by case whether this
        // particular length change renumbered this particular track — is more
        // machinery than the state is worth.
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
      // Fire-and-forget on this path by design — `_flushSave` records its own
      // failure in `error` and never rejects. The promise exists for
      // `flushPendingSave`'s benefit (B-080), not this call site's.
      void get()._flushSave();
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
    // B-283 — an undo/redo entry belongs to the timeline it was made on, and
    // `chroma_timeline_set` writes onto whichever timeline is ACTIVE. Undoing
    // after a timeline switch used to write the other timeline's snapshot —
    // id and all — over the active one. It now switches to the snapshot's own
    // timeline first (Premiere's behaviour: undo brings its sequence forward),
    // and refuses in words when that timeline no longer exists (deleted).
    const active = get().timeline;
    if (active && active.id && timeline.id && active.id !== timeline.id) {
      void get()
        .setActiveTimeline(timeline.id)
        .then((switched) => {
          if (!switched.ok) {
            set({
              error: `could not undo/redo on timeline "${timeline.name}": ${switched.error ?? 'it is no longer in this project'}`,
            });
            return;
          }
          get().restoreSnapshot(timeline);
        });
      return;
    }
    localEditGeneration += 1; // B-272
    // B-274/D-402 — an undo/redo is journalled as the whole snapshot it
    // restores: its immediate save is still a round trip a killed page can lose.
    if (journalOn) appendJournal({ seq: ++journalSeq, timelineId: timeline.id, kind: 'snapshot', timeline });
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const dur = timelineDuration(timeline);
    set((s) => ({ timeline, playhead: Math.min(s.playhead, Math.max(0, dur - 1)) }));
    // B-080 — tracked, like every other write to the active timeline: an undo
    // followed straight away by a timeline switch is the same race a debounced
    // edit is, and `flushPendingSave` has to be able to wait this one out too.
    void trackSave(
      invoke('chroma_timeline_set', saveArgs(timeline))
        .then(() => {
          void get().load({ afterOwnSave: true });
          return true;
        })
        .catch((e) => {
          set({ error: String(e) });
          return false;
        }),
    );
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
  //
  // B-080 — this returns a promise now (it used to be `void`). Nothing on the
  // debounced path awaits it; `flushPendingSave` below does, which is the
  // whole reason the save's resolution had to become reachable at all.
  _flushSave: () => {
    const timeline = get().timeline;
    if (!timeline) return Promise.resolve(true);
    return trackSave(
      invoke('chroma_timeline_set', saveArgs(timeline))
        .then(() => {
          set((s) => ({ savedVersion: s.savedVersion + 1 }));
          return true;
        })
        .catch((e) => {
          set({ error: String(e) });
          return false;
        }),
    );
  },

  flushPendingSave: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void get()._flushSave();
    }
    // Loop rather than a single `await`: a save could already have been in
    // flight when the timer above fired, in which case there are two to wait
    // out. `_flushSave`'s own `finally` clears `inFlightSave` when the promise
    // it settles is still the current one, so this terminates as soon as the
    // last save resolves — it cannot spin.
    let ok = true;
    while (inFlightSave) {
      const settled = await inFlightSave;
      ok = ok && settled;
    }
    return ok;
  },

  loadList: async () => {
    try {
      const timelines = await invoke<TimelineSummary[]>('chroma_timeline_list');
      set({ timelines });
    } catch {
      // no project open — leave whatever list (likely empty) is already there
    }
  },

  createTimeline: async (name, opts) => {
    const activate = opts?.activate ?? true;
    let output: OutputSpec | null = null;
    if (opts?.output) {
      const checked = checkTimelineOutput(opts.output.width, opts.output.height);
      if (!checked.ok) return { ok: false, error: checked.error };
      output = checked.output;
    }
    if (!name.trim()) return { ok: false, error: 'a timeline name must not be empty' };
    // B-080 — only a create that ACTIVATES changes where a pending save would
    // land; one that leaves the active timeline alone owes no flush.
    if (activate) {
      const flushed = await get().flushPendingSave();
      if (!flushed) return { ok: false, error: unflushedError(get().error) };
    }
    try {
      const timeline = await invoke<Timeline>('chroma_timeline_create', { name, output, activate });
      if (activate) {
        await Promise.all([get().load(), get().loadList()]);
        set({ playhead: 0 });
      } else {
        await get().loadList();
      }
      return { ok: true, timeline };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  setActiveTimeline: async (id) => {
    // B-080 — the flush must COMPLETE before `chroma_timeline_set_active` is
    // even issued, not merely be started alongside it: `chroma_timeline_set`
    // writes onto whichever timeline is active when it arrives, so the two
    // commands are order-dependent, not independent.
    const flushed = await get().flushPendingSave();
    if (!flushed) return { ok: false, error: unflushedError(get().error) };
    try {
      await invoke('chroma_timeline_set_active', { id });
      await Promise.all([get().load(), get().loadList()]);
      set({ playhead: 0 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  renameTimeline: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'a timeline name must not be empty' };
    const active = get().timeline;
    if (active && active.id === id) {
      get().applyOp({ kind: 'set_timeline_name', name: trimmed });
      return { ok: true };
    }
    try {
      await invoke('chroma_timeline_rename', { id, name: trimmed });
      await get().loadList();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  setTimelineOutput: async (id, output) => {
    let checkedOutput: OutputSpec | null = null;
    if (output) {
      const checked = checkTimelineOutput(output.width, output.height);
      if (!checked.ok) return { ok: false, error: checked.error };
      checkedOutput = checked.output;
    }
    const active = get().timeline;
    if (active && active.id === id) {
      get().applyOp({ kind: 'set_timeline_output', output: checkedOutput });
      return { ok: true };
    }
    try {
      await invoke('chroma_timeline_set_output', { id, output: checkedOutput });
      await get().loadList();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  duplicateTimeline: async (id, opts) => {
    const activate = opts?.activate ?? false;
    // The copy is read off disk, so a pending edit to the timeline being
    // copied must be there first; and an activating duplicate changes where a
    // pending save would land (B-080). Either way: flush.
    if (activate || get().timeline?.id === id) {
      const flushed = await get().flushPendingSave();
      if (!flushed) return { ok: false, error: unflushedError(get().error) };
    }
    try {
      const timeline = await invoke<Timeline>('chroma_timeline_duplicate', {
        id,
        name: opts?.name?.trim() ? opts.name.trim() : null,
        activate,
      });
      if (activate) {
        await Promise.all([get().load(), get().loadList()]);
        set({ playhead: 0 });
      } else {
        await get().loadList();
      }
      return { ok: true, timeline };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  deleteTimeline: async (id) => {
    const wasActive = get().timeline?.id === id;
    // B-080 — deleting the ACTIVE timeline moves "active" to a neighbour, so a
    // save still pending for it would land on that neighbour. Flushed first
    // (onto the timeline about to go, which is harmless) rather than dropped,
    // so a refused delete loses nothing either.
    if (wasActive) {
      const flushed = await get().flushPendingSave();
      if (!flushed) return { ok: false, error: unflushedError(get().error) };
    }
    try {
      await invoke('chroma_timeline_delete', { id });
      if (wasActive) {
        await Promise.all([get().load(), get().loadList()]);
        set({ playhead: 0, selection: [], selectedGap: null, curveEditor: null, dynamicZoom: null });
      } else {
        await get().loadList();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));

/** B-217/D-358 — what this store believes it is holding, for the guard that
 *  refuses an MCP op when the Edit tab and `useSessionStore` have stopped
 *  agreeing about which project is open. `openProjectKey` is pushed in from the
 *  composition root and is this tab's whole project identity (see its own doc
 *  above), so it is the right and only thing to compare. */
registerProjectIdentityParticipant('edit', {
  label: 'Edit timeline',
  read: () => useEditorTimelineStore.getState().openProjectKey,
  expected: (session) => session.projectKey,
});
