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
 * optimistically then persists (`chroma_timeline_set`, debounced) + refetches
 * to reconcile. `loadList()`/`createTimeline()`/`setActiveTimeline()` wrap
 * the D-045 `chroma_timeline_list`/`_create`/`_set_active` commands that had
 * no UI consumer until this pass.
 *
 * D-051: every real (non-no-op) `applyOp` call pushes a `{tab:'edit', ...}`
 * before/after snapshot pair onto `@chroma/history`'s shared undo stack —
 * whole-`Timeline` snapshots (not inverse deltas), because every op here is
 * already whole-document replace/persist, so restoring a snapshot is exactly
 * what a normal edit does. `restoreSnapshot()` is what the history entries'
 * `undo()`/`redo()` closures call: set state to the given `Timeline`,
 * cancelling any pending debounced save, then persist immediately (undo/redo
 * are discrete user actions — no reason to debounce them) and refetch to
 * reconcile, same as a normal edit.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { useHistoryStore } from '@chroma/history';

import { applyOp as applyOpPure, labelForOp, timelineDuration, type EditOp, type Timeline } from './timeline';

const SAVE_DEBOUNCE_MS = 400;

/** Mirrors `chroma::edit::TimelineSummary` (serde camelCase). */
export interface TimelineSummary {
  id: string;
  name: string;
  duration: number;
  active: boolean;
}

interface EditorTimelineState {
  timeline: Timeline | null;
  /** null until the first load resolves; a string when there's no project / an error */
  error: string | null;
  loaded: boolean;
  playhead: number;
  playing: boolean;
  /** every timeline in the open project, for the switcher (D-046 pass 3) */
  timelines: TimelineSummary[];

  load: () => Promise<void>;
  setPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
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

export const useEditorTimelineStore = create<EditorTimelineState>((set, get) => ({
  timeline: null,
  error: null,
  loaded: false,
  playhead: 0,
  playing: false,
  timelines: [],

  load: async () => {
    try {
      const timeline = await invoke<Timeline>('chroma_timeline_get');
      const dur = timelineDuration(timeline);
      set((s) => ({
        timeline,
        error: null,
        loaded: true,
        playhead: Math.min(s.playhead, Math.max(0, dur - 1)),
      }));
    } catch (e) {
      set({ timeline: null, error: String(e), loaded: true, playing: false });
    }
  },

  setPlayhead: (frame) => {
    const dur = timelineDuration(get().timeline);
    const max = Math.max(0, dur - 1);
    set({ playhead: Math.min(Math.max(Math.round(frame), 0), max) });
  },

  setPlaying: (playing) => set({ playing }),

  applyOp: (op) => {
    const before = get().timeline;
    if (!before) return;
    const after = applyOpPure(before, op);
    if (after === before) return; // no-op (clamped away)
    const dur = timelineDuration(after);
    set((s) => ({ timeline: after, playhead: Math.min(s.playhead, Math.max(0, dur - 1)) }));

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

  _flushSave: () => {
    const timeline = get().timeline;
    if (!timeline) return;
    invoke('chroma_timeline_set', { timeline })
      .then(() => get().load())
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
