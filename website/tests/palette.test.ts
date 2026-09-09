/**
 * palette.test.ts — the visual system is a system, and it is enforced (D-264).
 *
 * This replaces D-255's tokens.test.ts, which guarded a different rule: that the
 * site's palette WAS the desktop app's dark theme. D-264 deliberately split
 * those apart — the brand is now quarried from the Alexander Mosaic, and the
 * app's own theme survives only where the site draws the application itself.
 * So the coverage moves rather than disappears: both sources are still read
 * from disk, and both still fail this suite if the site drifts from them.
 *
 * The rule worth having a test for at all is the signature: `--pigment-rose` is
 * the pink the mosaicists imported from Portugal and spent on one face out of
 * roughly two million tesserae. A signature colour used twice is not a
 * signature, so it is asserted literally — one CSS rule, one component, one
 * element per built page (that last one lives in build-output.test.ts, where
 * the real pages are).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIGMENTS, SIGNATURE_TOKEN, TYPEFACES, BANNED_TYPEFACES, SOURCE } from '../src/data/palette.ts';

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

const tokens = read('../src/styles/tokens.css');
const global = read('../src/styles/global.css');
const themes = read('../../app/src/utils/themes.ts');

/** Pull `--x: value;` declarations out of a stylesheet. */
function declarations(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) out[m[1]] = m[2].trim();
  return out;
}

const site = declarations(tokens);

/** Every file under src/, so "nowhere on this site" can be asserted literally. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const SRC_FILES = walk(abs('../src'));
const SRC = SRC_FILES.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));

describe('the brand palette is exactly the documented one', () => {
  it.each(PIGMENTS.map((p) => [p.token, p.hex] as const))(
    '--%s is %s in tokens.css, matching src/data/palette.ts',
    (token, hex) => {
      expect(
        site[`--${token}`],
        `--${token} has drifted from src/data/palette.ts`,
      ).toBe(hex);
    },
  );

  it('defines no pigment token that palette.ts does not document', () => {
    const declared = Object.keys(site).filter((k) => k.startsWith('--pigment-'));
    const documented = PIGMENTS.map((p) => `--${p.token}`);
    expect(declared.sort()).toEqual(documented.sort());
  });

  it('gives every pigment a real material and a stated role', () => {
    for (const p of PIGMENTS) {
      expect(p.material.length, `${p.token} has no material`).toBeGreaterThan(10);
      expect(p.role.length, `${p.token} has no stated role`).toBeGreaterThan(10);
    }
  });

  it('cites the analysis the material claims rest on', () => {
    expect(SOURCE.url).toMatch(/^https:\/\//);
    expect(SOURCE.year).toBe(2025);
    // The citation is printed on the site, not just kept in a comment.
    expect(read('../src/components/Footer.astro')).toContain('SOURCE.url');
  });
});

describe('the product tokens are still the real app theme', () => {
  /** Pull the app's Dark theme block out of themes.ts. */
  const app: Record<string, string> = {};
  {
    const start = themes.indexOf('id: Theme.Dark');
    expect(start, 'themes.ts should still declare a Dark theme').toBeGreaterThan(-1);
    const block = themes.slice(start, themes.indexOf('},', themes.indexOf('cssVariables', start)));
    for (const m of block.matchAll(/'(--app-[a-z-]+)':\s*'([^']+)'/g)) app[m[1]] = m[2];
  }

  const declared = Object.entries(site).filter(([k]) => k.startsWith('--app-'));

  it('reads the app’s real dark theme', () => {
    expect(Object.keys(app).length).toBeGreaterThanOrEqual(10);
  });

  it('declares only the app tokens it actually draws with — no dead tokens', () => {
    for (const [name] of declared) {
      const used = SRC.some(
        ({ file, text }) => !file.endsWith('tokens.css') && text.includes(`var(${name})`),
      );
      expect(used, `${name} is declared but never used — dead token`).toBe(true);
    }
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(
    Object.entries(declarations(tokens)).filter(([k]) => k.startsWith('--app-')),
  )('%s matches app/src/utils/themes.ts exactly', (name, value) => {
    expect(app[name], `${name} has drifted from the app's own Dark theme`).toBe(value);
  });
});

describe('no colour exists outside those two sources', () => {
  it('tokens.css holds no literal that is neither a pigment nor an app token', () => {
    const literals = Object.entries(site).filter(
      ([, v]) => /^#[0-9a-f]{3,8}$/i.test(v) || /^rgb\(/i.test(v),
    );
    for (const [name] of literals) {
      expect(
        name.startsWith('--pigment-') || name.startsWith('--app-'),
        `${name} is an undocumented colour literal`,
      ).toBe(true);
    }
    // Sanity: the scan actually found the palette rather than matching nothing.
    expect(literals.length).toBe(PIGMENTS.length + 6);
  });

  it('no component or page hard-codes a colour — every one goes through a token', () => {
    const offenders: string[] = [];
    for (const { file, text } of SRC) {
      if (file.endsWith('tokens.css')) continue; // the one file allowed literals
      if (file.endsWith('palette.ts')) continue; // the source of record for them
      for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        // An id selector or an href fragment is not a colour.
        if (/^#[0-9a-fA-F]{3,8}$/.test(m[0])) offenders.push(`${file}: ${m[0]}`);
      }
      for (const m of text.matchAll(/\brgba?\(/g)) offenders.push(`${file}: ${m[0]}`);
    }
    expect(offenders, `hard-coded colours:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the favicon uses only real pigments', () => {
    const svg = readFileSync(abs('../public/favicon.svg'), 'utf8');
    const hexes = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
    const allowed = new Set(PIGMENTS.map((p) => p.hex));
    expect(hexes.length).toBeGreaterThan(4);
    for (const h of hexes) expect(allowed.has(h), `${h} is not in the palette`).toBe(true);
  });
});

describe('the signature is spent once, the way the mosaic spent it', () => {
  const uses = SRC.filter(
    ({ file }) => file.endsWith('.css') || file.endsWith('.astro'),
  ).flatMap(({ file, text }) =>
    [...text.matchAll(new RegExp(`var\\(--${SIGNATURE_TOKEN}\\)`, 'g'))].map(() => file),
  );

  it('is referenced by exactly one CSS declaration in the whole site', () => {
    expect(uses, `--${SIGNATURE_TOKEN} is used in: ${uses.join(', ')}`).toHaveLength(1);
  });

  it('and that declaration is the .signature rule in global.css', () => {
    expect(uses[0]).toMatch(/global\.css$/);
    const rule = global.slice(global.indexOf('.signature {'), global.indexOf('.signature:hover'));
    expect(rule).toContain(`var(--${SIGNATURE_TOKEN})`);
  });

  it('is emitted by one component only, so a page cannot grow a second by accident', () => {
    const emitters = SRC.filter(
      ({ file, text }) => file.endsWith('.astro') && /class="signature"/.test(text),
    ).map(({ file }) => file);
    expect(emitters).toHaveLength(1);
    expect(emitters[0]).toMatch(/Signature\.astro$/);
  });

  it('the favicon spends it once too — one rose tessera out of nine', () => {
    const svg = readFileSync(abs('../public/favicon.svg'), 'utf8');
    const rose = PIGMENTS.find((p) => p.token === SIGNATURE_TOKEN)?.hex ?? '';
    expect(svg.split(rose).length - 1).toBe(1);
  });
});

describe('type', () => {
  it('sets the three chosen faces, each with one job', () => {
    expect(site['--font-display']).toContain(TYPEFACES.display);
    expect(site['--font-ui']).toContain(TYPEFACES.ui);
    expect(site['--font-mono']).toContain(TYPEFACES.mono);
  });

  it('really loads all three, rather than naming a face it never fetches', () => {
    const base = read('../src/layouts/Base.astro');
    for (const face of Object.values(TYPEFACES)) {
      expect(base, `${face} is named in tokens.css but never requested`).toContain(
        face.replace(/ /g, '+'),
      );
    }
  });

  it.each(BANNED_TYPEFACES)('never falls back to %s — the generated-interface tell', (face) => {
    // Word-bounded, so "Interactive relight" is not mistaken for Inter, and
    // palette.ts is skipped because it is where the ban itself is written down.
    const pattern = new RegExp(`\\b${face}\\b`);
    for (const { file, text } of SRC) {
      if (file.endsWith('palette.ts')) continue;
      expect(pattern.test(text), `${file} mentions ${face}`).toBe(false);
    }
  });
});
