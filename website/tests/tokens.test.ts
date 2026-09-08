/**
 * tokens.test.ts — the site's palette must BE the app's palette (D-255).
 *
 * CLAUDE.md's one-token-source rule says all theming flows from the app's own
 * `--color-*` vars. A marketing site in a different repo directory can drift
 * from that silently, so this test reads BOTH real files and fails if a single
 * value diverges. It is the guard that keeps the site honest about what the
 * product actually looks like.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const themes = read('../../app/src/utils/themes.ts');
const tokens = read('../src/styles/tokens.css');
const timeline = read('../../packages/editor/src/timeline.ts');

/** Pull the app's Dark theme block out of themes.ts. */
function appDarkTheme(): Record<string, string> {
  const start = themes.indexOf('id: Theme.Dark');
  expect(start, 'themes.ts should still declare a Dark theme').toBeGreaterThan(-1);
  const block = themes.slice(start, themes.indexOf('},', themes.indexOf('cssVariables', start)));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/'(--app-[a-z-]+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
  return out;
}

/** Pull `--x: value;` declarations out of the site's tokens.css. */
function siteTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tokens.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) out[m[1]] = m[2].trim();
  return out;
}

describe('the website palette is the app palette', () => {
  const app = appDarkTheme();
  const site = siteTokens();

  it('finds all ten of the app’s dark-theme variables', () => {
    expect(Object.keys(app)).toHaveLength(10);
  });

  it.each(Object.entries(appDarkTheme()))('%s matches the app exactly', (name, value) => {
    expect(site[name], `${name} has drifted from app/src/utils/themes.ts`).toBe(value);
  });

  it('aliases every --app-* var onto a --color-* var, as app/src/styles.css does', () => {
    for (const name of Object.keys(app)) {
      const alias = name.replace('--app-', '--color-');
      expect(site[alias], `${alias} should alias ${name}`).toBe(`var(${name})`);
    }
  });

  it('defines no raw hex or rgb() colour outside the two documented sources', () => {
    // Every chromatic literal must be either a --app-* value (checked above) or
    // a --marker-* value (checked in the next block). Nothing else may exist.
    const literals = Object.entries(site).filter(
      ([, v]) => /^#[0-9a-f]{3,8}$/i.test(v) || /^rgb\(/i.test(v),
    );
    for (const [name] of literals) {
      expect(
        name.startsWith('--app-') || name.startsWith('--marker-'),
        `${name} is an undocumented colour literal — every colour must come from the app`,
      ).toBe(true);
    }
  });
});

describe('the signal colours are the app’s real marker palette', () => {
  /** Pull MARKER_COLORS out of packages/editor/src/timeline.ts. */
  const appMarkers = new Map<string, string>();
  const block = timeline.slice(timeline.indexOf('export const MARKER_COLORS'));
  for (const m of block.slice(0, block.indexOf('];')).matchAll(
    /name:\s*'([a-z]+)',\s*hex:\s*'(#[0-9A-Fa-f]{6})'/g,
  )) {
    appMarkers.set(m[1], m[2].toLowerCase());
  }

  const site = siteTokens();
  const siteMarkers = Object.entries(site).filter(([k]) => k.startsWith('--marker-'));

  it('reads the real 16-swatch palette from the editor package', () => {
    expect(appMarkers.size).toBe(16);
  });

  it('uses at least one of them', () => {
    expect(siteMarkers.length).toBeGreaterThan(0);
  });

  it.each(siteMarkers)('%s is a real shipped marker colour', (name, value) => {
    const swatch = name.replace('--marker-', '');
    expect(
      appMarkers.get(swatch),
      `${name} is not in MARKER_COLORS — the site must not invent a colour`,
    ).toBe(value.toLowerCase());
  });
});

describe('type', () => {
  const site = siteTokens();

  it('uses the app’s own default typeface for display and body', () => {
    // app/src/hooks/useAppInitialization.ts: "'Poppins', system-ui, sans-serif"
    expect(site['--font-display']).toContain('Poppins');
    expect(site['--font-sans']).toContain('Poppins');
  });

  it('has a separate mono face for technical material', () => {
    expect(site['--font-mono']).toContain('Plex Mono');
  });
});
