/**
 * `@apelles/editor` — drive the dark-region scan and its recovery, and hand back
 * the transcript a clip should actually be judged on (D-349, B-216).
 *
 * **What it is.** The one place that turns "this clip, this source range, this
 * cached transcript" into "the utterances to group, with the speech whisper
 * silently dropped put back." It is the *stateful* half of `darkRegions.ts`:
 * that module is pure maths over spans and segments, this one talks to
 * `mediaUnderstandingStore` — start the scan, start a recovery per window, read
 * the phases, splice when everything has landed.
 *
 * **Why it is its own module and not a helper inside either caller.** Both the
 * Recut panel and `useEditorControl`'s `editor_detect_retakes` need exactly this
 * sequence, and a copy in each is precisely the drift `CLAUDE.md` forbids: the
 * human's recut and the agent's would be reading two different transcripts of
 * the same file and reporting different retakes, which is the *shape* of the
 * failure B-216 is made of, one level up.
 *
 * **What it does NOT do.** No detection (the Rust crate), no transcription (the
 * sidecar), no timeline knowledge, no React, and nothing destructive. It reads
 * and writes one store's caches and returns plain data.
 *
 * **It never blocks.** The scan is a VAD pass and each recovery is a whole
 * Whisper pass over one window — far beyond `chroma::control`'s 20 s bridge and
 * beyond what a panel should freeze for. So this reports `pending` and the
 * caller comes back: an agent polls the `_status` tool it already polls, and the
 * panel re-runs on the store change it is already subscribed to.
 */

import {
  recoveryKey,
  useMediaUnderstandingStore,
  type Transcript,
  type TranscriptSegment,
} from './mediaUnderstandingStore';
import {
  darkKey,
  type DarkDetectionArgs,
} from './mediaUnderstandingStore';
import {
  recoveryWindows,
  spliceTranscript,
  type DarkDetection,
  type SplicedSegment,
} from './darkRegions';
import { clipSourceRangeSecs } from './recut';
import { mergeRunUtterances, type ClipRun } from './recutRuns';

/** One utterance as both retake callers hand it to the detector.
 *
 *  `recovered` is local bookkeeping, never sent to the detector — D-364's run
 *  merge counts recovered lines on the MERGED list (one line straddling two
 *  clips of a run is one line, not two), which needs the flag to travel with
 *  the utterance rather than as a per-clip total. `retakeArgsFor` strips it. */
export interface Utterance {
  start: number;
  end: number;
  text: string;
  recovered?: boolean;
}

/** A clip's transcript once dark regions have been accounted for. */
export interface ClipTranscriptView {
  /** The clip's own utterances, spliced, in time order. */
  utterances: Utterance[];
  /** How many of them exist only because the app went back for them. */
  recovered: number;
  /** What is still outstanding, or `null` when the view is complete. */
  pending: 'scanning' | 'recovering' | null;
  /** The scan, once there is one. Absent means no scan ran — which is NOT the
   *  same as a scan that found nothing, and callers must not report it as such. */
  detection?: DarkDetection;
  /** The scan or a recovery failed. The view still carries the RAW utterances:
   *  a failed recovery degrades to the pre-D-349 answer, never to no answer. */
  error?: string;
}

/**
 * The view for one clip's source range.
 *
 * `recover: false` short-circuits to the raw transcript — the exact pre-D-349
 * behaviour, byte for byte, which is what `recoverDarkRegions: false` and a
 * transcript without word timings both fall back to.
 *
 * `start: false` reads without kicking anything off, for a caller that is
 * polling rather than asking.
 */
export function clipTranscriptView(
  path: string,
  transcript: Transcript,
  rangeStartSecs: number,
  rangeSecs: number,
  recover: boolean,
  start: boolean,
  force = false,
): ClipTranscriptView {
  const rangeEnd = rangeStartSecs + rangeSecs;
  const inRange = (s: { start: number; end: number }) =>
    s.end > rangeStartSecs && s.start < rangeEnd;
  const toUtterances = (
    segments: ReadonlyArray<TranscriptSegment & { recovered?: boolean }>,
  ): Utterance[] =>
    segments
      .filter(inRange)
      .map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        ...(s.recovered ? { recovered: true as const } : {}),
      }));
  const raw = (extra: Partial<ClipTranscriptView> = {}): ClipTranscriptView => ({
    // "Raw" means without the D-349 scan, not without the client's applied
    // re-reads (D-380 step 2): those are part of the file's transcript for
    // every consumer, whether or not dark regions are being recovered.
    utterances: toUtterances(
      spliceTranscript(
        transcript.segments ?? [],
        useMediaUnderstandingStore.getState().appliedRereadsFor(path),
      ),
    ),
    recovered: 0,
    pending: null,
    ...extra,
  });

  if (!recover) return raw();

  // Coverage is a fact about WORDS. A transcript with no word timings cannot be
  // scanned, and simply not scanning is better than scanning against segment
  // bounds — which would call every inter-segment pause a hole.
  const words = (transcript.words ?? []).map((w) => ({ start: w.start, end: w.end }));
  if (words.length === 0) return raw();

  const store = useMediaUnderstandingStore.getState();
  const args: DarkDetectionArgs = {
    path,
    startSecs: rangeStartSecs,
    durationSecs: rangeSecs,
    words,
  };
  // **A previous failure is read BEFORE anything is started, and is not retried
  // on its own.** The store's own policy is that an error is never sticky — ask
  // again and it re-runs — which is right for a user clicking a button and
  // exactly wrong here: a broken VAD model would put every retake call into a
  // permanent `scanning`, and the caller would lose the retakes it asked for
  // rather than get the pre-D-349 answer. So a failed scan degrades, with its
  // reason, and `force` is what retries it.
  const key = darkKey(args);
  let scan = store.darkDetectionStatus(key);
  if (scan.phase === 'error' && !force) return raw({ error: scan.error });
  if (start && scan.phase !== 'running' && (scan.phase === 'idle' || force)) {
    store.startDarkDetection(args, force);
    scan = store.darkDetectionStatus(key);
  }
  if (scan.phase === 'error') return raw({ error: scan.error });
  if (scan.phase !== 'done' || !scan.result) return raw({ pending: 'scanning' });

  const windows = recoveryWindows(scan.result.regions, rangeStartSecs, rangeSecs);
  let outstanding = false;
  let failure: string | undefined;
  for (const w of windows) {
    const rkey = recoveryKey(path, w);
    let status = store.recoveryStatus(rkey);
    // Same rule one step later, for the same reason: a window that failed to
    // re-read leaves the rest of the splice to proceed rather than blocking.
    if (status.phase === 'error' && !force) {
      failure = status.error;
      continue;
    }
    if (start && status.phase !== 'running' && (status.phase === 'idle' || force)) {
      // The language is PINNED to the whole-file pass's own detection, never
      // auto-detected per window: 989 s of audio is far better evidence than a
      // 12 s extract, and auto-detection on short windows was measured
      // returning an entirely different script for 2 of 10 real ones — the same
      // windows read correctly once the language was pinned.
      store.startRecovery(path, w, transcript.language, force);
      status = store.recoveryStatus(rkey);
    }
    if (status.phase === 'error') failure = status.error;
    else if (status.phase !== 'done') outstanding = true;
  }
  if (outstanding) return raw({ pending: 'recovering', detection: scan.result });

  // Splice EVERY recovery held for this file, not only this clip's own windows:
  // a transcript is a fact about a FILE, and two clips cut from one source must
  // not read different versions of the same sentence.
  const spliced: SplicedSegment[] = spliceTranscript(
    transcript.segments ?? [],
    store.recoveriesFor(path),
  );
  return {
    utterances: toUtterances(spliced),
    recovered: spliced.filter((s) => s.recovered && inRange(s)).length,
    pending: null,
    detection: scan.result,
    error: failure,
  };
}

/**
 * The view for a whole RUN of clips cut from one continuous stretch of one
 * source (D-364, fixes B-237).
 *
 * **What it adds over [`clipTranscriptView`], and what it deliberately does
 * not.** It calls that function once per clip, unchanged — the same ranges, the
 * same dark-scan cache keys, the same recovery windows, so D-349 got neither
 * wider nor more expensive. The only thing that is new is the *merge*: the
 * clips' utterance lists are folded into one list, deduped, in time order. That
 * merged list is what the detector is handed, and it is the first time both
 * halves of a restart split across two clips are ever in the same input.
 *
 * **Only what the timeline still shows.** Because the merge is over the clips'
 * own filtered views, the stretches between them — material an earlier cut
 * removed — contribute nothing. The pre-B-237 invariant ("must not report
 * retakes from material nobody will ever see") holds at run granularity.
 *
 * Lives here, next to the per-clip view, because the Recut panel and
 * `editor_detect_retakes` both need exactly this and a copy in each is the
 * drift this module's own header exists to prevent.
 */
export interface RunTranscriptView {
  run: ClipRun;
  /** One entry per clip of the run, in run order — what D-349 found in each. */
  views: ClipTranscriptView[];
  /** The merged, deduped, time-ordered list the detector is handed. */
  utterances: Utterance[];
  /** How many of `utterances` exist only because the app went back for them.
   *  Counted on the MERGED list: a recovered line straddling two clips of the
   *  run is one line, not two. */
  recovered: number;
  /** Any clip of the run still waiting on words. A run cannot be grouped until
   *  all of them are in — a half-present run is exactly the partial view B-237
   *  is about. */
  pending: 'scanning' | 'recovering' | null;
}

export function runTranscriptView(
  run: ClipRun,
  transcript: Transcript,
  recover: boolean,
  start: boolean,
  force: boolean,
  fps: number,
): RunTranscriptView {
  const views = run.targets.map((t) => {
    const range = clipSourceRangeSecs(t.c, fps);
    return clipTranscriptView(
      t.source,
      transcript,
      range.startSecs,
      range.durationSecs,
      recover,
      start,
      force,
    );
  });
  // `scanning` wins over `recovering` in the note: it is the earlier step, and
  // it is the one that decides whether a recovery is needed at all.
  const pending: RunTranscriptView['pending'] = views.some((v) => v.pending === 'scanning')
    ? 'scanning'
    : views.some((v) => v.pending === 'recovering')
      ? 'recovering'
      : null;
  const utterances = mergeRunUtterances(views.map((v) => v.utterances));
  return {
    run,
    views,
    utterances,
    recovered: utterances.filter((u) => u.recovered).length,
    pending,
  };
}
