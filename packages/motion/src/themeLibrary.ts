/**
 * @apelles/motion — the user's theme library and how a theme gets BUILT (D-399).
 *
 * What it is: pure functions over `ThemeDef`s (`@apelles/motion-engine`'s
 * `themeDef.ts`): list surgery on the saved library (`upsertTheme`,
 * `removeTheme`, `sanitizeLoadedThemes`), the one function that builds a
 * definition from a base + a patch + an optional token file (`buildThemeDef`,
 * called by BOTH the `motion_define_theme` tool and the theme editor, so a human
 * and an agent define themes through the same code), and the lookup that
 * decides what a theme name means in this project (`findNamedTheme`).
 *
 * What it does NOT do: any I/O (`themeLibraryIO.ts` is the boundary), any
 * manifest write (`manifestEdit.ts`'s `setProjectThemeDef`), any rendering.
 * Pure and tested on its own, the `layerPresets.ts` split.
 */
import { THEMES, THEME_NAMES, type ThemeName } from '@apelles/motion-engine/src/design';
import {
  BUILTIN_THEME_FONTS,
  parseThemeDef,
  themeDefFromBuiltin,
  themeDefFromTokens,
  type ThemeDef,
} from '@apelles/motion-engine/src/themeDef';

export type { ThemeDef };

/** What a theme name resolves to in a project. */
export type NamedTheme =
  | { source: 'builtin'; name: ThemeName }
  | { source: 'embedded'; def: ThemeDef }
  | { source: 'library'; def: ThemeDef };

/**
 * What does `name` mean right now? The manifest's own embedded definition wins
 * (it is what the document renders with), then a built-in, then the user
 * library. `null` for a name nothing defines.
 */
export function findNamedTheme(
  name: string,
  library: readonly ThemeDef[],
  embedded?: ThemeDef | null,
): NamedTheme | null {
  if (embedded && embedded.name === name) return { source: 'embedded', def: embedded };
  if ((THEME_NAMES as string[]).includes(name)) return { source: 'builtin', name: name as ThemeName };
  const hit = library.find((t) => t.name === name);
  return hit ? { source: 'library', def: hit } : null;
}

/** The definition of any resolvable theme name: a built-in is copied under its
 *  own name for display, never saved under it. */
export function themeDefOfName(
  name: string,
  library: readonly ThemeDef[],
  embedded?: ThemeDef | null,
): ThemeDef | null {
  const found = findNamedTheme(name, library, embedded);
  if (!found) return null;
  if (found.source === 'builtin') {
    return { ...themeDefFromBuiltin(THEMES[found.name], found.name, BUILTIN_THEME_FONTS[found.name]) };
  }
  return found.def;
}

export interface BuildThemeInput {
  /** the new theme's id (lowercase kebab); never a built-in's */
  name: string;
  /** start from this built-in, library or embedded theme. Default: the engine
   *  default, so a partial definition is always a complete one. */
  base?: string;
  /** field overrides, applied over the base */
  fields?: Record<string, unknown>;
  /** a CSS token file (`--apelles-theme-*`), applied over the base and under `fields` */
  tokensCss?: string;
}

/**
 * Build a validated definition: base, then tokens, then explicit fields. Every
 * problem comes back as one named message; nothing partial is ever returned.
 */
export function buildThemeDef(
  input: BuildThemeInput,
  library: readonly ThemeDef[],
  embedded?: ThemeDef | null,
): { def: ThemeDef } | { error: string } {
  const baseName = input.base ?? 'dark-excalidraw';
  const base = themeDefOfName(baseName, library, embedded);
  if (!base) {
    return {
      error: `unknown base theme "${baseName}" — built-ins: ${THEME_NAMES.join(', ')}${
        library.length ? `; library: ${library.map((t) => t.name).join(', ')}` : ''
      }`,
    };
  }
  const tokenFields: Record<string, unknown> = input.tokensCss ? { ...themeDefFromTokens(input.tokensCss) } : {};
  // The name is the caller's: a token file cannot rename what it defines.
  delete tokenFields.name;
  const merged = { ...base, ...tokenFields, ...(input.fields ?? {}), name: input.name };
  // A copy of a theme is not that theme: don't carry its description unless the
  // caller wrote one for this one.
  if (!('description' in (input.fields ?? {})) && !('description' in tokenFields)) {
    delete (merged as Record<string, unknown>).description;
  }
  return parseThemeDef(merged);
}

/** The library with `def` added, or replaced if one of that name exists
 *  (definitions are compared by name; the order of existing entries is kept). */
export function upsertTheme(library: readonly ThemeDef[], def: ThemeDef): ThemeDef[] {
  const i = library.findIndex((t) => t.name === def.name);
  if (i < 0) return [...library, def];
  return library.map((t, k) => (k === i ? def : t));
}

/** The library without `name`; the SAME array when `name` is not in it. */
export function removeTheme(library: readonly ThemeDef[], name: string): readonly ThemeDef[] | ThemeDef[] {
  return library.some((t) => t.name === name) ? library.filter((t) => t.name !== name) : library;
}

/** What came off disk → the definitions that are still valid. A hand-edited or
 *  older file with one bad entry loses that entry, not the library. */
export function sanitizeLoadedThemes(raw: unknown): ThemeDef[] {
  if (!Array.isArray(raw)) return [];
  const out: ThemeDef[] = [];
  for (const item of raw) {
    const parsed = parseThemeDef(item);
    if ('def' in parsed && !out.some((t) => t.name === parsed.def.name)) out.push(parsed.def);
  }
  return out;
}
