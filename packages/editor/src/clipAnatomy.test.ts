import { describe, expect, it } from 'vitest';
import { clipAnatomy, clipChrome, clipKindOf, cutStyleAt } from './clipAnatomy';

describe('clipAnatomy — the FCP split by track height (ui-redesign §4.3)', () => {
  it.each([
    // track height, strip, film, band (video)
    [32, 14, 16, 0],
    [52, 14, 25, 11],
    [76, 16, 41, 17],
    [108, 16, 63, 27],
  ])('a video clip on a %i px track: strip %i, filmstrip %i, waveform band %i', (h, strip, film, band) => {
    const a = clipAnatomy(h, 'video');
    expect(a).toMatchObject({ height: h - 2, strip, film, band, wave: 0, labelsOnly: false });
    expect(a.strip + a.film + a.band).toBe(a.height);
  });

  it('gives an audio clip the whole area under its strip as waveform', () => {
    expect(clipAnatomy(32, 'audio')).toMatchObject({ strip: 14, wave: 16, film: 0, band: 0 });
    expect(clipAnatomy(52, 'audio')).toMatchObject({ strip: 14, wave: 36 });
    expect(clipAnatomy(108, 'audio')).toMatchObject({ strip: 16, wave: 90 });
  });

  it('uses the 11 px label on a 16 px strip and the 10 px one below', () => {
    expect(clipAnatomy(52, 'video').labelSize).toBe('2xs');
    expect(clipAnatomy(76, 'video').labelSize).toBe('xs');
  });

  it('collapses to labels only below 26 px', () => {
    expect(clipAnatomy(24, 'video')).toMatchObject({ labelsOnly: true, strip: 22, film: 0, band: 0 });
  });

  it('draws titles, captions and adjustment clips as strip + flat body', () => {
    for (const kind of ['text', 'caption', 'adjustment'] as const) {
      expect(clipAnatomy(52, kind)).toMatchObject({ strip: 14, film: 0, band: 0, wave: 0 });
    }
  });

  it('honours the band ratio (0 = filmstrip only, 1 = waveform only)', () => {
    expect(clipAnatomy(52, 'video', 0)).toMatchObject({ film: 36, band: 0 });
    expect(clipAnatomy(52, 'video', 1)).toMatchObject({ film: 0, band: 36 });
  });
});

describe('clipChrome — width thresholds', () => {
  it('drops the hairline below 8 px, the label below 28 px and badges below 120 px', () => {
    expect(clipChrome(6)).toEqual({ label: false, badges: false, hairline: false });
    expect(clipChrome(20)).toEqual({ label: false, badges: false, hairline: true });
    expect(clipChrome(60)).toEqual({ label: true, badges: false, hairline: true });
    expect(clipChrome(120)).toEqual({ label: true, badges: true, hairline: true });
  });
});

describe('clipKindOf / cutStyleAt', () => {
  it('names the colour family', () => {
    expect(clipKindOf({}, 'video')).toBe('video');
    expect(clipKindOf({}, 'audio')).toBe('audio');
    expect(clipKindOf({ adjustment: {} as never }, 'video')).toBe('adjustment');
  });

  it('dashes a through edit and draws a plain hairline at any other cut', () => {
    const a = { source_path: '/a.mp4', source_start: 0, duration: 30, source_fps: 30 };
    expect(cutStyleAt({ source_path: '/a.mp4', source_start: 30, source_fps: 30 }, a)).toBe('through');
    expect(cutStyleAt({ source_path: '/a.mp4', source_start: 40, source_fps: 30 }, a)).toBe('cut');
    expect(cutStyleAt({ source_path: '/b.mp4', source_start: 30, source_fps: 30 }, a)).toBe('cut');
    expect(cutStyleAt({ source_path: '/a.mp4', source_start: 30, source_fps: 30 }, null)).toBe('none');
  });
});
