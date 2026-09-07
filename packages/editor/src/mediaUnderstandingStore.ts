/**
 * `@chroma/editor` — media understanding for the Edit tab (D-189).
 *
 * **What it is:** a small Zustand store holding what the `ai-media/` sidecar
 * has told us about each media file — its transcript ("what was said, and
 * when") and its visual analysis ("what changed on screen, and when") — plus
 * the two actions that fetch them. Results are cached **by source path**, so a
 * repeated ask for the same file is free.
 *
 * **Why the cache is the point, not an optimization.** A transcript takes tens
 * of seconds and a video analysis runs at roughly 4x realtime. An agent
 * working over a cut ("find where I said X", then "and where does the product
 * appear") will ask for the same file repeatedly across separate tool calls,
 * each of which is a fresh round trip with no memory of the last. Without this
 * store each of those pays the full model cost again. `force: true` re-runs
 * anyway, for the case where the file on disk changed.
 *
 * **What it does NOT do:** it does not cut, mark, or otherwise touch the
 * timeline — it holds facts, and the ops/UI that act on them are separate. It
 * does not persist across app restarts (an in-memory cache; a `media_cache`
 * namespace on disk is the obvious next step, and is deliberately not this
 * pass's scope). It does not own the polling *cadence* policy beyond a fixed
 * interval — see `POLL_MS`.
 *
 * **Why it polls rather than awaiting one call:** the sidecar runs both
 * capabilities as background jobs, because `chroma::control`'s bridge has a
 * hard 20 s ceiling and these run far longer (D-189). So each action here
 * starts a job, then polls its status command until terminal. The action's own
 * promise still resolves with the finished result, so callers see a plain
 * async function and the job machinery stays an implementation detail.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/** How often to poll a running sidecar job. Coarse on purpose: these jobs run
 *  for tens of seconds to minutes, so a tighter loop would just add IPC
 *  traffic without making any answer arrive sooner. */
const POLL_MS = 1500;

/** Give up on a job that never reaches a terminal state. Generous — a long
 *  clip's video analysis legitimately runs for minutes — but not unbounded, so
 *  a wedged sidecar surfaces as a real error instead of a promise that never
 *  settles and an agent that waits forever. */
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

/** One word of a transcript, with its own start/end in source seconds. The
 *  shape that makes "cut to this exact word" possible at all. */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

/** `ai-media/transcribe.py`'s result, verbatim. */
export interface Transcript {
  text: string;
  language: string;
  model: string;
  source: string;
  segments: TranscriptSegment[];
  /** Every segment's words, flattened. Absent when the model returned no word
   *  timings at all (`word_timestamps: false`). */
  words?: TranscriptWord[];
}

/** One detected visual moment. `timeS` comes from ffmpeg's scene detection,
 *  never from the model — see `ai-media/video_understand.py` for why that split
 *  is the whole design. */
export interface VideoEvent {
  time_s: number;
  event: string;
}

/** `ai-media/video_understand.py`'s result, verbatim. */
export interface VideoAnalysis {
  video: string;
  question: string;
  events: VideoEvent[];
  _meta: {
    model: string;
    scene_threshold: number;
    min_gap_s: number;
    max_candidates: number;
    candidates: number;
    /** Candidates were dropped at the cap — raise `maxCandidates` and re-run. */
    truncated: boolean;
  };
}

export interface AnalyzeOptions {
  question?: string;
  sceneThreshold?: number;
  minGapS?: number;
  maxCandidates?: number;
  /** Re-run even if a cached result exists (the file changed on disk, or the
   *  tuning knobs above are different from the cached run's). */
  force?: boolean;
}

export interface TranscribeOptions {
  language?: string;
  wordTimestamps?: boolean;
  force?: boolean;
}

/** A sidecar job's status envelope. `result` is only present on `done`. */
interface JobStatus<T> {
  state: 'running' | 'done' | 'error' | 'unknown';
  elapsed_s?: number;
  result?: T;
  error?: string;
}

interface JobStart {
  job_id?: string;
  error?: string;
}

/** What this store knows about one capability for one file. `idle` means
 *  "never asked" — distinct from `error`, which means "asked and it failed."
 *  The distinction matters to a caller deciding whether to start a job. */
export type AnalysisPhase = 'idle' | 'running' | 'done' | 'error';

export interface AnalysisStatus<T> {
  phase: AnalysisPhase;
  result?: T;
  error?: string;
}

interface MediaUnderstandingState {
  /** sourcePath -> transcript. */
  transcripts: Record<string, Transcript>;
  /** sourcePath -> analysis. */
  analyses: Record<string, VideoAnalysis>;
  /** sourcePath -> true while a job is in flight for it. */
  transcribing: Record<string, boolean>;
  analyzing: Record<string, boolean>;
  /** sourcePath -> the last failure, kept so a poller can be told *why* rather
   *  than watching `running` silently flip back to `idle`. Cleared when a new
   *  run for that path starts. */
  transcriptErrors: Record<string, string>;
  analysisErrors: Record<string, string>;

  /** Run to completion. Resolves with the result (cached, if there is one).
   *  Callers that cannot wait minutes — anything reached through
   *  `chroma::control`'s 20 s bridge — should use `start*` + `*Status` below
   *  instead. */
  getTranscript(path: string, options?: TranscribeOptions): Promise<Transcript>;
  analyzeVideo(path: string, options?: AnalyzeOptions): Promise<VideoAnalysis>;

  /** Fire-and-forget: kick the job off if it isn't already cached or running,
   *  and return the phase as of right now. The counterpart to `*Status`, for
   *  the start-then-poll callers described above. */
  startTranscript(path: string, options?: TranscribeOptions): AnalysisPhase;
  startAnalysis(path: string, options?: AnalyzeOptions): AnalysisPhase;

  transcriptStatus(path: string): AnalysisStatus<Transcript>;
  analysisStatus(path: string): AnalysisStatus<VideoAnalysis>;

  /** Drop a cached result (or everything, with no argument) — the escape hatch
   *  for "this file changed and I don't want to pass `force` at every call
   *  site." */
  clear(path?: string): void;
}

/** Start a sidecar job, then poll it to completion. Shared by both actions —
 *  the two capabilities differ only in which pair of Tauri commands they call
 *  and what shape comes back, so the job loop itself is written once. */
async function runJob<T>(
  startCommand: string,
  statusCommand: string,
  args: Record<string, unknown>,
  label: string,
): Promise<T> {
  const started = await invoke<JobStart>(startCommand, args);
  if (started.error) throw new Error(started.error);
  const jobId = started.job_id;
  if (!jobId) throw new Error(`${label}: the sidecar returned no job_id`);

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const status = await invoke<JobStatus<T>>(statusCommand, { jobId });

    if (status.state === 'done') {
      if (!status.result) throw new Error(`${label}: job finished with no result`);
      return status.result;
    }
    // "unknown" means the sidecar has no record of this job — it restarted
    // mid-run, or the job was evicted. Either way the result is never coming,
    // so fail now rather than poll a job id that will never resolve.
    if (status.state === 'error' || status.state === 'unknown') {
      throw new Error(status.error ?? `${label}: job ended in state "${status.state}"`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: still running after ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes — giving up. ` +
          `Check the app log for '[sidecar/ai-media]' lines.`,
      );
    }
  }
}

/** The shared "start it if it isn't already going" body. Returns the phase as
 *  of right now; the promise deliberately isn't awaited or returned — a
 *  rejection is captured into the error map by the actions' own `catch`, so it
 *  never becomes an unhandled rejection. */
function startJob(
  running: boolean,
  cached: boolean,
  errored: string | undefined,
  force: boolean,
  run: () => Promise<unknown>,
): AnalysisPhase {
  if (running) return 'running';
  if (cached && !force) return 'done';
  // A previous failure is NOT sticky: asking again retries, which is what a
  // caller reasonably expects after fixing whatever broke (a stopped sidecar,
  // a missing venv). `errored` is only read to report the last reason.
  void errored;
  run().catch(() => {
    /* recorded in the store's error map by the action itself */
  });
  return 'running';
}

export const useMediaUnderstandingStore = create<MediaUnderstandingState>((set, get) => ({
  transcripts: {},
  analyses: {},
  transcribing: {},
  analyzing: {},
  transcriptErrors: {},
  analysisErrors: {},

  getTranscript: async (path, options = {}) => {
    const cached = get().transcripts[path];
    if (cached && !options.force) return cached;

    set((s) => {
      const { [path]: _cleared, ...transcriptErrors } = s.transcriptErrors;
      return { transcribing: { ...s.transcribing, [path]: true }, transcriptErrors };
    });
    try {
      const transcript = await runJob<Transcript>(
        'chroma_transcribe',
        'chroma_transcribe_status',
        {
          path,
          language: options.language ?? null,
          wordTimestamps: options.wordTimestamps ?? null,
        },
        'transcribe',
      );
      set((s) => ({ transcripts: { ...s.transcripts, [path]: transcript } }));
      return transcript;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ transcriptErrors: { ...s.transcriptErrors, [path]: message } }));
      throw e;
    } finally {
      set((s) => {
        const { [path]: _dropped, ...rest } = s.transcribing;
        return { transcribing: rest };
      });
    }
  },

  analyzeVideo: async (path, options = {}) => {
    const cached = get().analyses[path];
    if (cached && !options.force) return cached;

    set((s) => {
      const { [path]: _cleared, ...analysisErrors } = s.analysisErrors;
      return { analyzing: { ...s.analyzing, [path]: true }, analysisErrors };
    });
    try {
      const analysis = await runJob<VideoAnalysis>(
        'chroma_analyze_video',
        'chroma_analyze_video_status',
        {
          path,
          question: options.question ?? null,
          sceneThreshold: options.sceneThreshold ?? null,
          minGapS: options.minGapS ?? null,
          maxCandidates: options.maxCandidates ?? null,
        },
        'analyze_video',
      );
      set((s) => ({ analyses: { ...s.analyses, [path]: analysis } }));
      return analysis;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ analysisErrors: { ...s.analysisErrors, [path]: message } }));
      throw e;
    } finally {
      set((s) => {
        const { [path]: _dropped, ...rest } = s.analyzing;
        return { analyzing: rest };
      });
    }
  },

  startTranscript: (path, options = {}) => {
    const s = get();
    return startJob(
      !!s.transcribing[path],
      !!s.transcripts[path],
      s.transcriptErrors[path],
      !!options.force,
      () => get().getTranscript(path, options),
    );
  },

  startAnalysis: (path, options = {}) => {
    const s = get();
    return startJob(
      !!s.analyzing[path],
      !!s.analyses[path],
      s.analysisErrors[path],
      !!options.force,
      () => get().analyzeVideo(path, options),
    );
  },

  transcriptStatus: (path) => {
    const s = get();
    if (s.transcripts[path]) return { phase: 'done', result: s.transcripts[path] };
    if (s.transcribing[path]) return { phase: 'running' };
    if (s.transcriptErrors[path]) return { phase: 'error', error: s.transcriptErrors[path] };
    return { phase: 'idle' };
  },

  analysisStatus: (path) => {
    const s = get();
    if (s.analyses[path]) return { phase: 'done', result: s.analyses[path] };
    if (s.analyzing[path]) return { phase: 'running' };
    if (s.analysisErrors[path]) return { phase: 'error', error: s.analysisErrors[path] };
    return { phase: 'idle' };
  },

  clear: (path) => {
    if (path === undefined) {
      set({ transcripts: {}, analyses: {}, transcriptErrors: {}, analysisErrors: {} });
      return;
    }
    set((s) => {
      const { [path]: _t, ...transcripts } = s.transcripts;
      const { [path]: _a, ...analyses } = s.analyses;
      const { [path]: _te, ...transcriptErrors } = s.transcriptErrors;
      const { [path]: _ae, ...analysisErrors } = s.analysisErrors;
      return { transcripts, analyses, transcriptErrors, analysisErrors };
    });
  },
}));
