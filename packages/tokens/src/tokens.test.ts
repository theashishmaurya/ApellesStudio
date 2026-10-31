/**
 * D-432 P1 token-map tests: every token is defined in every theme, the CSS side
 * (Tailwind `@theme` aliases) covers exactly that set, and the contrast pairs the
 * redesign promises are computed (WCAG 2.x relative luminance), not asserted by eye.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOKEN_NAMES,
  THEME_VALUES,
  cssVariablesFor,
  resolveUiFontStack,
  UI_FONT_STACKS,
  type ThemeId,
  type TokenName,
} from './index';

const THEMES: ThemeId[] = ['dark', 'light', 'grey'];

function parseColor(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`unparseable colour: ${value}`);
}

function luminance(value: string): number {
  const [r, g, b] = parseColor(value).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('token map', () => {
  it('has no duplicate token names', () => {
    expect(new Set(TOKEN_NAMES).size).toBe(TOKEN_NAMES.length);
  });

  it.each(THEMES)('%s defines every token with a parseable colour and nothing extra', (theme) => {
    const values = THEME_VALUES[theme];
    expect(Object.keys(values).sort()).toEqual([...TOKEN_NAMES].sort());
    for (const name of TOKEN_NAMES) expect(() => parseColor(values[name])).not.toThrow();
  });

  it('emits one --app-* variable per token', () => {
    const vars = cssVariablesFor('dark');
    expect(Object.keys(vars)).toHaveLength(TOKEN_NAMES.length);
    expect(vars['--app-accent']).toBe(THEME_VALUES.dark.accent);
  });

  it('is aliased as a --color-* token (app/src/styles.css or packages/ui/src/styles.css) for every name', () => {
    const css = ['../../../app/src/styles.css', '../../ui/src/styles.css']
      .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
      .join('\n');
    for (const name of TOKEN_NAMES) {
      expect(css, `--color-${name}`).toContain(`--color-${name}: var(--app-${name});`);
    }
  });

  it('keeps clip colours identical across themes', () => {
    const clipNames = TOKEN_NAMES.filter((n) => n.startsWith('clip-'));
    for (const name of clipNames) {
      expect(THEME_VALUES.light[name]).toBe(THEME_VALUES.dark[name]);
      expect(THEME_VALUES.grey[name]).toBe(THEME_VALUES.dark[name]);
    }
  });
});

describe('contrast (dark theme)', () => {
  const dark = THEME_VALUES.dark;

  it.each<[TokenName, TokenName]>([
    ['text-primary', 'surface'],
    ['text-primary', 'bg-primary'],
    ['text-primary', 'bg-secondary'],
    ['text-primary', 'surface-raised'],
    ['text-secondary', 'surface'],
    ['text-secondary', 'bg-primary'],
    ['button-text', 'accent'],
    ['accent-text', 'surface'],
    ['accent-text', 'bg-primary'],
    ['destructive', 'surface'],
  ])('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(dark[fg], dark[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each<[TokenName, TokenName]>([
    ['accent', 'surface'],
    ['accent', 'bg-primary'],
    ['focus-ring', 'surface'],
    ['selection', 'timeline-bg'],
    ['playhead', 'timeline-bg'],
  ])('%s against %s is at least 3:1 (non-text UI)', (fg, bg) => {
    expect(contrast(dark[fg], dark[bg])).toBeGreaterThanOrEqual(3);
  });

  it.each(TOKEN_NAMES.filter((n) => /^clip-.+-strip$/.test(n)))('clip-label on %s is at least 4.5:1', (strip) => {
    expect(contrast(dark['clip-label'], dark[strip])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the selection amber distinct from the terracotta accent', () => {
    expect(dark.selection).not.toBe(dark.accent);
    expect(dark.playhead).not.toBe(dark.accent);
    expect(dark.accent).not.toBe(dark['text-primary']);
  });

  it('separates panels from the window background', () => {
    expect(luminance(dark.surface)).toBeGreaterThan(luminance(dark['bg-primary']));
    expect(luminance(dark['bg-secondary'])).toBeGreaterThan(luminance(dark.surface));
  });
});

describe('contrast (light and grey text)', () => {
  it.each(['light', 'grey'] as const)('%s text-primary on surface is at least 4.5:1', (theme) => {
    const v = THEME_VALUES[theme];
    expect(contrast(v['text-primary'], v.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('UI font', () => {
  it('defaults to the system stack, not Poppins', () => {
    expect(resolveUiFontStack(undefined)).toBe(UI_FONT_STACKS.system);
    expect(resolveUiFontStack('')).toBe(UI_FONT_STACKS.system);
    expect(resolveUiFontStack('nonsense')).toBe(UI_FONT_STACKS.system);
    expect(resolveUiFontStack('constructor')).toBe(UI_FONT_STACKS.system);
  });

  it('keeps Poppins as an explicit opt-in', () => {
    expect(resolveUiFontStack('poppins')).toBe(UI_FONT_STACKS.poppins);
  });
});
