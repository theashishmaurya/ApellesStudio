// @chroma/editor — the caption model and the shared layout arithmetic (D-229).
//
// **The point of this file is the mirror.** `captionLayout` here and
// `CaptionLayout::resolve` in `crates/chroma-timeline/src/caption.rs` are two
// hand-written implementations of one specification, in two languages that
// share no code — the live preview resolves one, the ffmpeg export compiler
// resolves the other, and a caption renders in the wrong place the moment they
// disagree by a pixel. The fixture in
// `captionLayout matches the Rust fixture exactly` below is the SAME fixture
// `layout_numbers_are_the_documented_arithmetic` asserts on the Rust side; if
// either side's rounding ever drifts, exactly one of those two tests goes red.
import { describe, expect, it } from 'vitest';

import {
  captionCharCount,
  captionCps,
  captionLayout,
  captionLines,
  resolveCaptionStyle,
  DEFAULT_CAPTION_FONT,
  DEFAULT_CAPTION_SIZE,
} from './caption';

describe('captionLines', () => {
  it('drops surrounding blanks but keeps an interior one', () => {
    // Mirrors `lines_drops_surrounding_blanks_but_keeps_an_interior_one`.
    expect(captionLines('\nfirst\n\nthird\n\n')).toEqual(['first', '', 'third']);
  });

  it('tolerates CRLF, which real .srt files are full of', () => {
    expect(captionLines('first\r\nsecond\r\n')).toEqual(['first', 'second']);
  });

  it('is empty — not one blank line — for an empty cue', () => {
    // A blank line would still reserve vertical space and draw an empty
    // background box, which is why this distinction matters.
    expect(captionLines('')).toEqual([]);
    expect(captionLines('\n \n')).toEqual([]);
  });
});

describe('character counts', () => {
  it('excludes line breaks, like the reference Inspector does', () => {
    expect(captionCharCount('ab\ncd')).toBe(4);
    expect(captionCharCount('ab\r\ncd')).toBe(4);
  });

  it('reports CPS, and null rather than Infinity for a zero-length cue', () => {
    expect(captionCps('hello', 2)).toBe(2.5);
    expect(captionCps('hello', 0)).toBeNull();
    expect(captionCps('hello', Number.NaN)).toBeNull();
  });
});

describe('resolveCaptionStyle', () => {
  it('fills in every default when nothing is set anywhere', () => {
    const s = resolveCaptionStyle(null, null);
    expect(s.font).toBe(DEFAULT_CAPTION_FONT);
    expect(s.size).toBe(DEFAULT_CAPTION_SIZE);
    expect(s.align).toBe('center');
    expect(s.box_enabled).toBe(true);
  });

  it('prefers the cue override over the track style, whole-record', () => {
    // The cue's style REPLACES the track's rather than merging with it —
    // "Use Track Style" is a checkbox, not a per-field cascade, so a cue with
    // an override must not silently inherit half its values from the track
    // and drift when the track changes.
    const track = { color: '#FF0000', size: 0.09, font: 'impact' };
    const cue = { color: '#00FF00' };
    const s = resolveCaptionStyle(cue, track);
    expect(s.color).toBe('#00FF00');
    expect(s.size).toBe(DEFAULT_CAPTION_SIZE);
    expect(s.font).toBe(DEFAULT_CAPTION_FONT);
  });

  it('falls back to the track style when the cue has none', () => {
    const s = resolveCaptionStyle(null, { color: '#FF0000', align: 'left' });
    expect(s.color).toBe('#FF0000');
    expect(s.align).toBe('left');
  });

  it('degrades a non-finite number to its default rather than propagating it', () => {
    const s = resolveCaptionStyle({ size: Number.NaN, position_y: Number.POSITIVE_INFINITY }, null);
    expect(s.size).toBe(DEFAULT_CAPTION_SIZE);
    expect(s.position_y).toBe(0.82);
  });
});

describe('captionLayout', () => {
  it('matches the Rust fixture exactly', () => {
    // THE mirror assertion. Same numbers as
    // `caption.rs::layout_numbers_are_the_documented_arithmetic`.
    const l = captionLayout(resolveCaptionStyle(null, null), 1920, 1080, 2);
    expect(l.font_px).toBe(59); // round(0.055 * 1080)
    expect(l.line_step).toBe(74); // round(0.055 * 1.25 * 1080) = round(74.25)
    expect(l.box_padding).toBe(13); // round(0.22 * 59) = round(12.98)
    expect(l.lines[0].x_anchor).toBe(960); // round(0.5 * 1920)
    expect(l.lines[1].line_top).toBe(886); // round(0.82 * 1080) = round(885.6)
    expect(l.lines[0].line_top).toBe(886 - 74);
  });

  it('anchors the LAST line, so lines stack upward', () => {
    // Mirrors `layout_anchors_the_last_line_so_lines_stack_upward`. A cue
    // gaining a second line must keep its bottom line where it was — the
    // subtitle convention, and the reason `position_y` means what it means.
    const style = resolveCaptionStyle(null, null);
    const one = captionLayout(style, 1920, 1080, 1);
    const two = captionLayout(style, 1920, 1080, 2);
    expect(two.lines[1].line_top).toBe(one.lines[0].line_top);
    expect(two.lines[1].line_top - two.lines[0].line_top).toBe(two.line_step);
  });

  it('never produces a zero font size or step', () => {
    // A `fontsize=0` is a hard ffmpeg failure, not a blank frame.
    const l = captionLayout(resolveCaptionStyle({ size: 0 }, null), 1920, 1080, 3);
    expect(l.font_px).toBeGreaterThanOrEqual(1);
    expect(l.line_step).toBeGreaterThanOrEqual(1);
  });

  it('scales proportionally with the composition, so preview and export agree', () => {
    // The same style at half the size must produce (within rounding) half the
    // numbers — this is what makes the 640-wide preview and the 1920-wide
    // export the same picture at two scales.
    const style = resolveCaptionStyle(null, null);
    const big = captionLayout(style, 1920, 1080, 1);
    const small = captionLayout(style, 960, 540, 1);
    expect(Math.abs(big.font_px / 2 - small.font_px)).toBeLessThanOrEqual(1);
    expect(Math.abs(big.lines[0].line_top / 2 - small.lines[0].line_top)).toBeLessThanOrEqual(1);
    expect(Math.abs(big.lines[0].x_anchor / 2 - small.lines[0].x_anchor)).toBeLessThanOrEqual(1);
  });

  it('resolves zero lines without underflowing', () => {
    const l = captionLayout(resolveCaptionStyle(null, null), 1920, 1080, 0);
    expect(l.lines).toEqual([]);
    expect(l.font_px).toBeGreaterThanOrEqual(1);
  });
});
