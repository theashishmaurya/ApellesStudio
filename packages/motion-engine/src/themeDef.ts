/**
 * themeDef.ts — a theme as DATA (D-399).
 *
 * What it is: `ThemeDef`, the validated, JSON-serialisable form of a `Theme`
 * (`design.ts`) — every look field plus the Google Fonts families the look's
 * type stacks need — with its zod schema, the conversion to a `Theme`, a
 * derivation from a CSS-token file, and the one function that turns a
 * manifest into the theme it renders with (`resolveManifestTheme`).
 *
 * What it does NOT do: store anything. A definition lives in one of three
 * places and this file knows only their SHAPE: embedded in the manifest
 * (`manifest.themeDef`, which makes the document self-contained), in the
 * user's library (`@apelles/motion`'s `themeLibraryIO.ts`), or derived from a
 * token file by [`themeDefFromTokens`]. The compiled presets in `design.ts`
 * stay as the built-ins; this adds user themes beside them.
 *
 * **Determinism (CLAUDE.md, D-339).** A manifest that names a non-built-in
 * theme MUST carry its definition (`manifestSchema` refuses it otherwise), so
 * the same document renders the same pixels on any machine whatever is or is
 * not in that machine's library. The library is a place to pick FROM; picking
 * copies the definition INTO the manifest.
 *
 * **Colours are opaque `#rrggbb`.** The same rule the built-ins follow
 * (`apelles-studio`'s note): a token is read by an SVG stroke, a CSS border and
 * a three.js material, and three.js discards alpha, so a translucent value
 * would render differently in 3D than in 2D.
 *
 * **Fonts are Google Fonts families by NAME** (`themeFonts.ts` loads them with
 * `@remotion/google-fonts`), so a font needs no file shipped with the
 * document. The CSS stacks (`fontDisplay` …) are what primitives actually use;
 * `fonts` lists which families to download for them.
 */
import { z } from "zod";
import { THEME_NAMES, resolveTheme, type Theme, type ThemeName } from "./design";
import { FONT_ASSET_ID_PATTERN } from "./lib/assetId";

/** One webfont to load: a Google Fonts family and the weights the look uses. */
export const themeFontSchema = z.object({
  /** the family exactly as Google Fonts names it ("Newsreader", "IBM Plex Mono") */
  family: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ]*$/, "a Google Fonts family name: letters, digits and spaces"),
  /** CSS weights, `"100"`..`"900"`. Omitted ⇒ the family's regular (400). */
  weights: z
    .array(z.string().regex(/^[1-9]00$/, 'a weight like "400" or "700"'))
    .max(9)
    .optional(),
  italic: z.boolean().optional(),
});

export type ThemeFont = z.infer<typeof themeFontSchema>;

/**
 * D-416 — one font FILE the theme loads from the project's asset folder: a brand
 * kit's own typeface (a person's licensed font), by content-hash asset id, so the
 * document still renders the same letters on any machine. Registered with the
 * browser's `FontFace` under `family` (`themeFonts.ts`), which the stacks then name.
 */
export const themeFontFileSchema = z.object({
  family: themeFontSchema.shape.family,
  src: z.string().regex(FONT_ASSET_ID_PATTERN, "a font asset id (sha256:<hex>.ttf|otf|woff|woff2) from motion_import_asset"),
  /** CSS weight; omitted ⇒ 400 */
  weight: z.string().regex(/^[1-9]00$/, 'a weight like "400" or "700"').optional(),
  italic: z.boolean().optional(),
});

export type ThemeFontFile = z.infer<typeof themeFontFileSchema>;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "an opaque #rrggbb colour");

/** A CSS font-family stack. Free text, minus the characters that could close
 *  the declaration it is interpolated into. */
const fontStack = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^;{}<>\\]*$/, "a CSS font-family list (no ; { } < > \\)");

/** Theme names are ids: lowercase kebab, and never a built-in's. */
const themeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "lowercase letters, digits and hyphens, at most 48")
  .refine((n) => !(THEME_NAMES as string[]).includes(n), {
    message: "is a built-in theme's name; pick another",
  });

export const themeDefSchema = z.object({
  name: themeId,
  description: z.string().max(240).optional(),
  bg: hex,
  bgDeep: hex,
  stroke: hex,
  strokeSoft: hex,
  text: hex,
  textDim: hex,
  accent: hex,
  accentSignal: hex,
  strokeWidth: z.number().min(0.5).max(20),
  roughness: z.number().min(0).max(10),
  bowing: z.number().min(0).max(10),
  fontDisplay: fontStack,
  fontUi: fontStack,
  fontMono: fontStack,
  ambientDriftPx: z.number().min(0).max(20),
  /** the webfonts to download for the stacks above; omitted ⇒ none (system fonts) */
  fonts: z.array(themeFontSchema).max(8).optional(),
  /** D-416 — font files to load from the asset folder; omitted ⇒ none */
  fontFiles: z.array(themeFontFileSchema).max(8).optional(),
});

export type ThemeDef = z.infer<typeof themeDefSchema>;

/** The look fields a definition carries, in the order tools and editors show them. */
export const THEME_COLOR_FIELDS = [
  "bg",
  "bgDeep",
  "stroke",
  "strokeSoft",
  "text",
  "textDim",
  "accent",
  "accentSignal",
] as const;
export const THEME_NUMBER_FIELDS = ["strokeWidth", "roughness", "bowing", "ambientDriftPx"] as const;
export const THEME_FONT_STACK_FIELDS = ["fontDisplay", "fontUi", "fontMono"] as const;

/** A built-in theme as a definition under `name`, to start a new theme from.
 *  `fonts` is what the built-in's loader downloads (`themeFonts.ts`), so the
 *  copy renders its type the same way. */
export function themeDefFromBuiltin(builtin: Theme, name: string, fonts?: ThemeFont[]): ThemeDef {
  return {
    name,
    description: builtin.description,
    bg: builtin.bg,
    bgDeep: builtin.bgDeep,
    stroke: builtin.stroke,
    strokeSoft: builtin.strokeSoft,
    text: builtin.text,
    textDim: builtin.textDim,
    accent: builtin.accent,
    accentSignal: builtin.accentSignal,
    strokeWidth: builtin.strokeWidth,
    roughness: builtin.roughness,
    bowing: builtin.bowing,
    fontDisplay: builtin.fontDisplay,
    fontUi: builtin.fontUi,
    fontMono: builtin.fontMono,
    ambientDriftPx: builtin.ambientDriftPx,
    ...(fonts && fonts.length > 0 ? { fonts } : {}),
  };
}

/** The `Theme` a definition renders as. */
export function themeDefToTheme(def: ThemeDef): Theme {
  return {
    name: def.name,
    description: def.description ?? "",
    bg: def.bg,
    bgDeep: def.bgDeep,
    stroke: def.stroke,
    strokeSoft: def.strokeSoft,
    text: def.text,
    textDim: def.textDim,
    accent: def.accent,
    accentSignal: def.accentSignal,
    strokeWidth: def.strokeWidth,
    roughness: def.roughness,
    bowing: def.bowing,
    fontDisplay: def.fontDisplay,
    fontUi: def.fontUi,
    fontMono: def.fontMono,
    ambientDriftPx: def.ambientDriftPx,
    fonts: def.fonts,
    ...(def.fontFiles ? { fontFiles: def.fontFiles } : {}),
  };
}

/** Parse + validate untrusted JSON into a definition, with every problem
 *  named by its path (`bg: an opaque #rrggbb colour`). */
export function parseThemeDef(raw: unknown): { def: ThemeDef } | { error: string } {
  const parsed = themeDefSchema.safeParse(raw);
  if (parsed.success) return { def: parsed.data };
  return {
    error: parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(theme)"}: ${i.message}`)
      .join("; "),
  };
}

/** `--apelles-theme-bg-deep` → `bgDeep`; every other custom property is ignored. */
const TOKEN_PREFIX = "--apelles-theme-";

const kebabToCamel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Derive a (partial) definition from a CSS token file.
 *
 * The convention is one custom property per look field, named
 * `--apelles-theme-<field-in-kebab-case>`: `--apelles-theme-bg: #1c1a17;`,
 * `--apelles-theme-stroke-width: 2;`, `--apelles-theme-font-display:
 * 'Newsreader', serif;`, plus `--apelles-theme-name` and
 * `--apelles-theme-fonts: Newsreader:400,600 | Instrument Sans:400` for the
 * webfonts (families separated by `|`, since `;` ends a CSS declaration). A site that already owns such tokens can alias them
 * (`--apelles-theme-bg: var(--pigment-basalt)` is NOT resolved here: tokens must
 * be literal values, which is what makes the derivation deterministic).
 *
 * Returns only what the file said; the caller merges it over a base and
 * validates the whole with [`parseThemeDef`].
 */
export function themeDefFromTokens(css: string): Partial<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const re = /(--apelles-theme-[a-z0-9-]+)\s*:\s*([^;}]+)\s*;?/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const key = kebabToCamel(m[1].slice(TOKEN_PREFIX.length));
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (key === "fonts") {
      out.fonts = value
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((spec) => {
          const [family, weights] = spec.split(":");
          return {
            family: family.trim(),
            ...(weights ? { weights: weights.split(",").map((w) => w.trim()) } : {}),
          };
        });
    } else if ((THEME_NUMBER_FIELDS as readonly string[]).includes(key)) {
      out[key] = Number(value);
    } else if (key.startsWith("font")) {
      // A font stack keeps its quotes: `'Newsreader', serif` is the CSS.
      out[key] = m[2].trim();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The theme a manifest renders with, and where it came from.
 *
 *  `themeDef` wins when present (it IS the document's own look); otherwise a
 *  built-in is resolved by `theme` name, with the engine default for an absent
 *  or unknown one (`resolveTheme`'s forgiving rule, kept). */
export function resolveManifestTheme(manifest: {
  theme?: string | null;
  themeDef?: ThemeDef | null;
}): Theme {
  if (manifest.themeDef) return themeDefToTheme(manifest.themeDef);
  return resolveTheme(manifest.theme);
}

/** The webfonts each built-in's own loader downloads (`themeFonts.ts`),
 *  as data, so a copy of a built-in (`themeDefFromBuiltin`) loads the same faces. */
export const BUILTIN_THEME_FONTS: Readonly<Record<ThemeName, ThemeFont[]>> = {
  "dark-excalidraw": [{ family: "Kalam" }],
  "apelles-studio": [
    { family: "Newsreader", weights: ["400", "600"] },
    { family: "Instrument Sans", weights: ["400", "500", "600"] },
    { family: "IBM Plex Mono", weights: ["400", "500"] },
  ],
  "apelles-studio-light": [
    { family: "Newsreader", weights: ["400", "600"] },
    { family: "Instrument Sans", weights: ["400", "500", "600"] },
    { family: "IBM Plex Mono", weights: ["400", "500"] },
  ],
};
