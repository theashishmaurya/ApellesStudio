/**
 * @apelles/brand — the brand kit document (D-416).
 *
 * What it is: the zod schema of a brand kit, the one brand definition every tab,
 * template, custom component, the Clipper (D-411) and agents read, plus its
 * migration, the version rule and the asset-id shapes. A kit is DATA: colours
 * (five roles + an extended palette), typography (display/body/mono, each a
 * Google, system or user-supplied font file with its licence, and a size/weight
 * scale), logos (light/dark/mark), a motion style (ease, speed, stagger,
 * entrance), a caption style (an Edit caption preset + which brand colours and
 * font it takes), an optional grade look (a LUT for the Colorist), sound (a
 * sonic logo, music preferences) and references (images or videos a person
 * dropped in, each with a note saying what to take from it).
 *
 * What it does NOT do: store anything (`io.ts` is the Tauri boundary, the files
 * live through `apelles-brand`), check contrast (`contrast.ts`), or turn a kit
 * into any tab's look (each tab's own apply: `@apelles/motion`'s `brandTheme.ts`,
 * `@apelles/editor`'s `brandEdit.ts`, the Colorist's `coloristBrand.ts`).
 *
 * **Files are content-addressed, never paths** (`sha256:<hex>.<ext>`, the D-404
 * rule): a kit copied into a project (`apelles_brand::project`) carries its files
 * with it, and the same id is the same bytes on any machine.
 *
 * **Strict.** Unlike the Motion manifest (loose on load, D-403), a kit is small,
 * user-authored and fully owned by this schema, so an unknown key is refused
 * with its path: a typo'd field must not silently do nothing.
 */
import { z } from 'zod';

/** The kit schema this build writes. A newer file is refused ("update Apelles"). */
export const BRAND_KIT_SCHEMA_VERSION = 1;

/** Ids are file stems: lowercase kebab, at most 40, so `brand-<id>` is a valid
 *  Motion theme id (48). */
export const BRAND_KIT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const BRAND_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] as const;
export const BRAND_VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'] as const;
export const BRAND_FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2'] as const;
export const BRAND_LUT_EXTENSIONS = ['cube'] as const;
export const BRAND_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] as const;

const assetId = (exts: readonly string[], what: string) =>
  z
    .string()
    .regex(new RegExp(`^sha256:[0-9a-f]{64}\\.(${exts.join('|')})$`), `a ${what} asset id (sha256:<hex>.${exts.join('|')}) from brand_import_asset`);

export const imageAssetId = assetId(BRAND_IMAGE_EXTENSIONS, 'image');
export const fontAssetId = assetId(BRAND_FONT_EXTENSIONS, 'font');
export const lutAssetId = assetId(BRAND_LUT_EXTENSIONS, 'LUT');
export const audioAssetId = assetId(BRAND_AUDIO_EXTENSIONS, 'audio');
export const referenceAssetId = assetId([...BRAND_IMAGE_EXTENSIONS, ...BRAND_VIDEO_EXTENSIONS], 'image or video');

/** The extension of an asset id, lowercase (`sha256:…ttf` → `ttf`). */
export function assetExtension(id: string): string {
  return id.slice(id.lastIndexOf('.') + 1);
}

/** `sha256:ab…cd.png` → `ab…cd.png`, the file's name in an asset folder. */
export function assetFileName(id: string): string {
  return id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'an opaque #rrggbb colour');

/** A family name a CSS stack and Google Fonts can both carry. */
const family = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ]*$/, 'a font family name: letters, digits and spaces');

const weight = z.string().regex(/^[1-9]00$/, 'a weight like "400" or "700"');

/** One typeface the kit uses, and where its letters come from. */
export const fontRefSchema = z
  .object({
    family,
    /** google: downloaded by name (Motion); system: installed on the machine;
     *  file: a font file imported into the kit (`file`, with its `licence`). */
    source: z.enum(['google', 'system', 'file']),
    file: fontAssetId.optional(),
    /** what the licence allows, in the person's words ("OFL 1.1", "bought a
     *  desktop + video licence from Klim, 2026"). Required for a file. */
    licence: z.string().min(1).max(240).optional(),
    weights: z.array(weight).max(9).optional(),
    /** The Edit tab's catalogue key to use when this face is not a .ttf/.otf
     *  file the Edit renderers can read (`chroma_text_fonts`, e.g. "serif-bold"). */
    editFallback: z.string().min(1).max(40).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.source === 'file') {
      if (!f.file) ctx.addIssue({ code: 'custom', path: ['file'], message: 'a file font needs its file (brand_import_asset)' });
      if (!f.licence) ctx.addIssue({ code: 'custom', path: ['licence'], message: 'say what the licence allows for a font file you supply' });
    } else if (f.file) {
      ctx.addIssue({ code: 'custom', path: ['file'], message: `a ${f.source} font has no file; use source "file"` });
    }
  });

export type FontRef = z.infer<typeof fontRefSchema>;

export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export const EASE_PRESETS = ['out', 'inOut', 'anticipate', 'linear'] as const;
export const ENTRANCES = ['none', 'fade', 'pop', 'rise', 'draw'] as const;

export const motionStyleSchema = z
  .object({
    /** a named curve or a cubic-bezier [x1, y1, x2, y2] */
    ease: z.union([z.enum(EASE_PRESETS), z.tuple([z.number(), z.number(), z.number(), z.number()])]),
    /** 1 = the engine's own pace; 2 = twice as fast (entrances take half as long) */
    speed: z.number().min(0.25).max(4),
    /** seconds between consecutive elements entering */
    stagger: z.number().min(0).max(2),
    entrance: z.enum(ENTRANCES),
  })
  .strict();

export type MotionStyle = z.infer<typeof motionStyleSchema>;

export const referenceSchema = z
  .object({
    /** stable within the kit; minted from the file name */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    asset: referenceAssetId,
    /** what to take from it: "use my work for materials and framing" */
    note: z.string().min(1).max(500),
    /** the person's own work, or someone else's reference */
    kind: z.enum(['own-work', 'reference']),
    /** the file name it was imported from, for display */
    name: z.string().max(200).optional(),
  })
  .strict();

export type BrandReference = z.infer<typeof referenceSchema>;

export const brandKitSchema = z
  .object({
    schemaVersion: z.literal(BRAND_KIT_SCHEMA_VERSION),
    id: z.string().regex(BRAND_KIT_ID_PATTERN, 'lowercase letters, digits and hyphens, at most 40'),
    name: z.string().min(1).max(80),
    /** bumped on every save to the library (`versionForSave`) */
    version: z.number().int().min(1),
    description: z.string().max(500).optional(),
    colors: z
      .object({
        primary: hex,
        secondary: hex,
        accent: hex,
        background: hex,
        text: hex,
        palette: z
          .array(z.object({ name: z.string().min(1).max(40), hex }).strict())
          .max(16)
          .optional(),
      })
      .strict(),
    typography: z
      .object({
        display: fontRefSchema,
        body: fontRefSchema,
        mono: fontRefSchema.optional(),
        scale: z
          .object({
            /** body size at 1080p, px */
            base: z.number().min(8).max(200),
            /** each heading step multiplies by this (1.25 = major third) */
            ratio: z.number().min(1).max(3),
            displayWeight: weight,
            bodyWeight: weight,
          })
          .strict()
          .optional(),
      })
      .strict(),
    logos: z
      .object({
        /** for light backgrounds */
        light: imageAssetId.optional(),
        /** for dark backgrounds */
        dark: imageAssetId.optional(),
        /** the symbol alone */
        mark: imageAssetId.optional(),
      })
      .strict()
      .optional(),
    motion: motionStyleSchema.optional(),
    captions: z
      .object({
        /** an Edit caption preset id (`editor_list_caption_presets`) */
        preset: z.string().min(1).max(64),
        font: z.enum(['display', 'body']).optional(),
        color: z.enum(COLOR_ROLES).optional(),
        boxColor: z.enum(COLOR_ROLES).optional(),
      })
      .strict()
      .optional(),
    look: z
      .object({
        lut: lutAssetId,
        /** 0..100, the Colorist's LUT intensity */
        intensity: z.number().min(0).max(100),
        name: z.string().max(80).optional(),
      })
      .strict()
      .optional(),
    sound: z
      .object({
        sonicLogo: audioAssetId.optional(),
        music: z
          .object({
            mood: z.string().max(200).optional(),
            bpm: z.tuple([z.number().min(30).max(300), z.number().min(30).max(300)]).optional(),
            tracks: z.array(audioAssetId).max(16).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    references: z.array(referenceSchema).max(64).optional(),
  })
  .strict()
  .superRefine((k, ctx) => {
    const ids = new Set<string>();
    for (const [i, r] of (k.references ?? []).entries()) {
      if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: ['references', i, 'id'], message: `duplicate reference id "${r.id}"` });
      ids.add(r.id);
    }
    const bpm = k.sound?.music?.bpm;
    if (bpm && bpm[0] > bpm[1]) ctx.addIssue({ code: 'custom', path: ['sound', 'music', 'bpm'], message: 'bpm is [low, high]' });
  });

export type BrandKit = z.infer<typeof brandKitSchema>;

/** One problem, by path (`colors.primary: an opaque #rrggbb colour`). */
export interface KitIssue {
  path: string;
  message: string;
}

export type ParsedKit = { kit: BrandKit } | { error: string; issues: KitIssue[] };

/** Parse untrusted JSON into a kit (after migrating it), naming every problem. */
export function parseBrandKit(raw: unknown): ParsedKit {
  const migrated = migrateBrandKit(raw);
  if ('error' in migrated) return { error: migrated.error, issues: [{ path: 'schemaVersion', message: migrated.error }] };
  const parsed = brandKitSchema.safeParse(migrated.value);
  if (parsed.success) return { kit: parsed.data };
  const issues = parsed.error.issues.map((i) => ({
    path: i.path.length ? i.path.map(String).join('.') : '(kit)',
    message: i.message,
  }));
  return { error: issues.map((i) => `${i.path}: ${i.message}`).join('; '), issues };
}

/**
 * Bring an older file up to this schema. Version 1 is the first, so the table is
 * empty; a file from a NEWER Apelles is refused rather than guessed at.
 */
export function migrateBrandKit(raw: unknown): { value: unknown } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'a brand kit is a JSON object' };
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof v === 'number' && v > BRAND_KIT_SCHEMA_VERSION) {
    return { error: `schemaVersion ${v} is newer than this Apelles understands (${BRAND_KIT_SCHEMA_VERSION}) — update Apelles` };
  }
  return { value: raw };
}

/** The version a kit is saved as: one past what the library holds under its id
 *  (1 for a new kit). The ONE place versions are decided (D-407's rule). */
export function versionForSave(libraryVersion: number | undefined): number {
  return (libraryVersion ?? 0) + 1;
}

/** A blank kit to start from: neutral colours, system type, everything optional left out. */
export function starterKit(id: string, name: string): BrandKit {
  return {
    schemaVersion: BRAND_KIT_SCHEMA_VERSION,
    id,
    name,
    version: 1,
    colors: { primary: '#2f6fed', secondary: '#1b2a4a', accent: '#f5a524', background: '#0f1115', text: '#f4f4f5' },
    typography: {
      display: { family: 'Georgia', source: 'system', editFallback: 'serif-bold' },
      body: { family: 'Arial', source: 'system', editFallback: 'sans' },
    },
    motion: { ease: 'out', speed: 1, stagger: 0.08, entrance: 'rise' },
    captions: { preset: 'plain-subtitle', font: 'body' },
  };
}

/** Every asset id a kit names, sorted, without repeats (what a project copy
 *  must carry; mirrors `apelles_brand::assets::asset_ids_in`). */
export function kitAssetIds(kit: BrandKit): string[] {
  const ids = new Set<string>();
  const add = (v: string | undefined) => {
    if (v) ids.add(v);
  };
  for (const role of ['display', 'body', 'mono'] as const) add(kit.typography[role]?.file);
  add(kit.logos?.light);
  add(kit.logos?.dark);
  add(kit.logos?.mark);
  add(kit.look?.lut);
  add(kit.sound?.sonicLogo);
  for (const t of kit.sound?.music?.tracks ?? []) add(t);
  for (const r of kit.references ?? []) add(r.asset);
  return [...ids].sort();
}

/** A reference id from a file name: kebab, unique within `taken`. Deterministic. */
export function referenceIdFor(name: string, taken: readonly string[]): string {
  const stem = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'reference';
  const base = /^[a-z0-9]/.test(stem) ? stem : `r-${stem}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}
