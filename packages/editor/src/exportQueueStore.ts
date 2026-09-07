/**
 * @chroma/editor — the Edit tab's export queue (D-198,
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
import { compileEditorExportArgs, runCompiledExport } from './editorExport';

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
  status: ExportJobStatus;
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

function runNext(): void {
  const { jobs } = useExportQueueStore.getState();
  if (jobs.some((j) => j.status === 'running')) return; // one at a time — D-198
  const next = jobs.find((j) => j.status === 'queued');
  if (!next) return;

  useExportQueueStore.setState((s) => ({
    jobs: s.jobs.map((j) => (j.id === next.id ? { ...j, status: 'running' as const, startedAt: Date.now() } : j)),
  }));

  runCompiledExport(next.args)
    .then((outcome) => {
      useExportQueueStore.setState((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === next.id
            ? {
                ...j,
                status: outcome.ok ? ('done' as const) : ('failed' as const),
                error: outcome.error,
                finishedAt: Date.now(),
              }
            : j,
        ),
      }));
    })
    .catch((e: unknown) => {
      useExportQueueStore.setState((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === next.id
            ? { ...j, status: 'failed' as const, error: String((e as Error)?.message ?? e), finishedAt: Date.now() }
            : j,
        ),
      }));
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
      status: 'queued',
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
