// @chroma/editor — the TypeScript half of the caption-animation mirror
// (D-241).
//
// **The point of this file.** `captionAnim.ts` and
// `crates/chroma-timeline/src/caption_anim.rs` are the same model written
// twice, in two runtimes that must resolve identical numbers for an identical
// cue. What keeps that honest is that both sides assert the SAME fixtures —
// the Rust module's `state_numbers_are_the_documented_arithmetic` and this
// file's own fixture test below are deliberately the same numbers. If either
// side's arithmetic drifts, exactly one of the two fails, which is the whole
// early-warning mechanism (the same one `caption.test.ts` provides for the
// static layout, per B-079's lesson).

import { describe, expect, it } from 'vitest';

import {
  captionActiveWord,
  captionWordColor,
  captionWordState,
  captionWords,
  easeOutCubic,
  isPerWordAnim,
  isSingleWordAnim,
  resolveCaptionAnimation,
  type CaptionAnimKind,
} from './captionAnim';

const anim = (kind: CaptionAnimKind, over: Parameters<typeof resolveCaptionAnimation>[0] = {}) =>
  resolveCaptionAnimation({ kind, active_box_color: '#FF1745', ...over });

describe('captionWords — the derived per-word windows', () => {
  it('tiles the cue exactly, in order, proportional to character count', () => {
    const ws = captionWords(['hello big', 'world'], 4);
    expect(ws.map((w) => w.text)).toEqual(['hello', 'big', 'world']);
    expect(ws.map((w) => w.line)).toEqual([0, 0, 1]);
    // per-line word indices restart
    expect(ws.map((w) => w.index)).toEqual([0, 1, 0]);
    // no gap, no overlap, and the last word ends exactly on the duration
    expect(ws[0].start).toBe(0);
    expect(ws[0].end).toBe(ws[1].start);
    expect(ws[1].end).toBe(ws[2].start);
    expect(ws[2].end).toBeCloseTo(4, 12);
    // 5 + 3 + 5 = 13 characters
    expect(ws[0].end).toBeCloseTo((4 * 5) / 13, 12);
  });

  it('degrades to all-zero windows rather than dividing by zero', () => {
    const ws = captionWords(['a b'], 0);
    expect(ws).toHaveLength(2);
    expect(ws.every((w) => w.start === 0 && w.end === 0)).toBe(true);
    // the LAST word is then the active one — the documented degradation
    expect(captionWordState(ws, 1, anim('highlight'), 0).phase).toBe('active');
  });

  it('yields no words for empty or whitespace-only text', () => {
    expect(captionWords([], 3)).toEqual([]);
    expect(captionWords(['   '], 3)).toEqual([]);
  });

  it('collapses runs of whitespace rather than emitting empty words', () => {
    expect(captionWords(['a    b'], 2).map((w) => w.text)).toEqual(['a', 'b']);
  });
});

describe('captionWordState — the per-word contract both renderers implement', () => {
  it('highlight keeps the whole line up and moves only the box', () => {
    const ws = captionWords(['one two three'], 3);
    const a = anim('highlight');
    const t = (ws[1].start + ws[1].end) / 2;
    const states = ws.map((_, i) => captionWordState(ws, i, a, t));
    expect(states.every((s) => s.visible && s.alpha === 1)).toBe(true);
    expect(states.every((s) => s.dx === 0 && s.dy === 0)).toBe(true);
    expect(states.map((s) => s.phase)).toEqual(['spoken', 'active', 'upcoming']);
    // exactly one box, on the active word
    expect(states.map((s) => s.box_alpha > 0)).toEqual([false, true, false]);
  });

  it('draws no box at all when the preset names no box colour', () => {
    const ws = captionWords(['one two'], 2);
    const a = resolveCaptionAnimation({ kind: 'karaoke' });
    const s = captionWordState(ws, 0, a, 0.2);
    expect(s.phase).toBe('active');
    expect(s.box_alpha).toBe(0);
  });

  it("the box is BINARY, not ramped — ffmpeg's drawbox has no alpha expression", () => {
    const ws = captionWords(['one two'], 2);
    const a = anim('highlight', { enter_secs: 0.5 });
    // At the very first instant of the word, mid-entrance, the box is already
    // fully on. A ramp here would be a preview the export cannot reproduce.
    expect(captionWordState(ws, 0, a, 0).box_alpha).toBe(1);
    expect(captionWordState(ws, 0, a, 0.4).box_alpha).toBe(1);
  });

  it('slam shows exactly one word at a time and alternates its entry side', () => {
    const ws = captionWords(['alpha beta gamma'], 3);
    const a = anim('slam');
    for (const t of [0.1, 1.4, 2.6]) {
      expect(ws.filter((_, i) => captionWordState(ws, i, a, t).visible)).toHaveLength(1);
    }
    expect(captionWordState(ws, 0, a, ws[0].start).dx).toBeLessThan(0);
    expect(captionWordState(ws, 1, a, ws[1].start).dx).toBeGreaterThan(0);
  });

  it('build accumulates words and never removes one', () => {
    const ws = captionWords(['a b c'], 3);
    const a = anim('build');
    const countAt = (t: number) => ws.filter((_, i) => captionWordState(ws, i, a, t).visible).length;
    expect(countAt(0)).toBe(1);
    expect(countAt(1.5)).toBe(2);
    expect(countAt(2.5)).toBe(3);
    expect(countAt(2.9)).toBeGreaterThanOrEqual(countAt(1.5));
  });

  it('an entering word rises to exactly its laid-out position', () => {
    const ws = captionWords(['a b'], 2);
    const a = resolveCaptionAnimation({ kind: 'build', enter_secs: 0.2, enter_rise: 0.5 });
    expect(captionWordState(ws, 0, a, 0).dy).toBeCloseTo(0.5, 12);
    expect(captionWordState(ws, 0, a, 0).alpha).toBe(0);
    expect(captionWordState(ws, 0, a, 0.4).dy).toBe(0);
    expect(captionWordState(ws, 0, a, 0.4).alpha).toBe(1);
  });

  it('a zero-length entrance snaps instead of dividing by zero', () => {
    const ws = captionWords(['a b'], 2);
    const a = resolveCaptionAnimation({ kind: 'build', enter_secs: 0 });
    expect(captionWordState(ws, 0, a, 0)).toMatchObject({ alpha: 1, dy: 0 });
  });

  it('keeps the last word active past the end of the cue', () => {
    const ws = captionWords(['a b c'], 3);
    expect(captionWordState(ws, 2, anim('highlight'), 99).phase).toBe('active');
    expect(captionActiveWord(ws, 99)).toBe(2);
  });

  it('an out-of-range index is not drawn rather than throwing', () => {
    const ws = captionWords(['a'], 1);
    expect(captionWordState(ws, 9, anim('build'), 0.5).visible).toBe(false);
  });
});

describe('the shared easing', () => {
  it('is the documented polynomial and is clamped', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-5)).toBe(0);
    expect(easeOutCubic(5)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 12);
  });
});

describe('colour resolution', () => {
  it('falls back to the style colour for any phase the preset leaves alone', () => {
    const a = resolveCaptionAnimation({ kind: 'karaoke', active_color: '#FF0000' });
    expect(captionWordColor('active', a, '#FFFFFF')).toBe('#FF0000');
    expect(captionWordColor('spoken', a, '#FFFFFF')).toBe('#FFFFFF');
    expect(captionWordColor('upcoming', a, '#FFFFFF')).toBe('#FFFFFF');
  });
});

describe('resolveCaptionAnimation', () => {
  it('defaults an absent animation to the static kind', () => {
    expect(resolveCaptionAnimation(undefined).kind).toBe('none');
    expect(resolveCaptionAnimation(null).kind).toBe('none');
    expect(isPerWordAnim('none')).toBe(false);
    expect(isPerWordAnim('highlight')).toBe(true);
    expect(isSingleWordAnim('slam')).toBe(true);
    expect(isSingleWordAnim('highlight')).toBe(false);
  });

  it('degrades a non-finite number to its default rather than propagating NaN', () => {
    const a = resolveCaptionAnimation({
      kind: 'build',
      enter_secs: Number.NaN,
      enter_rise: Number.POSITIVE_INFINITY,
    });
    expect(Number.isFinite(a.enter_secs)).toBe(true);
    expect(Number.isFinite(a.enter_rise)).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// The cross-language fixture
// --------------------------------------------------------------------------- //

describe('captionWordState matches the Rust fixture exactly', () => {
  // The SAME numbers `state_numbers_are_the_documented_arithmetic` asserts in
  // `crates/chroma-timeline/src/caption_anim.rs`. Changing one side without
  // the other must fail here or there.
  it('reproduces the documented arithmetic, number for number', () => {
    const ws = captionWords(['Every great video'], 3);
    // 5 + 5 + 5 = 15 characters, so the windows are exact thirds.
    expect(ws[0].end).toBeCloseTo(1, 12);
    expect(ws[1].start).toBeCloseTo(1, 12);
    expect(ws[2].start).toBeCloseTo(2, 12);

    const a = resolveCaptionAnimation({ kind: 'build', enter_secs: 0.5, enter_rise: 0.4 });
    // 0.25s into word 1's own entrance: ratio 0.5, easeOutCubic(0.5) = 0.875.
    const s = captionWordState(ws, 1, a, 1.25);
    expect(s.alpha).toBeCloseTo(0.875, 12);
    expect(s.dy).toBeCloseTo(0.05, 12);
  });
});
