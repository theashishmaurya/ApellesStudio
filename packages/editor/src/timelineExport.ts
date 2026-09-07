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
 * **v1 scope, deliberately**: VIDEO tracks/clips only — audio tracks/clips
 * (gain, ducking, fades) are out of scope this pass, a documented follow-up
 * rather than an oversight, since this pass's own concrete use case
 * (a stacked before/after screen-recording comparison reel) has no
 * multi-track audio mixing need yet.
 */

import type { Clip, Timeline } from './timeline';

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
 */
export function keyframeExprAt(
  keyframes: ExportKeyframe[],
  param: string,
  staticValue: number,
  fps: number,
): string {
  const points = keyframes
    .filter((k) => Object.prototype.hasOwnProperty.call(k.params, param))
    .map((k) => ({ t: k.frame / fps, value: Number(k.params[param]) }))
    .sort((a, b) => a.t - b.t);

  if (points.length === 0) return String(staticValue);
  if (points.length === 1) return String(points[0].value);

  // Build the nested if()/else chain from the LAST segment inward, so the
  // innermost final "else" is the after-last-keyframe hold and each
  // outer if() wraps the one built so far — same structure as ffmpeg's own
  // documented if(cond,then,else) nesting for a piecewise function.
  let expr = String(points[points.length - 1].value);
  for (let i = points.length - 2; i >= 0; i--) {
    const { t: t0, value: y0 } = points[i];
    const { t: t1, value: y1 } = points[i + 1];
    const slopeTerm = `${y0}+(${y1}-${y0})*(t-${t0})/(${t1}-${t0})`;
    expr = `if(between(t,${t0},${t1}),${slopeTerm},${expr})`;
  }
  // Before the first keyframe: hold at its value (no backward extrapolation).
  const firstT = points[0].t;
  expr = `if(lt(t,${firstT}),${points[0].value},${expr})`;
  return expr;
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
   *  **D-186 superseded the need for this on any clip with a real
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

  const scale = clip.scale ?? 1;
  // D-186 — `box_width`, when the clip has one, is a DIRECT canvas-fraction
  // override (mirrors `position_x`'s own convention) — it replaces
  // `opts.width*scale` outright rather than participating in B-074's
  // `fit`/`stretch` choice, since there is no more ambiguity to resolve
  // once the caller has stated the width explicitly. Falls back to the
  // pre-D-186 `opts.width*scale` when absent, so an existing clip (or one
  // that only sets `scale`) compiles byte-identically to before.
  const widthExpr = clip.box_width != null ? `${opts.width}*${clip.box_width}` : `${opts.width}*${scale}`;
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
  // D-186 — `box_height`, when the clip has one, is the same kind of direct
  // canvas-fraction override as `box_width` above and takes priority over
  // `fitOverrides` entirely: an explicit persisted height is a MORE
  // specific signal than an export-time-only fit/stretch default, and once
  // both axes are explicitly known there is nothing left for ffmpeg's `-2`
  // to compute. Unlike `box_width` (which was always unconditional — `fit`/
  // `stretch` never touched width), `box_height` is genuinely a third
  // option alongside `fit`/`stretch`, not a variant of either.
  //
  // **Known, deliberate limit (D-186):** `box_width`/`box_height` are a
  // fraction of the OUTPUT CANVAS in both this compiler and the Rust
  // live-preview compositor (`chroma::edit::composite_layer_onto`) — a
  // genuinely NEW field with NO Rust/TS parity gap, unlike `scale` itself
  // (whose meaning depends on the clip's own SOURCE resolution, which this
  // pure, no-I/O module still cannot probe — B-074/D-184's own pre-existing,
  // intentionally-not-reopened gap). See D-186's decision entry for the
  // full comparison.
  const fitMode = opts.fitOverrides?.[clip.id] ?? 'fit';
  const heightExpr =
    clip.box_height != null
      ? `${opts.height}*${clip.box_height}`
      : fitMode === 'stretch'
        ? `${opts.height}*${scale}`
        : '-2';
  const scaleLabel = padSecs > 0 ? `p${label}` : label;
  steps.push(`${src}scale=${widthExpr}:${heightExpr}[${scaleLabel}]`);

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
 * Compile `timeline` into a single ffmpeg argv array rendering `outPath` at
 * `opts.fps`/`opts.width`/`opts.height`.
 *
 * v1 scope: VIDEO tracks only, visible (`!track.hidden`) clips only. Audio
 * tracks/clips are not read at all this pass (see this module's own header
 * doc) — a silent export, with audio mixing a documented follow-up.
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
    inputIdx: number;
    label: string;
    startSec: number;
    endSec: number;
    clipFps: number;
  }
  const pending: PendingClip[] = [];

  for (const { track } of paintOrder) {
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
      pending.push({ clip, inputIdx, label: `v${inputIdx}`, startSec, endSec, clipFps });

      inputIdx++;
    }
  }

  // B-076 — the furthest NATURAL end across every clip, i.e. how long the
  // export will actually run (see the final `-t` below) — computed here,
  // BEFORE any freeze padding, since a frozen clip's own padding target IS
  // this number, not the other way around.
  const totalDurationSec = pending.reduce((max, p) => Math.max(max, p.endSec), 0);

  // Pass 2 — real filter chains, now that `totalDurationSec` is known.
  for (const p of pending) {
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

    filterSteps.push(buildClipFilterChain(p.clip, p.inputIdx, p.label, opts, padSecs));
    chains.push({ label: p.label, clip: p.clip, startSec: p.startSec, endSec: finalEndSec, clipFps: p.clipFps });
  }

  const bg = `color=black:size=${opts.width}x${opts.height}:rate=${opts.fps}[base]`;
  filterSteps.push(bg);

  let lastLabel = 'base';
  chains.forEach((chain, i) => {
    const outLabel = i === chains.length - 1 ? 'outv' : `ov${i}`;
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

  return [
    ...inputs,
    '-filter_complex',
    filterSteps.join(';'),
    '-map',
    `[${lastLabel}]`,
    '-r',
    String(opts.fps),
    '-t',
    String(totalDurationSec),
    outPath,
  ];
}
