/**
 * @chroma/editor — the real audio half of the timeline→ffmpeg export
 * compiler (D-197, `docs/notes/audio-export-mixing.md`).
 *
 * What it is: the pure math `timelineExport.ts`'s `buildExportFfmpegArgs`
 * needs to mix gain (D-057), ducking (D-149) and fades (D-147) into the
 * export's ffmpeg filtergraph, replicating — not re-inventing — the exact
 * semantics `app/src-tauri/src/chroma/audio.rs` / `crates/chroma-media/src/
 * audio.rs` already implement for live playback:
 *
 * - `fadeGainAt`/`fadeGainExpr` mirror `chroma_types::fade_gain`/
 *   `FadeCurve::eval` (the cubic-bezier Newton-Raphson-then-bisection solve)
 *   field-for-field. ffmpeg's own expression language has no bezier-root
 *   solver, so the fade curve is SAMPLED at a fine resolution and fed through
 *   `ffmpegExpr.ts`'s shared piecewise-linear builder — a deliberate,
 *   documented approximation of the CONTINUOUS curve (not of the algorithm:
 *   `fadeGainAt` itself is exact), with error bounded by the sample count
 *   (`FADE_SAMPLE_STEPS`) and imperceptible for any fade window a human would
 *   actually author.
 * - `buildDuckSegments`/`duckGainExpr` mirror `chroma_media::audio::
 *   DuckEnvelope` EXACTLY — no sampling needed here, because the one-pole
 *   smoother's closed form (`target + (entry-target)*exp(-(t-t0)/tau)`) is
 *   directly expressible in ffmpeg's own expression language (`exp` is a
 *   real supported function), so this is a precise reproduction, not an
 *   approximation.
 * - `resolveDuckForTrack` mirrors `chroma::edit::resolve_track_duck` +
 *   `chroma_timeline::Track::clip_spans_from` — **using the CORRECTED
 *   fps-aware frame math this session's B-075/B-077/D-194 already established
 *   for video** (`endFrame`, timeline.ts), not the still-buggy conflation
 *   B-079 documents in the live Rust playback path today. This is a
 *   deliberate improvement over live playback's own current defect, not a
 *   new interpretation of what ducking MEANS — see D-197's own decision entry
 *   for why replicating a known bug into new code would be the wrong call.
 *
 * - `clipAudioParam`/`panGainExprs` (D-223) mirror `chroma_media::audio::
 *   LevelEnvelope` + `chroma_types::pan_gains` — a clip's OWN volume and
 *   stereo pan. Neither is sampled: an automation curve IS piecewise-linear
 *   (so `piecewiseLinearExpr` reproduces it exactly), and ffmpeg's expression
 *   language has `cos`/`sin`/`PI`/`clip`, so the constant-power pan law is
 *   written AS the law rather than approximated. This is the one part of the
 *   chain that is not a single scalar per source: a pan needs different gains
 *   on the two channels, so `buildAudioSourceChain` forks into
 *   `channelsplit`/`join` for it — see that function for why ffmpeg's own
 *   `pan` filter cannot be used (it takes no expressions, so it cannot express
 *   a keyframed pan).
 *
 * What it does NOT do: decide WHICH clips contribute audio at all (that is
 * `timelineExport.ts`'s `hasAudioOverrides`-driven walk — this module never
 * sees a `Timeline`'s tracks directly except inside `resolveDuckForTrack`,
 * which only reads clip *positions*, never decides inclusion), build the
 * final `-i`/`amix`/`asoftclip` graph (also `timelineExport.ts`), or touch
 * video at all. Pure — no I/O, no Tauri, no React, matching `timelineExport
 * .ts`'s own module contract.
 */

import type { Clip, FadeCurve, Timeline, Track } from './timeline';
import {
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_FADE_CURVE,
  clampClipPan,
  clampClipVolume,
  endFrame,
  panGains,
} from './timeline';
import { piecewiseLinearExpr, type ExprPoint } from './ffmpegExpr';

// --------------------------------------------------------------------------- //
// fade — a sampled approximation of the exact cubic-bezier curve
// --------------------------------------------------------------------------- //

/** Newton-Raphson iteration cap — mirrors `chroma_types::fade::
 *  NEWTON_ITERATIONS` (WebKit's own number, see that constant's own doc). */
const NEWTON_ITERATIONS = 8;
/** Bisection fallback cap — mirrors `chroma_types::fade::BISECTION_ITERATIONS`. */
const BISECTION_ITERATIONS = 32;
/** Convergence tolerance — mirrors `chroma_types::fade::EPSILON`. */
const EPSILON = 1e-7;

function bezier(t: number, p1: number, p2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

function bezierSlope(t: number, p1: number, p2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

function solveTForX(x: number, x1: number, x2: number): number {
  let t = x;
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const err = bezier(t, x1, x2) - x;
    if (Math.abs(err) < EPSILON) return t;
    const slope = bezierSlope(t, x1, x2);
    if (Math.abs(slope) < EPSILON) break;
    const next = t - err / slope;
    if (next < 0 || next > 1) break;
    t = next;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const err = bezier(t, x1, x2) - x;
    if (Math.abs(err) < EPSILON) return t;
    if (err > 0) hi = t;
    else lo = t;
    t = (lo + hi) / 2;
  }
  return t;
}

/** `y` at normalised progress `x` — mirrors `chroma_types::FadeCurve::eval`
 *  field-for-field (same clamping, same short-circuit at the exact
 *  endpoints, same Newton-then-bisection solve). */
export function fadeCurveEval(curve: FadeCurve, x: number): number {
  if (!Number.isFinite(x)) return 1;
  const xc = Math.min(1, Math.max(0, x));
  if (xc <= 0) return 0;
  if (xc >= 1) return 1;
  const x1 = Math.min(1, Math.max(0, curve.x1));
  const x2 = Math.min(1, Math.max(0, curve.x2));
  const t = solveTForX(xc, x1, x2);
  return bezier(t, curve.y1, curve.y2);
}

/** The fade multiplier at `pos` for a clip of length `len`, fade windows
 *  `fadeIn`/`fadeOut` — mirrors `chroma_types::fade_gain` field-for-field,
 *  including its overlapping-windows-multiply and no-fade-configured
 *  short-circuit. All in the SAME unit (this module always calls it with
 *  seconds — see `fadeGainExpr`). */
export function fadeGainAt(
  pos: number,
  len: number,
  fadeIn: number,
  fadeOut: number,
  inCurve: FadeCurve,
  outCurve: FadeCurve,
): number {
  const fi = Number.isFinite(fadeIn) ? fadeIn : 0;
  const fo = Number.isFinite(fadeOut) ? fadeOut : 0;
  if (fi <= 0 && fo <= 0) return 1;
  if (!Number.isFinite(pos) || !Number.isFinite(len) || len <= 0) return 1;
  let g = 1;
  if (fi > 0 && pos < fi) g *= fadeCurveEval(inCurve, pos / fi);
  if (fo > 0) {
    const fromEnd = len - pos;
    if (fromEnd < fo) g *= fadeCurveEval(outCurve, fromEnd / fo);
  }
  return Math.min(1, Math.max(0, g));
}

/** How many samples cover EACH fade window (in + out separately) when
 *  building the piecewise-linear ffmpeg approximation below — 20 segments
 *  per window keeps the worst-case error from a cubic-bezier's curvature
 *  imperceptible (well under 1% of full scale for any of the four built-in
 *  presets) while keeping the generated expression's size reasonable, the
 *  same size/fidelity trade-off `keyframeExprAt`'s own callers already
 *  accept for animated position/scale. */
const FADE_SAMPLE_STEPS = 20;

/**
 * The ffmpeg `volume` filter expression (in terms of `timeVar`, a seconds
 * quantity) approximating `fadeGainAt(t, len, fadeIn, fadeOut, ...)` as a
 * piecewise-linear function sampled at `FADE_SAMPLE_STEPS` points across
 * each configured window — see this module's own doc for why sampling
 * (ffmpeg has no bezier solver) rather than an approximation of the curve
 * SHAPE itself (each sampled value is the exact, real `fadeGainAt`).
 *
 * `null` when neither window is configured (`fadeIn <= 0 && fadeOut <= 0`)
 * — the caller skips the `volume` filter node entirely for this clip, the
 * same byte-identical-when-unused contract `fade_for_clip`'s own `None`
 * gives the live mixer.
 *
 * Windows that overlap (`fadeIn + fadeOut > len`, a legitimate "the whole
 * clip is one dip" authoring choice per `fade_gain`'s own doc) are handled
 * correctly because every sample point evaluates the real COMBINED
 * `fadeGainAt`, not one window's contribution in isolation — the two
 * windows' own sample grids are simply pooled, de-duplicated (points closer
 * than 1ns apart, a float-precision guard against two grids landing on
 * "the same" instant), and interpolated as one curve.
 */
export function fadeGainExpr(
  len: number,
  fadeIn: number,
  fadeOut: number,
  inCurve: FadeCurve,
  outCurve: FadeCurve,
  timeVar: string,
): string | null {
  if (!(fadeIn > 0) && !(fadeOut > 0)) return null;
  if (!(len > 0)) return null;

  const raw: number[] = [];
  if (fadeIn > 0) {
    const w = Math.min(fadeIn, len);
    for (let i = 0; i <= FADE_SAMPLE_STEPS; i++) raw.push((i / FADE_SAMPLE_STEPS) * w);
  }
  if (fadeOut > 0) {
    const w = Math.min(fadeOut, len);
    const start = Math.max(len - fadeOut, 0);
    for (let i = 0; i <= FADE_SAMPLE_STEPS; i++) raw.push(start + (i / FADE_SAMPLE_STEPS) * w);
  }
  raw.sort((a, b) => a - b);

  const ts: number[] = [];
  for (const t of raw) {
    if (ts.length === 0 || t - ts[ts.length - 1] > 1e-9) ts.push(t);
  }

  const points: ExprPoint[] = ts.map((t) => ({
    t,
    value: fadeGainAt(t, len, fadeIn, fadeOut, inCurve, outCurve),
  }));
  return piecewiseLinearExpr(points, timeVar);
}

// --------------------------------------------------------------------------- //
// duck — an exact reproduction of the one-pole smoother (ffmpeg's `exp()`
// makes the closed form directly expressible, no sampling needed)
// --------------------------------------------------------------------------- //

/** Mirrors `chroma_media::audio::MIN_DUCK_TAU_SECS`. */
const MIN_DUCK_TAU_SECS = 1e-6;

/** One piecewise segment of the smoothed duck-presence signal — mirrors
 *  `chroma_media::audio::DuckSegment` field-for-field. */
export interface DuckSegment {
  t0: number;
  target: number;
  entry: number;
  tau: number;
}

function decay(from: number, target: number, elapsed: number, tau: number): number {
  return target + (from - target) * Math.exp(-elapsed / tau);
}

/** Mirrors `chroma_media::audio::db_to_linear`. */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/** The resolved duck for one track — its precomputed segments plus the
 *  linear gain to reach while fully ducked. `resolveDuckForTrack` returns
 *  `null` (not this) for every "no real ducking applies" case. */
export interface DuckResolution {
  segments: DuckSegment[];
  duckedGain: number;
}

/** Build the duck envelope's segments — mirrors `chroma_media::audio::
 *  DuckEnvelope::new` field-for-field (same points construction, same
 *  entry-chaining continuity, same attack-vs-release-by-target selection,
 *  same `duck_db === 0` / empty-spans short-circuits to `null`).
 *  `triggerSpans` are `[start, end)` SESSION-RELATIVE SECONDS, already
 *  sorted and non-overlapping (`resolveDuckForTrack` below is the one real
 *  caller and gives it exactly that). */
export function buildDuckSegments(
  triggerSpans: Array<[number, number]>,
  duckDb: number,
  attackMs: number,
  releaseMs: number,
): DuckResolution | null {
  const db = Number.isFinite(duckDb) ? duckDb : 0;
  if (db === 0) return null;

  const tau = (ms: number) => {
    const s = Number.isFinite(ms) ? ms / 1000 : 0;
    return Math.max(s, MIN_DUCK_TAU_SECS);
  };
  const attackTau = tau(attackMs);
  const releaseTau = tau(releaseMs);

  const points: Array<[number, number]> = [];
  for (const [s, e] of triggerSpans) {
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= 0 || e <= s) continue;
    points.push([Math.max(s, 0), 1]);
    points.push([e, 0]);
  }
  if (points.length === 0) return null;
  if (points[0][0] > 0) points.unshift([0, 0]);

  const segments: DuckSegment[] = [];
  let entry = points[0][1];
  for (let i = 0; i < points.length; i++) {
    const [t0, target] = points[i];
    const segTau = target >= 0.5 ? attackTau : releaseTau;
    segments.push({ t0, target, entry, tau: segTau });
    const next = points[i + 1];
    if (next) entry = decay(entry, target, Math.max(next[0] - t0, 0), segTau);
  }
  return { segments, duckedGain: dbToLinear(db) };
}

/**
 * The exact ffmpeg `volume` expression for `gain_at(t)` — mirrors
 * `chroma_media::audio::DuckEnvelope::{presence_at,gain_at}` composed into
 * one expression: `1 + presence(t)*(duckedGain-1)` per segment, nested the
 * same "last segment innermost" way `piecewiseLinearExpr` builds a linear
 * ramp (segments are inherently ordered/contiguous here — the LAST segment
 * covers everything from its own `t0` onward, with no upper bound, which is
 * exactly `DuckEnvelope::presence_at`'s own `partition_point`-then-
 * `saturating_sub(1)` "last segment starting at or before `t`" contract).
 *
 * `timeVar` is a full sub-expression (e.g. `'(t+2.5)'`, not just `'t'`) so a
 * per-clip filter chain — whose own `t` is CLIP-local (0 at the clip's own
 * trimmed in-point) — can shift onto the SESSION-relative seconds this
 * envelope's `t0`/segments were computed in (see `resolveDuckForTrack`).
 */
export function duckGainExpr(segments: DuckSegment[], duckedGain: number, timeVar: string): string {
  const segExpr = (seg: DuckSegment): string =>
    `(1+(${seg.target}+(${seg.entry}-${seg.target})*exp(-(${timeVar}-${seg.t0})/${seg.tau}))*(${duckedGain}-1))`;

  let expr = segExpr(segments[segments.length - 1]);
  for (let i = segments.length - 2; i >= 0; i--) {
    expr = `if(lt(${timeVar},${segments[i + 1].t0}),${segExpr(segments[i])},${expr})`;
  }
  return expr;
}

/** `tr`'s own clips, as merged `[start, end)` TIMELINE-frame spans from frame
 *  0 — mirrors `chroma_timeline::Track::clip_spans_from(0)` field-for-field,
 *  **except** it uses `endFrame` (this session's B-075/B-077/D-194-corrected,
 *  fps-aware conversion) instead of the Rust method's own still-uncorrected
 *  `Clip::end_frame` (`start_frame + duration`, no `source_fps` conversion —
 *  B-079's own documented, not-yet-fixed defect in the LIVE playback path).
 *  Export is new code, not a patch to the live mixer, so there is no reason
 *  to carry a known bug into it — see D-197's own decision entry. */
function trackClipSpansFromZero(tr: Track, fps: number): Array<[number, number]> {
  const spans: Array<[number, number]> = tr.clips
    .map((c): [number, number] => [Math.max(c.start_frame, 0), endFrame(c, fps)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * Resolve `timeline.tracks[trackIndex]`'s own ducking (D-149) for a WHOLE
 * export session starting at frame 0 — mirrors `chroma::edit::
 * resolve_track_duck` + `Track::clip_spans_from` composed with
 * `DuckEnvelope::new`, the exact real playback semantics (not a new
 * interpretation): no `duck_from` set, a `duck_from` pointing at itself, a
 * `duck_from` naming no real track, or a `duck_db === 0` all resolve to
 * `null` — "no ducking for this track", every ordinary, non-error reason
 * `resolve_track_duck` itself lists.
 */
export function resolveDuckForTrack(tl: Timeline, trackIndex: number, fps: number): DuckResolution | null {
  const track = tl.tracks[trackIndex];
  if (!track) return null;
  const from = track.duck_from;
  if (from == null || from === trackIndex) return null;
  const trigger = tl.tracks[from];
  if (!trigger) return null;

  const framesSpans = trackClipSpansFromZero(trigger, fps);
  const spansSec: Array<[number, number]> = framesSpans.map(([s, e]) => [s / fps, e / fps]);
  return buildDuckSegments(
    spansSec,
    track.duck_db ?? 0,
    track.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS,
    track.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS,
  );
}

// --------------------------------------------------------------------------- //
// D-223 — per-clip volume + pan, static or keyframed
// --------------------------------------------------------------------------- //

/** One per-clip audio param's real shape for the export: a single number
 *  (never keyed, or keyed to one value everywhere) or a real automation
 *  expression in CLIP-LOCAL, POST-SPEED seconds.
 *
 *  Two cases rather than always an expression, because the static one is what
 *  keeps the common export byte-identical: a number folds into the existing
 *  single `volume=<n>` node (or, for pan, into two constants) instead of
 *  making ffmpeg re-evaluate an expression every frame for a value that never
 *  changes. */
export type ClipAudioParamValue =
  | { kind: 'static'; value: number }
  | { kind: 'keys'; expr: string };

/**
 * Resolve one per-clip audio param (`'volume'` / `'pan'`) for the export.
 *
 * Keyframes are read out of `clip.chroma_keyframes` under the param's own
 * name and rebased on `source_start` — the clip's input is already
 * `-ss`-trimmed to its in-point, so its `t` is 0 there, whereas a keyframe's
 * `frame` is a SOURCE frame. (That rebase is deliberately NOT what
 * `timelineExport.ts`'s own `keyframeExprAt` does for the picture: its
 * expressions are consumed inside `overlay`, whose `t` is timeline time, not
 * clip time. Two different time bases, each correct for its own filter.)
 *
 * Interpolation is `piecewiseLinearExpr` — linear between keys, held flat
 * outside — which is exactly what `chroma_media::audio::LevelCurve::value_at`
 * does in the live mixer and what `interpolate_param` does for the Inspector's
 * own readout. No sampling and no approximation here, unlike a fade's bezier:
 * an automation curve IS piecewise-linear.
 *
 * Keys that all hold the identity collapse back to `static` — the same
 * `LevelEnvelope::new` short-circuit the mixer applies, so an agent that keyed
 * volume at 1.0 twice costs the export nothing either.
 */
export function clipAudioParam(
  clip: Clip,
  param: 'volume' | 'pan',
  identity: number,
  clipFps: number,
  speed: number,
): ClipAudioParamValue {
  const keys = (clip.chroma_keyframes ?? [])
    .filter((k) => Object.prototype.hasOwnProperty.call(k.params, param))
    .map((k) => ({
      t: (k.frame - clip.source_start) / clipFps / speed,
      value: Number(k.params[param]),
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value))
    .sort((a, b) => a.t - b.t);

  if (keys.length === 0 || keys.every((k) => k.value === identity)) {
    const stored = clip[param];
    return { kind: 'static', value: Number.isFinite(stored) ? (stored as number) : identity };
  }
  return { kind: 'keys', expr: piecewiseLinearExpr(keys, 't') };
}

/**
 * The two per-channel gain expressions for a pan expression — the ffmpeg
 * mirror of `chroma_types::pan_gains`, written as the law itself rather than
 * as sampled points: ffmpeg's own expression language has `cos`, `sin`, `PI`
 * and `clip`, so the constant-power curve is expressible EXACTLY, the same way
 * `duckGainExpr`'s `exp` is (and unlike the fade's bezier root-solve, which
 * has to be sampled).
 *
 * That exactness matters here specifically because the pan value is what gets
 * interpolated, not the gains: interpolating the two GAINS linearly between
 * keys would cut the corner off the constant-power arc and quietly dip the
 * level mid-sweep. Applying the law to the interpolated pan is what the live
 * mixer does per sample-frame, and this is the same composition.
 *
 * `clip(...)` reproduces `pan_gains`' own `[-1, 1]` clamp. The one difference
 * from Rust, stated: `pan_gains` short-circuits an exact `0.0` to a bit-exact
 * `(1, 1)`, while `cos(PI/4)*√2` evaluates to 0.9999999999999999 — a 1e-16
 * relative difference, ~320 dB below anything audible, and unreachable for a
 * clip that is centred throughout (this whole chain is skipped for it).
 */
export function panGainExprs(panExpr: string): [string, string] {
  const theta = `((clip(${panExpr},-1,1)+1)*PI/4)`;
  return [`${Math.SQRT2}*cos(${theta})`, `${Math.SQRT2}*sin(${theta})`];
}

// --------------------------------------------------------------------------- //
// atempo — keep a speed-overridden clip's embedded/attached audio in sync
// --------------------------------------------------------------------------- //

/**
 * Decompose `speed` into a chain of ffmpeg `atempo` factors each within its
 * documented `[0.5, 2.0]` per-instance range — the standard, real technique
 * (ffmpeg's own FAQ recommends exactly this) for a speed change outside that
 * single-filter range, not a workaround invented here. `speed` is assumed
 * `> 0` (every real caller already validates this the same way
 * `speedOverrides` itself does).
 */
export function atempoFactors(speed: number): number[] {
  const MIN = 0.5;
  const MAX = 2.0;
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > MAX) {
    factors.push(MAX);
    remaining /= MAX;
  }
  while (remaining < MIN) {
    factors.push(MIN);
    remaining /= MIN;
  }
  factors.push(remaining);
  return factors;
}

/** The `atempo=...,atempo=...` filter-chain fragment (no leading `[in]`/
 *  trailing `[out]` labels — the caller splices those on) for `speed`. */
export function atempoFilterChain(speed: number): string {
  return atempoFactors(speed)
    .map((f) => `atempo=${f}`)
    .join(',');
}

// --------------------------------------------------------------------------- //
// buildAudioSourceChain — one clip's full audio filter chain
// --------------------------------------------------------------------------- //

/** Where one audio source ends up feeding the final mix — see
 *  `timelineExport.ts`'s own use for why this is two shapes rather than
 *  always a bracketed filtergraph label: a source with NOTHING to apply
 *  (unity gain, no fade, no duck, no delay — a clip sitting at frame 0 with
 *  none of D-057/D-147/D-149 configured, the overwhelmingly common case for
 *  a project with exactly one audio-contributing clip) needs no filter node
 *  at all and can be `-map`ped straight off its own input. */
export type AudioRef =
  | { kind: 'raw'; inputIdx: number }
  | { kind: 'label'; label: string };

/** The bracketed form usable as a `[filter_complex]` chain input (both an
 *  `amix` input list entry and — for a `'raw'` ref — a valid filtergraph
 *  stream reference are the exact same syntax, `[N:a]`). */
export function audioRefBracket(ref: AudioRef): string {
  return ref.kind === 'raw' ? `[${ref.inputIdx}:a]` : `[${ref.label}]`;
}

/** The exact string to place after a bare `-map` (no filter_complex
 *  involvement for a `'raw'` ref — direct stream muxing, `N:a`, no
 *  brackets). */
export function audioRefMapArg(ref: AudioRef): string {
  return ref.kind === 'raw' ? `${ref.inputIdx}:a` : `[${ref.label}]`;
}

export interface AudioSourceChainArgs {
  /** This source's ffmpeg audio stream, e.g. `[3:a]` — either a video
   *  clip's own already-`-ss`/`-t`-trimmed input (embedded audio, no new
   *  `-i` needed) or a genuine audio-track clip's own dedicated input. */
  srcRef: string;
  clip: Clip;
  /** `clip.source_fps ?? <export fps>` — the same resolution every other
   *  source-frame-to-seconds conversion in `timelineExport.ts` uses. */
  clipFps: number;
  /** Linear gain multiplier: `1.0` (hardcoded) for a video clip's own
   *  embedded audio — D-057's real, documented scoping — or `track.gain`
   *  for a genuine audio-track clip. */
  gain: number;
  /** `speedOverrides[clip.id] ?? 1` — this source gets an `atempo` chain
   *  when not `1`, keeping it in sync with a sped-up picture (or simply
   *  honoring a caller's explicit speed request on a pure audio clip). */
  speed: number;
  /** This clip's real placement on the OUTPUT timeline, in seconds — what
   *  `adelay` shifts this source to. Already POST-speed (a clip's
   *  `start_frame` is unaffected by its own speed override — only its
   *  internal duration shrinks/grows). */
  startSec: number;
  /** This source's track's own resolved ducking, or `null` for none. */
  duck: DuckResolution | null;
  /** A unique label stem for this source's own intermediate filter nodes
   *  (`at<id>`, `v<id>`, `d<id>`) — the caller hands out one per audio
   *  source so labels never collide across the whole filtergraph. */
  idLabel: string;
}

/**
 * Build one audio source's real filter chain: `atempo` (if sped) → `volume`
 * (gain × fade × duck, whichever apply — folded into ONE expression/filter,
 * mirroring `chroma_media::audio::SourceEnvelopes::apply`'s own "they
 * multiply, and they share the pass" contract) → `adelay` (placing it at its
 * real position on the output timeline). Any step with nothing to do is
 * omitted entirely — the same "byte-identical when the feature isn't used"
 * discipline every other filter in `timelineExport.ts` already follows —
 * down to returning the caller's own `srcRef` completely untouched (as a
 * `'raw'` [`AudioRef`]) when NOTHING applies at all.
 *
 * Fade timing uses this source's own CLIP-LOCAL `t` (0 at the clip's own
 * in-point — matches how the input was `-ss`-trimmed, and how `fade_gain`'s
 * `pos` is defined for a clip rendered from its own start, unlike live
 * playback's mid-clip `offset_secs` case). Duck timing uses `t` SHIFTED onto
 * the session timeline (`t + startSec`) — a duck's trigger spans are real
 * timeline positions, not clip-relative. Both are expressed in POST-speed
 * seconds (each duration pre-divided by `speed`) precisely because `volume`
 * runs AFTER `atempo` in the chain, so the `t` it sees is already the real,
 * sped-up seconds axis — this is what keeps a duck or fade correctly timed
 * on a clip that ALSO has a `speedOverrides` entry, not just a documented gap.
 */
export function buildAudioSourceChain(args: AudioSourceChainArgs): { steps: string[]; ref: AudioRef } {
  const { srcRef, clip, clipFps, gain, speed, startSec, duck, idLabel } = args;
  const steps: string[] = [];
  let ref = srcRef;
  let hasFilter = false;

  if (speed !== 1 && speed > 0) {
    const label = `at${idLabel}`;
    steps.push(`${ref}${atempoFilterChain(speed)}[${label}]`);
    ref = `[${label}]`;
    hasFilter = true;
  }

  const effectiveSpeed = speed > 0 ? speed : 1;
  const lenSec = clip.duration / clipFps / effectiveSpeed;
  const fadeInSec = (clip.fade_in_frames ?? 0) / clipFps / effectiveSpeed;
  const fadeOutSec = (clip.fade_out_frames ?? 0) / clipFps / effectiveSpeed;
  const fadeExpr =
    fadeInSec > 0 || fadeOutSec > 0
      ? fadeGainExpr(lenSec, fadeInSec, fadeOutSec, clip.fade_in_curve ?? DEFAULT_FADE_CURVE, clip.fade_out_curve ?? DEFAULT_FADE_CURVE, 't')
      : null;
  const duckExpr = duck ? duckGainExpr(duck.segments, duck.duckedGain, `(t+${startSec})`) : null;

  // D-223 — this clip's own level. `volume` is one more factor in the same
  // product (`track.gain × clip.volume × fade × duck`, the exact order
  // `SourceEnvelopes::apply` multiplies them in); `pan` is the one stage that
  // is NOT the same number on both channels, so it forks the chain below.
  //
  // A STATIC clip volume folds straight into the track gain rather than
  // becoming a second factor — one number, exactly as the live mixer's own
  // `gains` slice and `LevelEnvelope` compose to, and it keeps a project that
  // uses neither feature on the same single `volume=<n>` node it had before.
  const volume = clipAudioParam(clip, 'volume', 1, clipFps, effectiveSpeed);
  const pan = clipAudioParam(clip, 'pan', 0, clipFps, effectiveSpeed);
  const staticGain = volume.kind === 'static' ? gain * clampClipVolume(volume.value) : gain;

  const factors: string[] = [];
  if (staticGain !== 1) factors.push(String(staticGain));
  // `max(…,0)` mirrors `chroma_types::clip_volume`'s floor — a negative
  // authored key would otherwise invert the waveform's phase, which is never
  // what "quieter" means.
  if (volume.kind === 'keys') factors.push(`max(${volume.expr},0)`);
  if (fadeExpr) factors.push(fadeExpr);
  if (duckExpr) factors.push(duckExpr);
  // Whether any factor is time-varying, i.e. whether `volume` needs
  // `eval=frame` (per-frame re-evaluation) rather than ffmpeg's default
  // parse-once. A static-only product stays the cheap, plain `volume=<number>`
  // node it was before this feature existed.
  const animated = Boolean(fadeExpr || duckExpr || volume.kind === 'keys');

  if (pan.kind === 'static' && clampClipPan(pan.value) === 0) {
    if (factors.length > 0) {
      const label = `v${idLabel}`;
      if (animated) {
        steps.push(`${ref}volume=eval=frame:volume='${factors.join('*')}'[${label}]`);
      } else {
        steps.push(`${ref}volume=${factors[0]}[${label}]`);
      }
      ref = `[${label}]`;
      hasFilter = true;
    }
  } else {
    // A real pan: split the source into its two channels, apply the shared
    // factors AND that channel's own pan-law gain to each, and join them back
    // into one stereo stream.
    //
    // **Why a split/join rather than ffmpeg's own `pan` filter**: `pan`'s
    // coefficients are parsed once, as numbers — it has no expression
    // evaluation at all, so it cannot express a KEYFRAMED pan (and this
    // feature's pan is keyframeable, exactly like every other clip property).
    // `volume` is the one gain filter in ffmpeg that takes a real per-frame
    // expression, so the pan is expressed as two of them. `stereotools`'
    // `balance_in`/`balance_out` are likewise static options.
    //
    // `aformat=channel_layouts=stereo` first because `channelsplit` on a MONO
    // source is an error, and a mono clip is exactly the case where panning is
    // most meaningful: the upmix duplicates the mono channel into both, which
    // is precisely what `chroma_media::audio::adapt_channels` does before the
    // live mixer's own pan, so a panned mono clip becomes stereo-positioned
    // mono in both paths rather than one of them.
    const [leftExpr, rightExpr] =
      pan.kind === 'static'
        ? (panGains(clampClipPan(pan.value)).map(String) as [string, string])
        : panGainExprs(pan.expr);
    // A keyframed pan is itself time-varying, so the per-channel `volume`
    // nodes need `eval=frame` even when nothing else does.
    const perFrame = animated || pan.kind === 'keys';
    const common = factors.length > 0 ? `${factors.join('*')}*` : '';
    const evalMode = perFrame ? 'eval=frame:' : '';
    const stereo = `s${idLabel}`;
    const left = `l${idLabel}`;
    const right = `r${idLabel}`;
    const leftOut = `lv${idLabel}`;
    const rightOut = `rv${idLabel}`;
    const joined = `p${idLabel}`;
    steps.push(`${ref}aformat=channel_layouts=stereo[${stereo}]`);
    steps.push(`[${stereo}]channelsplit=channel_layout=stereo[${left}][${right}]`);
    steps.push(`[${left}]volume=${evalMode}volume='${common}(${leftExpr})'[${leftOut}]`);
    steps.push(`[${right}]volume=${evalMode}volume='${common}(${rightExpr})'[${rightOut}]`);
    // An explicit `map` rather than `join`'s own channel-name guess: both
    // inputs are mono streams whose single channel is named the same thing, so
    // leaving it to the guess is leaving it to chance.
    steps.push(
      `[${leftOut}][${rightOut}]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[${joined}]`,
    );
    ref = `[${joined}]`;
    hasFilter = true;
  }

  const delayMs = Math.round(startSec * 1000);
  if (delayMs > 0) {
    const label = `d${idLabel}`;
    steps.push(`${ref}adelay=${delayMs}:all=1[${label}]`);
    ref = `[${label}]`;
    hasFilter = true;
  }

  if (!hasFilter) {
    // `srcRef` is always `[N:a]` — parse the index back out so the caller
    // can `-map N:a` directly with no filter_complex involvement at all.
    const m = /^\[(\d+):a\]$/.exec(srcRef);
    if (m) return { steps: [], ref: { kind: 'raw', inputIdx: Number(m[1]) } };
  }
  return { steps, ref: { kind: 'label', label: ref.slice(1, -1) } };
}
