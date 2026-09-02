/**
 * @chroma/editor — the Edit-tab timeline store (D-041).
 *
 * Kept in `@chroma/editor` for now; a `@chroma/bridge` extraction (shared
 * stores + typed Tauri bindings) is a separate later task (D-039 step 6).
 *
 * State: the `chroma-timeline` model for the open project, the playhead
 * (timeline frame), and a play flag. `load()` fetches (`chroma_timeline_get`);
 * `applyOp()` mutates optimistically then persists (`chroma_timeline_set`,
 * debounced) + refetches to reconcile.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

import { applyOp as applyOpPure, timelineDuration, type EditOp, type Timeline } from './timeline';

const SAVE_DEBOUNCE_MS = 400;

interface EditorTimelineState {
  timeline: Timeline | null;
  /** null until the first load resolves; a string when there's no project / an error */
  error: string | null;
  loaded: boolean;
  playhead: number;
  playing: boolean;

  load: () => Promise<void>;
  setPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  applyOp: (op: EditOp) => void;
  _flushSave: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditorTimelineStore = create<EditorTimelineState>((set, get) => ({
  timeline: null,
  error: null,
  loaded: false,
  playhead: 0,
  playing: false,

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
    const cur = get().timeline;
    if (!cur) return;
    const next = applyOpPure(cur, op);
    if (next === cur) return; // no-op (clamped away)
    const dur = timelineDuration(next);
    set((s) => ({ timeline: next, playhead: Math.min(s.playhead, Math.max(0, dur - 1)) }));

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      get()._flushSave();
    }, SAVE_DEBOUNCE_MS);
  },

  _flushSave: () => {
    const timeline = get().timeline;
    if (!timeline) return;
    invoke('chroma_timeline_set', { timeline })
      .then(() => get().load())
      .catch((e) => set({ error: String(e) }));
  },
}));
