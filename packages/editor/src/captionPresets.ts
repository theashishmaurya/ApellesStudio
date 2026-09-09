// @apelles/editor — the caption preset library (D-243/D-244,
// `docs/notes/caption-presets.md`).
//
// **What it is:** the named, styled caption looks the Captions panel offers,
// each one a plain `CaptionStyle` (+ its `CaptionAnimation`). Picking a preset
// is nothing more than writing that style onto a subtitle track through the
// existing `set_caption_style` op.
//
// **What it does NOT do:** no rendering, no placement, no storage of its own.
// A preset is not a new kind of object and nothing in the model ever refers to
// one by name — the moment it is applied it IS the track's style, fully
// editable field by field in the Inspector (owner, 2026-09-08: "keep the style
// configurable as much as possible"). That is the whole reason this file can
// be pure data: nothing downstream needs to know a preset existed.
//
// ## Provenance and licence (D-244)
//
// The looks are adapted from **HyperFrames**' own caption catalogue —
// `github.com/heygen-com/hyperframes`, Apache License 2.0, "Copyright 2026
// HeyGen, Inc." (verified against the repo's own `LICENSE`, and its
// `docs/public/catalog/components/caption-*.json` sources, on 2026-09-08).
// Apache-2.0 is one-way compatible with this repo's AGPL-3.0, so the
// combined work stays AGPL-3.0.
//
// **What was taken and what was changed.** No HyperFrames code is in this
// repo: their compositions are HTML + CSS + GSAP rendered in a browser, and
// Apelles renders captions twice, natively — `ab_glyph` for the live preview
// and ffmpeg `drawtext` for the export (owner, 2026-09-08: "keeps things
// local, fast, no new heavy runtime dependency chroma only"). What is reused
// is the **design**: the colour values, type treatment, per-word timing feel
// and layout of each named look, read off their real source and re-expressed
// in `CaptionStyle`/`CaptionAnimation` terms. Per-preset divergences (a wipe
// that became a rise, a rounded box that became square) are named in each
// preset's own `note`, and the presets from that catalogue NOT built here are
// listed with their reasons in D-243.
//
// The same relationship this repo already has with
// `scratch/resolve-reference/` — a real reference, a native reimplementation.

import {
  DEFAULT_CAPTION_BOX_PADDING,
  DEFAULT_CAPTION_LINE_SPACING,
  type CaptionStyle,
} from './caption';

/** One entry in the panel's preset library.
 *
 *  `style` is applied verbatim; everything else is presentation for the
 *  library grid. Deliberately NOT stored anywhere once applied — see the
 *  header. */
export interface CaptionPreset {
  /** Stable id — what `editor_add_caption_preset` names, and the React key.
   *  Matches the HyperFrames component slug wherever one was adapted, so the
   *  reference is findable from the code. */
  id: string;
  /** Human label for the library grid. */
  label: string;
  /** One-line description of the look, shown under the thumbnail. */
  description: string;
  /** Tone grouping the library grid sections by — HyperFrames' own
   *  tone→component taxonomy, kept because it is a genuinely useful way to
   *  find a caption look and because it makes the mapping back to the
   *  reference obvious. */
  group: CaptionPresetGroup;
  /** Where this look came from, and anything about it that is deliberately
   *  not a literal reproduction. Rendered in the panel as the preset's
   *  tooltip, so the divergence is visible to the person choosing it rather
   *  than buried in a doc. */
  note: string;
  /** The style this preset applies — the whole payload. */
  style: CaptionStyle;
}

/** The tone groups the library is sectioned by. */
export type CaptionPresetGroup =
  | 'Plain'
  | 'Social'
  | 'Karaoke'
  | 'Clean'
  | 'Editorial';

/** Font catalogue keys used below.
 *
 *  **A known fidelity gap, deliberately taken** (D-243): HyperFrames' looks
 *  are set in Montserrat, Anton, Poppins, Outfit, Space Grotesk and Gabarito,
 *  and Apelles' font catalogue (`chroma::text::TEXT_FONTS`) is system faces
 *  only — Arial/Impact/Georgia/Courier — because both renderers must read the
 *  same single-face `.ttf` (D-212). Each preset therefore names the nearest
 *  catalogue face, and the `font` field stays editable like every other.
 *  Bundling the real (SIL OFL 1.1, freely redistributable) faces is a named
 *  follow-up in D-243, not a thing this pass silently faked. */
const FONT_HEAVY = 'sans-black';
const FONT_BOLD = 'sans-bold';
const FONT_DISPLAY = 'impact';
const FONT_SERIF_BOLD = 'serif-bold';

/**
 * The library, in the order the panel shows it.
 *
 * Every value here is a DEFAULT, not a constant: applying a preset copies
 * these numbers onto the track's style, where the Inspector then edits any of
 * them. Nothing re-reads this list afterwards.
 */
export const CAPTION_PRESETS: readonly CaptionPreset[] = [
  {
    id: 'plain-subtitle',
    label: 'Subtitle',
    description: 'The standard broadcast subtitle — white on a soft black box.',
    group: 'Plain',
    note: "Apelles' own D-229 default, not adapted from anything. The look every imported .srt starts with.",
    style: {
      font: FONT_BOLD,
      size: 0.055,
      color: '#FFFFFF',
      box_enabled: true,
      box_color: '#000000',
      box_opacity: 0.6,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: DEFAULT_CAPTION_LINE_SPACING,
      align: 'center',
      position_x: 0.5,
      position_y: 0.82,
      animation: { kind: 'none' },
    },
  },
  {
    id: 'plain-clean',
    label: 'Clean',
    description: 'No box — plain white type for footage that is already dark.',
    group: 'Plain',
    note: "Apelles' own. The same geometry as Subtitle with the background box off.",
    style: {
      font: FONT_BOLD,
      size: 0.055,
      color: '#FFFFFF',
      box_enabled: false,
      box_color: '#000000',
      box_opacity: 0,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: DEFAULT_CAPTION_LINE_SPACING,
      align: 'center',
      position_x: 0.5,
      position_y: 0.82,
      animation: { kind: 'none' },
    },
  },
  {
    id: 'caption-highlight',
    label: 'Highlight',
    description: 'TikTok-style — the line stays up, each word lit by a red sweep as it lands.',
    group: 'Social',
    note:
      'Adapted from HyperFrames caption-highlight (Apache-2.0). Its red gradient box becomes a solid #FF1745 and its 10px rounded corners become square — ffmpeg drawbox has neither a gradient nor a radius, so a preview with them could not be exported (D-243).',
    style: {
      font: FONT_HEAVY,
      // 80px against a 1080-tall frame in the reference.
      size: 80 / 1080,
      color: '#FFFFFF',
      box_enabled: false,
      box_color: '#000000',
      box_opacity: 0,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: DEFAULT_CAPTION_LINE_SPACING,
      align: 'center',
      position_x: 0.5,
      // The reference sits its group 140px off the bottom of 1080.
      position_y: 1 - 140 / 1080,
      animation: {
        kind: 'highlight',
        active_box_color: '#FF1745',
        active_box_opacity: 1,
        // 12px / 6px padding at 80px type in the reference.
        active_box_pad_x: 12 / 80,
        active_box_pad_y: 6 / 80,
        // The reference sweeps its box in over 0.15s.
        enter_secs: 0.15,
        enter_rise: 0,
      },
    },
  },
  {
    id: 'caption-kinetic-slam',
    label: 'Kinetic Slam',
    description: 'One full-screen word per beat, slamming in from alternating sides.',
    group: 'Social',
    note:
      'Adapted from HyperFrames caption-kinetic-slam (Apache-2.0). Its back.out scale-pop becomes a slide: ffmpeg fontsize is the measurement both renderers agree through, so animating it would break preview/export parity (D-243). Anton is stood in for by Impact.',
    style: {
      font: FONT_DISPLAY,
      size: 0.16,
      color: '#FFFFFF',
      box_enabled: false,
      box_color: '#000000',
      box_opacity: 0,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: DEFAULT_CAPTION_LINE_SPACING,
      align: 'center',
      position_x: 0.5,
      position_y: 0.46,
      animation: {
        kind: 'slam',
        enter_secs: 0.22,
        enter_rise: 0,
      },
    },
  },
  {
    id: 'caption-pill-karaoke',
    label: 'Pill Karaoke',
    description: 'Follow-along lyrics — spoken words dim, the live word wears a bright pill.',
    group: 'Karaoke',
    note:
      'Adapted from HyperFrames caption-pill-karaoke (Apache-2.0). The pill is a square box for the same drawbox reason as Highlight (D-243).',
    style: {
      font: FONT_BOLD,
      size: 0.07,
      color: '#FFFFFF',
      box_enabled: false,
      box_color: '#000000',
      box_opacity: 0,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: DEFAULT_CAPTION_LINE_SPACING,
      align: 'center',
      position_x: 0.5,
      position_y: 0.8,
      animation: {
        kind: 'karaoke',
        active_color: '#0A0A0A',
        spoken_color: '#8A8F98',
        upcoming_color: '#FFFFFF',
        active_box_color: '#4ADE80',
        active_box_opacity: 1,
        active_box_pad_x: 0.16,
        active_box_pad_y: 0.08,
        enter_secs: 0.1,
        enter_rise: 0,
      },
    },
  },
  {
    id: 'caption-neon-accent',
    label: 'Neon Accent',
    description: 'Words light up in neon as they are spoken, and stay lit.',
    group: 'Karaoke',
    note:
      'Adapted from HyperFrames caption-neon-accent (Apache-2.0). The recolour and per-word timing are reproduced; its actual neon GLOW is not — a real bloom needs a blur in both renderers, which is a named deferral in D-243.',
    style: {
      font: FONT_HEAVY,
      size: 0.075,
      color: '#FFFFFF',
      box_enabled: false,
      box_color: '#000000',
      box_opacity: 0,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: DEFAULT_CAPTION_LINE_SPACING,
      align: 'center',
      position_x: 0.5,
      position_y: 1 - 100 / 1080,
      animation: {
        kind: 'karaoke',
        active_color: '#22D3EE',
        spoken_color: '#22D3EE',
        upcoming_color: '#5B6472',
        enter_secs: 0.12,
        enter_rise: 0,
      },
    },
  },
  {
    id: 'caption-clip-wipe',
    label: 'Clip Wipe',
    description: 'Clean corporate build — each word rises into the line and stays.',
    group: 'Clean',
    note:
      'Adapted from HyperFrames caption-clip-wipe (Apache-2.0). Its per-word clipPath wipe becomes a rise-and-fade: ffmpeg drawtext cannot clip a text box, so the wipe itself is not reproducible in the export (D-243).',
    style: {
      font: FONT_BOLD,
      size: 88 / 1080,
      color: '#FFFFFF',
      box_enabled: false,
      box_color: '#000000',
      box_opacity: 0,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: DEFAULT_CAPTION_LINE_SPACING,
      align: 'center',
      position_x: 0.5,
      position_y: 1 - 120 / 1080,
      animation: {
        kind: 'build',
        enter_secs: 0.25,
        enter_rise: 0.18,
      },
    },
  },
  {
    id: 'caption-editorial-build',
    label: 'Editorial',
    description: 'Elegant serif that assembles itself word by word, warm on dark.',
    group: 'Editorial',
    note:
      "Adapted from HyperFrames caption-editorial-emphasis (Apache-2.0), partially: its cream-on-black palette and word build are reproduced, its dramatic per-word SIZE contrast is not — per-word size is the one property excluded from Apelles' animation vocabulary (D-243).",
    style: {
      font: FONT_SERIF_BOLD,
      size: 0.075,
      color: '#F5F0D0',
      box_enabled: false,
      box_color: '#000000',
      box_opacity: 0,
      box_padding: DEFAULT_CAPTION_BOX_PADDING,
      line_spacing: 0.3,
      align: 'center',
      position_x: 0.5,
      position_y: 0.78,
      animation: {
        kind: 'build',
        enter_secs: 0.3,
        enter_rise: 0.25,
      },
    },
  },
] as const;

/** Look one preset up by id. `undefined` for an unknown id rather than a
 *  throw: the id can arrive from an MCP call, where an unknown name must
 *  become a readable refusal at the caller rather than a crash here. */
export function captionPresetById(id: string): CaptionPreset | undefined {
  return CAPTION_PRESETS.find((p) => p.id === id);
}

/** The preset ids, for MCP's own enum and for error messages that need to
 *  list what IS valid. */
export function captionPresetIds(): string[] {
  return CAPTION_PRESETS.map((p) => p.id);
}

/** The presets grouped for the library grid, preserving `CAPTION_PRESETS`
 *  order within and across groups. */
export function captionPresetGroups(): Array<{
  group: CaptionPresetGroup;
  presets: CaptionPreset[];
}> {
  const out: Array<{ group: CaptionPresetGroup; presets: CaptionPreset[] }> = [];
  for (const preset of CAPTION_PRESETS) {
    const existing = out.find((g) => g.group === preset.group);
    if (existing) existing.presets.push(preset);
    else out.push({ group: preset.group, presets: [preset] });
  }
  return out;
}
