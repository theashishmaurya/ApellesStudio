/**
 * D-339 — the theme registry's regression suite.
 *
 * Lives in `@apelles/motion`'s test suite for the same reason
 * `interpolateKeys.test.ts` / `schema.test.ts` / `ambientDrift.test.ts` do —
 * `@apelles/motion-engine` has no `test` script of its own — importing across
 * the package boundary the same established way.
 *
 * Three things are proved here, and they are the three ways this refactor
 * could have gone wrong:
 *
 *  1. **The default look did not move.** Before D-339 the engine had one flat
 *     `design` object, and every manifest ever written renders through those
 *     exact numbers. `FROZEN_PRE_D330_DESIGN` below is a verbatim copy of it,
 *     transcribed from the pre-change file, and every field is asserted
 *     against the `dark-excalidraw` preset. This is the project's own "same
 *     doc + same frame ⇒ identical pixels" invariant (CLAUDE.md) applied to
 *     this specific change: if a token drifted, a render drifted, and this
 *     fails.
 *  2. **An absent `theme` key stays absent.** `theme` is `.optional()`, not
 *     `.default()`, precisely so `manifestSchema.parse()` does not
 *     materialise the key into every project file the app opens and saves.
 *  3. **The new preset is the website's palette, not an impression of it.**
 *     The `apelles-studio` values are checked against the REAL
 *     `website/src/styles/tokens.css`, the same anti-fabrication discipline
 *     `website/tests/palette.test.ts` already applies to the site itself — so
 *     a palette change there cannot silently leave this theme behind.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_THEME,
  DEFAULT_THEME_NAME,
  THEMES,
  THEME_NAMES,
  motion,
  resolveTheme,
} from '@apelles/motion-engine/src/design';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import { sample } from '@apelles/motion-engine/src/engine/sample';

/**
 * `packages/motion-engine/src/design.ts`'s entire pre-D-339 `design` export,
 * copied here verbatim. Do not regenerate this from the current source — the
 * whole point is that it is an independent record of what the look WAS.
 */
const FROZEN_PRE_D330_DESIGN = {
  bg: '#1e1e24',
  bgDeep: '#17171c',
  stroke: '#e8e8e8',
  strokeSoft: '#a9a9b2',
  text: '#efefef',
  textDim: '#9a9aa4',
  accentRed: '#e5484d',
  accentBlue: '#5b8def',
  strokeWidth: 3,
  roughness: 1.6,
  bowing: 1.2,
  fontHand: '"Kalam", "Comic Neue", "Segoe Print", cursive',
  fontMono: '"JetBrains Mono", ui-monospace, monospace',
  fps: 30,
  ease: {
    out: [0.22, 1, 0.36, 1],
    inOut: [0.65, 0, 0.35, 1],
    anticipate: [0.68, -0.55, 0.27, 1.55],
  },
  ambientDriftPx: 1.5,
} as const;

describe('D-339 — the default look is byte-for-byte the pre-registry `design`', () => {
  const d = THEMES['dark-excalidraw'];
  const frozen = FROZEN_PRE_D330_DESIGN;

  it('is still the engine default', () => {
    expect(DEFAULT_THEME_NAME).toBe('dark-excalidraw');
    expect(DEFAULT_THEME).toBe(d);
    expect(THEME_NAMES[0]).toBe('dark-excalidraw');
  });

  it('keeps every ground/ink token unchanged', () => {
    expect(d.bg).toBe(frozen.bg);
    expect(d.bgDeep).toBe(frozen.bgDeep);
    expect(d.stroke).toBe(frozen.stroke);
    expect(d.strokeSoft).toBe(frozen.strokeSoft);
    expect(d.text).toBe(frozen.text);
    expect(d.textDim).toBe(frozen.textDim);
  });

  it('keeps both accents unchanged, under their new ROLE names', () => {
    // `accentRed` was the emphasis/active colour, `accentBlue` the
    // signal/energy one — renamed, not revalued.
    expect(d.accent).toBe(frozen.accentRed);
    expect(d.accentSignal).toBe(frozen.accentBlue);
  });

  it('keeps the stroke feel and the ambient drift unchanged', () => {
    expect(d.strokeWidth).toBe(frozen.strokeWidth);
    expect(d.roughness).toBe(frozen.roughness);
    expect(d.bowing).toBe(frozen.bowing);
    expect(d.ambientDriftPx).toBe(frozen.ambientDriftPx);
  });

  it('keeps the type stacks unchanged, with `fontUi` aliasing the one face this look has', () => {
    expect(d.fontDisplay).toBe(frozen.fontHand);
    // Pre-D-339 there was no UI slot at all: `layers`' card labels and
    // `graph`'s node labels both read `fontHand` directly. `fontUi` is that
    // slot made explicit, and in THIS theme it must resolve to the same face
    // or those two primitives would render in a different font than before.
    expect(d.fontUi).toBe(frozen.fontHand);
    expect(d.fontMono).toBe(frozen.fontMono);
  });

  it('keeps the unthemed motion grammar unchanged', () => {
    expect(motion.fps).toBe(frozen.fps);
    expect(motion.ease.out).toEqual(frozen.ease.out);
    expect(motion.ease.inOut).toEqual(frozen.ease.inOut);
    expect(motion.ease.anticipate).toEqual(frozen.ease.anticipate);
  });
});

describe('D-339 — resolveTheme', () => {
  it('falls back to the default for absent, empty, and unregistered names', () => {
    expect(resolveTheme(undefined)).toBe(DEFAULT_THEME);
    expect(resolveTheme(null)).toBe(DEFAULT_THEME);
    expect(resolveTheme('')).toBe(DEFAULT_THEME);
    expect(resolveTheme('neon-vaporwave')).toBe(DEFAULT_THEME);
  });

  it('returns the named theme when it is registered', () => {
    for (const name of THEME_NAMES) {
      expect(resolveTheme(name)).toBe(THEMES[name]);
      expect(resolveTheme(name).name).toBe(name);
    }
  });
});

describe('D-339 — the manifest `theme` field is purely additive', () => {
  it('a manifest with no `theme` does NOT gain one on parse', () => {
    // The load-bearing assertion for every project file already on disk: the
    // app parses on open and writes the parse result back on save, so a
    // `.default()` here would rewrite them all.
    expect('theme' in sample).toBe(false);
    const parsed = manifestSchema.parse(structuredClone(sample));
    expect('theme' in parsed).toBe(false);
    expect(parsed.theme).toBeUndefined();
    expect(parsed).toEqual(manifestSchema.parse(structuredClone(sample)));
  });

  it('every registered theme name round-trips through the schema', () => {
    for (const name of THEME_NAMES) {
      const parsed = manifestSchema.parse({ ...structuredClone(sample), theme: name });
      expect(parsed.theme).toBe(name);
    }
  });

  it('an unregistered theme name is a parse ERROR, not a silent fallback', () => {
    const bad = { ...structuredClone(sample), theme: 'neon-vaporwave' };
    expect(() => manifestSchema.parse(bad)).toThrow();
    const r = manifestSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['theme']);
  });

  it('setting a theme changes nothing else about the document', () => {
    const themed = manifestSchema.parse({ ...structuredClone(sample), theme: 'apelles-studio' });
    const { theme, ...rest } = themed;
    expect(theme).toBe('apelles-studio');
    expect(rest).toEqual(manifestSchema.parse(structuredClone(sample)));
  });
});

describe("D-339 — `apelles-studio` is the website's real palette, not a paraphrase", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const tokensCss = readFileSync(
    resolve(HERE, '../../../website/src/styles/tokens.css'),
    'utf8',
  );

  /** the value of a `--custom-property: <value>;` declaration in tokens.css */
  const token = (name: string): string => {
    const m = tokensCss.match(new RegExp(`--${name}:\\s*([^;]+);`));
    if (!m) throw new Error(`tokens.css has no --${name}`);
    return m[1].trim();
  };

  const s = THEMES['apelles-studio'];

  it('grounds on basalt — the site\'s warm black, never #000', () => {
    expect(s.bg).toBe(token('pigment-basalt'));
    expect(s.bgDeep).toBe(token('pigment-basalt'));
    expect(s.bg).not.toBe('#000');
    expect(s.bg).not.toBe('#000000');
  });

  it('inks in marble', () => {
    expect(s.stroke).toBe(token('pigment-marble'));
    expect(s.text).toBe(token('pigment-marble'));
  });

  it('uses OCHRE as the working colour, and does not carry terracotta onto the dark ground', () => {
    // tokens.css states the rule outright: terracotta is 2.9:1 on basalt and
    // fails even large-text contrast, so inside a basalt section ochre takes
    // over as the working link/emphasis colour and terracotta is not used.
    expect(s.accent).toBe(token('pigment-ochre'));
    expect(s.accentSignal).toBe(token('pigment-ochre'));
    expect(s.accent).not.toBe(token('pigment-terracotta'));
    expect(s.accentSignal).not.toBe(token('pigment-terracotta'));
  });

  it('draws its soft ink from --ink-inverse-soft, flattened over the basalt ground', () => {
    // The site expresses it as `color-mix(in srgb, marble 68%, transparent)`;
    // this engine needs one opaque value (three.js discards alpha), so the
    // mix is pre-flattened against basalt. Recompute it here from the REAL
    // tokens rather than trusting the transcribed hex.
    expect(token('ink-inverse-soft')).toContain('68%');
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const marble = hex(token('pigment-marble'));
    const basalt = hex(token('pigment-basalt'));
    const flat = marble.map((c, i) => Math.round(c * 0.68 + basalt[i] * 0.32));
    const expected = `#${flat.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    expect(s.strokeSoft).toBe(expected);
    expect(s.textDim).toBe(expected);
  });

  it("uses the site's own three type stacks verbatim", () => {
    expect(s.fontDisplay).toBe(token('font-display'));
    expect(s.fontUi).toBe(token('font-ui'));
    expect(s.fontMono).toBe(token('font-mono'));
    expect(s.fontDisplay).toContain('Newsreader');
    expect(s.fontUi).toContain('Instrument Sans');
    expect(s.fontMono).toContain('IBM Plex Mono');
  });

  it('is a CLEAN look — no roughjs jitter, no ambient drift', () => {
    expect(s.roughness).toBe(0);
    expect(s.bowing).toBe(0);
    expect(s.ambientDriftPx).toBe(0);
  });
});
