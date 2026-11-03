/**
 * Text that does not fit its container (B-309), reported by `motion_validate`.
 *
 * What it is: a pure, DOM-free check. For every `text` layer that has both an
 * `x` and a `y` (so it sits at a known place, as `primitives/Text.tsx` lays it
 * out: `x` is the left / centre / right edge per `align`, `y` the top, line
 * height 1.15, wrapped at `maxWidth`), it builds the text's box and compares it
 * with its container: the smallest `shape` layer (rect, roundrect or ellipse
 * bounding box) among its siblings that holds the text's anchor point, else the
 * canvas. A text that sticks out of the container by more than a small
 * tolerance is a `text_overflow` issue on that layer.
 *
 * Measuring: the real width of a line depends on the face, which only a browser
 * can ask. The caller passes a `TextMeasurer` (the app's webview measures with a
 * canvas on fonts that are loaded); without one, or when it declines a face, the
 * check estimates from the glyph advance. A monospace face advances exactly
 * 0.6 em, so its estimate is exact; any other face is estimated and only flagged
 * past `ESTIMATE_SLACK`, so a guess never cries wolf on text that fits.
 *
 * What it does NOT do: render, follow `transform` / `anim` tracks or a layer's
 * enter animation, or know a group's own offset (a group's children are checked
 * in the group's own coordinates, which is how they are authored). Text with no
 * `x`/`y` sits in the flow and is skipped. This is a lint with a stated
 * tolerance, not a layout engine.
 */
import { formatPath, type PathSeg, type ValidationIssue } from "./issues";

/** `primitives/Text.tsx`'s `lineHeight`. */
export const TEXT_LINE_HEIGHT = 1.15;
/** `Text`'s default letter spacing, `0.01em`. */
const DEFAULT_LETTER_SPACING_EM = 0.01;
/** `Text`'s defaults for `size` and `weight`. */
const DEFAULT_SIZE = 64;
const DEFAULT_WEIGHT = 700;
/** A monospace face's advance, as a fraction of the font size. */
const MONO_ADVANCE_EM = 0.6;
/** An average proportional glyph's advance (regular / bold), as a fraction of the size. */
const PROPORTIONAL_ADVANCE_EM = 0.5;
const PROPORTIONAL_BOLD_ADVANCE_EM = 0.55;
/** Pixels of overhang ignored: sub-pixel rounding and side bearings. */
export const OVERFLOW_TOLERANCE_PX = 2;
/** Extra overhang, as a fraction of the container, ignored when the width is only estimated. */
export const ESTIMATE_SLACK = 0.12;

/** The style a line is measured in. `font` is undefined when the layer takes the theme's face. */
export interface TextStyle {
  size: number;
  weight: number;
  font: string | undefined;
  letterSpacingPx: number;
}

/** The measured width of one line, or null when this measurer cannot answer for the face. */
export type TextMeasurer = (text: string, style: TextStyle) => number | null;

const isMono = (font: string | undefined): boolean => font !== undefined && /mono|courier|consolas|menlo/i.test(font);

interface LineWidth {
  width: number;
  /** false when the width is an estimate rather than a measurement. */
  exact: boolean;
}

function lineWidth(line: string, style: TextStyle, measure: TextMeasurer | undefined): LineWidth {
  const measured = measure?.(line, style);
  if (measured !== null && measured !== undefined) return { width: measured, exact: true };
  const chars = [...line].length;
  const advance = isMono(style.font)
    ? MONO_ADVANCE_EM
    : style.weight >= 600
      ? PROPORTIONAL_BOLD_ADVANCE_EM
      : PROPORTIONAL_ADVANCE_EM;
  return {
    width: chars * (advance * style.size + style.letterSpacingPx),
    exact: isMono(style.font),
  };
}

/** Greedy word wrap of one paragraph at `maxWidth` (CSS `pre-wrap`: a word wider than the box overflows it). */
function wrapParagraph(
  paragraph: string,
  style: TextStyle,
  maxWidth: number,
  measure: TextMeasurer | undefined,
): LineWidth[] {
  const words = paragraph.split(/ +/);
  const lines: LineWidth[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    const w = lineWidth(candidate, style, measure);
    if (current !== "" && w.width > maxWidth) {
      lines.push(lineWidth(current, style, measure));
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(lineWidth(current, style, measure));
  return lines;
}

export interface TextBox {
  left: number;
  top: number;
  width: number;
  height: number;
  exact: boolean;
}

/** A `text` layer's box in its own coordinates, or null when it sits in the flow or has nothing to show. */
export function textBox(layer: Record<string, unknown>, measure?: TextMeasurer): TextBox | null {
  const { x, y, text } = layer;
  if (typeof x !== "number" || typeof y !== "number" || typeof text !== "string" || text === "") return null;
  const size = typeof layer.size === "number" && layer.size > 0 ? layer.size : DEFAULT_SIZE;
  const weight = typeof layer.weight === "number" ? layer.weight : DEFAULT_WEIGHT;
  const spacing = layer.letterSpacing;
  const letterSpacingPx =
    typeof spacing === "number"
      ? spacing
      : typeof spacing === "string" && /^-?\d*\.?\d+em$/.test(spacing.trim())
        ? Number.parseFloat(spacing) * size
        : typeof spacing === "string" && /^-?\d*\.?\d+(px)?$/.test(spacing.trim())
          ? Number.parseFloat(spacing)
          : DEFAULT_LETTER_SPACING_EM * size;
  const style: TextStyle = {
    size,
    weight,
    font: typeof layer.font === "string" ? layer.font : undefined,
    letterSpacingPx,
  };
  const maxWidth = typeof layer.maxWidth === "number" && layer.maxWidth > 0 ? layer.maxWidth : undefined;
  const lines = text
    .split("\n")
    .flatMap((paragraph) =>
      maxWidth === undefined ? [lineWidth(paragraph, style, measure)] : wrapParagraph(paragraph, style, maxWidth, measure),
    );
  const width = Math.max(...lines.map((l) => l.width));
  const align = layer.align === "center" || layer.align === "right" ? layer.align : "left";
  const left = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  return {
    left,
    top: y,
    width,
    height: lines.length * size * TEXT_LINE_HEIGHT,
    exact: lines.every((l) => l.exact),
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A `shape` layer's rectangle (its bounding box for an ellipse), or null for anything that cannot hold text. */
function shapeRect(layer: Record<string, unknown>): Rect | null {
  if (layer.use !== "shape") return null;
  const kind = layer.shape ?? "rect";
  if (kind !== "rect" && kind !== "roundrect" && kind !== "ellipse") return null;
  const { x, y, w, h } = layer;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return null;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isLayerList = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length > 0 && v.every((item) => isPlainObject(item) && typeof item.use === "string");

const px = (n: number): string => `${Math.round(n)} px`;

function overflowIssue(
  path: PathSeg[],
  layer: Record<string, unknown>,
  box: TextBox,
  container: Rect,
  containerName: string,
): ValidationIssue | null {
  const slack = box.exact ? 0 : ESTIMATE_SLACK;
  const over = (amount: number, room: number) => amount > OVERFLOW_TOLERANCE_PX + slack * room;
  const left = container.x - box.left;
  const right = box.left + box.width - (container.x + container.w);
  const top = container.y - box.top;
  const bottom = box.top + box.height - (container.y + container.h);
  const sides: string[] = [];
  if (over(left, container.w)) sides.push(`${px(left)} past the left edge`);
  if (over(right, container.w)) sides.push(`${px(right)} past the right edge`);
  if (over(top, container.h)) sides.push(`${px(top)} above the top edge`);
  if (over(bottom, container.h)) sides.push(`${px(bottom)} below the bottom edge`);
  if (sides.length === 0) return null;
  const preview = String(layer.text).replace(/\s+/g, " ").slice(0, 40);
  const wide = box.width > container.w + OVERFLOW_TOLERANCE_PX;
  return {
    path: formatPath(path),
    code: "text_overflow",
    message:
      `text "${preview}" is about ${px(box.width)} x ${px(box.height)} but ${containerName} is ` +
      `${px(container.w)} x ${px(container.h)}: it runs ${sides.join(" and ")}` +
      (box.exact ? "" : " (width estimated)"),
    hint: wide
      ? `lower "size", widen ${containerName}, or set "maxWidth" (<= ${px(container.w)}) so the text wraps`
      : `raise ${containerName} or lower "size" / the line count`,
  };
}

/** What `textOverflowIssues` needs besides the data. */
export interface TextFitOptions {
  /** the canvas, for text that sits in no container; omitted when unknown (a bare scene or layer list). */
  canvas?: { w: number; h: number };
  measure?: TextMeasurer;
}

/**
 * Every text layer under `data` (a manifest, a scene or a list of layers) that
 * overflows its container, as `text_overflow` issues at `root` + the layer's path.
 */
export function textOverflowIssues(data: unknown, root: PathSeg[] = [], options: TextFitOptions = {}): ValidationIssue[] {
  const out: ValidationIssue[] = [];

  const checkList = (list: Record<string, unknown>[], path: PathSeg[]) => {
    const containers = list.map((l, i) => ({ rect: shapeRect(l), i })).filter((c): c is { rect: Rect; i: number } => c.rect !== null);
    list.forEach((layer, i) => {
      if (layer.use !== "text") return;
      const box = textBox(layer, options.measure);
      if (!box) return;
      const anchorY = box.top + Math.min(box.height, (typeof layer.size === "number" ? layer.size : DEFAULT_SIZE) * TEXT_LINE_HEIGHT) / 2;
      const anchorX = layer.x as number;
      const holding = containers
        .filter(({ rect }) => anchorX >= rect.x && anchorX <= rect.x + rect.w && anchorY >= rect.y && anchorY <= rect.y + rect.h)
        .sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0];
      const layerPath = [...path, i];
      if (holding) {
        const name = `the shape at ${formatPath([...path, holding.i])}`;
        const issue = overflowIssue(layerPath, layer, box, holding.rect, name);
        if (issue) out.push(issue);
      } else if (options.canvas) {
        const canvas = { x: 0, y: 0, w: options.canvas.w, h: options.canvas.h };
        const issue = overflowIssue(layerPath, layer, box, canvas, "the canvas");
        if (issue) out.push(issue);
      }
    });
  };

  const walk = (v: unknown, path: PathSeg[]) => {
    if (Array.isArray(v)) {
      if (isLayerList(v)) checkList(v, path);
      v.forEach((item, i) => walk(item, [...path, i]));
      return;
    }
    if (!isPlainObject(v)) return;
    for (const [k, child] of Object.entries(v)) walk(child, [...path, k]);
  };
  walk(data, root);
  return out;
}

