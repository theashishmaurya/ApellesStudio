/**
 * @apelles/editor — the WHOLE-TRACK half of silence + retake detection
 * (D-342, fixes B-216).
 *
 * **What it is.** The pure planning and aggregation layer behind
 * `editor_detect_silences` / `editor_detect_retakes` **with `clip` omitted**:
 * pick every clip on a track worth analysing, and fold N per-clip answers into
 * one report a caller can read at a glance.
 *
 * **Why it exists at all** (B-216's real root cause, and it is not the
 * detector). Both detectors used to require an explicit `clip` index per call.
 * On a 75-clip timeline a cleanup pass therefore covers whichever clip a
 * report points at and never re-sweeps the rest — several genuine retakes and
 * one 5-10s silence survived to a final cut exactly that way. The obvious
 * "just call it in a loop from the client" does not fix it, because
 * `app/src-tauri/src/chroma/control.rs`'s `serve()` is a **single-threaded,
 * one-request-at-a-time** HTTP loop (`for req in server.incoming_requests()`,
 * no per-request spawn): 75 calls queue at that loop and are served strictly in
 * sequence, paying the full bridge round trip 75 times for per-clip analysis
 * that is itself cheap (a cached, per-FILE transcript plus string similarity;
 * a short VAD pass). The cost is the round trips, so the sweep has to happen
 * **inside one dispatch** — which is what the op handler this module serves
 * does, and what `recutSweep.dom.test.tsx` pins as a counting invariant.
 *
 * **What it does NOT do.** No detection (that is `apelles-speech`, reached
 * through `mediaUnderstandingStore`), no store access, no React, no I/O, and
 * **nothing destructive** — a sweep proposes exactly as the single-clip tools
 * do, and `editor_ripple_delete_ranges` is still the only thing that cuts.
 * It also does not re-derive any frame math: every span already crossed
 * `recut.ts`'s `spanToFrames` before it reaches [`sweepReport`].
 *
 * **The response shape is the point, not a detail.** A sweep's normal answer
 * is mostly *nothing* — an empty finding list is a healthy clip, not an error
 * (the same convention the single-clip tools already keep). So the report
 * carries **full detail only for the clips that actually flagged**, and every
 * clean clip collapses to a bare index in `clean`. On a 75-clip timeline that
 * is the difference between a response a caller can act on and 75 sub-reports
 * to scan for the three that matter.
 */

import { isStillSource, type Clip, type Track } from './timeline';

/** One clip a sweep will actually analyse. */
export interface SweepTarget {
  /** Index into the track's own `clips`, which is what every `editor_*` op
   *  and `editor_ripple_delete_ranges` speak in. */
  clip: number;
  c: Clip;
  /** Non-null by construction — [`sweepTargets`] skips clips without one. */
  source: string;
}

/** A clip a sweep deliberately did not analyse, and why. Reported rather than
 *  silently dropped: "20 clips, 18 analysed" is only trustworthy if the other
 *  two say what they were. */
export interface SweepSkip {
  clip: number;
  clipId: string;
  reason: string;
}

/** Which clips on one track a detector can say anything about.
 *
 *  Two exclusions, both of them "there is no speech here to find" rather than
 *  a policy choice:
 *  - a **generated** clip (a title or an adjustment) has no `source_path` and
 *    therefore no audio at all — the same refusal `resolveSilenceArgs` gives
 *    for a single clip, kept verbatim so one clip and a sweep agree;
 *  - a **still** (`isStillSource`) is a picture on screen for N frames, which
 *    is `dialogueClips`' own exclusion in `timelineTranscript.ts` (D-329) and
 *    is reused here rather than re-decided.
 *
 *  Order is the track's own clip order, so a report reads left-to-right along
 *  the timeline the way the editor does. */
export function sweepTargets(tr: Track | undefined): {
  targets: SweepTarget[];
  skipped: SweepSkip[];
} {
  const targets: SweepTarget[] = [];
  const skipped: SweepSkip[] = [];
  if (!tr) return { targets, skipped };

  tr.clips.forEach((c, clip) => {
    if (!c.source_path) {
      skipped.push({
        clip,
        clipId: c.id,
        reason: 'generated clip (a title or adjustment) — no audio to analyse',
      });
      return;
    }
    if (isStillSource(c.source_path)) {
      skipped.push({ clip, clipId: c.id, reason: 'a still image — no audio to analyse' });
      return;
    }
    targets.push({ clip, c, source: c.source_path });
  });

  return { targets, skipped };
}

/** Where one clip's detection got to, as the sweep found it.
 *
 *  `'transcribing'` is a retake-only state and genuinely distinct from
 *  `'running'`: the words do not exist yet, so nothing has been grouped and
 *  the thing to wait on is the transcript, not the grouping. The single-clip
 *  tool draws the same distinction (`resolveRetakeArgs`' `pending` branch) and
 *  this keeps it rather than flattening both into "not done".
 *
 *  `'idle'` can only come back from a `_status` sweep — nothing was ever
 *  started for that clip. It is kept separate from `'running'` for the same
 *  reason the single-clip status tool keeps them separate: polling an idle
 *  clip forever would never finish, and the answer is to start it. */
export type SweepClipState = 'done' | 'running' | 'transcribing' | 'idle' | 'error';

/** One clip's contribution to a sweep.
 *
 *  `findings` is whatever the single-clip tool would have returned for this
 *  clip — `silences` entries or retake `groups` — already converted to frames.
 *  It is `[]` for a clip that is `done` and clean, and ignored for any other
 *  state. */
export interface SweepClipResult {
  clip: number;
  clipId: string;
  source: string;
  state: SweepClipState;
  findings: unknown[];
  /** Present only on `state: 'error'`. */
  error?: string;
}

/** A sweep's aggregate answer. */
export interface SweepReport {
  ok: true;
  track: number;
  /** `'running'` while any clip is still being computed, `'idle'` when nothing
   *  on this track has ever been started, `'done'` otherwise. Deliberately the
   *  SAME three values, in the same first field, a single-clip answer carries,
   *  so an agent reads `state` first either way (D-321's own contract). */
  state: 'done' | 'running' | 'idle';
  /** The clips with something to decide about, in track order, in full. This
   *  is the list a caller acts on. */
  flagged: Array<{ clip: number; clipId: string; source: string } & Record<string, unknown>>;
  /** Analysed, nothing found. Indices only — a clean clip has no detail worth
   *  carrying, and on a long track this is most of them. */
  clean: number[];
  /** Still being computed. Poll the same tool, same arguments, `clip` still
   *  omitted. */
  running: number[];
  /** Retakes only: waiting on the transcript, not on the grouping. */
  transcribing: number[];
  /** `_status` sweeps only: nothing was ever started for these. Start them by
   *  calling the detector itself with `clip` omitted. */
  notStarted: number[];
  /** Analysed and failed, each with its own reason — one clip's failure never
   *  fails the sweep. */
  failed: Array<{ clip: number; error: string }>;
  /** Not analysable at all, and why (see [`sweepTargets`]). */
  skipped: SweepSkip[];
  totals: {
    clips: number;
    analysable: number;
    flagged: number;
    clean: number;
    running: number;
    transcribing: number;
    notStarted: number;
    failed: number;
    skipped: number;
    /** Total findings across every flagged clip — the "how much is there to
     *  review" number, which `flagged.length` alone does not give. */
    findings: number;
  };
  note: string;
}

/** What a sweep is looking for, which is the only thing that differs between
 *  the two detectors at this layer. */
export interface SweepKind {
  /** The key each flagged clip's findings are reported under — `'silences'`
   *  or `'groups'`, matching the single-clip tools' own field names exactly so
   *  one clip's answer and a sweep's read identically. */
  field: 'silences' | 'groups';
  /** The tool that STARTS this detection, named in the note when a `_status`
   *  sweep finds clips nobody ever started. */
  startTool: string;
  /** The tool to poll while anything is still running. */
  statusTool: string;
  /** Singular noun for the note, e.g. `'silence'` / `'retake group'`. */
  noun: string;
}

export const SILENCE_SWEEP: SweepKind = {
  field: 'silences',
  startTool: 'editor_detect_silences',
  statusTool: 'editor_detect_silences_status',
  noun: 'silence',
};

export const RETAKE_SWEEP: SweepKind = {
  field: 'groups',
  startTool: 'editor_detect_retakes',
  statusTool: 'editor_detect_retakes_status',
  noun: 'retake group',
};

/** Fold N per-clip results into the one report described in this module's
 *  header. Pure: same inputs, same report, which is what makes the "flagged vs
 *  clean" split testable without a store or a backend. */
export function sweepReport(
  kind: SweepKind,
  track: number,
  results: SweepClipResult[],
  skipped: SweepSkip[],
): SweepReport {
  const flagged: SweepReport['flagged'] = [];
  const clean: number[] = [];
  const running: number[] = [];
  const transcribing: number[] = [];
  const notStarted: number[] = [];
  const failed: SweepReport['failed'] = [];
  let findings = 0;

  for (const r of results) {
    switch (r.state) {
      case 'error':
        failed.push({ clip: r.clip, error: r.error ?? 'detection failed' });
        break;
      case 'running':
        running.push(r.clip);
        break;
      case 'transcribing':
        transcribing.push(r.clip);
        break;
      case 'idle':
        notStarted.push(r.clip);
        break;
      case 'done':
        if (r.findings.length === 0) {
          clean.push(r.clip);
        } else {
          findings += r.findings.length;
          flagged.push({
            clip: r.clip,
            clipId: r.clipId,
            source: r.source,
            [kind.field]: r.findings,
          });
        }
        break;
    }
  }

  const pending = running.length + transcribing.length;
  // `idle` only when NOTHING on this track has been started — a track with one
  // finished clip and nine untouched ones is `done` with a note naming the
  // nine, not `idle`, because there is a real answer in hand to read.
  const state =
    pending > 0
      ? 'running'
      : results.length > 0 && notStarted.length === results.length
        ? 'idle'
        : 'done';

  return {
    ok: true,
    track,
    state,
    flagged,
    clean,
    running,
    transcribing,
    notStarted,
    failed,
    skipped,
    totals: {
      clips: results.length + skipped.length,
      analysable: results.length,
      flagged: flagged.length,
      clean: clean.length,
      running: running.length,
      transcribing: transcribing.length,
      notStarted: notStarted.length,
      failed: failed.length,
      skipped: skipped.length,
      findings,
    },
    note: sweepNote(kind, {
      completed: flagged.length + clean.length,
      flagged: flagged.length,
      findings,
      pending,
      notStarted: notStarted.length,
      failed: failed.length,
    }),
  };
}

/** The one line that tells a caller what to do next. Written here rather than
 *  at the call site so both detectors phrase "nothing was cut" identically —
 *  the single-clip tools' own `note` convention. */
function sweepNote(
  kind: SweepKind,
  { completed, flagged, findings, pending, notStarted, failed }: {
    completed: number;
    flagged: number;
    findings: number;
    pending: number;
    notStarted: number;
    failed: number;
  },
): string {
  const parts: string[] = [];

  if (flagged === 0) {
    // "no silences anywhere on this track" is a CLAIM, and it is only true
    // once every analysable clip has actually answered. A sweep that is still
    // running, or one nobody started, must not make it.
    parts.push(
      completed === 0
        ? 'no clip on this track has an answer yet'
        : pending > 0 || notStarted > 0
          ? `no ${kind.noun}s in the ${completed} clip${completed === 1 ? '' : 's'} that have finished`
          : `no ${kind.noun}s anywhere on this track`,
    );
  } else {
    parts.push(
      `${findings} ${kind.noun}${findings === 1 ? '' : 's'} across ${flagged} clip${
        flagged === 1 ? '' : 's'
      } — nothing was cut; pass the ranges you accept to editor_ripple_delete_ranges`,
    );
  }

  if (pending > 0) {
    parts.push(
      `${pending} clip${pending === 1 ? ' is' : 's are'} still being analysed — poll ${
        kind.statusTool
      } with the same arguments and no clip`,
    );
  }
  if (notStarted > 0) {
    parts.push(
      `${notStarted} clip${
        notStarted === 1 ? ' was' : 's were'
      } never started — call ${kind.startTool} with no clip to sweep the track`,
    );
  }
  if (failed > 0) {
    parts.push(`${failed} clip${failed === 1 ? '' : 's'} failed — see failed[]`);
  }

  return parts.join('. ');
}
