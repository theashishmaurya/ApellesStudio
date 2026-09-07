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
 */

import type { Clip, Timeline } from './timeline';
import { DEFAULT_FADE_CURVE, endFrame } from './timeline';
import { piecewiseLinearExpr, type ExprPoint } from './ffmpegExpr';
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

/** One clip's raw keyframe array, as stored on `Clip.chroma_keyframes`. */
export interface ExportKeyframe {
  frame: number;
  params: Record<string, unknown>;
}

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
  const points: ExprPoint[] = keyframes
    .filter((k) => Object.prototype.hasOwnProperty.call(k.params, param))
    .map((k) => ({ t: k.frame / fps, value: Number(k.params[param]) }))
    .sort((a, b) => a.t - b.t);

  if (points.length === 0) return String(staticValue);
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
    clip.fade_in_curve ?? DEFAULT_FADE_CURVE,
    clip.fade_out_curve ?? DEFAULT_FADE_CURVE,
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

interface ClipChain {
  /** This clip's finished filter-chain output label, e.g. `v0`. */
  label: string;
  clip: Clip;
  /** This clip's own on-timeline window at the OUTPUT rate, in seconds —
   *  already accounts for `speedOverrides` shrinking it (see below). */
  startSec: number;
  endSec: number;
  /** B-075 — this clip's own real frame rate (`clip.source_fps ?? opts.fps`),
   *  resolved once per clip so keyframe timing uses the same rate the
   *  `-ss`/`-t`/`endSec` math above it already does. */
  clipFps: number;
}

/** One clip's `crop`/`setpts`/`scale` chain, ending in `[label]` — factored
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
): string {
  const steps: string[] = [];
  let src = `[${inputIdx}:v]`;

  const cl = clip.crop_left ?? 0;
  const ct = clip.crop_top ?? 0;
  const cr = clip.crop_right ?? 0;
  const cb = clip.crop_bottom ?? 0;
  if (cl !== 0 || ct !== 0 || cr !== 0 || cb !== 0) {
    steps.push(`${src}crop=iw*(1-${cl}-${cr}):ih*(1-${ct}-${cb}):iw*${cl}:ih*${ct}[c${label}]`);
    src = `[c${label}]`;
  }

  const speed = opts.speedOverrides?.[clip.id];
  if (speed && speed !== 1) {
    steps.push(`${src}setpts=PTS/${speed}[s${label}]`);
    src = `[s${label}]`;
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
    ? keyframeExprAt(rebaseKeyframesToClipInput(clip), 'scale', scale, clipFps)
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
  const scaleLabel = padSecs > 0 ? `p${label}` : label;
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
  steps.push(`${src}scale=w=${quotedWidth}:h=${quotedHeight}${evalSuffix}[${scaleLabel}]`);

  // D-188 — `freezeOverrides`: hold this clip's own real last decoded frame,
  // cloned, for `padSecs` more seconds past its natural end. `tpad` operates
  // on the already-scaled/positioned overlay stream (last step, not before
  // crop/setpts/scale) so the held frame is pixel-identical to whatever the
  // clip's last real frame actually rendered as, at full output resolution —
  // the caller (`buildExportFfmpegArgs`) also extends this clip's own
  // `enable=between()` window to match, or the held frame would decode fine
  // but never actually get composited past the original window.
  if (padSecs > 0) {
    steps.push(`[${scaleLabel}]tpad=stop_mode=clone:stop_duration=${padSecs}[${label}]`);
  }

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
  return (clip.chroma_keyframes ?? []).map((k) => ({ frame: k.frame - clip.source_start, params: k.params }));
}

function positionExpr(clip: Clip, param: 'position_x' | 'position_y', fps: number): string {
  const staticValue = clip[param] ?? 0;
  if (!hasKeyframesFor(clip, param)) return String(staticValue);
  return keyframeExprAt(rebaseKeyframesToClipInput(clip), param, staticValue, fps);
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
    clip: Clip;
    /** `null` for a TEXT clip (D-211): it opens no file, so it consumes no
     *  `-i` and has no `[N:v]` to address. Its picture comes from a
     *  `drawtext` node spliced into the overlay chain instead — see
     *  `buildTextDrawtextStep`. */
    inputIdx: number | null;
    label: string;
    startSec: number;
    endSec: number;
    clipFps: number;
    /** D-197 — which VIDEO track this clip is on, needed only for embedded-
     *  audio ducking (`resolveDuckForTrack` looks up `duck_from` on THIS
     *  track, not the clip). */
    trackIndex: number;
  }
  const pending: PendingClip[] = [];

  for (const { track, index: trackIndex } of paintOrder) {
    for (const clip of track.clips) {
      const speed = opts.speedOverrides?.[clip.id] ?? 1;
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
      if (clip.text) {
        const startSec = clip.start_frame / opts.fps;
        pending.push({
          clip,
          inputIdx: null,
          label: `t${pending.length}`,
          startSec,
          // A generated layer has no `source_fps` (see `newTextClipFields`),
          // so `clipFps` is the export's own rate and `duration` really is
          // its timeline footprint. `speed` still divides it for the same
          // reason it does for a media clip: `speedOverrides` shrinks the
          // window a clip occupies in the output.
          endSec: startSec + clip.duration / speed / clipFps,
          clipFps,
          trackIndex,
        });
        continue;
      }

      inputs.push(
        '-ss',
        String(clip.source_start / clipFps),
        '-t',
        String(clip.duration / clipFps),
        '-i',
        clip.source_path,
      );

      // `start_frame` is a TIMELINE frame (project/export rate) — `opts.fps`
      // is correct here. `duration` is a SOURCE frame count — `clipFps` is
      // correct here, same reasoning as the `-ss`/`-t` conversion above.
      // When sped up, `setpts=PTS/speed` compresses playback into
      // `duration / speed` (source seconds) worth of OUTPUT time — the
      // `enable=between()` gate below must shrink to match, or the clip
      // would appear to freeze/hold its last frame for the un-shrunk
      // remainder of its original window.
      const startSec = clip.start_frame / opts.fps;
      const endSec = startSec + clip.duration / speed / clipFps;
      pending.push({ clip, inputIdx, label: `v${inputIdx}`, startSec, endSec, clipFps, trackIndex });

      inputIdx++;
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
      const speed = opts.speedOverrides?.[c.id] ?? 1;
      const clipFps = c.source_fps ?? opts.fps;
      return c.start_frame / opts.fps + c.duration / speed / clipFps;
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
    if (p.inputIdx === null) {
      chains.push({ label: p.label, clip: p.clip, startSec: p.startSec, endSec: p.endSec, clipFps: p.clipFps });
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

    filterSteps.push(buildClipFilterChain(p.clip, p.inputIdx, p.label, opts, p.clipFps, padSecs));
    chains.push({ label: p.label, clip: p.clip, startSec: p.startSec, endSec: finalEndSec, clipFps: p.clipFps });
  }

  const bg = `color=black:size=${opts.width}x${opts.height}:rate=${opts.fps}[base]`;
  filterSteps.push(bg);

  let lastLabel = 'base';
  chains.forEach((chain, i) => {
    const outLabel = i === chains.length - 1 ? 'outv' : `ov${i}`;
    // D-211 — a text clip paints with `drawtext` on the stream built so far,
    // at exactly the position in the chain its `overlay` would have taken, so
    // z-order needs no separate rule. A clip whose font could not be resolved
    // is skipped rather than compiled against a guessed path — the caller
    // (`compileEditorExportArgs`) has already refused the whole export via
    // `textClipsMissingFonts`, so this is the defensive second line only.
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
    const xExpr = positionExpr(chain.clip, 'position_x', chain.clipFps);
    const yExpr = positionExpr(chain.clip, 'position_y', chain.clipFps);
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
    if (p.inputIdx === null) continue;
    if (p.clip.link_group) continue;
    if (!(opts.hasAudioOverrides?.[p.clip.id] ?? false)) continue;
    const speed = opts.speedOverrides?.[p.clip.id] ?? 1;
    const { steps, ref } = buildAudioSourceChain({
      srcRef: `[${p.inputIdx}:a]`,
      clip: p.clip,
      clipFps: p.clipFps,
      gain: 1, // D-057: a video track's own embedded audio stays hardcoded at unity
      speed,
      startSec: p.startSec,
      duck: duckForTrack(p.trackIndex),
      idLabel: `au${audioLabelSeq++}`,
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
      const speed = opts.speedOverrides?.[clip.id] ?? 1;
      const startSec = clip.start_frame / opts.fps;
      const { steps, ref } = buildAudioSourceChain({
        srcRef: `[${thisInputIdx}:a]`,
        clip,
        clipFps,
        gain: track.gain ?? 1,
        speed,
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
