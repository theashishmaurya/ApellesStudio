/**
 * @apelles/editor — `editor_export` / `editor_export_status` as JOBS of the
 * export queue (B-335).
 *
 * **What it is.** The two MCP ops over `exportQueueStore`:
 *
 * - [`runQueuedEditorExport`] — `editor_export`. It compiles, enqueues the job
 *   under its OWN id (the caller's `jobId`, else a fresh one) and resolves with
 *   THAT job's result when it settles. A second export while one runs queues
 *   behind it (D-198: one job at a time) instead of running beside it or
 *   inheriting its answer.
 * - [`exportJobStatus`] — `editor_export_status` with a `job_id`: that job's
 *   state (`queued` / `running` / `done` / `failed`), its output path and, while
 *   it renders, its live progress.
 *
 * **Why.** Before B-335 the op ran the render directly and the MCP tool, on a
 * bridge timeout, polled the renderer's single "latest export" slot — so an
 * export started while another ran reported the FIRST one's output as its own.
 * A job id from enqueue to result makes "which export is this" a fact, not a
 * guess from whatever the slot holds.
 *
 * **What it does NOT do.** Render (`runCompiledExport`), schedule
 * (`exportQueueStore`), or answer the id-less status (native, `chroma::
 * export_status`: the renderer's latest slot, unchanged).
 */
import { prepareEditorExport, type CompileError, type EditorExportResult } from './editorExport';
import { useExportQueueStore, type ExportJob } from './exportQueueStore';

type ExportArgs = Parameters<typeof prepareEditorExport>[0] & { jobId?: string };

/** What a finished (or failed) job reports as `editor_export`'s result. */
function resultOf(job: ExportJob): EditorExportResult & { jobId: string } {
  return {
    jobId: job.id,
    ok: job.status === 'done',
    error: job.error,
    outPath: job.outPath,
    timelineId: job.timelineId,
    width: job.width,
    height: job.height,
    stdoutTail: job.stdoutTail,
    stderrTail: job.stderrTail,
    args: job.args,
    loudness: job.loudnessReport,
  };
}

/** `editor_export`: enqueue and wait for THIS job. */
export async function runQueuedEditorExport(
  a: ExportArgs,
): Promise<(EditorExportResult & { jobId: string }) | CompileError> {
  const prepared = await prepareEditorExport(a);
  if ('error' in prepared) return prepared;
  const name = typeof a.outPath === 'string' ? (a.outPath.split('/').pop() ?? a.outPath) : 'export';
  const queued = useExportQueueStore.getState().enqueue(name, a, prepared.timeline, a.jobId || undefined);
  if ('error' in queued) return queued;
  const settled = (): ExportJob | undefined => {
    const job = useExportQueueStore.getState().jobs.find((j) => j.id === queued.id);
    return job && (job.status === 'done' || job.status === 'failed') ? job : undefined;
  };
  const already = settled();
  if (already) return resultOf(already);
  return await new Promise((resolve) => {
    const unsubscribe = useExportQueueStore.subscribe(() => {
      const job = settled();
      if (!job) return;
      unsubscribe();
      resolve(resultOf(job));
    });
  });
}

/** `editor_export_status` for one job id. */
export function exportJobStatus(a: { job_id?: unknown }): Record<string, unknown> | CompileError {
  const id = typeof a.job_id === 'string' ? a.job_id : '';
  const jobs = useExportQueueStore.getState().jobs;
  const job = jobs.find((j) => j.id === id);
  if (!job) return { error: `no export job with id "${id}" (this session's jobs: ${jobs.map((j) => j.id).join(', ') || 'none'})` };
  const base = { jobId: job.id, state: job.status, outPath: job.outPath, timelineId: job.timelineId };
  if (job.status === 'queued') {
    const position = jobs.filter((j) => j.status === 'queued').findIndex((j) => j.id === job.id) + 1;
    return { ...base, queuePosition: position, ahead: jobs.filter((j) => j.status === 'running').length + position - 1 };
  }
  if (job.status === 'running') return { ...(job.progress ?? {}), ...base, state: 'running' };
  return { ...base, error: job.error, loudness: job.loudnessReport };
}
