/**
 * `@apelles/editor` — the Automatic Clipper's runs, held for the Clipper
 * panel and the `editor_*clip*` ops (D-411).
 *
 * **What it is.** The open project's clip runs (`clips/<run-id>.json`), the
 * one the panel shows, and each run's latest analysis (the moment view's
 * data). The store is the runs' one writer on this side: every change goes
 * through [`ClipperState.saveRun`], which writes the file through
 * `chroma_clip_run_save` (schema-checked in Rust) BEFORE memory changes, so
 * what the panel shows is always what is on disk.
 *
 * **Why runs persist when retake and music-edit proposals do not.** A run
 * cost an analysis and an agent's judgement (D-411 §5.2). Analyses do not
 * persist: they are recomputed in milliseconds from cached transcripts and
 * audio evidence.
 *
 * **What it does NOT do.** No analysis, gating or building (`clipperOps.ts`),
 * and nothing across projects: a project switch drops it.
 */
import { invoke } from '@tauri-apps/api/core';
import { createSharedStore } from '@apelles/store';

import { useEditorTimelineStore } from '../timelineStore';
import type { AnalyzeWire, ClipRun } from './clipperTypes';

/** One row of `chroma_clip_run_list`. */
export interface ClipRunSummary {
  id: string;
  createdAt: string;
  sourceName: string;
  proposals: number;
  built: number;
}

/** A run's latest analysis, and whether it was read from a partial
 *  (windowed) transcript. */
export interface RunAnalysis {
  wire: AnalyzeWire;
  provisional: boolean;
  at: number;
  /** D-443 — each analysed source's file path, by the index a resolved range
   *  names (`ResolvedRange.source`): where a short's poster frame is read. */
  sourcePaths: string[];
}

/** D-443 — what the Clipper's surface in the viewer area shows: nothing (the
 *  viewer), the New shorts form, or the active run (its reading / waiting state,
 *  or the review of the selected short). */
export type ClipperSurface = 'closed' | 'setup' | 'run';

/** A sentence for the person: an error, or what an action did. */
export interface ClipperNotice {
  ok: boolean;
  message: string;
}

interface ClipperState {
  runs: Record<string, ClipRun>;
  /** Files `chroma_clip_run_list` could not read, by name. */
  loadErrors: Array<{ file: string; error: string }>;
  activeRunId: string | null;
  analyses: Record<string, RunAnalysis>;
  /** D-443 — the viewer-area surface, and the short under review. UI state:
   *  never persisted, dropped with the project. */
  surface: ClipperSurface;
  selectedProposalId: string | null;
  /** Show `surface` in the viewer area (`'run'` also makes `runId` active). */
  openSurface(surface: Exclude<ClipperSurface, 'closed'>, runId?: string): void;
  closeSurface(): void;
  /** Review one short of the active run (opens the run surface). */
  selectProposal(id: string | null): void;
  /** D-443 — the last outcome worth saying (an error, a build result), shown
   *  by the list and the surface alike; `null` once dismissed. */
  notice: ClipperNotice | null;
  setNotice(n: ClipperNotice | null): void;
  /** Write a run (file first, then memory). */
  saveRun(run: ClipRun): Promise<{ ok: true } | { error: string }>;
  /** Read every run of the open project. */
  loadRuns(): Promise<void>;
  deleteRun(id: string): Promise<{ ok: true } | { error: string }>;
  setActiveRun(id: string | null): void;
  setAnalysis(runId: string, analysis: RunAnalysis): void;
  clear(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useClipperStore = createSharedStore<ClipperState>('edit.clipper', (set, get) => ({
  runs: {},
  loadErrors: [],
  activeRunId: null,
  analyses: {},
  surface: 'closed',
  selectedProposalId: null,
  notice: null,

  saveRun: async (run) => {
    try {
      await invoke('chroma_clip_run_save', { run });
    } catch (e: unknown) {
      return { error: `the clip run could not be saved: ${message(e)}` };
    }
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
    return { ok: true };
  },

  loadRuns: async () => {
    let listed: { runs: ClipRunSummary[]; errors: Array<{ file: string; error: string }> };
    try {
      listed = await invoke('chroma_clip_run_list');
    } catch (e: unknown) {
      set({ loadErrors: [{ file: 'clips/', error: message(e) }] });
      return;
    }
    const runs: Record<string, ClipRun> = {};
    const errors = [...listed.errors];
    for (const row of listed.runs) {
      try {
        runs[row.id] = await invoke<ClipRun>('chroma_clip_run_load', { id: row.id });
      } catch (e: unknown) {
        errors.push({ file: `${row.id}.json`, error: message(e) });
      }
    }
    const active = get().activeRunId;
    set({
      runs,
      loadErrors: errors,
      activeRunId: active && runs[active] ? active : (listed.runs[0]?.id ?? null),
    });
  },

  deleteRun: async (id) => {
    try {
      await invoke('chroma_clip_run_delete', { id });
    } catch (e: unknown) {
      return { error: message(e) };
    }
    set((s) => {
      const { [id]: _run, ...runs } = s.runs;
      const { [id]: _analysis, ...analyses } = s.analyses;
      const wasActive = s.activeRunId === id;
      return {
        runs,
        analyses,
        activeRunId: wasActive ? null : s.activeRunId,
        ...(wasActive ? { selectedProposalId: null, surface: 'closed' as const } : {}),
      };
    });
    return { ok: true };
  },

  setActiveRun: (id) => set((s) => (s.activeRunId === id ? s : { activeRunId: id, selectedProposalId: null })),

  openSurface: (surface, runId) =>
    set((s) => ({
      surface,
      ...(runId && runId !== s.activeRunId ? { activeRunId: runId, selectedProposalId: null } : {}),
    })),

  closeSurface: () => set({ surface: 'closed' }),

  setNotice: (notice) => set({ notice }),

  selectProposal: (id) => set(id === null ? { selectedProposalId: null } : { selectedProposalId: id, surface: 'run' }),

  setAnalysis: (runId, analysis) => set((s) => ({ analyses: { ...s.analyses, [runId]: analysis } })),

  clear: () => set({ runs: {}, loadErrors: [], activeRunId: null, analyses: {}, surface: 'closed', selectedProposalId: null, notice: null }),
}));

// Runs belong to the open project: a switch drops them (the panel reloads).
useEditorTimelineStore.subscribe((s, prev) => {
  if (s.openProjectKey !== prev.openProjectKey) useClipperStore.getState().clear();
});
