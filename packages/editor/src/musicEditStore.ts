/**
 * `@apelles/editor` — the music-edit review list and the panel's defaults
 * (D-408).
 *
 * **What it is.** Per music track, the proposal set an agent's
 * `editor_propose_music_edits` stored (and the rows a person added from the
 * panel or a transcript line), each row's review status and adjustments; plus
 * the defaults the panel and the "Music dropout here" context actions use —
 * which track is the bed when it is ambiguous, the fade lengths, the re-entry
 * mode. Held in a store rather than in the panel for the reason
 * `mediaUnderstandingStore.retakeProposals` is: the agent writes it and the
 * person reads it, and component state cannot be fed from outside.
 *
 * **Lifecycle (mirrors the retake proposals, D-380 step 2).** A proposal call
 * REPLACES its track's set; an empty one clears it. Applying removes the rows
 * that landed and keeps the ones that did not (with their reason shown). Every
 * set carries the timeline it was made on and is ignored on any other; the
 * whole store is dropped when the open project changes.
 *
 * **What it does NOT do.** No document writes (applying is the `music_edits`
 * op, through `musicEditOps.ts`), no persistence — like the retake proposals
 * it is review state for this session, not part of `project.json`.
 */

import { createSharedStore } from '@apelles/store';

import type { MusicEditMode } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { DEFAULT_MUSIC_FADE_IN_FRAMES, DEFAULT_MUSIC_FADE_OUT_FRAMES } from './timeline';
import type { MusicEditProposalSet, MusicEditRow, MusicEditRowStatus } from './musicEdits';

/** What a reviewer may change on a row. */
export type MusicEditRowPatch = Partial<Pick<MusicEditRow, 'start' | 'end' | 'fadeOutFrames' | 'fadeInFrames' | 'mode' | 'kind'>>;

/** The panel's defaults for an edit made from the GUI. */
export interface MusicEditDefaults {
  /** The bed to use when more than one audio track has music under a range;
   *  `null` = only act when it is unambiguous. */
  track: number | null;
  fadeOutFrames: number;
  fadeInFrames: number;
  mode: MusicEditMode;
}

interface MusicEditState {
  /** Music track index -> its proposal set. */
  proposals: Record<number, MusicEditProposalSet>;
  defaults: MusicEditDefaults;
  setProposals(track: number, set: MusicEditProposalSet | null): void;
  setRowStatus(track: number, id: string, status: MusicEditRowStatus): void;
  /** Accept or reject every pending row of a set at once. */
  setAllPending(track: number, status: MusicEditRowStatus): void;
  patchRow(track: number, id: string, patch: MusicEditRowPatch): void;
  /** Add a person's row to `track`'s set, creating the set if there is none. */
  addRow(track: number, timelineId: string, row: Omit<MusicEditRow, 'id'>): string;
  removeRows(track: number, ids: readonly string[]): void;
  setDefaults(patch: Partial<MusicEditDefaults>): void;
  clear(): void;
}

export const DEFAULT_MUSIC_EDIT_DEFAULTS: MusicEditDefaults = {
  track: null,
  fadeOutFrames: DEFAULT_MUSIC_FADE_OUT_FRAMES,
  fadeInFrames: DEFAULT_MUSIC_FADE_IN_FRAMES,
  mode: 'continuous',
};

function updateSet(
  proposals: Record<number, MusicEditProposalSet>,
  track: number,
  fn: (set: MusicEditProposalSet) => MusicEditProposalSet | null,
): Record<number, MusicEditProposalSet> {
  const set = proposals[track];
  if (!set) return proposals;
  const next = fn(set);
  const { [track]: _dropped, ...rest } = proposals;
  return next && next.rows.length > 0 ? { ...rest, [track]: next } : rest;
}

export const useMusicEditStore = createSharedStore<MusicEditState>('edit.musicEdits', (set, get) => ({
  proposals: {},
  defaults: DEFAULT_MUSIC_EDIT_DEFAULTS,

  setProposals: (track, proposals) =>
    set((s) => {
      const { [track]: _dropped, ...rest } = s.proposals;
      return { proposals: proposals && proposals.rows.length > 0 ? { ...rest, [track]: proposals } : rest };
    }),

  setRowStatus: (track, id, status) =>
    set((s) => ({
      proposals: updateSet(s.proposals, track, (ps) => ({
        ...ps,
        rows: ps.rows.map((r) => (r.id === id ? { ...r, status } : r)),
      })),
    })),

  setAllPending: (track, status) =>
    set((s) => ({
      proposals: updateSet(s.proposals, track, (ps) => ({
        ...ps,
        rows: ps.rows.map((r) => (r.status === 'pending' ? { ...r, status } : r)),
      })),
    })),

  patchRow: (track, id, patch) =>
    set((s) => ({
      proposals: updateSet(s.proposals, track, (ps) => ({
        ...ps,
        rows: ps.rows.map((r) => {
          if (r.id !== id) return r;
          const next = { ...r, ...patch };
          // Frames stay whole and ordered; a reviewer's nudge can never make
          // a row that is not a range.
          next.start = Math.max(0, Math.round(next.start));
          next.end = Math.max(next.start + 1, Math.round(next.end));
          next.fadeOutFrames = Math.max(0, Math.round(next.fadeOutFrames));
          next.fadeInFrames = Math.max(0, Math.round(next.fadeInFrames));
          return next;
        }),
      })),
    })),

  addRow: (track, timelineId, row) => {
    const existing = get().proposals[track];
    const base: MusicEditProposalSet =
      existing && existing.timelineId === timelineId
        ? existing
        : { timelineId, track, receivedAt: Date.now(), rows: [], nextId: 0 };
    const id = `p${base.nextId}`;
    set((s) => ({
      proposals: { ...s.proposals, [track]: { ...base, rows: [...base.rows, { ...row, id }], nextId: base.nextId + 1 } },
    }));
    return id;
  },

  removeRows: (track, ids) =>
    set((s) => ({
      proposals: updateSet(s.proposals, track, (ps) => ({ ...ps, rows: ps.rows.filter((r) => !ids.includes(r.id)) })),
    })),

  setDefaults: (patch) => set((s) => ({ defaults: { ...s.defaults, ...patch } })),

  clear: () => set({ proposals: {}, defaults: DEFAULT_MUSIC_EDIT_DEFAULTS }),
}));

// Everything here belongs to the open project: a switch drops it, the way the
// timeline store drops its own document (B-083/D-203). Idempotent, so a second
// subscription after a dev-mode module re-evaluation is harmless.
useEditorTimelineStore.subscribe((s, prev) => {
  if (s.openProjectKey !== prev.openProjectKey) useMusicEditStore.getState().clear();
});
