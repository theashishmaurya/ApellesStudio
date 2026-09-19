/**
 * @apelles/editor — pure timeline → ffmpeg export compiler (Phase 2 of the
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
  isStillSource,
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
import {
  captionAnimationOf,
  captionWordColor,
  captionWords,
  isPerWordAnim,
  isSingleWordAnim,
} from './captionAnim';
import { captionMetricKey, type CaptionMetrics } from './captionMetrics';
import { buildAdjustmentSteps, clipAdjustmentOps } from './adjustment';
import { piecewiseLinearExpr, type ExprPoint } from './ffmpegExpr';
// D-236 — one definition of a clip's time remap, shared with the live
// preview's own `clipSourceFrameAt`/`Clip::source_frame_at`. See `speedRamp.ts`.
import {
  flatSpeedOf,
  hasReverseSegments,
  hasSpeedRamp,
  outputAtSourceFrame,
  outputSpanOfLeadingSource,
  outputSpanOfTrailingSource,
  rampOutputSourceFrames,
  rampSegmentSeconds,
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
 * The shortest signed arc, in degrees, from `from` to `to` — mirrors
 * `chroma::keyframes::lerp_value`'s own `rotation`-only rule byte-for-byte
 * (same `%`, same clamp into `(-180, 180]`) so a seam-crossing rotation
 * keyframe animates identically on both sides (B-108). JS's `%` already has
 * Rust's truncated-division sign behaviour for this range, so no extra
 * normalisation is needed to match it.
 */
function shortestArcDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/**
 * B-108 — re-express a `rotation` key sequence's values as one continuous,
 * UNWRAPPED running total, so the straight lines `keyframeExprAt` draws
 * between them sweep the shortest arc segment-by-segment, the same as
 * `lerp_value`'s own per-bracket rule.
 *
 * **Why a running total works, and why it never mismatches Rust's own
 * per-request (stateless) computation.** `lerp_value` always computes its arc
 * from that segment's own two *stored* key values, independent of any other
 * segment. Here, each key's new value is `previous unwrapped value +
 * shortestArcDelta(previous RAW value, this RAW value)` — by induction, that
 * running value stays congruent to the key's own raw number mod 360 at every
 * key (it only ever differs by a whole multiple of 360°). A whole-turn offset
 * changes no rendered pixel (rotation is periodic), so the two engines agree
 * exactly on the physical angle at every instant while this compiler gets a
 * single continuous piecewise-linear curve — no synthetic duplicate point at
 * a shared timestamp is needed to "snap back" to the raw number at each key,
 * which `piecewiseLinearExpr`'s point list has no way to express anyway.
 *
 * The very first key is never rewritten (there is no previous key to take an
 * arc from), so a `rotation` animation with a single key — or no seam at all —
 * produces byte-identical values to the pre-B-108 plain ramp.
 */
function unwrapRotationKeys<T extends { value: number }>(keyed: T[]): T[] {
  if (keyed.length < 2) return keyed;
  const out: T[] = [keyed[0]];
  for (let i = 1; i < keyed.length; i++) {
    const delta = shortestArcDelta(keyed[i - 1].value, keyed[i].value);
    out.push({ ...keyed[i], value: out[i - 1].value + delta });
  }
  return out;
}

/**
 * Build an ffmpeg filter expression (using `t`, ffmpeg's own per-frame time
 * in seconds) that piecewise-linearly interpolates `param` across
 * `keyframes`, exactly mirroring the semantics `apelles_timeline::edit::
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
 * keyframe reader in this codebase, e.g. `apelles-timeline`'s own parser).
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
 *
 * **B-108 — `rotation` takes the shortest arc, exactly like the live preview.**
 * `chroma::keyframes::lerp_value` (Rust) special-cases `"rotation"`: rather
 * than a plain numeric ramp from key to key, it normalises the delta between
 * two keys into `(-180, 180]` before interpolating, so `350° → 10°` moves
 * `+20°` forward through `0°` instead of `-340°` backwards through `180°`.
 * This compiler used to have no such rule — every param, rotation included,
 * got the plain `y0 + (y1-y0)*t` ramp — so the export took the 340°-long way
 * round on exactly that animation while the preview took the 20°-short way,
 * rendering the clip upside down mid-sweep where the preview showed it
 * upright. See `unwrapRotationKeys` below for how the fix is applied.
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
  const rawKeyed = keyframes
    .filter((k) => Object.prototype.hasOwnProperty.call(k.params, param))
    .map((k) => ({
      t: k.frame / fps,
      value: Number(k.params[param]),
      // Normalised exactly as `clipKeyframes.ts`'s own index does, so "linear"
      // and "no curve" are one case on both sides of the wire.
      ease: isIdentityEase(k.ease?.[param]) ? null : (k.ease?.[param] ?? null),
    }))
    .sort((a, b) => a.t - b.t);

  // B-108 — only `rotation` gets the shortest-arc treatment, matching
  // `lerp_value`'s own `key == "rotation"` guard exactly.
  const keyed = param === 'rotation' ? unwrapRotationKeys(rawKeyed) : rawKeyed;

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
        // of `apelles_types::EaseCurve::eval` they call. Only the straight
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
 *  same degrade `apelles_timeline::TextLayer::rgb` performs on the preview
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
 * runs. See `caption.ts`'s header and `apelles_timeline::caption`'s module doc.
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
  metrics?: CaptionMetrics,
): string[] {
  const lines = captionLines(cue.text);
  if (lines.length === 0) return [];
  // D-243 — an animated caption is drawn per WORD, not per line. Branching
  // here rather than inside the loop keeps D-229's static path byte-identical:
  // a caption with no animation compiles to exactly the filtergraph it
  // compiled to before this decision existed.
  const anim = captionAnimationOf(style);
  if (isPerWordAnim(anim.kind)) {
    return buildAnimatedCaptionSteps(
      lines,
      style,
      anim,
      inLabel,
      outLabelFor,
      opts,
      startSec,
      endSec,
      fontFile,
      metrics ?? {},
    );
  }
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

/** A number as a filtergraph literal — fixed to 4 decimals so a compiled argv
 *  is stable for a given timeline rather than carrying a float's full printed
 *  precision (the same reason `boxcolor`'s alpha is `toFixed(3)`). */
function num(v: number): string {
  return (Number.isFinite(v) ? v : 0).toFixed(4).replace(/\.?0+$/, '') || '0';
}

/** The ffmpeg expression for `easeOutCubic` over a word's own entrance —
 *  `1-pow(1-clip((t-t0)/e,0,1),3)`.
 *
 *  **The same closed-form polynomial `easeOutCubic` evaluates**, which is the
 *  entire reason that function is written out as a polynomial rather than
 *  pulled from a curve library: it has to be the same function in Rust, in
 *  TypeScript, and here as a string. A zero-length entrance degrades to the
 *  constant `1`, matching both mirrors' `enter <= 0` branch exactly. */
export function captionEnterExpr(t0: number, enterSecs: number): string {
  if (!Number.isFinite(enterSecs) || enterSecs <= 0) return '1';
  return `1-pow(1-clip((t-${num(t0)})/${num(enterSecs)}\\,0\\,1)\\,3)`;
}

/**
 * The `drawtext`/`drawbox` nodes for one ANIMATED caption cue (D-243) — one
 * chain per word, over the whole cue.
 *
 * **Why per word.** The static path hands a whole line to one `drawtext` and
 * lets ffmpeg's own advance decide its width. An animated caption cannot: a
 * word has to be independently faded, moved and recoloured, so each word is
 * its own node at an x computed HERE, from the backend's measured advances.
 * That is D-229's "make the layout ours" one level further down, and for the
 * identical reason — it is the only way `ab_glyph` and `drawtext` put a word
 * in the same place.
 *
 * **What is expression-driven and what is not.** `alpha`, `x` and `y` are real
 * per-frame `drawtext` expressions (verified against this machine's ffmpeg:
 * all three are declared `<string>` expression options). `fontcolor` is NOT,
 * so a word that changes colour is emitted as up to three nodes, each
 * `enable`d over the window of one phase — and phases that resolve to the SAME
 * colour are collapsed into one node, which is what keeps a long subtitle
 * track's filtergraph from growing three nodes per word for no visual reason.
 * `drawbox`'s colour is not an expression either, which is why the highlight
 * box is binary rather than swept (see `caption_anim`'s own doc).
 */
function buildAnimatedCaptionSteps(
  lines: string[],
  style: Required<CaptionStyle>,
  anim: ReturnType<typeof captionAnimationOf>,
  inLabel: string,
  outLabelFor: (nodeIndex: number) => string,
  opts: Pick<TimelineExportOptions, 'width' | 'height'>,
  startSec: number,
  endSec: number,
  fontFile: string,
  metrics: CaptionMetrics,
): string[] {
  const durSecs = Math.max(0, endSec - startSec);
  const words = captionWords(lines, durSecs);
  if (words.length === 0) return [];

  // `Slam` shows one word alone, so it lays out as a SINGLE line regardless of
  // how the cue is broken — the identical rule the preview applies.
  const singleWord = isSingleWordAnim(anim.kind);
  const layout = captionLayout(style, opts.width, opts.height, singleWord ? 1 : lines.length);
  const fontPx = layout.font_px;
  const advanceOf = (w: string): number =>
    metrics[captionMetricKey(style.font, fontPx, w)] ?? 0;
  const gapPx = Math.max(0, anim.word_gap) * fontPx;
  // `drawtext` draws a word's glyphs from its own line box top under
  // `y_align=font`, exactly as the static path does.
  const lineTopOf = (lineIndex: number): number =>
    layout.lines[Math.min(lineIndex, layout.lines.length - 1)].line_top;

  /** One word, placed — the export's mirror of the preview's `PlacedWord`. */
  const placed: Array<{ index: number; x: number; lineTop: number; advance: number }> = [];

  if (singleWord) {
    // Every word is centred on the anchor in turn, so each node's x needs no
    // cross-word measurement at all — `text_w` alone would do, but our own
    // advance is used so the two engines agree even when they disagree about
    // a glyph's last fractional pixel.
    const geom = layout.lines[layout.lines.length - 1];
    words.forEach((w, i) => {
      const advance = advanceOf(w.text);
      const x =
        style.align === 'left'
          ? geom.x_anchor
          : style.align === 'right'
            ? geom.x_anchor - advance
            : geom.x_anchor - advance / 2;
      placed.push({ index: i, x, lineTop: geom.line_top, advance });
    });
  } else {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const onLine = words
        .map((w, i) => ({ w, i }))
        .filter(({ w }) => w.line === lineIndex);
      if (onLine.length === 0) continue;
      const total =
        onLine.reduce((n, { w }) => n + advanceOf(w.text), 0) + gapPx * (onLine.length - 1);
      const anchor = layout.lines[lineIndex].x_anchor;
      let cursor =
        style.align === 'left' ? anchor : style.align === 'right' ? anchor - total : anchor - total / 2;
      for (const { w, i } of onLine) {
        const advance = advanceOf(w.text);
        placed.push({ index: i, x: cursor, lineTop: lineTopOf(lineIndex), advance });
        cursor += advance + gapPx;
      }
    }
  }

  const steps: string[] = [];
  let last = inLabel;
  let node = 0;
  const push = (filter: string) => {
    const out = outLabelFor(node);
    steps.push(`[${last}]${filter}[${out}]`);
    last = out;
    node += 1;
  };

  // Pass 1 — the highlight box behind the active word, under every glyph, for
  // the same reason the preview paints its boxes first.
  if (anim.active_box_color) {
    const padX = Math.max(0, anim.active_box_pad_x) * fontPx;
    const padY = Math.max(0, anim.active_box_pad_y) * fontPx;
    // The box spans the font's own line box, whose height `drawtext` derives
    // from the face under `y_align=font`. `captionLayout` has no font metric in
    // it by design, so the height used here is the same `line_step`-free
    // quantity the preview computes from `ascent`/`line_gap`: approximated for
    // the box alone as the font size plus both paddings, which is what makes
    // the two boxes the same rectangle for the catalogue's faces.
    const boxH = fontPx + padY * 2;
    const alpha = clampUnit(anim.active_box_opacity);
    for (const p of placed) {
      const w = words[p.index];
      const t0 = startSec + w.start;
      const t1 = startSec + w.end;
      push(
        `drawbox=x=${Math.round(p.x - padX)}:y=${Math.round(p.lineTop - padY)}:` +
          `w=${Math.round(p.advance + padX * 2)}:h=${Math.round(boxH)}:` +
          `color=${ffmpegColorLiteral(anim.active_box_color)}@${alpha.toFixed(3)}:t=fill:` +
          `enable='between(t,${num(t0)},${num(t1)})'`,
      );
    }
  }

  // Pass 2 — the words themselves.
  for (const p of placed) {
    const w = words[p.index];
    const t0 = startSec + w.start;
    const t1 = startSec + w.end;
    const enterExpr = captionEnterExpr(t0, anim.enter_secs);

    // The window this word is on screen for, and how it moves while it is.
    let visFrom: number;
    let visTo: number;
    let alphaExpr: string;
    let xExpr: string;
    let yExpr: string;
    if (anim.kind === 'slam') {
      visFrom = t0;
      visTo = t1;
      alphaExpr = enterExpr;
      // dx = side * (1 - entered) * 0.6, in fractions of the font size.
      const side = p.index % 2 === 0 ? -1 : 1;
      xExpr = `${num(p.x)}+(${side})*(1-(${enterExpr}))*0.6*${fontPx}`;
      yExpr = `${p.lineTop}`;
    } else if (anim.kind === 'build') {
      visFrom = t0;
      visTo = endSec;
      alphaExpr = enterExpr;
      xExpr = `${num(p.x)}`;
      // dy = (1 - entered) * enter_rise, positive is DOWN.
      yExpr = `${num(p.lineTop)}+(1-(${enterExpr}))*${num(anim.enter_rise)}*${fontPx}`;
    } else {
      // Highlight / karaoke: the whole line is up for the whole cue, unmoved.
      visFrom = startSec;
      visTo = endSec;
      alphaExpr = '1';
      xExpr = `${num(p.x)}`;
      yExpr = `${p.lineTop}`;
    }

    // The colour phases this word actually passes through, as [from, to,
    // colour] windows clipped to the word's visible span — then collapsed
    // wherever two adjacent phases resolve to the same colour, so a preset
    // that recolours nothing emits ONE node per word rather than three.
    const phases: Array<{ from: number; to: number; color: string }> = [
      { from: visFrom, to: Math.min(t0, visTo), color: captionWordColor('upcoming', anim, style.color) },
      {
        from: Math.max(visFrom, t0),
        to: Math.min(t1, visTo),
        color: captionWordColor('active', anim, style.color),
      },
      {
        from: Math.max(visFrom, t1),
        to: visTo,
        color: captionWordColor('spoken', anim, style.color),
      },
    ].filter((p2) => p2.to > p2.from);
    const merged: Array<{ from: number; to: number; color: string }> = [];
    for (const ph of phases) {
      const prev = merged[merged.length - 1];
      if (prev && prev.color === ph.color && Math.abs(prev.to - ph.from) < 1e-9) prev.to = ph.to;
      else merged.push({ ...ph });
    }

    for (const ph of merged) {
      const optsList = [
        `fontfile=${quoteFiltergraphValue(fontFile)}`,
        `text=${quoteFiltergraphValue(w.text)}`,
        `fontcolor=${ffmpegColorLiteral(ph.color)}`,
        `fontsize=${fontPx}`,
        'expansion=none',
        'y_align=font',
        `y='${yExpr}'`,
        `x='${xExpr}'`,
        `alpha='${alphaExpr}'`,
        `enable='between(t,${num(ph.from)},${num(ph.to)})'`,
      ];
      push(`drawtext=${optsList.join(':')}`);
    }
  }

  return steps;
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

/** D-243 — every animated caption on `timeline` with a word this export has no
 *  measured advance for, so the caller can refuse with a real reason instead
 *  of compiling a line whose words all stack at x=0.
 *
 *  The animated counterpart of `captionClipsMissingFonts`, and refused for the
 *  same reason that one is: an export that silently disagrees with the preview
 *  is the exact defect class this repo keeps closing.
 *
 *  Static captions are never listed — they carry no per-word layout and ffmpeg
 *  measures them itself. */
export function captionClipsMissingMetrics(
  timeline: Timeline,
  metrics: CaptionMetrics | undefined,
  fps: number,
  width: number,
  height: number,
): Array<{ clipId: string; word: string }> {
  const missing: Array<{ clipId: string; word: string }> = [];
  for (const c of captionsForExport(timeline, fps)) {
    const anim = captionAnimationOf(c.style);
    if (!isPerWordAnim(anim.kind)) continue;
    const lines = captionLines(c.cue.text);
    if (lines.length === 0) continue;
    const layout = captionLayout(
      c.style,
      width,
      height,
      isSingleWordAnim(anim.kind) ? 1 : lines.length,
    );
    for (const w of captionWords(lines, Math.max(0, c.endSec - c.startSec))) {
      if (metrics?.[captionMetricKey(c.style.font, layout.font_px, w.text)] === undefined) {
        missing.push({ clipId: c.clip.id, word: w.text });
      }
    }
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
   *  overlay's width from `scale` (B-208/D-353: `scale` × the clip's own
   *  native footprint — see `sourceFootprints` below) and lets ffmpeg compute
   *  its height from the clip's own real (post-crop) aspect ratio — correct,
   *  undistorted, for a "full width, natural height" layout (e.g. two clips
   *  stacked in one canvas, each letterboxed within its half). `'stretch'`
   *  is the pre-B-074 behavior: force BOTH dimensions from `scale` that same
   *  way, so the box keeps the UNCROPPED source's own shape whatever the crop
   *  did to the real picture, rather than following its post-crop aspect —
   *  correct for a deliberate distort effect, or a plain same-aspect
   *  picture-in-picture bubble where that was already true anyway, never
   *  correct for fitting arbitrary source footage into a differently-shaped
   *  region.
   *
   *  **B-208/D-353 moved `'stretch'` too, deliberately.** It could have been
   *  left on the old canvas-fraction reading — it is export-only and the
   *  preview has no equivalent — but then `scale` would have meant two
   *  different things depending on an unrelated export flag. Both modes now
   *  read `scale` as a native-footprint multiple and this option decides only
   *  where the HEIGHT comes from. For a source shaped like the canvas (this
   *  mode's own stated main use) the box is unchanged.
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
  /**
   * **B-208/D-353 — each clip's own SOURCE footprint, as a fraction of the
   * OUTPUT COMPOSITION**, keyed by `Clip.id`. `{width: 0.5, height: 0.5}` is
   * "this clip's source is half the composition's width and half its height".
   * Exactly `chroma::edit::ClipGeometry`'s `naturalWidth`/`naturalHeight` —
   * the same normalised footprint the on-canvas transform overlay already
   * reads — not raw source pixels, so the SAME map is correct whether this
   * export is compiled at the composition's own size or at any multiple of it.
   *
   * **What it is for.** `scale` is a multiplier of the clip's own NATIVE
   * footprint (see `Clip.scale`'s own doc, and `ClipTransform::effective_size`
   * in `app/src-tauri/src/chroma/edit.rs`, which is what the live preview and
   * the D-350 compositor render path both compute). This compiler read it as a
   * fraction of the output canvas instead, so `scale` meant two different
   * things in the two engines and they only agreed when a clip's source
   * resolution happened to equal the composition's — B-208. D-353 settled the
   * direction: the EXPORT learns the preview's reading, because flipping the
   * preview would silently resize every clip in every existing project that
   * carries a non-default `scale`.
   *
   * **Why the caller supplies it and not this module.** Same
   * "the-compiler-stays-pure / the-caller-supplies-what-only-it-can-know"
   * split as `hasAudioOverrides` and `audioChannelsOverrides` above: this
   * module is pure and does no I/O, and a source's resolution can only come
   * from a probe. It is already probed — `editor_import_media` stores it on
   * the media-pool item (`MediaVideoInfo.width`/`height`, or
   * `MediaImageInfo`'s for a still) — so nothing new is measured at export
   * time; `editorExport.ts`'s `resolveSourceFootprints` just divides that by
   * the composition size.
   *
   * **An absent entry means "unknown", and keeps the pre-B-208 reading**
   * (footprint `1.0` on both axes, i.e. `scale` as a plain canvas fraction) —
   * the `audioChannelsOverrides` sentinel discipline, for the same reason: a
   * guessed footprint is a confidently wrong box. That fallback is also
   * byte-identical to this compiler's pre-fix output, so a clip with no pooled
   * media (and every test that passes no map at all) compiles exactly as
   * before. A clip carrying `box_width`/`box_height` never consults this at
   * all — those are canvas fractions in BOTH engines by construction (D-193)
   * and have no divergence to fix.
   */
  sourceFootprints?: Record<string, { width: number; height: number }>;
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
  /** B-101/D-269 — each clip's source **audio channel count**, keyed by
   *  `Clip.id`, resolved by the caller from the media pool's own probed
   *  `MediaVideoInfo.audioChannels` (the same "the compiler stays pure, the
   *  caller supplies what only it can know" split `hasAudioOverrides` above
   *  established).
   *
   *  Read for exactly one decision, and only on a clip that is actually
   *  panned: **is this source mono?** A mono source has to be adapted to
   *  stereo before it can be panned, and the two adaptations that exist are
   *  3.01 dB apart — duplicate-at-unity (what the live mixer's
   *  `apelles_media::audio::adapt_channels` does, and what this codebase's
   *  0 dB-centre pan law assumes) versus libswresample's power-preserving
   *  matrix (each channel at 1/√2, what a bare `aformat=channel_layouts=stereo`
   *  gets you). Exporting with the second while the preview plays the first is
   *  B-101; see D-269 for why the live mixer is the source of truth.
   *
   *  Absent/unset for a clip means **unknown**, not mono: the pre-B-101
   *  `aformat` upmix is kept rather than guessing a channel count, exactly as
   *  `MediaVideoInfo.audioChannels`' own sentinel requires. Stereo and
   *  multichannel sources take the same `aformat` path they always did, so
   *  this option changes nothing for them. */
  audioChannelsOverrides?: Record<string, number>;
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
  /** D-243 — the measured advance width of every word of every ANIMATED
   *  caption on the timeline, keyed by `captionMetricKey`.
   *
   *  The same split as `fontFiles` directly above, for the same reason: an
   *  animated caption positions each word itself (it is the only way the
   *  `ab_glyph` preview and ffmpeg put a word in the same place), a word's x
   *  depends on the advances before it, and an advance is a glyph measurement
   *  only the backend can make. `captionMetrics.ts` warms these; this compiler
   *  only reads them.
   *
   *  A word with no measurement here compiles at advance `0`, which stacks the
   *  line's words on top of each other — visible, not subtle. That is why
   *  `compileEditorExportArgs` refuses the export up front via
   *  `captionClipsMissingMetrics` rather than relying on this fallback; the
   *  fallback exists only so a missing measurement cannot throw mid-compile.
   *  Unused by a static (D-229) caption, which ffmpeg measures itself. */
  captionMetrics?: CaptionMetrics;
  /** D-256 — the absolute path of the baked `.cube` carrying each clip's
   *  **Colorist grade**, keyed by `Clip.id`.
   *
   *  The same "the compiler stays pure, the caller supplies what only it can
   *  know" split as `fontFiles` / `captionMetrics` above, and for a stronger
   *  version of their reason: the grade is applied by RapidRAW's wgpu shader
   *  and there is no CPU implementation of it anywhere — so the *only* form
   *  this compiler could ever consume it in is a baked lattice. The backend
   *  (`chroma::grade_lut`) runs an identity lattice through that shader once
   *  and writes it as a `.cube`; `gradeLuts.ts` warms the paths; this compiler
   *  emits one `lut3d` node per entry.
   *
   *  **An entry exists ONLY for a clip with a real, non-identity grade.** A
   *  clip that was never graded, or whose grade was reset, has none — so an
   *  ungraded timeline compiles to byte-identically the argv it compiled to
   *  before D-256, exactly as the live preview stays byte-identical for it.
   *  This is the same "an untouched effect emits nothing" property D-230's
   *  adjustment clip already has in both engines.
   *
   *  A clip that HAS a grade but whose bake failed never reaches here as a
   *  silent omission: `compileEditorExportArgs` refuses the whole export, for
   *  the reason a missing font refuses it — shipping a file that quietly
   *  disagrees with the preview is the defect this repo keeps closing. */
  gradeLutPaths?: Record<string, string>;
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
 * `apelles_timeline::Transition::progress_at`'s own `(pos - start) / duration`.
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
    // D-236 — a clip's OWN speed ramp disqualifies a transition for exactly
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
 * `apelles_timeline::Transition::dip_alpha_at` computes — up to fully opaque at
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
 * D-236 — how many of `clip`'s own source-frame units of OUTPUT it produces
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
 * `apelles_timeline::Clip::output_source_frames`), which is the same sum over
 * the same segments — that shared definition is what makes a ramped clip
 * occupy the same number of timeline frames in the app as it does in the file.
 */
function outputSourceFrames(clip: Clip, opts: TimelineExportOptions): number {
  return rampOutputSourceFrames(resolveSpeedSegments(clip, opts.speedOverrides?.[clip.id]));
}

/**
 * **How long this export actually runs**, in seconds — the furthest NATURAL end
 * across every clip on the timeline, before any D-188 freeze padding (a frozen
 * clip's padding target IS this number, so it can never extend it).
 *
 * This is what `buildExportFfmpegArgs` puts in its output `-t` (B-076: the
 * `color=…[base]` backdrop is an endless `lavfi` source, so without it the
 * exported file has no natural end at all) and what
 * `timelinePipeExport.ts`'s `buildPipeExportPlan` derives its frame count from.
 * **One definition, deliberately** (D-350): two export paths that disagreed
 * about an export's own length by a rounding would produce two files of
 * different durations from one document, which is precisely the class of silent
 * preview/export divergence this project keeps closing.
 *
 * Counts:
 * - every visible video track's clips, at their own output length
 *   (`outputSourceFrames`, i.e. a speed ramp's real footprint), placed at
 *   `start_frame`;
 * - every transition plan's own window end (D-226) — which covers both a
 *   dip-to-colour PLATE, a generated layer with no clip of its own, and an
 *   outgoing clip whose composited window a dissolve widened past its media;
 * - every audio track's clips, unconditionally (D-197). A timeline with audio
 *   tracks and no video track previously computed `0` here, which capped the
 *   whole output at `-t 0` — a real, silently zero-length export. Even a clip
 *   `hasAudioOverrides` will later exclude from the mix still occupies real
 *   timeline space and must not truncate the export it sits on.
 */
export function exportTotalDurationSec(timeline: Timeline, opts: TimelineExportOptions): number {
  let max = 0;
  const naturalEnd = (clip: Clip): number => {
    const clipFps = clip.source_fps ?? opts.fps;
    return clip.start_frame / opts.fps + outputSourceFrames(clip, opts) / clipFps;
  };
  for (const track of timeline.tracks) {
    if (track.kind === 'video' && !track.hidden) {
      for (const clip of track.clips) max = Math.max(max, naturalEnd(clip));
      for (const plan of transitionPlansFor(track, opts)) max = Math.max(max, plan.endSec);
    } else if (track.kind === 'audio') {
      for (const clip of track.clips) max = Math.max(max, naturalEnd(clip));
    }
  }
  return max;
}

/**
 * D-241 — the PICTURE half of reverse speed: one `trim`(+`reverse`)+`setpts`
 * branch per resolved run, spliced back together with `concat`.
 *
 * **Why a different filtergraph shape rather than a different expression.**
 * Every other speed case this compiler handles is a `setpts` slope, because
 * `setpts` relabels the timestamp of a frame the decoder has already handed
 * over *in decode order*. A negative slope therefore emits descending
 * timestamps over frames that are still in forward order — the encoder drops
 * or reorders them, and the picture never actually runs backwards. Reversing
 * frames is a buffering operation, and ffmpeg spells it `reverse`: hold the
 * window, emit it last-to-first. So reverse is structurally the audio side's
 * `asplit`/`atrim`/`concat` construction (`buildRampedAtempoSteps`), not the
 * picture side's expression — which is why this reads like that function and
 * not like `rampSetptsSecondsExpr`.
 *
 * **The memory question, which is the real constraint.** `reverse` buffers
 * every frame in its window as raw video. Two things bound that here, and both
 * are load-bearing:
 *
 * 1. The clip's own input is already opened `-ss`/`-t` to exactly its trim
 *    window (see `buildExportFfmpegArgs`), so `reverse` can never see the rest
 *    of the source file — the pathological case is a 4-second clip out of a
 *    two-hour master, and that master is never buffered.
 * 2. Each branch `trim`s to ONE run before reversing, so a ramp that reverses
 *    only its middle second buffers only that second. A branch whose run plays
 *    forwards gets no `reverse` node at all and buffers nothing.
 *
 * What remains is genuinely required: a fully-reversed clip buffers itself,
 * which is what "reverse" costs in every NLE. `splitLabels` fan the SAME
 * decoded stream out to the branches (`split`, not N `-i`s) so the file is
 * decoded once regardless of how many runs the ramp has.
 *
 * Each branch re-bases with `setpts=PTS-STARTPTS` because `concat` requires
 * its inputs to start at zero, and divides by `|speed|` because a reversed run
 * is exactly as long as the same range played forwards — the sign has already
 * done its whole job by selecting `reverse`.
 *
 * Returns the steps plus the label the joined result lands in. The caller
 * splices the B-103 placement `setpts` on afterwards, so everything downstream
 * still runs on one timeline-seconds clock.
 */
export function buildReversibleRampSteps(
  srcRef: string,
  segments: ReadonlyArray<{ startSec: number; endSec: number; speed: number }>,
  idLabel: string,
): { steps: string[]; label: string } {
  const steps: string[] = [];
  const branch = (seg: { startSec: number; endSec: number; speed: number }, inRef: string, out: string): string => {
    const parts = [`${inRef}trim=start=${seg.startSec}:end=${seg.endSec}`];
    if (seg.speed < 0) parts.push('reverse');
    const magnitude = Math.abs(seg.speed);
    parts.push(magnitude !== 1 ? `setpts=(PTS-STARTPTS)/${magnitude}` : 'setpts=PTS-STARTPTS');
    return `${parts.join(',')}[${out}]`;
  };

  // A one-run reverse (the common case — "play this clip backwards") needs no
  // `split` and no `concat`: those exist only to rejoin runs, and there is
  // nothing to rejoin. Emitting them anyway would work, but it would put a
  // `concat=n=1` in every reversed export's filtergraph for no reason.
  if (segments.length === 1) {
    const out = `rv${idLabel}`;
    steps.push(branch(segments[0], srcRef, out));
    return { steps, label: `[${out}]` };
  }

  const splitLabels = segments.map((_, i) => `vs${idLabel}_${i}`);
  steps.push(`${srcRef}split=${segments.length}${splitLabels.map((l) => `[${l}]`).join('')}`);
  const partLabels: string[] = [];
  segments.forEach((seg, i) => {
    const part = `vp${idLabel}_${i}`;
    steps.push(branch(seg, `[${splitLabels[i]}]`, part));
    partLabels.push(part);
  });
  const out = `vc${idLabel}`;
  steps.push(`${partLabels.map((l) => `[${l}]`).join('')}concat=n=${segments.length}:v=1:a=0[${out}]`);
  return { steps, label: `[${out}]` };
}

/** B-208/D-353 — the footprint of a clip whose source resolution IS the
 *  composition's, on either axis: the identity, and the value every clip the
 *  caller could not resolve a real footprint for falls back to. Named because
 *  the compiler also branches on it to keep emitting the pre-B-208 argv
 *  verbatim in that case (see `buildClipFilterChain`'s `widthExpr`). */
const FULL_FRAME_FOOTPRINT = 1;

/** B-208/D-353 — `clip`'s SOURCE footprint as a fraction of the output
 *  composition, per `TimelineExportOptions.sourceFootprints`.
 *
 *  Absent, non-finite or non-positive on an axis ⇒ [`FULL_FRAME_FOOTPRINT`]
 *  for that axis. A missing entry is the honest "this clip's source was never
 *  probed" case (an offline pool item, a text/adjustment clip with no media at
 *  all) and the fallback is exactly this compiler's pre-B-208 behaviour; the
 *  non-finite guards are ordinary defensiveness about a number that arrives
 *  from a division the caller performed. */
function sourceFootprintOf(
  clip: Clip,
  opts: TimelineExportOptions,
): { width: number; height: number } {
  const f = opts.sourceFootprints?.[clip.id];
  const axis = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : FULL_FRAME_FOOTPRINT;
  return { width: axis(f?.width), height: axis(f?.height) };
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
  // D-236 — the same `setpts` node now also carries a variable-speed RAMP,
  // because a ramp is nothing but a non-constant version of the `PTS/speed`
  // term that was already here. `rampSetptsSecondsExpr` returns `null` for a
  // flat ramp, in which case the pre-D-236 `PTS/<speed>` form is emitted
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
  if (hasReverseSegments(speedSegments)) {
    // D-241 — at least one run plays backwards, which no `setpts` expression
    // can do (see `buildReversibleRampSteps`). The retime becomes a
    // `trim`/`reverse`/`concat` block whose output already starts at zero and
    // already has the right length, and the B-103 placement shift is then
    // applied to THAT as its own node — so downstream this chain is in
    // timeline seconds exactly as it is on every other path, and every filter
    // after this point is untouched by reverse.
    const built = buildReversibleRampSteps(src, rampSegmentSeconds(speedSegments, clipFps), label);
    steps.push(...built.steps);
    src = built.label;
    if (placement.inputStartSec !== 0) {
      steps.push(`${src}setpts=PTS+${placement.inputStartSec}/TB[s${label}]`);
      src = `[s${label}]`;
    }
  } else if (rampExpr !== null) {
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

  // D-256 — **this clip's Colorist grade**, as the baked lattice `lut3d`
  // applies. See `TimelineExportOptions.gradeLutPaths`.
  //
  // **Here in the chain, and here specifically.** The live preview applies the
  // very same lattice to this clip's decoded pixels *before* any geometry
  // (`chroma::edit`'s `composite_video_frame`), so this node goes before
  // `crop`/`scale` too. A 3D LUT is per-pixel, so it commutes with `crop`
  // exactly and only the resample is order-sensitive — both engines now
  // resample after, which is what makes the two agree on order as well as on
  // maths. It sits after `setpts` only because `setpts` touches timestamps and
  // not a single pixel.
  //
  // **`interp=trilinear`, explicitly, and NOT ffmpeg's default.** vf_lut3d
  // defaults to `tetrahedral`, which is the more accurate interpolation — and
  // therefore the wrong one here, because the preview's own sampler
  // (`apelles_types::Lut3d::sample_trilinear`) is trilinear. Matching the other
  // engine beats being marginally better than it; that is the same call D-230
  // made when it quantised the preview's intermediate to 8 bits purely because
  // ffmpeg's two filters do.
  //
  // A clip with no entry emits nothing at all — see the option's own doc.
  const gradeLut = opts.gradeLutPaths?.[clip.id];
  if (gradeLut) {
    steps.push(
      `${src}lut3d=file=${quoteFiltergraphValue(gradeLut)}:interp=trilinear[g${label}]`,
    );
    src = `[g${label}]`;
  }

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
  // once the caller has stated the width explicitly. Falls back to `scale`'s
  // own formula when absent, so an existing clip (or one that only sets
  // `scale`) keeps going through the branch below.
  // B-208/D-353 — `scale` is a multiplier of the clip's own NATIVE footprint,
  // which is what `ClipTransform::effective_size` (the live preview and the
  // D-350 compositor render path) has always computed; this compiler used to
  // read it as a plain fraction of the output canvas. `sourceFootprints`
  // carries that footprint in, already normalised against the composition, so
  // the two engines finally agree on a clip whose source resolution is not the
  // composition's. See the option's own doc for the full "why".
  const footprint = sourceFootprintOf(clip, opts);
  const widthExpr =
    clip.box_width != null
      ? `${opts.width}*${clip.box_width}`
      : footprint.width === FULL_FRAME_FOOTPRINT
        ? // The unknown/source-is-the-composition case, spelled EXACTLY as it
          // was before B-208 rather than as `…*1*(…)` — this is the argv the
          // committed `export-parity.json` fixture and every existing test
          // assert on byte for byte.
          `${opts.width}*(${scaleExpr})`
        : `${opts.width}*${footprint.width}*(${scaleExpr})`;
  // B-074 — see `TimelineExportOptions.fitOverrides`'s own doc for the full
  // "why": `'fit'` (default) sizes WIDTH from the canvas and lets ffmpeg's
  // `-2` compute height from the clip's real post-crop aspect ratio;
  // `'stretch'` keeps the pre-B-074 behavior of forcing both dimensions to
  // canvas-relative fractions (always canvas-shaped, any `scale`).
  // `position_y` always just places the resulting box's top-left corner
  // (ffmpeg's own `overlay` convention — and, since D-338, the live
  // preview's too; B-201 is the six days the two disagreed about this) — so
  // the CALLER computes where to put it, e.g. centering a
  // shorter-than-its-slot 'fit' box within one canvas-half using the clip's
  // own known aspect ratio from `editor_import_media`'s probe result.
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
  // **D-193:** `box_width`/`box_height` are a fraction of the OUTPUT CANVAS
  // in both this compiler and the Rust live-preview compositor
  // (`chroma::edit::composite_layer_onto`) — a genuinely NEW field that never
  // had a Rust/TS parity gap at all, which is why this pair stayed correct
  // through the whole of B-208. `scale` itself, whose meaning depends on the
  // clip's own SOURCE resolution, DID have one until D-353 closed it: this
  // module is still pure and still probes nothing, and now reads that
  // resolution from `sourceFootprints`, which the caller fills from the media
  // pool's already-probed dimensions. See D-193's decision entry for the full
  // comparison and D-353's for why the export moved to the preview's reading
  // rather than the other way round.
  const fitMode = opts.fitOverrides?.[clip.id] ?? 'fit';
  const heightExpr =
    clip.box_height != null
      ? `${opts.height}*${clip.box_height}`
      : fitMode === 'stretch'
        ? // B-208/D-353 — the same native-footprint reading as `widthExpr`
          // above, on the other axis. `'fit'` (the default, `-2`) needs no
          // footprint at all: ffmpeg derives the height from the already-
          // corrected width and the input's own post-crop aspect ratio, which
          // is precisely what `effective_size` derives it from too.
          footprint.height === FULL_FRAME_FOOTPRINT
          ? `${opts.height}*(${scaleExpr})`
          : `${opts.height}*${footprint.height}*(${scaleExpr})`
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
  // B-112 / D-236 — every one of the three is a POST-retime output second,
  // obtained through the ramp's own forward map. `lenSec` always was (it
  // divided by the flat speed), but the two fade windows were NOT: they were
  // `frames / clipFps` with no speed division at all, so on a clip carrying a
  // `speedOverrides` entry the picture's fade ran `speed`× longer than both
  // its own clip length and the very same fade on that clip's AUDIO, which
  // `buildAudioSourceChain` has always divided correctly. Routing all three
  // through one map fixes that flat-speed bug and makes the ramped case right
  // by construction, rather than adding a second way to be wrong.
  //
  // D-241 — all three are now asked in PLAYBACK order
  // (`rampOutputSourceFrames` / `outputSpanOf{Leading,Trailing}Source`) rather
  // than by mapping a source endpoint forward. For every forward ramp that is
  // algebraically the same expression B-112 wrote and returns the same
  // numbers; for a REVERSED run it is the difference between a fade at the
  // head of what the viewer sees and a fade at the tail — and between a real
  // `lenSec` and a zero one. See `outputSpanOfLeadingSource`.
  const lenSec = rampOutputSourceFrames(speedSegments) / clipFps;
  const fadeExpr = fadeGainExpr(
    lenSec,
    outputSpanOfLeadingSource(speedSegments, clip.fade_in_frames ?? 0) / clipFps,
    outputSpanOfTrailingSource(speedSegments, clip.fade_out_frames ?? 0) / clipFps,
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

  // D-344 — rounded corners, static AND keyframed, in exactly `scaleExpr`'s
  // own identity-when-default shape: a clip with neither a static radius nor a
  // `corner_radius` keyframe emits no node at all, so every pre-D-344 clip
  // compiles byte-identically. `bigTVar` because the node is a `geq`.
  const cornerRadius = clip.corner_radius ?? 0;
  const hasCornerRadiusKeyframes = hasKeyframesFor(clip, 'corner_radius');
  const cornerRadiusExpr = hasCornerRadiusKeyframes
    ? keyframeExprAt(rebaseKeyframesToClipInput(clip), 'corner_radius', cornerRadius, clipFps, bigTVar)
    : String(cornerRadius);
  const needsCornerRadius = hasCornerRadiusKeyframes || cornerRadius > 0;

  // Ordered chain from here: scale -> [format+corner+rotate+alpha, if any is
  // real] -> [tpad, if freezing]. Each step's OUTPUT label is `label` itself
  // only if it's the LAST one that actually runs — everything before that
  // gets its own tagged intermediate label. This is what keeps a plain clip
  // (no rotation, no opacity/fade, no freeze — still most clips) emitting
  // the exact same single `scale=...[label]` line as before B-095.
  type Step = (inLabel: string) => string;
  const after: { tag: string; build: Step }[] = [];
  if (needsRotation || needsAlpha || needsCornerRadius || dissolveInSec !== null) {
    // `format=rgba` first: a plain decoded video frame (yuv420p, no alpha
    // plane) makes `rotate`'s transparent `fillcolor`, `geq`'s alpha
    // read/write and (D-226) `fade`'s own `alpha=1` all silently no-op.
    // Needed for any one of the three alone — and (D-344) for the corner-radius
    // mask, which is a fourth alpha writer with the identical requirement.
    after.push({ tag: 'fmt', build: (inLabel) => `[${inLabel}]format=rgba` });
  }
  // D-344 — the corner-radius mask, **after `scale` and before `rotate`**, and
  // that position is the whole of its definition rather than a convenience.
  // Rounding is a property of the layer's PLACEMENT BOX, so it has to be
  // applied once the box's real output size is known (which after `scale` is
  // simply `geq`'s own `W`/`H`) and while the box is still axis-aligned — so a
  // rotated clip's rounded corners rotate with it, the only reading of "this
  // clip has rounded corners" that survives a rotation. `chroma::edit::
  // composite_layer_onto` puts its own mask at exactly the matching point for
  // the same reasons; putting this one after `rotate` instead would give the
  // export axis-aligned rounding on a rotated clip while the preview showed
  // rotated rounding — precisely the two-engine divergence class B-090/B-094/
  // B-095 each closed.
  //
  // MULTIPLIES `alpha(X,Y)` rather than overwriting it, exactly as the opacity
  // `geq` below does, so this composes with the crop mask above it: a
  // cropped-away pixel is already alpha 0 there and must not be un-hidden.
  if (needsCornerRadius) {
    const cov = cornerRadiusMaskExpr(cornerRadiusExpr);
    after.push({
      tag: 'cr',
      build: (inLabel) =>
        `[${inLabel}]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${cov})'`,
    });
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

/**
 * D-344 — an ffmpeg expression giving the rounded-box COVERAGE of the pixel
 * `(X, Y)` of the current frame, for corner radius `rExpr` (itself an
 * expression, so a keyframed radius animates): `1` well inside, `0` well
 * outside, a linear one-pixel ramp across the corner arc.
 *
 * **The canonical rounded-box signed distance field**, not a hand-derived
 * corner test: `q = |p| - (half - r)`, `length(max(q,0)) + min(max(q.x,q.y),0)
 * - r`, thresholded at half a pixel. That choice is load-bearing rather than
 * stylistic. The obvious alternative — "distance from the corner circle's
 * centre, thresholded at `r`" — has no defined value along the straight edges
 * and therefore needs a special case there, and that special case is exactly
 * what breaks `r == 0`: with no corner arc to be outside of, the naive
 * expression evaluates to `clip(0.5 - 0, 0, 1) == 0.5` and silently HALVES THE
 * ALPHA OF THE ENTIRE LAYER. That was measured against real ffmpeg before
 * either engine was written (`docs/notes/rounded-corners.md`); the SDF form is
 * an exact identity at `r == 0` by construction, with no special case, which is
 * what makes the "zero is byte-identical" guarantee hold for a KEYFRAMED radius
 * passing through zero and not merely for a clip that never sets one.
 *
 * `W`/`H` are `geq`'s own per-frame frame dimensions, so this tracks a
 * keyframed `scale` for free. The `+ 0.5` on the pixel centre makes the box
 * span `0..W` (full pixel coverage) rather than `0..W-1` (pixel centres) —
 * without it the outermost row and column would come back half-covered even at
 * `r == 0`. The radius is clamped to `0 .. min(W,H)/2` here, at the point of
 * use, so an over-large radius becomes a pill or circle (what CSS
 * `border-radius` does with one) rather than a degenerate shape.
 *
 * `chroma::edit::corner_coverage` computes this identical formula — same SDF,
 * same clamp, same half-pixel convention — which is what makes the live preview
 * and this exporter agree to within ffmpeg's own 1/255 alpha quantisation
 * rather than "approximately"; `timelineExportCornerRadius.ffmpeg.test.ts`
 * measures exactly that against both engines' real output.
 *
 * Uppercase `X`/`Y`/`W`/`H`/`T` throughout: `geq` is the one filter here whose
 * time variable is `T` and which rejects lowercase `t` outright — see
 * `alphaExpr`'s own note.
 */
function cornerRadiusMaskExpr(rExpr: string): string {
  const R = `min(max((${rExpr}),0),min(W,H)/2)`;
  const qx = `(abs(X+0.5-W/2)-(W/2-${R}))`;
  const qy = `(abs(Y+0.5-H/2)-(H/2-${R}))`;
  const sd = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${R})`;
  return `clip(0.5-${sd},0,1)`;
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

/** B-230 — the TOTAL decoder frame-thread budget ONE export may spend, shared
 *  across all of its video inputs rather than granted to each one separately.
 *
 *  ffmpeg's `-threads` default for a decoder is `auto` = the machine's logical
 *  CPU count, applied PER INPUT, and each frame thread of a frame-threaded
 *  decoder carries its own full-size frame buffers and reference pictures. One
 *  `-i` per clip therefore costs (clip count) x (CPU count) x (one frame) — a
 *  per-clip price that also grows with the machine it runs on. Bounding the SUM
 *  makes a heavily-cut project's decode memory roughly flat in clip count,
 *  which is the same argument B-229's `-filter_complex_threads` cap makes about
 *  the filter half of the same graph. 8 is "about one machine's worth of decode
 *  parallelism", deliberately a constant rather than anything read from the
 *  host — this module compiles an argv and must stay a pure function of the
 *  document (it is bundled into the app's frontend, where there is no `os`). */
const TOTAL_DECODE_FRAME_THREADS = 8;

/** The `-threads` value to put in front of each video `-i`, or `null` to leave
 *  ffmpeg's own default alone.
 *
 *  A single-input export is left alone deliberately: one decoder's thread pool
 *  is a bounded, one-off cost no matter how wide it is, and full frame
 *  threading is the fastest way to decode one stream — the pathology is
 *  strictly the per-input multiplication. This also keeps the argv of a
 *  one-clip export byte-identical to what it has always been. */
function perInputDecodeThreads(videoInputCount: number): number | null {
  if (videoInputCount <= 1) return null;
  return Math.max(1, Math.floor(TOTAL_DECODE_FRAME_THREADS / videoInputCount));
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
 * Compositing order mirrors `apelles_timeline::edit::composite_video_frame`'s
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

  // B-230 — how many real video DECODERS this export will open. Known before
  // the loop below opens any of them because the skip rule is exactly "a text
  // or adjustment clip has no media of its own" (the `clip.text ||
  // clip.adjustment` branch further down), and a dip plate is a `color`
  // source, not an `-i`.
  const videoInputCount = videoTracks.reduce(
    (n, { track }) => n + track.clips.filter((c) => !(c.text || c.adjustment)).length,
    0,
  );
  const decodeThreads = perInputDecodeThreads(videoInputCount);
  const decodeThreadArgs = decodeThreads === null ? [] : ['-threads', String(decodeThreads)];

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
      // D-236 — the clip's own OUTPUT length in its own source-frame units.
      // Replaces the pre-D-236 `clip.duration / speed` this loop spelled
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
          // D-236) shrinks the window a clip occupies in the output.
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
      // D-292 — a STILL IMAGE is opened as a LOOPED single-frame source, not
      // seeked into like a stream.
      //
      // `-loop 1 -framerate <rate>` makes ffmpeg's image demuxer emit that one
      // picture forever at `<rate>`; `-t` then cuts it to exactly the clip's
      // own length, so the still is present at EVERY output frame of its
      // duration rather than at one. There is deliberately no `-ss`: a still
      // has no timeline to seek within (`source_start` is meaningless on it,
      // and the compositor ignores the resolved source frame for the same
      // reason — see `decode_clip_picture` in `chroma::edit`), and an `-ss`
      // into a looped image would just discard whole copies of the same frame.
      //
      // The transition handles ARE folded into the length, exactly as they are
      // for footage: a still under a cross dissolve has to keep being emitted
      // through the dissolve window. It never runs out of media doing so,
      // which is the one way a still is easier than footage here.
      //
      // B-230 — `decodeThreadArgs` (empty for a one-clip export) caps THIS
      // input's own decoder thread pool; see `perInputDecodeThreads`. An input
      // option, so it goes before the `-i` it belongs to, like `-ss`/`-t`.
      if (isStillSource(clip.source_path)) {
        inputs.push(
          ...decodeThreadArgs,
          '-loop',
          '1',
          '-framerate',
          String(clipFps),
          '-t',
          String((clip.duration + adjust.headSrcFrames + adjust.tailSrcFrames) / clipFps),
          '-i',
          clip.source_path,
        );
      } else {
        inputs.push(
          ...decodeThreadArgs,
          '-ss',
          String((clip.source_start - adjust.headSrcFrames) / clipFps),
          '-t',
          String((clip.duration + adjust.headSrcFrames + adjust.tailSrcFrames) / clipFps),
          '-i',
          clip.source_path,
        );
      }

      // `start_frame` is a TIMELINE frame (project/export rate) — `opts.fps`
      // is correct here. `duration` is a SOURCE frame count — `clipFps` is
      // correct here, same reasoning as the `-ss`/`-t` conversion above.
      // When sped up, `setpts=PTS/speed` compresses playback into
      // `duration / speed` (source seconds) worth of OUTPUT time — or, under
      // a D-236 ramp, into `Σ len_i / speed_i`, which is the same statement
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
  // D-350 — one definition, shared with the render path's own compiler
  // (`timelinePipeExport.ts`), so the two export paths cannot disagree about
  // how long the same timeline is. `export_t_matches_exportTotalDurationSec` in
  // `timelineExport.test.ts` asserts this call and the emitted `-t` stay the
  // same number.
  const totalDurationSec = exportTotalDurationSec(timeline, opts);

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
      opts.captionMetrics,
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
    // D-236 — the SAME segments the picture's own `setpts` was built from,
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
      // B-101 — the source's channel count, so a panned MONO clip is adapted
      // to stereo the same way the live mixer adapts it.
      sourceChannels: opts.audioChannelsOverrides?.[p.clip.id],
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
    // B-228 — a track muted at the TRACK level (`gain: 0`, D-057) contributes
    // exactly nothing to `amix` no matter what its clips decode to
    // (`buildAudioSourceChain`'s `gain` multiplies every sample by it), so
    // decoding those clips at all is pure waste: a full `-i` + filter chain
    // per clip for output that's provably silent. Safe to skip entirely —
    // `resolveDuckForTrack` (above) derives ducking from a track's own CLIP
    // TIMING (`trackClipSpansFromZero`), never from another track's actual
    // decoded audio, so a muted track can still duck (or be ducked by)
    // another track correctly with none of its own clips ever opened here.
    // Does NOT skip a clip whose PER-CLIP `volume` is 0 — that field can be
    // keyframed/faded up from 0, so only the non-animatable track-level gain
    // is safe to treat as "never audible, ever" statically.
    if ((track.gain ?? 1) === 0) continue;
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
        sourceChannels: opts.audioChannelsOverrides?.[clip.id],
      });
      filterSteps.push(...steps);
      audioRefs.push(ref);
    }
  }

  // Final mix. Exactly one total audio-contributing clip bypasses `amix`/
  // `asoftclip` entirely — mirrors `apelles_media::audio::mix_sources`'s own
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
    // B-229 — ffmpeg's own `-filter_complex_threads` defaults to the
    // logical CPU count, but that count is applied to EVERY individual
    // filter INSTANCE in the graph independently, not shared once across
    // it — total OS threads scale as roughly (filter instance count) ×
    // (this value). A heavily-cut timeline's overlay/crop/geq chain can
    // carry hundreds of filter instances, which multiplied by an
    // unbounded per-instance thread pool measured out to 3,000+ threads
    // and tens of GB RSS on a real project (confirmed via a controlled
    // synthetic reproduction, not guessed) — `-filter_threads` does NOT
    // control this; it is a documented no-op for a `-filter_complex`
    // graph. Capping this to a small constant bounds both memory and
    // thread count to a small multiple of the instance count regardless
    // of how many clips a project has, at the cost of some per-filter
    // parallelism on a simple, few-clip export.
    '-filter_complex_threads',
    '2',
    '-filter_complex',
    filterSteps.join(';'),
    '-map',
    `[${lastLabel}]`,
  ];
  if (audioMapArg) args.push('-map', audioMapArg);
  args.push('-r', String(opts.fps), '-t', String(totalDurationSec), outPath);
  return args;
}
