/**
 * @apelles/editor — suggest highlights for a screenshot clip (D-396/D-397).
 *
 * What it is: the pure matching step behind `editor_suggest_clip_highlights`
 * and the Inspector's "Suggest from transcript" button. Given the words OCR
 * found in a clip's picture (with boxes) and the words being SPOKEN while that
 * clip is on screen (with timeline frames), it returns ready-to-apply
 * `ClipHighlight`s: one box per matched run of the spoken phrase, swept over
 * exactly the frames the phrase is spoken.
 *
 * What it does NOT do: no OCR (the `chroma_ocr_media` command, over macOS
 * Vision), no transcript fetching (`highlightSuggestOp.ts`), no writing — it
 * returns a suggestion, and applying it is `set_clip_highlights`. Pure, no I/O.
 *
 * **Matching.** Both sides are normalised to lowercase letters and digits and
 * walked as sequences. A run is a stretch where the spoken words and the OCR
 * words agree word for word (a one-letter slip in a long word is forgiven, since
 * both OCR and ASR make them). A run counts only if it holds at least
 * [`MIN_CONTENT_WORDS`] content words (stopwords carry a run across but do not
 * justify one), and is trimmed to its first and last content word so the pen
 * never starts on "the". Longer runs win; a run claims its words on both sides
 * so the same headline word is never highlighted twice for two utterances.
 *
 * **Boxes.** A run's OCR words are grouped by the line they sit on; each line
 * part becomes one box (padded a little so the stroke clears the glyphs), and a
 * phrase that wraps sweeps its parts in order, sharing the spoken duration in
 * proportion to their widths.
 *
 * **Fallback.** With no match at all (nothing spoken over this picture, or the
 * narration is about something the picture does not say), the largest line of
 * text is swept once at the start of the clip, so the result is never empty
 * when the picture has any text.
 */

import {
  DEFAULT_HIGHLIGHT_SWEEP_SECONDS,
  sanitizeHighlight,
  type ClipHighlight,
} from './clipHighlights';

/** One OCR word, as `chroma_ocr_media` returns it. `bbox` is `[x0, y0, x1, y1]`
 *  as fractions of the image, origin top-left. */
export interface OcrWord {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
}

/** One OCR line and its words in reading order. */
export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
  words: OcrWord[];
}

/** One spoken word, located on the TIMELINE. */
export interface SpokenWord {
  text: string;
  startFrame: number;
  endFrame: number;
}

/** A run needs at least this many content words to be worth a highlight. */
export const MIN_CONTENT_WORDS = 2;
/** Fractions of the image the stroke extends past the glyph boxes, so the pen
 *  clears the ascenders and does not start flush against the first letter. */
export const HIGHLIGHT_PAD_X = 0.004;
export const HIGHLIGHT_PAD_Y_OF_HEIGHT = 0.15;
/** Words this short or this common carry a run but never justify one. */
const STOPWORDS = new Set(
  (
    'a an the of to in on at by for with from as and or but nor so if then than that this these those ' +
    'is are was were be been being am it its i you he she we they me him her us them my your his our their ' +
    'not no do does did has have had will would can could should may might must just very too also into onto ' +
    'about over under up out off again there here when where which who whom what why how all any some'
  ).split(' '),
);

/** A normalised token: lowercase letters and digits only (any script). */
export function normaliseToken(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const isContent = (token: string): boolean => token.length > 1 && !STOPWORDS.has(token);

/** Edit distance, capped: returns `limit + 1` as soon as it must exceed it. */
function editDistanceWithin(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Two normalised tokens match when equal, or — for words long enough that one
 *  slip is not a different word (six letters: "trust"/"crust" are two words,
 *  "customer"/"customers" are one) — one edit apart. */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 6 || b.length < 6) return false;
  return editDistanceWithin(a, b, 1) <= 1;
}

interface Token<T> {
  norm: string;
  item: T;
}

interface Run {
  /** Index of the first matched token on each side, and the length. */
  spoken: number;
  ocr: number;
  length: number;
  content: number;
}

/** Every maximal diagonal run of matching tokens, longest first. */
function findRuns(spoken: Token<SpokenWord>[], ocr: Token<OcrWord>[]): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < spoken.length; i++) {
    for (let j = 0; j < ocr.length; j++) {
      // Only start a run where the previous pair does not already continue it.
      if (i > 0 && j > 0 && tokensMatch(spoken[i - 1].norm, ocr[j - 1].norm)) continue;
      let len = 0;
      let content = 0;
      while (i + len < spoken.length && j + len < ocr.length && tokensMatch(spoken[i + len].norm, ocr[j + len].norm)) {
        if (isContent(spoken[i + len].norm)) content++;
        len++;
      }
      if (len > 0 && content >= MIN_CONTENT_WORDS) runs.push({ spoken: i, ocr: j, length: len, content });
    }
  }
  return runs.sort((a, b) => b.content - a.content || b.length - a.length || a.ocr - b.ocr);
}

/** Drop the stopwords from both ends of a run. `null` when too little is left. */
function trimRun(run: Run, spoken: Token<SpokenWord>[]): Run | null {
  let { spoken: s, ocr: o, length: n } = run;
  while (n > 0 && !isContent(spoken[s].norm)) {
    s++;
    o++;
    n--;
  }
  while (n > 0 && !isContent(spoken[s + n - 1].norm)) n--;
  let content = 0;
  for (let k = 0; k < n; k++) if (isContent(spoken[s + k].norm)) content++;
  return content >= MIN_CONTENT_WORDS ? { spoken: s, ocr: o, length: n, content } : null;
}

type Box = [number, number, number, number];

const unionBox = (boxes: readonly Box[]): Box => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3])),
];

/** Pad a box so the stroke clears the glyphs, clamped to the image. */
export function padHighlightBox(box: Box): Box {
  const padY = (box[3] - box[1]) * HIGHLIGHT_PAD_Y_OF_HEIGHT;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(box[0] - HIGHLIGHT_PAD_X), c(box[1] - padY), c(box[2] + HIGHLIGHT_PAD_X), c(box[3] + padY)];
}

/** Group a run's OCR words by the line they sit on (words whose vertical
 *  centres fall inside the same line box), in reading order. */
function lineParts(words: readonly OcrWord[]): OcrWord[][] {
  const parts: OcrWord[][] = [];
  for (const w of words) {
    const last = parts[parts.length - 1];
    const centre = (w.bbox[1] + w.bbox[3]) / 2;
    if (last) {
      const lb = unionBox(last.map((x) => x.bbox));
      if (centre >= lb[1] && centre <= lb[3]) {
        last.push(w);
        continue;
      }
    }
    parts.push([w]);
  }
  return parts;
}

/** One matched phrase, reported alongside the highlights it became. */
export interface SuggestedPhrase {
  text: string;
  /** TIMELINE frames the phrase is spoken over. */
  startFrame: number;
  endFrame: number;
}

export interface HighlightSuggestion {
  /** Ready for `set_clip_highlights`. */
  highlights: ClipHighlight[];
  /** `'transcript'` = matched against the spoken words; `'headline'` = nothing
   *  matched, so the largest line is swept at the clip's start. */
  basis: 'transcript' | 'headline' | 'none';
  phrases: SuggestedPhrase[];
  ocrWords: number;
  spokenWords: number;
}

/**
 * Suggest highlights for one clip.
 *
 * `sourceFrameAt` converts a TIMELINE frame to the clip's SOURCE frame
 * (`clipSourceFrameAt`), which is the axis `ClipHighlight.at`/`dur` are on.
 * `clipSourceStart` / `clipSourceFps` place the headline fallback and size its
 * sweep.
 */
export function suggestHighlights(args: {
  lines: readonly OcrLine[];
  spoken: readonly SpokenWord[];
  sourceFrameAt: (timelineFrame: number) => number;
  clipSourceStart: number;
  clipSourceFps: number;
  clipSourceFrames: number;
}): HighlightSuggestion {
  const { lines, spoken, sourceFrameAt, clipSourceStart, clipSourceFps, clipSourceFrames } = args;
  const ocrTokens: Token<OcrWord>[] = lines
    .flatMap((l) => l.words)
    .map((w) => ({ norm: normaliseToken(w.text), item: w }))
    .filter((t) => t.norm.length > 0);
  const spokenTokens: Token<SpokenWord>[] = spoken
    .map((w) => ({ norm: normaliseToken(w.text), item: w }))
    .filter((t) => t.norm.length > 0);
  const base = { ocrWords: ocrTokens.length, spokenWords: spokenTokens.length };

  const claimedSpoken = new Set<number>();
  const claimedOcr = new Set<number>();
  const chosen: Run[] = [];
  for (const raw of findRuns(spokenTokens, ocrTokens)) {
    const run = trimRun(raw, spokenTokens);
    if (!run) continue;
    const overlaps = Array.from({ length: run.length }, (_, k) => k).some(
      (k) => claimedSpoken.has(run.spoken + k) || claimedOcr.has(run.ocr + k),
    );
    if (overlaps) continue;
    for (let k = 0; k < run.length; k++) {
      claimedSpoken.add(run.spoken + k);
      claimedOcr.add(run.ocr + k);
    }
    chosen.push(run);
  }
  // Reading order = the order the phrases are spoken.
  chosen.sort((a, b) => a.spoken - b.spoken);

  const highlights: ClipHighlight[] = [];
  const phrases: SuggestedPhrase[] = [];
  for (const run of chosen) {
    const words = spokenTokens.slice(run.spoken, run.spoken + run.length);
    const startFrame = words[0].item.startFrame;
    const endFrame = Math.max(words[words.length - 1].item.endFrame, startFrame + 1);
    const parts = lineParts(ocrTokens.slice(run.ocr, run.ocr + run.length).map((t) => t.item));
    const widths = parts.map((p) => {
      const b = unionBox(p.map((w) => w.bbox));
      return b[2] - b[0];
    });
    const totalWidth = widths.reduce((a, b) => a + b, 0) || 1;
    let cursor = startFrame;
    parts.forEach((part, i) => {
      const partEnd = i === parts.length - 1 ? endFrame : cursor + Math.round(((endFrame - startFrame) * widths[i]) / totalWidth);
      const at = sourceFrameAt(cursor);
      const dur = Math.max(1, sourceFrameAt(Math.max(partEnd, cursor + 1)) - at);
      const h = sanitizeHighlight({ box: padHighlightBox(unionBox(part.map((w) => w.bbox))), at, dur });
      if (h) highlights.push(h);
      cursor = partEnd;
    });
    phrases.push({ text: words.map((t) => t.item.text).join(' '), startFrame, endFrame });
  }
  if (highlights.length > 0) return { ...base, highlights, basis: 'transcript', phrases };

  // Fallback: the headline, swept once at the clip's start (line by line if it wraps).
  const headline = pickHeadline(lines);
  if (headline.length === 0) return { ...base, highlights: [], basis: 'none', phrases: [] };
  const sweepFrames = Math.max(1, Math.min(Math.round(DEFAULT_HIGHLIGHT_SWEEP_SECONDS * clipSourceFps), clipSourceFrames));
  const perLine = Math.max(1, Math.round(sweepFrames / headline.length));
  const fallback = headline
    .map((l, i) => sanitizeHighlight({ box: padHighlightBox(l.bbox), at: clipSourceStart + i * perLine, dur: perLine }))
    .filter((h): h is ClipHighlight => h !== null);
  return { ...base, highlights: fallback, basis: fallback.length > 0 ? 'headline' : 'none', phrases: [] };
}

/** B-269 — what a headline line looks like: real words, set horizontally, below the
 *  site chrome. The tallest box on a page is often NOT the headline — a logo in the
 *  nav bar, a vertical sidebar strip, or text inside a photo — so the bare
 *  "largest line" rule highlighted those. */
export const HEADLINE_MIN_WORDS = 3;
/** Lines whose top sits above this fraction of the image are site chrome (logo, nav). */
export const HEADLINE_CHROME_BAND = 0.07;
/** A text line is at least this many times wider than it is tall. */
export const HEADLINE_MIN_ASPECT = 3;
/** A headline line spans at least this fraction of the image width: narrower lines are
 *  sidebar items, ads and captions (a BleepingComputer sidebar ad won before this). */
export const HEADLINE_MIN_WIDTH = 0.18;
/** Wrapped headline lines are within this ratio of the first line's height. */
const HEADLINE_SAME_SIZE = 0.2;
/** At most this many wrapped lines are swept as one headline. */
const HEADLINE_MAX_LINES = 3;

/** B-269 — the headline: the largest-type line that looks like a headline, plus the
 *  lines directly beneath it set at the same size (its wrapped continuation), in
 *  reading order. Empty when nothing on the picture looks like a headline. */
export function pickHeadline(lines: readonly OcrLine[]): OcrLine[] {
  const height = (l: OcrLine) => l.bbox[3] - l.bbox[1];
  const width = (l: OcrLine) => l.bbox[2] - l.bbox[0];
  const candidates = lines.filter(
    (l) =>
      height(l) > 0 &&
      width(l) > 0 &&
      l.bbox[1] >= HEADLINE_CHROME_BAND &&
      width(l) >= HEADLINE_MIN_ASPECT * height(l) &&
      width(l) >= HEADLINE_MIN_WIDTH &&
      l.words.filter((w) => normaliseToken(w.text).length > 0).length >= HEADLINE_MIN_WORDS,
  );
  if (candidates.length === 0) return [];
  const top = [...candidates].sort((a, b) => height(b) - height(a) || width(b) - width(a))[0];
  // Wrapped lines of the same headline: same type size, stacked directly on one
  // another, in the same column. Grow the block up from `top`, then down.
  const sameBlock = (a: OcrLine, b: OcrLine) =>
    Math.abs(height(a) - height(top)) <= HEADLINE_SAME_SIZE * height(top) &&
    a.bbox[0] < b.bbox[2] &&
    a.bbox[2] > b.bbox[0];
  const byY = [...candidates].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const block = [top];
  for (let i = byY.indexOf(top) - 1; i >= 0 && block.length < HEADLINE_MAX_LINES; i--) {
    const l = byY[i];
    if (sameBlock(l, block[0]) && block[0].bbox[1] - l.bbox[3] <= height(top) * 0.8) block.unshift(l);
  }
  for (let i = byY.indexOf(top) + 1; i < byY.length && block.length < HEADLINE_MAX_LINES; i++) {
    const l = byY[i];
    const last = block[block.length - 1];
    if (sameBlock(l, last) && l.bbox[1] - last.bbox[3] <= height(top) * 0.8) block.push(l);
  }
  return block;
}
