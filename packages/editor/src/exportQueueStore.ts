/**
 * @apelles/editor — the Edit tab's export queue (D-198,
 * `docs/notes/export-dialog-queue.md`).
 *
 * What it is: a real, SEQUENTIAL job queue over `editorExport.ts`'s
 * compile/run split — `enqueue` compiles a job's ffmpeg argv immediately
 * (`compileEditorExportArgs`, a real snapshot of the timeline at that
 * instant, so editing further after queueing job 1 cannot silently change
 * what job 1 renders), pushes it `'queued'`, and `runNext` picks the first
 * queued job the moment nothing else is `'running'` — so job 2 starts the
 * instant job 1 finishes, with no polling and no idle gap. Real, live
 * per-job status (`queued`/`running`/`done`/`failed`), not a decorative list.
 *
 * **Sequential, not parallel — a deliberate D-198 scope call, not an
 * oversight.** ffmpeg is already CPU/GPU-heavy per export; running two at
 * once on the same machine mostly just makes both slower rather than
 * finishing sooner, and a real concurrency-limited pool (N workers, a real
 * scheduler) is a genuinely separate, larger piece of work than "add a
 * queue" — see D-198's own decision entry for the honest accounting.
 *
 * Module-level zustand store (same "reachable via `.getState()` outside
 * React's render cycle, survives the Export dialog closing" convention
 * `useEditorTimelineStore`/`useMediaUnderstandingStore` already use) — a
 * multi-minute export must keep running/reporting status even if the user
 * closes the dialog and reopens it later, or switches tabs.
 */
import { create } from 'zustand';
import { compileEditorExportArgs, readTimelineExportStatus, runCompiledExport } from './editorExport';
import type { TimelineExportStatus } from './editorExport';
import type { TimelineRenderPlan } from './timelinePipeExport';
import type { LoudnessReport, LoudnessTarget } from './loudness';

/** How often a running compositor job's real progress is re-read (D-362).
 *
 *  The read is a handful of atomic loads behind one Tauri command, so the cost
 *  is the IPC hop and nothing else. Half a second is fast enough that a
 *  progress bar moves smoothly on an export measured in minutes, and slow
 *  enough to be invisible next to the render itself — this repo's performance
 *  rule cuts both ways, and a progress poll that competed with the compositor
 *  for a core would be the wrong trade. */
const PROGRESS_POLL_MS = 500;

export type ExportJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ExportJob {
  id: string;
  /** A human label for the dialog's list — defaults to the output file's
   *  own basename, but callers may pass anything more descriptive. */
  name: string;
  outPath: string;
  /** The compiled ffmpeg argv, frozen at enqueue time — see this module's
   *  own header doc for why. */
  args: string[];
  /** D-350 — frozen alongside `args` when this job was compiled for the
   *  compositor render path: the frame count and size the app's own compositor
   *  must feed that argv's stdin. Absent for a job compiled for the old
   *  filter-graph path, which needs no frames from us. Frozen for exactly the
   *  reason `args` is — a job must run the path it was queued for, even if the
   *  timeline or the dialog's choice has changed since. */
  render?: TimelineRenderPlan;
  /** D-401 — the loudness target frozen at enqueue, like `args`. */
  loudness?: LoudnessTarget;
  /** D-401 — measured before/after loudness once the job is done. */
  loudnessReport?: LoudnessReport;
  status: ExportJobStatus;
  /** D-362 — this job's LIVE progress while it runs on the compositor path,
   *  polled from the renderer's own counters (`editor_export_status`'s exact
   *  snapshot). `null` when the job is not running, and also for a
   *  filter-graph job: that path hands the whole export to one ffmpeg and
   *  learns nothing until it exits, so there is no honest number to show and
   *  the dialog keeps its spinner rather than inventing one. */
  progress: TimelineExportStatus | null;
  /** Populated only for `status === 'failed'` — ffmpeg's own stderr tail,
   *  or a compile-time validation error. */
  error: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface ExportQueueState {
  jobs: ExportJob[];
  /** Compile `exportArgs` right now and enqueue it — returns the new job's
   *  id, or a compile error (the SAME validation `editor_export` itself
   *  would reject with — bad `outPath`/`width`/`height`/etc.) without ever
   *  touching the queue. */
  enqueue(
    name: string,
    exportArgs: Parameters<typeof compileEditorExportArgs>[0],
  ): { id: string } | { error: string };
  /** Drop every finished (`done`/`failed`) job from the list — a `queued`/
   *  `running` job is never removed by this (there is no cancel this pass;
   *  see D-198's own honestly-scoped gaps). */
  clearFinished(): void;
}

/** D-362 — follow the renderer's own progress counters onto `job`, until it
 *  stops running. Returns the stopper.
 *
 *  **Only a snapshot from a LATER render than the one already recorded is
 *  believed.** The renderer keeps the last export's result in its slot after
 *  it finishes, so a poll that lands before this job's render has actually
 *  begun would otherwise paint the PREVIOUS export's numbers — a "done, 100%"
 *  for a job that has not started. `jobId` is monotonic per render, which is
 *  what it is for. */
function followProgress(jobId: string, baselineRenderId: number): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void readTimelineExportStatus()
      .then((progress) => {
        if (stopped || progress.jobId <= baselineRenderId) return;
        useExportQueueStore.setState((s) => ({
          jobs: s.jobs.map((j) => (j.id === jobId && j.status === 'running' ? { ...j, progress } : j)),
        }));
      })
      // A failed read is not a failed export: the render owns the outcome, and
      // this is only its readout. Leave the last good numbers on screen.
      .catch(() => {});
  }, PROGRESS_POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function runNext(): void {
  const { jobs } = useExportQueueStore.getState();
  if (jobs.some((j) => j.status === 'running')) return; // one at a time — D-198
  const next = jobs.find((j) => j.status === 'queued');
  if (!next) return;

  useExportQueueStore.setState((s) => ({
    jobs: s.jobs.map((j) => (j.id === next.id ? { ...j, status: 'running' as const, startedAt: Date.now() } : j)),
  }));

  // Only the compositor path has progress to report (see `ExportJob.progress`).
  // The baseline is read BEFORE the render starts, so the poller can tell this
  // job's render from whatever the slot is still holding.
  let stopFollowing: (() => void) | null = null;
  if (next.render) {
    void readTimelineExportStatus()
      .then((before) => {
        // By the time this resolves the job may already have finished; starting
        // a poller then would leave an interval running with nothing to update.
        if (useExportQueueStore.getState().jobs.find((j) => j.id === next.id)?.status !== 'running') return;
        stopFollowing = followProgress(next.id, before.jobId);
      })
      .catch(() => {});
  }

  const settle = (patch: Partial<ExportJob>) => {
    stopFollowing?.();
    stopFollowing = null;
    useExportQueueStore.setState((s) => ({
      jobs: s.jobs.map((j) => (j.id === next.id ? { ...j, ...patch, progress: null, finishedAt: Date.now() } : j)),
    }));
  };

  runCompiledExport(next.args, next.render, next.outPath, next.loudness)
    .then((outcome) => {
      settle({ status: outcome.ok ? 'done' : 'failed', error: outcome.error, loudnessReport: outcome.loudness });
    })
    .catch((e: unknown) => {
      settle({ status: 'failed', error: String((e as Error)?.message ?? e) });
    })
    .finally(() => runNext()); // cascade to the next queued job, if any
}

export const useExportQueueStore = create<ExportQueueState>((set) => ({
  jobs: [],
  enqueue: (name, exportArgs) => {
    const compiled = compileEditorExportArgs(exportArgs);
    if (!('ok' in compiled)) return { error: compiled.error };
    const id = `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: ExportJob = {
      id,
      name,
      outPath: compiled.outPath,
      args: compiled.args,
      render: compiled.render,
      loudness: compiled.loudness,
      status: 'queued',
      progress: null,
      error: null,
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    set((s) => ({ jobs: [...s.jobs, job] }));
    runNext();
    return { id };
  },
  clearFinished: () => set((s) => ({ jobs: s.jobs.filter((j) => j.status === 'queued' || j.status === 'running') })),
}));
