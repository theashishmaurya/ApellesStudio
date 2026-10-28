// D-420 — filler and disfluency suggestions.
import { describe, expect, it } from 'vitest';

import { findFillers, normaliseWord } from './fillers';

const words = (s: string) => s.split(' ').map((text) => ({ text }));

describe('findFillers', () => {
  it('marks hesitations as fillers and "like"/"okay" as maybe', () => {
    expect(findFillers(words('So, um, I like it. Okay, uh, like, done.'))).toEqual([
      { index: 1, word: 'um,', kind: 'filler' },
      { index: 3, word: 'like', kind: 'maybe' },
      { index: 5, word: 'Okay,', kind: 'maybe' },
      { index: 6, word: 'uh,', kind: 'filler' },
      { index: 7, word: 'like,', kind: 'maybe' },
    ]);
  });

  it('marks the FIRST of an immediate repeat, so deleting the marks keeps one copy', () => {
    expect(findFillers(words('it is the the point, I I said'))).toEqual([
      { index: 2, word: 'the', kind: 'repeat' },
      { index: 5, word: 'I', kind: 'repeat' },
    ]);
  });

  it('marks a cut-off fragment before the word it starts, but not a real short word', () => {
    expect(findFillers(words('th- the idea, bec because, a about, to today'))).toEqual([
      { index: 0, word: 'th-', kind: 'stutter' },
      { index: 3, word: 'bec', kind: 'stutter' },
    ]);
  });

  it('is case- and punctuation-blind, and empty for empty input', () => {
    expect(normaliseWord(' Um,')).toBe('um');
    expect(findFillers([])).toEqual([]);
    expect(findFillers(words('UH'))).toEqual([{ index: 0, word: 'UH', kind: 'filler' }]);
  });
});
