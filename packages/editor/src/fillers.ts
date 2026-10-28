/**
 * `@apelles/editor` — filler and disfluency SUGGESTIONS over a word list
 * (D-420, roadmap 0l).
 *
 * **What it is.** One pure function that marks the words a person editing by
 * text usually looks at first: hesitation sounds ("uh", "um"), the two verbal
 * fillers the owner named ("like", "okay"), stutters (a cut-off fragment right
 * before the word it starts, "th- the", "bec because") and immediate repeats
 * ("the the" — the FIRST copy is marked, so deleting the marks keeps one).
 * The Index panel highlights them for one-click review; `editor_get_word_transcript`
 * lists them beside each page so the MCP client sees the same suggestions.
 *
 * **Suggestions, never decisions.** "like" is a verb as often as a filler, "okay"
 * is often the point of the sentence, and a repeat can be emphasis. So `kind`
 * says how sure the rule is (`filler` and `stutter` and `repeat` are
 * mechanical; `maybe` is a word that is only sometimes filler) and nothing here
 * cuts: a person reviews in the panel, or the client judges, and the cut is
 * `editor_cut_words` either way.
 *
 * **What it does NOT do.** No timing, no audio, no store. It reads word text
 * only. The hesitation list is a superset of the retake gate's forgiven fillers
 * (`apelles_speech::proposal`'s `FILLERS`, which also forgives them); the two
 * serve different jobs (forgiving vs. suggesting) and are listed separately.
 */

/** Hesitation sounds — filler whenever they occur. */
const HESITATIONS = new Set(['uh', 'um', 'uhm', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);

/** Words that are filler only sometimes ("I like it" vs "it was, like, huge"). */
const SOMETIMES = new Set(['like', 'okay', 'ok']);

/** Real short words a stutter rule must not read as a cut-off fragment of the
 *  next word ("a about", "to today", "in into" are ordinary speech). */
const REAL_SHORT_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'no',
  'of', 'on', 'or', 'so', 'the', 'to', 'up', 'us', 'we', 'you', 'all', 'are', 'but', 'can', 'for', 'get',
  'had', 'has', 'her', 'him', 'his', 'how', 'its', 'not', 'now', 'one', 'our', 'out', 'see', 'she', 'that',
  'them', 'then', 'they', 'this', 'too', 'two', 'was', 'way', 'who', 'why', 'with', 'your', 'any', 'new',
]);

export type FillerKind = 'filler' | 'maybe' | 'stutter' | 'repeat';

export interface FillerMark {
  index: number;
  word: string;
  kind: FillerKind;
}

/** A word as it compares: lower case, letters/digits/apostrophes only. */
export function normaliseWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
}

/** Every suggested filler in `words`, in index order, at most one mark per word. */
export function findFillers(words: ReadonlyArray<{ text: string }>): FillerMark[] {
  const norm = words.map((w) => normaliseWord(w.text));
  const out: FillerMark[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = norm[i];
    if (!w) continue;
    const raw = words[i].text.trim();
    const next = i + 1 < words.length ? norm[i + 1] : '';
    let kind: FillerKind | null = null;
    if (HESITATIONS.has(w)) kind = 'filler';
    else if (next && next === w) kind = 'repeat';
    else if (
      next &&
      next.length > w.length &&
      next.startsWith(w) &&
      (/[-–—]$/.test(raw) || (w.length <= 4 && !REAL_SHORT_WORDS.has(w)))
    ) {
      kind = 'stutter';
    } else if (SOMETIMES.has(w)) kind = 'maybe';
    if (kind) out.push({ index: i, word: raw, kind });
  }
  return out;
}
