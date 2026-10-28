/**
 * @apelles/editor — the Edit tab's RECUT library (D-318).
 *
 * **What it is.** The human half of silence + retake detection: pick what to
 * scan, run a detector, see what it found, tick the ones you agree with, cut
 * them. The GUI counterpart of `editor_detect_silences` /
 * `editor_detect_retakes` / `editor_ripple_delete_ranges`, and deliberately
 * not a re-implementation of any of them — both interfaces call the same two
 * Tauri commands, convert through the same `recut.ts` helpers, decide what is
 * scannable with the same `recutSweep.ts` `sweepTargets`, and cut with the
 * same `ripple_delete_ranges` store op. One detector, one rounding rule, one
 * undo entry, whichever asked (CLAUDE.md: every feature is built for a human
 * AND an AI).
 *
 * **Scope: this clip, or the whole track (D-342, fixes B-216).** The panel used
 * to say "Select **one** clip" and mean it, which is the human half of the same
 * hole the MCP tools had: on a 75-clip timeline a cleanup pass covers the clip
 * you are looking at and never re-sweeps the rest, and real retakes survive to
 * a final cut that way. The two detector buttons now run over either the
 * selected clip or every analysable clip on its track, chosen on one control —
 * not a second pair of buttons, for the same reason the MCP side made `clip`
 * optional on the existing tools instead of adding `*_all` twins. With nothing
 * selected and exactly one video track there is no ambiguity about WHICH
 * track, so the panel offers the sweep rather than refusing.
 *
 * **Nothing is cut until you say so, and that is the whole design.** Detection
 * only ever *proposes*. Every candidate arrives unticked; the Cut button is
 * disabled until at least one is ticked and names exactly how many ranges it
 * will remove. A retake group's suggested keep (the last take) is pre-excluded
 * from the cut rather than pre-ticked for deletion, because the failure modes
 * are not symmetric — a missed cut is a second's work to fix, and a take
 * deleted by a checkbox nobody read is gone behind an undo the user has to
 * think to press.
 *
 * **It reads the speech the ASR silently dropped, too (D-349, B-216).** Before
 * grouping, a retake run scans each clip's range for stretches where the VAD
 * hears a voice and the transcript has no words, re-transcribes those windows on
 * their own, and splices the result in. That is not a bonus feature bolted on
 * here: the dropped speech is *biased towards near-duplicate repeats*, i.e.
 * towards exactly the retakes this button exists to find, so grouping the raw
 * transcript is blind in the one place it is looking. The panel says so when it
 * happens — a recovered line appearing in a list is only trustworthy if the
 * panel admits where it came from — and `clipTranscriptView` is literally the
 * same function `editor_detect_retakes` runs, so the two cannot drift.
 *
 * **It also reviews the MCP client's retake proposals (D-380 step 2).** The
 * groups an MCP client submits through `editor_propose_retakes` land in the
 * store's `retakeProposals` slice and join this same list — one row per take,
 * unticked, with the coverage gate's status: verified, AI-confirmed (the
 * client vouched for words the gate could not account for; its reasons shown,
 * those words marked) or refused (reason shown, not tickable until a person
 * who has listened unlocks it). "Tick all suggested" never ticks the last two,
 * a banner locks the rows when the timeline moves after the client read it,
 * and the same Cut applies them. No model runs here or anywhere in the app.
 *
 * **The detector's own groups go through the same gate (D-382).** After
 * `chroma_detect_retakes` answers, each group is mapped onto the track's words
 * and checked (`detectorGate.ts`); a refused detector row is treated exactly
 * like a refused client row. The detector itself is unchanged.
 *
 * **What it does NOT do.** It does not transcribe (it asks
 * `mediaUnderstandingStore` for a cached transcript and reports honestly when
 * one is still running), it owns no timeline state, and it does not paint
 * anything on the timeline — the candidates live in this panel until they are
 * applied or discarded. Highlighting pending cuts on the timeline itself is a
 * real follow-up and deliberately not smuggled in here.
 *
 * **Tier note for its tests.** `RecutPanel.dom.test.tsx` mounts this with a
 * real store and stubbed `invoke`, and drives real clicks — it proves the
 * handlers, the candidate list and the op that comes out. It does not prove the
 * VAD is right; that is the Rust crate's own 33 tests and its live model check.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  LockOpenIcon,
  ProhibitIcon,
  RepeatIcon,
  RobotIcon,
  ScissorsIcon,
  SealCheckIcon,
  SpinnerIcon,
  WarningIcon,
  WaveformIcon,
} from '@phosphor-icons/react';
import { Button } from '@apelles/ui';

import {
  DEFAULT_MIN_SILENCE_MS,
  clipSourceRangeSecs,
  groupTakes,
  spanToFrames,
  type DetectedSpan,
} from './recut';
import { sweepTargets } from './recutSweep';
// D-364/B-237 — the clips a fine-grained silence cut chopped out of one
// continuous take are put back together before the grouper reads them, so a
// restart whose halves landed in two clips is visible here too, not only to
// the MCP tool. The panel and `editor_detect_retakes` share this layer for the
// same reason they share `clipTranscriptView`: they must not disagree.
import { clipRuns, takeSegments, type ClipRun } from './recutRuns';
import { applyRippleDeleteRanges, timelineFps, type Clip } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import {
  recoveriesIn,
  retakeKey,
  silenceKey,
  useMediaUnderstandingStore,
  type RetakeDetectionArgs,
  type SilenceDetectionArgs,
} from './mediaUnderstandingStore';
// D-349/B-216 — the shared step that scans for speech the ASR silently dropped,
// re-reads those windows and splices the words back in. The SAME function
// `editor_detect_retakes` runs, so the human's recut and the agent's cannot end
// up grouping two different transcripts of one file.
import { clipTranscriptView, runTranscriptView } from './darkRecovery';
// D-380 step 2 — the MCP client's retake proposals, gated, from the store
// `editor_propose_retakes` writes. Reviewed in this same list, cut by the
// same Cut button.
import { buildWordViewInput, viewBasisKey } from './retakeWordView';
// B-289 / D-420 — silence rows stop short of every transcribed word.
import { transcriptWordSpans, wordAwareSilences } from './silenceWords';
// D-382 — the detector's own groups through the same gate.
import { detectedForGate, gateDetectorGroups, type DetectorGateResult } from './detectorGate';
import type { ProposalStatus, ProposalWord, RetakeProposalSet } from './retakeProposals';

/** One row the user can tick. A silence is its own candidate; a retake group
 *  contributes one candidate per take, with the suggested keep marked so the
 *  list can say so and leave it alone. */
interface Candidate {
  id: string;
  kind: 'silence' | 'retake';
  /** Where the row starts, for sorting and for the timestamp column. */
  span: DetectedSpan;
  /** Every range this row would cut, one per clip it lands in (D-364). A
   *  silence, and a retake take that lives inside one clip, has exactly one —
   *  which is every row this panel showed before B-237. A take spanning clips a
   *  silence cut split apart has several, and cutting only the first would
   *  leave the other halves on the timeline. */
  spans: DetectedSpan[];
  /** Which clip on the scanned track this came from — the first one, when the
   *  row spans several. Always present: a whole-track scan needs it to label
   *  the row, and a single-clip scan gets it for free. */
  clip: number;
  clipName: string;
  /** How many clips the row spans, when that is more than one (D-364). Shown
   *  so a human can see the cut reaches past the clip the row is labelled
   *  with. */
  clipSpan?: number;
  /** Present for retakes: the words, so a human can see what they are cutting. */
  text?: string;
  /** Retakes only: this take is the group's suggested keeper. */
  suggestedKeep?: boolean;
  /** Retakes only: which group it belongs to, for the "Take 2 of 3" label. */
  groupIndex?: number;
  takeIndex?: number;
  takeCount?: number;
  /** Which group the row belongs to, unique across detector and client rows
   *  — what a listener's unlock is keyed by. */
  groupKey?: string;
  /** D-380 step 2 — who proposed the row. Absent means the detector. */
  source?: 'detector' | 'client';
  /** Client rows: the coverage gate's status for the row's group. */
  status?: ProposalStatus;
  /** Client rows: the client's own one-line description of the group. */
  line?: string;
  /** Client rows: the take's words, so the ones a cut would lose can be
   *  marked inside the text rather than listed apart from it. */
  words?: ProposalWord[];
  /** Client rows: words to mark (the gate's offending words, or the ones the
   *  AI vouched for), each with the AI's reason when it gave one. */
  flagged?: Record<number, string>;
  /** Client rows: the group's offending words themselves. They can sit in a
   *  sibling take, not this row's `words`, so the reasons are labelled from
   *  here (B-251) rather than looked up in the row's own text. */
  offending?: ProposalWord[];
  /** Refused client rows: why. */
  reasonText?: string;
  /** Refused client rows: a human who has listened may unlock the group. */
  unlockable?: boolean;
}

/** Client rows for one track's proposals: one row per take, like the
 *  detector's, carrying the group's status and the words to mark. A take whose
 *  words land on no frame (outside every clip) has nothing to show. */
function clientRows(set: RetakeProposalSet, nameOf: (clip: number) => string): Candidate[] {
  const rows: Candidate[] = [];
  for (const g of set.groups) {
    const flagged: Record<number, string> = {};
    for (const w of g.offending) flagged[w.index] = g.justifications[w.index] ?? '';
    g.takes.forEach((t, ti) => {
      const shown = t.extent[0];
      if (!shown) return;
      rows.push({
        id: `cli-${set.track}-${g.group}-${ti}`,
        kind: 'retake',
        source: 'client',
        status: g.status,
        span: shown.span,
        spans: t.segments.map((s) => s.span),
        clip: shown.clip,
        clipName: nameOf(shown.clip),
        ...(t.extent.length > 1 ? { clipSpan: t.extent.length } : {}),
        text: t.text,
        words: t.words,
        flagged: t.keep ? {} : flagged,
        offending: g.offending,
        suggestedKeep: t.keep,
        groupIndex: g.group,
        groupKey: `cli-${set.track}-${g.group}`,
        takeIndex: ti,
        takeCount: g.takes.length,
        ...(g.line ? { line: g.line } : {}),
        ...(g.reasonText ? { reasonText: g.reasonText } : {}),
        unlockable: g.unlockable,
      });
    });
  }
  return rows;
}

/** `mm:ss.s` — short enough for a narrow column, precise enough to find. */
function stamp(secs: number): string {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** A detection this panel is waiting on (B-188/D-321).
 *
 *  The panel used to `await invoke(...)` directly, which meant a detection that
 *  ran long left the user staring at a spinner with no way to get the answer
 *  back if anything interrupted it, and a retake run that needed a transcript
 *  simply gave up with "try again when it finishes." Both now go through
 *  `mediaUnderstandingStore`, so the work outlives this component's render and
 *  its result is *looked up*, not awaited.
 *
 *  `key` is `null` for a retake whose transcript has not landed yet — there is
 *  nothing to key a detection on until there are words. */
interface PendingClip {
  /** The clip's index on the scanned track — what a cut is addressed by. */
  index: number;
  /** The clip AS IT WAS when the run started: the detection describes that
   *  exact source range, so the frames must be derived from that snapshot and
   *  not from whatever is selected by the time the answer arrives. */
  clip: Clip;
  source: string;
  startSecs: number;
  durationSecs: number;
  key: string | null;
  /** Retakes only (D-364/B-237): the continuous take this unit covers. One
   *  detection runs per RUN, not per clip, so `index`/`clip` name the run's
   *  first clip and this carries the rest. A silence scan has no run — silence
   *  is a fact about one clip's own audio and never spanned anything. */
  run?: ClipRun;
  /** Set when this one unit failed (a transcript that errored) — the rest of
   *  the scan carries on, which is the point of a whole-track scan. */
  failure?: string;
  /** D-349 — how many of this clip's utterances came back only because the app
   *  re-read a stretch the ASR silently dropped. Carried on the pending record
   *  so the finished list can say so; `undefined` until the words have landed. */
  recovered?: number;
  /** D-387 — the located regions no re-read could put words to (source
   *  seconds). Carried so the finished list can say where the transcript is
   *  still blind instead of implying it is complete. */
  unread?: Array<{ start: number; end: number }>;
}

/** One run of one detector, over one clip or over a whole track (D-342).
 *
 *  A whole-track scan is N detections, not one — but it is ONE run from the
 *  user's point of view, so it lives in one pending record with one spinner
 *  and produces one candidate list. The per-clip snapshots are what let a
 *  result arriving late still be converted against the clip it described. */
interface PendingJob {
  kind: 'silence' | 'retake';
  track: number;
  fps: number;
  minSilenceMs: number;
  clips: PendingClip[];
}

export function RecutPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);

  const [pending, setPending] = useState<PendingJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [minSilenceMs, setMinSilenceMs] = useState(DEFAULT_MIN_SILENCE_MS);
  /** D-342 — what the next run covers. Defaults to the selected clip: a scan
   *  is cheap but not free, and "the thing I am looking at" is what a click on
   *  a selected clip means. `track` is one click away and is what a cleanup
   *  pass wants. */
  const [scope, setScope] = useState<'clip' | 'track'>('clip');
  /** The track the CURRENT candidate list came from, kept separately from the
   *  selection: a cut must go to the track that was scanned, not to whatever
   *  the user clicked on while reading the results. */
  const [resultTrack, setResultTrack] = useState<number | null>(null);
  /** D-380 step 2 — refused client groups a human has unlocked after
   *  listening, by group index. Cleared whenever the proposals change. */
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({});

  // Subscribed as whole maps rather than through a key-dependent selector: the
  // key only exists once a run has started, and a map's identity changes
  // exactly when one of its entries does, so this re-renders precisely when
  // there is something new to look up.
  const silences = useMediaUnderstandingStore((s) => s.silences);
  const silenceErrors = useMediaUnderstandingStore((s) => s.silenceErrors);
  const retakes = useMediaUnderstandingStore((s) => s.retakes);
  const retakeErrors = useMediaUnderstandingStore((s) => s.retakeErrors);
  const transcripts = useMediaUnderstandingStore((s) => s.transcripts);
  const transcriptErrors = useMediaUnderstandingStore((s) => s.transcriptErrors);
  // D-349 — the dark-region scan and its recoveries. Subscribed for the same
  // reason as the maps above: the retake effect below has to re-run when a scan
  // lands and again when the last re-read does.
  const dark = useMediaUnderstandingStore((s) => s.dark);
  const recoveries = useMediaUnderstandingStore((s) => s.recoveries);

  const busy = pending ? pending.kind : null;

  // Phase-1 multi-select fallback, the same one every single-clip consumer in
  // this package uses (docs/notes/multi-select.md).
  const primary = selection.length === 1 ? selection[0] : null;
  const selectedClip =
    primary && timeline
      ? timeline.tracks[primary.track]?.clips.find((c) => c.id === primary.id)
      : undefined;
  const analysable = Boolean(selectedClip?.source_path);

  /** The one video track a whole-track scan would run over when nothing is
   *  selected. `null` when that is genuinely ambiguous (two or more video
   *  tracks), which is the only case still worth asking the user to pick. */
  const loneVideoTrack = useMemo(() => {
    if (!timeline) return null;
    const video = timeline.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.kind === 'video');
    return video.length === 1 ? video[0].i : null;
  }, [timeline]);

  /** Which track the next run covers, and in which scope. `scope` is only
   *  honoured when there is a selected clip to honour it with — with nothing
   *  selected the only thing a scan CAN mean is the whole track. */
  const effectiveScope: 'clip' | 'track' = primary && analysable ? scope : 'track';
  const track = primary ? primary.track : loneVideoTrack;
  const canScan =
    timeline !== null &&
    track !== null &&
    (effectiveScope === 'track' ? true : analysable);

  // ---- D-380 step 2: the MCP client's proposals -------------------------
  // They belong to a track; the panel shows the ones for the track its
  // detector results are on, or else the track a scan would cover.
  const retakeProposals = useMediaUnderstandingStore((s) => s.retakeProposals);
  const appliedRereads = useMediaUnderstandingStore((s) => s.appliedRereads);
  const displayTrack = resultTrack ?? track;
  const clientSet = displayTrack !== null ? retakeProposals[displayTrack] : undefined;

  /** Has the track moved away from the view the AI judged? The same inputs
   *  the view id is built from (`viewBasisKey`), recomputed here so the human
   *  is told BEFORE ticking rows whose frames now point at other material. */
  const clientStale = useMemo(() => {
    if (!clientSet || !timeline) return false;
    const maps = { recoveries, appliedRereads };
    const input = buildWordViewInput(
      timeline,
      clientSet.track,
      transcripts,
      (path) => recoveriesIn(maps, path),
      transcriptErrors,
    );
    return 'error' in input || viewBasisKey(input) !== clientSet.basisKey;
  }, [clientSet, timeline, transcripts, transcriptErrors, recoveries, appliedRereads]);

  const clientCandidates = useMemo(() => {
    if (!clientSet) return [];
    const clips = timeline?.tracks[clientSet.track]?.clips ?? [];
    return clientRows(clientSet, (i) => clips[i]?.name ?? `clip ${i}`);
  }, [clientSet, timeline]);

  // A new submission is a new set of groups: an unlock given to the old
  // group 3 must not carry over to whatever is group 3 now.
  useEffect(() => {
    setUnlocked({});
  }, [clientSet]);

  /** Every row in the list, read along the timeline. */
  const rows = useMemo(
    () => [...candidates, ...clientCandidates].sort((a, b) => a.span.startFrame - b.span.startFrame),
    [candidates, clientCandidates],
  );

  /** Can this row be ticked at all? A silence always; a retake the gate
   *  refused (a client's or, since D-382, the detector's) only once a person
   *  who listened unlocks it; a client row not while its view is stale. */
  const tickable = (c: Candidate): boolean => {
    if (c.source === 'client' && (clientStale || c.spans.length === 0)) return false;
    if (c.status === 'refused') return Boolean(unlocked[c.groupKey ?? '']);
    return true;
  };

  const reset = () => {
    setCandidates([]);
    setTicked({});
    setError(null);
    setNotice(null);
    setPending(null);
    setResultTrack(null);
  };

  /** The bit both buttons share: work out which clips this run covers and
   *  snapshot each one's source range.
   *
   *  `sweepTargets` is the SAME function the `editor_detect_*` sweep uses to
   *  decide what is analysable, so the panel and the agent can never disagree
   *  about which clips a whole-track scan covered. */
  const beginJob = (kind: PendingJob['kind']): PendingJob | null => {
    if (!timeline || track === null) return null;
    const tr = timeline.tracks[track];
    if (!tr) return null;
    const fps = timelineFps(timeline);

    const all = sweepTargets(tr).targets;
    const chosen =
      effectiveScope === 'clip' ? all.filter((t) => t.c.id === primary?.id) : all;
    if (chosen.length === 0) return null;

    if (kind === 'silence') {
      return {
        kind,
        track,
        fps,
        minSilenceMs,
        clips: chosen.map((t) => {
          const range = clipSourceRangeSecs(t.c, fps);
          return {
            index: t.clip,
            clip: t.c,
            source: t.source,
            startSecs: range.startSecs,
            durationSecs: range.durationSecs,
            key: null,
          };
        }),
      };
    }

    // D-364/B-237 — a retake unit is a RUN. Reviewing ONE clip still widens to
    // the run that clip belongs to (built from the whole track, not from the
    // selection), because a stumble the user can see in this clip is usually
    // only half inside it, and half a restart cannot be grouped with anything.
    const runs = clipRuns(all, fps).filter((r) =>
      chosen.some((t) => r.targets.some((rt) => rt.clip === t.clip)),
    );
    return {
      kind,
      track,
      fps,
      minSilenceMs,
      clips: runs.map((run) => ({
        index: run.targets[0].clip,
        clip: run.targets[0].c,
        source: run.source,
        startSecs: run.startSecs,
        durationSecs: run.durationSecs,
        key: null,
        run,
      })),
    };
  };

  const findSilences = () => {
    reset();
    const job = beginJob('silence');
    if (!job) return;
    const store = useMediaUnderstandingStore.getState();
    const clips = job.clips.map((c) => {
      const args: SilenceDetectionArgs = {
        path: c.source,
        startSecs: c.startSecs,
        durationSecs: c.durationSecs,
        minSilenceMs: job.minSilenceMs,
      };
      // `force` so the button always means "run it again", the way a human
      // expects a button to. The cache is there for the agent's repeated tool
      // calls, not to make a click do nothing.
      store.startSilenceDetection(args, true);
      return { ...c, key: silenceKey(args) };
    });
    setPending({ ...job, clips });
  };

  const findRetakes = () => {
    reset();
    const job = beginJob('retake');
    if (!job) return;
    const store = useMediaUnderstandingStore.getState();

    // One transcript per SOURCE FILE, never one per clip — a whole-track scan
    // of fifty clips cut from one recording costs one transcription. Same rule
    // the `editor_detect_retakes` sweep follows (D-342) and the Transcript
    // panel before it (D-329).
    let waiting = 0;
    for (const source of new Set(job.clips.map((c) => c.source))) {
      // A click means "run it again", and that has to include retrying whatever
      // failed last time — the D-349 scan and its re-reads do not auto-retry a
      // failure (they degrade to the raw transcript instead, so a broken model
      // cannot spin forever). Errors only, never results: `clear(source)` would
      // throw away the transcript and cost a fresh multi-minute transcription pass.
      store.clearErrors(source);
      const status = store.transcriptStatus(source);
      if (status.phase === 'done') continue;
      if (status.phase !== 'error') {
        // Kick the transcript and WAIT for it here — the effect below picks the
        // run back up the moment the words land. Before D-321 this told the user
        // to come back and click again, which is a poll implemented by a human.
        store.startTranscript(source, { wordTimestamps: true });
      }
      waiting += 1;
    }
    if (waiting > 0) {
      setNotice(
        waiting === 1
          ? 'Transcribing first — retakes need the words. This keeps running.'
          : `Transcribing ${waiting} source files first — retakes need the words. This keeps running.`,
      );
    }
    setPending(job);
  };

  /** A retake run whose transcripts are landing: turn each file's words into a
   *  detection as it arrives. Runs again on every transcript-map change until
   *  every clip has a key or a failure of its own. */
  useEffect(() => {
    if (!pending || pending.kind !== 'retake') return;
    if (pending.clips.every((c) => c.key !== null || c.failure)) return;

    let changed = false;
    let pendingRecovery = false;
    const store = useMediaUnderstandingStore.getState();
    const clips = pending.clips.map((c) => {
      if (c.key !== null || c.failure) return c;
      const failure = transcriptErrors[c.source];
      if (failure) {
        changed = true;
        return { ...c, failure };
      }
      const transcript = transcripts[c.source];
      if (!transcript) return c;

      // D-349 — scan for the speech the ASR silently dropped, re-read it, and
      // splice it in BEFORE grouping. Not an optional extra: the dropped speech
      // is biased towards near-duplicate repeats, i.e. towards exactly the
      // retakes this button is looking for (B-216). The view reports `pending`
      // while a scan or a re-read is in flight, and this effect runs again on
      // the store change that resolves it.
      // **`force` is deliberately NOT passed here**, unlike `findSilences`'
      // `startSilenceDetection(args, true)`. This runs inside an effect that
      // re-fires on every `dark`/`recoveries` change, and forcing would restart
      // the scan on each pass and never settle. "Run it again" is expressed
      // instead by `findRetakes` clearing this file's failures once per click,
      // which is the part of `force` a human actually wants.
      // D-364/B-237 — one merged view over the whole run, not one per clip.
      // The per-clip D-349 scan and splice inside it are unchanged; only the
      // grouping input is merged, which is what lets a restart split across
      // two clips be compared with itself at all.
      const view = runTranscriptView(c.run as ClipRun, transcript, true, true, false, pending.fps);
      if (view.pending) {
        if (view.pending === 'recovering') pendingRecovery = true;
        return c;
      }

      const args: RetakeDetectionArgs = {
        path: c.source,
        startSecs: c.startSecs,
        durationSecs: c.durationSecs,
        // The `recovered` flag is local bookkeeping and does not cross the wire.
        utterances: view.utterances.map((u) => ({ start: u.start, end: u.end, text: u.text })),
        recovered: view.recovered,
      };
      store.startRetakeDetection(args, true);
      changed = true;
      return {
        ...c,
        key: retakeKey(args),
        recovered: view.recovered,
        unread: view.unread.map((r) => ({ start: r.start_secs, end: r.end_secs })),
      };
    });

    if (pendingRecovery) {
      setNotice(
        'Found speech the transcription skipped — re-reading it before grouping. This keeps running.',
      );
    }
    if (!changed) return;
    if (clips.some((c) => c.key !== null)) setNotice(null);
    setPending({ ...pending, clips });
  }, [pending, transcripts, transcriptErrors, dark, recoveries]);

  /** Every started detection has reached a terminal state: build the rows.
   *
   *  Deliberately all-or-nothing rather than streaming partial results in: a
   *  half-filled list invites a human to tick and cut from it, and cutting
   *  shifts every frame number the rest of the run is still computing
   *  against. */
  useEffect(() => {
    if (!pending) return;
    const errors = pending.kind === 'silence' ? silenceErrors : retakeErrors;
    const results: Record<string, { silences?: unknown; groups?: unknown }> =
      pending.kind === 'silence' ? silences : retakes;

    const settled = pending.clips.every(
      (c) => c.failure || (c.key !== null && (results[c.key] || errors[c.key])),
    );
    if (!settled) return;

    /** D-382 — build the list once the detector's groups have been through
     *  the coverage gate (retakes only; a silence has no words to check). */
    const finish = (gates: Readonly<Record<string, DetectorGateResult[]>>) => {
      const { fps } = pending;
      const rows: Candidate[] = [];
      const failures: string[] = [];
      let wordAwareRuns = 0;

      for (const c of pending.clips) {
        if (c.failure) {
          failures.push(c.failure);
          continue;
        }
        const key = c.key as string;
        const failure = errors[key];
        if (failure) {
          failures.push(failure);
          continue;
        }

        if (pending.kind === 'silence') {
          const found = silences[key];
          // B-289 / D-420 — the same word-aware rule `editor_detect_silences`
          // applies, so a row offered for cutting never clips a word when the
          // source has a transcript (the panel and the tool cannot disagree).
          const words = transcriptWordSpans(
            transcripts[c.source],
            recoveriesIn({ recoveries, appliedRereads }, c.source),
          );
          if (words) wordAwareRuns += 1;
          const ranges = words
            ? wordAwareSilences(found.silences, words, pending.minSilenceMs / 1000).silences
            : found.silences;
          ranges.forEach((s, i) => {
            const span = spanToFrames(c.clip, s.start_secs, s.end_secs, fps);
            if (span.endFrame <= span.startFrame) return;
            rows.push({
              id: `sil-${c.index}-${i}`,
              kind: 'silence',
              span,
              spans: [span],
              clip: c.index,
              clipName: c.clip.name,
            });
          });
          continue;
        }

        // One row per TAKE, not per member: since D-327 a delivery can span
        // several utterances, and a row per member would offer half a delivery
        // for cutting while marking the other half as the keeper.
        retakes[key].groups.forEach((g, gi) => {
          const takes = groupTakes(g);
          const gate = gates[key]?.[gi];
          const flagged: Record<number, string> = {};
          for (const w of gate?.offending ?? []) flagged[w.index] = '';
          takes.forEach((t) => {
            // D-364/B-237 — a take can land in several clips of the run, and one
            // row has to carry every one of those ranges or the cut leaves the
            // other halves behind. `spans[0]` is where the row sorts and reads.
            const segments = takeSegments(c.run as ClipRun, t.startSecs, t.endSecs, fps);
            if (segments.length === 0) return;
            const spans = segments.map((seg) => seg.span);
            rows.push({
              id: `ret-${c.index}-${gi}-${t.index}`,
              kind: 'retake',
              span: spans[0],
              spans,
              clip: segments[0].clip,
              clipName:
                (c.run as ClipRun).targets.find((rt) => rt.clip === segments[0].clip)?.c.name ??
                c.clip.name,
              ...(segments.length > 1 ? { clipSpan: segments.length } : {}),
              text: t.text,
              suggestedKeep: t.suggestedKeep,
              groupIndex: gi,
              groupKey: `ret-${c.index}-${gi}`,
              takeIndex: t.index,
              takeCount: takes.length,
              ...(gate
                ? {
                    source: 'detector' as const,
                    status: gate.status,
                    ...(gate.takeWords[t.index]?.length ? { words: gate.takeWords[t.index] } : {}),
                    flagged: t.suggestedKeep ? {} : flagged,
                    offending: gate.offending,
                    ...(gate.reasonText ? { reasonText: gate.reasonText } : {}),
                    unlockable: gate.unlockable,
                  }
                : {}),
            });
          });
        });
      }

      // A whole run that failed is an error; a run where SOME clips failed still
      // has real answers in it, and burying them behind one red box would be the
      // same "you only looked at part of it" failure this scan exists to fix.
      if (failures.length === pending.clips.length) {
        setError(failures[0] ?? 'detection failed');
        setPending(null);
        return;
      }

      // Sorted by where the cut lands, not by which clip answered first — the
      // list reads along the timeline, which is how a human reviews it.
      rows.sort((a, b) => a.span.startFrame - b.span.startFrame);
      setCandidates(rows);
      setResultTrack(pending.track);

      // Counted in CLIPS, not in units: since D-364 a retake unit is a whole run
      // of clips, and "1 clip on this track" for a run of twenty would be a lie.
      const clipsIn = (c: PendingClip) => c.run?.targets.length ?? 1;
      const scannedUnits = pending.clips.filter((c) => !c.failure);
      const scanned = scannedUnits.reduce((n, c) => n + clipsIn(c), 0);
      const where = scanned === 1 ? 'this clip' : `${scanned} clips on this track`;
      // D-349 — say it out loud whenever the grouping read words the transcript
      // did not originally contain. A human reading this list is entitled to know
      // that, and a line of text is cheaper than being blindsided by a take
      // appearing that was invisible five minutes ago.
      const recovered = pending.clips.reduce((n, c) => n + (c.recovered ?? 0), 0);
      const recoveredNote =
        recovered > 0
          ? ` Recovered ${recovered} line${recovered === 1 ? '' : 's'} the transcription had silently skipped, and grouped those too.`
          : '';
      // D-387 — and say where it is STILL blind. A region the VAD hears and no
      // re-read could put words to is not an error, but a list that stays quiet
      // about it reads as a complete transcript, and a cut across it is a cut
      // nobody judged.
      const unread = pending.clips.flatMap((c) => c.unread ?? []);
      const unreadNote =
        unread.length > 0
          ? ` ${unread.length} stretch${unread.length === 1 ? '' : 'es'} of speech-like sound could not be read by any pass (source ${unread
              .slice(0, 3)
              .map((r) => `${stamp(r.start)}–${stamp(r.end)}`)
              .join(', ')}${unread.length > 3 ? ', …' : ''}) — listen there before cutting.`
          : '';
      // B-289 / D-420 — a silence list built without words can clip a soft word
      // ending; say so rather than let it read as safe to cut.
      const analysed = pending.clips.filter((c) => !c.failure && !errors[c.key as string]).length;
      const vadOnlyNote =
        pending.kind === 'silence' && wordAwareRuns < analysed
          ? ` ${analysed - wordAwareRuns === analysed ? 'These ranges are' : `${analysed - wordAwareRuns} clip(s) are`} from the voice detector alone — transcribe the source (Index › Transcript) so silences stop short of every word.`
          : '';
      const darkNote = recoveredNote + unreadNote + vadOnlyNote;
      if (rows.length === 0) {
        setNotice(
          (pending.kind === 'silence'
            ? `No silence of ${pending.minSilenceMs}ms or longer in ${where}.`
            : `No retakes found in ${where}.`) + darkNote,
        );
      } else if (failures.length > 0) {
        setNotice(`${failures.length} clip(s) could not be analysed: ${failures[0]}${darkNote}`);
      } else if (darkNote) {
        setNotice(darkNote.trim());
      }
      setPending(null);
    };

    if (pending.kind === 'silence') {
      finish({});
      return;
    }
    // Every unit's groups through the gate together, then the list — still
    // all-or-nothing (see above). A newer run of this effect cancels this one.
    let cancelled = false;
    const tl = useEditorTimelineStore.getState().timeline;
    const units = pending.clips.filter((c) => !c.failure && c.key !== null && retakes[c.key]);
    void Promise.all(
      units.map(async (c) => {
        const key = c.key as string;
        const gate = tl
          ? await gateDetectorGroups(tl, pending.track, c.source, detectedForGate(retakes[key].groups))
          : [];
        return [key, gate] as const;
      }),
    ).then((entries) => {
      if (!cancelled) finish(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [pending, silences, silenceErrors, retakes, retakeErrors, transcripts, recoveries, appliedRereads]);

  /** Tick every take a group suggests dropping, leaving its keeper alone.
   *
   *  Client rows join only when the gate VERIFIED them (D-380 step 2). An
   *  AI-confirmed take is the AI's word against the gate's, and a refused one
   *  the gate's no: each is ticked by hand, after reading its reason, never in
   *  bulk — the asymmetry D-318 is built on (a missed cut is a second's work; a
   *  lost line is gone behind an undo nobody thinks to press). */
  const tickSuggested = () => {
    const next: Record<string, boolean> = {};
    for (const c of rows) {
      if (!tickable(c)) continue;
      if (c.source === 'client') {
        if (c.status === 'verified' && !c.suggestedKeep) next[c.id] = true;
        continue;
      }
      // D-382 — a detector group the gate refused is never ticked in bulk,
      // even once unlocked: a person ticks it, row by row, after listening.
      if (c.status === 'refused') continue;
      if (c.kind === 'silence' || !c.suggestedKeep) next[c.id] = true;
    }
    setTicked(next);
  };

  const chosen = rows.filter((c) => ticked[c.id] && tickable(c));
  /** The track a cut goes to: the one the detector rows were measured on, or
   *  — with only client rows showing — the one the client's proposals are for.
   *  Never the live selection. */
  const cutTrack = resultTrack ?? clientSet?.track ?? null;

  const cut = () => {
    // `cutTrack`, not the live selection: these candidates were measured
    // against one track, and reading the results may well have moved the
    // selection somewhere else.
    if (!timeline || chosen.length === 0 || cutTrack === null) return;
    // Every range each ticked row covers, not just its first: a retake take
    // split across clips by an earlier silence cut is several ranges (D-364).
    const ranges = chosen.flatMap((c) =>
      c.spans.map((s) => ({ start: s.startFrame, end: s.endFrame })),
    );
    // B-197 — the same per-range dry run the MCP side runs, for the same
    // reason: "did the timeline change at all" cannot tell a full cut from one
    // that quietly dropped some of its ranges (a sync-locked clip straddling a
    // gap's end, an L-cut link partner that can't be razored there), and the
    // panel used to report "Cut N ranges" either way.
    const outcome = applyRippleDeleteRanges(timeline, cutTrack, ranges, timelineFps(timeline));
    const skipped = outcome.results.filter((r) => !r.applied);
    if (outcome.timeline === timeline) {
      setError(skipped[0]?.reason ?? 'Nothing was cut — the track may be locked.');
      return;
    }
    applyOp({ kind: 'ripple_delete_ranges', track: cutTrack, ranges });
    // The candidates described the timeline as it was a moment ago; after a
    // ripple every later frame number is stale, so they go rather than linger
    // as numbers that now point at the wrong material. The client's proposals
    // for this track go too: their word indices described the same timeline.
    reset();
    if (clientSet && clientSet.track === cutTrack) {
      useMediaUnderstandingStore.getState().setRetakeProposals(cutTrack, null);
    }
    const cutCount = outcome.results.length - skipped.length;
    // One message, not two: the notice is hidden while an error is showing, and
    // "some of it did not happen" is the half the user has to read.
    if (skipped.length > 0) {
      setError(
        `Cut ${cutCount} of ${outcome.results.length} ranges — the other ${skipped.length} could not be cut and ` +
          `${skipped.length === 1 ? 'was' : 'were'} left untouched: ${skipped[0].reason}`,
      );
      return;
    }
    setNotice(`Cut ${cutCount} range${cutCount === 1 ? '' : 's'} — one undo reverses all of it.`);
  };

  return (
    <div
      data-chroma-panel="edit-recut"
      className="flex h-full w-full min-h-0 flex-col bg-surface text-text-primary"
    >
      {/* No header of its own — `EditLibraryPanel` supplies the one every
          library mode shares, so switching to Recut reads as the same column
          changing what it holds. */}
      <div className="shrink-0 border-b border-border-color p-2">
        {!canScan && (
          <p className="text-[11px] leading-snug text-text-secondary">
            {primary
              ? 'That clip is generated (a title or adjustment) — there is no audio to analyse. Choose Whole track to scan the rest of it.'
              : 'Select a clip to scan it, or select nothing on a timeline with one video track to scan the whole track.'}
          </p>
        )}
        {canScan && (
          <div className="flex flex-col gap-2">
            {/* D-342 — scope lives on ONE control rather than a second pair of
                buttons, mirroring `clip` becoming optional on the MCP tools
                rather than growing `*_all` twins. */}
            <div
              className="flex gap-1 rounded border border-border-color p-0.5"
              role="radiogroup"
              aria-label="What to scan"
              data-chroma-recut-scope
            >
              {(['clip', 'track'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={effectiveScope === s}
                  disabled={busy !== null || (s === 'clip' && !analysable)}
                  data-chroma-recut-scope-option={s}
                  onClick={() => setScope(s)}
                  className={`flex-1 rounded px-1.5 py-1 text-[11px] disabled:opacity-40 ${
                    effectiveScope === s
                      ? 'bg-accent text-button-text'
                      : 'text-text-secondary hover:bg-bg-primary'
                  }`}
                  title={
                    s === 'clip'
                      ? 'Scan only the selected clip'
                      : 'Scan every clip on this track — what a cleanup pass wants, so nothing is left unchecked'
                  }
                >
                  {s === 'clip' ? 'This clip' : 'Whole track'}
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
              <span>Min silence (ms)</span>
              <input
                type="number"
                min={100}
                step={50}
                value={minSilenceMs}
                data-chroma-recut-min-silence
                onChange={(e) => setMinSilenceMs(Math.max(1, Math.round(Number(e.target.value) || 0)))}
                className="w-20 rounded border border-border-color bg-bg-primary px-1.5 py-1 text-right text-text-primary"
              />
            </label>
            <div className="flex gap-1.5">
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                data-chroma-recut-find-silences
                onClick={findSilences}
                title={
                  effectiveScope === 'clip'
                    ? 'Find the stretches of this clip where nobody is speaking'
                    : 'Find every stretch on this track where nobody is speaking'
                }
              >
                {busy === 'silence' ? (
                  <SpinnerIcon className="size-3.5 animate-spin" />
                ) : (
                  <WaveformIcon className="size-3.5" />
                )}
                <span className="ml-1">{busy === 'silence' ? 'Listening…' : 'Silences'}</span>
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                data-chroma-recut-find-retakes
                onClick={findRetakes}
                title={
                  effectiveScope === 'clip'
                    ? 'Group the places where this line was delivered more than once'
                    : 'Group every line on this track that was delivered more than once'
                }
              >
                {busy === 'retake' ? (
                  <SpinnerIcon className="size-3.5 animate-spin" />
                ) : (
                  <RepeatIcon className="size-3.5" />
                )}
                <span className="ml-1">{busy === 'retake' ? 'Reading…' : 'Retakes'}</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* D-380 step 2 — what the MCP client proposed for this track, as the
          coverage gate judged it. Summary, its age, and a way for the human
          to throw it away; the rows themselves join the list below. */}
      {clientSet && (
        <div
          data-chroma-recut-client
          className="shrink-0 border-b border-border-color px-2.5 py-2 text-[11px] leading-snug text-text-secondary"
        >
          <div className="flex items-center justify-between gap-2">
            <span>
              <RobotIcon className="mr-1 inline size-3.5 align-[-2px]" />
              AI proposals ·{' '}
              {clientSet.groups.filter((g) => g.status === 'verified').length} verified,{' '}
              {clientSet.groups.filter((g) => g.status === 'ai_confirmed').length} AI-confirmed,{' '}
              {clientSet.groups.filter((g) => g.status === 'refused').length} refused
            </span>
            <button
              type="button"
              data-chroma-recut-client-dismiss
              onClick={() =>
                useMediaUnderstandingStore.getState().setRetakeProposals(clientSet.track, null)
              }
              className="shrink-0 underline-offset-2 hover:underline"
              title="Discard the AI's proposals for this track (nothing on the timeline changes)"
            >
              Dismiss
            </button>
          </div>
          {clientStale && (
            <p data-chroma-recut-client-stale className="mt-1 text-destructive">
              <WarningIcon className="mr-1 inline size-3.5 align-[-2px]" />
              The timeline changed since the AI read it — ask it to re-read the track. These rows can no longer be
              ticked.
            </p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-chroma-recut-list>
        {rows.length === 0 && !notice && !error && canScan && (
          <p className="text-[11px] leading-snug text-text-secondary">
            Nothing detected yet — run one of the two above.
          </p>
        )}
        {rows.map((c) => {
          const enabled = tickable(c);
          return (
            <label
              key={c.id}
              data-chroma-recut-candidate={c.id}
              data-chroma-recut-source={c.source ?? 'detector'}
              data-chroma-recut-status={c.status}
              title={c.line}
              className={`flex items-start gap-2 rounded px-1.5 py-1.5 text-[11px] leading-snug hover:bg-bg-primary ${
                enabled ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              <input
                type="checkbox"
                checked={enabled && Boolean(ticked[c.id])}
                disabled={!enabled}
                onChange={(e) => setTicked((t) => ({ ...t, [c.id]: e.target.checked }))}
                className="mt-0.5 accent-accent disabled:opacity-40"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {c.kind === 'silence'
                      ? 'Silence'
                      : `Take ${(c.takeIndex ?? 0) + 1} of ${c.takeCount ?? 1}`}
                    {c.suggestedKeep && (
                      <span className="ml-1 font-normal text-accent">
                        · {c.source === 'client' ? 'keep' : 'suggested keep'}
                      </span>
                    )}
                    {c.status && <StatusBadge status={c.status} />}
                  </span>
                  <span className="shrink-0 tabular-nums text-text-secondary">
                    {stamp(c.span.startSecs)}–{stamp(c.span.endSecs)}
                  </span>
                </span>
                {/* Which clip this came from — a whole-track scan's rows are
                    otherwise indistinguishable, and a reviewer needs to know
                    where on the track they are about to cut. */}
                <span className="mt-0.5 block truncate text-text-secondary">
                  <span className="tabular-nums opacity-70">#{c.clip}</span> {c.clipName}
                  {c.clipSpan && (
                    <span className="ml-1 opacity-70">+{c.clipSpan - 1} more clip{c.clipSpan > 2 ? 's' : ''}</span>
                  )}
                  {c.text && !c.words && <span className="ml-1 opacity-100">· {c.text}</span>}
                </span>
                {c.words && <TakeWords words={c.words} flagged={c.flagged ?? {}} status={c.status} />}
                {c.status === 'refused' && !c.suggestedKeep && c.reasonText && (
                  <span data-chroma-recut-reason className="mt-0.5 block text-destructive">
                    Refused: {c.reasonText}
                  </span>
                )}
                {c.status && !c.suggestedKeep && <Justifications flagged={c.flagged ?? {}} offending={c.offending ?? []} />}
                {c.status === 'refused' &&
                  !c.suggestedKeep &&
                  c.unlockable &&
                  !unlocked[c.groupKey ?? ''] &&
                  !(c.source === 'client' && clientStale) && (
                    <button
                      type="button"
                      data-chroma-recut-unlock={c.groupKey}
                      onClick={(e) => {
                        e.preventDefault();
                        const group = c.groupKey ?? '';
                        setUnlocked((u) => ({ ...u, [group]: true }));
                      }}
                      className="mt-1 inline-flex items-center gap-1 text-text-secondary underline-offset-2 hover:underline"
                      title="The gate reads text and cannot hear. Unlock only after listening to this take: the marked words may be lost."
                    >
                      <LockOpenIcon className="size-3.5" />
                      I listened — let me tick it
                    </button>
                  )}
              </span>
            </label>
          );
        })}
      </div>

      {rows.length > 0 && (
        <div className="shrink-0 border-t border-border-color p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <button
              type="button"
              data-chroma-recut-tick-suggested
              onClick={tickSuggested}
              title="Tick every take a detector or a verified AI group suggests dropping. AI-confirmed and refused takes are ticked one by one, after reading why."
              className="text-[11px] text-text-secondary underline-offset-2 hover:underline"
            >
              Tick all suggested
            </button>
            <button
              type="button"
              data-chroma-recut-clear
              onClick={() => setTicked({})}
              className="text-[11px] text-text-secondary underline-offset-2 hover:underline"
            >
              Clear
            </button>
          </div>
          <Button
            variant="default"
            size="xs"
            className="w-full"
            disabled={chosen.length === 0}
            data-chroma-recut-cut
            onClick={cut}
            title="Ripple delete every ticked range, as one edit"
          >
            <ScissorsIcon className="size-3.5" />
            <span className="ml-1">
              {chosen.length === 0
                ? 'Nothing ticked'
                : `Cut ${chosen.length} range${chosen.length === 1 ? '' : 's'}`}
            </span>
          </Button>
        </div>
      )}

      {notice && !error && (
        <div
          data-chroma-recut-notice
          className="shrink-0 border-t border-border-color px-2.5 py-2 text-[11px] leading-snug text-text-secondary"
        >
          {notice}
        </div>
      )}
      {error && (
        <button
          type="button"
          data-chroma-recut-error
          onClick={() => setError(null)}
          title="Dismiss"
          className="shrink-0 border-t border-border-color bg-red-500/10 px-2.5 py-2 text-left text-[11px] leading-snug text-red-400"
        >
          {error}
        </button>
      )}
    </div>
  );
}

/** The gate's verdict on a client row (D-380 step 2), as a short badge. */
function StatusBadge({ status }: { status: ProposalStatus }) {
  if (status === 'verified') {
    return (
      <span className="ml-1 inline-flex items-center gap-0.5 font-normal text-accent" title="The coverage gate checked that every word this take holds is also in the kept take">
        <SealCheckIcon className="size-3" /> verified
      </span>
    );
  }
  if (status === 'ai_confirmed') {
    return (
      <span className="ml-1 inline-flex items-center gap-0.5 font-normal text-text-primary" title="The gate could not account for some words; the AI vouched for each one — read its reasons">
        <RobotIcon className="size-3" /> AI-confirmed
      </span>
    );
  }
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 font-normal text-destructive" title="The gate found words this take would lose that the kept take does not hold">
      <ProhibitIcon className="size-3" /> refused
    </span>
  );
}

/** A client take's words, with the ones a cut would lose marked in place. */
function TakeWords({
  words,
  flagged,
  status,
}: {
  words: ProposalWord[];
  flagged: Record<number, string>;
  status?: ProposalStatus;
}) {
  const mark = status === 'refused' ? 'bg-destructive/20' : 'bg-accent/25';
  return (
    <span data-chroma-recut-words className="mt-0.5 block text-text-primary">
      {words.map((w, i) => (
        <span key={w.index}>
          {i > 0 && ' '}
          {w.index in flagged ? (
            <mark data-chroma-recut-flagged={w.index} className={`rounded-sm px-0.5 text-text-primary ${mark}`}>
              {w.word.trim()}
            </mark>
          ) : (
            w.word.trim()
          )}
        </span>
      ))}
    </span>
  );
}

/** The AI's per-word reasons, one line each — what the human weighs before
 *  ticking an AI-confirmed take. */
function Justifications({ flagged, offending }: { flagged: Record<number, string>; offending: ProposalWord[] }) {
  const lines = Object.entries(flagged).filter(([, why]) => why.length > 0);
  if (lines.length === 0) return null;
  // One label form for every reason: the word, then its index. The offending
  // word can live in a sibling take, so it is read from the group's own list.
  const label = (i: number) => {
    const word = offending.find((w) => w.index === i)?.word.trim();
    return word ? `“${word}” (#${i})` : `#${i}`;
  };
  return (
    <span data-chroma-recut-justifications className="mt-0.5 block text-text-secondary">
      {lines.map(([i, why]) => (
        <span key={i} className="block">
          <RobotIcon className="mr-0.5 inline size-3 align-[-2px]" />
          {label(Number(i))} — {why}
        </span>
      ))}
    </span>
  );
}
