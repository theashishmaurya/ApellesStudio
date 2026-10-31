/**
 * @apelles/tokens — theme values (D-039, D-432 P1).
 *
 * The ONE definition of every colour token's value, per theme. `app/src/utils/themes.ts`
 * imports these and writes them onto `:root` as `--app-*` custom properties; the
 * `@theme` block in `app/src/styles.css` aliases each as a Tailwind `--color-*` token
 * and `packages/ui/src/styles.css` maps the shadcn names onto those. This file holds
 * values only: no CSS, no React, no Tauri.
 *
 * Does NOT hold: the type scale, radii and shadows (those are Tailwind v4 `@theme`
 * variables in `app/src/styles.css`, the canonical place), or marker colours (document
 * data, D-222).
 *
 * Accent (D-432, owner answer 2026-10-31): Apelles terracotta, not macOS blue.
 * The website brand terracotta is `#a6432c`; on the dark surfaces it only reaches
 * 2.5:1, below the 3:1 a focus ring or active control needs, so the dark UI uses
 * `#c4502f` (same hue, lifted): 4.63:1 against white button text and 3.26:1 against
 * `surface`. Terracotta used as *text* on dark takes `accent-text` instead (5.9:1).
 * Timeline selection and the playhead stay amber, as separate tokens.
 */

export type ThemeId = 'dark' | 'light' | 'grey';

/** Every token name, without the `--app-` prefix. */
export const TOKEN_NAMES = [
  // chrome (existing names)
  'bg-primary',
  'bg-secondary',
  'surface',
  'card-active',
  'button-text',
  'text-primary',
  'text-secondary',
  'accent',
  'border-color',
  'hover-color',
  // chrome (new, D-432)
  'text-tertiary',
  'divider',
  'surface-raised',
  'destructive',
  'accent-text',
  'focus-ring',
  // timeline
  'timeline-bg',
  'lane-alt',
  'selection',
  'playhead',
  'skimmer',
  // clips: opaque media colours, identical in every theme
  'clip-label',
  'clip-video',
  'clip-video-strip',
  'clip-video-wave',
  'clip-video-wave-ink',
  'clip-audio',
  'clip-audio-strip',
  'clip-audio-wave-ink',
  'clip-text',
  'clip-text-strip',
  'clip-caption',
  'clip-caption-strip',
  'clip-adjustment',
  'clip-adjustment-strip',
  'clip-motion',
  'clip-motion-strip',
  'clip-gap',
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type ThemeValues = Record<TokenName, string>;

/**
 * Clip colours are media colours, not chrome: FCP keeps them constant across
 * appearances, so one set serves all themes. All opaque (the old 55 %-alpha
 * literals over a grey backing read muddy).
 */
const CLIP_COLORS = {
  'clip-label': '#e8ecf4',
  'clip-video': '#3d5a8a',
  'clip-video-strip': '#2d3f61',
  'clip-video-wave': '#677b9d',
  'clip-video-wave-ink': '#b7c4dd',
  'clip-audio': '#2a5530',
  'clip-audio-strip': '#214427',
  'clip-audio-wave-ink': '#7fb38a',
  'clip-text': '#5b4a9e',
  'clip-text-strip': '#44397a',
  'clip-caption': '#7a6838',
  'clip-caption-strip': '#5c4e2a',
  'clip-adjustment': '#8a3f7e',
  'clip-adjustment-strip': '#6a2f61',
  'clip-motion': '#2c7a78',
  'clip-motion-strip': '#1f5b59',
  'clip-gap': '#3a3a3e',
} as const;

const DARK: ThemeValues = {
  'bg-primary': '#1e1e20',
  'bg-secondary': '#2e2e32',
  surface: '#262629',
  'card-active': '#3a3a3f',
  'button-text': '#ffffff',
  'text-primary': '#ebebf0',
  'text-secondary': '#9a9aa3',
  accent: '#c4502f',
  'border-color': '#333338',
  'hover-color': '#ebebf0',
  'text-tertiary': '#6b6b74',
  divider: '#111113',
  'surface-raised': '#2c2c30',
  destructive: '#ff5a50',
  'accent-text': '#e8896b',
  'focus-ring': '#c4502f',
  'timeline-bg': '#1a1a1c',
  'lane-alt': '#1f1f22',
  selection: '#f5c542',
  playhead: '#f5c542',
  skimmer: '#ff5a5f',
  ...CLIP_COLORS,
};

/** Light and grey carry values for every name but are not redesigned in v0.4 (D-432). */
const LIGHT: ThemeValues = {
  'bg-primary': 'rgb(245, 245, 245)',
  'bg-secondary': 'rgb(255, 255, 255)',
  surface: 'rgb(241, 241, 241)',
  'card-active': 'rgb(250, 250, 250)',
  'button-text': 'rgb(255, 255, 255)',
  'text-primary': 'rgb(20, 20, 20)',
  'text-secondary': 'rgb(108, 108, 108)',
  accent: 'rgb(198, 142, 110)',
  'border-color': 'rgb(224, 224, 224)',
  'hover-color': 'rgb(198, 142, 110)',
  'text-tertiary': '#8e8e96',
  divider: '#c9c9ce',
  'surface-raised': '#ffffff',
  destructive: '#d70015',
  'accent-text': '#a6432c',
  'focus-ring': 'rgb(198, 142, 110)',
  'timeline-bg': '#e6e6e9',
  'lane-alt': '#dedee2',
  selection: '#d9a400',
  playhead: '#d9a400',
  skimmer: '#e0383e',
  ...CLIP_COLORS,
};

const GREY: ThemeValues = {
  'bg-primary': 'rgb(112, 112, 112)',
  'bg-secondary': 'rgb(118, 118, 118)',
  surface: 'rgb(108, 108, 108)',
  'card-active': 'rgb(133, 133, 133)',
  'button-text': 'rgb(45, 45, 45)',
  'text-primary': 'rgb(240, 240, 240)',
  'text-secondary': 'rgb(180, 180, 180)',
  accent: 'rgb(220, 220, 220)',
  'border-color': 'rgb(138, 138, 138)',
  'hover-color': 'rgb(220, 220, 220)',
  'text-tertiary': '#b0b0b0',
  divider: '#555555',
  'surface-raised': '#7a7a7a',
  destructive: '#ff6a5f',
  'accent-text': 'rgb(240, 240, 240)',
  'focus-ring': 'rgb(220, 220, 220)',
  'timeline-bg': '#666666',
  'lane-alt': '#6b6b6b',
  selection: '#f5c542',
  playhead: '#f5c542',
  skimmer: '#ff5a5f',
  ...CLIP_COLORS,
};

export const THEME_VALUES: Record<ThemeId, ThemeValues> = {
  dark: DARK,
  light: LIGHT,
  grey: GREY,
};

/** `{ '--app-surface': '#262629', … }` — what the app writes onto `:root`. */
export function cssVariablesFor(theme: ThemeId): Record<string, string> {
  const values = THEME_VALUES[theme];
  return Object.fromEntries(TOKEN_NAMES.map((name) => [`--app-${name}`, values[name]]));
}
