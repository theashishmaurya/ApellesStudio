/**
 * @apelles/motion — a brand kit, as the Motion tab uses it (D-416).
 *
 * What it is: three pure functions.
 * - `themeDefFromBrandKit`: the kit → a D-399 `ThemeDef` named `brand-<kit id>`.
 *   The existing theme system is the mechanism (one token source, CLAUDE.md): a
 *   kit does not get a parallel styling path, it generates a theme, and every
 *   primitive, template colour slot (D-407) and custom component (D-409, which
 *   reads `theme`) picks it up from there. Deterministic: the same kit gives the
 *   same definition, byte for byte (no clock, no randomness, sorted lists).
 * - `brandLayerDefaults`: the kit's motion style as DEFAULTS for a new layer
 *   (`enter`, `enterDur`) on the primitives that have an entrance; the caller's
 *   own props still win. Nothing existing is touched.
 * - `restyleManifest`: the explicit op that DOES touch existing work (asked for
 *   with `restyle_existing`): every entrance-capable layer gets the kit's
 *   entrance and duration, every layer transform key the kit's ease.
 *
 * What it does NOT do: import files (the applier does, `brandApply.ts`), or
 * write the manifest (callers commit).
 */
import { primitivePropShape, type Layer, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import type { PrimitiveUse } from './catalog';
import { THEMES } from '@apelles/motion-engine/src/design';
import type { ThemeDef, ThemeFont, ThemeFontFile } from '@apelles/motion-engine/src/themeDef';
import type { BrandKit, FontRef, MotionStyle } from '@apelles/brand';
import { clampEaseCurve, type EaseCurve } from './easeCurve';

/** The prefix a kit's generated theme is named with. */
export const BRAND_THEME_PREFIX = 'brand-';

/** An entrance at speed 1 lasts this long (the primitives' own default, 12
 *  frames at 30 fps). */
export const ENTER_BASE_SECONDS = 0.4;

/** The base the non-colour look fields come from: Apelles Studio's clean
 *  geometry (no roughness, no drift), the look a brand video wants. */
const BASE = THEMES['apelles-studio'];

/** The named curves a kit's `ease` may be, as bezier control points (the
 *  engine's own `motion.ease` values, plus linear). */
export const BRAND_EASE_CURVES: Readonly<Record<'out' | 'inOut' | 'anticipate' | 'linear', EaseCurve>> = {
  out: [0.22, 1, 0.36, 1],
  inOut: [0.65, 0, 0.35, 1],
  anticipate: [0.68, -0.55, 0.27, 1.55],
  linear: [0, 0, 1, 1],
};

export function brandThemeName(kit: Pick<BrandKit, 'id'>): string {
  return `${BRAND_THEME_PREFIX}${kit.id}`;
}

/** `#rrggbb` mixed toward `toward` by `t` (0..1), rounded per channel. */
export function mixHex(from: string, toward: string, t: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t);
  };
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

const GENERIC: Record<'display' | 'body' | 'mono', string> = {
  display: 'system-ui, sans-serif',
  body: 'system-ui, sans-serif',
  mono: 'ui-monospace, Menlo, monospace',
};

function stack(font: FontRef, role: 'display' | 'body' | 'mono'): string {
  return `'${font.family}', ${GENERIC[role]}`;
}

/** The kit → its Motion theme. */
export function themeDefFromBrandKit(kit: BrandKit): ThemeDef {
  const { colors, typography } = kit;
  const roles: Array<['display' | 'body' | 'mono', FontRef | undefined]> = [
    ['display', typography.display],
    ['body', typography.body],
    ['mono', typography.mono],
  ];
  const weightFor = (role: 'display' | 'body' | 'mono', font: FontRef): string =>
    font.weights?.[0] ?? (role === 'display' ? typography.scale?.displayWeight : typography.scale?.bodyWeight) ?? '400';

  const fonts: ThemeFont[] = [];
  const fontFiles: ThemeFontFile[] = [];
  for (const [role, font] of roles) {
    if (!font) continue;
    if (font.source === 'google' && !fonts.some((f) => f.family === font.family)) {
      fonts.push({ family: font.family, ...(font.weights ? { weights: [...font.weights].sort() } : {}) });
    }
    if (font.source === 'file' && font.file && !fontFiles.some((f) => f.src === font.file)) {
      fontFiles.push({ family: font.family, src: font.file, weight: weightFor(role, font) });
    }
  }

  return {
    name: brandThemeName(kit),
    description: `Brand kit "${kit.name}" v${kit.version}`,
    bg: colors.background,
    bgDeep: mixHex(colors.background, colors.text, 0.06),
    stroke: colors.text,
    strokeSoft: mixHex(colors.text, colors.background, 0.6),
    text: colors.text,
    textDim: mixHex(colors.text, colors.background, 0.35),
    accent: colors.primary,
    accentSignal: colors.accent,
    strokeWidth: BASE.strokeWidth,
    roughness: BASE.roughness,
    bowing: BASE.bowing,
    fontDisplay: stack(typography.display, 'display'),
    fontUi: stack(typography.body, 'body'),
    fontMono: typography.mono ? stack(typography.mono, 'mono') : BASE.fontMono,
    ambientDriftPx: BASE.ambientDriftPx,
    ...(fonts.length > 0 ? { fonts } : {}),
    ...(fontFiles.length > 0 ? { fontFiles } : {}),
  };
}

/** The kit's ease as bezier control points. */
export function brandEase(style: MotionStyle): EaseCurve {
  return clampEaseCurve(typeof style.ease === 'string' ? BRAND_EASE_CURVES[style.ease] : style.ease);
}

/** Seconds an entrance lasts at the kit's speed, to the millisecond. */
export function brandEnterSeconds(style: MotionStyle): number {
  return Math.round((ENTER_BASE_SECONDS / style.speed) * 1000) / 1000;
}

/** Whether a primitive has the shared entrance (`enter` + `enterDur`, D-405's
 *  `enterProps`). `text` has an `enter` of its own shape (`{at, stagger}`) and
 *  no `enterDur`, so it is not one. */
export function hasEntrance(use: string): boolean {
  const shape: Record<string, unknown> | undefined = primitivePropShape(use as PrimitiveUse);
  return shape !== undefined && 'enterDur' in shape && 'enter' in shape;
}

/** Defaults a NEW layer of `use` takes from the kit's motion style; `{}` for a
 *  primitive with no entrance or a kit with no motion style. */
export function brandLayerDefaults(use: string, style: MotionStyle | undefined): Record<string, unknown> {
  if (!style || !hasEntrance(use)) return {};
  return { enter: style.entrance, enterDur: brandEnterSeconds(style) };
}

/** What `restyleManifest` changed. */
export interface RestyleReport {
  entrances: number;
  keys: number;
}

/**
 * The explicit restyle: every entrance-capable layer (groups' children too)
 * gets the kit's entrance and duration; every layer transform key gets the
 * kit's ease. Returns a new manifest; the input is not mutated.
 */
export function restyleManifest(manifest: Manifest, style: MotionStyle): { manifest: Manifest; report: RestyleReport } {
  const next = JSON.parse(JSON.stringify(manifest)) as Manifest;
  const ease = [...brandEase(style)] as [number, number, number, number];
  const enterDur = brandEnterSeconds(style);
  const report: RestyleReport = { entrances: 0, keys: 0 };
  const visit = (layer: Layer) => {
    const l = layer as Layer & {
      use: string;
      enter?: string;
      enterDur?: number;
      transform?: { keys?: Array<{ ease?: unknown }> };
      children?: Layer[];
    };
    if (hasEntrance(l.use)) {
      l.enter = style.entrance;
      l.enterDur = enterDur;
      report.entrances += 1;
    }
    for (const key of l.transform?.keys ?? []) {
      key.ease = ease;
      report.keys += 1;
    }
    for (const child of l.children ?? []) visit(child);
  };
  for (const scene of next.scenes) for (const layer of scene.layers ?? []) visit(layer);
  return { manifest: next, report };
}
