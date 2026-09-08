// @chroma/editor — per-word caption metrics for the export compiler (D-241,
// `docs/notes/caption-presets.md`).
//
// **What it is:** a module-level cache of `chroma_measure_caption_words` — the
// advance width, in composition pixels, of each word of each ANIMATED caption
// on the timeline, measured by the backend with the same `ab_glyph` walk the
// live preview rasterises with.
//
// **Why it has to exist.** An animated caption positions every WORD itself
// rather than letting either renderer lay out a line — one level below the
// move D-229 made for lines, and for the same reason: it is the only way
// `ab_glyph` and ffmpeg's `drawtext` put a word in the same place. But a
// word's x depends on the advance of every word before it, and an advance is a
// glyph measurement only the Rust side can make. So the pure export compiler
// is GIVEN the measurements, exactly as it is already given `fontFiles` —
// "the compiler stays pure, the caller supplies what only it can know"
// (D-197).
//
// **What it does NOT do:** no layout, no rendering. It answers one question
// (how wide is this word, in this face, at this size) and caches the answer.
//
// ## Why a module cache, and why it is warmed explicitly
//
// The same shape and the same reason as `textFonts.ts`: `compileEditorExportArgs`
// is SYNCHRONOUS (the export queue snapshots a job's argv at enqueue time,
// D-198), so anything it needs from the backend has to already be in memory.
// `loadCaptionMetrics(timeline, …)` is the awaited warm step, called from
// `runEditorExport` right where `loadTextFonts()` already is.
//
// Unlike the font catalogue this cache is keyed by CONTENT, not static — a
// caption's words change as it is edited — so it is additive and never
// invalidated: an entry is a measurement of an immutable (face, size, word)
// triple, which cannot go stale. Re-warming after an edit measures only the
// words that are genuinely new.

import { invoke } from '@tauri-apps/api/core';

import { captionLines } from './caption';
import { captionWords } from './captionAnim';

/** The cache key for one measurement. Exported because the export compiler
 *  looks entries up by exactly this key, and a second definition of it is the
 *  obvious way for the two to silently disagree. */
export function captionMetricKey(font: string, fontPx: number, word: string): string {
  return `${font}|${fontPx}|${word}`;
}

/** The measurements, keyed by [`captionMetricKey`]. */
export type CaptionMetrics = Record<string, number>;

let cache: CaptionMetrics = {};

/** Every (font, fontPx, word) triple the animated captions on `timeline` need
 *  measured — the pure part, so it is testable without a backend.
 *
 *  Only ANIMATED captions contribute: a static caption is drawn one whole line
 *  at a time and ffmpeg measures it itself with `text_w`, exactly as D-229
 *  left it. */
export function captionMetricRequests(
  captions: Array<{ font: string; fontPx: number; text: string; durSecs: number }>,
): Array<{ font: string; fontPx: number; words: string[] }> {
  const byFace = new Map<string, { font: string; fontPx: number; words: Set<string> }>();
  for (const c of captions) {
    const key = `${c.font}|${c.fontPx}`;
    let entry = byFace.get(key);
    if (!entry) {
      entry = { font: c.font, fontPx: c.fontPx, words: new Set() };
      byFace.set(key, entry);
    }
    for (const w of captionWords(captionLines(c.text), c.durSecs)) {
      entry.words.add(w.text);
    }
  }
  // Sorted so a given timeline always produces the same batches — the same
  // determinism rule the compiled filtergraph itself follows.
  return [...byFace.values()]
    .sort((a, b) => (a.font === b.font ? a.fontPx - b.fontPx : a.font < b.font ? -1 : 1))
    .map((e) => ({ font: e.font, fontPx: e.fontPx, words: [...e.words].sort() }))
    .filter((e) => e.words.length > 0);
}

/** Measure whatever `requests` names that is not already cached, and fold the
 *  results into the module cache.
 *
 *  A failed measurement is left ABSENT rather than defaulted to a made-up
 *  width: the export compiler refuses a caption whose metrics are missing
 *  (`captionClipsMissingMetrics`), which is a readable failure, where guessing
 *  a width would silently export a caption whose words sit somewhere other
 *  than the preview put them. */
export async function loadCaptionMetrics(
  requests: Array<{ font: string; fontPx: number; words: string[] }>,
): Promise<CaptionMetrics> {
  for (const req of requests) {
    const missing = req.words.filter(
      (w) => cache[captionMetricKey(req.font, req.fontPx, w)] === undefined,
    );
    if (missing.length === 0) continue;
    try {
      const advances = await invoke<number[]>('chroma_measure_caption_words', {
        font: req.font,
        fontPx: req.fontPx,
        words: missing,
      });
      missing.forEach((w, i) => {
        const a = advances[i];
        if (typeof a === 'number' && Number.isFinite(a)) {
          cache[captionMetricKey(req.font, req.fontPx, w)] = a;
        }
      });
    } catch {
      // Left absent deliberately — see the doc comment above.
    }
  }
  return cache;
}

/** The cache as the synchronous export compiler sees it. */
export function captionMetricsSnapshot(): CaptionMetrics {
  return cache;
}

/** Drop every cached measurement. For tests, which must not inherit another
 *  test's backend stub. */
export function resetCaptionMetrics(): void {
  cache = {};
}

/** Warm the cache for every animated caption on `timeline` — the one call
 *  `runEditorExport` makes, next to `loadTextFonts()`.
 *
 *  Takes the already-resolved caption list rather than re-deriving it, so this
 *  module never needs to know how a style resolves. */
export async function warmCaptionMetrics(
  captions: Array<{ font: string; fontPx: number; text: string; durSecs: number }>,
): Promise<CaptionMetrics> {
  return loadCaptionMetrics(captionMetricRequests(captions));
}
