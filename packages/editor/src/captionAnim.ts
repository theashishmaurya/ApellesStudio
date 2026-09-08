// @chroma/editor — animated caption presets: the per-word model and its
// evaluation (D-241, `docs/notes/caption-presets.md`).
//
// **What it is:** the exact TypeScript mirror of
// `chroma_timeline::caption_anim` — when each word of a cue is "spoken", and
// what a renderer should draw for it at a given moment.
//
// **What it does NOT do:** no rendering, no font measurement, no ffmpeg.
// Compiling the animation into a filtergraph is `timelineExport.ts`; drawing
// it live is the Rust side's `chroma::caption_render`.
//
// ## Why this file is a mirror rather than a shared package
//
// The same reason `caption.ts` is one (see its header, and B-079): the Rust
// preview path and this TypeScript edit/export path are two different runtimes
// that must resolve identical numbers for the identical cue, and there is no
// shared language between them. What keeps a mirror honest is that both sides
// assert the SAME fixtures — `state_numbers_are_the_documented_arithmetic` in
// `crates/chroma-timeline/src/caption_anim.rs` and
// `captionWordState matches the Rust fixture exactly` in `captionAnim.test.ts`.
// If one side's arithmetic ever drifts, exactly one of those two fails.
//
// ## The vocabulary is deliberately small — see the Rust module's own doc
//
// Alpha, dx/dy, a discrete per-phase fill colour and a highlight box are in;
// **scale is deliberately out**, because ffmpeg's `fontsize` is the input to
// the very measurement that makes the two engines agree (D-212), so animating
// it re-opens the divergence D-229 closed. That table lives in the Rust
// module doc rather than being duplicated here.

import type { CaptionStyle } from './caption';

/** Per-word entrance duration, seconds. Mirrors the Rust constant. */
export const DEFAULT_CAPTION_ENTER_SECS = 0.12;
/** Rise distance of an entering word, as a fraction of the font size. */
export const DEFAULT_CAPTION_ENTER_RISE = 0.22;
/** Extra tracking between words, as a fraction of the font size — the
 *  per-word path's stand-in for a space. A fraction rather than the face's own
 *  space advance because a space advance is a FONT METRIC, and no font metric
 *  is allowed to decide layout (see `caption.ts`'s `captionLayout`). */
export const DEFAULT_CAPTION_WORD_GAP = 0.28;
/** Horizontal padding of the active-word box, fraction of the font size. */
export const DEFAULT_CAPTION_ACTIVE_BOX_PAD_X = 0.15;
/** Vertical padding of the active-word box, fraction of the font size. */
export const DEFAULT_CAPTION_ACTIVE_BOX_PAD_Y = 0.075;

/** What an animated caption does, per word — mirrors
 *  `chroma_timeline::caption_anim::CaptionAnimKind`.
 *
 *  A closed set rather than a composable effect graph: every kind is
 *  implemented TWICE, pixel-compatibly, and five is auditable where an
 *  open-ended effect language is not. */
export type CaptionAnimKind =
  /** No animation — D-229's static, whole-cue caption, one `drawtext` per
   *  LINE. The default, and what every pre-D-241 project deserialises to. */
  | 'none'
  /** Line stays up; the active word gets a filled box behind it. The box is
   *  SQUARE — ffmpeg's `drawbox` has no corner radius, so a rounded one would
   *  be a preview the export cannot reproduce (D-241). */
  | 'highlight'
  /** Line stays up; words recolour as they are spoken, active word may
   *  additionally carry a pill. */
  | 'karaoke'
  /** One word at a time, alone on frame, sliding in from an alternating
   *  side. */
  | 'slam'
  /** The line builds word by word; each rises and fades into place. */
  | 'build';

/** Whether `kind` draws the cue word by word rather than line by line — the
 *  one branch every renderer keys off. `'none'` keeps D-229's original path
 *  exactly, which is what makes every existing project render unchanged. */
export function isPerWordAnim(kind: CaptionAnimKind): boolean {
  return kind !== 'none';
}

/** Whether `kind` shows only the active word rather than the whole line. */
export function isSingleWordAnim(kind: CaptionAnimKind): boolean {
  return kind === 'slam';
}

/** How an animated caption behaves — mirrors
 *  `chroma_timeline::caption_anim::CaptionAnimation` field for field.
 *
 *  Every field optional and defaulted through `resolveCaptionAnimation`, the
 *  same convention `CaptionStyle` follows: a style saved before a field
 *  existed must round-trip unchanged.
 *
 *  **A preset is nothing more than a `CaptionStyle` carrying one of these**,
 *  which is why every value a preset sets stays editable afterwards — it is
 *  data applied through the existing `set_caption_style` op, not a baked-in
 *  look (owner, 2026-09-08: "keep the style configurable as much as
 *  possible"). */
export interface CaptionAnimation {
  kind?: CaptionAnimKind;
  /** Fill of the word being spoken. Absent = the style's own `color`. */
  active_color?: string | null;
  /** Fill of words already spoken. Absent = the style's own `color`. */
  spoken_color?: string | null;
  /** Fill of words not yet spoken. Absent = the style's own `color`. */
  upcoming_color?: string | null;
  /** Box behind the active word. Absent = no box at all — what distinguishes
   *  a pure recolour karaoke from a highlight. */
  active_box_color?: string | null;
  /** `0..1`. */
  active_box_opacity?: number;
  /** Fraction of the font size. */
  active_box_pad_x?: number;
  /** Fraction of the font size. */
  active_box_pad_y?: number;
  /** Seconds. */
  enter_secs?: number;
  /** Fraction of the font size. `0` = a pure fade. */
  enter_rise?: number;
  /** Fraction of the font size. */
  word_gap?: number;
}

/** Every default filled in — the mirror of reading a Rust
 *  `CaptionStyle::animation_or_default()`.
 *
 *  A non-finite number degrades to its default rather than poisoning the
 *  arithmetic downstream, exactly as the Rust side does. */
export function resolveCaptionAnimation(
  a?: CaptionAnimation | null,
): Required<Omit<CaptionAnimation, 'active_color' | 'spoken_color' | 'upcoming_color' | 'active_box_color'>> & {
  active_color: string | null;
  spoken_color: string | null;
  upcoming_color: string | null;
  active_box_color: string | null;
} {
  const s = a ?? {};
  const num = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    kind: s.kind ?? 'none',
    active_color: s.active_color ?? null,
    spoken_color: s.spoken_color ?? null,
    upcoming_color: s.upcoming_color ?? null,
    active_box_color: s.active_box_color ?? null,
    active_box_opacity: num(s.active_box_opacity, 1),
    active_box_pad_x: num(s.active_box_pad_x, DEFAULT_CAPTION_ACTIVE_BOX_PAD_X),
    active_box_pad_y: num(s.active_box_pad_y, DEFAULT_CAPTION_ACTIVE_BOX_PAD_Y),
    enter_secs: num(s.enter_secs, DEFAULT_CAPTION_ENTER_SECS),
    enter_rise: num(s.enter_rise, DEFAULT_CAPTION_ENTER_RISE),
    word_gap: num(s.word_gap, DEFAULT_CAPTION_WORD_GAP),
  };
}

/** The resolved animation of a style — the mirror of
 *  `CaptionStyle::animation_or_default`. Read animations through this, never
 *  off the field directly, so an absent key and an explicit `kind: 'none'` are
 *  provably the same render. */
export function captionAnimationOf(style: CaptionStyle | null | undefined) {
  return resolveCaptionAnimation(style?.animation);
}

/** One word of a cue with the time window it owns — mirrors
 *  `chroma_timeline::caption_anim::CaptionWord`.
 *
 *  `start`/`end` are CLIP-LOCAL seconds, so a cue that is moved or rippled
 *  keeps its word timings unchanged. */
export interface CaptionWord {
  /** Index within its LINE. */
  index: number;
  /** Which line of the cue this word is on. */
  line: number;
  text: string;
  start: number;
  end: number;
}

/** Split a cue's lines into words with derived time windows — the exact mirror
 *  of `caption_words`.
 *
 *  A `.srt` cue carries no word timings, so each word takes a share of
 *  `durSecs` proportional to its character count, taken over the WHOLE cue
 *  rather than per line (so a two-line cue reads at one rate instead of
 *  speeding up on the shorter line).
 *
 *  A non-positive or non-finite `durSecs` yields all-zero windows; every
 *  renderer then treats the LAST word as active — a stable, visible
 *  degradation rather than a division by zero. */
export function captionWords(lines: string[], durSecs: number): CaptionWord[] {
  const words: CaptionWord[] = [];
  lines.forEach((line, lineIndex) => {
    const parts = line.split(/\s+/).filter((w) => w !== '');
    parts.forEach((text, index) => {
      words.push({ index, line: lineIndex, text, start: 0, end: 0 });
    });
  });
  if (words.length === 0) return words;
  const charsOf = (w: CaptionWord) => Math.max(1, [...w.text].length);
  const total = words.reduce((n, w) => n + charsOf(w), 0);
  if (!Number.isFinite(durSecs) || durSecs <= 0 || total === 0) return words;
  // Cumulative INTEGER character counts, converted to seconds only at the end
  // — so the windows tile the cue exactly with no accumulated float drift and
  // the last word's `end` is exactly `durSecs`.
  let consumed = 0;
  for (const w of words) {
    const start = consumed;
    consumed += charsOf(w);
    w.start = (durSecs * start) / total;
    w.end = (durSecs * consumed) / total;
  }
  return words;
}

/** Which of the three colour states a word is in — mirrors
 *  `CaptionWordPhase`. */
export type CaptionWordPhase = 'upcoming' | 'active' | 'spoken';

/** What to draw for one word at one moment — mirrors `CaptionWordState`.
 *
 *  Holds a PHASE rather than a resolved colour because the export resolves a
 *  phase to a separate `drawtext` node rather than to a value (`fontcolor` is
 *  not an ffmpeg expression). */
export interface CaptionWordState {
  visible: boolean;
  /** `0..1`. */
  alpha: number;
  /** Fractions of the font size; positive is DOWN. */
  dy: number;
  /** Fractions of the font size. */
  dx: number;
  phase: CaptionWordPhase;
  /** `0..1`; `0` whenever no box should be drawn at all. */
  box_alpha: number;
}

/** Cubic ease-out — `1 - (1 - t)^3`, GSAP's `power3.out`.
 *
 *  Written out rather than pulled from a curve library because it must be
 *  evaluated identically in Rust, here, AND as an ffmpeg expression string; a
 *  closed-form polynomial is the only shape that is obviously the same
 *  function in all three. Clamped, so callers need not clamp. */
export function easeOutCubic(t: number): number {
  if (!Number.isFinite(t)) return 1;
  const c = Math.min(1, Math.max(0, t));
  const inv = 1 - c;
  return 1 - inv * inv * inv;
}

/** Index of the word active at clip-local `tSecs` — mirrors
 *  `caption_active_word`.
 *
 *  "The last word whose window has opened" rather than "the word containing
 *  `t`", so a `t` past the end of the cue keeps the final word active instead
 *  of blanking the caption — which matters because a clip's last frame lands
 *  exactly on its own duration. */
export function captionActiveWord(words: CaptionWord[], tSecs: number): number {
  const t = Number.isFinite(tSecs) ? tSecs : 0;
  let active = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (t >= words[i].start) active = i;
  }
  return active;
}

/** Evaluate `words[index]`'s state at clip-local `tSecs` — the exact mirror of
 *  `caption_word_state`, and the contract both renderers implement. */
export function captionWordState(
  words: CaptionWord[],
  index: number,
  anim: ReturnType<typeof resolveCaptionAnimation>,
  tSecs: number,
): CaptionWordState {
  const word = words[index];
  if (!word) {
    return { visible: false, alpha: 0, dy: 0, dx: 0, phase: 'upcoming', box_alpha: 0 };
  }
  const t = Number.isFinite(tSecs) ? tSecs : 0;
  const enter = Number.isFinite(anim.enter_secs) && anim.enter_secs > 0 ? anim.enter_secs : 0;

  const activeIndex = captionActiveWord(words, t);
  const phase: CaptionWordPhase =
    index < activeIndex ? 'spoken' : index === activeIndex ? 'active' : 'upcoming';

  const sinceStart = t - word.start;
  const entered = enter <= 0 ? (sinceStart >= 0 ? 1 : 0) : easeOutCubic(sinceStart / enter);

  switch (anim.kind) {
    // Never reached by a renderer (both branch on `isPerWordAnim` first), but
    // defined so the function is total.
    case 'none':
      return { visible: true, alpha: 1, dy: 0, dx: 0, phase, box_alpha: 0 };
    case 'slam': {
      const visible = phase === 'active';
      // Alternate the entry side by word index — what makes a run of slams
      // read as kinetic rather than as one repeated move.
      const side = index % 2 === 0 ? -1 : 1;
      return {
        visible,
        alpha: visible ? entered : 0,
        dy: 0,
        dx: visible ? side * (1 - entered) * 0.6 : 0,
        phase,
        box_alpha: 0,
      };
    }
    case 'build': {
      const visible = sinceStart >= 0;
      return {
        visible,
        alpha: visible ? entered : 0,
        dy: visible ? (1 - entered) * anim.enter_rise : anim.enter_rise,
        dx: 0,
        phase,
        box_alpha: 0,
      };
    }
    case 'highlight':
    case 'karaoke': {
      // BINARY, not ramped with `entered`: ffmpeg's `drawbox` takes a colour
      // string, not a per-frame alpha expression, so a box that faded in here
      // could not be reproduced in the export (D-241).
      const boxAlpha =
        phase === 'active' && anim.active_box_color
          ? Math.min(1, Math.max(0, anim.active_box_opacity))
          : 0;
      return { visible: true, alpha: 1, dy: 0, dx: 0, phase, box_alpha: boxAlpha };
    }
    default:
      return { visible: true, alpha: 1, dy: 0, dx: 0, phase, box_alpha: 0 };
  }
}

/** The fill colour a word takes in `phase`, falling back to the style's own
 *  colour for any phase the animation does not override.
 *
 *  One function so the preview, the export compiler and the panel's thumbnail
 *  cannot disagree about what "spoken" looks like. */
export function captionWordColor(
  phase: CaptionWordPhase,
  anim: ReturnType<typeof resolveCaptionAnimation>,
  styleColor: string,
): string {
  const pick =
    phase === 'active'
      ? anim.active_color
      : phase === 'spoken'
        ? anim.spoken_color
        : anim.upcoming_color;
  return pick ?? styleColor;
}
