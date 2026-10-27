/**
 * @apelles/brand — the contrast check a kit's colours get (D-416).
 *
 * What it is: WCAG 2.2's relative luminance and contrast ratio
 * (w3.org/TR/WCAG22, "contrast ratio" and "relative luminance" definitions;
 * sRGB linearisation threshold 0.04045), and the pairs of brand colours that end
 * up on top of each other in this app: text and every accent on the background,
 * caption text on its box. Each pair gets its ratio and the level it reaches
 * (AAA 7, AA 4.5, AA for large text 3).
 *
 * What it does NOT do: refuse a kit. A brand's colours are the brand's; a low
 * ratio is a WARNING shown in the panel and returned to an agent, which then
 * picks the right colour for text (that is why the result says which pairs fail).
 * Pure arithmetic: no colour-science dependency for two formulas.
 */
import type { BrandKit, ColorRole } from './kit';

/** WCAG thresholds. */
export const CONTRAST_AAA = 7;
export const CONTRAST_AA = 4.5;
export const CONTRAST_AA_LARGE = 3;

export type ContrastLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

/** `#rrggbb` → its WCAG relative luminance, 0..1. */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** The WCAG contrast ratio of two colours, 1..21, rounded to two decimals. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  return Math.round(ratio * 100) / 100;
}

export function contrastLevel(ratio: number): ContrastLevel {
  if (ratio >= CONTRAST_AAA) return 'AAA';
  if (ratio >= CONTRAST_AA) return 'AA';
  if (ratio >= CONTRAST_AA_LARGE) return 'AA-large';
  return 'fail';
}

export interface ContrastPair {
  /** e.g. "text on background" */
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  level: ContrastLevel;
  /** what this pair is used for, so a warning says why it matters */
  use: string;
  /** body-size text needs AA; a pair only ever used for large type needs AA-large */
  ok: boolean;
}

interface PairSpec {
  fg: ColorRole;
  bg: ColorRole;
  use: string;
  large: boolean;
}

const PAIRS: readonly PairSpec[] = [
  { fg: 'text', bg: 'background', use: 'body text, captions and labels', large: false },
  { fg: 'primary', bg: 'background', use: 'emphasis and headlines in the brand colour', large: true },
  { fg: 'accent', bg: 'background', use: 'highlights and data accents', large: true },
  { fg: 'secondary', bg: 'background', use: 'secondary marks and rules', large: true },
  { fg: 'background', bg: 'primary', use: 'text on a primary-coloured button or card', large: false },
];

/** Every pair, with its verdict. Deterministic: same colours, same report. */
export function checkKitContrast(colors: BrandKit['colors']): ContrastPair[] {
  return PAIRS.map(({ fg, bg, use, large }) => {
    const ratio = contrastRatio(colors[fg], colors[bg]);
    const level = contrastLevel(ratio);
    return {
      pair: `${fg} on ${bg}`,
      foreground: colors[fg],
      background: colors[bg],
      ratio,
      level,
      use,
      ok: large ? ratio >= CONTRAST_AA_LARGE : ratio >= CONTRAST_AA,
    };
  });
}

/** The failing pairs as one-line warnings an agent or a person can act on. */
export function contrastWarnings(colors: BrandKit['colors']): string[] {
  return checkKitContrast(colors)
    .filter((p) => !p.ok)
    .map((p) => `${p.pair} is ${p.ratio}:1 (${p.level}); too low for ${p.use}`);
}
