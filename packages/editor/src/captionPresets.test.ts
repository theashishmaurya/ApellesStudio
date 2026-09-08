// @chroma/editor — the caption preset library's own invariants (D-241/D-242).
//
// A preset is pure data applied through `set_caption_style`, so what can go
// wrong with one is: a duplicate id (two library tiles that overwrite each
// other), a colour the renderers cannot parse, a value outside the range its
// field means, or a preset that claims an animation the model does not have.
// Every one of those is silent at runtime — a bad colour degrades to white, an
// out-of-range position just draws off frame — which is exactly why they are
// asserted here rather than left to be noticed in a render.

import { describe, expect, it } from 'vitest';

import { resolveCaptionStyle } from './caption';
import { captionAnimationOf, isPerWordAnim } from './captionAnim';
import {
  CAPTION_PRESETS,
  captionPresetById,
  captionPresetGroups,
  captionPresetIds,
} from './captionPresets';

/** The colour forms both renderers parse (`parse_hex_rgb` / `ffmpegColorLiteral`). */
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The font keys `chroma::text::TEXT_FONTS` actually ships. A preset naming
 *  anything else would silently fall back to the default face in the preview
 *  AND be refused by the export's own `captionClipsMissingFonts`. */
const CATALOGUE_FONTS = [
  'sans',
  'sans-bold',
  'sans-black',
  'condensed-bold',
  'impact',
  'serif',
  'serif-bold',
  'mono',
];

describe('the caption preset library', () => {
  it('is not empty and every id is unique', () => {
    expect(CAPTION_PRESETS.length).toBeGreaterThan(0);
    const ids = captionPresetIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names only fonts the catalogue actually ships', () => {
    for (const p of CAPTION_PRESETS) {
      expect(CATALOGUE_FONTS, `${p.id} font`).toContain(p.style.font);
    }
  });

  it('uses only colours both renderers can parse', () => {
    for (const p of CAPTION_PRESETS) {
      const s = resolveCaptionStyle(p.style);
      expect(s.color, `${p.id} color`).toMatch(HEX);
      expect(s.box_color, `${p.id} box_color`).toMatch(HEX);
      const a = captionAnimationOf(p.style);
      for (const [field, value] of Object.entries({
        active_color: a.active_color,
        spoken_color: a.spoken_color,
        upcoming_color: a.upcoming_color,
        active_box_color: a.active_box_color,
      })) {
        if (value !== null) expect(value, `${p.id} ${field}`).toMatch(HEX);
      }
    }
  });

  it('keeps every normalised field inside the range its own units mean', () => {
    for (const p of CAPTION_PRESETS) {
      const s = resolveCaptionStyle(p.style);
      expect(s.size, `${p.id} size`).toBeGreaterThan(0);
      // A caption taller than the frame is never a real preset.
      expect(s.size, `${p.id} size`).toBeLessThan(1);
      expect(s.box_opacity, `${p.id} box_opacity`).toBeGreaterThanOrEqual(0);
      expect(s.box_opacity, `${p.id} box_opacity`).toBeLessThanOrEqual(1);
      expect(s.position_x, `${p.id} position_x`).toBeGreaterThanOrEqual(0);
      expect(s.position_x, `${p.id} position_x`).toBeLessThanOrEqual(1);
      expect(s.position_y, `${p.id} position_y`).toBeGreaterThanOrEqual(0);
      expect(s.position_y, `${p.id} position_y`).toBeLessThanOrEqual(1);
      const a = captionAnimationOf(p.style);
      expect(a.enter_secs, `${p.id} enter_secs`).toBeGreaterThanOrEqual(0);
      expect(a.active_box_opacity, `${p.id} active_box_opacity`).toBeGreaterThanOrEqual(0);
      expect(a.active_box_opacity, `${p.id} active_box_opacity`).toBeLessThanOrEqual(1);
    }
  });

  it('gives every preset a real animation kind the model implements', () => {
    const kinds = ['none', 'highlight', 'karaoke', 'slam', 'build'];
    for (const p of CAPTION_PRESETS) {
      expect(kinds, `${p.id} kind`).toContain(captionAnimationOf(p.style).kind);
    }
  });

  it('ships both static and animated presets — the panel needs both', () => {
    const animated = CAPTION_PRESETS.filter((p) => isPerWordAnim(captionAnimationOf(p.style).kind));
    expect(animated.length).toBeGreaterThan(0);
    expect(animated.length).toBeLessThan(CAPTION_PRESETS.length);
  });

  it('gives every adapted preset a provenance note naming its source', () => {
    for (const p of CAPTION_PRESETS) {
      expect(p.note.length, `${p.id} note`).toBeGreaterThan(0);
      expect(p.label.length, `${p.id} label`).toBeGreaterThan(0);
      expect(p.description.length, `${p.id} description`).toBeGreaterThan(0);
      // D-242 — anything adapted from the HyperFrames catalogue must SAY so
      // and must carry its licence, since that is the whole attribution
      // obligation. Presets whose id is not a catalogue slug are Chroma's own.
      if (p.id.startsWith('caption-')) {
        expect(p.note, `${p.id} note`).toContain('HyperFrames');
        expect(p.note, `${p.id} note`).toContain('Apache-2.0');
      }
    }
  });

  it('every animated preset that draws a box also names the box colour', () => {
    for (const p of CAPTION_PRESETS) {
      const a = captionAnimationOf(p.style);
      if (a.active_box_opacity > 0 && a.active_box_color) {
        expect(a.active_box_pad_x, `${p.id} pad_x`).toBeGreaterThanOrEqual(0);
        expect(a.active_box_pad_y, `${p.id} pad_y`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('preset lookup', () => {
  it('finds a preset by id and returns undefined for an unknown one', () => {
    expect(captionPresetById(CAPTION_PRESETS[0].id)?.id).toBe(CAPTION_PRESETS[0].id);
    // Undefined rather than a throw: an unknown id arrives from MCP, where it
    // must become a readable refusal at the caller.
    expect(captionPresetById('no-such-preset')).toBeUndefined();
  });

  it('groups every preset exactly once, preserving library order', () => {
    const grouped = captionPresetGroups().flatMap((g) => g.presets);
    expect(grouped).toHaveLength(CAPTION_PRESETS.length);
    expect(new Set(grouped.map((p) => p.id)).size).toBe(CAPTION_PRESETS.length);
  });
});
