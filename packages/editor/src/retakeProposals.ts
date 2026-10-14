/**
 * `@apelles/editor` — retake proposals from the MCP client, as the app holds
 * and shows them (D-380 step 2).
 *
 * **What it is.** The pure half of `editor_propose_retakes` and of the Recut
 * panel's client rows: the shapes a proposal set is stored in, the parsing of
 * a client's groups off the wire, the conversion of the coverage gate's
 * verdicts (`chroma_check_retake_proposals`) into reviewable groups — status,
 * reason, the words a cut would lose, the AI's justifications, the frames to
 * cut — and the instructions served with the word view.
 *
 * **The three statuses.**
 * - `verified` — the gate proved the deletions lose no word.
 * - `ai_confirmed` — the gate refused on content alone, and the MCP client
 *   vouched for every word it named, with a written reason. Not proven; shown
 *   to the human with the words and the reasons, and never ticked for them in
 *   bulk.
 * - `refused` — still refused. Shown with its reason and offending words, not
 *   tickable; a content refusal can be unlocked by a human who has listened
 *   (the gate cannot hear; a person can).
 *
 * **What it does NOT do.** No judgement (the client's), no gate (the crate's),
 * no store or I/O, no React, and nothing destructive: cutting stays
 * `ripple_delete_ranges`, from the panel's Cut button or
 * `editor_ripple_delete_ranges`.
 */

import type { DetectedSpan } from './recut';
import type { TakeSegment } from './recutRuns';
import {
  cutSegments,
  wordSpanSegments,
  wordsText,
  type CutRangeWire,
  type ViewWord,
  type WordViewInput,
} from './retakeWordView';

export type ProposalStatus = 'verified' | 'ai_confirmed' | 'refused';

/** One word, by its view index. */
export interface ProposalWord {
  index: number;
  word: string;
}

/** One take of a reviewed group. */
export interface ProposalTake {
  first: number;
  last: number;
  /** This is the group's kept take. */
  keep: boolean;
  text: string;
  words: ProposalWord[];
  startSecs: number;
  endSecs: number;
  /** Where on the timeline: for a deleted take, the ranges a cut removes (the
   *  gate's padded ranges — or, for a refused group, what it WOULD remove);
   *  for the kept take, the extent of its words. One per clip. Empty for a
   *  deleted take of a group that has nothing sound to cut (malformed, or in
   *  conflict with another group). */
  segments: TakeSegment[];
  /** Where the take's words sit, unpadded — for SHOWING the take (its row,
   *  its timestamp) whatever its status. Never cut from. */
  extent: TakeSegment[];
}

/** One group as reviewed. */
export interface ProposalGroupView {
  /** Index in the client's submission. */
  group: number;
  status: ProposalStatus;
  line?: string;
  note?: string;
  keep: number;
  takes: ProposalTake[];
  /** Refused groups: the gate's reason, as the crate names it. */
  reason?: { kind: string; group?: number };
  reasonText?: string;
  /** Refused: the words still unaccounted for. Confirmed: the words the
   *  client vouched for (what the gate could not account for). */
  offending: ProposalWord[];
  /** The client's per-word reasons, keyed by view word index. */
  justifications: Record<number, string>;
  /** A content refusal a listening human may unlock (its deletions are
   *  resolvable); false for a malformed or conflicting group. */
  unlockable: boolean;
}

/** One track's proposals, as the store holds them. */
export interface RetakeProposalSet {
  track: number;
  viewId: string;
  /** [`viewBasisKey`] of the view the groups were judged on. */
  basisKey: string;
  /** `Date.now()` when they arrived — display only, never in a key. */
  receivedAt: number;
  groups: ProposalGroupView[];
}

/** One group as a client submits it, after parsing. */
export interface ClientGroup {
  takes: Array<{ first: number; last: number }>;
  keep: number;
  line?: string;
  note?: string;
  /** View word index -> why that word is not lost. */
  confirm: Record<number, string>;
}

/** The gate's verdict as `chroma_check_retake_proposals` returns it. */
export type VerdictWire =
  | { verdict: 'accepted'; cuts: CutRangeWire[] }
  | { verdict: 'confirmed'; cuts: CutRangeWire[]; waived: number[] }
  | {
      verdict: 'refused';
      reason: { kind: string; group?: number };
      reasonText: string;
      offending: number[];
      waivable: boolean;
      wouldCut: CutRangeWire[];
    };

/** `chroma_check_retake_proposals`' answer. */
export type CheckWire =
  | { stale: true; viewId: string }
  | { stale: false; viewId: string; verdicts: VerdictWire[]; words: ViewWord[] };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Parse a client's `groups` off the wire. Strict: an index must be a
 *  non-negative integer, a take an object `{first, last}`, and a confirmation a
 *  non-empty reason for a word index — a vague or missing reason is not a
 *  confirmation. Range and overlap checks are the gate's, not this. */
export function parseClientGroups(raw: unknown): ClientGroup[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'groups must be an array (an empty one clears the proposals)' };
  const out: ClientGroup[] = [];
  for (let gi = 0; gi < raw.length; gi += 1) {
    const g = raw[gi] as Record<string, unknown> | null;
    if (!g || typeof g !== 'object') return { error: `group ${gi} is not an object` };
    if (!Array.isArray(g.takes)) return { error: `group ${gi}: takes must be an array of {first, last}` };
    const takes: Array<{ first: number; last: number }> = [];
    for (const t of g.takes as unknown[]) {
      const tk = t as { first?: unknown; last?: unknown } | null;
      if (!tk || typeof tk !== 'object' || !isInt(tk.first) || !isInt(tk.last)) {
        return { error: `group ${gi}: every take must be {first, last} with non-negative integer word indices` };
      }
      takes.push({ first: tk.first, last: tk.last });
    }
    if (!isInt(g.keep)) return { error: `group ${gi}: keep must be a non-negative integer index into takes` };
    const confirm: Record<number, string> = {};
    if (g.confirm !== undefined && g.confirm !== null) {
      if (typeof g.confirm !== 'object' || Array.isArray(g.confirm)) {
        return { error: `group ${gi}: confirm must map word indices to a reason, e.g. {"412": "..."}` };
      }
      for (const [k, v] of Object.entries(g.confirm as Record<string, unknown>)) {
        const index = Number(k);
        if (!isInt(index) || String(index) !== k.trim()) {
          return { error: `group ${gi}: confirm key "${k}" is not a word index` };
        }
        if (typeof v !== 'string' || v.trim().length === 0) {
          return { error: `group ${gi}: confirm[${k}] needs a reason — why is this word not lost?` };
        }
        confirm[index] = v.trim();
      }
    }
    out.push({
      takes,
      keep: g.keep,
      ...(typeof g.line === 'string' && g.line.trim() ? { line: g.line.trim() } : {}),
      ...(typeof g.note === 'string' && g.note.trim() ? { note: g.note.trim() } : {}),
      confirm,
    });
  }
  return out;
}

/** What `chroma_check_retake_proposals` takes for each group. */
export function wireGroups(groups: readonly ClientGroup[]) {
  return groups.map((g) => ({
    takes: g.takes,
    keep: g.keep,
    waive: Object.keys(g.confirm)
      .map(Number)
      .sort((a, b) => a - b),
  }));
}

const wordsOf = (words: readonly ViewWord[], indices: readonly number[]): ProposalWord[] =>
  indices.filter((i) => i >= 0 && i < words.length).map((index) => ({ index, word: words[index].text }));

/**
 * The reviewed groups for one submission: each verdict turned into a status,
 * its takes into text and timeline segments, its reason and words into what a
 * reviewer reads. Pure — the same verdicts give the same groups.
 */
export function reviewGroups(
  input: WordViewInput,
  words: readonly ViewWord[],
  groups: readonly ClientGroup[],
  verdicts: readonly VerdictWire[],
): ProposalGroupView[] {
  return groups.map((g, gi) => {
    const v = verdicts[gi];
    const cuts: CutRangeWire[] =
      v?.verdict === 'refused' ? v.wouldCut : v ? v.cuts : [];
    const inRange = (t: { first: number; last: number }) =>
      t.first <= t.last && t.last < words.length;
    const takes: ProposalTake[] = g.takes.map((t, ti) => {
      const keep = ti === g.keep;
      const ok = inRange(t);
      const extent = ok ? wordSpanSegments(input, words, t.first, t.last) : [];
      const segments = !ok
        ? []
        : keep
          ? extent
          : cutSegments(
              input,
              cuts.filter((c) => c.first >= t.first && c.last <= t.last),
            );
      return {
        first: t.first,
        last: t.last,
        keep,
        text: ok ? wordsText(words, t.first, t.last) : '',
        words: ok ? wordsOf(words, range(t.first, t.last)) : [],
        startSecs: ok ? words[t.first].start : 0,
        endSecs: ok ? words[t.last].end : 0,
        segments,
        extent,
      };
    });
    const base = {
      group: gi,
      keep: g.keep,
      takes,
      ...(g.line ? { line: g.line } : {}),
      ...(g.note ? { note: g.note } : {}),
    };
    if (!v || v.verdict === 'accepted') {
      return {
        ...base,
        status: 'verified' as const,
        offending: [],
        justifications: {},
        unlockable: false,
      };
    }
    if (v.verdict === 'confirmed') {
      const justifications: Record<number, string> = {};
      for (const i of v.waived) if (g.confirm[i]) justifications[i] = g.confirm[i];
      return {
        ...base,
        status: 'ai_confirmed' as const,
        offending: wordsOf(words, v.waived),
        justifications,
        unlockable: false,
      };
    }
    return {
      ...base,
      status: 'refused' as const,
      reason: v.reason,
      reasonText: v.reasonText,
      offending: wordsOf(words, v.offending),
      justifications: { ...g.confirm },
      unlockable: v.waivable && v.wouldCut.length > 0,
    };
  });
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** A take's segments as the MCP answer prints them — the same flat
 *  `{clip, clipId, startFrame, endFrame, …}` entries `editor_detect_retakes`
 *  returns, so `editor_ripple_delete_ranges` takes either unchanged. */
export function segmentsDto(segments: readonly TakeSegment[]): Array<{ clip: number; clipId: string } & DetectedSpan> {
  return segments.map((s) => ({ clip: s.clip, clipId: s.clipId, ...s.span }));
}

/** One reviewed group as `editor_propose_retakes` answers it. */
export function groupDto(g: ProposalGroupView) {
  return {
    group: g.group,
    status: g.status,
    ...(g.line ? { line: g.line } : {}),
    keep: g.keep,
    takes: g.takes.map((t) => ({
      first: t.first,
      last: t.last,
      keep: t.keep,
      text: t.text,
      startSecs: t.startSecs,
      endSecs: t.endSecs,
      segments: segmentsDto(t.segments),
    })),
    ...(g.status === 'refused'
      ? {
          reason: g.reason,
          reasonText: g.reasonText,
          offending: g.offending,
          ...(g.unlockable ? {} : { notConfirmable: true }),
        }
      : {}),
    ...(g.status === 'ai_confirmed'
      ? {
          confirmed: g.offending.map((w) => ({ ...w, justification: g.justifications[w.index] ?? '' })),
        }
      : {}),
  };
}

/**
 * The instructions served with the first page of `editor_get_word_transcript`
 * — the judging rules D-379's POC was measured under (`rules`, verbatim from
 * the crate's `JUDGING_RULES`), wrapped in how to answer in Apelles and how
 * to handle a refusal. Written to the MCP client, about the client's own loop:
 * the app runs no model and makes no judgement.
 */
export function retakeInstructions(rules: string): string {
  return [
    'You are reviewing one timeline track of a video editor (Apelles) for RETAKES. The app gives you the words; the judgement is yours. The app runs no model of its own: it checks your answer mechanically and shows it to the person editing.',
    '',
    rules.trimEnd(),
    '',
    'In this app the transcript is one track in play order and may be several clips; a "--- segment" line also starts at every clip boundary. Word indices are global across every page and only mean something with the viewId they were read under.',
    '',
    'How to answer:',
    '- Call editor_propose_retakes with {track, view_id, groups: [{line, takes: [{first, last}, ...], keep, note}]}. Takes in spoken order, non-overlapping. Each call REPLACES the track\'s whole set, so always send every group you still stand by; an empty list clears it.',
    '- Every group is checked by a deterministic coverage gate: each word a deleted take holds must also be in the kept take (stopwords, fillers, false starts and stutters are forgiven; near-identical spellings of long words match). The gate cannot hear and does not judge which take is better. Each group comes back "verified", "ai_confirmed" or "refused".',
    '- A refusal names the offending word indices and words and the reason. Resolve each one yourself:',
    '  1. Narrow: if the offending words are unique speech your take swallowed (the end of the previous sentence, the start of the next), move first/last so they fall outside the take and resubmit.',
    '  2. Re-transcribe: if an offending word looks misheard (type/time, bin/bill), call editor_retranscribe_words {track, view_id, first, last} over the flagged stretch. It returns a fresh speech-recogniser reading of that audio beside the current words; nothing changes until you call it again with apply: true. Apply only a reading that is better. Applying updates the transcript for everyone, so the viewId changes: re-read the pages you need, re-derive your indices, and resubmit.',
    '  3. Confirm: if you are sure the content survives in the kept take (an inflection such as chip/chips, a mishearing the re-read did not fix, a word that only belongs to the abandoned attempt), resubmit the group with confirm: {"<word index>": "<why this word is not lost>"} for EVERY offending word. It is stored as "ai_confirmed": shown to the person with your reasons and the words highlighted, and never ticked for them in bulk. Only content refusals can be confirmed; a malformed group or two groups fighting over the same words must be fixed instead.',
    '  4. Drop: when you are still unsure, leave the group out (rule 4). An unresolved group stays "refused" and is shown to the person with its reason.',
    '- Nothing is cut by any of this. The person reviews the proposals in the Recut panel and cuts them there; cut them yourself with editor_ripple_delete_ranges (every segment of every deleted take) only when they ask you to.',
  ].join('\n');
}
