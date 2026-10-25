/**
 * @apelles/editor — clip highlights, the "highlighter pen" sweep (D-396).
 *
 * What it is: the TypeScript mirror of `apelles_timeline::highlight` — the
 * `ClipHighlight` shape (`Clip.highlights`), its defaults, and the pure helpers
 * every TS consumer shares: the `set_clip_highlights` reducer's sanitiser, the
 * MCP op's validator, the on-canvas overlay's progress read-out and the
 * exporter's expression compiler.
 *
 * What it does NOT do: no drawing (the Rust compositor and the exporter's
 * `geq` node draw), no OCR, no transcript matching (`highlightSuggest.ts`).
 * Pure, no I/O, no React.
 *
 * Why a mirror of Rust constants at all: the same reason `easeCurve.ts` and
 * `eq.ts` carry one — the render path resolves in Rust, the exporter compiles
 * the identical numbers into ffmpeg, and the GUI has to draw the same box. The
 * constants are pinned to their Rust twins by `clipHighlights.test.ts`.
 */

import { easeCurveEval } from './easeCurve';
import type { EaseCurve } from './timeline';

/** One phrase highlight — mirrors `apelles_timeline::highlight::Highlight`. */
export interface ClipHighlight {
  /** `[x0, y0, x1, y1]` as fractions of the SOURCE image, top-left origin. */
  box: [number, number, number, number];
  /** The clip SOURCE frame the sweep starts on (a keyframe's frame axis). */
  at: number;
  /** Frames the sweep takes; `0` is an instant reveal at `at`. */
  dur: number;
  /** `#RRGGBB` / `#RGB`; absent = [`DEFAULT_HIGHLIGHT_COLOR`]. */
  color?: string;
  /** `0..=1`; absent = [`DEFAULT_HIGHLIGHT_OPACITY`]. */
  opacity?: number;
}

/** Highlighter yellow-ochre — `DEFAULT_HIGHLIGHT_COLOR` in Rust. */
export const DEFAULT_HIGHLIGHT_COLOR = '#F2B63A';
/** `DEFAULT_HIGHLIGHT_OPACITY` in Rust. */
export const DEFAULT_HIGHLIGHT_OPACITY = 0.45;
/** CSS ease-out-cubic — `HIGHLIGHT_SWEEP_EASE` in Rust. */
export const HIGHLIGHT_SWEEP_EASE: EaseCurve = { x1: 0.215, y1: 0.61, x2: 0.355, y2: 1 };
/** Leading-end rounding as a fraction of the box height —
 *  `HIGHLIGHT_TIP_ROUNDING` in Rust. */
export const HIGHLIGHT_TIP_ROUNDING = 0.25;
/** The default sweep length (seconds) the GUI and the suggester give a new
 *  highlight when nothing says how long the phrase is spoken for. */
export const DEFAULT_HIGHLIGHT_SWEEP_SECONDS = 0.6;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Whether `s` is a colour the renderers accept (`#RGB` or `#RRGGBB`). */
export function isHighlightColor(s: unknown): s is string {
  return typeof s === 'string' && HEX_COLOR.test(s);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The box with ordered corners clamped to `0..1`, or `null` when it has no
 *  area or a non-finite edge — `Highlight::normalised_box` in Rust. */
export function normalisedHighlightBox(
  box: readonly number[],
): [number, number, number, number] | null {
  if (box.length !== 4 || !box.every(Number.isFinite)) return null;
  const x0 = clamp01(Math.min(box[0], box[2]));
  const x1 = clamp01(Math.max(box[0], box[2]));
  const y0 = clamp01(Math.min(box[1], box[3]));
  const y1 = clamp01(Math.max(box[1], box[3]));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/** How far the pen has travelled at `sourceFrame`, `0..1`, eased —
 *  `Highlight::progress_at` in Rust. */
export function highlightProgressAt(h: Pick<ClipHighlight, 'at' | 'dur'>, sourceFrame: number): number {
  if (sourceFrame < h.at) return 0;
  if (h.dur <= 0 || sourceFrame >= h.at + h.dur) return 1;
  return easeCurveEval(HIGHLIGHT_SWEEP_EASE, (sourceFrame - h.at) / h.dur);
}

/** One highlight as the model stores it: a normalised box, whole non-negative
 *  frames, a valid colour or none, an opacity in `0..1` or none. `null` when the
 *  box cannot be drawn at all. The reducer applies this to everything it is
 *  handed, so no path (GUI, MCP, undo replay) can persist an unrenderable
 *  entry. */
export function sanitizeHighlight(h: ClipHighlight): ClipHighlight | null {
  const box = normalisedHighlightBox(h.box);
  if (!box || !Number.isFinite(h.at) || !Number.isFinite(h.dur)) return null;
  const out: ClipHighlight = {
    box,
    at: Math.max(0, Math.round(h.at)),
    dur: Math.max(0, Math.round(h.dur)),
  };
  if (isHighlightColor(h.color)) out.color = h.color;
  if (typeof h.opacity === 'number' && Number.isFinite(h.opacity)) out.opacity = clamp01(h.opacity);
  return out;
}

/** Validate caller-supplied highlights (the MCP op, the Inspector's text
 *  fields), naming the first problem rather than silently dropping an entry.
 *  Returns the sanitised list on success. */
export function validateHighlights(
  raw: unknown,
): { highlights: ClipHighlight[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'highlights must be an array' };
  const out: ClipHighlight[] = [];
  for (let i = 0; i < raw.length; i++) {
    const h = raw[i] as Partial<ClipHighlight> | null;
    const where = `highlights[${i}]`;
    if (!h || typeof h !== 'object') return { error: `${where} must be an object` };
    if (!Array.isArray(h.box) || h.box.length !== 4 || !h.box.every((v) => typeof v === 'number')) {
      return { error: `${where}.box must be [x0, y0, x1, y1], four numbers (fractions of the image)` };
    }
    if (!normalisedHighlightBox(h.box)) {
      return { error: `${where}.box has no area (x1 must differ from x0, y1 from y0, all finite)` };
    }
    if (typeof h.at !== 'number' || !Number.isFinite(h.at) || h.at < 0) {
      return { error: `${where}.at must be a clip source frame >= 0` };
    }
    if (typeof h.dur !== 'number' || !Number.isFinite(h.dur) || h.dur < 0) {
      return { error: `${where}.dur must be a frame count >= 0` };
    }
    if (h.color !== undefined && !isHighlightColor(h.color)) {
      return { error: `${where}.color must be #RGB or #RRGGBB` };
    }
    if (h.opacity !== undefined && (typeof h.opacity !== 'number' || !(h.opacity >= 0 && h.opacity <= 1))) {
      return { error: `${where}.opacity must be between 0 and 1` };
    }
    const clean = sanitizeHighlight(h as ClipHighlight);
    if (!clean) return { error: `${where} cannot be drawn` };
    out.push(clean);
  }
  return { highlights: out };
}

/** `#RGB`/`#RRGGBB` → `[r, g, b]` 0..255, falling back to the default colour on
 *  anything else — `Highlight::rgb` in Rust. */
export function highlightRgb(color: string | undefined): [number, number, number] {
  const hex = (isHighlightColor(color) ? color : DEFAULT_HIGHLIGHT_COLOR).slice(1);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}
