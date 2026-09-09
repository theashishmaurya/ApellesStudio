/**
 * @apelles/editor — unit tests for the D-240 Bold/Italic style-axis helpers
 * (`baseFontFamilies`, `fontStyleOf`, `composeFontStyleKey`).
 *
 * Pure, no Tauri, no DOM — these three functions are plain lookups over a
 * `TextFont[]` the caller supplies, so they are tested against a small fixed
 * fixture rather than the real `chroma_text_fonts` catalogue.
 * `TextClipInspectorPanel.dom.test.tsx`/`CaptionInspectorPanel.dom.test.tsx`
 * cover the same rule wired into the real Inspector components.
 */
import { describe, expect, it } from 'vitest';

import { baseFontFamilies, composeFontStyleKey, fontStyleOf, type TextFont } from './textFonts';

const FONTS: TextFont[] = [
  { key: 'sans', label: 'Sans', path: '/f/Arial.ttf', group: 'sans', bold: false, italic: false },
  { key: 'sans-bold', label: 'Sans Bold', path: '/f/Arial Bold.ttf', group: 'sans', bold: true, italic: false },
  { key: 'sans-italic', label: 'Sans Italic', path: '/f/Arial Italic.ttf', group: 'sans', bold: false, italic: true },
  {
    key: 'sans-bold-italic',
    label: 'Sans Bold Italic',
    path: '/f/Arial Bold Italic.ttf',
    group: 'sans',
    bold: true,
    italic: true,
  },
  // A group with a HOLE — no bold-italic file on this machine — to exercise
  // the degrade-not-fail path.
  { key: 'mono', label: 'Mono', path: '/f/Courier.ttf', group: 'mono', bold: false, italic: false },
  { key: 'mono-bold', label: 'Mono Bold', path: '/f/Courier Bold.ttf', group: 'mono', bold: true, italic: false },
  { key: 'mono-italic', label: 'Mono Italic', path: '/f/Courier Italic.ttf', group: 'mono', bold: false, italic: true },
  { key: 'mono-bold-italic', label: 'Mono Bold Italic', path: null, group: 'mono', bold: true, italic: true },
  { key: 'impact', label: 'Impact', path: '/f/Impact.ttf', group: null, bold: false, italic: false },
];

describe('baseFontFamilies (D-240)', () => {
  it('lists exactly one row per group (its regular member) plus every standalone entry', () => {
    const bases = baseFontFamilies(FONTS).map((f) => f.key);
    expect(bases).toEqual(['sans', 'mono', 'impact']);
  });
});

describe('fontStyleOf (D-240)', () => {
  it('reads group/bold/italic straight off the matching catalogue entry', () => {
    expect(fontStyleOf(FONTS, 'sans-bold-italic')).toEqual({ group: 'sans', bold: true, italic: true });
    expect(fontStyleOf(FONTS, 'impact')).toEqual({ group: null, bold: false, italic: false });
  });

  it('degrades an unrecognised key to "no group, not bold, not italic" rather than throwing', () => {
    expect(fontStyleOf(FONTS, 'a-font-this-build-no-longer-ships')).toEqual({
      group: null,
      bold: false,
      italic: false,
    });
  });
});

describe('composeFontStyleKey (D-240)', () => {
  it('composes the exact sibling for every (bold, italic) pair in a complete group', () => {
    expect(composeFontStyleKey(FONTS, 'sans', false, false)).toBe('sans');
    expect(composeFontStyleKey(FONTS, 'sans', true, false)).toBe('sans-bold');
    expect(composeFontStyleKey(FONTS, 'sans', false, true)).toBe('sans-italic');
    expect(composeFontStyleKey(FONTS, 'sans', true, true)).toBe('sans-bold-italic');
  });

  it('composes from ANY starting member of the group, not just the base', () => {
    // Starting from sans-bold-italic and asking for "not bold, not italic"
    // must land on plain "sans" — the composition depends on the GROUP, not
    // on the starting key being the base.
    expect(composeFontStyleKey(FONTS, 'sans-bold-italic', false, false)).toBe('sans');
  });

  it('is a true no-op for a key with no group at all', () => {
    expect(composeFontStyleKey(FONTS, 'impact', true, true)).toBe('impact');
  });

  it('degrades bold-italic to bold-only when the machine has no file for the combo', () => {
    // `mono-bold-italic` exists in the catalogue but its `path` is null
    // (unavailable on this machine) — composing to it must fall back to the
    // BOLD face rather than hand back an unusable key or drop all the way to
    // plain regular.
    expect(composeFontStyleKey(FONTS, 'mono', true, true)).toBe('mono-bold');
  });

  it('falls back to the unchanged key if the group itself somehow has nothing usable', () => {
    const brokenGroup: TextFont[] = [
      { key: 'x', label: 'X', path: null, group: 'x', bold: false, italic: false },
    ];
    expect(composeFontStyleKey(brokenGroup, 'x', true, true)).toBe('x');
  });
});
