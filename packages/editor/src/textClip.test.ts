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
import {
  buildExportFfmpegArgs,
  ffmpegColorLiteral,
  quoteFiltergraphValue,
  textClipsMissingFonts,
} from './timelineExport';

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

  it('rejects a non-positive or non-finite size', () => {
    for (const bad of [0, -0.1, NaN, Infinity]) {
      expect(newTextLayer({ content: 'A', size: bad })).toEqual({
        error: expect.stringContaining('positive fraction'),
      });
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

describe('drawtext escaping', () => {
  it('wraps the value in filtergraph quotes', () => {
    expect(quoteFiltergraphValue('PLAIN')).toBe("'PLAIN'");
  });

  it("escapes an apostrophe for BOTH parsers, not just the filtergraph one", () => {
    // The shell-style `'\''` is the version that silently fails: it delivers
    // a bare `'` to `av_opt_set_from_string`, which opens a quote there and
    // swallows every option after it. See `quoteFiltergraphValue`'s own doc.
    expect(quoteFiltergraphValue("it's")).toBe("'it'\\\\\\''s'");
    expect(quoteFiltergraphValue("it's")).not.toContain("'\\''s");
  });

  it('escapes `:` and `\\` for the option-level parser that runs after the quotes are stripped', () => {
    expect(quoteFiltergraphValue('12:30')).toBe("'12\\:30'");
    expect(quoteFiltergraphValue('a\\b')).toBe("'a\\\\b'");
  });

  it('leaves alone what the outer quotes and `expansion=none` already handle', () => {
    for (const s of ['a, b', 'a; b', '[bracket]', '100% sure', '{OK}', 'a=b']) {
      expect(quoteFiltergraphValue(s)).toBe(`'${s}'`);
    }
  });

  it('converts a hex colour to ffmpeg\'s own 0xRRGGBB literal', () => {
    expect(ffmpegColorLiteral('#FF8800')).toBe('0xFF8800');
    expect(ffmpegColorLiteral('ff8800')).toBe('0xFF8800');
    expect(ffmpegColorLiteral('#f80')).toBe('0xFF8800');
    // Degrades to white exactly as `TextLayer::rgb` does on the Rust side,
    // so a malformed colour renders the SAME in both engines.
    expect(ffmpegColorLiteral('puce')).toBe('0xFFFFFF');
  });
});

// --------------------------------------------------------------------------- //
// the compiler
// --------------------------------------------------------------------------- //

describe('buildExportFfmpegArgs — text clips', () => {
  it('opens no ffmpeg input for a text clip', () => {
    const args = buildExportFfmpegArgs(timeline([track('video', [textClip('t')])]), '/out.mp4', OPTS);
    expect(args.filter((a) => a === '-i')).toHaveLength(0);
    expect(drawtextNode(args)).toContain('text=');
  });

  it('sizes the text from the OUTPUT height, so `size` is a real fraction', () => {
    const tl = timeline([track('video', [textClip('t', { text: layer({ size: 0.25 }) })])]);
    expect(drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', OPTS))).toContain('fontsize=90'); // 360 * 0.25
    expect(
      drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', { ...OPTS, height: 1080 })),
    ).toContain('fontsize=270'); // 1080 * 0.25
  });

  it('centres on the ink box and offsets by position_*, mirroring the Rust compositor', () => {
    const tl = timeline([track('video', [textClip('t', { position_x: 0.25, position_y: -0.1 })])]);
    const node = drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', OPTS)) ?? '';
    expect(node).toContain("x='(w-text_w)/2+w*(0.25)'");
    expect(node).toContain("y='(h-text_h)/2+h*(-0.1)'");
  });

  it('gates the title to its own timeline window', () => {
    const tl = timeline([track('video', [textClip('t', { start_frame: 24, duration: 48 })])]);
    // 24/24 = 1s in, 48 frames = 2s long.
    expect(drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', OPTS))).toContain("enable='between(t,1,3)'");
  });

  it('turns text expansion off, so % and {} are literal text', () => {
    const tl = timeline([track('video', [textClip('t', { text: layer({ content: '100% {done}' }) })])]);
    const node = drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', OPTS)) ?? '';
    expect(node).toContain('expansion=none');
    expect(node).toContain("text='100% {done}'");
  });

  it('re-bases keyframe and fade expressions to TIMELINE time, not clip-input time', () => {
    // A media clip's chain has its own t==0 (its `-ss`); a text clip's
    // `drawtext` runs on the composited base stream where `t` is timeline
    // time — so everything authored clip-relative needs `(t-startSec)`.
    const tl = timeline([
      track('video', [
        textClip('t', {
          start_frame: 48, // 2s in at 24fps
          duration: 48,
          chroma_keyframes: [
            { frame: 0, params: { position_x: 0 } },
            { frame: 24, params: { position_x: 0.5 } },
          ],
          fade_in_frames: 12,
        }),
      ]),
    ]);
    const node = drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', OPTS)) ?? '';
    expect(node).toContain('(t-2)');
    expect(node).not.toMatch(/x='\(w-text_w\)\/2\+w\*\(if\([^)]*\bt\b[,)]/); // never bare `t` in the keyframe expr
    expect(node).toContain("alpha='");
  });

  it('composes opacity and fade multiplicatively, as the preview does', () => {
    const tl = timeline([track('video', [textClip('t', { opacity: 0.5 })])]);
    expect(drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', OPTS))).toContain("alpha='0.5'");

    const faded = timeline([track('video', [textClip('t', { opacity: 0.5, fade_in_frames: 12 })])]);
    expect(drawtextNode(buildExportFfmpegArgs(faded, '/out.mp4', OPTS))).toContain("alpha='(0.5)*(");
  });

  it('paints the title at its own place in the z-order — a track-0 title over track-1 video', () => {
    const tl = timeline([
      track('video', [textClip('title')]),
      track('video', [mediaClip('under')]),
    ]);
    const graph = buildExportFfmpegArgs(tl, '/out.mp4', OPTS)[
      buildExportFfmpegArgs(tl, '/out.mp4', OPTS).indexOf('-filter_complex') + 1
    ];
    const steps = graph.split(';');
    const overlayIdx = steps.findIndex((s) => s.includes('overlay='));
    const drawIdx = steps.findIndex((s) => s.includes('drawtext='));
    // Track 0 paints LAST (on top) — so the title's drawtext must come after
    // the video's overlay, and must read that overlay's own output label.
    expect(drawIdx).toBeGreaterThan(overlayIdx);
    expect(steps[drawIdx]).toContain('[ov0]');
    expect(steps[drawIdx]).toContain('[outv]');
  });

  it('counts a title toward the export duration even with no video clip at all', () => {
    // B-076's own failure mode, in the one shape that could reintroduce it:
    // an all-titles timeline with no `-i` inputs whatsoever.
    const tl = timeline([track('video', [textClip('t', { start_frame: 24, duration: 48 })])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', OPTS);
    expect(args[args.indexOf('-t') + 1]).toBe('3'); // 1s offset + 2s long
  });

  it('never references a text clip as an audio source', () => {
    // A text clip has no input stream, so `[N:a]` would be a filtergraph
    // reference to nothing — a hard ffmpeg failure, not silence.
    const tl = timeline([track('video', [textClip('t'), mediaClip('m', { start_frame: 100 })])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', {
      ...OPTS,
      // Deliberately lying about the title having audio, to prove the guard.
      hasAudioOverrides: { t: true, m: true },
    });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).not.toContain('[1:a]');
    expect(graph).toContain('[0:a]'); // the real media clip's own audio still mixes
  });

  it('reports — rather than guesses at — a font this machine has no file for', () => {
    const tl = timeline([track('video', [textClip('t', { text: layer({ font: 'no-such-font' }) })])]);
    expect(textClipsMissingFonts(tl, FONTS)).toEqual([{ clipId: 't', font: 'no-such-font' }]);
    expect(textClipsMissingFonts(tl, { 'no-such-font': FONT_FILE })).toEqual([]);
    // …and the compiler skips it rather than emitting an unrunnable node.
    expect(drawtextNode(buildExportFfmpegArgs(tl, '/out.mp4', OPTS))).toBeNull();
  });

  it('leaves a timeline with no text clips byte-identical to before D-211', () => {
    const tl = timeline([track('video', [mediaClip('a'), mediaClip('b', { start_frame: 48 })])]);
    const withFonts = buildExportFfmpegArgs(tl, '/out.mp4', OPTS);
    const withoutFonts = buildExportFfmpegArgs(tl, '/out.mp4', { fps: 24, width: 640, height: 360 });
    expect(withFonts).toEqual(withoutFonts);
    expect(withFonts.join(' ')).not.toContain('drawtext');
  });
});
