/**
 * `@apelles/editor` — dark regions: plan the recovery, and splice it back into
 * the transcript (D-349, B-216).
 *
 * **What it is.** The pure half of "the ASR dropped some speech here, go and get
 * it." `apelles-speech`'s `dark` module says *where* the holes are; this module
 * decides *what windows to re-transcribe* and *how the recovered words rejoin
 * the transcript* that retake grouping and the Transcript panel read.
 *
 * **Why the splice, and not just a warning.** The dropped speech is not randomly
 * distributed — it lands preferentially on immediately-repeated near-duplicate
 * material, i.e. on retakes, which is exactly what `editor_detect_retakes`
 * exists to find (`docs/notes/whisper-dark-region-research.md` §2). A report
 * that merely says "there is unread speech at 365.7s" leaves the retake grouper
 * reading the same blind transcript it always did, and leaves a human to run
 * `ffmpeg` by hand. Splicing the recovered words in fixes the *input* to every
 * consumer instead of warning about the output of one.
 *
 * **What it does NOT do.** No detection (that is the Rust crate), no
 * transcription (that is the sidecar's windowed pass), no store access, no
 * React, no I/O. Pure functions over plain data — which is what makes the two
 * decisions worth arguing about (which window to re-read, and what the merged
 * transcript looks like) testable without a model in the loop.
 *
 * **Nothing here is destructive to the timeline.** A splice changes the
 * transcript this session reads; it never changes a clip, and it never touches
 * the cached whole-file transcript — [`spliceTranscript`] returns a new list.
 */

import type { Transcript, TranscriptSegment, TranscriptWord } from './mediaUnderstandingStore';

/** One located dark region, as `chroma_detect_dark_regions` puts it on the
 *  wire. Absolute SOURCE seconds throughout. */
export interface DarkRegionWire {
  start_secs: number;
  end_secs: number;
  duration_secs: number;
  /** The uncovered stretch the region was found in — wider than the region, and
   *  bounded by the transcript words either side of it. */
  stretch_start_secs: number;
  stretch_end_secs: number;
  stretch_speech_secs: number;
  rms_peak: number;
}

/** `chroma_detect_dark_regions`' result, verbatim. */
export interface DarkDetection {
  source: string;
  start_secs: number;
  duration_secs: number;
  analysed_secs: number;
  min_dark_secs: number;
  max_word_secs: number;
  model: string;
  regions: DarkRegionWire[];
  /** `null` when the range held too few well-transcribed utterances to
   *  calibrate a floor — in which case no amplitude gate was applied. */
  rms_floor: number | null;
  calibration_spans: number;
  gated_out: number;
  speech_secs: number;
  covered_secs: number;
}

/** A span of source seconds a recovery is allowed to change: one piece of an
 *  uncovered stretch — the hole itself, never the context read around it. */
export interface HoleSpan {
  startSecs: number;
  endSecs: number;
}

/** A window to re-transcribe in isolation, in absolute source seconds.
 *
 *  `startSecs`/`durationSecs` are what is READ. `holes`, when present, are
 *  what the read may CHANGE (D-387): a dark-region window reads its hole plus
 *  [`RECOVERY_CONTEXT_SECS`] of context either side, and only the words it
 *  hears inside a hole are spliced in. Absent `holes` means the whole read
 *  range replaces — the shape of a client's re-read (D-380 step 2), which asks
 *  for exactly the stretch it wants replaced. `plan` is [`RECOVERY_PLAN`] on a
 *  dark-region window, so a recovery persisted under an older plan (D-385)
 *  is recognisably stale and is not spliced. */
export interface RecoveryWindow {
  startSecs: number;
  durationSecs: number;
  holes?: HoleSpan[];
  plan?: number;
}

/**
 * The version of the window plan [`recoveryWindows`] produces. D-349's plan
 * (unversioned) read the bare stretch and replaced every word in the read
 * range; D-387's — this, version 2 — reads context and replaces only the
 * holes. A persisted recovery whose `plan` is not this one was cut and spliced
 * under different rules and is dropped on load rather than trusted
 * (`parsePersisted` in `mediaUnderstandingStore.ts`). Bump it whenever the plan
 * or the hole-scoped splice changes what a stored recovery means.
 */
export const RECOVERY_PLAN = 2;

/**
 * Context read either side of a hole (D-387).
 *
 * Measured on the four stretches D-381's recovery got wrong or partly wrong
 * (`docs/notes/asr-backends-and-harness.md` §4.3.2): with the hole read bare,
 * C038 502 s reads "we read" for "reread" and C038 836-852 s reads nothing; the
 * preceding sentence ("Word one, reread everything") is what disambiguates the
 * first, and the speech before the hole is what lets the decoder emit the false
 * start "So quick" at the end of the second. 5 s fixed the first and not the
 * second; 8-12 s fixed both. 10 s is the middle of that plateau. Context is
 * read, never spliced, so a wider value cannot overwrite a correct whole-file
 * word — which is what made a context this wide safe to adopt.
 */
export const RECOVERY_CONTEXT_SECS = 10;

/**
 * The longest hole one window is read for. A stretch longer than this is cut
 * into equal pieces, each read with its own context, so no window exceeds
 * [`MAX_RECOVERY_WINDOW_SECS`].
 */
export const MAX_RECOVERY_HOLE_SECS = 20;

/**
 * The longest window handed to one isolated pass: one hole piece plus its
 * context either side.
 *
 * D-349 sized it at 30 s against Whisper's 30 s decoding window ("a longer
 * extract would simply be chunked again"). Parakeet chunks at 120 s
 * (`ai-media/asr/parakeet_mlx.py`'s `CHUNK_DURATION_S`), so 40 s is still one
 * chunk — the whole-file chunking this recovery exists to escape is not
 * reintroduced. 40 = [`MAX_RECOVERY_HOLE_SECS`] + 2 × [`RECOVERY_CONTEXT_SECS`].
 */
export const MAX_RECOVERY_WINDOW_SECS = MAX_RECOVERY_HOLE_SECS + 2 * RECOVERY_CONTEXT_SECS;

/**
 * The windows to re-transcribe for a set of detected regions.
 *
 * **One hole per STRETCH, not per region** — the stretch is the span between
 * the transcript words either side of the hole, so it is exactly "the audio
 * nobody has read." Several regions inside one stretch (a dropped take split by
 * a pause) share one hole and one pass.
 *
 * **Each window reads its hole plus context, and may change only the hole**
 * (D-387). Before D-387 a window was the bare stretch (grown to 4 s when
 * shorter), and the splice replaced every word whose midpoint the window held.
 * Two measured faults followed: a long stretch was read with no context at all
 * (C038 836-852 s came back empty), and the 4 s growth cut into the
 * neighbouring words, whose truncated re-read then replaced the whole-file
 * word (C038's "everything." at 501.2 s was deleted from the transcript).
 * Context is now [`RECOVERY_CONTEXT_SECS`] either side, and the splice is
 * scoped to `holes`. (D-349's 4 s minimum window went with it: a window is now
 * at least its hole plus whatever context the clip's range allows, which is
 * the most context there is to give.)
 *
 * Windows are clamped to `[rangeStartSecs, rangeStartSecs + rangeSecs)` — the
 * clip's own trimmed source range — so a recovery never reads material the
 * edit does not contain. Windows whose read ranges touch are merged (their
 * holes kept separately) while the union stays within
 * [`MAX_RECOVERY_WINDOW_SECS`], so nearby holes cost one pass. Returned in time
 * order; holes never overlap one another, read ranges may.
 */
export function recoveryWindows(
  regions: readonly DarkRegionWire[],
  rangeStartSecs: number,
  rangeSecs: number,
): RecoveryWindow[] {
  const rangeEnd = rangeStartSecs + Math.max(rangeSecs, 0);
  if (!(rangeEnd > rangeStartSecs)) return [];

  // Deduplicate by stretch: regions carry their stretch, and several regions in
  // one stretch must not become several passes over the same audio.
  const stretches = new Map<string, { start: number; end: number }>();
  for (const r of regions) {
    const start = Math.max(r.stretch_start_secs, rangeStartSecs);
    const end = Math.min(r.stretch_end_secs, rangeEnd);
    if (!(end > start)) continue;
    stretches.set(`${r.stretch_start_secs}|${r.stretch_end_secs}`, { start, end });
  }

  const windows: RecoveryWindow[] = [];
  for (const { start, end } of Array.from(stretches.values()).sort((a, b) => a.start - b.start)) {
    for (const hole of splitLong(start, end)) {
      const readStart = Math.max(rangeStartSecs, hole.start - RECOVERY_CONTEXT_SECS);
      const readEnd = Math.min(rangeEnd, hole.end + RECOVERY_CONTEXT_SECS);
      windows.push({
        startSecs: readStart,
        durationSecs: readEnd - readStart,
        holes: [{ startSecs: hole.start, endSecs: hole.end }],
        plan: RECOVERY_PLAN,
      });
    }
  }

  // Merging keeps nearby holes to one pass. **Never past the maximum**, or this
  // would hand the recogniser back the long window the split spared it.
  const merged: RecoveryWindow[] = [];
  for (const w of windows.sort((a, b) => a.startSecs - b.startSecs)) {
    const last = merged[merged.length - 1];
    const lastEnd = last ? last.startSecs + last.durationSecs : 0;
    const union = last ? Math.max(lastEnd, w.startSecs + w.durationSecs) - last.startSecs : 0;
    if (last && w.startSecs <= lastEnd && union <= MAX_RECOVERY_WINDOW_SECS + 1e-9) {
      last.durationSecs = union;
      last.holes = [...(last.holes ?? []), ...(w.holes ?? [])];
    } else {
      merged.push({ ...w, holes: [...(w.holes ?? [])] });
    }
  }
  return merged;
}

/** A stretch longer than [`MAX_RECOVERY_HOLE_SECS`], cut into equal pieces at
 *  most that long. Equal rather than greedy so no piece is a sliver. */
function splitLong(start: number, end: number): Array<{ start: number; end: number }> {
  const span = end - start;
  if (span <= MAX_RECOVERY_HOLE_SECS) return [{ start, end }];
  const pieces = Math.ceil(span / MAX_RECOVERY_HOLE_SECS);
  const each = span / pieces;
  return Array.from({ length: pieces }, (_, i) => ({
    start: start + i * each,
    end: i === pieces - 1 ? end : start + (i + 1) * each,
  }));
}

/** One window's recovered transcript, as the store holds it. */
export interface RecoveredWindow {
  window: RecoveryWindow;
  /** The isolated pass's segments, already in absolute source seconds — the
   *  sidecar shifts them (D-349), so nothing here re-derives an offset. */
  segments: TranscriptSegment[];
}

/** A transcript segment that came from a recovery pass rather than from the
 *  whole-file one. The flag is not decoration: a human reading the Transcript
 *  panel is entitled to know which words appeared because the app went back for
 *  them, and a caller comparing two runs needs to tell a splice from a model
 *  change. */
export interface SplicedSegment extends TranscriptSegment {
  recovered?: true;
}

/**
 * The transcript as it should be read, with every recovered window spliced in.
 *
 * **What a window may change.** A dark-region window (D-387) carries `holes`:
 * the uncovered stretches it was read for. Only those change — whole-file
 * words whose midpoint lies in a hole are replaced (by construction there are
 * none with real duration, only the zero-width words of a timestamp collapse),
 * and only the recovered words whose midpoint lies in a hole are added. The
 * context the window also read is evidence for the decoder, never a
 * replacement for the whole-file pass's words there: before D-387 a window's
 * edge could cut a neighbouring word in half, and the half-word re-read
 * replaced the whole one. A window without `holes` — a client's re-read
 * (D-380 step 2) — replaces its whole read range, as it always has.
 *
 * **At WORD granularity.** Everything outside the spans is untouched,
 * including the rest of a segment that merely straddles an edge — which is why
 * the trim is per word rather than per segment. A recovered word that repeats
 * the kept word it overlaps (same text, overlapping time — the same spoken word
 * timed a few frames differently by the two passes) is not added a second time.
 *
 * A transcript with no word timings cannot be trimmed that finely, so a segment
 * is dropped only when it lies wholly inside a span, and a recovered segment
 * without words is added only when its midpoint is in one. That is the honest
 * fallback rather than a silent approximation; every caller in this repo asks
 * for word timings.
 *
 * **Windows are applied in the order given, and a later one wins** (D-380 step
 * 2). Each window trims every word already in the list — the whole-file pass's
 * and any earlier window's — whose midpoint its spans hold, then adds its own.
 * Dark-region holes are disjoint by construction; the order matters for a
 * client's re-read (`editor_retranscribe_words`), which may overlap an earlier
 * recovery or re-read and must replace those words rather than sit beside them.
 *
 * Pure: `segments` is not mutated, and the same inputs give the same output in
 * the same order.
 */
export function spliceTranscript(
  segments: readonly TranscriptSegment[],
  recovered: readonly RecoveredWindow[],
): SplicedSegment[] {
  let out: SplicedSegment[] = segments.map((s) => ({ ...s }));
  for (const r of recovered) {
    const spans = spliceSpans(r.window);
    // An empty window read nothing and replaces nothing.
    if (spans.length === 0) continue;
    for (const span of spans) out = trimWindow(out, span);
    const inSpan = (start: number, end: number) => {
      const mid = (start + end) / 2;
      return spans.some((sp) => mid >= sp.start && mid < sp.end);
    };
    const kept = out.flatMap((s) => s.words ?? []);
    for (const s of r.segments) {
      if (!s.text.trim()) continue;
      const words = s.words ?? [];
      if (words.length === 0) {
        if (inSpan(s.start, s.end)) out.push({ ...s, recovered: true });
        continue;
      }
      const taken = words.filter(
        (w) => inSpan(w.start, w.end) && !kept.some((k) => sameSpokenWord(k, w)),
      );
      if (taken.length === 0) continue;
      out.push({ ...rebuilt(s, taken), recovered: true });
    }
  }

  // Stable by start, then by end — two segments starting on the same instant
  // (a recovered one landing exactly on a kept boundary) read in the order a
  // person would say them.
  return out.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
}

/** The spans a window may change: its `holes` when it has them, else its whole
 *  read range. Empty spans are dropped. */
function spliceSpans(w: RecoveryWindow): Array<{ start: number; end: number }> {
  const spans = w.holes
    ? w.holes.map((h) => ({ start: h.startSecs, end: h.endSecs }))
    : [{ start: w.startSecs, end: w.startSecs + w.durationSecs }];
  return spans.filter((sp) => sp.end > sp.start);
}

/** A word's text with case, punctuation and the leading space removed — enough
 *  to tell "Plus" and " plus," apart from "Plus" and "the". */
function normalisedWord(w: TranscriptWord): string {
  return w.word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

/** The same spoken word, read by two passes: same normalised text, and the two
 *  timings overlap. */
function sameSpokenWord(a: TranscriptWord, b: TranscriptWord): boolean {
  return a.end > b.start && b.end > a.start && normalisedWord(a) === normalisedWord(b) && normalisedWord(a) !== '';
}

/** `s` rebuilt from a subset of its own words, so `text`/`start`/`end` cannot
 *  disagree with them. */
function rebuilt(s: SplicedSegment, words: TranscriptWord[]): SplicedSegment {
  return {
    ...s,
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join('').trim(),
    words,
  };
}

/** One span's trim, the word-granular rule [`spliceTranscript`] documents:
 *  a segment the span does not overlap is untouched; one with words keeps
 *  the words whose MIDPOINT is outside it (an endpoint test would drop a word
 *  that merely abuts the edge), rebuilt from them; one without word timings is
 *  dropped only when wholly inside. Flags such as `recovered` survive. */
function trimWindow(
  segments: readonly SplicedSegment[],
  win: { start: number; end: number },
): SplicedSegment[] {
  const wordInside = (w: TranscriptWord) => {
    const mid = (w.start + w.end) / 2;
    return mid >= win.start && mid < win.end;
  };
  const out: SplicedSegment[] = [];
  for (const s of segments) {
    // Inclusive at the start: a zero-width word (a timestamp collapse) sitting
    // exactly on the span's first instant is inside it, and is judged below.
    if (s.end < win.start || s.start >= win.end) {
      out.push(s);
      continue;
    }
    const words = s.words ?? [];
    if (words.length === 0) {
      // No word timings: all-or-nothing is the only honest call.
      if (!(s.start >= win.start && s.end <= win.end)) out.push(s);
      continue;
    }
    const kept = words.filter((w) => !wordInside(w));
    if (kept.length === 0) continue;
    out.push(rebuilt(s, kept));
  }
  return out;
}

/** [`spliceTranscript`] applied to a whole [`Transcript`], for the consumers
 *  that take one (the Transcript panel, `editor_get_timeline_transcript`).
 *
 *  `text` is rebuilt from the spliced segments rather than carried over: a
 *  transcript whose `text` disagreed with its own `segments` would be a worse
 *  artefact than either. */
export function spliceTranscriptDoc(
  transcript: Transcript,
  recovered: readonly RecoveredWindow[],
): Transcript {
  if (recovered.length === 0) return transcript;
  const segments = spliceTranscript(transcript.segments ?? [], recovered);
  return {
    ...transcript,
    segments,
    text: segments.map((s) => s.text.trim()).filter(Boolean).join(' '),
    words: segments.flatMap((s) => s.words ?? []),
  };
}

/** How many segments in a spliced list came from a recovery pass — the one
 *  number a panel or a tool response needs to say "this transcript is not the
 *  one the ASR handed us." */
export function recoveredCount(segments: readonly SplicedSegment[]): number {
  return segments.filter((s) => s.recovered).length;
}

/**
 * The located regions that are still unread after every recovery (D-387).
 *
 * A region is READ when some word of the spliced transcript overlaps it — a
 * recovered word, or a zero-width whole-file word sitting inside it (a
 * timestamp collapse: the text is present), or a segment without word timings
 * spanning it. Anything else is speech-like
 * sound the VAD hears and no transcription pass could put words to — measured
 * on C038 839.5 s and 843.5 s: isolated half-second voiced bursts that neither
 * Parakeet at any window nor Whisper transcribed. Such a region is not an
 * error and must not be silent either: it is reported to the person and the
 * agent so nobody cuts across it believing the transcript is complete.
 *
 * Pure; regions are returned in the order given.
 */
export function unreadRegions(
  regions: readonly DarkRegionWire[],
  spliced: readonly TranscriptSegment[],
): DarkRegionWire[] {
  // A segment without word timings reads its whole span — the same honest
  // fallback the splice uses for it.
  const words = spliced.flatMap((s) =>
    s.words?.length ? s.words : [{ word: s.text, start: s.start, end: s.end }],
  );
  return regions.filter(
    (r) =>
      !words.some((w) =>
        w.end > w.start
          ? w.start < r.end_secs && w.end > r.start_secs
          : w.start >= r.start_secs && w.start < r.end_secs,
      ),
  );
}
