/**
 * @chroma/editor — pure timeline → ffmpeg export compiler (Phase 2 of the
 * MCP-editor-control effort, `docs/notes/mcp-architecture.md`).
 *
 * No exporter anywhere in the codebase renders a full MULTI-track/MULTI-clip
 * `Timeline`: Colorist's own `chroma_export_video` (`app/src-tauri/src/
 * chroma/export.rs`) is single-clip-only. Rather than write a bespoke
 * frame-accurate compositor in Rust (multi-day, high-risk), this reuses
 * ffmpeg's own `crop`/`setpts`/`scale`/`overlay` filters as a real
 * general-purpose compositor via one `-filter_complex` graph — consistent
 * with the fact that Colorist's own exporter already leans on ffmpeg
 * internally for frame decode.
 *
 * This module is PURE — no Tauri, no React, no store access, no I/O. It
 * takes a `Timeline` (`./timeline.ts`) and explicit output options and
 * returns a single ffmpeg argv array. The caller (`useEditorControl.ts`'s
 * `editor_export` op, wired separately) is responsible for actually
 * spawning ffmpeg (a small generic Rust `chroma_run_ffmpeg` command, built
 * in a parallel effort).
 *
 * **D-197 closed the "v1 scope: video-only" gap this doc used to describe.**
 * Every visible `Track.kind === 'audio'` clip, PLUS a video clip's own
 * embedded audio (when its source is known to have one and it isn't A/V-
 * linked to a separate audio clip, D-129), is now mixed into a real second
 * output stream — gain (D-057), ducking (D-149) and fades (D-147), each
 * replicating the exact semantics `app/src-tauri/src/chroma/audio.rs`'s live
 * playback mixer already implements, not a re-invented interpretation. See
 * `timelineExportAudio.ts` for the actual per-source math (fade-curve
 * sampling, the one-pole duck envelope) and D-197 in `docs/08-decisions.md`
 * for the full design (why sampling, not a closed-form bezier; why `amix`
 * `normalize=0` + `asoftclip=type=tanh` instead of ffmpeg's default
 * per-input attenuation).
 *
 * **D-226 — transitions.** A `Track.transitions` entry compiles to a widened
 * input window (its handle media), a widened `enable` gate, and one
 * `fade=alpha=1` step on the incoming layer — deliberately NOT ffmpeg's own
 * `xfade`, which concatenates two continuous streams and so is a different
 * compiler shape from this one entirely (see `TransitionPlan`'s own doc). A dip
 * to colour compiles to a `color` filter SOURCE with no `-i` at all, the same
 * shape `[base]` already uses. `docs/notes/transitions.md` §6.
 *
 * **D-230 — adjustment clips.** A `Clip.adjustment` compiles to two colour
 * filter nodes (`lutrgb` then `colorchannelmixer`, see `./adjustment.ts`)
 * spliced into the overlay chain at exactly the position that clip's `overlay`
 * would have occupied — so the stream they operate on is, by construction,
 * every layer beneath the clip, and "applies to everything under it" needs no
 * scoping rule of its own. Same trick D-213's `drawtext` already uses. An
 * identity correction emits nothing at all, so an untouched adjustment clip
 * produces a byte-identical argv to having none. `docs/notes/adjustment-clips.md`.
 *
 * **B-103 — every clip is now placed in TIME** (`setpts=PTS+<start>/TB` at the
 * head of its chain). It never was: `overlay` pairs its inputs by timestamp,
 * and nothing shifted a clip's stream to where it sits on the timeline, so a
 * clip at `start_frame > 0` exported its last frame frozen for its whole
 * window. The audio half of this compiler always did place its sources
 * (`adelay`); the video half simply never grew the equivalent. See
 * `buildClipFilterChain`'s own note and `docs/BUGS.md` B-103.
 */

import type { Clip, EaseCurve, Timeline, Track, Transition } from './timeline';
import {
  DEFAULT_EASE_CURVE,
  endFrame,
  timelineFramesToSource,
  transitionHandles,
  transitionWindow,
  transitionsOf,
} from './timeline';
import {
  captionLayout,
  captionLines,
  resolveCaptionStyle,
  type CaptionCue,
  type CaptionStyle,
} from './caption';
import { buildAdjustmentSteps, clipAdjustmentOps } from './adjustment';
import { piecewiseLinearExpr, type ExprPoint } from './ffmpegExpr';
// D-235 — one definition of a clip's time remap, shared with the live
// preview's own `clipSourceFrameAt`/`Clip::source_frame_at`. See `speedRamp.ts`.
import {
  flatSpeedOf,
  hasSpeedRamp,
  outputAtSourceFrame,
  rampOutputSourceFrames,
  rampSetptsSecondsExpr,
  resolveSpeedSegments,
} from './speedRamp';
import { easeCurveEval, isIdentityEase } from './easeCurve';
import {
  audioRefBracket,
  audioRefMapArg,
  buildAudioSourceChain,
  fadeGainExpr,
  resolveDuckForTrack,
  type AudioRef,
} from './timelineExportAudio';

// --------------------------------------------------------------------------- //
// keyframeExprAt — piecewise-linear ffmpeg expression generator
// --------------------------------------------------------------------------- //

/** One clip's raw keyframe array, as stored on `Clip.chroma_keyframes`.
 *
 *  Structurally `ClipKeyframe` (`timeline.ts`), spelled separately because
 *  this compiler deliberately takes the loosest shape it can read rather than
 *  the model type — `rebaseKeyframesToClipInput` hands it re-based entries
 *  that are not a `Clip`'s own any more, and `keyframeExprAt` is called
 *  directly by tests with hand-written fixtures. D-233 added `ease` to both,
 *  identically. */
export interface ExportKeyframe {
  frame: number;
  params: Record<string, unknown>;
  ease?: Record<string, EaseCurve>;
}

/**
 * How many linear segments approximate ONE eased keyframe segment in the
 * generated ffmpeg expression (D-233).
 *
 * ffmpeg's expression language has no bezier-root solver, so an eased segment
 * is SAMPLED and fed through `ffmpegExpr.ts`'s piecewise-linear builder —
 * exactly what `timelineExportAudio.ts`'s `fadeGainExpr` already does to the
 * identical curve type, for the identical reason, and the reason this constant
 * matches `FADE_SAMPLE_STEPS`. Each sampled *value* is exact (the real
 * `easeCurveEval`); the approximation is only of the continuous curve BETWEEN
 * samples, with error bounded by the sample count.
 *
 * 20 is not a guess: for the steepest of the four presets the worst-case
 * chord error against the true curve is well under 0.5% of the segment's own
 * value range — below a frame's worth of movement for any animation a person
 * would author, and far below the 1/255 an 8-bit output can even represent for
 * opacity. `timelineExport.ease.test.ts` measures it rather than asserting it.
 */
const EASE_SAMPLE_STEPS = 20;

/**
 * Build an ffmpeg filter expression (using `t`, ffmpeg's own per-frame time
 * in seconds) that piecewise-linearly interpolates `param` across
 * `keyframes`, exactly mirroring the semantics `chroma_timeline::edit::
 * resolve_clip_transform` (Rust) already applies for live preview —
 * reimplemented here as a static expression string because export happens
 * outside the Rust engine's own per-frame interpolation loop, in ffmpeg
 * itself.
 *
 * `keyframes[].frame` is in the SAME time axis the caller's `t` will be —
 * i.e. already relative to whatever `t == 0` means for the ffmpeg filter
 * chain this expression is spliced into (see `buildExportFfmpegArgs`, which
 * re-bases `Clip.chroma_keyframes`' own source-frame-absolute numbering
 * before calling this). This function itself has no opinion on that; it
 * just converts `frame / fps` to seconds and interpolates.
 *
 * `keyframes` is never mutated — a sorted copy is used internally, since
 * keyframes are not guaranteed to arrive in frame order (mirrors every other
 * keyframe reader in this codebase, e.g. `chroma-timeline`'s own parser).
 *
 * D-197 — the actual nested-`if`/`between` construction now lives in
 * `ffmpegExpr.ts`'s `piecewiseLinearExpr`, extracted verbatim (byte-identical
 * output, see that module's own doc) once a second, unrelated caller
 * (`timelineExportAudio.ts`'s sampled fade-curve expression) needed the exact
 * same piecewise-linear-over-points construction.
 *
 * **D-233 — per-segment easing, and why this is still one expression.** A key
 * may carry an `ease` curve for `param`, shaping the segment that starts at
 * it. ffmpeg cannot solve a bezier, so an eased segment is emitted as
 * `EASE_SAMPLE_STEPS` linear sub-segments whose endpoints are the exact
 * `easeCurveEval` values — the same sampling `fadeGainExpr` performs on the
 * same curve type. The sampling is confined to eased segments: a linear one
 * still emits its two authored endpoints and nothing else, so a timeline with
 * no easing produces a **byte-identical** expression string (and therefore
 * byte-identical ffmpeg argv) to before D-233. That is asserted, not assumed —
 * see `timelineExport.ease.test.ts`.
 *
 * The preview does not sample: Rust evaluates the curve exactly, per frame.
 * That asymmetry is the same one D-197 already documents for fades, and it is
 * bounded rather than open-ended — both sides agree on the authored endpoints
 * exactly, and in between by less than the output's own quantisation. The
 * B-090/B-094/B-095 divergence class is about the two sides interpreting the
 * animation DATA differently; here they interpret it identically and one of
 * them approximates the drawing of it, within a measured bound.
 */
export function keyframeExprAt(
  keyframes: ExportKeyframe[],
  param: string,
  staticValue: number,
  fps: number,
  /** D-211 — which ffmpeg time variable the expression is written in terms
   *  of. `'t'` (the default, and every pre-D-211 caller) is right for a
   *  per-clip filter chain, whose own `t == 0` is the clip's in-point because
   *  of its `-ss` input. A TEXT clip has no input of its own: its `drawtext`
   *  runs on the composited base stream, where `t` is TIMELINE time, so that
   *  caller passes `'(t-<startSec>)'` to re-base the same keyframe times.
   *  Byte-identical output for the default, so no existing argv changes. */
  timeVar = 't',
): string {
  const keyed = keyframes
    .filter((k) => Object.prototype.hasOwnProperty.call(k.params, param))
    .map((k) => ({
      t: k.frame / fps,
      value: Number(k.params[param]),
      // Normalised exactly as `clipKeyframes.ts`'s own index does, so "linear"
      // and "no curve" are one case on both sides of the wire.
      ease: isIdentityEase(k.ease?.[param]) ? null : (k.ease?.[param] ?? null),
    }))
    .sort((a, b) => a.t - b.t);

  if (keyed.length === 0) return String(staticValue);

  const points: ExprPoint[] = [];
  for (let i = 0; i < keyed.length; i++) {
    const a = keyed[i];
    const b = keyed[i + 1];
    points.push({ t: a.t, value: a.value });
    // Interior sample points, for an eased segment only. `1..STEPS-1`: both
    // endpoints are already authored points (this key's, and the next key's on
    // its own iteration), and re-emitting them would only add duplicate `t`s
    // for `piecewiseLinearExpr` to build zero-width segments from.
    if (!b || !a.ease || b.t <= a.t) continue;
    for (let s = 1; s < EASE_SAMPLE_STEPS; s++) {
      const u = s / EASE_SAMPLE_STEPS;
      points.push({
        t: a.t + (b.t - a.t) * u,
        // The value is the EXACT one both the live preview and the authoring
        // layer resolve at this instant — `easeCurveEval` is the same mirror
        // of `chroma_types::EaseCurve::eval` they call. Only the straight
        // lines drawn between these points are the approximation.
        value: a.value + (b.value - a.value) * easeCurveEval(a.ease, u),
      });
    }
  }
  return piecewiseLinearExpr(points, timeVar);
}

// --------------------------------------------------------------------------- //
// Text / title clips (D-211/D-213) — compiled to ffmpeg's own `drawtext`
// --------------------------------------------------------------------------- //

/**
 * Quote and escape `raw` so ffmpeg delivers it to a filter option **verbatim**
 * — returns the value *including* its surrounding quotes (D-213).
 *
 * **There are two parsers, in series, and that is the whole difficulty.**
 * ffmpeg first parses the filtergraph description (splitting chains on `;`,
 * filters on `,`, reading link labels in `[…]`), honouring `'` quoting and
 * `\` escapes and **stripping them**. What survives is then handed to
 * `av_opt_set_from_string`, which splits the *remaining* text on `:` into
 * `key=value` pairs, honouring `'` and `\` all over again. A value that only
 * satisfies the first parser is therefore still wrong: the quotes that
 * protected a `:` are gone by the time the parser that splits on `:` runs.
 *
 * So each character is escaped for the level that actually cares:
 * - **`:`** → `\:` inside the quotes. The outer quotes stop the filtergraph
 *   splitter; the `\` (literal inside a quoted section, so it passes through
 *   untouched) is what stops the option splitter afterwards.
 * - **`\`** → `\\`, for the same second-level parser.
 * - **`'`** → leave the quoted section, emit `\\\'`, re-enter (`'\\\''`).
 *   Nothing can be escaped *inside* a quoted section, so a literal quote has
 *   to be emitted outside one — and it needs to survive as `\'` into the
 *   second parser, which is what the doubled backslash buys. The obvious
 *   shell-style `'\''` is the version that does NOT work: it delivers a bare
 *   `'` to the option parser, which opens a quote there and swallows every
 *   option after it (verified live — it silently rendered nothing at all).
 * - **`,` `;` `[` `]`** → nothing; the outer quotes already handle them, and
 *   the option parser does not care about them.
 * - **`%` and `{}`** → nothing; the `drawtext` node sets `expansion=none`,
 *   which makes them literal text rather than expansion directives. Turning
 *   expansion off outright beats escaping around it: none of this feature's
 *   text is ever meant to be a directive.
 *
 * Verified against ffmpeg 7.1 by rendering each awkward string BOTH through
 * this function and through `drawtext`'s own escaping-free `textfile=`, and
 * asserting the two frames are byte-identical — see
 * `timelineExportText.ffmpeg.test.ts`. That test, not this doc comment, is
 * what keeps the rule honest.
 */
export function quoteFiltergraphValue(raw: string): string {
  let out = "'";
  for (const ch of raw) {
    if (ch === '\\') out += '\\\\';
    else if (ch === ':') out += '\\:';
    else if (ch === "'") out += "'\\\\\\''";
    else out += ch;
  }
  return `${out}'`;
}

/** `#RRGGBB` / `#RGB` → ffmpeg's own `0xRRGGBB` colour literal.
 *
 *  ffmpeg's `av_parse_color` does accept a `#`-prefixed hex string, but `0x`
 *  is its documented canonical form and avoids relying on that; the 3-digit
 *  shorthand is expanded here (each nibble doubled, per CSS) because ffmpeg
 *  does not accept it at all. An unparseable value falls back to white — the
 *  same degrade `chroma_timeline::TextLayer::rgb` performs on the preview
 *  side, so a malformed colour renders the same in both engines rather than
 *  failing one of them. */
export function ffmpegColorLiteral(color: string): string {
  const hex = color.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `0x${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `0x${[...hex].map((c) => c + c).join('').toUpperCase()}`;
  }
  return '0xFFFFFF';
}

/**
 * One text clip's `drawtext` filter node: reads `[inLabel]`, writes
 * `[outLabel]`.
 *
 * **`drawtext` on the composited stream, not an `overlay` of its own input**
 * (D-213). A text clip has no media to open, so it has no ffmpeg input and no
 * per-clip filter chain; splicing its `drawtext` into the overlay chain at the
 * exact position that clip's `overlay` would have occupied is what preserves
 * z-order — a title on track 0 is still drawn last, over everything below it,
 * with no separate ordering rule to keep in step.
 *
 * **Every geometry rule here mirrors `chroma::text::render_text_layer` +
 * `composite_layer_onto` exactly:**
 * - `fontsize` = `size × the output height` — the same fraction-of-the-
 *   composition unit the Rust rasteriser resolves against its own canvas.
 * - `x`/`y` centre the text's own **ink box** (`text_w`/`text_h` are ffmpeg's
 *   measurements of the rendered glyphs, which is why the Rust side centres on
 *   the measured ink box too rather than on font ascent/descent), then add
 *   `position_x × w` / `position_y × h`.
 * - `alpha` is the clip's opacity times its fade — `composite_layer_onto`
 *   applies both as one alpha multiply on the layer.
 * - `enable` gates the clip to its own timeline window, exactly as the
 *   `overlay` step does for a media clip.
 *
 * `fontFile` is the absolute path the caller resolved from the backend's own
 * `chroma_text_fonts` catalogue — **the same file the live preview
 * rasterised** (D-212). Without it there is nothing honest to draw, so the
 * caller is expected to have resolved it; see `buildExportFfmpegArgs`.
 */
export function buildTextDrawtextStep(
  clip: Clip,
  inLabel: string,
  outLabel: string,
  opts: TimelineExportOptions,
  startSec: number,
  endSec: number,
  clipFps: number,
  fontFile: string,
): string {
  const layer = clip.text;
  if (!layer) throw new Error('buildTextDrawtextStep called on a clip with no text layer');

  const fontSize = Math.max(1, Math.round(opts.height * layer.size));
  // Every expression below runs on the BASE stream, where ffmpeg's `t` is
  // timeline time — so anything authored relative to the clip's own start
  // (its keyframes, its fade) is re-based through this.
  const clipTime = `(t-${startSec})`;

  const posExpr = (param: 'position_x' | 'position_y'): string => {
    const staticValue = clip[param] ?? 0;
    if (!hasKeyframesFor(clip, param)) return String(staticValue);
    // A text clip's `source_start` is always 0 (`newTextClipFields`), so
    // `rebaseKeyframesToClipInput` is a no-op here — called anyway so this
    // reads the same as `positionExpr` and stays correct if that ever changes.
    return keyframeExprAt(rebaseKeyframesToClipInput(clip), param, staticValue, clipFps, clipTime);
  };

  // Opacity × fade, as one alpha expression — the same multiplicative
  // composition `resolve_clip_transform` performs on the preview side (D-147:
  // "clip opacity keyframes × the fade handle").
  const opacity = clip.opacity ?? 1;
  const opacityExpr = hasKeyframesFor(clip, 'opacity')
    ? `(${keyframeExprAt(rebaseKeyframesToClipInput(clip), 'opacity', opacity, clipFps, clipTime)})`
    : String(opacity);
  const lenSec = Math.max(endSec - startSec, 0);
  const fadeExpr = fadeGainExpr(
    lenSec,
    (clip.fade_in_frames ?? 0) / clipFps,
    (clip.fade_out_frames ?? 0) / clipFps,
    clip.fade_in_curve ?? DEFAULT_EASE_CURVE,
    clip.fade_out_curve ?? DEFAULT_EASE_CURVE,
    clipTime,
  );
  const alphaExpr = fadeExpr ? `(${opacityExpr})*(${fadeExpr})` : opacityExpr;

  const optsList = [
    // Both quoted through the same escaper — a font path can contain spaces
    // ("Arial Bold.ttf") and, on some systems, characters the option parser
    // would otherwise split on.
    `fontfile=${quoteFiltergraphValue(fontFile)}`,
    `text=${quoteFiltergraphValue(layer.content)}`,
    `fontcolor=${ffmpegColorLiteral(layer.color)}`,
    `fontsize=${fontSize}`,
    // `expansion=none` — see `quoteFiltergraphValue`'s own doc. Without it a
    // title containing `%` or `{` is a text-expansion directive, not text.
    'expansion=none',
    `x='(w-text_w)/2+w*(${posExpr('position_x')})'`,
    `y='(h-text_h)/2+h*(${posExpr('position_y')})'`,
    `alpha='${alphaExpr}'`,
    `enable='between(t,${startSec},${endSec})'`,
  ];
  return `[${inLabel}]drawtext=${optsList.join(':')}[${outLabel}]`;
}

// --------------------------------------------------------------------------- //
// Subtitles / captions (D-229) — one `drawtext` per LINE, over everything
// --------------------------------------------------------------------------- //

/**
 * The `drawtext` nodes for one caption cue — **one per line**, chained.
 *
 * **Why one node per line, rather than a `\n` in a single `drawtext`**
 * (D-229). `drawtext` can render multi-line text itself, and doing so would be
 * shorter. It is not used, deliberately: its inter-line layout (line height,
 * per-line alignment) is libfreetype's, and the live preview's is `ab_glyph`'s,
 * and those two genuinely disagree — which is precisely why D-211 forbade
 * multi-line titles outright. Emitting each line as its own single-line draw at
 * a `y` that `captionLayout` computed means neither engine is ever asked to lay
 * out a second line, so the case where they agree is the only case that ever
 * runs. See `caption.ts`'s header and `chroma_timeline::caption`'s module doc.
 *
 * **`y_align=font` is load-bearing.** It makes `y` refer to the font's own line
 * box rather than to the rendered string's ink, which is what makes a `y` mean
 * the same thing for a line of "xx" as for a line of "Ag" — measured directly
 * against ffmpeg 7.1: with `y_align=font` those two strings produce an
 * identical box, with the default `y_align=text` they do not. It is also what
 * makes `box=1` a uniform band anchored at `y` instead of a rectangle that
 * jitters with each line's descenders, which is the shape
 * `scratch/resolve-reference/captioning.jpg` actually shows.
 *
 * **Every geometry number here comes from `captionLayout`**, the exact mirror
 * of the Rust `CaptionLayout` the live preview resolves — this function
 * chooses nothing. The one thing it leaves to ffmpeg is `text_w`, the measured
 * advance width used to apply the alignment; `chroma::caption_render` measures
 * the same advance from the same font file with `ab_glyph` (D-212).
 *
 * `fontFile` is the absolute path the caller resolved from the backend's own
 * `chroma_text_fonts` catalogue — the same file the preview rasterised.
 */
export function buildCaptionDrawtextSteps(
  cue: CaptionCue,
  style: Required<CaptionStyle>,
  inLabel: string,
  outLabelFor: (lineIndex: number) => string,
  opts: Pick<TimelineExportOptions, 'width' | 'height'>,
  startSec: number,
  endSec: number,
  fontFile: string,
): string[] {
  const lines = captionLines(cue.text);
  if (lines.length === 0) return [];
  const layout = captionLayout(style, opts.width, opts.height, lines.length);

  const steps: string[] = [];
  let last = inLabel;
  lines.forEach((line, i) => {
    const geom = layout.lines[i];
    const out = outLabelFor(i);
    // `text_w` is ffmpeg's measurement of this line's advance width. The
    // anchor semantics match `chroma::caption_render`'s `pen_x` exactly.
    const xExpr =
      style.align === 'left'
        ? `${geom.x_anchor}`
        : style.align === 'right'
          ? `${geom.x_anchor}-text_w`
          : `${geom.x_anchor}-text_w/2`;

    const optsList = [
      // Quoted through the same escaper the title path uses — a font path can
      // contain spaces ("Arial Bold.ttf"), and caption text is arbitrary user
      // text straight out of a `.srt` file, which is exactly where a stray
      // `:` or `'` comes from.
      `fontfile=${quoteFiltergraphValue(fontFile)}`,
      `text=${quoteFiltergraphValue(line)}`,
      `fontcolor=${ffmpegColorLiteral(style.color)}`,
      `fontsize=${layout.font_px}`,
      // `expansion=none` — see `quoteFiltergraphValue`'s own doc. Without it a
      // caption containing `%` or `{` is a text-expansion directive, not text.
      // Real subtitles contain both.
      'expansion=none',
      'y_align=font',
      `y=${geom.line_top}`,
      `x='${xExpr}'`,
    ];
    if (style.box_enabled && style.box_opacity > 0) {
      optsList.push(
        `box=1`,
        // `@a` is ffmpeg's own colour-alpha suffix. Clamped and fixed to 3
        // decimals so the compiled argv is stable for a given style rather
        // than carrying a float's full printed precision.
        `boxcolor=${ffmpegColorLiteral(style.box_color)}@${clampUnit(style.box_opacity).toFixed(3)}`,
        `boxborderw=${layout.box_padding}`,
      );
    }
    optsList.push(`enable='between(t,${startSec},${endSec})'`);
    steps.push(`[${last}]drawtext=${optsList.join(':')}[${out}]`);
    last = out;
  });
  return steps;
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

/** Every caption showing anywhere on `timeline`, in the order they must be
 *  drawn — the export-side mirror of `Timeline::resolve_visible_captions_at`.
 *
 *  Walks subtitle tracks in index order (lowest first, so a higher-index track
 *  draws on top of it — the same order the Rust resolver documents), and each
 *  track's clips in `start_frame` order so the compiled filtergraph is stable
 *  rather than depending on the bookkeeping order of `Track.clips`. */
export function captionsForExport(
  timeline: Timeline,
  fps: number,
): Array<{ clip: Clip; cue: CaptionCue; style: Required<CaptionStyle>; startSec: number; endSec: number }> {
  const out: Array<{
    clip: Clip;
    cue: CaptionCue;
    style: Required<CaptionStyle>;
    startSec: number;
    endSec: number;
  }> = [];
  for (const track of timeline.tracks ?? []) {
    if (track.kind !== 'subtitle' || track.hidden) continue;
    const clips = [...(track.clips ?? [])].sort((a, b) => a.start_frame - b.start_frame);
    for (const clip of clips) {
      if (!clip.caption) continue;
      out.push({
        clip,
        cue: clip.caption,
        style: resolveCaptionStyle(clip.caption.style, track.caption_style),
        startSec: clip.start_frame / fps,
        endSec: endFrame(clip, fps) / fps,
      });
    }
  }
  return out;
}

/** D-229/D-212 — every distinct caption font key on `timeline` that
 *  `fontFiles` cannot resolve, so the caller can refuse the export with a real
 *  reason instead of handing ffmpeg a `drawtext` with no `fontfile=` (a hard
 *  failure with an opaque message). The caption counterpart of
 *  `textClipsMissingFonts`. */
export function captionClipsMissingFonts(
  timeline: Timeline,
  fontFiles: Record<string, string> | undefined,
  fps: number,
): Array<{ clipId: string; font: string }> {
  const missing: Array<{ clipId: string; font: string }> = [];
  for (const c of captionsForExport(timeline, fps)) {
    if (fontFiles?.[c.style.font]) continue;
    missing.push({ clipId: c.clip.id, font: c.style.font });
  }
  return missing;
}

// --------------------------------------------------------------------------- //
// buildExportFfmpegArgs — the real compiler
// --------------------------------------------------------------------------- //

export interface TimelineExportOptions {
  fps: number;
  width: number;
  height: number;
  /** Export-time-only speed multiplier, keyed by `Clip.id` (e.g. `1.2`).
   *  Deliberately NOT a `Clip`/`EditOp` model field — no interactive
   *  GUI scrubbing/preview of sped-up playback exists, so this stays a pure
   *  export parameter rather than a cross-cutting change to the core
   *  trim/split/move frame-unit model. */
  speedOverrides?: Record<string, number>;
  /** B-074 — export-time-only per-clip choice of how `scale` sizes the
   *  overlay, keyed by `Clip.id`, mirroring `speedOverrides`'s own shape and
   *  rationale immediately above (no persisted `Clip`/`EditOp` field, no
   *  interactive GUI toggle exists yet — a pure export parameter, the
   *  caller's choice per export, not a cross-cutting change to the core
   *  model). `'fit'` (the default when a clip has no entry here) sizes the
   *  overlay's width to `opts.width * scale` and lets ffmpeg compute its
   *  height from the clip's own real (post-crop) aspect ratio — correct,
   *  undistorted, for a "full width, natural height" layout (e.g. two clips
   *  stacked in one canvas, each letterboxed within its half). `'stretch'`
   *  is the pre-B-074 behavior: force BOTH dimensions to
   *  `opts.width * scale` / `opts.height * scale`, i.e. a box that always
   *  has exactly the OUTPUT canvas's own aspect ratio regardless of the
   *  source's — correct for a deliberate distort effect, or a plain
   *  same-aspect picture-in-picture bubble where that was already true
   *  anyway, never correct for fitting arbitrary source footage into a
   *  differently-shaped region.
   *
   *  **D-193 superseded the need for this on any clip with a real
   *  `box_width`/`box_height` override** (now a first-class, persisted
   *  `Clip` field, not an export-time parameter — see that field's own doc
   *  and `buildClipFilterChain`'s use of it): an explicit per-axis
   *  canvas-fraction size has no more `fit`/`stretch` ambiguity to resolve.
   *  `fitOverrides` is NOT removed or deprecated — it is still exactly
   *  right for a clip that only sets `scale` (no independent-axis override
   *  at all), which stays a real, common, first-class case this option
   *  keeps serving unchanged. */
  fitOverrides?: Record<string, 'fit' | 'stretch'>;
  /** D-188 — export-time-only per-clip choice to hold this clip's OWN LAST
   *  FRAME, frozen, for the rest of the export's total runtime (the longest
   *  clip on the whole timeline) instead of simply disappearing once its own
   *  content ends — e.g. a shorter, sped-up clip stacked next to a longer
   *  one that keeps playing. Keyed by `Clip.id`, mirroring `speedOverrides`'
   *  own shape/rationale (no persisted `Clip`/`EditOp` field or GUI toggle
   *  for this yet — a real per-export creative choice, not a cross-cutting
   *  model change). A clip already at (or past) the overall total runtime is
   *  simply unaffected — no negative-duration padding is ever added. */
  freezeOverrides?: Record<string, boolean>;
  /** D-197 — which clips' sources are known to carry a real decodeable
   *  audio stream, keyed by `Clip.id`. This module is pure (no store/I-O
   *  access, per its own header doc) and so cannot probe a source itself —
   *  the caller (`editorExport.ts`'s `compileEditorExportArgs`) resolves
   *  this from the media pool's own probed `MediaVideoInfo.hasAudio`
   *  (D-129) and passes it down, the same "the compiler stays pure, the
   *  caller supplies what only it can know" split `speedOverrides`/
   *  `fitOverrides`/`freezeOverrides` already established.
   *
   *  Absent/unset for a clip resolves conservatively: `false` (no embedded
   *  audio contributed) for a `kind === 'video'` clip — the same "don't
   *  invent a signal" reading `linkedClipsFromDraggedMedia`'s own
   *  `hasAudio` doc already gives an unprobed source — and `true` for a
   *  `kind === 'audio'` clip, since a clip placed deliberately on a real
   *  audio track is assumed to carry real audio unless POSITIVELY known
   *  otherwise. Referencing a non-existent audio stream inside ffmpeg's
   *  `-filter_complex` is a hard failure (unlike a top-level `-map`, a
   *  filtergraph stream reference has no "optional" form), so getting this
   *  wrong in the "assume audio" direction breaks the whole export — the
   *  asymmetric defaults above are chosen to fail closed on the case that
   *  actually risks that (an unprobed VIDEO source, which is very often
   *  genuinely silent screen-recording footage), not out of an arbitrary
   *  preference. */
  hasAudioOverrides?: Record<string, boolean>;
  /** D-211/D-212 — absolute font-file paths keyed by `TextLayer.font`'s
   *  catalogue key, for every text clip on the timeline.
   *
   *  This module is pure (no store, no I/O, per its own header doc) and so
   *  cannot resolve a font key to a file itself; the caller
   *  (`editorExport.ts`'s `compileEditorExportArgs`) reads the backend's own
   *  `chroma_text_fonts` catalogue — **the same resolution the live preview
   *  rasterises with** — and passes it down. Exactly the "the compiler stays
   *  pure, the caller supplies what only it can know" split
   *  `hasAudioOverrides` already established (D-197).
   *
   *  A text clip whose font key is missing here is **skipped, with a real
   *  reason**, rather than compiled against a guessed path: `drawtext`
   *  without a resolvable `fontfile=` is a hard ffmpeg failure that would
   *  take the whole export down, and a substituted font would produce an
   *  export that silently disagrees with the preview. See
   *  `buildExportFfmpegArgs`' return value. */
  fontFiles?: Record<string, string>;
}

// --------------------------------------------------------------------------- //
// Transitions (D-226) — see `docs/notes/transitions.md`
// --------------------------------------------------------------------------- //

/**
 * D-226 — how ONE transition changes what this compiler emits for the two clips
 * it joins.
 *
 * **Why not ffmpeg's own `xfade`, which is literally the crossfade filter.**
 * `xfade` CONCATENATES: it takes two continuous streams, plays the first, blends
 * into the second at `offset`, and outputs `in1 + in2 - duration`. That is a
 * whole different compiler shape from this one, where every clip is an
 * independent `-i` with its own `-ss`/`-t`, its own filter chain, and its own
 * `overlay ... enable='between(t,…)'` gate onto a shared `[base]` — a model that
 * exists precisely so N tracks and arbitrary gaps/stacking work at all. Routing
 * one cut through `xfade` would mean building a second, concat-shaped pipeline
 * beside the overlay one and reconciling their timing, for a blend the overlay
 * model already expresses exactly: two clips visible at once, the incoming one's
 * alpha ramping up. So the primitive used here is `fade=alpha=1` — a plain
 * multiply on the incoming layer's alpha plane — which is also what makes
 * preview/export parity provable rather than hopeful: it is frame-index linear
 * (ffmpeg's `vf_fade` computes `frame_index / nb_frames`), which is exactly
 * `chroma_timeline::Transition::progress_at`'s own `(pos - start) / duration`.
 */
interface TransitionPlan {
  transition: Transition;
  /** `[start, end)` of the transition's own window, in OUTPUT seconds. */
  startSec: number;
  endSec: number;
  /** Cross dissolve only — the clip that must open extra media past its
   *  out-point, and how many of ITS OWN source frames of it. */
  outgoing?: { clip: Clip; tailSrcFrames: number };
  /** Cross dissolve only — the clip that must open extra media before its
   *  in-point, and how many of ITS OWN source frames of it. */
  incoming?: { clip: Clip; headSrcFrames: number };
}

/** D-226 — per-clip accumulation of every transition touching it. A clip
 *  between two dissolved cuts is the incoming of one and the outgoing of the
 *  other, so these are sums/extremes, not single values. */
interface ClipTransitionAdjust {
  /** Extra SOURCE frames to open before the clip's in-point (head handle). */
  headSrcFrames: number;
  /** Extra SOURCE frames to open past its out-point (tail handle). */
  tailSrcFrames: number;
  /** How early, in OUTPUT seconds, this clip must start being composited. */
  startSec: number | null;
  /** How late, in OUTPUT seconds, it must keep being composited. */
  endSec: number | null;
  /** Dissolve-in length in OUTPUT seconds, when this clip is a dissolve's
   *  incoming half — the `fade=t=in:alpha=1` ramp applied at the very end of
   *  its chain. `null` when it is not. */
  dissolveInSec: number | null;
}

function emptyAdjust(): ClipTransitionAdjust {
  return { headSrcFrames: 0, tailSrcFrames: 0, startSec: null, endSec: null, dissolveInSec: null };
}

/**
 * D-226 — every transition on `track` that this compiler will actually honour,
 * resolved against the real clips it joins.
 *
 * Skips (rather than mis-compiles) a transition that:
 * - has no real cut any more — one side was trimmed or deleted, and there is
 *   nothing to blend across. Same degrade `Track::push_layers_at` makes on the
 *   preview side, so the two agree about a dangling transition too;
 * - joins a clip carrying a `speedOverrides` entry. A speed override changes a
 *   clip's on-timeline footprint at export time only (see that option's own
 *   doc), so the cut the transition names is no longer where the clip's edge
 *   actually lands, and the two would drift apart by exactly the speed factor.
 *   `compileEditorExportArgs` refuses the whole export with a named reason
 *   before ever reaching here — this is the defensive second line, exactly the
 *   pair `textClipsMissingFonts` / `buildExportFfmpegArgs` already forms for an
 *   unresolvable font.
 */
export function transitionPlansFor(
  track: Track,
  opts: TimelineExportOptions,
): TransitionPlan[] {
  const plans: TransitionPlan[] = [];
  for (const transition of transitionsOf(track)) {
    const { start, end } = transitionWindow(transition);
    if (end <= start) continue;
    const outgoing = track.clips.find((c) => endFrame(c, opts.fps) === transition.at_frame);
    const incoming = track.clips.find((c) => c.start_frame === transition.at_frame);
    if (!outgoing || !incoming) continue;
    // D-235 — a clip's OWN speed ramp disqualifies a transition for exactly
    // the same reason a `speedOverrides` entry does, one step further: a ramp
    // moves the clip's edge AND makes the handle media it would need play at
    // a position the dissolve's own linear window cannot name.
    const sped = (c: Clip) => (opts.speedOverrides?.[c.id] ?? 1) !== 1 || hasSpeedRamp(c);
    if (sped(outgoing) || sped(incoming)) continue;

    const plan: TransitionPlan = {
      transition,
      startSec: start / opts.fps,
      endSec: end / opts.fps,
    };
    if (transition.kind === 'cross_dissolve') {
      // TIMELINE-frame handles converted into each clip's OWN source frames —
      // B-077's distinction: a clip whose native rate differs from the
      // project's needs a different number of its own frames to cover the same
      // timeline span.
      const { head, tail } = transitionHandles(transition);
      plan.outgoing = { clip: outgoing, tailSrcFrames: timelineFramesToSource(outgoing, tail, opts.fps) };
      plan.incoming = { clip: incoming, headSrcFrames: timelineFramesToSource(incoming, head, opts.fps) };
    }
    plans.push(plan);
  }
  return plans;
}

/** D-226 — the dip-to-colour plate's own filter chain, ending in `[label]`.
 *
 * A generated full-frame layer with **no ffmpeg input of its own** — the same
 * shape `[base]` already uses (`color` is a filter *source*), so it costs no
 * `-i` and no decode. `d=` bounds the source at the window's end so it is not
 * generated for the whole export; the two `fade`s make the triangle
 * `chroma_timeline::Transition::dip_alpha_at` computes — up to fully opaque at
 * the window's midpoint (the cut), back down to nothing at its end.
 *
 * `fade` rather than a `geq` alpha expression, deliberately: `geq` is a
 * per-pixel expression evaluated over the whole canvas for every frame it sees,
 * where `fade` is a plain multiply on the alpha plane, and (see
 * [`TransitionPlan`]) its frame-index linearity is exactly the preview's own
 * progress formula rather than an approximation of it.
 */
export function buildDipPlateChain(
  plan: TransitionPlan,
  label: string,
  opts: TimelineExportOptions,
): string {
  const halfSec = (plan.endSec - plan.startSec) / 2;
  const color = ffmpegColorLiteral(plan.transition.color ?? '#000000');
  return (
    `color=c=${color}:size=${opts.width}x${opts.height}:rate=${opts.fps}:d=${plan.endSec},` +
    `format=rgba,` +
    `fade=t=in:st=${plan.startSec}:d=${halfSec}:alpha=1,` +
    `fade=t=out:st=${plan.startSec + halfSec}:d=${halfSec}:alpha=1[${label}]`
  );
}

interface ClipChain {
  /** This clip's finished filter-chain output label, e.g. `v0`. */
  label: string;
  /** `null` for a D-226 dip-to-colour plate, which is a generated layer with no
   *  clip behind it (`plate` carries what it is instead). */
  clip: Clip | null;
  /** D-226 — set only for a dip-to-colour plate; `null` for every real clip. */
  plate: TransitionPlan | null;
  /** This clip's own on-timeline window at the OUTPUT rate, in seconds —
   *  already accounts for `speedOverrides` shrinking it (see below), and for
   *  D-226's transition windows widening it. */
  startSec: number;
  endSec: number;
  /** B-103 — where this clip's OWN in-point sits on the timeline, which
   *  `overlay`'s timeline-clock `x`/`y` expressions have to be re-based
   *  against. Differs from `startSec` only when a D-226 transition widened the
   *  composited window backwards into handle media. */
  clipStartSec: number;
  /** B-075 — this clip's own real frame rate (`clip.source_fps ?? opts.fps`),
   *  resolved once per clip so keyframe timing uses the same rate the
   *  `-ss`/`-t`/`endSec` math above it already does. */
  clipFps: number;
}

/** Where one clip's ffmpeg stream sits on the OUTPUT timeline (B-103). */
interface ClipPlacement {
  /** The timeline second the stream's FIRST frame belongs at. Equal to
   *  `clipStartSec` for an ordinary clip; earlier by the head handle for the
   *  incoming half of a D-226 cross dissolve. */
  inputStartSec: number;
  /** The timeline second the clip's OWN in-point belongs at, i.e.
   *  `clip.start_frame / opts.fps`. Every expression authored relative to the
   *  clip (its keyframes, its D-147 fade) is re-based against this. */
  clipStartSec: number;
}

/**
 * D-235 — how many of `clip`'s own source-frame units of OUTPUT it produces
 * under whichever speed applies to it: its own persisted ramp
 * (`Clip.speed_points`), else an export-time flat `speedOverrides` entry, else
 * neither.
 *
 * This is the ONE place this file converts a clip's trim window into an output
 * length, replacing the `clip.duration / speed` that used to be spelled inline
 * at three sites. It returns exactly `clip.duration` for an un-ramped,
 * un-overridden clip and exactly `clip.duration / speed` for a flat override,
 * so no existing export's timing moves by a frame.
 *
 * Its preview twin is `timeline.ts`'s `clipOutputSourceFrames` (and
 * `chroma_timeline::Clip::output_source_frames`), which is the same sum over
 * the same segments — that shared definition is what makes a ramped clip
 * occupy the same number of timeline frames in the app as it does in the file.
 */
function outputSourceFrames(clip: Clip, opts: TimelineExportOptions): number {
  return rampOutputSourceFrames(resolveSpeedSegments(clip, opts.speedOverrides?.[clip.id]));
}

/** One clip's `setpts`/`crop`/`scale` chain, ending in `[label]` — factored
 *  out of `buildExportFfmpegArgs` so it's independently testable. Takes the
 *  clip's ffmpeg INPUT index (`inputIdx`, one `-i` per clip, in track/clip
 *  order) since `[N:v]` is how a filter chain addresses its own input. */
function buildClipFilterChain(
  clip: Clip,
  inputIdx: number,
  label: string,
  opts: TimelineExportOptions,
  clipFps: number,
  padSecs = 0,
  transition: ClipTransitionAdjust = emptyAdjust(),
  placement: ClipPlacement = { inputStartSec: 0, clipStartSec: 0 },
): string {
  const steps: string[] = [];
  let src = `[${inputIdx}:v]`;

  // B-103 — **place this clip in TIME.** Every `-i` here decodes to a stream
  // whose own timestamps start at ~0, and `overlay` pairs its two inputs BY
  // TIMESTAMP (ffmpeg's `framesync`), so without this shift a clip at
  // `start_frame > 0` had its real frames consumed against the base stream's
  // first seconds — where its own `enable='between(t,…)'` gate was still
  // closed — and then, once the gate opened, showed nothing but its LAST frame
  // repeated for the rest of its window (`overlay`'s default
  // `eof_action=repeat`). Confirmed directly against real ffmpeg output, not
  // reasoned about: a two-colour source placed at t=2 rendered its second
  // colour, frozen, for its whole window.
  //
  // The audio half of this compiler always did place its sources
  // (`timelineExportAudio.ts`'s `adelay`); the video half simply never grew
  // the equivalent, and every existing real-ffmpeg test happened to place its
  // clips at frame 0 or use a flat colour, where the two are indistinguishable.
  // `setpts=PTS+<start>/TB` is the video equivalent — timestamps only, no
  // frames generated, no decode cost.
  //
  // **First in the chain, before `crop`**, so there is exactly ONE time base
  // downstream: after this step every filter's `t`/`T` is TIMELINE seconds,
  // which is also what `overlay`'s own `enable`/`x`/`y` expressions have always
  // used. Two time bases in one chain is precisely how the position-keyframe
  // half of this bug went unnoticed.
  //
  // D-235 — the same `setpts` node now also carries a variable-speed RAMP,
  // because a ramp is nothing but a non-constant version of the `PTS/speed`
  // term that was already here. `rampSetptsSecondsExpr` returns `null` for a
  // flat ramp, in which case the pre-D-235 `PTS/<speed>` form is emitted
  // byte-for-byte — a plain speed override, and an un-ramped clip, compile to
  // exactly the filtergraph they always did.
  //
  // The ramped form works in SECONDS (`T`) rather than PTS units and divides
  // by `TB` once at the end, because the expression's knots are real
  // source-time boundaries; `PTS*TB == T`, so the two forms are the same
  // arithmetic written in different units, which is why the flat special case
  // is an optimisation and not a second semantics.
  const speedSegments = resolveSpeedSegments(clip, opts.speedOverrides?.[clip.id]);
  const rampExpr = rampSetptsSecondsExpr(speedSegments, clipFps);
  if (rampExpr !== null) {
    const placeTerm = placement.inputStartSec !== 0 ? `+${placement.inputStartSec}` : '';
    // SINGLE-QUOTED, and that is load-bearing rather than cosmetic: a comma is
    // how a filtergraph separates one filter from the next, so an unquoted
    // `if(lt(T,x),a,b)` is parsed as three filters and ffmpeg fails outright
    // with "No such filter: 'x)'". Every other expression this file emits is
    // already quoted because it sits in a `key='value'` option
    // (`scale=w='...'`); `setpts` takes its expression as the whole argument,
    // so the quotes go around that instead. Caught by the real-ffmpeg test in
    // `speedRamp.ffmpeg.test.ts`, which is the only thing that would have.
    steps.push(`${src}setpts='(${rampExpr}${placeTerm})/TB'[s${label}]`);
    src = `[s${label}]`;
  } else {
    const speedFactor = flatSpeedOf(speedSegments);
    const ptsTerms: string[] = [speedFactor !== 1 ? `PTS/${speedFactor}` : 'PTS'];
    if (placement.inputStartSec !== 0) ptsTerms.push(`${placement.inputStartSec}/TB`);
    if (ptsTerms.length > 1 || speedFactor !== 1) {
      steps.push(`${src}setpts=${ptsTerms.join('+')}[s${label}]`);
      src = `[s${label}]`;
    }
  }

  // Clip-relative time, for every expression authored against the clip's own
  // in-point (its keyframes, its D-147 fade) now that the chain runs on
  // TIMELINE time. Exactly the re-basing `buildTextDrawtextStep` has always
  // done for a title, which runs on the composited base stream for the same
  // reason. Two variables because ffmpeg is not consistent about the spelling:
  // `geq` uses uppercase `T` and rejects `t` outright, while
  // `scale`/`crop`/`rotate` all take lowercase `t` — see `alphaExpr`'s own note
  // below.
  const clipT0 = placement.clipStartSec;
  const tVar = clipT0 !== 0 ? `(t-${clipT0})` : 't';
  const bigTVar = clipT0 !== 0 ? `(T-${clipT0})` : 'T';

  // B-098 — the four crop insets are now keyframe-or-static, mirroring
  // `scaleExpr`'s own shape exactly: identity (no filter step) when the clip
  // has neither a static crop nor any crop keyframe, so an uncropped clip
  // compiles byte-identically to before this fix. Unlike `scale`/`crop`'s
  // sibling filters, ffmpeg's `crop` filter has no `eval=init`/`eval=frame`
  // toggle at all — confirmed empirically (a two-colour `hstack` source
  // cropped with an animated `x` expression genuinely switches which half
  // shows at the exact frame the expression crosses over) that its `w`/`h`/
  // `x`/`y` expressions are simply always evaluated per frame, with no
  // B-090-style trap to route around here.
  const cl = clip.crop_left ?? 0;
  const ct = clip.crop_top ?? 0;
  const cr = clip.crop_right ?? 0;
  const cb = clip.crop_bottom ?? 0;
  const hasCropKeyframes = (['crop_left', 'crop_top', 'crop_right', 'crop_bottom'] as const).some((p) =>
    hasKeyframesFor(clip, p),
  );
  if (cl !== 0 || ct !== 0 || cr !== 0 || cb !== 0 || hasCropKeyframes) {
    const insetExpr = (param: 'crop_left' | 'crop_top' | 'crop_right' | 'crop_bottom', staticValue: number): string =>
      hasKeyframesFor(clip, param)
        ? keyframeExprAt(rebaseKeyframesToClipInput(clip), param, staticValue, clipFps, tVar)
        : String(staticValue);
    const clExpr = insetExpr('crop_left', cl);
    const ctExpr = insetExpr('crop_top', ct);
    const crExpr = insetExpr('crop_right', cr);
    const cbExpr = insetExpr('crop_bottom', cb);
    // B-075/B-090's own single-quoting requirement: a keyframed expression is
    // full of bare commas/colons ffmpeg's filtergraph syntax would otherwise
    // split on. A plain static value is just a bare number with no special
    // characters, so quoting it too is harmless.
    steps.push(
      `${src}crop=w='iw*(1-(${clExpr})-(${crExpr}))':h='ih*(1-(${ctExpr})-(${cbExpr}))':` +
        `x='iw*(${clExpr})':y='ih*(${ctExpr})'[c${label}]`,
    );
    src = `[c${label}]`;
  }

  // B-090 — `scale` used to be read ONCE here (`clip.scale ?? 1`, a plain
  // number baked into a static ffmpeg `scale=` step) even when the clip had
  // real `scale` keyframes (`editor_set_clip_keyframes`) — so a "zoom"
  // authored as a `scale` animation silently compiled to NO resize at all;
  // only `position_x`/`position_y`'s own dynamic expressions (below, in the
  // `overlay` step) actually moved anything, panning a box that never grew
  // to compensate — confirmed live: a punch-in zoom's pan revealed a real
  // black gap on the box's trailing edge, proportional to how far scale had
  // "zoomed" (which never actually happened). `scaleExpr` mirrors
  // `positionExpr`'s own keyframe-or-static shape exactly; `eval=frame` on
  // the `scale` filter (default `eval=init`, evaluated ONCE) is what makes
  // ffmpeg re-evaluate a `t`-referencing width expression every frame —
  // without it a keyframed expression would still only be sampled once, at
  // t=0, silently reproducing the same bug under a different mechanism.
  const scale = clip.scale ?? 1;
  const hasScaleKeyframes = hasKeyframesFor(clip, 'scale');
  const scaleExpr = hasScaleKeyframes
    ? keyframeExprAt(rebaseKeyframesToClipInput(clip), 'scale', scale, clipFps, tVar)
    : String(scale);
  // D-193 — `box_width`, when the clip has one, is a DIRECT canvas-fraction
  // override (mirrors `position_x`'s own convention) — it replaces
  // `opts.width*scale` outright rather than participating in B-074's
  // `fit`/`stretch` choice, since there is no more ambiguity to resolve
  // once the caller has stated the width explicitly. Falls back to the
  // pre-D-193 `opts.width*scale` when absent, so an existing clip (or one
  // that only sets `scale`) compiles byte-identically to before.
  const widthExpr = clip.box_width != null ? `${opts.width}*${clip.box_width}` : `${opts.width}*(${scaleExpr})`;
  // B-074 — see `TimelineExportOptions.fitOverrides`'s own doc for the full
  // "why": `'fit'` (default) sizes WIDTH from the canvas and lets ffmpeg's
  // `-2` compute height from the clip's real post-crop aspect ratio;
  // `'stretch'` keeps the pre-B-074 behavior of forcing both dimensions to
  // canvas-relative fractions (always canvas-shaped, any `scale`).
  // `position_y` always just places the resulting box's top-left corner
  // (D-136's convention, unchanged either way) — the CALLER computes where
  // to put it, e.g. centering a shorter-than-its-slot 'fit' box within one
  // canvas-half using the clip's own known aspect ratio from
  // `editor_import_media`'s probe result.
  //
  // D-193 — `box_height`, when the clip has one, is the same kind of direct
  // canvas-fraction override as `box_width` above and takes priority over
  // `fitOverrides` entirely: an explicit persisted height is a MORE
  // specific signal than an export-time-only fit/stretch default, and once
  // both axes are explicitly known there is nothing left for ffmpeg's `-2`
  // to compute. Unlike `box_width` (which was always unconditional — `fit`/
  // `stretch` never touched width), `box_height` is genuinely a third
  // option alongside `fit`/`stretch`, not a variant of either.
  //
  // **Known, deliberate limit (D-193):** `box_width`/`box_height` are a
  // fraction of the OUTPUT CANVAS in both this compiler and the Rust
  // live-preview compositor (`chroma::edit::composite_layer_onto`) — a
  // genuinely NEW field with NO Rust/TS parity gap, unlike `scale` itself
  // (whose meaning depends on the clip's own SOURCE resolution, which this
  // pure, no-I/O module still cannot probe — B-074/D-184's own pre-existing,
  // intentionally-not-reopened gap). See D-193's decision entry for the
  // full comparison.
  const fitMode = opts.fitOverrides?.[clip.id] ?? 'fit';
  const heightExpr =
    clip.box_height != null
      ? `${opts.height}*${clip.box_height}`
      : fitMode === 'stretch'
        ? `${opts.height}*(${scaleExpr})`
        : '-2';
  // `eval=frame` (default `eval=init`, sampled once) only when `scale` is
  // actually animated — a keyframed width/height expression under the
  // default `eval=init` would still only be evaluated at t=0, reproducing
  // B-090 under a different name. Harmless to omit for the static case
  // (nothing in `widthExpr`/`heightExpr` references `t` then), so this stays
  // scoped rather than always-on.
  const evalSuffix = hasScaleKeyframes ? ':eval=frame' : '';
  // B-090/B-075 — same single-quoting requirement as the overlay's own x/y
  // expressions: a keyframed `if(between(t,a,b),...)` expression is full of
  // bare commas/colons ffmpeg's filtergraph syntax would otherwise split
  // on. `'-2'` (the `fit` mode's own literal auto-height sentinel, not an
  // expression) must stay unquoted — quoting it would make ffmpeg try to
  // parse the literal two-character string "-2" as an expression, which it
  // is not.
  const quotedWidth = `'${widthExpr}'`;
  const quotedHeight = heightExpr === '-2' ? heightExpr : `'${heightExpr}'`;

  // B-095 — `opacity` and `rotation`, static AND keyframed, mirroring
  // `scaleExpr`'s own identity-when-default shape exactly: neither field
  // emits a filter step at all unless it's actually doing something, so
  // every clip that never touches either (still the overwhelming majority)
  // compiles byte-identically to before this fix.
  const opacity = clip.opacity ?? 1;
  const hasOpacityKeyframes = hasKeyframesFor(clip, 'opacity');
  // `geq` (below) is the only filter here whose time variable is spelled
  // `T`, not `t` — confirmed empirically: `T` animates per frame exactly
  // like every other filter's `t`, but `t` itself is flatly undefined in a
  // `geq` expression ("Undefined constant... in 't,...'"), unlike
  // `scale`/`crop`/`rotate`, which all take lowercase `t`. Both expressions
  // built for `alphaExpr` below are built in terms of `T` for exactly this
  // reason — nothing else in this function reuses them.
  const opacityExpr = hasOpacityKeyframes
    ? keyframeExprAt(rebaseKeyframesToClipInput(clip), 'opacity', opacity, clipFps, bigTVar)
    : String(opacity);
  // Opacity × fade, as one alpha expression — the same multiplicative
  // composition `resolve_clip_transform` performs on the preview side
  // (D-147), mirroring `buildTextDrawtextStep`'s own `alphaExpr` exactly.
  // `len` is this clip's OWN post-speed decoded-stream duration in seconds —
  // already the domain `T` lives in here (this filter chain is the clip's
  // own single ffmpeg input, whose `T == 0` is its own in-point; unlike
  // `buildTextDrawtextStep`, which runs on the composited BASE stream and
  // needs `clipTime` rebasing, nothing here needs an offset).
  //
  // B-112 / D-235 — every one of the three is a POST-retime output second,
  // obtained through the ramp's own forward map. `lenSec` always was (it
  // divided by the flat speed), but the two fade windows were NOT: they were
  // `frames / clipFps` with no speed division at all, so on a clip carrying a
  // `speedOverrides` entry the picture's fade ran `speed`× longer than both
  // its own clip length and the very same fade on that clip's AUDIO, which
  // `buildAudioSourceChain` has always divided correctly. Routing all three
  // through one map fixes that flat-speed bug and makes the ramped case right
  // by construction, rather than adding a second way to be wrong.
  const clipEndSourceFrame = clip.source_start + clip.duration;
  const outSec = (sourceFrame: number) => outputAtSourceFrame(speedSegments, sourceFrame) / clipFps;
  const lenSec = outSec(clipEndSourceFrame);
  const fadeExpr = fadeGainExpr(
    lenSec,
    outSec(clip.source_start + (clip.fade_in_frames ?? 0)),
    lenSec - outSec(clipEndSourceFrame - (clip.fade_out_frames ?? 0)),
    clip.fade_in_curve ?? DEFAULT_EASE_CURVE,
    clip.fade_out_curve ?? DEFAULT_EASE_CURVE,
    bigTVar,
  );
  const alphaExpr = fadeExpr ? `(${opacityExpr})*(${fadeExpr})` : opacityExpr;
  // D-226 — a dissolve's own ramp is NOT folded in here: it is a separate
  // `fade=alpha=1` step appended after this one (see `after` below), because
  // `fade`'s frame-index linearity is exactly the preview's own `progress_at`
  // and an expression would only approximate it. Both multiply the same alpha
  // plane, so the composition is the same product either way — this is about
  // which primitive computes the ramp, not about the order.
  const needsAlpha = hasOpacityKeyframes || opacity !== 1 || !!fadeExpr;
  const dissolveInSec = transition.dissolveInSec;

  const rotation = clip.rotation ?? 0;
  const hasRotationKeyframes = hasKeyframesFor(clip, 'rotation');
  const rotationExpr = hasRotationKeyframes
    ? keyframeExprAt(rebaseKeyframesToClipInput(clip), 'rotation', rotation, clipFps, tVar)
    : String(rotation);
  const needsRotation = hasRotationKeyframes || rotation !== 0;

  // Ordered chain from here: scale -> [format+rotate+alpha, if either is
  // real] -> [tpad, if freezing]. Each step's OUTPUT label is `label` itself
  // only if it's the LAST one that actually runs — everything before that
  // gets its own tagged intermediate label. This is what keeps a plain clip
  // (no rotation, no opacity/fade, no freeze — still most clips) emitting
  // the exact same single `scale=...[label]` line as before B-095.
  type Step = (inLabel: string) => string;
  const after: { tag: string; build: Step }[] = [];
  if (needsRotation || needsAlpha || dissolveInSec !== null) {
    // `format=rgba` first: a plain decoded video frame (yuv420p, no alpha
    // plane) makes `rotate`'s transparent `fillcolor`, `geq`'s alpha
    // read/write and (D-226) `fade`'s own `alpha=1` all silently no-op.
    // Needed for any one of the three alone.
    after.push({ tag: 'fmt', build: (inLabel) => `[${inLabel}]format=rgba` });
  }
  if (needsRotation) {
    // `angle` is in RADIANS; `t.rotation`/keyframes are stored in DEGREES
    // (matching the Rust side's own `ClipTransform.rotation` unit) — hence
    // `*PI/180`. Verified against the Rust compositor's own
    // `imageproc::rotate_about_center` empirically (a real two-tone probe
    // image through both engines): both rotate the same visual direction
    // for the same signed angle, and both keep the ORIGINAL frame's own
    // dimensions (no `ow`/`oh` override needed) — so no sign flip and no
    // extra canvas math is required to match. `rotate` has no `eval=init`
    // trap the way `scale`/`crop` do — its `angle` expression is always
    // re-evaluated per frame, confirmed against real ffmpeg output, not
    // assumed (see the B-095 decision entry).
    after.push({
      tag: 'rot',
      build: (inLabel) => `[${inLabel}]rotate=angle='(${rotationExpr})*PI/180':fillcolor=black@0.0`,
    });
  }
  if (needsAlpha) {
    // No filter takes a single per-frame "multiply the whole layer's alpha"
    // parameter that also accepts a time-varying expression — confirmed
    // empirically: `colorchannelmixer`'s `aa` rejects `t` outright
    // ("Undefined constant... in 't,...'"), unlike `scale`/`crop`/`rotate`.
    // `geq`'s per-pixel `alpha_expr` does support time (as `T`) and can read
    // the existing alpha plane back via `alpha(X,Y)` — multiplying through
    // it rather than overwriting is what keeps this composing correctly
    // with the crop mask above (a cropped-away pixel is already alpha 0
    // there; opacity must not un-hide it).
    after.push({
      tag: 'al',
      build: (inLabel) =>
        `[${inLabel}]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alphaExpr})'`,
    });
  }
  // D-226 — the dissolve ramp: this clip is the INCOMING half of a cross
  // dissolve, so its alpha rises linearly from nothing at the transition
  // window's first frame to full at its last. `st` is the window's own start in
  // TIMELINE seconds, which is what this chain's clock reads after B-103's
  // `setpts` placement above — and it is exactly `placement.inputStartSec`,
  // since the input was opened `headSrcFrames` early for precisely this window.
  //
  // `fade` MULTIPLIES the existing alpha plane rather than overwriting it
  // (ffmpeg's `vf_fade` scales it), so this composes correctly with the `geq`
  // step above and with the crop mask below it — a clip that is 50% opaque,
  // fading out, and dissolving in is all three at once, exactly as
  // `chroma::edit`'s `with_transition_alpha` multiplies them on the preview
  // side. It runs BEFORE `tpad` for the same reason `tpad` runs last there: a
  // held frame must be identical to the last real one, ramp included.
  if (dissolveInSec !== null && dissolveInSec > 0) {
    const rampStartSec = placement.inputStartSec;
    after.push({
      tag: 'xf',
      build: (inLabel) => `[${inLabel}]fade=t=in:st=${rampStartSec}:d=${dissolveInSec}:alpha=1`,
    });
  }
  // D-188 — `freezeOverrides`: hold this clip's own real last decoded frame,
  // cloned, for `padSecs` more seconds past its natural end. `tpad` runs
  // LAST (after any rotate/alpha) so the held frame is pixel-identical to
  // whatever the clip's own last real frame actually rendered as — the
  // caller (`buildExportFfmpegArgs`) also extends this clip's own
  // `enable=between()` window to match, or the held frame would decode fine
  // but never actually get composited past the original window.
  if (padSecs > 0) {
    after.push({ tag: 'tpad', build: (inLabel) => `[${inLabel}]tpad=stop_mode=clone:stop_duration=${padSecs}` });
  }

  const scaleLabel = after.length > 0 ? `sc${label}` : label;
  steps.push(`${src}scale=w=${quotedWidth}:h=${quotedHeight}${evalSuffix}[${scaleLabel}]`);

  let cur = scaleLabel;
  after.forEach((step, i) => {
    const outLabel = i === after.length - 1 ? label : `${step.tag}${label}`;
    steps.push(`${step.build(cur)}[${outLabel}]`);
    cur = outLabel;
  });

  return steps.join(';');
}

function hasKeyframesFor(clip: Clip, param: string): boolean {
  return (clip.chroma_keyframes ?? []).some((k) => Object.prototype.hasOwnProperty.call(k.params, param));
}

/** `Clip.chroma_keyframes`, re-based from the Rust engine's own numbering
 *  (`resolve_clip_transform(clip, source_frame)` — SOURCE-frame-absolute,
 *  `edit.rs`) to be relative to THIS clip's own ffmpeg input stream, whose
 *  `t == 0` is `clip.source_start` (because of the `-ss <source_start/fps>`
 *  on that input, below). Without this shift, a clip trimmed mid-source
 *  (`source_start > 0`) would have its keyframes' timing offset by exactly
 *  `source_start/fps` seconds inside its own filter chain. */
function rebaseKeyframesToClipInput(clip: Clip): ExportKeyframe[] {
  // D-233 — `ease` rides along with the entry it belongs to. Re-basing
  // shifts WHEN a key is, never what shape leaves it; dropping the map here
  // would have exported every eased animation as linear while the preview
  // eased it, which is precisely the preview/export divergence class
  // B-090/B-094/B-095 document.
  return (clip.chroma_keyframes ?? []).map((k) => ({
    frame: k.frame - clip.source_start,
    params: k.params,
    ease: k.ease,
  }));
}

/** B-103 — `overlay`'s `x`/`y` expressions are evaluated on the MAIN (base)
 *  stream's clock, i.e. TIMELINE seconds, so a clip's own keyframe times have to
 *  be re-based against where that clip starts on the timeline (`clipStartSec`).
 *  Before this they were emitted in clip-relative seconds against a timeline
 *  clock, so a clip at `start_frame > 0` ran its position animation
 *  `clipStartSec` seconds early — the same "two time bases in one graph" mistake
 *  as the missing `setpts` placement, in the one filter that was always on the
 *  timeline's clock. Byte-identical output for a clip at frame 0. */
function positionExpr(
  clip: Clip,
  param: 'position_x' | 'position_y',
  fps: number,
  clipStartSec = 0,
): string {
  const staticValue = clip[param] ?? 0;
  if (!hasKeyframesFor(clip, param)) return String(staticValue);
  const timeVar = clipStartSec !== 0 ? `(t-${clipStartSec})` : 't';
  return keyframeExprAt(rebaseKeyframesToClipInput(clip), param, staticValue, fps, timeVar);
}

/**
 * D-211/D-212 — every distinct `TextLayer.font` key on `timeline` that
 * `fontFiles` has no absolute path for, with the clips that use it.
 *
 * Called by `compileEditorExportArgs` BEFORE compiling, so an unresolvable
 * font is a real, named error at compile time rather than an opaque ffmpeg
 * failure at run time ("Could not load font ...") or, worse, a title silently
 * missing from the finished file. `buildExportFfmpegArgs` also skips such a
 * clip defensively, but the caller is where the reason can actually be
 * reported.
 */
export function textClipsMissingFonts(
  timeline: Timeline,
  fontFiles: Record<string, string> | undefined,
): Array<{ clipId: string; font: string }> {
  const missing: Array<{ clipId: string; font: string }> = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (!clip.text) continue;
      if (fontFiles?.[clip.text.font]) continue;
      missing.push({ clipId: clip.id, font: clip.text.font });
    }
  }
  return missing;
}

/**
 * Compile `timeline` into a single ffmpeg argv array rendering `outPath` at
 * `opts.fps`/`opts.width`/`opts.height`.
 *
 * Picture: VIDEO tracks only, visible (`!track.hidden`) clips only — the
 * original v1 scope, unchanged.
 *
 * Sound (D-197): every visible video-track clip's own embedded audio (unless
 * A/V-linked, D-129, or `opts.hasAudioOverrides` says its source has none)
 * PLUS every `kind === 'audio'` track's clips (hidden or not — `hidden` is a
 * picture-only concept, matching `resolve_audio_track_positions`'s own real
 * behavior, replicated here rather than reinvented) are mixed down to one
 * `-map`ped audio stream — see `timelineExportAudio.ts` for the actual
 * gain/fade/duck math.
 *
 * Compositing order mirrors `chroma_timeline::edit::composite_video_frame`'s
 * own documented paint contract (`edit.rs`): **track index 0 is the highest
 * z-priority (painted last, on top)**; higher track indices paint first, at
 * the back. So the base of the overlay chain is the highest-indexed visible
 * video track, with each lower index overlaid on top of it in turn, ending
 * with track 0 last (topmost).
 *
 * **Transitions (D-226).** A track's clips are walked in **time order** here
 * (a stable sort on `start_frame`), not in `Track.clips` `Vec` order. That is a
 * strict no-op for every project without transitions — clips on one track never
 * overlap (D-104), so their paint order among themselves is unobservable — and
 * it is load-bearing with one: a cross dissolve is the only case where two clips
 * on ONE track are composited at the same instant, and the incoming one has to
 * land on top of the outgoing one for `p·incoming + (1-p)·outgoing` to be what
 * comes out. A dip-to-colour plate is emitted after its own track's clips and
 * before the next (higher-priority) track's, so a dip never covers a track above
 * it. See `transitionPlansFor` / `buildDipPlateChain`.
 */
export function buildExportFfmpegArgs(timeline: Timeline, outPath: string, opts: TimelineExportOptions): string[] {
  const videoTracks = timeline.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.kind === 'video' && !track.hidden);

  const inputs: string[] = [];
  const filterSteps: string[] = [];
  const chains: ClipChain[] = [];
  let inputIdx = 0;

  // Highest track index first (painted first/at the back), track 0 last
  // (painted last/on top) — see this function's own doc.
  const paintOrder = [...videoTracks].sort((a, b) => b.index - a.index);

  // Pass 1 — real per-clip timing only (`-ss`/`-t` inputs, each clip's own
  // natural start/end in OUTPUT seconds). Deliberately NOT building filter
  // chains yet: D-188's `freezeOverrides` needs `totalDurationSec` (the
  // furthest NATURAL end across every clip) to know how much padding a
  // frozen clip needs, and that isn't known until every clip's own natural
  // end has been computed once.
  interface PendingClip {
    /** `null` for a D-226 dip-to-colour PLATE, which is a generated layer with
     *  no clip and no media of its own (`plate` says what it is instead). */
    clip: Clip | null;
    /** D-226 — set only for a dip-to-colour plate. */
    plate: TransitionPlan | null;
    /** `null` for a TEXT clip (D-211) and for a D-226 plate: neither opens a
     *  file, so neither consumes an `-i` or has a `[N:v]` to address. A text
     *  clip's picture comes from a `drawtext` node spliced into the overlay
     *  chain (see `buildTextDrawtextStep`), a plate's from a `color` filter
     *  source (see `buildDipPlateChain`). */
    inputIdx: number | null;
    label: string;
    startSec: number;
    endSec: number;
    /** D-226 — this clip's own on-timeline start, BEFORE any transition widened
     *  `startSec`. The picture has to be composited early (that is the
     *  dissolve); the SOUND does not — see the embedded-audio walk below. */
    naturalStartSec: number;
    clipFps: number;
    /** D-197 — which VIDEO track this clip is on, needed only for embedded-
     *  audio ducking (`resolveDuckForTrack` looks up `duck_from` on THIS
     *  track, not the clip). */
    trackIndex: number;
    /** D-226 — everything the transitions touching this clip change about its
     *  input window, its composited window and its alpha. All zero/`null` for
     *  a clip no transition touches, which is every clip in a project with
     *  none. */
    transition: ClipTransitionAdjust;
  }
  const pending: PendingClip[] = [];

  for (const { track, index: trackIndex } of paintOrder) {
    // D-226 — resolve this track's transitions once, then fold each one into
    // the two clips it joins. Accumulated per clip (not assigned) because a
    // clip between two dissolved cuts is the incoming half of one and the
    // outgoing half of the other.
    const plans = transitionPlansFor(track, opts);
    const adjusts = new Map<string, ClipTransitionAdjust>();
    const adjustFor = (clip: Clip): ClipTransitionAdjust => {
      let a = adjusts.get(clip.id);
      if (!a) {
        a = emptyAdjust();
        adjusts.set(clip.id, a);
      }
      return a;
    };
    for (const plan of plans) {
      if (plan.outgoing) {
        const a = adjustFor(plan.outgoing.clip);
        a.tailSrcFrames = Math.max(a.tailSrcFrames, plan.outgoing.tailSrcFrames);
        a.endSec = Math.max(a.endSec ?? plan.endSec, plan.endSec);
      }
      if (plan.incoming) {
        const a = adjustFor(plan.incoming.clip);
        a.headSrcFrames = Math.max(a.headSrcFrames, plan.incoming.headSrcFrames);
        a.startSec = Math.min(a.startSec ?? plan.startSec, plan.startSec);
        a.dissolveInSec = plan.endSec - plan.startSec;
      }
    }

    // D-226 — TIME order, not `Vec` order. A strict no-op without transitions
    // (clips on a track never overlap, so their relative paint order is
    // unobservable); load-bearing with one — see this function's own doc.
    const orderedClips = [...track.clips].sort((a, b) => a.start_frame - b.start_frame);
    for (const clip of orderedClips) {
      const adjust = adjusts.get(clip.id) ?? emptyAdjust();
      // D-235 — the clip's own OUTPUT length in its own source-frame units.
      // Replaces the pre-D-235 `clip.duration / speed` this loop spelled
      // inline twice, and is exactly that value for a flat clip.
      const outSrcFrames = outputSourceFrames(clip, opts);
      // B-075 — `source_start`/`duration` (and a keyframe's `frame`) are
      // documented as SOURCE frames, i.e. at the CLIP's own native rate —
      // only `start_frame` is a TIMELINE frame, at the project/export rate
      // (`opts.fps`). Converting source frames to seconds with `opts.fps`
      // instead of the source's own rate silently produces the wrong
      // duration/timing for any clip whose native fps differs from the
      // export's — exactly two real screen recordings at two different
      // native frame rates, composited together, will do. Falls back to
      // `opts.fps` only for a clip with no known `source_fps` (created
      // before this field existed, or from an unprobed source) — the
      // pre-B-075 behavior, better than nothing but only actually correct
      // when the source happens to share the project's own rate.
      const clipFps = clip.source_fps ?? opts.fps;

      // D-211 — a TEXT clip has no file to open: no `-i`, no input index, no
      // per-clip filter chain. It still takes a real slot in `pending` (and
      // so a real position in the paint order below) because it is a real
      // visible layer occupying real timeline space — `totalDurationSec` and
      // z-order both have to count it. `label` is derived from its clip id
      // rather than an input index, since it has none; `t` prefixed so a text
      // label can never collide with a `v<N>` input label.
      // D-230 — an ADJUSTMENT clip takes the exact same "no `-i`, no input
      // index, real slot in the paint order" branch, and for the same reason:
      // it occupies real timeline space and its position in the chain is what
      // decides which layers it reaches. It differs only in what gets spliced
      // there — two colour-filter nodes on the composited stream rather than a
      // `drawtext` or an `overlay`. Sharing this branch (rather than adding a
      // parallel one) is what guarantees a title and an adjustment on the same
      // track keep their relative order.
      if (clip.text || clip.adjustment) {
        const startSec = clip.start_frame / opts.fps;
        pending.push({
          clip,
          plate: null,
          inputIdx: null,
          label: `t${pending.length}`,
          startSec,
          // A generated layer has no `source_fps` (see `newTextClipFields`),
          // so `clipFps` is the export's own rate and `duration` really is
          // its timeline footprint. The speed still divides it for the same
          // reason it does for a media clip: a speed change (flat or ramped,
          // D-235) shrinks the window a clip occupies in the output.
          endSec: startSec + outSrcFrames / clipFps,
          naturalStartSec: startSec,
          clipFps,
          trackIndex,
          transition: adjust,
        });
        continue;
      }

      // D-226 — a transition widens this clip's INPUT window into its handle
      // media: `headSrcFrames` before its in-point, `tailSrcFrames` past its
      // out-point, both already in this clip's OWN source frames. Zero for a
      // clip no transition touches, so the `-ss`/`-t` pair below is
      // byte-identical to pre-D-226 for it. `checkTransition` has already
      // refused any transition whose handles do not exist, so this never asks
      // ffmpeg for media outside the file.
      inputs.push(
        '-ss',
        String((clip.source_start - adjust.headSrcFrames) / clipFps),
        '-t',
        String((clip.duration + adjust.headSrcFrames + adjust.tailSrcFrames) / clipFps),
        '-i',
        clip.source_path,
      );

      // `start_frame` is a TIMELINE frame (project/export rate) — `opts.fps`
      // is correct here. `duration` is a SOURCE frame count — `clipFps` is
      // correct here, same reasoning as the `-ss`/`-t` conversion above.
      // When sped up, `setpts=PTS/speed` compresses playback into
      // `duration / speed` (source seconds) worth of OUTPUT time — or, under
      // a D-235 ramp, into `Σ len_i / speed_i`, which is the same statement
      // once the speed stops being constant. The
      // `enable=between()` gate below must shrink to match, or the clip
      // would appear to freeze/hold its last frame for the un-shrunk
      // remainder of its original window.
      //
      // D-226 — a transition also widens the window this clip is COMPOSITED
      // over: the outgoing half keeps being drawn (opaquely) until the window
      // ends, and the incoming half starts being drawn (from zero alpha) when
      // it begins. Without both halves the extra handle media would decode
      // fine and simply never be shown — the same pairing D-188's freeze
      // already needs between its `tpad` and its `enable` window.
      const startSec = Math.min(clip.start_frame / opts.fps, adjust.startSec ?? Infinity);
      const naturalEndSec = clip.start_frame / opts.fps + outSrcFrames / clipFps;
      const endSec = Math.max(naturalEndSec, adjust.endSec ?? -Infinity);
      pending.push({
        clip,
        plate: null,
        inputIdx,
        label: `v${inputIdx}`,
        startSec,
        endSec,
        naturalStartSec: clip.start_frame / opts.fps,
        clipFps,
        trackIndex,
        transition: adjust,
      });

      inputIdx++;
    }

    // D-226 — this track's dip-to-colour plates, emitted AFTER its own clips
    // (so a dip covers them) and before the next, higher-priority track's (so
    // it never covers a track above). No `-i`, no decode: a plate is a `color`
    // filter source. `clipFps` is the export's own rate — a generated layer has
    // no native one, same reading a text clip's own entry above takes.
    for (const plan of plans) {
      if (plan.transition.kind !== 'dip_to_color') continue;
      pending.push({
        clip: null,
        plate: plan,
        inputIdx: null,
        label: `p${pending.length}`,
        startSec: plan.startSec,
        endSec: plan.endSec,
        naturalStartSec: plan.startSec,
        clipFps: opts.fps,
        trackIndex,
        transition: emptyAdjust(),
      });
    }
  }

  // B-076 — the furthest NATURAL end across every clip, i.e. how long the
  // export will actually run (see the final `-t` below) — computed here,
  // BEFORE any freeze padding, since a frozen clip's own padding target IS
  // this number, not the other way around.
  //
  // D-197 — this MUST also account for genuine audio-track clips, not just
  // video's own `pending`: a timeline with audio tracks but NO video track
  // at all (or one where an audio-track clip runs past every video clip's
  // own end) previously computed `totalDurationSec = 0` here (an empty
  // `pending`), which then capped the WHOLE output — video AND audio — at
  // `-t 0`: a real, silently-broken zero-length export with "Output file
  // does not contain any stream", caught by this pass's own real-ffmpeg
  // tests. Counted unconditionally (even a clip `hasAudioOverrides` will
  // later exclude from the actual mix still occupies real timeline space
  // and must not truncate the export it's sitting on).
  const audioTrackEndSecs = timeline.tracks
    .filter((t) => t.kind === 'audio')
    .flatMap((t) => t.clips)
    .map((c) => {
      const clipFps = c.source_fps ?? opts.fps;
      return c.start_frame / opts.fps + outputSourceFrames(c, opts) / clipFps;
    });
  const totalDurationSec = [...pending.map((p) => p.endSec), ...audioTrackEndSecs].reduce(
    (max, end) => Math.max(max, end),
    0,
  );

  // Pass 2 — real filter chains, now that `totalDurationSec` is known.
  for (const p of pending) {
    // D-211 — a text clip has no per-clip chain to build (its `drawtext` node
    // is emitted inline in the paint loop below, on the composited stream),
    // and no `freezeOverrides` behaviour either: `tpad` holds a decoded
    // frame, and there is nothing decoded to hold. A title that should stay
    // up longer is simply a longer title.
    //
    // D-226 — a dip-to-colour plate takes the same "no input, no per-clip
    // chain here" branch, but it DOES have a filter chain of its own: a
    // `color` filter source, which (like `[base]`) is emitted as a standalone
    // step rather than reading a `[N:v]`.
    if (p.plate) {
      filterSteps.push(buildDipPlateChain(p.plate, p.label, opts));
      chains.push({
        label: p.label,
        clip: null,
        plate: p.plate,
        startSec: p.startSec,
        endSec: p.endSec,
        clipStartSec: p.naturalStartSec,
        clipFps: p.clipFps,
      });
      continue;
    }
    if (p.clip === null) continue; // only a plate has no clip, handled above
    if (p.inputIdx === null) {
      chains.push({
        label: p.label,
        clip: p.clip,
        plate: null,
        startSec: p.startSec,
        endSec: p.endSec,
        clipStartSec: p.naturalStartSec,
        clipFps: p.clipFps,
      });
      continue;
    }
    // D-188 — a clip flagged in `freezeOverrides` holds its own last frame
    // (via `tpad` inside `buildClipFilterChain`) for whatever's left between
    // its natural end and the overall export's real total length, and stays
    // COMPOSITED (this widened `enable=between()` window) for that whole
    // stretch — without both halves of this, either the held frame would
    // never actually get drawn (chain's own window still closes at the old,
    // shorter `endSec`), or it'd get drawn but decoding never produced a
    // frame to hold past the natural end (no `tpad`) and ffmpeg would error.
    // `Math.max(0, ...)` — a clip already at/past `totalDurationSec` (e.g.
    // it's the longest clip on the timeline, or the ONLY one) gets zero
    // padding and an unchanged `endSec`, never a negative-duration `tpad`.
    const freeze = opts.freezeOverrides?.[p.clip.id];
    const padSecs = freeze ? Math.max(0, totalDurationSec - p.endSec) : 0;
    const finalEndSec = freeze ? Math.max(p.endSec, totalDurationSec) : p.endSec;

    filterSteps.push(
      buildClipFilterChain(p.clip, p.inputIdx, p.label, opts, p.clipFps, padSecs, p.transition, {
        inputStartSec: p.startSec,
        clipStartSec: p.naturalStartSec,
      }),
    );
    chains.push({
      label: p.label,
      clip: p.clip,
      plate: null,
      startSec: p.startSec,
      endSec: finalEndSec,
      clipStartSec: p.naturalStartSec,
      clipFps: p.clipFps,
    });
  }

  const bg = `color=black:size=${opts.width}x${opts.height}:rate=${opts.fps}[base]`;
  filterSteps.push(bg);

  // D-229 — captions are drawn over the FINISHED picture, after every video
  // overlay, in subtitle-track order. Resolved up front because it decides
  // which node gets to be `[outv]`: with captions present the last overlay is
  // no longer the end of the video chain.
  const captions = captionsForExport(timeline, opts.fps);
  const captionSteps: string[] = [];

  let lastLabel = 'base';
  chains.forEach((chain, i) => {
    const outLabel =
      i === chains.length - 1 && captions.length === 0 ? 'outv' : `ov${i}`;
    // D-211 — a text clip paints with `drawtext` on the stream built so far,
    // at exactly the position in the chain its `overlay` would have taken, so
    // z-order needs no separate rule. A clip whose font could not be resolved
    // is skipped rather than compiled against a guessed path — the caller
    // (`compileEditorExportArgs`) has already refused the whole export via
    // `textClipsMissingFonts`, so this is the defensive second line only.
    //
    // D-226 — a dip-to-colour plate is a full-frame layer with no geometry of
    // its own (mirroring `chroma::edit`'s `plate_transform`, which pins the
    // identity for exactly this reason): a plain `overlay` at the origin,
    // gated to the transition's own window. Its alpha triangle is already
    // baked into its chain by `buildDipPlateChain`.
    if (chain.plate) {
      filterSteps.push(
        `[${lastLabel}][${chain.label}]overlay=x=0:y=0:` +
          `enable='between(t,${chain.startSec},${chain.endSec})'[${outLabel}]`,
      );
      lastLabel = outLabel;
      return;
    }
    if (chain.clip === null) return; // only a plate has no clip, handled above
    // D-230 — an ADJUSTMENT clip applies its correction to the stream built so
    // far, at exactly the position in the chain its `overlay` would have taken.
    // `lastLabel` at this point is precisely "every layer below this clip
    // composited", so "applies to everything beneath it, for its own span"
    // needs no scoping logic of its own — the same property the live-preview
    // compositor gets from its own back-to-front walk (`chroma::edit`'s
    // `Step::Adjust`), which is what makes the two engines agree structurally
    // rather than by two matching implementations.
    //
    // A correction that provably does nothing emits NO node at all, so adding
    // an adjustment clip and leaving it alone produces a byte-identical argv to
    // not having it — mirroring the preview's own skip.
    if (chain.clip.adjustment) {
      const ops = clipAdjustmentOps(chain.clip);
      if (ops) {
        filterSteps.push(
          ...buildAdjustmentSteps(ops, lastLabel, outLabel, chain.startSec, chain.endSec),
        );
        lastLabel = outLabel;
      }
      return;
    }
    if (chain.clip.text) {
      const fontFile = opts.fontFiles?.[chain.clip.text.font];
      if (fontFile) {
        filterSteps.push(
          buildTextDrawtextStep(
            chain.clip,
            lastLabel,
            outLabel,
            opts,
            chain.startSec,
            chain.endSec,
            chain.clipFps,
            fontFile,
          ),
        );
        lastLabel = outLabel;
      }
      return;
    }
    // B-075 — a keyframe's `frame` is source-frame-absolute (this clip's own
    // native rate), not `opts.fps` — same reasoning as above.
    const xExpr = positionExpr(chain.clip, 'position_x', chain.clipFps, chain.clipStartSec);
    const yExpr = positionExpr(chain.clip, 'position_y', chain.clipFps, chain.clipStartSec);
    // B-075 — ffmpeg's filtergraph syntax splits filter/option text on bare
    // `,`/`:` OUTSIDE quotes; a keyframed `if(between(t,a,b),...)` expression
    // is FULL of exactly those characters. `enable=` was already correctly
    // single-quoted; `x=`/`y=` were not, which — invisibly, since no unit
    // test here ever actually invokes ffmpeg, only string-compares the argv
    // — broke every real export of a clip with more than a trivial
    // one-keyframe position/scale animation (`ffmpeg`: "No option name near
    // 'if(lt(t'"). A plain static value (no keyframes) is just a bare number
    // with no special characters, so quoting it too is harmless.
    filterSteps.push(
      `[${lastLabel}][${chain.label}]overlay=x='${xExpr}*W':y='${yExpr}*H':` +
        `enable='between(t,${chain.startSec},${chain.endSec})'[${outLabel}]`,
    );
    lastLabel = outLabel;
  });

  // D-229 — now the captions, on top of everything the loop above built.
  //
  // The video stream is `-map`ped by whatever `lastLabel` ends up being (see
  // the `-map` below), so appending here needs no label surgery: each cue's
  // lines chain off the current end and become the new end. A cue whose font
  // could not be resolved, or whose text is empty, simply contributes no node
  // and leaves `lastLabel` alone — it cannot strand a dangling label.
  // (`compileEditorExportArgs` has already refused the whole export via
  // `captionClipsMissingFonts` for the font case, so that arm is the
  // defensive second line only.)
  captions.forEach((cap, ci) => {
    const fontFile = opts.fontFiles?.[cap.style.font];
    if (!fontFile) return;
    const steps = buildCaptionDrawtextSteps(
      cap.cue,
      cap.style,
      lastLabel,
      (li) => `cap${ci}_${li}`,
      opts,
      cap.startSec,
      cap.endSec,
      fontFile,
    );
    if (steps.length === 0) return;
    captionSteps.push(...steps);
    lastLabel = `cap${ci}_${steps.length - 1}`;
  });
  filterSteps.push(...captionSteps);

  // B-076 — `color=...[base]` (the black backdrop every clip overlays onto)
  // is an ffmpeg `lavfi` source with NO duration of its own — unlike a real
  // decoded video input, it never reaches EOF by itself. Every real clip's
  // own `-t` bounds ITS input, but nothing bounded the OUTPUT overall, so
  // the exported file's length was governed by the base layer alone: i.e.
  // never. Confirmed live: a real export ran for 10+ minutes of continuous
  // encoding (8.6MB and climbing for what should have been a few-second,
  // few-KB clip) before being killed by hand — this was true of every
  // export this whole module ever produced, immediately masked until now by
  // B-075's filtergraph parse error making every real run fail before it
  // could ever start rendering. `-t <furthest clip end>` on the OUTPUT
  // (after `-map`) is the standard, simplest fix — bounded by the real
  // content instead of a synthetic source that has no natural end. `0` for
  // an empty timeline (no clips at all) rather than an unbounded run.
  // (`totalDurationSec` is the same value computed above, before any D-188
  // freeze padding — a frozen clip's own `endSec` is clamped to exactly
  // this number, never past it, so re-deriving it from `chains` here would
  // just recompute the identical value.)

  // --------------------------------------------------------------------- //
  // D-197 — audio: embedded video-clip audio + every audio-track clip,
  // mixed down to at most one `-map`ped stream. See `timelineExportAudio.ts`
  // for the actual per-source math; this is purely the walk + assembly.
  // --------------------------------------------------------------------- //
  const audioRefs: AudioRef[] = [];
  let audioLabelSeq = 0;
  const duckCache = new Map<number, ReturnType<typeof resolveDuckForTrack>>();
  const duckForTrack = (idx: number) => {
    if (!duckCache.has(idx)) duckCache.set(idx, resolveDuckForTrack(timeline, idx, opts.fps));
    return duckCache.get(idx) ?? null;
  };

  // Embedded video-clip audio — reuses each clip's ALREADY-OPENED `-ss`/`-t`
  // input (no second `-i` for the same file/window), skips a clip whose
  // audio has been externalized to a linked clip (D-129) or whose source
  // isn't known to have audio at all (`hasAudioOverrides`, conservative
  // default `false` for a video clip — see that option's own doc). Its own
  // NATURAL end (`p.endSec`, pre-freeze) bounds it — freezing a clip's last
  // VIDEO frame has no audio analog, so a frozen clip's audio simply ends on
  // time rather than looping or holding silence past it.
  for (const p of pending) {
    // D-211 — a text clip has no input stream at all, so `[N:a]` would not
    // just be silent, it would be a filtergraph reference to nothing (a hard
    // ffmpeg failure). `resolveHasAudioOverrides` already resolves it to
    // `false`, so this is belt-and-braces against a caller-supplied override.
    if (p.inputIdx === null || p.clip === null) continue;
    if (p.clip.link_group) continue;
    if (!(opts.hasAudioOverrides?.[p.clip.id] ?? false)) continue;
    // D-235 — the SAME segments the picture's own `setpts` was built from,
    // so a ramped clip's sound is retimed by exactly the curve its picture is.
    const speedSegments = resolveSpeedSegments(p.clip, opts.speedOverrides?.[p.clip.id]);
    const idLabel = `au${audioLabelSeq++}`;
    // D-226 — **a video transition is a video transition, and the sound is not
    // part of it.** Premiere and Resolve both keep picture and audio
    // transitions as separate effects (Resolve's own Effects Library lists
    // "Audio Transitions" apart from "Video Transitions"), so a cross dissolve
    // must not silently crossfade the two clips' embedded audio as well.
    //
    // The transition widened this clip's ffmpeg INPUT into its handle media,
    // which widened its audio stream with it. Trimming that back here — to
    // exactly the clip's own `[source_start, +duration)` window, then
    // re-basing the timestamps — restores the audio this clip had before any
    // transition existed, and `naturalStartSec` (not the widened `startSec`)
    // puts it back at its own cut. An audio crossfade is a real, separate
    // feature and is tracked as such (roadmap item 27); the clip-level
    // `set_clip_fade` handles (D-147) already give a manual one.
    let srcRef = `[${p.inputIdx}:a]`;
    const headSecIn = p.transition.headSrcFrames / p.clipFps;
    if (p.transition.headSrcFrames > 0 || p.transition.tailSrcFrames > 0) {
      const label = `ht${idLabel}`;
      filterSteps.push(
        `${srcRef}atrim=start=${headSecIn}:end=${headSecIn + p.clip.duration / p.clipFps},` +
          `asetpts=PTS-STARTPTS[${label}]`,
      );
      srcRef = `[${label}]`;
    }
    const { steps, ref } = buildAudioSourceChain({
      srcRef,
      clip: p.clip,
      clipFps: p.clipFps,
      gain: 1, // D-057: a video track's own embedded audio stays hardcoded at unity
      speedSegments,
      startSec: p.naturalStartSec,
      duck: duckForTrack(p.trackIndex),
      idLabel,
    });
    filterSteps.push(...steps);
    audioRefs.push(ref);
  }

  // Genuine audio-track clips — each gets its own dedicated `-i` (continuing
  // the SAME `inputIdx` counter Pass 1 used, so every input index in the
  // final argv stays unique and in argv order). NOT filtered by `track.
  // hidden` — `resolve_audio_track_positions` (the live mixer's real
  // behavior) never checks it either; `hidden` is a picture-only concept.
  for (const track of timeline.tracks) {
    if (track.kind !== 'audio') continue;
    const trackIndex = timeline.tracks.indexOf(track);
    for (const clip of track.clips) {
      if (!(opts.hasAudioOverrides?.[clip.id] ?? true)) continue;
      const clipFps = clip.source_fps ?? opts.fps;
      inputs.push(
        '-ss',
        String(clip.source_start / clipFps),
        '-t',
        String(clip.duration / clipFps),
        '-i',
        clip.source_path,
      );
      const thisInputIdx = inputIdx++;
      const speedSegments = resolveSpeedSegments(clip, opts.speedOverrides?.[clip.id]);
      const startSec = clip.start_frame / opts.fps;
      const { steps, ref } = buildAudioSourceChain({
        srcRef: `[${thisInputIdx}:a]`,
        clip,
        clipFps,
        gain: track.gain ?? 1,
        speedSegments,
        startSec,
        duck: duckForTrack(trackIndex),
        idLabel: `au${audioLabelSeq++}`,
      });
      filterSteps.push(...steps);
      audioRefs.push(ref);
    }
  }

  // Final mix. Exactly one total audio-contributing clip bypasses `amix`/
  // `asoftclip` entirely — mirrors `chroma_media::audio::mix_sources`'s own
  // documented single-active-source bypass (Phase C, D-057), which is what
  // keeps the overwhelmingly common "just this one clip's own audio, no
  // separate tracks" case byte-simple. Two or more sum with `normalize=0`
  // (ffmpeg's own default divides by input count, which is NOT what a real
  // mixer does just because more tracks exist) then `asoftclip=type=tanh` —
  // the same "sum, then a soft saturating limiter" topology the roadmap's
  // own Phase C write-up describes for live playback, replicated with
  // ffmpeg's own real soft-clip filter rather than approximated.
  let audioMapArg: string | null = null;
  if (audioRefs.length === 1) {
    audioMapArg = audioRefMapArg(audioRefs[0]);
  } else if (audioRefs.length > 1) {
    const mixInputs = audioRefs.map(audioRefBracket).join('');
    filterSteps.push(`${mixInputs}amix=inputs=${audioRefs.length}:duration=longest:normalize=0[mixa]`);
    filterSteps.push(`[mixa]asoftclip=type=tanh[outa]`);
    audioMapArg = '[outa]';
  }

  const args = [
    ...inputs,
    '-filter_complex',
    filterSteps.join(';'),
    '-map',
    `[${lastLabel}]`,
  ];
  if (audioMapArg) args.push('-map', audioMapArg);
  args.push('-r', String(opts.fps), '-t', String(totalDurationSec), outPath);
  return args;
}
