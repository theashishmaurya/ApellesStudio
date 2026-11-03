// @apelles/editor — the text/title clip primitive's pure logic (D-211/D-213,
// `docs/notes/text-title-clips.md`): the `TextLayer` validator, the
// `set_text_clip` reducer, and the `drawtext` compilation in
// `timelineExport.ts`.
//
// The REAL ffmpeg execution / pixel-level half is
// `timelineExportText.ffmpeg.test.ts` — kept separate for the reason that
// file's own header gives: string-matching an argv proves the compiler's
// logic, not that ffmpeg accepts the graph or that the text lands where it
// should. Both exist because B-075/B-076/B-090 each shipped past a green
// argv-only test.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT,
  DEFAULT_TEXT_SIZE,
  applyOp,
  isTextClip,
  labelForOp,
  newTextClipFields,
  newTextLayer,
  type Clip,
  type TextLayer,
  type Timeline,
  type Track,
} from './timeline';
import { textClipsMissingFonts } from './exportTimeline';

const FONT_FILE = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONTS = { [DEFAULT_TEXT_FONT]: FONT_FILE };

function layer(overrides: Partial<TextLayer> = {}): TextLayer {
  const made = newTextLayer({ content: 'AFTER', ...overrides });
  if ('error' in made) throw new Error(made.error);
  return made;
}

function mediaClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 48,
    source_len: 48,
    start_frame: 0,
    ...overrides,
  };
}

function textClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return { ...newTextClipFields(layer(), 48), id, start_frame: 0, ...overrides };
}

function timeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'tl', tracks };
}

function track(kind: Track['kind'], clips: Clip[], overrides: Partial<Track> = {}): Track {
  return { kind, clips, ...overrides };
}

const OPTS = { fps: 24, width: 640, height: 360, fontFiles: FONTS };

/** The single `drawtext=` node in a compiled argv, or `null`. */
function drawtextNode(args: string[]): string | null {
  const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
  return graph.split(';').find((s) => s.includes('drawtext=')) ?? null;
}

// --------------------------------------------------------------------------- //
// newTextLayer — the ONE validator both the GUI and the MCP op run
// --------------------------------------------------------------------------- //

describe('newTextLayer', () => {
  it('fills every unmentioned field from the shared defaults', () => {
    const l = newTextLayer({ content: 'AFTER' });
    expect(l).toEqual({
      content: 'AFTER',
      font: DEFAULT_TEXT_FONT,
      size: DEFAULT_TEXT_SIZE,
      color: DEFAULT_TEXT_COLOR,
    });
  });

  it('merges a patch against an existing layer rather than resetting it', () => {
    // The `set_text_clip` contract: changing the colour must never silently
    // clear the text (the exact hazard `set_clip_transform`'s all-required
    // fields exist to avoid, solved the other way round here).
    const base = layer({ content: 'BEFORE', size: 0.2, color: '#123456' });
    expect(newTextLayer({ color: '#FF0000' }, base)).toEqual({ ...base, color: '#FF0000' });
    expect(newTextLayer({ content: 'AFTER' }, base)).toEqual({ ...base, content: 'AFTER' });
  });

  it('rejects multi-line content — Phase 1 is single-line, provably (D-213)', () => {
    for (const bad of ['one\ntwo', 'one\r\ntwo', 'trailing\n']) {
      expect(newTextLayer({ content: bad })).toEqual({
        error: expect.stringContaining('single line'),
      });
    }
  });

  it('rejects a size outside 0.5%–100% of the frame height, or non-finite (B-383)', () => {
    // 96 is the B-383 case: a pixel size passed where a fraction is expected.
    for (const bad of [0, -0.1, 0.004, 1.01, 96, NaN, Infinity]) {
      expect(newTextLayer({ content: 'A', size: bad })).toEqual({
        error: expect.stringContaining('fraction of the composition height between'),
      });
    }
    for (const ok of [0.005, 0.12, 1]) {
      expect(newTextLayer({ content: 'A', size: ok })).toMatchObject({ size: ok });
    }
  });

  it('accepts #RGB and #RRGGBB (with or without the #) and rejects anything else', () => {
    expect(newTextLayer({ content: 'A', color: '#f80' })).toMatchObject({ color: '#f80' });
    expect(newTextLayer({ content: 'A', color: 'FF8800' })).toMatchObject({ color: '#FF8800' });
    for (const bad of ['red', '#12345', 'rgb(1,2,3)', '']) {
      expect(newTextLayer({ content: 'A', color: bad })).toEqual({
        error: expect.stringContaining('#RGB or #RRGGBB'),
      });
    }
  });
});

// --------------------------------------------------------------------------- //
// newTextClipFields — a title is a Clip, placed by the ordinary add_clip op
// --------------------------------------------------------------------------- //

describe('newTextClipFields', () => {
  it('builds a real Clip with no source and a 1:1 timeline footprint', () => {
    const fields = newTextClipFields(layer(), 72);
    expect(fields.source_path).toBe('');
    expect(fields.duration).toBe(72);
    // `source_len === duration` so a trim can still extend it back out, and
    // `source_fps` unset so `sourceFramesToTimeline`'s 1:1 fallback applies.
    expect(fields.source_len).toBe(72);
    expect(fields.source_fps).toBeUndefined();
    expect(fields.media_id).toBeNull();
    expect(isTextClip(fields)).toBe(true);
  });

  it('names the clip after its own text unless told otherwise', () => {
    expect(newTextClipFields(layer({ content: 'AFTER' }), 24).name).toBe('AFTER');
    expect(newTextClipFields(layer({ content: 'AFTER' }), 24, 'Card 1').name).toBe('Card 1');
  });

  it('is placed by the ORDINARY add_clip op, with ripple and explicit positions', () => {
    // The whole payoff of the Clip-variant shape (D-211): no new placement
    // path, so ripple/startFrame/track-creation all come for free.
    const tl = timeline([track('video', [mediaClip('a', { duration: 48, start_frame: 0 })])]);
    const after = applyOp(tl, {
      kind: 'add_clip',
      track: 0,
      clip: newTextClipFields(layer(), 24),
      startFrame: 0,
      ripple: true,
    });
    expect(after.tracks[0].clips).toHaveLength(2);
    const title = after.tracks[0].clips.find((c) => isTextClip(c));
    expect(title?.start_frame).toBe(0);
    // The media clip rippled out of the way by the title's own duration.
    expect(after.tracks[0].clips.find((c) => c.id === 'a')?.start_frame).toBe(24);
  });
});

// --------------------------------------------------------------------------- //
// the set_text_clip op
// --------------------------------------------------------------------------- //

describe('applyOp — set_text_clip', () => {
  const base = () => timeline([track('video', [textClip('t'), mediaClip('m', { start_frame: 100 })])]);

  it('patches only the fields named', () => {
    const after = applyOp(base(), { kind: 'set_text_clip', track: 0, clip: 0, patch: { color: '#FF0000' } });
    expect(after.tracks[0].clips[0].text).toEqual({
      content: 'AFTER',
      font: DEFAULT_TEXT_FONT,
      size: DEFAULT_TEXT_SIZE,
      color: '#FF0000',
    });
  });

  it('keeps the clip name in step with its text — but not once renamed', () => {
    const withText = applyOp(base(), { kind: 'set_text_clip', track: 0, clip: 0, patch: { content: 'BEFORE' } });
    expect(withText.tracks[0].clips[0].name).toBe('BEFORE');

    const renamed = base();
    renamed.tracks[0].clips[0].name = 'Card 1';
    const after = applyOp(renamed, { kind: 'set_text_clip', track: 0, clip: 0, patch: { content: 'BEFORE' } });
    expect(after.tracks[0].clips[0].name).toBe('Card 1');
  });

  it('refuses a MEDIA clip — patching one would turn a video into a title', () => {
    const tl = base();
    expect(applyOp(tl, { kind: 'set_text_clip', track: 0, clip: 1, patch: { content: 'X' } })).toBe(tl);
  });

  it('refuses a locked track, like every other per-clip op', () => {
    const tl = timeline([track('video', [textClip('t')], { locked: true })]);
    expect(applyOp(tl, { kind: 'set_text_clip', track: 0, clip: 0, patch: { content: 'X' } })).toBe(tl);
  });

  it('is a no-op for an invalid patch rather than storing junk', () => {
    const tl = base();
    expect(applyOp(tl, { kind: 'set_text_clip', track: 0, clip: 0, patch: { content: 'a\nb' } })).toBe(tl);
    expect(applyOp(tl, { kind: 'set_text_clip', track: 0, clip: 0, patch: { color: 'puce' } })).toBe(tl);
    expect(applyOp(tl, { kind: 'set_text_clip', track: 0, clip: 0, patch: { size: 0 } })).toBe(tl);
  });

  it('gets a real undo label', () => {
    expect(labelForOp({ kind: 'set_text_clip', track: 0, clip: 0, patch: { content: 'AFTER' } }, base())).toBe(
      'Set title text to "AFTER"',
    );
    expect(labelForOp({ kind: 'set_text_clip', track: 0, clip: 0, patch: { size: 0.2 } }, base())).toContain('title');
  });
});

// --------------------------------------------------------------------------- //
// escaping / colour literals
// --------------------------------------------------------------------------- //

describe('the export refuses a title whose font this machine lacks', () => {
  it('reports — rather than guesses at — a font this machine has no file for', () => {
    const tl = timeline([track('video', [textClip('t', { text: layer({ font: 'no-such-font' }) })])]);
    expect(textClipsMissingFonts(tl, FONTS)).toEqual([{ clipId: 't', font: 'no-such-font' }]);
    expect(textClipsMissingFonts(tl, { 'no-such-font': FONT_FILE })).toEqual([]);
  });
});
