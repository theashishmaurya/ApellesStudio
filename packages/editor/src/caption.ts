// @chroma/editor — subtitles / captions: the types and the shared layout
// arithmetic (D-229, `docs/notes/subtitles.md`).
//
// **What it is:** the TypeScript mirror of `chroma_timeline::caption` — the
// caption cue and style types the store and the Inspector work with, plus
// `captionLayout`, the arithmetic that decides where every line of a cue
// lands.
//
// **What it does NOT do:** no rendering, no file parsing, no ffmpeg. Reading
// `.srt`/`.vtt` is the Rust side's `chroma_timeline::subtitle_import` (reached
// through the `chroma_import_subtitles` command) — deliberately ONE parser, not
// one per language; compiling the export filtergraph is `timelineExport.ts`.
//
// ## Why this file is a mirror rather than a shared package
//
// The same reason `sourceFramesToTimeline` is one (B-079): the Rust preview
// path and this TypeScript edit/export path are two different runtimes that
// must resolve the identical integers for the identical cue, and there is no
// shared language between them. What keeps a mirror honest is that both sides
// assert the SAME fixtures — see `layout_numbers_are_the_documented_arithmetic`
// in `crates/chroma-timeline/src/caption.rs` and
// `captionLayout matches the Rust fixture exactly` in `caption.test.ts`. If
// one side's rounding ever drifts, those two tests disagree.

// A TYPE-ONLY import, deliberately: `captionAnim.ts` imports this module's
// `CaptionStyle` back, and a value import either way would be a real runtime
// cycle. The two are one model split across two files (see either header), so
// the mutual reference is intended.
import type { CaptionAnimation } from './captionAnim';

/** Font family KEY from the backend's own catalogue (`chroma_text_fonts`) —
 *  see `TextLayer.font` for why a key rather than a path. */
export const DEFAULT_CAPTION_FONT = 'sans-bold';
/** Cap size as a fraction of the composition's HEIGHT. ~59 px at 1080p. */
export const DEFAULT_CAPTION_SIZE = 0.055;
export const DEFAULT_CAPTION_COLOR = '#FFFFFF';
export const DEFAULT_CAPTION_BOX_COLOR = '#000000';
export const DEFAULT_CAPTION_BOX_OPACITY = 0.6;
/** Background-box padding as a fraction of the RESOLVED FONT SIZE. */
export const DEFAULT_CAPTION_BOX_PADDING = 0.22;
/** Extra leading between lines, as a fraction of the resolved font size. */
export const DEFAULT_CAPTION_LINE_SPACING = 0.25;
export const DEFAULT_CAPTION_POSITION_X = 0.5;
/** Where the LAST line's font line box begins, as a fraction of composition
 *  height. Extra lines stack upward from it — see `CaptionStyle.position_y`. */
export const DEFAULT_CAPTION_POSITION_Y = 0.82;

export type CaptionAlign = 'left' | 'center' | 'right';

/** How a caption is drawn — mirrors `chroma_timeline::caption::CaptionStyle`
 *  field for field.
 *
 *  Every field is optional here and defaulted server-side, the same convention
 *  `Track.gain`/`locked`/`hidden` already follow: a style saved before a field
 *  existed must round-trip unchanged. `resolveCaptionStyle` is the one place
 *  the defaults are filled in. */
export interface CaptionStyle {
  font?: string;
  /** Fraction of composition height. */
  size?: number;
  /** `#RGB` or `#RRGGBB`. */
  color?: string;
  box_enabled?: boolean;
  box_color?: string;
  /** `0..1`. */
  box_opacity?: number;
  /** Fraction of the resolved font size. */
  box_padding?: number;
  /** Fraction of the resolved font size. */
  line_spacing?: number;
  align?: CaptionAlign;
  /** Normalised horizontal anchor (fraction of composition width). */
  position_x?: number;
  /** Normalised vertical anchor (fraction of composition height) — the top of
   *  the **last** line's font line box. Extra lines stack *upward*, so a cue
   *  growing from one line to two keeps its bottom line in place. */
  position_y?: number;
  /** D-241 — how this caption ANIMATES, or absent for D-229's original static
   *  rendering. Mirrors `CaptionStyle::animation`.
   *
   *  Read it through `captionAnimationOf` (`captionAnim.ts`), never off this
   *  field directly — that is what makes an absent key and an explicit
   *  `kind: 'none'` provably the same render. */
  animation?: CaptionAnimation | null;
}

/** One caption — mirrors `chroma_timeline::caption::CaptionCue`.
 *
 *  The cue's TIMING is its clip's own `start_frame`/`duration`, not a field
 *  here: a caption is an ordinary `Clip` on a `'subtitle'` track, which is what
 *  makes every existing edit op work on it for free. */
export interface CaptionCue {
  /** The caption text. **May contain `\n`** — unlike `TextLayer.content`,
   *  which is single-line by construction. See `caption.ts`'s own header and
   *  the Rust module doc for how multi-line stays preview/export-identical. */
  text: string;
  /** Present = this cue overrides its track's style (the reference
   *  Inspector's per-caption "Use Track Style" checkbox, unticked).
   *  Absent/null = it uses `Track.caption_style`. */
  style?: CaptionStyle | null;
}

/** Every default filled in — the one place the per-cue-override → track-style
 *  → defaults chain is resolved on this side, mirroring
 *  `Timeline::resolve_visible_captions_at` on the Rust side.
 *
 *  A non-finite number degrades to its default rather than poisoning the
 *  arithmetic downstream, exactly as `CaptionLayout::resolve` does. */
export function resolveCaptionStyle(
  cue?: CaptionStyle | null,
  track?: CaptionStyle | null,
): Required<CaptionStyle> {
  const s = cue ?? track ?? {};
  const num = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    font: s.font ?? DEFAULT_CAPTION_FONT,
    size: num(s.size, DEFAULT_CAPTION_SIZE),
    color: s.color ?? DEFAULT_CAPTION_COLOR,
    box_enabled: s.box_enabled ?? true,
    box_color: s.box_color ?? DEFAULT_CAPTION_BOX_COLOR,
    box_opacity: num(s.box_opacity, DEFAULT_CAPTION_BOX_OPACITY),
    box_padding: num(s.box_padding, DEFAULT_CAPTION_BOX_PADDING),
    line_spacing: num(s.line_spacing, DEFAULT_CAPTION_LINE_SPACING),
    align: s.align ?? 'center',
    position_x: num(s.position_x, DEFAULT_CAPTION_POSITION_X),
    position_y: num(s.position_y, DEFAULT_CAPTION_POSITION_Y),
    // Carried through as-is rather than defaulted here: the animation has its
    // own resolver (`resolveCaptionAnimation`), and filling in eleven
    // animation defaults on every resolved style would make "this caption is
    // static" indistinguishable from "this caption animates with every default
    // value". `null` is the honest resolved value for a style with none.
    animation: s.animation ?? null,
  };
}

/** A cue's text split into the lines both renderers will draw — the exact
 *  mirror of `CaptionCue::lines`.
 *
 *  Tolerates CRLF and drops leading/trailing blank lines while KEEPING a blank
 *  line between two non-blank ones, so the stray trailing newline nearly every
 *  `.srt` cue carries does not become an empty line that shifts the cue. */
export function captionLines(text: string): string[] {
  const all = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const first = all.findIndex((l) => l.trim() !== '');
  if (first === -1) return [];
  let last = all.length - 1;
  while (last >= 0 && all[last].trim() === '') last -= 1;
  return all.slice(first, last + 1);
}

/** Characters in the cue, newlines excluded — the reference Inspector's
 *  "25 Characters" readout. Mirrors `CaptionCue::char_count`. */
export function captionCharCount(text: string): number {
  return [...text].filter((c) => c !== '\n' && c !== '\r').length;
}

/** Characters per second — the reference Inspector's `CPS` column, the
 *  standard subtitle readability metric. `null` for a non-positive duration
 *  rather than an infinity. Mirrors `CaptionCue::chars_per_second`. */
export function captionCps(text: string, secs: number): number | null {
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return captionCharCount(text) / secs;
}

/** One laid-out line, in composition pixels — mirrors
 *  `chroma_timeline::caption::CaptionLine`. */
export interface CaptionLineGeometry {
  index: number;
  /** Top of this line's FONT LINE BOX — `drawtext`'s `y` under
   *  `y_align=font`, and the top of the background box before padding. */
  line_top: number;
  /** Normalised horizontal anchor in composition pixels, before the alignment
   *  rule is applied to the line's measured advance width. */
  x_anchor: number;
}

/** The resolved, font-independent geometry of one cue — mirrors
 *  `chroma_timeline::caption::CaptionLayout`. */
export interface CaptionLayoutResult {
  /** `drawtext`'s `fontsize`, in composition pixels. */
  font_px: number;
  /** Vertical distance between consecutive lines' `line_top`. */
  line_step: number;
  /** `drawtext`'s `boxborderw`, in composition pixels. */
  box_padding: number;
  lines: CaptionLineGeometry[];
}

/** Resolve `style` against a `compW × compH` composition for a cue of
 *  `lineCount` lines.
 *
 *  **Every rounding here is deliberate and mirrored exactly** in
 *  `CaptionLayout::resolve` — one `Math.round` per value, in this order, so
 *  the Rust preview and this export compiler cannot produce different integers
 *  for the same cue. Note `Math.round` and Rust's `f64::round` differ on
 *  negative halves (`-0.5` → `-0` vs `-1`), which is why every value rounded
 *  here is a non-negative quantity; the one value that CAN go negative
 *  (`line_top`, for a cue pushed off the top of frame) is computed by integer
 *  subtraction AFTER its rounding, never rounded itself. */
export function captionLayout(
  style: Required<CaptionStyle>,
  compW: number,
  compH: number,
  lineCount: number,
): CaptionLayoutResult {
  const size = Math.max(0, style.size);
  const font_px = Math.max(1, Math.round(size * compH));
  const spacing = Math.max(0, style.line_spacing);
  const line_step = Math.max(1, Math.round(size * (1 + spacing) * compH));
  const box_padding = Math.max(0, Math.round(Math.max(0, style.box_padding) * font_px));
  const x_anchor = Math.round(style.position_x * compW);
  // The anchor fixes the LAST line; earlier lines stack upward.
  const last_line_top = Math.round(style.position_y * compH);
  const first_line_top = last_line_top - (Math.max(1, lineCount) - 1) * line_step;
  const lines: CaptionLineGeometry[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    lines.push({ index, line_top: first_line_top + index * line_step, x_anchor });
  }
  return { font_px, line_step, box_padding, lines };
}
