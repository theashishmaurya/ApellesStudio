/**
 * `@apelles/editor` — the Clipper review's words, worked out from the run's
 * data (D-445, B-363). Pure: no store, no React.
 *
 * **What it is.** Everything the redesigned Clipper says about a run and its
 * shorts in plain words, so the list, the review surface and their tests read
 * one answer: the run's name ("Shorts from Voiceover v2 · 30 Oct"), its state
 * line, a short's clean-cut chip and its check as a sentence with what to try,
 * its length against the target, where it comes from, the sentences that are
 * in and out of it (the transcript view), and the count line under the list.
 *
 * **What it does NOT do.** Judge anything. The gate's verdict and notes come
 * from `apelles-clipper` (D-411); this only words them.
 */
import type { RunAnalysis } from './clipperStore';
import type { ClipProposal, ClipRun, Resolved, SentenceDto } from './clipperTypes';

/** Is the run's source still being read (transcript windows, evidence passes)? */
export function runIsReading(analysis: RunAnalysis | undefined, transcribing: Readonly<Record<string, unknown>>): boolean {
  return (
    !analysis ||
    analysis.provisional ||
    analysis.wire.evidence.some((e) => e.audio.state === 'running' || e.scenes.state === 'running') ||
    Object.keys(transcribing).length > 0
  );
}

/** "0:42" / "1:02:03". */
export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "Shorts from Voiceover v2". */
export function runTitle(run: ClipRun): string {
  return `Shorts from ${run.source.name}`;
}

/** "30 Oct". */
export function runDate(run: ClipRun): string {
  const d = new Date(run.created_at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const ASPECT_WORDS: Record<string, string> = { '9:16': 'Vertical 9:16', '1:1': 'Square 1:1', '4:5': 'Portrait 4:5' };

/** "30 s and 60 s · Vertical 9:16". */
export function runSettingsLine(run: ClipRun): string {
  const ds = run.settings.durations.map((d) => `${d} s`);
  const lengths = ds.length > 1 ? `${ds.slice(0, -1).join(', ')} and ${ds[ds.length - 1]}` : (ds[0] ?? '');
  return `${lengths} · ${ASPECT_WORDS[run.settings.aspect] ?? run.settings.aspect}`;
}

/** "target 30–60 s". */
export function targetLine(run: ClipRun): string {
  const ds = run.settings.durations;
  if (ds.length === 0) return '';
  const lo = Math.min(...ds);
  const hi = Math.max(...ds);
  return lo === hi ? `target ${lo} s` : `target ${lo}–${hi} s`;
}

export type CheckTone = 'ok' | 'warn' | 'bad';

/** The clean-cut check as a chip: "Clean cut", "1 warning", "Needs a fix". */
export function checkChip(p: ClipProposal): { tone: CheckTone; label: string } {
  if (p.verdict.verdict === 'refused') return { tone: 'bad', label: 'Needs a fix' };
  if (p.verdict.verdict === 'warned') {
    const n = Math.max(1, p.verdict.warnings.length);
    return { tone: 'warn', label: `${n} warning${n === 1 ? '' : 's'}` };
  }
  return { tone: 'ok', label: 'Clean cut' };
}

/** What to try for each warning / refusal kind the gate names. */
const ADVICE: Record<string, string> = {
  context_open: 'Try Start ‹ Earlier, so it opens on what it leans on.',
  ends_on_question: 'Try End › Later, to include the answer.',
  runs_on: 'Try End › Later, to finish the thought.',
  spans_topics: 'Try ending one sentence earlier, to keep it on one topic.',
  overlaps_proposal: 'Skip one of the two.',
};

const sentenceCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The check as sentences with what to try, or `null` for a clean cut. */
export function checkSentences(p: ClipProposal): string[] | null {
  if (p.verdict.verdict === 'verified') return null;
  const kinds = p.verdict.verdict === 'warned' ? p.verdict.warnings.map((w) => w.kind) : [p.verdict.reason.kind];
  return p.gate_notes.map((note, i) => {
    const advice = ADVICE[kinds[i] ?? ''];
    return `${sentenceCase(note.replace(/\.$/, ''))}.${advice ? ` ${advice}` : ''}`;
  });
}

/** The resolved range of a proposal the gate accepted, or `null`. */
export function resolvedOf(p: ClipProposal): Resolved | null {
  return p.verdict.verdict === 'refused' ? null : p.verdict.resolved;
}

/** The short's length after tightening, seconds (`null` when refused). */
export function shortSeconds(p: ClipProposal): number | null {
  const r = resolvedOf(p);
  return r ? r.tight_secs : null;
}

/** Where in the source the short starts and ends, seconds: from its first kept
 *  sentence to its last (the same span the gate resolved). */
export function sourceSpan(p: ClipProposal, sentences: readonly SentenceDto[]): { start: number; end: number } | null {
  const r = resolvedOf(p);
  if (!r) return null;
  const first = sentences[r.first_sentence];
  const last = sentences[r.last_sentence];
  return first && last ? { start: first.startSecs, end: last.endSecs } : null;
}

/** The range a poster frame is taken from: the opening line when there is a
 *  hook, else the first kept range. */
export function posterRange(p: ClipProposal): { source: number; secs: number } | null {
  const r = resolvedOf(p);
  if (!r || r.ranges.length === 0) return null;
  const first = r.ranges.find((x) => x.role === 'hook') ?? r.ranges[0];
  return { source: first.source, secs: first.start_secs };
}

/** One line of the "What's in it" transcript. */
export interface ScriptLine {
  index: number;
  text: string;
  /** In the short, left out, or the opening line. */
  kind: 'in' | 'out' | 'hook';
}

/** The sentences around and inside a short, each marked in / out / opening
 *  line — the transcript view. One sentence of context either side. */
export function scriptLines(p: ClipProposal, sentences: readonly SentenceDto[]): ScriptLine[] {
  const r = resolvedOf(p);
  if (!r || sentences.length === 0) return [];
  const inWords = (s: SentenceDto, segs: ReadonlyArray<{ first_word: number; last_word: number }>) =>
    segs.some((g) => g.first_word <= s.lastWord && s.firstWord <= g.last_word);
  const from = Math.max(0, r.first_sentence - 1);
  const to = Math.min(sentences.length - 1, r.last_sentence + 1);
  const hookSegs = p.shape.hook ? [p.shape.hook] : [];
  const out: ScriptLine[] = [];
  for (let i = from; i <= to; i += 1) {
    const s = sentences[i];
    const kind = inWords(s, hookSegs) ? 'hook' : inWords(s, p.shape.segments) ? 'in' : 'out';
    out.push({ index: i, text: s.text, kind });
  }
  return out;
}

/** The pauses and flubbed takes the build trims out, seconds each. */
export function trimmedCuts(p: ClipProposal): Array<{ kind: 'dead_air' | 'retake'; secs: number }> {
  const r = resolvedOf(p);
  if (!r) return [];
  return r.ranges.flatMap((range) => range.cuts.map((c) => ({ kind: c.kind, secs: Math.max(0, c.end_secs - c.start_secs) })));
}

/** "2 approved · 1 skipped · 2 to review" and how many can be made. */
export function reviewCounts(run: ClipRun): { line: string; approved: string[]; pending: number; made: number } {
  const approved = run.proposals.filter((p) => p.status === 'accepted' && p.verdict.verdict !== 'refused').map((p) => p.id);
  const skipped = run.proposals.filter((p) => p.status === 'rejected').length;
  const pending = run.proposals.filter((p) => p.status === 'pending').length;
  const made = run.proposals.filter((p) => p.status === 'built').length;
  const parts = [
    approved.length > 0 ? `${approved.length} approved` : null,
    skipped > 0 ? `${skipped} skipped` : null,
    pending > 0 ? `${pending} to review` : null,
    made > 0 ? `${made} made` : null,
  ].filter((x): x is string => x !== null);
  return { line: parts.join(' · ') || 'Nothing to review', approved, pending, made };
}

/** The request to paste to an agent that has not picked yet. */
export function askPrompt(run: ClipRun): string {
  const ds = run.settings.durations.join(' or ');
  return `Use the apelles-auto-clip skill: suggest ${run.settings.count} shorts (${ds} s) from “${runTitle(run)}” (clip run ${run.id}) in Apelles.`;
}
