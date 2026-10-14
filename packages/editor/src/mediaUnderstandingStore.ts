/**
 * `@apelles/editor` — media understanding for the Edit tab (D-189).
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
 * **Two of the caches here are not optimizations at all (D-349).** A
 * dark-region scan says where whisper silently dropped speech, and a *recovery*
 * is a whole extra Whisper pass over one window to get those words back. Every
 * consumer of the transcript — retake grouping, the Transcript panel,
 * `editor_get_timeline_transcript` — must read the SAME spliced result, or two
 * callers disagree about what was said; caching the recovery by
 * `path|window` is what makes that one answer rather than several. See
 * `darkRegions.ts` for the splice itself.
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
import { DEFAULT_MIN_SILENCE_MS, type RetakeGroupWire } from './recut';
import type { DarkDetection, RecoveredWindow, RecoveryWindow } from './darkRegions';
import type { RetakeProposalSet } from './retakeProposals';

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

/** `chroma_detect_silences`'s result, verbatim — seconds, not frames. The
 *  seconds→frames conversion needs a clip and an fps and belongs to the op
 *  layer (D-318), so this store caches what the detector actually said. */
export interface SilenceDetection {
  source: string;
  start_secs: number;
  duration_secs: number;
  analysed_secs: number;
  min_silence_ms: number;
  model: string;
  silences: Array<{ start_secs: number; end_secs: number; duration_secs: number }>;
}

/** `chroma_detect_retakes`'s result, verbatim. */
export interface RetakeDetection {
  similarity: number;
  window_secs: number;
  min_words: number;
  max_span_utterances: number;
  phrase_min_words: number;
  utterances: number;
  groups: RetakeGroupWire[];
}

/** Everything that changes what `chroma_detect_silences` would answer. */
export interface SilenceDetectionArgs {
  path: string;
  startSecs: number;
  durationSecs: number;
  minSilenceMs?: number;
}

/** Everything that changes what `chroma_detect_retakes` would answer, plus the
 *  clip range the utterances were filtered to. */
export interface RetakeDetectionArgs {
  path: string;
  startSecs: number;
  durationSecs: number;
  utterances: Array<{ start: number; end: number; text: string }>;
  similarity?: number;
  windowSecs?: number;
  minWords?: number;
  maxSpanUtterances?: number;
  /** Shortest repeated PHRASE, in words, that marks two spans as one
   *  self-correction even when `similarity` says they are different sentences
   *  (D-365) — the detector's second, independent signal. 0 turns it off,
   *  giving exactly the pre-D-365 detector. */
  phraseMinWords?: number;
  /** How many of `utterances` came from a dark-region recovery rather than from
   *  the whole-file pass (D-349). Not sent to the detector — it is in the KEY,
   *  because a splice can swap a stretched-word segment for a recovered one
   *  without changing the count, and serving the pre-splice grouping to a caller
   *  that now has the recovered words is exactly the stale answer
   *  [`retakeKey`]'s utterance count exists to prevent. */
  recovered?: number;
}

/** The cache key for one silence detection (B-188/D-321).
 *
 *  Unlike a transcript — which is a fact about a whole FILE and is therefore
 *  keyed by path alone — a detection is a fact about a *range of* a file at a
 *  *given threshold*. Two clips trimmed from one source, or one clip asked at
 *  two thresholds, are different questions with different answers, so every
 *  input that changes the answer is in the key. Pure, and unit-tested: a key
 *  that collided would silently serve one clip another clip's cut list.
 */
export function silenceKey(a: SilenceDetectionArgs): string {
  return [
    a.path,
    a.startSecs,
    a.durationSecs,
    a.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS,
  ].join('|');
}

/** The cache key for one retake detection. Same rule as [`silenceKey`], plus
 *  the utterance COUNT — the transcript can arrive between two calls, and a
 *  detection run over 0 utterances must not be served to a caller that now has
 *  the words. */
export function retakeKey(a: RetakeDetectionArgs): string {
  return [
    a.path,
    a.startSecs,
    a.durationSecs,
    a.utterances.length,
    a.recovered ?? 0,
    a.similarity ?? '',
    a.windowSecs ?? '',
    a.minWords ?? '',
    a.maxSpanUtterances ?? '',
    a.phraseMinWords ?? '',
  ].join('|');
}

/** Everything that changes what `chroma_detect_dark_regions` would answer
 *  (D-349). The WORDS are not in the key: they come from the file's own
 *  transcript, which is cached by path and cannot differ between two calls for
 *  the same path — and a key carrying 900 word times would be enormous. What
 *  *is* in it is `transcriptWords`, the count, for the same reason
 *  [`retakeKey`] carries the utterance count: a scan run before the transcript
 *  arrived must not be served to a caller that now has the words. */
export interface DarkDetectionArgs {
  path: string;
  startSecs: number;
  durationSecs: number;
  words: Array<{ start: number; end: number }>;
  minDarkSecs?: number;
  maxWordSecs?: number;
  rmsFloorScale?: number;
}

export function darkKey(a: DarkDetectionArgs): string {
  return [
    a.path,
    a.startSecs,
    a.durationSecs,
    a.words.length,
    a.minDarkSecs ?? '',
    a.maxWordSecs ?? '',
    a.rmsFloorScale ?? '',
  ].join('|');
}

/** The cache key for one recovery pass — an isolated re-transcription of one
 *  window of one file. Same `<path>|…` prefix convention as every other key
 *  here, so `clear(path)` drops these too. Also the key of a client's re-read
 *  (D-380 step 2) — the same question about the same audio, held in its own
 *  map because it is a preview until the client applies it. */
export function recoveryKey(path: string, window: RecoveryWindow): string {
  return [path, window.startSecs, window.durationSecs].join('|');
}

/** A re-read the MCP client chose to APPLY (D-380 step 2): spliced into the
 *  file's transcript after every dark-region recovery, in the order applied, a
 *  later one winning wherever two overlap (see `spliceTranscript`). `seq` is
 *  that order — a counter, not a clock, so the splice is deterministic. */
export interface AppliedReread extends RecoveredWindow {
  seq: number;
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

  /** [`silenceKey`] -> detection. The recut detectors (D-318) get the same
   *  three-map treatment for the same reason the sidecar jobs above do — see
   *  B-188/D-321: a detection that outruns its caller's timeout must leave its
   *  answer somewhere retrievable instead of being thrown away. */
  silences: Record<string, SilenceDetection>;
  detectingSilences: Record<string, boolean>;
  silenceErrors: Record<string, string>;
  /** [`retakeKey`] -> detection, and its twins. */
  retakes: Record<string, RetakeDetection>;
  detectingRetakes: Record<string, boolean>;
  retakeErrors: Record<string, string>;
  /** [`darkKey`] -> the dark-region scan, and its twins (D-349). */
  dark: Record<string, DarkDetection>;
  detectingDark: Record<string, boolean>;
  darkErrors: Record<string, string>;
  /** [`recoveryKey`] -> one window's isolated re-transcription, and its twins.
   *  Cached as hard as a transcript is, and for a stronger reason: a recovery is
   *  a whole Whisper pass, and the whole point of splicing is that every
   *  consumer of the transcript sees the same recovered words. */
  recoveries: Record<string, RecoveredWindow>;
  recovering: Record<string, boolean>;
  recoveryErrors: Record<string, string>;
  /** [`recoveryKey`] -> an isolated re-read a client asked for over a stretch
   *  of words (`editor_retranscribe_words`, D-380 step 2), and its twins. A
   *  PREVIEW: nothing reads these until one is applied. */
  rereads: Record<string, RecoveredWindow>;
  rereading: Record<string, boolean>;
  rereadErrors: Record<string, string>;
  /** [`recoveryKey`] -> the re-reads a client APPLIED. Part of the transcript
   *  from then on, for every consumer, through [`recoveriesFor`]. */
  appliedRereads: Record<string, AppliedReread>;
  /** The next [`AppliedReread.seq`]. */
  rereadSeq: number;
  /** Track index -> the MCP client's retake proposals for that track, as the
   *  coverage gate judged them (D-380 step 2). The Recut panel subscribes to
   *  this; `editor_propose_retakes` writes it. Held here rather than in the
   *  panel because the agent writes it and the human reads it — component
   *  state cannot be fed from outside. */
  retakeProposals: Record<number, RetakeProposalSet>;

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

  /** The recut detectors, in the same three shapes (B-188/D-321). `detect*`
   *  runs to completion; `startDetect*` kicks it and returns the phase now;
   *  `*DetectionStatus` is a pure read of the maps above, keyed by
   *  [`silenceKey`] / [`retakeKey`]. */
  detectSilences(args: SilenceDetectionArgs, force?: boolean): Promise<SilenceDetection>;
  startSilenceDetection(args: SilenceDetectionArgs, force?: boolean): AnalysisPhase;
  silenceDetectionStatus(key: string): AnalysisStatus<SilenceDetection>;

  detectRetakes(args: RetakeDetectionArgs, force?: boolean): Promise<RetakeDetection>;
  startRetakeDetection(args: RetakeDetectionArgs, force?: boolean): AnalysisPhase;
  retakeDetectionStatus(key: string): AnalysisStatus<RetakeDetection>;

  /** The dark-region scan (D-349), in the same three shapes. */
  detectDarkRegions(args: DarkDetectionArgs, force?: boolean): Promise<DarkDetection>;
  startDarkDetection(args: DarkDetectionArgs, force?: boolean): AnalysisPhase;
  darkDetectionStatus(key: string): AnalysisStatus<DarkDetection>;

  /** Re-transcribe ONE window of a file in isolation and cache the result — the
   *  recovery half of D-349. `language` should be the whole-file pass's own
   *  detected language: auto-detection on a short window is unreliable and was
   *  measured returning an entirely different script for 2 of 10 real windows,
   *  where the same windows read correctly once the language was pinned. */
  recoverWindow(
    path: string,
    window: RecoveryWindow,
    language?: string,
    force?: boolean,
  ): Promise<RecoveredWindow>;
  startRecovery(
    path: string,
    window: RecoveryWindow,
    language?: string,
    force?: boolean,
  ): AnalysisPhase;
  recoveryStatus(key: string): AnalysisStatus<RecoveredWindow>;
  /** Every window spliced into one file's transcript, in splice order — what
   *  [`spliceTranscript`] takes, so every consumer reads one transcript. The
   *  dark-region recoveries first, in time order (disjoint by construction),
   *  then the client re-reads it applied, in the order applied (D-380 step 2),
   *  so a re-read replaces whatever it overlaps. Pure read.
   *
   *  [`spliceTranscript`]: ./darkRegions.ts */
  recoveriesFor(path: string): RecoveredWindow[];
  /** Only the client re-reads applied to one file, in the order applied — the
   *  part of [`recoveriesFor`] that is part of the transcript even when the
   *  D-349 dark-region pass is not run. Pure read. */
  appliedRereadsFor(path: string): RecoveredWindow[];

  /** Re-transcribe one window of a file for a client to inspect (D-380 step
   *  2) — the same isolated pass a dark-region recovery runs, cached as a
   *  preview. Start-then-poll like every other job here. */
  startReread(path: string, window: RecoveryWindow, language?: string, force?: boolean): AnalysisPhase;
  rereadStatus(key: string): AnalysisStatus<RecoveredWindow>;
  /** Splice a finished re-read into the file's transcript (see
   *  [`recoveriesFor`]). `false` when there is no finished re-read under that
   *  key. Re-applying the same window moves it to the end of the order. */
  applyReread(key: string): boolean;

  /** Store or replace one track's client proposals; `null` clears them. */
  setRetakeProposals(track: number, set: RetakeProposalSet | null): void;

  /** Drop a cached result (or everything, with no argument) — the escape hatch
   *  for "this file changed and I don't want to pass `force` at every call
   *  site." */
  clear(path?: string): void;

  /** Forget every recorded FAILURE for one file (or for everything), keeping
   *  every expensive result.
   *
   *  The retry a human means by clicking a button again, without [`clear`]'s
   *  cost: `clear` would drop the transcript too and re-run a multi-minute
   *  Whisper pass to retry a two-second VAD scan. Added with D-349, whose
   *  `clipTranscriptView` deliberately does NOT auto-retry a failed scan —
   *  auto-retrying it would spin a broken model forever instead of degrading to
   *  the raw transcript, so "forget the failure" has to be something a caller
   *  asks for. */
  clearErrors(path?: string): void;
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

/** One isolated, windowed transcription pass — the dark-region recovery's
 *  (D-349) and a client re-read's (D-380 step 2), which are the same question
 *  about the same audio. The sidecar returns its words already in absolute
 *  source seconds. `language` should be the whole-file pass's own (see
 *  `recoverWindow`'s doc for why it is pinned). The backend is the sidecar's
 *  default — the same one the whole-file transcript came from. */
async function transcribeWindow(
  path: string,
  window: RecoveryWindow,
  language: string | undefined,
  label: string,
): Promise<RecoveredWindow> {
  const result = await runJob<Transcript>(
    'chroma_transcribe',
    'chroma_transcribe_status',
    {
      path,
      language: language ?? null,
      wordTimestamps: true,
      startSecs: window.startSecs,
      durationSecs: window.durationSecs,
    },
    label,
  );
  return { window, segments: result.segments ?? [] };
}

/** [`MediaUnderstandingState.recoveriesFor`] over plain maps: the dark-region
 *  recoveries in time order, then the client re-reads in the order applied.
 *  Exported so a component that SUBSCRIBES to both maps (the Recut panel's
 *  staleness check) computes from what it subscribed to, not from `getState()`. */
export function recoveriesIn(
  s: Pick<MediaUnderstandingState, 'recoveries' | 'appliedRereads'>,
  path: string,
): RecoveredWindow[] {
  const prefix = `${path}|`;
  const dark = Object.entries(s.recoveries)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v)
    .sort((a, b) => a.window.startSecs - b.window.startSecs);
  return [...dark, ...appliedRereadsIn(s, path)];
}

/** [`MediaUnderstandingState.appliedRereadsFor`] over a plain map. */
export function appliedRereadsIn(
  s: Pick<MediaUnderstandingState, 'appliedRereads'>,
  path: string,
): RecoveredWindow[] {
  const prefix = `${path}|`;
  return Object.entries(s.appliedRereads)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v)
    .sort((a, b) => a.seq - b.seq)
    .map(({ window, segments }) => ({ window, segments }));
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

/** Every entry of a detection map whose key did NOT come from `path`.
 *
 *  Both key builders put the path first and join with `|`, and a real absolute
 *  path cannot contain `|`, so the prefix test is exact rather than a
 *  heuristic. Pure — unit-tested alongside the key builders. */
function withoutPath<T>(map: Record<string, T>, path: string): Record<string, T> {
  const prefix = `${path}|`;
  return Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith(prefix)));
}

export const useMediaUnderstandingStore = create<MediaUnderstandingState>((set, get) => ({
  transcripts: {},
  analyses: {},
  transcribing: {},
  analyzing: {},
  transcriptErrors: {},
  analysisErrors: {},
  silences: {},
  detectingSilences: {},
  silenceErrors: {},
  retakes: {},
  detectingRetakes: {},
  retakeErrors: {},
  dark: {},
  detectingDark: {},
  darkErrors: {},
  recoveries: {},
  recovering: {},
  recoveryErrors: {},
  rereads: {},
  rereading: {},
  rereadErrors: {},
  appliedRereads: {},
  rereadSeq: 0,
  retakeProposals: {},

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

  detectSilences: async (args, force = false) => {
    const key = silenceKey(args);
    const cached = get().silences[key];
    if (cached && !force) return cached;

    set((s) => {
      const { [key]: _cleared, ...silenceErrors } = s.silenceErrors;
      return { detectingSilences: { ...s.detectingSilences, [key]: true }, silenceErrors };
    });
    try {
      // One `invoke`, not a start/poll pair: the work is a Tauri command that
      // runs to completion in-process (there is no sidecar job id to poll).
      // The store IS the job record — which is the whole point of B-188/D-321,
      // because this promise outliving its caller's timeout is exactly the
      // case that used to throw the answer away.
      const detection = await invoke<SilenceDetection>('chroma_detect_silences', {
        path: args.path,
        startSecs: args.startSecs,
        durationSecs: args.durationSecs,
        minSilenceMs: args.minSilenceMs ?? null,
      });
      set((s) => ({ silences: { ...s.silences, [key]: detection } }));
      return detection;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ silenceErrors: { ...s.silenceErrors, [key]: message } }));
      throw e;
    } finally {
      set((s) => {
        const { [key]: _dropped, ...rest } = s.detectingSilences;
        return { detectingSilences: rest };
      });
    }
  },

  startSilenceDetection: (args, force = false) => {
    const key = silenceKey(args);
    const s = get();
    return startJob(!!s.detectingSilences[key], !!s.silences[key], s.silenceErrors[key], force, () =>
      get().detectSilences(args, force),
    );
  },

  silenceDetectionStatus: (key) => {
    const s = get();
    if (s.silences[key]) return { phase: 'done', result: s.silences[key] };
    if (s.detectingSilences[key]) return { phase: 'running' };
    if (s.silenceErrors[key]) return { phase: 'error', error: s.silenceErrors[key] };
    return { phase: 'idle' };
  },

  detectRetakes: async (args, force = false) => {
    const key = retakeKey(args);
    const cached = get().retakes[key];
    if (cached && !force) return cached;

    set((s) => {
      const { [key]: _cleared, ...retakeErrors } = s.retakeErrors;
      return { detectingRetakes: { ...s.detectingRetakes, [key]: true }, retakeErrors };
    });
    try {
      const detection = await invoke<RetakeDetection>('chroma_detect_retakes', {
        utterances: args.utterances,
        similarity: args.similarity ?? null,
        windowSecs: args.windowSecs ?? null,
        minWords: args.minWords ?? null,
        maxSpanUtterances: args.maxSpanUtterances ?? null,
        phraseMinWords: args.phraseMinWords ?? null,
      });
      set((s) => ({ retakes: { ...s.retakes, [key]: detection } }));
      return detection;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ retakeErrors: { ...s.retakeErrors, [key]: message } }));
      throw e;
    } finally {
      set((s) => {
        const { [key]: _dropped, ...rest } = s.detectingRetakes;
        return { detectingRetakes: rest };
      });
    }
  },

  startRetakeDetection: (args, force = false) => {
    const key = retakeKey(args);
    const s = get();
    return startJob(!!s.detectingRetakes[key], !!s.retakes[key], s.retakeErrors[key], force, () =>
      get().detectRetakes(args, force),
    );
  },

  retakeDetectionStatus: (key) => {
    const s = get();
    if (s.retakes[key]) return { phase: 'done', result: s.retakes[key] };
    if (s.detectingRetakes[key]) return { phase: 'running' };
    if (s.retakeErrors[key]) return { phase: 'error', error: s.retakeErrors[key] };
    return { phase: 'idle' };
  },

  detectDarkRegions: async (args, force = false) => {
    const key = darkKey(args);
    const cached = get().dark[key];
    if (cached && !force) return cached;

    set((s) => {
      const { [key]: _cleared, ...darkErrors } = s.darkErrors;
      return { detectingDark: { ...s.detectingDark, [key]: true }, darkErrors };
    });
    try {
      const detection = await invoke<DarkDetection>('chroma_detect_dark_regions', {
        path: args.path,
        startSecs: args.startSecs,
        durationSecs: args.durationSecs,
        words: args.words,
        minDarkSecs: args.minDarkSecs ?? null,
        maxWordSecs: args.maxWordSecs ?? null,
        rmsFloorScale: args.rmsFloorScale ?? null,
      });
      set((s) => ({ dark: { ...s.dark, [key]: detection } }));
      return detection;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ darkErrors: { ...s.darkErrors, [key]: message } }));
      throw e;
    } finally {
      set((s) => {
        const { [key]: _dropped, ...rest } = s.detectingDark;
        return { detectingDark: rest };
      });
    }
  },

  startDarkDetection: (args, force = false) => {
    const key = darkKey(args);
    const s = get();
    return startJob(!!s.detectingDark[key], !!s.dark[key], s.darkErrors[key], force, () =>
      get().detectDarkRegions(args, force),
    );
  },

  darkDetectionStatus: (key) => {
    const s = get();
    if (s.dark[key]) return { phase: 'done', result: s.dark[key] };
    if (s.detectingDark[key]) return { phase: 'running' };
    if (s.darkErrors[key]) return { phase: 'error', error: s.darkErrors[key] };
    return { phase: 'idle' };
  },

  recoverWindow: async (path, window, language, force = false) => {
    const key = recoveryKey(path, window);
    const cached = get().recoveries[key];
    if (cached && !force) return cached;

    set((s) => {
      const { [key]: _cleared, ...recoveryErrors } = s.recoveryErrors;
      return { recovering: { ...s.recovering, [key]: true }, recoveryErrors };
    });
    try {
      // Language pinned, not auto-detected — see the interface doc.
      const recovered = await transcribeWindow(path, window, language, 'recover');
      set((s) => ({ recoveries: { ...s.recoveries, [key]: recovered } }));
      return recovered;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ recoveryErrors: { ...s.recoveryErrors, [key]: message } }));
      throw e;
    } finally {
      set((s) => {
        const { [key]: _dropped, ...rest } = s.recovering;
        return { recovering: rest };
      });
    }
  },

  startRecovery: (path, window, language, force = false) => {
    const key = recoveryKey(path, window);
    const s = get();
    return startJob(!!s.recovering[key], !!s.recoveries[key], s.recoveryErrors[key], force, () =>
      get().recoverWindow(path, window, language, force),
    );
  },

  recoveryStatus: (key) => {
    const s = get();
    if (s.recoveries[key]) return { phase: 'done', result: s.recoveries[key] };
    if (s.recovering[key]) return { phase: 'running' };
    if (s.recoveryErrors[key]) return { phase: 'error', error: s.recoveryErrors[key] };
    return { phase: 'idle' };
  },

  recoveriesFor: (path) => recoveriesIn(get(), path),

  appliedRereadsFor: (path) => appliedRereadsIn(get(), path),

  startReread: (path, window, language, force = false) => {
    const key = recoveryKey(path, window);
    const s = get();
    return startJob(!!s.rereading[key], !!s.rereads[key], s.rereadErrors[key], force, async () => {
      set((st) => {
        const { [key]: _cleared, ...rereadErrors } = st.rereadErrors;
        return { rereading: { ...st.rereading, [key]: true }, rereadErrors };
      });
      try {
        const reread = await transcribeWindow(path, window, language, 'reread');
        set((st) => ({ rereads: { ...st.rereads, [key]: reread } }));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        set((st) => ({ rereadErrors: { ...st.rereadErrors, [key]: message } }));
        throw e;
      } finally {
        set((st) => {
          const { [key]: _dropped, ...rest } = st.rereading;
          return { rereading: rest };
        });
      }
    });
  },

  rereadStatus: (key) => {
    const s = get();
    if (s.rereads[key]) return { phase: 'done', result: s.rereads[key] };
    if (s.rereading[key]) return { phase: 'running' };
    if (s.rereadErrors[key]) return { phase: 'error', error: s.rereadErrors[key] };
    return { phase: 'idle' };
  },

  applyReread: (key) => {
    const reread = get().rereads[key];
    if (!reread) return false;
    set((s) => ({
      appliedRereads: { ...s.appliedRereads, [key]: { ...reread, seq: s.rereadSeq } },
      rereadSeq: s.rereadSeq + 1,
    }));
    return true;
  },

  setRetakeProposals: (track, proposals) => {
    set((s) => {
      const { [track]: _dropped, ...rest } = s.retakeProposals;
      return { retakeProposals: proposals ? { ...rest, [track]: proposals } : rest };
    });
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

  clearErrors: (path) => {
    if (path === undefined) {
      set({
        transcriptErrors: {},
        analysisErrors: {},
        silenceErrors: {},
        retakeErrors: {},
        darkErrors: {},
        recoveryErrors: {},
        rereadErrors: {},
      });
      return;
    }
    set((s) => {
      const { [path]: _t, ...transcriptErrors } = s.transcriptErrors;
      const { [path]: _a, ...analysisErrors } = s.analysisErrors;
      return {
        transcriptErrors,
        analysisErrors,
        rereadErrors: withoutPath(s.rereadErrors, path),
        // Detection and recovery keys are `<path>|…`, not the bare path.
        silenceErrors: withoutPath(s.silenceErrors, path),
        retakeErrors: withoutPath(s.retakeErrors, path),
        darkErrors: withoutPath(s.darkErrors, path),
        recoveryErrors: withoutPath(s.recoveryErrors, path),
      };
    });
  },

  clear: (path) => {
    if (path === undefined) {
      set({
        transcripts: {},
        analyses: {},
        transcriptErrors: {},
        analysisErrors: {},
        silences: {},
        silenceErrors: {},
        retakes: {},
        retakeErrors: {},
        dark: {},
        darkErrors: {},
        recoveries: {},
        recoveryErrors: {},
        rereads: {},
        rereadErrors: {},
        appliedRereads: {},
        retakeProposals: {},
      });
      return;
    }
    set((s) => {
      const { [path]: _t, ...transcripts } = s.transcripts;
      const { [path]: _a, ...analyses } = s.analyses;
      const { [path]: _te, ...transcriptErrors } = s.transcriptErrors;
      const { [path]: _ae, ...analysisErrors } = s.analysisErrors;
      // Detections are keyed by `<path>|<range>|<params>`, not by path alone,
      // so "forget this file" has to drop every key that file contributed —
      // otherwise a changed file keeps serving its old cut list.
      return {
        transcripts,
        analyses,
        transcriptErrors,
        analysisErrors,
        silences: withoutPath(s.silences, path),
        silenceErrors: withoutPath(s.silenceErrors, path),
        retakes: withoutPath(s.retakes, path),
        retakeErrors: withoutPath(s.retakeErrors, path),
        dark: withoutPath(s.dark, path),
        darkErrors: withoutPath(s.darkErrors, path),
        recoveries: withoutPath(s.recoveries, path),
        recoveryErrors: withoutPath(s.recoveryErrors, path),
        // A client's re-reads are facts about this file's audio too; a changed
        // file must not keep splicing its old words in.
        rereads: withoutPath(s.rereads, path),
        rereadErrors: withoutPath(s.rereadErrors, path),
        appliedRereads: withoutPath(s.appliedRereads, path),
      };
    });
  },
}));
