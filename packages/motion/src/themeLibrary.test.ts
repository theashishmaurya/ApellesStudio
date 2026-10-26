/**
 * themeLibrary.test.ts — themes as data (D-399, B-268): the definition schema,
 * the manifest's determinism rule, token-file derivation, and the pure library
 * and build functions both the MCP tools and the theme editor go through.
 */
import { describe, it, expect } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import { THEMES } from '@apelles/motion-engine/src/design';
import {
  BUILTIN_THEME_FONTS,
  parseThemeDef,
  resolveManifestTheme,
  themeDefFromBuiltin,
  themeDefFromTokens,
  themeDefToTheme,
  type ThemeDef,
} from '@apelles/motion-engine/src/themeDef';

import {
  buildThemeDef,
  findNamedTheme,
  removeTheme,
  sanitizeLoadedThemes,
  themeDefOfName,
  upsertTheme,
} from './themeLibrary';
import { setProjectTheme, setProjectThemeDef } from './manifestEdit';

const def = (over: Record<string, unknown> = {}): ThemeDef => {
  const parsed = parseThemeDef({ ...themeDefFromBuiltin(THEMES['apelles-studio'], 'my-theme'), ...over });
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.def;
};

describe('the definition schema', () => {
  it('accepts a complete definition and round-trips it to a Theme and back', () => {
    const d = def();
    const theme = themeDefToTheme(d);
    expect(theme).toMatchObject({ name: 'my-theme', bg: THEMES['apelles-studio'].bg, strokeWidth: 2 });
    expect(themeDefFromBuiltin(theme, 'my-theme')).toMatchObject({ bg: d.bg, fontUi: d.fontUi });
  });

  it('refuses non-opaque colours (three.js discards alpha), bad names, built-in names and unsafe font stacks', () => {
    const bad = (over: Record<string, unknown>) => {
      const r = parseThemeDef({ ...themeDefFromBuiltin(THEMES['apelles-studio'], 'ok'), ...over });
      return 'error' in r ? r.error : null;
    };
    expect(bad({ bg: 'rgba(0,0,0,.5)' })).toMatch(/bg: an opaque #rrggbb/);
    expect(bad({ bg: '#fff' })).toMatch(/bg/);
    expect(bad({ name: 'Has Spaces' })).toMatch(/name/);
    expect(bad({ name: 'dark-excalidraw' })).toMatch(/built-in/);
    expect(bad({ fontUi: 'a; color: red' })).toMatch(/fontUi/);
    expect(bad({ strokeWidth: 0 })).toMatch(/strokeWidth/);
    expect(bad({ fonts: [{ family: 'Bad;Family' }] })).toMatch(/fonts\.0\.family/);
    expect(bad({})).toBeNull();
  });

  it('a copy of a built-in carries the faces that built-in loads', () => {
    const copy = themeDefFromBuiltin(THEMES['apelles-studio'], 'x', BUILTIN_THEME_FONTS['apelles-studio']);
    expect(copy.fonts?.map((f) => f.family)).toEqual(['Newsreader', 'Instrument Sans', 'IBM Plex Mono']);
    expect(themeDefFromBuiltin(THEMES['dark-excalidraw'], 'y').fonts).toBeUndefined();
  });
});

describe('the manifest rule (determinism)', () => {
  const base = JSON.parse(JSON.stringify(sample));

  it('an existing manifest parses exactly as before, with no theme key materialised', () => {
    const parsed = manifestSchema.parse(base);
    expect('theme' in parsed).toBe(false);
    expect('themeDef' in parsed).toBe(false);
  });

  it('a built-in name needs no definition', () => {
    expect(manifestSchema.safeParse({ ...base, theme: 'apelles-studio-light' }).success).toBe(true);
  });

  it('a name that is not built in is refused unless the manifest embeds it', () => {
    const r = manifestSchema.safeParse({ ...base, theme: 'my-theme' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('does not embed its definition');
    expect(manifestSchema.safeParse({ ...base, theme: 'my-theme', themeDef: def() }).success).toBe(true);
    // naming nothing is fine too: the embedded definition IS the look
    expect(manifestSchema.safeParse({ ...base, themeDef: def() }).success).toBe(true);
  });

  it('a name that disagrees with the embedded definition is refused', () => {
    const r = manifestSchema.safeParse({ ...base, theme: 'apelles-studio', themeDef: def() });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('must match');
  });

  it('resolution: the embedded definition wins; otherwise the named built-in; otherwise the default', () => {
    expect(resolveManifestTheme({ themeDef: def({ bg: '#010203' }) }).bg).toBe('#010203');
    expect(resolveManifestTheme({ theme: 'apelles-studio' })).toBe(THEMES['apelles-studio']);
    expect(resolveManifestTheme({})).toBe(THEMES['dark-excalidraw']);
  });
});

describe('deriving a theme from a token file', () => {
  const css = `
    :root {
      --apelles-theme-bg: #1c1a17;
      --apelles-theme-bg-deep: #14120f;
      --apelles-theme-stroke-width: 3;
      --apelles-theme-font-display: 'Newsreader', Georgia, serif;
      --apelles-theme-fonts: Newsreader:400,600 | IBM Plex Mono;
      --unrelated: red;
    }`;

  it('reads only --apelles-theme-* properties, camel-casing the field and typing the numbers', () => {
    const t = themeDefFromTokens(css);
    expect(t).toMatchObject({ bg: '#1c1a17', bgDeep: '#14120f', strokeWidth: 3 });
    expect(t.fontDisplay).toBe("'Newsreader', Georgia, serif");
    expect(t.fonts).toEqual([{ family: 'Newsreader', weights: ['400', '600'] }, { family: 'IBM Plex Mono' }]);
    expect('unrelated' in t).toBe(false);
  });

  it('is deterministic: the same file gives the same definition', () => {
    expect(themeDefFromTokens(css)).toEqual(themeDefFromTokens(css));
  });
});

describe('buildThemeDef', () => {
  it('builds base, then tokens, then explicit fields, and validates the whole', () => {
    const out = buildThemeDef(
      {
        name: 'blend',
        base: 'apelles-studio',
        tokensCss: '--apelles-theme-bg: #111111; --apelles-theme-text: #eeeeee;',
        fields: { text: '#fafafa' },
      },
      [],
    );
    expect('def' in out && out.def).toMatchObject({ name: 'blend', bg: '#111111', text: '#fafafa', stroke: '#f4efe6' });
  });

  it('a token file cannot rename what it defines; the caller names it', () => {
    const out = buildThemeDef({ name: 'caller-name', tokensCss: '--apelles-theme-name: tokens-name;' }, []);
    expect('def' in out && out.def.name).toBe('caller-name');
  });

  it('a copy does not inherit the base theme\'s description', () => {
    const out = buildThemeDef({ name: 'plain', base: 'apelles-studio' }, []);
    expect('def' in out && out.def.description).toBeUndefined();
  });

  it('can start from a library or an embedded theme, and names an unknown base', () => {
    const lib = [def({ name: 'lib', bg: '#0a0b0c' })];
    const fromLib = buildThemeDef({ name: 'child', base: 'lib' }, lib);
    expect('def' in fromLib && fromLib.def.bg).toBe('#0a0b0c');
    const fromEmbedded = buildThemeDef({ name: 'kid', base: 'emb' }, [], def({ name: 'emb', bg: '#0d0e0f' }));
    expect('def' in fromEmbedded && fromEmbedded.def.bg).toBe('#0d0e0f');
    expect(buildThemeDef({ name: 'x', base: 'nope' }, lib)).toEqual({
      error: expect.stringContaining('unknown base theme "nope"'),
    });
  });
});

describe('library operations', () => {
  it('upsert adds, then replaces in place by name', () => {
    const a = def({ name: 'a' });
    const b = def({ name: 'b' });
    const lib = upsertTheme(upsertTheme([], a), b);
    const replaced = upsertTheme(lib, def({ name: 'a', bg: '#abcdef' }));
    expect(replaced.map((t) => t.name)).toEqual(['a', 'b']);
    expect(replaced[0].bg).toBe('#abcdef');
  });

  it('remove returns the SAME list when the name is absent', () => {
    const lib = [def({ name: 'a' })];
    expect(removeTheme(lib, 'zzz')).toBe(lib);
    expect(removeTheme(lib, 'a')).toEqual([]);
  });

  it('a damaged library file loses the bad entry, not the library', () => {
    const good = def({ name: 'good' });
    expect(sanitizeLoadedThemes([good, { name: 'bad', bg: 'nope' }, 'junk', good])).toEqual([good]);
    expect(sanitizeLoadedThemes(null)).toEqual([]);
  });

  it('names resolve embedded first, then built-in, then library', () => {
    const lib = [def({ name: 'lib' })];
    const emb = def({ name: 'emb' });
    expect(findNamedTheme('emb', lib, emb)?.source).toBe('embedded');
    expect(findNamedTheme('apelles-studio', lib, emb)?.source).toBe('builtin');
    expect(findNamedTheme('lib', lib, emb)?.source).toBe('library');
    expect(findNamedTheme('ghost', lib, emb)).toBeNull();
    expect(themeDefOfName('apelles-studio', [], null)?.fonts).toHaveLength(3);
  });
});

describe('writing a theme into the document', () => {
  it('embeds the definition and names it; a built-in pick removes it again', () => {
    const withDef = setProjectThemeDef(sample, def({ name: 'mine' }));
    expect(withDef.theme).toBe('mine');
    expect(withDef.themeDef?.name).toBe('mine');
    expect(manifestSchema.safeParse(withDef).success).toBe(true);
    const back = setProjectTheme(withDef, 'apelles-studio');
    expect('themeDef' in back).toBe(false);
    expect(back.theme).toBe('apelles-studio');
    expect(setProjectTheme(withDef, undefined)).toEqual(sample);
  });

  it('the embedded copy is detached from the definition it came from', () => {
    const d = def({ name: 'mine' });
    const m = setProjectThemeDef(sample, d);
    d.bg = '#000000';
    expect(m.themeDef?.bg).not.toBe('#000000');
  });
});
