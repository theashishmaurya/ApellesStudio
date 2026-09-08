/**
 * @chroma/editor — the speed ramp: variable playback speed over one clip's
 * own length (D-236, roadmap item 27).
 *
 * **What it is.** The single, canonical implementation of a clip's *time
 * remap* — the function that answers "which SOURCE frame does this clip show
 * at this OUTPUT position, and how long does the clip therefore occupy on the
 * timeline". Every consumer (the live preview's frame resolution, the export's
 * `setpts` expression, the export's audio `atempo` chain, every duration
 * calculation) goes through this module rather than re-spelling the
 * arithmetic, so the two renderers cannot drift apart. Its Rust mirror is
 * `chroma_timeline::speed_ramp` — the two are kept deliberately line-for-line
 * comparable, and `speedRamp.test.ts` pins the shared cases.
 *
 * **What it does.** A ramp is a list of [`SpeedPoint`]s stored on the clip
 * (`Clip.speed_points`). Each point says "from this SOURCE frame onward, play
 * at this speed", so the speed profile is a **step function over the source
 * axis** and the resulting time remap is exactly **piecewise linear** in both
 * directions. That is the whole design (see D-236): a piecewise-linear remap
 * is the one shape that can be written identically as closed-form arithmetic
 * in Rust (the preview), as a nested `if(between(...))` `setpts` expression in
 * ffmpeg (the export picture), and as an `atrim`/`atempo`/`concat` chain in
 * ffmpeg (the export audio) — the audio side in particular can ONLY ever be
 * piecewise constant, because `atempo` takes a constant factor and has no
 * time-varying form at all.
 *
 * **A flat speed is a one-segment ramp.** `speedOverrides` (the pre-D-236
 * export-time-only flat multiplier, D-183) is not a second concept: it
 * resolves through [`resolveSpeedSegments`] into a single segment at that
 * speed, and every downstream consumer sees only segments. The flat case
 * still compiles to the exact pre-D-236 `setpts=PTS/<speed>` / single
 * `atempo` chain (see [`isFlatSegments`]) so no existing export changes by a
 * byte.
 *
 * **Reverse (negative) speed — D-240.** A speed may now be NEGATIVE, meaning
 * that run plays its own source range backwards. It is not a second model: a
 * segment `[a, b)` at speed `-s` occupies exactly the same `(b-a)/s` of
 * output a `+s` segment would, it just walks the source from `b` down to `a`
 * instead of `a` up to `b`. The whole generalisation is one `anchor` term in
 * [`outputAtSourceFrame`] / [`sourceFrameAtOutput`] (the segment's END rather
 * than its start is the source position at its output start) plus `|speed|`
 * wherever an output LENGTH is computed. The remap stays piecewise linear and
 * stays a bijection — it simply stops being monotonic, which nothing in this
 * module ever needed.
 *
 * **What it does NOT do.**
 * - **Smoothed (S-curve) speed transitions.** Resolve's optional "smooth" on
 *   a speed point makes the speed itself ease between two segments, which
 *   makes the remap piecewise *quadratic* and has no `atempo` equivalent at
 *   all. Deferred deliberately (D-236); note that the model is closed under
 *   refinement — a smooth ramp is approximable to any tolerance by
 *   subdividing it into more constant segments, with no schema change.
 * - **Frame interpolation.** Slow motion repeats source frames (Resolve's
 *   "nearest frame"); optical flow / frame blending are not attempted.
 * - Any I/O, store access or React. Pure math, like the rest of the export
 *   compiler.
 */

import type { Clip } from './timeline';

/** A speed point: from `source_frame` onward (in the clip's own SOURCE frame
 *  space — the same space as `Clip.source_start`, absolute in the file, NOT
 *  clip-relative), this clip plays at `speed`.
 *
 *  Storing points in ABSOLUTE source frames rather than clip-relative ones is
 *  what makes a ramp survive a trim: trimming the head moves `source_start`
 *  but the moment in the footage the speed was authored against — the exact
 *  frame the action happens on — stays put, which is the whole reason an
 *  editor places a speed point in the first place. It matches Resolve's own
 *  Retime Controls, whose speed points are anchored to source frames and move
 *  the OUTPUT duration when dragged, not the frame they sit on. */
export interface SpeedPoint {
  /** Absolute SOURCE frame, in the clip's own native rate (`source_fps`). */
  source_frame: number;
  /** Playback speed from here on: source frames consumed per output frame.
   *  `2` is double speed (half the output length), `0.5` is half speed
   *  (double the output length). **Negative is REVERSE** (D-240): `-1` plays
   *  this run backwards at its recorded rate, `-2` backwards at double speed.
   *  Never `0` — see [`clampSpeed`]. */
  speed: number;
}

/** One resolved, concrete constant-speed run over a clip's own trim window.
 *  Produced by [`resolveSpeedSegments`]; the unit every consumer works in. */
export interface SpeedSegment {
  /** Inclusive, absolute SOURCE frame. */
  startSourceFrame: number;
  /** Exclusive, absolute SOURCE frame. */
  endSourceFrame: number;
  /** Negative = this run plays `[startSourceFrame, endSourceFrame)` BACKWARDS
   *  (D-240). Its output length is unchanged — `len / |speed|`. */
  speed: number;
}

/** The SOURCE position a segment sits at when its own OUTPUT run begins: its
 *  start when it plays forwards, its **end** when it plays in reverse.
 *
 *  This one term is the entire negative-speed generalisation (D-240). With it,
 *  `output = acc + (source - anchor) / speed` and `source = anchor + (output -
 *  acc) * speed` are each other's exact inverse for either sign, so both maps
 *  below are written once and branch nowhere. */
function anchorSourceFrame(s: SpeedSegment): number {
  return s.speed > 0 ? s.startSourceFrame : s.endSourceFrame;
}

/** A segment's OUTPUT length, in the same source-frame units its endpoints are
 *  in — `len / |speed|`. The absolute value is the only place the sign of a
 *  reversed run is discarded: playing a range backwards takes exactly as long
 *  as playing it forwards. */
function segmentOutputLength(s: SpeedSegment): number {
  return Math.max(0, s.endSourceFrame - s.startSourceFrame) / Math.abs(s.speed);
}

/** Does any run of this ramp play backwards (D-240)? The branch every
 *  compiler takes: a reversed run cannot be expressed as a `setpts` slope or
 *  an `atempo` factor at all — it needs ffmpeg's frame-buffering
 *  `reverse`/`areverse`, which is a different filtergraph shape entirely. */
export function hasReverseSegments(segments: readonly SpeedSegment[]): boolean {
  return segments.some((s) => s.speed < 0);
}

/** The speed range a ramp point is clamped into on the way in.
 *
 *  The lower bound is not arbitrary: at `0.01` a one-second clip stretches to
 *  100 seconds of output, which is already past any real use and well into
 *  "an accidental keystroke just made the export a hundred times longer"
 *  territory. The upper bound mirrors it. Resolve's own Retime Controls
 *  expose roughly the same practical window before you are expected to reach
 *  for a freeze frame (below) or a cut (above). */
export const MIN_SPEED = 0.05;
export const MAX_SPEED = 20;

/** `speed` with its MAGNITUDE pinned into `[MIN_SPEED, MAX_SPEED]` and its
 *  SIGN preserved (D-240: a negative speed is a real, supported reverse run).
 *  Every non-finite input and exact `0` resolves to `1` — the two values that
 *  would make the remap infinite or collapse the clip to a single instant.
 *
 *  Note what is deliberately NOT clamped away: `-0.5` stays `-0.5`. Before
 *  D-240 this function's whole job was to erase a negative, and the one-line
 *  change here is what unlocks reverse everywhere downstream, because every
 *  authored point in both languages goes through it. */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed === 0) return 1;
  const magnitude = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.abs(speed)));
  return speed < 0 ? -magnitude : magnitude;
}

/** Normalise an authored point list: drop non-finite frames, clamp every
 *  speed, sort by `source_frame`, and collapse duplicates at the same frame
 *  (last one wins — the natural "you just set this point again" semantic).
 *
 *  **It deliberately does NOT drop a point whose speed equals the one already
 *  in force.** That looks like tidying and is actually destructive: splitting a
 *  clip at the playhead and *then* choosing a speed for the new run is the
 *  normal authoring order (it is Resolve's, and it is the only order in which
 *  adding a speed point does not retime the clip the instant you add it), and
 *  a redundant-point filter deletes that split before the editor can use it —
 *  caught live by `ClipInspectorPanel.speed.dom.test.tsx`. Flatness is decided
 *  from the SPEEDS instead, by [`isFlatSegments`], so a clip carrying only
 *  1x points still compiles down the byte-identical flat path.
 *
 *  Applied on the way IN (the `set_clip_speed` op) so the stored document is
 *  always already normalised, and again on the way OUT (here) so a
 *  hand-edited or older document still resolves sanely — the same
 *  belt-and-braces `chroma_timeline_set`'s own "stores whatever it is handed"
 *  contract (D-058) forces on every other resolver in this package. */
export function normalizeSpeedPoints(points: readonly SpeedPoint[] | undefined): SpeedPoint[] {
  if (!points || points.length === 0) return [];
  const sorted = points
    .filter((p) => p && Number.isFinite(p.source_frame))
    .map((p) => ({ source_frame: Math.round(p.source_frame), speed: clampSpeed(p.speed) }))
    .sort((a, b) => a.source_frame - b.source_frame);

  // One point per frame, last write wins ("you just set this point again").
  const byFrame: SpeedPoint[] = [];
  for (const p of sorted) {
    const prev = byFrame[byFrame.length - 1];
    if (prev && prev.source_frame === p.source_frame) byFrame[byFrame.length - 1] = p;
    else byFrame.push(p);
  }

  return byFrame;
}

/** Does this clip actually play at anything other than its recorded speed?
 *
 *  Deliberately about the SPEEDS, not about whether points exist: a clip that
 *  has been split by a speed point but not yet retimed (every point still 1x)
 *  plays exactly as it always did, moves no edge, and must not trip any of the
 *  "a speed change is incompatible with this" refusals. */
export function hasSpeedRamp(clip: Pick<Clip, 'speed_points'>): boolean {
  return normalizeSpeedPoints(clip.speed_points).some((p) => p.speed !== 1);
}

/**
 * The concrete constant-speed segments covering exactly this clip's own trim
 * window `[source_start, source_start + duration)`.
 *
 * The clip's own `speed_points` win outright when it has any; otherwise
 * `flatOverride` (an export-time `speedOverrides[clip.id]` entry, D-183)
 * supplies a single flat segment; otherwise the identity. **An explicit ramp
 * beating the export-time override is the deliberate precedence** — the ramp
 * is real, persisted, previewable model data an editor authored, and the
 * override is a per-export knob with no GUI of its own; silently multiplying
 * them would make the exported clip match neither what the preview shows nor
 * what the export dialog's number says.
 *
 * Always returns at least one segment. A zero-or-negative-duration clip
 * yields one empty segment at `source_start` rather than an empty list, so
 * every consumer can index `[0]` without a guard.
 */
export function resolveSpeedSegments(
  clip: Pick<Clip, 'source_start' | 'duration' | 'speed_points'>,
  flatOverride?: number,
): SpeedSegment[] {
  const start = clip.source_start;
  const end = start + Math.max(0, clip.duration);
  const points = normalizeSpeedPoints(clip.speed_points);

  if (points.length === 0) {
    return [{ startSourceFrame: start, endSourceFrame: end, speed: clampSpeed(flatOverride ?? 1) }];
  }

  // The speed in force AT `start` is the last point at or before it — a point
  // authored before the clip's current in-point still governs the head of the
  // trimmed window, which is exactly what keeps a ramp stable under a trim.
  const boundaries: number[] = [start];
  let headSpeed = 1;
  for (const p of points) {
    if (p.source_frame <= start) {
      headSpeed = p.speed;
    } else if (p.source_frame < end) {
      boundaries.push(p.source_frame);
    }
  }
  boundaries.push(end);

  const speedAt = (frame: number): number => {
    let s = headSpeed;
    for (const p of points) {
      if (p.source_frame <= frame) s = p.speed;
      else break;
    }
    return s;
  };

  const segments: SpeedSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    segments.push({
      startSourceFrame: boundaries[i],
      endSourceFrame: boundaries[i + 1],
      speed: speedAt(boundaries[i]),
    });
  }
  return segments.length > 0
    ? segments
    : [{ startSourceFrame: start, endSourceFrame: end, speed: headSpeed }];
}

/** Is this clip's playback speed CONSTANT **and FORWARD** — i.e. is it
 *  something a pre-D-236 consumer could already express as one `PTS/<speed>`
 *  and one `atempo` factor? Every compiler in this package branches on this to
 *  keep the flat path byte-identical to what it emitted before ramps existed.
 *
 *  Equal speeds, not one segment: a clip split by a speed point whose runs all
 *  play at the same rate is flat in every way that matters to a renderer, and
 *  compiling it as a ramp would emit a needless expression for an identity.
 *
 *  **D-240 — a reversed run is never "flat", even alone.** A single segment at
 *  `-2` is perfectly constant, but `setpts=PTS/-2` and `atempo=-2` are not
 *  what plays it backwards (the first emits descending timestamps, the second
 *  is rejected outright), so it must not take the constant path. "Flat" here
 *  has always meant *expressible by the pre-D-236 compiler*, and that is the
 *  meaning kept. */
export function isFlatSegments(segments: readonly SpeedSegment[]): boolean {
  if (hasReverseSegments(segments)) return false;
  return segments.length <= 1 || segments.every((s) => s.speed === segments[0].speed);
}

/** The single speed of a flat segment list (`1` for an empty one). Only
 *  meaningful when [`isFlatSegments`]. */
export function flatSpeedOf(segments: readonly SpeedSegment[]): number {
  return segments[0]?.speed ?? 1;
}

/**
 * How long this ramp's OUTPUT is, measured in the clip's own source-frame
 * units (i.e. still to be divided by `source_fps` for seconds, or converted
 * to timeline frames with the project's rate — exactly what an un-ramped
 * clip's `duration` already is).
 *
 * `Σ len_i / |speed_i|` — the one place the "a 2x segment occupies half as
 * much output" rule is written down. The magnitude (D-240) is what makes a
 * reversed run take exactly as long as the same range played forwards, which
 * is the whole reason reverse needed no schema change: a clip's footprint on
 * the timeline never depends on the DIRECTION it plays.
 */
export function rampOutputSourceFrames(segments: readonly SpeedSegment[]): number {
  let total = 0;
  for (const s of segments) {
    total += segmentOutputLength(s);
  }
  return total;
}

/**
 * The forward map: the OUTPUT position (in source-frame units from the clip's
 * own start, the same unit [`rampOutputSourceFrames`] returns) at which this
 * ramp reaches absolute SOURCE frame `sourceFrame`.
 *
 * This is the direction ffmpeg needs — `setpts` is handed the decoded frame's
 * own source timestamp and must produce its output timestamp — and it is the
 * exact inverse of [`sourceFrameAtOutput`], which is the direction the
 * preview needs. Both are written here, against the same segment list, for
 * that reason: the two renderers' agreement is `F(F⁻¹(x)) == x`, and
 * `speedRamp.test.ts` asserts precisely that round trip.
 *
 * Positions outside the ramp EXTRAPOLATE at the first/last segment's own
 * speed rather than clamping, mirroring `chroma_timeline::Clip::
 * source_frame_at`'s own documented handle-media behaviour.
 */
export function outputAtSourceFrame(segments: readonly SpeedSegment[], sourceFrame: number): number {
  if (segments.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    // The last segment also absorbs everything past the ramp — that IS the
    // documented "extrapolate at the last segment's own speed" rule, and
    // writing it as a fall-through rather than a separate tail case is what
    // makes the head, the body and the tail one formula. (Before D-240 the
    // head and tail were spelled out separately; they are algebraically the
    // same expression, which is why collapsing them changed no forward-ramp
    // result — pinned by the untouched D-236 tests.)
    if (sourceFrame < s.endSourceFrame || i === segments.length - 1) {
      return acc + (sourceFrame - anchorSourceFrame(s)) / s.speed;
    }
    acc += segmentOutputLength(s);
  }
  return acc;
}

/**
 * The inverse map: the absolute SOURCE frame this ramp shows at OUTPUT
 * position `outputPos` (in source-frame units from the clip's own start).
 *
 * This is the direction the live preview needs — `Clip::source_frame_at` asks
 * "the playhead is here, which frame do I decode". Extrapolates outside the
 * ramp exactly as [`outputAtSourceFrame`] does, and for the same reason.
 */
export function sourceFrameAtOutput(segments: readonly SpeedSegment[], outputPos: number): number {
  if (segments.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const outLen = segmentOutputLength(s);
    // Same fall-through as `outputAtSourceFrame`: the first segment covers
    // everything before the ramp and the last everything after it.
    if (outputPos < acc + outLen || i === segments.length - 1) {
      return anchorSourceFrame(s) + (outputPos - acc) * s.speed;
    }
    acc += outLen;
  }
  return 0;
}

/**
 * [`sourceFrameAtOutput`] quantised to the integer SOURCE FRAME actually shown
 * — the form the live preview decodes with (`Clip::source_frame_at` and
 * `clipSourceFrameAt` are both exactly this).
 *
 * **The rounding rule depends on the direction of travel, and that is not a
 * detail.** A frame owns the half-open source interval `[n, n+1)`:
 *
 * - Playing FORWARD, output sweeps that interval upward, so `floor` is the
 *   frame on screen — and `setpts` floors by construction, which is why D-236
 *   pinned this rule after a test failure rather than by reasoning.
 * - Playing in REVERSE (D-240), a segment `[a, b)` is entered at source `b`
 *   and swept DOWN to `a`, so the continuous position ranges over `(a, b]` —
 *   the mirror interval. `floor` there would show frame `b` (one past the
 *   segment's own end) at the very first output frame and frame `a-1` at the
 *   last. The mirror of `floor` is **`ceil - 1`**, which maps `(a, b]` onto
 *   exactly `[a, b-1]` — the same frames, in the opposite order.
 *
 * That is also precisely what the export produces: ffmpeg's `reverse` emits
 * the trimmed window's real decoded frames last-to-first, i.e. `b-1 … a`. The
 * two agree by construction, and `speedRamp.ffmpeg.test.ts` proves it against
 * decoded pixels.
 */
export function quantizedSourceFrameAtOutput(
  segments: readonly SpeedSegment[],
  outputPos: number,
): number {
  const raw = sourceFrameAtOutput(segments, outputPos);
  return segmentSpeedAtOutput(segments, outputPos) < 0 ? Math.ceil(raw) - 1 : Math.floor(raw);
}

/** Which segment's speed governs OUTPUT position `outputPos` — the sign the
 *  quantiser above needs. Outside the ramp the first/last segment governs, for
 *  the same reason both maps extrapolate there. */
function segmentSpeedAtOutput(segments: readonly SpeedSegment[], outputPos: number): number {
  if (segments.length === 0) return 1;
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const outLen = segmentOutputLength(s);
    if (outputPos < acc + outLen || i === segments.length - 1) return s.speed;
    acc += outLen;
  }
  return segments[segments.length - 1].speed;
}

/**
 * How much OUTPUT the ramp's **first** `sourceFrames` source frames occupy, in
 * playback order — the length of a fade-in, in the axis the fade actually runs
 * on.
 *
 * **Why this is not `outputAtSourceFrame(source_start + n)` (D-240).** That
 * spelling — which is what B-112 correctly introduced — asks "when does the
 * ramp REACH this source frame". For a forward ramp the frame `n` past the
 * in-point is the frame `n` past the playback start, so the two questions have
 * the same answer and this function returns exactly what B-112's expression
 * did (pinned by the whole pre-D-240 fade suite passing unchanged).
 *
 * Under a REVERSED run they are different questions with different answers.
 * A clip playing wholly backwards *starts* on its last source frame, so
 * `outputAtSourceFrame(source_start)` is the clip's END, and using it would
 * put the fade-in at the tail and collapse `lenSec` to zero — a fade
 * expression that divides by it then produces a silently broken export. A fade
 * is a window on what the viewer sees, so it is measured in playback order,
 * which is what this walks.
 *
 * A count past the whole ramp saturates at the ramp's own output length.
 */
export function outputSpanOfLeadingSource(
  segments: readonly SpeedSegment[],
  sourceFrames: number,
): number {
  let remaining = Math.max(0, sourceFrames);
  let out = 0;
  for (const s of segments) {
    const len = Math.max(0, s.endSourceFrame - s.startSourceFrame);
    const take = Math.min(remaining, len);
    out += take / Math.abs(s.speed);
    remaining -= take;
    if (remaining <= 0) break;
  }
  return out;
}

/** The mirror of [`outputSpanOfLeadingSource`]: how much OUTPUT the ramp's
 *  **last** `sourceFrames` source frames occupy, in playback order — the
 *  length of a fade-out. Same argument, walked from the far end. */
export function outputSpanOfTrailingSource(
  segments: readonly SpeedSegment[],
  sourceFrames: number,
): number {
  let remaining = Math.max(0, sourceFrames);
  let out = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    const len = Math.max(0, s.endSourceFrame - s.startSourceFrame);
    const take = Math.min(remaining, len);
    out += take / Math.abs(s.speed);
    remaining -= take;
    if (remaining <= 0) break;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// ffmpeg compilation — the export side of the same math
// --------------------------------------------------------------------------- //

/** Round a seconds value for emission into a filtergraph. Six decimals is
 *  ~1µs — three orders of magnitude finer than a frame at any real rate — and
 *  keeps the generated expression readable and stable across platforms
 *  instead of carrying a full f64's worth of trailing digits. */
function sec(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The `setpts` expression body for this ramp: given the decoded frame's own
 * source time, the output time it belongs at.
 *
 * Returned WITHOUT the `setpts=` prefix and without the `/TB` divisor or the
 * placement term — `buildClipFilterChain` splices those on, because it also
 * has to add `inputStartSec` and wants one single `setpts` node for both.
 *
 * `clipFps` converts the segment boundaries (source FRAMES) into the seconds
 * ffmpeg's own `T` variable is expressed in. The input has already been
 * `-ss`-trimmed to the clip's in-point, so source time `0` here is
 * `source_start` — every boundary is emitted relative to that.
 *
 * A flat ramp returns `null`: the caller keeps its pre-D-236 `PTS/<speed>`
 * form, which is both shorter and byte-identical to what every existing
 * export already produces.
 *
 * **A ramp containing a REVERSED run also returns `null` (D-240)**, and for a
 * reason of a different kind: no `setpts` expression plays a clip backwards.
 * `setpts` only relabels the timestamp of a frame the decoder already handed
 * over in decode order, so a descending slope emits descending timestamps and
 * the encoder either drops or reorders them — the frames themselves are never
 * reversed. That needs ffmpeg's `reverse` filter, which buffers a window and
 * re-emits it last-to-first, i.e. a different filtergraph SHAPE rather than a
 * different expression. `buildClipFilterChain` checks
 * [`hasReverseSegments`] first and takes that path; this function is only
 * reached for a forward ramp, and the guard here is a second lock on the same
 * door rather than a case anyone relies on.
 */
export function rampSetptsSecondsExpr(
  segments: readonly SpeedSegment[],
  clipFps: number,
): string | null {
  if (isFlatSegments(segments) || hasReverseSegments(segments)) return null;
  const origin = segments[0].startSourceFrame;
  // The knots of the piecewise-linear forward map, in SECONDS on both axes:
  // `inSec` is the decoded frame's own source time relative to the clip's
  // in-point (what ffmpeg's `T` holds, since the input was `-ss`-trimmed
  // there); `outSec` is where that instant lands on the output.
  //
  // `outputAtSourceFrame` returns SOURCE-FRAME units, so every value it
  // produces is divided by `clipFps` exactly once, here — the single place
  // this expression crosses from the model's frame space into ffmpeg's
  // seconds. The per-segment slope is `d(outSec)/d(inSec) = 1/speed`, which
  // is unitless and needs no conversion.
  const knots = segments.map((s) => ({
    inSec: sec((s.startSourceFrame - origin) / clipFps),
    outSec: sec(outputAtSourceFrame(segments, s.startSourceFrame) / clipFps),
    slope: sec(1 / s.speed),
  }));

  // Built here rather than through `ffmpegExpr`'s `piecewiseLinearExpr`
  // because that helper HOLDS past its last point — correct for a keyframed
  // property, actively wrong for a timestamp, where holding would collapse
  // every trailing frame onto one PTS. The final segment's own slope is
  // continued instead, which is also what makes this agree with
  // `outputAtSourceFrame`'s documented extrapolation.
  const lastKnot = knots[knots.length - 1];
  let expr = `${lastKnot.outSec}+(T-${lastKnot.inSec})*${lastKnot.slope}`;
  for (let i = knots.length - 2; i >= 0; i--) {
    const term = `${knots[i].outSec}+(T-${knots[i].inSec})*${knots[i].slope}`;
    expr = `if(lt(T,${knots[i + 1].inSec}),${term},${expr})`;
  }
  return expr;
}

/** One resolved run, restated in SECONDS relative to the clip's own in-point
 *  — the unit both ffmpeg `trim`/`atrim` and `chroma_media`'s live mixer take.
 *  `speed` carries its sign, so a negative entry is a reversed run. */
export interface SpeedSegmentSeconds {
  startSec: number;
  endSec: number;
  speed: number;
}

/** The ramp's runs as SECONDS windows relative to the clip's own in-point,
 *  each paired with the (signed) speed that plays it.
 *
 *  Consumed by all three retiming compilers, which is why it is not named for
 *  any one of them: `timelineExportAudio.ts`'s `atrim`/`atempo`/`areverse`/
 *  `concat` chain, `timelineExport.ts`'s `trim`/`reverse`/`setpts`/`concat`
 *  chain for a reversed picture (D-240), and `chroma::audio`'s live
 *  `AudioSpeedSegment` list for the preview mixer (D-241).
 *
 *  The seconds axis is the SOURCE one — the input has been `-ss`-trimmed to
 *  the clip's in-point, so source second `0` is `source_start`, and the live
 *  mixer's own source is opened at the same place.
 *
 *  This shape is the reason the whole model is piecewise CONSTANT: `atempo`
 *  takes a number, not an expression, so a time-varying tempo can only ever be
 *  expressed as a concatenation of constant-tempo runs. */
export function rampSegmentSeconds(
  segments: readonly SpeedSegment[],
  clipFps: number,
): SpeedSegmentSeconds[] {
  const origin = segments[0]?.startSourceFrame ?? 0;
  return segments.map((s) => ({
    startSec: sec((s.startSourceFrame - origin) / clipFps),
    endSec: sec((s.endSourceFrame - origin) / clipFps),
    speed: s.speed,
  }));
}
