/**
 * `retakeProposals.ts` — parsing a client's groups, turning the gate's
 * verdicts into reviewed groups, and the served instructions (D-380 step 2).
 */
import { describe, expect, it } from 'vitest';

import {
  groupDto,
  parseClientGroups,
  retakeInstructions,
  reviewGroups,
  wireGroups,
  type ClientGroup,
  type VerdictWire,
} from './retakeProposals';
import { buildWordViewInput, type ViewWord, type WordViewInput } from './retakeWordView';
import type { Timeline } from './timeline';

const A = '/media/a.mov';
const TEXT = 'final bin final bill the cat the cat'.split(' ');

function view(): { input: WordViewInput; words: ViewWord[] } {
  const words = TEXT.map((w, i) => ({ word: ` ${w}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const tl = {
    id: 'tl',
    name: 't',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'a', name: 'a', source_path: A, source_start: 0, duration: 240, source_len: 240, source_fps: 24, start_frame: 0 },
        ],
        gain: 1,
        sync_locked: false,
      },
    ],
    markers: [],
  } as unknown as Timeline;
  const input = buildWordViewInput(
    tl,
    0,
    { [A]: { text: '', language: 'en', model: 't', source: A, segments: [{ start: 0, end: 4, text: '', words }], words } },
    () => [],
  );
  if ('error' in input) throw new Error(input.error);
  return { input, words: words.map((w) => ({ text: w.word, start: w.start, end: w.end, piece: 0 })) };
}

describe('parseClientGroups', () => {
  it('takes {first,last} takes, a keep, and per-word reasons', () => {
    const g = parseClientGroups([
      { line: ' the cat ', takes: [{ first: 4, last: 5 }, { first: 6, last: 7 }], keep: 1, confirm: { '5': ' same word ' } },
    ]);
    expect(g).toEqual([
      { takes: [{ first: 4, last: 5 }, { first: 6, last: 7 }], keep: 1, line: 'the cat', confirm: { 5: 'same word' } },
    ]);
    expect(wireGroups(g as ClientGroup[])).toEqual([{ takes: [{ first: 4, last: 5 }, { first: 6, last: 7 }], keep: 1, waive: [5] }]);
  });

  it('refuses what is not a group, rather than guessing', () => {
    expect(parseClientGroups('x')).toMatchObject({ error: expect.stringContaining('array') });
    expect(parseClientGroups([{ takes: [[0, 1]], keep: 0 }])).toMatchObject({ error: expect.stringContaining('{first, last}') });
    expect(parseClientGroups([{ takes: [{ first: -1, last: 1 }], keep: 0 }])).toMatchObject({ error: expect.any(String) });
    expect(parseClientGroups([{ takes: [], keep: 'x' }])).toMatchObject({ error: expect.stringContaining('keep') });
    expect(parseClientGroups([{ takes: [], keep: 0, confirm: { a: 'why' } }])).toMatchObject({
      error: expect.stringContaining('not a word index'),
    });
    expect(parseClientGroups([{ takes: [], keep: 0, confirm: { 3: '  ' } }])).toMatchObject({
      error: expect.stringContaining('needs a reason'),
    });
    expect(parseClientGroups([])).toEqual([]);
  });
});

describe('reviewGroups', () => {
  const { input, words } = view();
  const groups: ClientGroup[] = [
    { takes: [{ first: 4, last: 5 }, { first: 6, last: 7 }], keep: 1, confirm: {} },
    { takes: [{ first: 0, last: 1 }, { first: 2, last: 3 }], keep: 1, confirm: { 1: 'misheard bill' } },
    { takes: [{ first: 0, last: 1 }, { first: 2, last: 3 }], keep: 1, confirm: {} },
    { takes: [{ first: 0, last: 9 }], keep: 0, confirm: {} },
  ];
  const cut = (first: number, last: number) => ({ first, last, startSecs: first * 0.5, endSecs: last * 0.5 + 0.4, piece: 0 });
  const verdicts: VerdictWire[] = [
    { verdict: 'accepted', cuts: [cut(4, 5)] },
    { verdict: 'confirmed', cuts: [cut(0, 1)], waived: [1] },
    {
      verdict: 'refused',
      reason: { kind: 'content_absent_from_kept_take' },
      reasonText: 'a deleted take has words the kept take does not',
      offending: [1],
      waivable: true,
      wouldCut: [cut(0, 1)],
    },
    { verdict: 'refused', reason: { kind: 'too_few_takes' }, reasonText: 'a group needs at least two takes', offending: [], waivable: false, wouldCut: [] },
  ];
  const r = reviewGroups(input, words, groups, verdicts);

  it('maps each verdict to a status', () => {
    expect(r.map((g) => g.status)).toEqual(['verified', 'ai_confirmed', 'refused', 'refused']);
  });

  it('a deleted take carries the gate\'s cut ranges and a kept take its own words', () => {
    expect(r[0].takes[0].segments).toHaveLength(1);
    expect(r[0].takes[0].segments[0].span.startFrame).toBe(48);
    expect(r[0].takes[1].keep).toBe(true);
    expect(r[0].takes[1].text).toBe('the cat');
  });

  it('a confirmed group lists the vouched words with their reasons', () => {
    expect(r[1].offending).toEqual([{ index: 1, word: ' bin' }]);
    expect(r[1].justifications).toEqual({ 1: 'misheard bill' });
    const dto = groupDto(r[1]);
    expect(dto.confirmed).toEqual([{ index: 1, word: ' bin', justification: 'misheard bill' }]);
  });

  it('a content refusal is unlockable with its would-cut; a malformed one is not and cuts nothing', () => {
    expect(r[2].unlockable).toBe(true);
    expect(r[2].takes[0].segments).toHaveLength(1);
    expect(r[3].unlockable).toBe(false);
    expect(r[3].takes[0].segments).toEqual(r[3].takes[0].extent);
    expect(groupDto(r[3])).toMatchObject({ notConfirmable: true, reason: { kind: 'too_few_takes' } });
  });

  it('is deterministic', () => {
    expect(reviewGroups(input, words, groups, verdicts)).toEqual(r);
  });
});

describe('retakeInstructions', () => {
  it('carries the rules verbatim and the client\'s whole refusal loop', () => {
    const text = retakeInstructions('RULES BLOCK\n');
    expect(text).toContain('RULES BLOCK');
    for (const tool of ['editor_propose_retakes', 'editor_retranscribe_words', 'editor_ripple_delete_ranges']) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('confirm');
    expect(text).toContain('runs no model');
  });
});
