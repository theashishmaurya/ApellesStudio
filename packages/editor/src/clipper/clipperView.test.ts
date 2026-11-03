// @apelles/editor — the Clipper review's words (D-445): the run's name and
// state line, the clean-cut chip and the check as sentences with what to try,
// the transcript view (in / out / opening line), the trimmed pauses and the
// count line. The gate's verdicts are fixtures; this only words them.
import { describe, expect, it } from 'vitest';

import type { ClipProposal, ClipRun, SentenceDto } from './clipperTypes';
import {
  askPrompt,
  checkChip,
  checkSentences,
  fmtClock,
  posterRange,
  reviewCounts,
  runSettingsLine,
  runTitle,
  scriptLines,
  sourceSpan,
  targetLine,
  trimmedCuts,
} from './clipperView';

const sentences: SentenceDto[] = [0, 1, 2, 3, 4].map((i) => ({
  index: i,
  firstWord: i * 10,
  lastWord: i * 10 + 9,
  piece: 0,
  startSecs: 190 + i * 10,
  endSecs: 199 + i * 10,
  text: `Sentence ${i}.`,
  ending: 'period',
  topic: 0,
  tags: [],
}));

const resolved = {
  ranges: [
    { role: 'hook' as const, piece: 0, source: 1, first_word: 30, last_word: 39, start_secs: 220, end_secs: 229, cuts: [] },
    { role: 'body' as const, piece: 0, source: 1, first_word: 10, last_word: 29, start_secs: 200, end_secs: 219, cuts: [{ kind: 'dead_air' as const, start_secs: 205, end_secs: 206.5 }] },
  ],
  raw_secs: 31,
  tight_secs: 28.6,
  first_sentence: 1,
  last_sentence: 3,
};

const p = (extra: Partial<ClipProposal> = {}): ClipProposal => ({
  id: 'p1',
  shape: { hook: { first_word: 30, last_word: 39 }, segments: [{ first_word: 10, last_word: 29 }] },
  title: 't',
  reason: 'r',
  picked_by: 'client',
  view_id: 'v',
  rules_version: 1,
  verdict: { verdict: 'verified', resolved },
  gate_notes: [],
  status: 'pending',
  ...extra,
});

const run: ClipRun = {
  schema: 1,
  id: 'run-9',
  created_at: '2026-10-30T10:09:00Z',
  source: { kind: 'timeline', timeline_id: 't1', track: 0, name: 'Voiceover v2' },
  settings: { durations: [30, 60], count: 5, aspect: '9:16', captions: 'brand', hook_first: true, tighten: { dead_air: true, retakes: true } },
  proposals: [
    p({ id: 'a', status: 'accepted' }),
    p({ id: 'b', status: 'rejected' }),
    p({ id: 'c' }),
    p({ id: 'd', status: 'built' }),
    p({ id: 'e', status: 'accepted', verdict: { verdict: 'refused', reason: { kind: 'too_short' }, offending: [] } }),
  ],
};

describe('clipperView (D-445)', () => {
  it('names the run and its settings in words', () => {
    expect(runTitle(run)).toBe('Shorts from Voiceover v2');
    expect(runSettingsLine(run)).toBe('30 s and 60 s · Vertical 9:16');
    expect(targetLine(run)).toBe('target 30–60 s');
    expect(askPrompt(run)).toContain('suggest 5 shorts (30 or 60 s) from “Shorts from Voiceover v2” (clip run run-9)');
    expect(fmtClock(192)).toBe('3:12');
    expect(fmtClock(3723)).toBe('1:02:03');
  });

  it('words the clean-cut check, with what to try', () => {
    expect(checkChip(p())).toEqual({ tone: 'ok', label: 'Clean cut' });
    expect(checkSentences(p())).toBeNull();
    const warned = p({
      verdict: { verdict: 'warned', resolved, warnings: [{ kind: 'context_open' }, { kind: 'runs_on' }] },
      gate_notes: ['opens on "and", which leans on something said before the clip', 'the last sentence has no full stop: the thought may run on'],
    });
    expect(checkChip(warned)).toEqual({ tone: 'warn', label: '2 warnings' });
    expect(checkSentences(warned)).toEqual([
      'Opens on "and", which leans on something said before the clip. Try Start ‹ Earlier, so it opens on what it leans on.',
      'The last sentence has no full stop: the thought may run on. Try End › Later, to finish the thought.',
    ]);
    const refused = p({ verdict: { verdict: 'refused', reason: { kind: 'too_short' }, offending: [] }, gate_notes: ['the clip runs 9.0 s after tightening'] });
    expect(checkChip(refused)).toEqual({ tone: 'bad', label: 'Needs a fix' });
    expect(checkSentences(refused)).toEqual(['The clip runs 9.0 s after tightening.']);
  });

  it('shows what is in the short: context out, the body in, the opening line tinted', () => {
    expect(scriptLines(p(), sentences).map((l) => [l.index, l.kind])).toEqual([
      [0, 'out'],
      [1, 'in'],
      [2, 'in'],
      [3, 'hook'],
      [4, 'out'],
    ]);
    expect(trimmedCuts(p())).toEqual([{ kind: 'dead_air', secs: 1.5 }]);
    expect(sourceSpan(p(), sentences)).toEqual({ start: 200, end: 229 });
    // The poster comes from the opening line's range.
    expect(posterRange(p())).toEqual({ source: 1, secs: 220 });
  });

  it('counts the review, never offering a short that needs a fix as made-able', () => {
    expect(reviewCounts(run)).toEqual({ line: '1 approved · 1 skipped · 1 to review · 1 made', approved: ['a'], pending: 1, made: 1 });
  });
});
