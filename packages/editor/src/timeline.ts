/**
 * @chroma/editor — the edit model, mirrored from the `chroma-timeline` Rust
 * crate (D-041), plus pure edit ops for optimistic UI updates.
 *
 * The Rust `chroma_timeline_set` command stores whatever we send verbatim (no
 * server-side clamping), so these ops are authoritative for what lands on disk.
 * They mirror `chroma-timeline`'s clamp rules; a `chroma_timeline_get` refetch
 * after each save reconciles anything (e.g. a source frame count that only the
 * backend knows).
 *
 * D-045 (multiple named timelines): a project can now hold several
 * `Timeline`s with one active — `Timeline.id` (below) is how they're told
 * apart. That selection is a Rust-side concept this pass (`ProjectManifest.
 * active_timeline` in `app/src-tauri/src/chroma/project.rs`): `chroma_timeline_
 * get`/`_set`/`_frame` are unchanged here, they just transparently target
 * whichever timeline is active. No timeline-switcher UI yet (pass 3).
 *
 * D-051: `labelForOp` turns an `EditOp` into the human-readable label
 * `useEditorTimelineStore.applyOp` puts on the `@chroma/history` entry it
 * pushes for every op — kept here (pure, testable) rather than inline in the
 * store.
 *
 * D-058: `Clip.start_frame` — mirrors `chroma-timeline::Clip::start_frame`
 * (D-054). Before this, every op here still assumed the pre-D-054 world
 * (a clip's timeline position is *implicit*, the sum of every preceding
 * clip's duration — `chroma_timeline_set` stores what's sent, so this file,
 * not the Rust ops, is what actually ran for every edit made through this
 * UI). D-054 gave the crate an explicit, authoritative `start_frame` and
 * changed `trim_start`/`trim_end`'s real semantics to be gap-aware around
 * it, but nothing here was updated to match — new/modified clips were built
 * without the field at all (an absent JSON key, not a wrong value), and
 * every position was still derived from Vec order. See D-058 for the full
 * bug writeup (B-011, B-012); every op below now mirrors the Rust op of the
 * same name field-for-field (`trim_start`'s neighbor clamp, `trim_end`'s
 * neighbor clamp, `split`'s `start_frame` on the right half, `add_clip`'s
 * append-at-track-end position) so what this file computes and what
 * `chroma-timeline::lib.rs` would compute for the same input agree.
 *
 * D-070 (unified clip identity, `docs/notes/unified-clip-model.md`):
 * `Clip.media_id` mirrors the Rust crate's new field — `clipFromDraggedMedia`
 * sets it from the dragged Sources-panel item's id, so a clip created by
 * dragging onto this timeline already carries the pool-item link
 * `chroma::project`'s grade-file migration and "add to grading" convenience
 * both key off.
 *
 * D-222 (timeline markers, roadmap item 27): `Timeline.markers` +
 * `add_marker`/`remove_marker`/`set_marker`. Markers are real document
 * content — persisted and undoable through the ordinary `EditOp` path —
 * unlike D-216's `selection` and D-218's `previewView`, which are store-only
 * view state; the ops' own docs spell out why that split falls where it does.
 * `newMarker`/`resolveMarkerColor`/`MARKER_COLORS` are the shared
 * construction path the ruler's flag strip and the `editor_*_marker` MCP ops
 * both go through.
 *
 * D-226 (transitions, roadmap item 27, `docs/notes/transitions.md`):
 * `Track.transitions` + `add_transition`/`remove_transition`/`set_transition`,
 * mirroring `chroma_timeline::Transition`. A transition bridges a CUT — the two
 * clips stay abutting and never overlap, so nothing about this module's
 * placement/landing/gap rules (D-104's overlap rejection included) changes.
 * `transitionWindow`/`transitionHandles` are exact mirrors of the Rust methods
 * of the same name, integer halving and all, so the live preview and the ffmpeg
 * compiler cannot disagree by a frame about which frames a transition covers.
 * `checkTransition` is the one precondition the timeline's drop gesture, its
 * badge popover and the `editor_*_transition` MCP ops all go through — the
 * `checkLink` (D-138) shape, so a refusal message can never drift from what
 * `applyOp` enforces.
 */

// D-224 — the EQ band type and its Audio EQ Cookbook math live in `eq.ts`,
// one directory over rather than inline here, for the reason `PropertyRow`'s
// own extraction records: it is a self-contained body of DSP with three
// consumers (this model, the Inspector, the export compiler) and no dependency
// on the timeline at all, so the dependency runs `timeline.ts → eq.ts` and
// never back. Re-exported because `Clip.eq_bands` is typed by it and a caller
// working in the edit model should not have to know which file it came from —
// exactly what `chroma-timeline` does with `chroma_types::eq` on the Rust side.
import { captionLines, type CaptionCue, type CaptionStyle } from './caption';
// D-239 — the seven edit types' NAMES and display copy live in their own
// module, which imports nothing back from here (see its own doc), so this stays
// a one-way dependency exactly as `speedRamp.ts` below is.
import { dropEditTypeInfo, type DropEditType } from './editTypes';
import { clampEqBand, eqBandsForDisplay, type EqBand } from './eq';
// D-236 — the speed ramp's arithmetic lives in its own module, which imports
// only the `Clip` TYPE back from here (erased at build), so the runtime
// dependency stays one-way: `timeline.ts` -> `speedRamp.ts`, never a cycle.
import {
  MAX_SPEED,
  MIN_SPEED,
  normalizeSpeedPoints,
  outputAtSourceFrame,
  quantizedSourceFrameAtOutput,
  rampOutputSourceFrames,
  resolveSpeedSegments,
  type SpeedPoint,
} from './speedRamp';

export type {
  BiquadCoeffs,
  EqBand,
  EqBandKind,
} from './eq';
// D-229 — re-exported here so a consumer working with the edit model does not
// have to know which file the caption types came from, exactly as the EQ types
// above are.
export type { CaptionAlign, CaptionCue, CaptionStyle } from './caption';
// D-239 — same re-export courtesy as the caption/EQ types below: a consumer
// working in the edit model reaches for `DropEditType` alongside `EditOp`, and
// should not have to know it is defined one file over.
export type { DropEditType, DropEditTypeInfo } from './editTypes';
export { DROP_EDIT_TYPES, dropEditTypeInfo, editTargetIndexAt, isDropEditType } from './editTypes';
export {
  captionCharCount,
  captionCps,
  captionLayout,
  captionLines,
  resolveCaptionStyle,
  DEFAULT_CAPTION_FONT,
  DEFAULT_CAPTION_SIZE,
} from './caption';
export {
  EQ_BAND_COUNT,
  EQ_BAND_KIND_LABELS,
  EQ_BAND_KINDS,
  EQ_DEFAULT_Q,
  EQ_DESIGN_SAMPLE_RATE,
  EQ_MAX_FREQ_HZ,
  EQ_MAX_GAIN_DB,
  EQ_MAX_Q,
  EQ_MIN_FREQ_HZ,
  EQ_MIN_Q,
  biquadResponseDb,
  clampEqBand,
  defaultEqBands,
  describeEqBand,
  eqBandCoeffs,
  eqBandsForDisplay,
  eqKindUsesGain,
  eqResponseDb,
  hasActiveEq,
  isEqBandActive,
} from './eq';

export interface Rational {
  num: number;
  den: number;
}

/**
 * One entry of a clip's `chroma_keyframes` array — mirrors
 * `chroma::keyframes::Keyframe` (Rust) entry-for-entry.
 *
 * `frame` is in the clip's **own source frames**, the same axis
 * `Clip.source_start`/`duration` are in (see `clipSourceFrame`). `params` is
 * a loose `name -> value` map because different entries legitimately name
 * different subsets of properties — per-property keyframing (D-208) is
 * exactly that, and every reader filters by name before bracketing.
 *
 * `ease` (D-233) is the optional per-param easing of the segment that STARTS
 * at this key; see `Clip.chroma_keyframes`' own doc for the shape and
 * `chroma::keyframes::interpolate_param` for the semantics. It lives on the
 * model type here, beside `Clip`, rather than in `clipKeyframes.ts` where the
 * pre-D-233 version of this interface sat: three modules now read it
 * (`clipKeyframes.ts` to author and resolve, `timelineExport.ts` to compile,
 * `curveEditor.ts` to draw), and a shared model type belongs with the model.
 */
export interface ClipKeyframe {
  frame: number;
  params: Record<string, unknown>;
  ease?: Record<string, EaseCurve>;
}

/** Mirrors `chroma_timeline::Clip` (serde snake_case). */
export interface Clip {
  id: string;
  shot_id?: string | null;
  /** Pool-item back-link (D-070) — mirrors `chroma_timeline::Clip::media_id`.
   *  Set by `clipFromDraggedMedia` for a clip dropped from the Sources
   *  panel; absent/`null` for a clip built before D-070 (`Timeline::
   *  from_shots`), which only ever set `shot_id`. */
  media_id?: string | null;
  /** A/V link group (D-129) — mirrors `chroma_timeline::Clip::link_group`.
   *  The id of the group of clips this one is linked to; absent/`null` =
   *  unlinked, which is what every pre-D-129 clip deserializes to.
   *
   *  **On a video clip it additionally means "this clip's audio lives in a
   *  linked audio clip — don't play its embedded stream"** (Rust-side
   *  `chroma_audio_play` reads it for exactly that). See the Rust field's own
   *  doc for the full reasoning; this is the single fact "this video clip's
   *  sound has been externalized," which is what Premiere/Resolve mean by a
   *  linked A/V pair. */
  link_group?: string | null;
  name: string;
  source_path: string;
  source_start: number;
  duration: number;
  source_len: number;
  /** B-075/D-193 — the SOURCE media's own real frame rate, at the moment
   *  this clip was created from a probed media-pool item (`editor_add_clip`
   *  sets it from `MediaItem.video.fps`). `source_start`/`duration` (and a
   *  keyframe's `frame`) are documented as being in **source frames** — this
   *  is what actually converts them to real seconds. Absent on a clip
   *  created before this field existed, or one whose source was never
   *  successfully probed (`timelineExport.ts` falls back to the export's own
   *  `opts.fps`, which is only correct when the source happens to share the
   *  project's fps — the same silent-wrongness this field exists to close
   *  for the common case of mixed-fps source footage, e.g. two screen
   *  recordings at two different native frame rates composited together). */
  source_fps?: number;
  /** D-236 — the speed ramp: variable playback speed over this clip's own
   *  length, as a step function on the SOURCE axis. Absent/empty = flat 1x,
   *  which is every pre-D-236 clip.
   *
   *  Mirrors `chroma_timeline::Clip::speed_points`. All the arithmetic —
   *  resolution to concrete segments, the output-duration sum, and both
   *  directions of the time remap — lives in `speedRamp.ts` (and its Rust
   *  twin `chroma_timeline::speed_ramp`); nothing in this file interprets
   *  the raw points except through `endFrame`/`clipSourceFrameAt`, which is
   *  what keeps the preview and the exporter reading one definition.
   *
   *  **This is the generalisation of, not a rival to,
   *  `TimelineExportOptions.speedOverrides`** (D-183's export-time-only flat
   *  multiplier): a flat speed is a one-segment ramp, `resolveSpeedSegments`
   *  resolves both into the same shape, and the flat case still compiles to
   *  the identical pre-D-236 filtergraph. */
  speed_points?: SpeedPoint[];
  /** Timeline-absolute start frame (D-054/D-058) — see the module doc. */
  start_frame: number;
  /** Compositing transform (D-086/D-088, Phase 1/2 of the full-NLE P0
   *  effort) — mirrors `chroma_timeline::Clip`'s new fields exactly.
   *  `opacity`/`scale` default to `1.0` server-side (NOT `0.0` — see the
   *  Rust field's own doc for why `Clip` moved off `#[derive(Default)]`),
   *  `position_x`/`position_y`/`rotation` to `0.0`. Optional here the same
   *  way `Track.gain` already is — a pre-D-086 clip (or one this file
   *  builds without setting them) round-trips fine, `chroma_timeline_set`'s
   *  verbatim-storage contract means the server fills in real defaults on
   *  the next `chroma_timeline_get`.
   *
   *  **`position_x`/`position_y` are normalised (D-136), not absolute
   *  pixels** — a fraction of the project's own composition
   *  (`ProjectSettings.width`/`height`), the same per-axis convention
   *  `crop_left`/`crop_top` below already used. This closed B-043: before
   *  D-136 these were canvas pixels in a compositor canvas that changed size
   *  with the preview quality (960 scrubbing / 640 playing), so a PIP
   *  offset visibly moved and resized when you pressed Play. A pre-D-136
   *  `project.json`'s stored values are migrated once on load
   *  (`chroma::project::load_manifest`, schema-minor gated) — this file
   *  never sees the old unit. */
  opacity?: number;
  position_x?: number;
  position_y?: number;
  scale?: number;
  /** Independent per-axis box-size override (D-193,
   *  `docs/notes/independent-clip-size.md`) — mirrors `chroma_timeline::
   *  Clip::box_width`/`box_height`. A fraction of the OUTPUT COMPOSITION's
   *  own width/height, the SAME per-axis convention `position_x`/
   *  `position_y` already use — NOT a multiplier of the clip's own source
   *  resolution the way `scale` is. `null`/absent on either axis (every
   *  pre-D-193 clip, and the default for a freshly-added one) means "derive
   *  this axis from `scale`'s own natural-footprint formula instead," the
   *  byte-identical-to-pre-D-193 fallback both the Rust compositor
   *  (`chroma::edit::composite_layer_onto`) and `timelineExport.ts`'s
   *  `buildClipFilterChain` apply.
   *
   *  `null` as well as `undefined` for the same reason `Track.duck_from`'s
   *  own doc gives: `set_clip_transform` writes an explicit `null` to CLEAR
   *  an override back to "derive from scale", so a value that was once set
   *  and later cleared round-trips as a real `null`, not a missing key. */
  box_width?: number | null;
  box_height?: number | null;
  rotation?: number;
  /** Crop (D-132) — mirrors `chroma_timeline::Clip::crop_left`/`crop_top`/
   *  `crop_right`/`crop_bottom`. Four **normalised (0–1) edge insets** into
   *  the clip's own SOURCE frame: the fraction of the picture trimmed off
   *  that edge, all four `0` = uncropped. Optional here for the same reason
   *  the five fields above are — a pre-D-132 clip has no such key and the
   *  backend defaults it to `0`.
   *
   *  A fraction rather than pixels because the compositor decodes each
   *  layer at whatever preview scale the caller asked for (960 scrubbing /
   *  640 playing), so a pixel crop would cover a different part of the
   *  picture at each quality — see the Rust field's own doc. `position_x`/
   *  `position_y` above carried that same defect (B-043) until D-136. */
  crop_left?: number;
  crop_top?: number;
  crop_right?: number;
  crop_bottom?: number;
  /** D-086/D-132 — `[{frame, params: {opacity?, position_x?, position_y?,
   *  scale?, rotation?, crop_left?, crop_top?, crop_right?, crop_bottom?}}]`,
   *  the exact shape `utils/maskKeyframes.ts` already writes
   *  for mask/relight-light keyframes, reused verbatim rather than a
   *  second keyframe shape. `chroma::keyframes`'s D-034 engine
   *  (Rust-side) interpolates it at render time relative to the clip's own
   *  source frame — this file never interpolates it itself.
   *
   *  **D-233 — the optional `ease` map.** `{"<param>": {x1,y1,x2,y2}}`, naming
   *  per param the [`EaseCurve`] that shapes the segment running from THIS key
   *  to that param's NEXT key. Absent (the default, and every pre-D-233 key)
   *  means linear, so nothing about an existing project's stored shape or
   *  resolved values changed. It sits beside `params` rather than inside it
   *  because `params` is a flat `name -> number` map that three separate
   *  readers iterate with `Object.keys` to discover which properties are
   *  animated (`paramTrackIndex` here, `keyframeExprAt` in the exporter,
   *  `interpolate_param` in Rust) — a curve smuggled in under a mangled key
   *  would show up in all three as a phantom animated property. See
   *  `chroma::keyframes::interpolate_param` for why the curve is owned by the
   *  segment's start key rather than split into per-key in/out handles. */
  chroma_keyframes?: ClipKeyframe[];
  /** Fade in / out (D-147) — mirrors `chroma_timeline::Clip::fade_in_frames`
   *  / `fade_out_frames` / `fade_in_curve` / `fade_out_curve`.
   *
   *  How many frames at the head / tail of this clip its output ramps up /
   *  down over, and the cubic-bezier curve each ramp is shaped by. **One pair
   *  drives both picture and sound**: opacity on a video clip, gain on an
   *  audio clip, and both on a video clip that still carries its own embedded
   *  audio — which is what Premiere's and Resolve's single fade handle
   *  actually does. See the Rust field's own doc and
   *  `docs/notes/audio-fade-duck-crossfade-plan.md` §2.
   *
   *  Optional here for the same reason the transform fields are: absent on a
   *  pre-D-147 clip, defaulted server-side (`0` frames, `linear` curves) on
   *  the next `chroma_timeline_get`. Frames, not seconds — the unit every
   *  other number on this type is in. */
  fade_in_frames?: number;
  fade_out_frames?: number;
  fade_in_curve?: EaseCurve;
  fade_out_curve?: EaseCurve;
  /** Per-clip audio level (D-223) — mirrors `chroma_timeline::Clip::volume` /
   *  `pan`, this clip's OWN contribution to the mix, independent of
   *  `Track.gain`'s whole-track fader.
   *
   *  `volume` is a **linear** multiplier (`1` = unity), deliberately the same
   *  unit as `Track.gain` rather than dB — two level controls in one signal
   *  chain that disagree about their unit is a trap. `pan` is normalised:
   *  `-1` hard left · `0` centre · `1` hard right, through the constant-power
   *  (0 dB centre) law in `chroma_types::pan` / `panGains` here.
   *
   *  Both apply ONLY to sound: on an audio-track clip that is the whole clip,
   *  on a video clip it is its embedded audio (and nothing at all once that
   *  audio has been unlinked into its own clip — D-129). They compose
   *  multiplicatively with everything else: `track.gain × clip.volume × fade ×
   *  duck`, then pan splits per channel.
   *
   *  Both are keyframeable through `chroma_keyframes` under these exact names
   *  (see [`ClipAudioParam`]). Optional here for the same reason the transform
   *  fields are: absent on a pre-D-223 clip, defaulted server-side (`1` / `0`)
   *  on the next `chroma_timeline_get`. */
  volume?: number;
  pan?: number;
  /** Per-clip parametric EQ (D-224) — mirrors `chroma_timeline::Clip::eq_bands`,
   *  the next stage in the same per-clip audio chain `volume`/`pan` opened, and
   *  what Resolve's Inspector calls the Clip Equalizer.
   *
   *  A **list**, and absent/empty means no EQ. Not a fixed four even though
   *  the Inspector authors exactly Resolve's four-band strip
   *  ([`EQ_BAND_COUNT`]/`defaultEqBands`): each band carries its own `kind`, so
   *  a fixed index→role mapping would be a second source of truth for the same
   *  fact — see `chroma_timeline::Clip::eq_bands`' own doc for the full
   *  argument and for why an empty list needs no migration default where
   *  `volume` did.
   *
   *  **Static, not keyframeable**, unlike `volume`/`pan` — a stated decision,
   *  not an omission: ffmpeg's biquad filters parse their parameters once, as
   *  numbers, so an animated EQ is not expressible in the export at all. See
   *  D-224.
   *
   *  Sound only, exactly like `volume`/`pan`. */
  eq_bands?: EqBand[];
  /** Text/title layer (D-211) — mirrors `chroma_timeline::Clip::text`.
   *  Present (non-null) = this clip is a GENERATED text layer: its picture is
   *  rasterised from these properties rather than decoded from `source_path`
   *  (which is empty on such a clip). Absent/`null` = an ordinary media clip,
   *  which is every clip in every pre-D-211 project.
   *
   *  A `Clip` variant rather than a new `Track.kind` because a title in
   *  Resolve/Premiere is a generator clip on an ordinary video track above
   *  the picture, and track-index z-order already composites it there — see
   *  the Rust field's own doc and D-211 for the full comparison.
   *
   *  **Not every other field on this type applies to it.** `opacity` (with
   *  its fade) and `position_x`/`position_y` do, and are keyframeable exactly
   *  as on a media clip. `scale`/`rotation`/`box_width`/`box_height`/the four
   *  crop insets do NOT — neither renderer honours them for a text clip
   *  (`chroma::edit::resolve_text_clip_transform`, and `buildClipFilterChain`
   *  compiling to `drawtext`, which has no scale/rotate/crop at all). See
   *  `docs/notes/text-title-clips.md`. */
  text?: TextLayer | null;
  /** D-229 — present = this clip is one CAPTION on a `'subtitle'` track.
   *  Mirrors `chroma_timeline::Clip::caption`.
   *
   *  The cue's timing is this clip's own `start_frame`/`duration`, which is
   *  what makes every existing edit op (move, trim, split, remove, ripple,
   *  marquee, undo) work on a caption for free. **None of the geometry fields
   *  apply** — `position_*`, `scale`, `rotation`, the crop insets, `opacity`
   *  and the fades are all ignored by BOTH renderers; a caption is positioned
   *  and sized entirely by its resolved `CaptionStyle`. See the Rust field's
   *  own doc and D-229 for why that line is drawn there. */
  caption?: CaptionCue | null;
  /** Adjustment layer (D-230) — mirrors `chroma_timeline::Clip::adjustment`.
   *  Present (non-null) = this clip is an ADJUSTMENT CLIP: it contributes no
   *  picture of its own and instead applies a primary colour correction to
   *  everything composited BENEATH it, for the span it covers. `source_path`
   *  is empty on such a clip, as on a text clip. Absent/`null` = an ordinary
   *  clip, which is every clip in every pre-D-230 project.
   *
   *  A `Clip` variant rather than a new `Track.kind`, following `text`'s own
   *  precedent: Resolve puts an adjustment clip on an ordinary video track
   *  above the clips it affects, and track-index z-order already means
   *  "beneath". The genuinely new part is the compositing MODEL — an operator
   *  on the canvas so far, rather than a layer with pixels — see the Rust
   *  field's doc and D-230.
   *
   *  **Only `opacity` applies, and only statically.** It is the correction's
   *  mix amount (`0` = no effect, `1` = full). It is NOT keyframeable and NOT
   *  faded here, because the export compiles to `lutrgb`/`colorchannelmixer`
   *  coefficients, which ffmpeg fixes at filter init — a preview that animated
   *  what the export cannot is the B-053/B-095 defect class. `position_*`,
   *  `scale`, `rotation`, `box_*` and the crop insets do not apply at all: the
   *  correction is always full-frame. See `docs/notes/adjustment-clips.md`. */
  adjustment?: AdjustmentLayer | null;
}

/** The five-parameter primary correction an adjustment clip carries (D-230) —
 *  mirrors `chroma_types::adjustment::AdjustmentLayer` field for field.
 *
 *  Named in the Colorist's own vocabulary on purpose: an adjustment clip is
 *  emphatically NOT a second, parallel effects language. It is also not the
 *  Colorist grade itself, which is structurally unavailable here — that blob is
 *  untyped in Rust (D-020/D-025) and applied only by a wgpu shader the Edit
 *  tab's CPU preview does not run and ffmpeg could not reproduce. See D-230.
 *
 *  Every field is `0` at identity, so a freshly added adjustment clip changes
 *  nothing until something moves. All five are clamped to `-1..=1`. */
export interface AdjustmentLayer {
  /** Stops of exposure, `-1..=1`; a linear gain of `2^exposure`. */
  exposure: number;
  /** Contrast about the 0.5 pivot, `-1..=1`. */
  contrast: number;
  /** Saturation, `-1..=1`; `-1` is Rec.709 luma, `+1` is double. */
  saturation: number;
  /** Warm/cool, `-1..=1`; positive is warmer (red up, blue down). */
  temperature: number;
  /** Green/magenta, `-1..=1`; positive is magenta (green down). */
  tint: number;
}

/** The identity correction — what a newly added adjustment clip carries. */
export const IDENTITY_ADJUSTMENT: AdjustmentLayer = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
};

/** The five parameter names, in the order the Inspector shows them — one list
 *  so the GUI panel, the MCP tool's argument validation and the tests cannot
 *  drift apart about which parameters exist. */
export const ADJUSTMENT_PARAMS: readonly (keyof AdjustmentLayer)[] = [
  'exposure',
  'contrast',
  'saturation',
  'temperature',
  'tint',
] as const;

/** Build a valid [`AdjustmentLayer`], filling in defaults and clamping — the
 *  ONE place an adjustment layer is constructed or patched, shared by the GUI's
 *  Add-adjustment button, its Inspector and the `editor_add_adjustment_clip` /
 *  `editor_set_adjustment_clip` MCP ops (CLAUDE.md: "the same op/store action
 *  underneath both").
 *
 *  Returns `{ error }` rather than throwing or silently coercing, matching
 *  [`newTextLayer`] and every other validating helper on this surface. A
 *  non-finite value is a real caller error worth naming; an out-of-range one is
 *  clamped rather than rejected, matching the Rust side's `normalised()` (the
 *  model stores what the UI wrote and the consumer decides what it means). */
export function newAdjustmentLayer(
  patch: Partial<AdjustmentLayer>,
  base?: AdjustmentLayer | null,
): AdjustmentLayer | { error: string } {
  const from: AdjustmentLayer = base ?? { ...IDENTITY_ADJUSTMENT };
  const out = { ...from };
  for (const key of ADJUSTMENT_PARAMS) {
    const v = patch[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { error: `${key} must be a finite number in -1..1` };
    }
    out[key] = Math.min(1, Math.max(-1, v));
  }
  return out;
}

/** Whether a correction provably does nothing — so the compositor can skip a
 *  full-canvas pass and the exporter can emit no filter node at all, keeping a
 *  freshly-added, untouched adjustment clip byte-identical to having none.
 *  Mirrors `AdjustmentLayer::is_identity` in Rust. */
export function isIdentityAdjustment(layer: AdjustmentLayer): boolean {
  return ADJUSTMENT_PARAMS.every((k) => {
    const v = layer[k];
    return !Number.isFinite(v) || v === 0;
  });
}

/** The `NewClipFields` for an adjustment clip (D-230), ready to hand to the
 *  ordinary `add_clip` op — placed by exactly the same op a media or text clip
 *  is, so ripple / explicit `startFrame` / track creation all come for free and
 *  there is no second placement path to keep in step. Mirrors
 *  [`newTextClipFields`] exactly, including why `source_fps` stays unset. */
export function newAdjustmentClipFields(
  layer: AdjustmentLayer,
  durationFrames: number,
  name?: string,
): NewClipFields {
  const duration = Math.max(1, Math.round(durationFrames));
  return {
    id: `adjust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    shot_id: null,
    media_id: null,
    link_group: null,
    // Resolve labels these "Adjustment Clip" on the clip body — the reference
    // screenshot this feature was built from shows exactly that string.
    name: name || 'Adjustment Clip',
    source_path: '',
    source_start: 0,
    duration,
    source_len: duration,
    adjustment: layer,
  };
}

/** A generated text/title layer (D-211) — mirrors `chroma_timeline::TextLayer`
 *  field for field.
 *
 *  Phase 1 is Resolve's "basic title generator" (type your text, set
 *  font/size/colour), NOT its 100+ prebuilt animated Fusion templates —
 *  `docs/notes/text-title-clips.md` has the full deferred list. */
export interface TextLayer {
  /** The text to draw. **Single line** — a `\n` is rejected at the write path
   *  ([`newTextLayer`], the `set_text_clip` op, `editor_set_text_clip`).
   *  Deliberate, not an oversight: the live preview rasterises with
   *  `ab_glyph` and the export with ffmpeg's `drawtext`/libfreetype, and
   *  inter-line layout is the one thing those two genuinely disagree about.
   *  See the Rust type's own doc and D-213. */
  content: string;
  /** A font-family KEY from the backend's own catalogue (`chroma_text_fonts`)
   *  — `sans`, `sans-bold`, `serif`, … — not a path and not a system family
   *  name. The catalogue resolves a key to one real font FILE that BOTH
   *  renderers read: `ab_glyph` in the preview, `drawtext`'s `fontfile=` in
   *  the export. That shared file is why the two draw the same glyphs. */
  font: string;
  /** Font size as a fraction of the OUTPUT COMPOSITION's height — the same
   *  per-axis normalised convention `position_y`/`crop_top` already use, and
   *  for the same B-043 reason: the preview rasterises at 640/960 px while
   *  the export renders at full resolution, so a pixel size would mean a
   *  different fraction of the picture in each. */
  size: number;
  /** Fill colour, `#RGB` or `#RRGGBB`. Transparency is `Clip.opacity` (already
   *  keyframeable, already fade-multiplied), never a second alpha here. */
  color: string;
}

/** Mirrors `chroma_timeline::DEFAULT_TEXT_FONT`/`_SIZE`/`_COLOR` exactly — the
 *  one source of truth for what a freshly-added title looks like, on both the
 *  GUI and MCP paths. A disagreement with the Rust constants would mean a clip
 *  created here and one deserialised there were different titles. */
export const DEFAULT_TEXT_FONT = 'sans-bold';
/** ~12% of the frame height — a real title size, not a placeholder. */
export const DEFAULT_TEXT_SIZE = 0.12;
export const DEFAULT_TEXT_COLOR = '#FFFFFF';

/** How long a freshly-added title runs, in SECONDS, before the user trims it.
 *  Three seconds is the standard default duration a still/generator gets in
 *  every reference NLE (Premiere's own default still duration is 5s, Resolve's
 *  4s; 3s reads better for the short-form work this editor is built for) —
 *  a named constant rather than a magic number, per CLAUDE.md.
 *
 *  **Also the default span of a new ADJUSTMENT clip (D-230)**, deliberately
 *  sharing this constant rather than declaring a second one: both are
 *  generator clips with no source media to take a length from, which is
 *  exactly the case this number was chosen for (see "still/generator" above).
 *  The name is historical — it predates there being a second generator kind. */
export const DEFAULT_TITLE_SECONDS = 3;

/** Whether `c` is a generated text/title clip rather than a media clip
 *  (D-211). Mirrors `chroma_timeline::Clip::is_text` — one predicate, asked
 *  the same way everywhere, rather than an `!= null` check at each site. */
export function isTextClip(c: Pick<Clip, 'text'> | null | undefined): boolean {
  return c?.text != null;
}

/** D-230 — whether a clip is an ADJUSTMENT clip (an operator on the layers
 *  beneath it, with no picture of its own). [`isTextClip`]'s counterpart, and
 *  the one predicate every consumer branches on, mirroring
 *  `Clip::is_adjustment` in Rust. */
export function isAdjustmentClip(c: Pick<Clip, 'adjustment'> | null | undefined): boolean {
  return c?.adjustment != null;
}

/** B-129/D-262 — whether a clip is a GENERATED PICTURE clip: a title
 *  (D-211) or an adjustment clip (D-230). Both are built by
 *  [`clipFromDraggedGenerator`], both composite into the picture by track
 *  z-order, and both are therefore only meaningful on a `'video'` track —
 *  which is the one rule [`checkAddClip`] enforces. A caption is deliberately
 *  NOT one of these: it belongs on a `'subtitle'` track and D-229 already owns
 *  that placement. */
export function isGeneratedPictureClip(c: Pick<Clip, 'text' | 'adjustment'> | null | undefined): boolean {
  return isTextClip(c) || isAdjustmentClip(c);
}

/** D-229/D-230 — whether a clip contributes no decoded picture of its own,
 *  i.e. it is a text clip, a caption, or an adjustment clip. The predicate for
 *  "don't ask the media layer about this clip": it has no `source_path` to
 *  probe, decode, filmstrip or open an ffmpeg input for. Mirrors
 *  `Clip::is_generated` in Rust. */
export function isGeneratedClip(
  c: Pick<Clip, 'text' | 'caption' | 'adjustment'> | null | undefined,
): boolean {
  return isTextClip(c) || isCaptionClip(c) || isAdjustmentClip(c);
}

/** Build a valid [`TextLayer`], filling in the defaults and normalising what
 *  the model cannot store meaningfully — the ONE place a text layer is
 *  constructed or patched, shared by the GUI's Add-title button, its Inspector
 *  and the `editor_add_text_clip`/`editor_set_text_clip` MCP ops (CLAUDE.md:
 *  "the same op/store action underneath both").
 *
 *  Returns `{ error }` rather than throwing or silently coercing, matching
 *  every other validating helper on this surface. The three real rejections:
 *  a multi-line `content` (Phase 1 is single-line — see [`TextLayer.content`]),
 *  a non-positive `size` (would render nothing), and a `color` that is not
 *  `#RGB`/`#RRGGBB` (the Rust side falls back to white for an unparseable
 *  value, which is a safe *render*, but writing one is still a caller error
 *  worth naming rather than quietly ignoring). */
export function newTextLayer(
  patch: Partial<TextLayer>,
  base?: TextLayer | null,
): TextLayer | { error: string } {
  const from: TextLayer = base ?? {
    content: '',
    font: DEFAULT_TEXT_FONT,
    size: DEFAULT_TEXT_SIZE,
    color: DEFAULT_TEXT_COLOR,
  };
  const content = patch.content ?? from.content;
  if (typeof content !== 'string') return { error: 'content must be a string' };
  if (/[\r\n]/.test(content)) {
    return { error: 'content must be a single line — multi-line titles are not supported yet (D-213)' };
  }
  const size = patch.size ?? from.size;
  if (!Number.isFinite(size) || size <= 0) {
    return { error: 'size must be a positive fraction of the composition height (e.g. 0.12)' };
  }
  const color = patch.color ?? from.color;
  if (!/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    return { error: `color must be #RGB or #RRGGBB, got "${color}"` };
  }
  const font = patch.font ?? from.font;
  if (typeof font !== 'string' || !font) return { error: 'font must be a catalogue key, e.g. "sans-bold"' };
  return { content, font, size, color: color.startsWith('#') ? color : `#${color}` };
}

/** The `NewClipFields` for a title, ready to hand to the ordinary `add_clip`
 *  op (D-211) — a text clip is placed by exactly the same op a media clip is,
 *  so ripple / explicit `startFrame` / track creation all come for free and
 *  there is no second placement path to keep in step.
 *
 *  `durationFrames` is in TIMELINE frames and `source_fps` is deliberately
 *  left unset: a generated layer has no native rate, and `source_frames_to_
 *  timeline`'s own documented fallback for an absent `source_fps` is a 1:1
 *  ratio — which is exactly right here, so a title's `duration` really is its
 *  timeline footprint. `source_len` mirrors `duration` so a trim can still
 *  extend it back out to its original length, the same ceiling a media clip's
 *  source length gives. */
export function newTextClipFields(
  layer: TextLayer,
  durationFrames: number,
  name?: string,
): NewClipFields {
  const duration = Math.max(1, Math.round(durationFrames));
  return {
    id: `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    shot_id: null,
    media_id: null,
    link_group: null,
    // The title's own text is the natural clip name — what both references
    // show on the clip body in the timeline.
    name: name || layer.content || 'Title',
    source_path: '',
    source_start: 0,
    duration,
    source_len: duration,
    text: layer,
  };
}

/**
 * D-248 — the `NewClipFields` for a generator (`DraggedGenerator`), at the
 * project's own rate.
 *
 * **The one place a generated clip is built**, shared by the library rail's
 * click-to-add, the rail's drag-onto-the-timeline drop, and (through the same
 * factories it calls) `editor_add_text_clip`/`editor_add_adjustment_clip`. It
 * exists because a drag and a click MUST produce the identical clip — a title
 * you dropped and a title you clicked differing in duration or default layer
 * would be exactly the kind of two-implementations drift CLAUDE.md's "the same
 * op/store action underneath both" rule is about.
 *
 * Returns `{ error }` only for a failure the underlying layer factories can
 * report; this call site passes literals, so in practice it is a type narrow
 * rather than a real branch — but it is propagated rather than swallowed so a
 * future caller passing real user input gets the real message.
 */
export function clipFromDraggedGenerator(
  gen: DraggedGenerator,
  fps: number,
): NewClipFields | { error: string } {
  const duration = Math.max(1, Math.round(DEFAULT_TITLE_SECONDS * fps));
  if (gen.kind === 'title') {
    const layer = newTextLayer({ content: 'Title' });
    if ('error' in layer) return layer;
    return newTextClipFields(layer, duration);
  }
  const layer = newAdjustmentLayer({});
  if ('error' in layer) return layer;
  return newAdjustmentClipFields(layer, duration);
}

/** D-229 — whether `c` is a caption cue. The counterpart of [`isTextClip`],
 *  asked the same way everywhere for the same reason. */
export function isCaptionClip(c: Pick<Clip, 'caption'> | null | undefined): boolean {
  return c?.caption != null;
}

/** Build the `NewClipFields` for one caption cue — the ONE place a caption
 *  clip is constructed, shared by the `.srt` importer, the GUI's Add-caption
 *  button and `editor_add_caption` (CLAUDE.md: "the same op/store action
 *  underneath both").
 *
 *  No validation to fail: unlike [`newTextLayer`], a caption's text is
 *  deliberately allowed to be multi-line, and its style lives on the track. */
export function newCaptionClipFields(
  text: string,
  durationFrames: number,
  id?: string,
): NewClipFields {
  const duration = Math.max(1, Math.round(durationFrames));
  return {
    id: id ?? `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    shot_id: null,
    media_id: null,
    link_group: null,
    // The cue's own first line is the natural clip name — the reference shows
    // a caption clip labelled with its own text on the timeline.
    name: captionLines(text)[0] || 'Caption',
    source_path: '',
    source_start: 0,
    duration,
    source_len: duration,
    caption: { text },
  };
}

/** The nine scalar `Clip` fields that are BOTH independently keyframeable
 *  (`chroma_keyframes[].params` names them verbatim — `chroma::edit::
 *  resolve_clip_transform` reads each one out by exactly this string) and
 *  independently resettable from the Inspector (D-208).
 *
 *  `box_width`/`box_height` are deliberately NOT here even though the Rust
 *  resolver can interpolate them: they are a nullable, *paired* override
 *  fronted by a ratio lock (D-193), so neither "keyframe just this one axis"
 *  nor "reset just this one axis" is a well-defined single-field action —
 *  clearing them is what `Scale`'s own field already does. See D-208. */
export type ClipTransformParam =
  | 'opacity'
  | 'position_x'
  | 'position_y'
  | 'scale'
  | 'rotation'
  | 'crop_left'
  | 'crop_top'
  | 'crop_right'
  | 'crop_bottom';

/** Each keyframeable transform field's rest value — the ONE source of truth
 *  for the `?? 1` / `?? 0` fallbacks scattered through the Inspector and for
 *  D-208's per-property reset button, and matching `chroma_timeline::Clip`'s
 *  own server-side defaults exactly (that type moved off `#[derive(Default)]`
 *  precisely so `opacity`/`scale` could default to `1.0` rather than `0.0` —
 *  see `Clip.opacity`'s doc above). A reset that disagreed with these would
 *  write a value the backend would then treat as a real, non-default
 *  override. */
export const CLIP_TRANSFORM_DEFAULTS: Readonly<Record<ClipTransformParam, number>> = {
  opacity: 1,
  position_x: 0,
  position_y: 0,
  scale: 1,
  rotation: 0,
  crop_left: 0,
  crop_top: 0,
  crop_right: 0,
  crop_bottom: 0,
};

/** D-223 — the per-clip AUDIO properties, keyframeable and resettable exactly
 *  like the transform ones above, and named identically to their
 *  `chroma_timeline::Clip` fields (which is also the name their keyframes are
 *  stored under, so nothing has to translate).
 *
 *  Their own type rather than more members of [`ClipTransformParam`] for
 *  `set_clip_fade`'s own reason: a level is not geometry, it applies to
 *  audio-track clips that have no transform at all, and it is written by its
 *  own op — see the `'set_clip_audio'` op below. What they DO share with the
 *  transform params is the keyframe machinery, which is generic over the
 *  param name (D-208/D-220) — see [`ClipKeyframeParam`]. */
export type ClipAudioParam = 'volume' | 'pan';

/** Each per-clip audio property's rest value — unity gain, dead centre. The
 *  same one-source-of-truth role [`CLIP_TRANSFORM_DEFAULTS`] plays, matching
 *  `chroma_timeline::Clip`'s own server-side defaults (`default_volume()` /
 *  `0.0`) exactly. */
export const CLIP_AUDIO_DEFAULTS: Readonly<Record<ClipAudioParam, number>> = {
  volume: 1,
  pan: 0,
};

/** Every param name a clip keyframe can address from the Inspector — the
 *  transform/crop set plus D-223's two audio ones. The keyframe helpers
 *  (`clipKeyframes.ts`) are typed on this rather than on
 *  [`ClipTransformParam`] alone: the machinery was always generic over the
 *  name (that is exactly what D-220 generalised `PropertyRow` for), and the
 *  Rust interpolator it mirrors (`chroma::keyframes::interpolate_param`) never
 *  knew the transform names either. */
export type ClipKeyframeParam = ClipTransformParam | ClipAudioParam;

/** [`CLIP_TRANSFORM_DEFAULTS`] ∪ [`CLIP_AUDIO_DEFAULTS`] — every keyframeable
 *  clip property's rest value, for the Inspector's per-property state
 *  derivation and reset. The two halves stay separately exported because the
 *  ops that WRITE them are different (`set_clip_transform` vs.
 *  `set_clip_audio`), which is a real distinction a single merged map would
 *  lose. */
export const CLIP_KEYFRAME_DEFAULTS: Readonly<Record<ClipKeyframeParam, number>> = {
  ...CLIP_TRANSFORM_DEFAULTS,
  ...CLIP_AUDIO_DEFAULTS,
};

/** Is `param` one of D-223's audio properties (and therefore written through
 *  `set_clip_audio`, not `set_clip_transform`)? One predicate, so the
 *  Inspector's shared per-property handlers ask it in one place rather than
 *  each re-spelling the membership test. */
export function isClipAudioParam(param: ClipKeyframeParam): param is ClipAudioParam {
  return param === 'volume' || param === 'pan';
}

/** The stored-clamp for a clip's own linear volume (D-223) — mirrors
 *  `chroma_types::clip_volume`: floored at silence, no ceiling (a fader that
 *  cannot boost is not one, and `Track.gain` has no ceiling either), and a
 *  cleared numeric `<input>`'s `NaN` becomes unity rather than reaching the
 *  timeline. */
export function clampClipVolume(v: number): number {
  return Number.isFinite(v) ? Math.max(v, 0) : 1;
}

/** The stored-clamp for a clip's pan (D-223) — `[-1, 1]`, `NaN` → centre.
 *  Mirrors `chroma_types::pan_gains`' own clamp, applied here as well as
 *  there for `clamp01`'s stated reason: the UI's own writes should be
 *  well-formed at rest, not merely survivable. */
export function clampClipPan(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0;
}

/** The left/right amplitude multipliers for a normalised `pan` — an exact
 *  mirror of `chroma_types::pan_gains` (constant power, normalised to unity at
 *  centre; see that module for why the centre, not the extremes, is the
 *  0 dB point here). Lives beside the model rather than in
 *  `timelineExportAudio.ts` because both the exporter and any future meter/UI
 *  readout need the same two numbers, and a second copy of a pan law is
 *  exactly the drift this repo's "extract it" rule exists to stop. */
export function panGains(pan: number): [number, number] {
  if (!Number.isFinite(pan)) return [1, 1];
  // Exactly `[1, 1]` at centre — `Math.SQRT2 * Math.cos(Math.PI / 4)` is
  // 0.9999999999999999, and an un-panned clip must be a bit-exact no-op.
  if (pan === 0) return [1, 1];
  const p = Math.min(Math.max(pan, -1), 1);
  // The extremes are pinned too, for the same reason and symmetrically:
  // `Math.sin(0)` is exactly 0 but `Math.cos(Math.PI / 2)` is 6.1e-17, so
  // without this, hard left would silence the right channel exactly while hard
  // right left a 1e-16 residue in the left one.
  if (p <= -1) return [Math.SQRT2, 0];
  if (p >= 1) return [0, Math.SQRT2];
  const theta = ((p + 1) * Math.PI) / 4;
  return [Math.SQRT2 * Math.cos(theta), Math.SQRT2 * Math.sin(theta)];
}

/** A `cubic-bezier(x1,y1,x2,y2)` easing curve (D-147, generalised by D-233) —
 *  mirrors `chroma_types::EaseCurve`. `P0 = (0,0)` and `P3 = (1,1)` are
 *  implicit; `x` is normalised progress through *something*, `y` is how far
 *  through the change you are at that progress.
 *
 *  **Two consumers, one type** (this is why D-233 renamed it off `FadeCurve`):
 *  a clip's `fade_in_curve`/`fade_out_curve` shape a fade window's gain ramp,
 *  and a keyframe entry's `ease` shapes the segment between two of one
 *  property's keyframes. The curve itself knows about neither — see
 *  `easeCurve.ts` for the evaluator and `chroma_types::ease` for the Rust
 *  original.
 *
 *  **No preset name is stored** — the four control points are the only truth,
 *  and [`easePresetName`] matches a curve back to a label for display.
 *  Storing both would be two sources of truth that disagree the moment a
 *  custom curve is authored, which both the curve editor (D-233) and MCP can
 *  do. */
export interface EaseCurve {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The four curve presets the fade Inspector and the keyframe curve editor
 *  both offer, as real control points — mirroring `chroma_types::EaseCurve`'s
 *  own constants exactly.
 *
 *  `linear` is `(1/3, 2/3)` rather than CSS's `(0,0,1,1)`. Both trace the same
 *  straight line — any control points on the `y = x` diagonal do — but
 *  `1/3, 2/3` is the *uniform* parameterisation, which is better-conditioned
 *  for the Rust-side solver. See that constant's own doc for the full
 *  reasoning; this list must stay in step with it, or a preset picked here
 *  would round-trip back as "custom". */
export const EASE_PRESETS: ReadonlyArray<{ name: string; curve: EaseCurve }> = [
  { name: 'linear', curve: { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 } },
  { name: 'ease-in', curve: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { name: 'ease-out', curve: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  { name: 'ease-in-out', curve: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
];

/** `linear` — what an absent curve means, matching Rust's `EaseCurve::default()`. */
export const DEFAULT_EASE_CURVE: EaseCurve = EASE_PRESETS[0].curve;

/** The preset `c` exactly matches, or `null` for a custom curve. An absent
 *  curve is `linear`, matching the server-side default. Exact comparison, the
 *  same call Rust's `EaseCurve::preset_name` makes and for the same reason:
 *  these values come from the preset list itself, so "the user picked ease-in"
 *  really is the exact literal, and a tolerance would invent a second notion
 *  of identity. */
export function easePresetName(c: EaseCurve | undefined | null): string | null {
  if (!c) return EASE_PRESETS[0].name;
  const hit = EASE_PRESETS.find(
    (p) => p.curve.x1 === c.x1 && p.curve.y1 === c.y1 && p.curve.x2 === c.x2 && p.curve.y2 === c.y2,
  );
  return hit ? hit.name : null;
}

/** B-077 — `c.duration`/`c.source_start` (and any other quantity measured in
 *  `c`'s own **source frames**, per the module doc on `Clip`) converted to
 *  **timeline frames** at the project's own `fps` (`timelineFps(tl)`), using
 *  `c.source_fps` (B-075/D-186) to know the real ratio. Falls back to `fps`
 *  itself when `source_fps` is absent/zero (a clip probed before that field
 *  existed, or one that's genuinely native-rate == project-rate) — the ratio
 *  is `1` either way, so this is the exact identity every call site already
 *  had before B-077, never a behavior change for the common same-fps case.
 *
 *  Every function in this file that combines a `start_frame`-space position
 *  with a `duration`/`source_start`-space quantity (`endFrame`, gap/insertion/
 *  ripple math, the trim clamps below) must go through this rather than add
 *  the two directly — that direct addition, done in exactly `endFrame` and
 *  nowhere else at first, was B-077 itself: correct only when a clip's own
 *  native rate happens to equal the project's, which a real mixed-native-fps
 *  timeline (two screen recordings at two different rates) breaks live. */
export function sourceFramesToTimeline(c: Pick<Clip, 'source_fps'>, sourceFrames: number, fps: number): number {
  const srcFps = c.source_fps && c.source_fps > 0 ? c.source_fps : fps;
  return Math.round((sourceFrames * fps) / srcFps);
}

/** The reverse of [`sourceFramesToTimeline`] — how many of `c`'s own native
 *  **source** frames a span of `timelineFrames` timeline frames corresponds
 *  to. Used where a TIMELINE-frame delta (a UI drag, always computed against
 *  the project's own pixels-per-frame) must be applied to a SOURCE-frame
 *  field (`source_start`, and — per the `Clip` doc — `duration` itself). */
export function timelineFramesToSource(c: Pick<Clip, 'source_fps'>, timelineFrames: number, fps: number): number {
  const srcFps = c.source_fps && c.source_fps > 0 ? c.source_fps : fps;
  return Math.round((timelineFrames * srcFps) / fps);
}

/** A clip's exclusive timeline end frame — `chroma-timeline::Clip::end_frame`,
 *  fps-corrected (B-077): `chroma-timeline`'s own `Clip` doc is explicit that
 *  `duration` is in **source** frames while `start_frame` is a **timeline**
 *  frame, so the two can only be added after `duration` is converted via
 *  `sourceFramesToTimeline` — plain `start_frame + duration` (this function's
 *  entire pre-B-077 body) is only correct when `c.source_fps` equals `fps`.
 *  `fps` is the project's own `timelineFps(tl)` — every caller either already
 *  has a `Timeline` to read that from, or (for a bare `Track`) is handed it by
 *  ITS caller, all the way up to the one place `Timeline`/`fps` are both in
 *  scope at once. */
export function endFrame(c: Clip, fps: number): number {
  // D-236 — `Math.round` BEFORE the fps conversion, matching
  // `chroma_timeline::Clip::end_frame_at` exactly (whose
  // `source_frames_to_timeline` takes an `i64`, so it must round first).
  // Rounding in a different ORDER than the preview does is a real divergence
  // on a mixed-native-fps ramped clip — e.g. 83.5 output source frames at
  // 25 fps into a 24 fps project is timeline frame 81 rounding first and 80
  // rounding last — so the order is pinned here rather than left to whichever
  // engine happens to be more accurate. `clipOutputSourceFrames` returns
  // `c.duration` exactly (already an integer) for every un-ramped clip, so
  // this rounds nothing that was not already round before D-236.
  return c.start_frame + sourceFramesToTimeline(c, Math.round(clipOutputSourceFrames(c)), fps);
}

/** D-236 — how much OUTPUT this clip produces, still measured in its own
 *  source-frame units (so `sourceFramesToTimeline` converts it exactly as it
 *  always converted `duration`).
 *
 *  For an un-ramped clip this **is** `c.duration`, returned without touching
 *  the ramp machinery at all — which is what keeps every pre-D-236 timeline's
 *  frame arithmetic bit-for-bit unchanged. For a ramped one it is
 *  `Σ segment_length / segment_speed`: a 2x segment contributes half its own
 *  length to the output, a 0.5x segment twice.
 *
 *  Mirrors `chroma_timeline::Clip::output_source_frames`. */
export function clipOutputSourceFrames(c: Pick<Clip, 'source_start' | 'duration' | 'speed_points'>): number {
  if (normalizeSpeedPoints(c.speed_points).length === 0) return c.duration;
  return rampOutputSourceFrames(resolveSpeedSegments(c));
}

/** D-236 — the fields the two remap functions below actually read.
 *
 *  Structural rather than a whole `Clip` because `clipKeyframes.ts`'s
 *  `clipSourceFrame`/`clipTimelineFrame` — the AUTHORING half of the same
 *  question, and the reason these are not two separate implementations — has
 *  always taken a subset, and its callers include tests that build one by
 *  hand. `duration` is optional for the same reason: it is only read when the
 *  clip actually carries speed points, and a caller that has none has nothing
 *  to say about it. */
type RampedClipRef = Pick<Clip, 'source_start' | 'start_frame'> &
  Partial<Pick<Clip, 'duration' | 'speed_points' | 'source_fps'>>;

/** The resolved segments of a [`RampedClipRef`] — only ever called on the
 *  ramped branch, where `duration` is real. */
function rampSegmentsOf(c: RampedClipRef) {
  return resolveSpeedSegments({
    source_start: c.source_start,
    duration: c.duration ?? 0,
    speed_points: c.speed_points,
  });
}

/** D-236 — the absolute SOURCE frame this clip shows at TIMELINE frame
 *  `timelineFrame`: the TS mirror of `chroma_timeline::Clip::source_frame_at`,
 *  which is what the live preview actually decodes with.
 *
 *  Un-ramped this is exactly the pre-D-236 `source_start +
 *  timelineFramesToSource(timelineFrame - start_frame)`. Ramped, the linear
 *  second term is replaced by the ramp's own inverse remap — the SAME
 *  `sourceFrameAtOutput` the export's `setpts` expression is the forward
 *  image of. That shared definition is the whole preview/export parity
 *  argument for this feature (see D-236, and `speedRamp.ffmpeg.test.ts`,
 *  which decodes real exported pixels and checks them against this function).
 *
 *  Like its Rust twin it EXTRAPOLATES outside the clip's own window rather
 *  than clamping — the caller decides what to do about a frame that isn't in
 *  the file. */
export function clipSourceFrameAt(c: RampedClipRef, timelineFrame: number, fps: number): number {
  const outputPos = timelineFramesToSource(c, timelineFrame - c.start_frame, fps);
  if (normalizeSpeedPoints(c.speed_points).length === 0) return c.source_start + outputPos;
  // FLOOR, not round — see `chroma_timeline::Clip::source_frame_at`'s own
  // note: a frame owns the half-open source interval `[n, n+1)`, and the
  // export's `setpts` floors by construction, so rounding here would put the
  // preview half a frame ahead of the file. D-241 moved that rounding into
  // `quantizedSourceFrameAtOutput`, because a REVERSED run sweeps the same
  // interval downward and its mirror rule is `ceil - 1`; for a forward ramp
  // it is exactly the `Math.floor` this line used to be.
  return quantizedSourceFrameAtOutput(rampSegmentsOf(c), outputPos);
}

/** D-236 — the inverse of [`clipSourceFrameAt`]: the TIMELINE frame at which
 *  this clip reaches absolute SOURCE frame `sourceFrame`. Used by the GUI's
 *  speed-ramp editor to draw a speed point (authored in source frames) at its
 *  real position on the retimed clip, and by "add a speed point at the
 *  playhead" to go the other way. */
export function clipTimelineFrameAtSource(c: RampedClipRef, sourceFrame: number, fps: number): number {
  const outputPos =
    normalizeSpeedPoints(c.speed_points).length === 0
      ? sourceFrame - c.source_start
      : outputAtSourceFrame(rampSegmentsOf(c), sourceFrame);
  return c.start_frame + sourceFramesToTimeline(c, outputPos, fps);
}

export interface Track {
  /** D-229 added `'subtitle'` — mirrors `chroma_timeline::TrackKind`. A
   *  subtitle track's clips carry a `CaptionCue` and are drawn OVER the
   *  finished picture by their own resolver; it is neither composited in the
   *  video z-order nor mixed into the audio. Every existing
   *  `kind === 'video'` / `=== 'audio'` test keeps its exact meaning, which is
   *  why the variant could be added without revisiting them. */
  kind: 'video' | 'audio' | 'subtitle';
  clips: Clip[];
  /** Linear volume multiplier (D-057) — mirrors `chroma_timeline::Track::gain`.
   *  `1.0` unity, `0.0` full mute, `> 1.0` boosts. Absent on a pre-D-057
   *  timeline (defaults to `1.0` server-side); optional here for the same
   *  reason. Only meaningful for `kind === 'audio'` — a video track's own
   *  embedded audio stays hardcoded at unity (D-057's own scoping). */
  gain?: number;
  /** D-086 — mirrors `chroma_timeline::Track::locked`/`hidden` (both default
   *  `false` server-side, optional here for the same reason as `gain`).
   *  `locked` blocks per-clip edits on this track (`reorder`/`trim_start`/
   *  `trim_end`/`split`/`remove`/`move` in `applyOp` below all refuse —
   *  mirroring Rust's single `track_mut` choke point, `TimelineError::
   *  TrackLocked`) but NOT `add_track`/`remove_track`/`move_track` — same
   *  "locking protects a track's clips, not the track list" split as the
   *  Rust side. `hidden` is a pure compositor/render concern (`chroma_
   *  timeline_frame`'s `resolve_visible_video_layers_at` skips a hidden
   *  video track) — `applyOp` has nothing to refuse for it. */
  locked?: boolean;
  hidden?: boolean;
  /** Cross-track ripple sync (D-106/roadmap item 11) — mirrors
   *  `chroma_timeline::Track::sync_locked`. Whether this track RECEIVES a
   *  ripple shift triggered by an edit on a DIFFERENT track; independent of
   *  whether THIS track's own edits ripple (always, unconditionally, same
   *  as before this field existed). Matches DaVinci Resolve's/Palmier Pro's
   *  real Sync Lock semantics (checked live, `docs/notes/
   *  cross-track-ripple-sync-lock.md`), a distinct concept from `locked`
   *  (protects THIS track's own clips from being edited at all — not the
   *  same as whether it receives someone else's ripple). Optional here for
   *  the same reason `gain` is: absent on a pre-D-106 track, defaulted to
   *  `true` (NOT the bare-optional "falsy" reading) wherever a `Track` is
   *  constructed or migrated — see `DEFAULT_SYNC_LOCKED`. */
  sync_locked?: boolean;
  /** Ducking (D-149) — mirrors `chroma_timeline::Track::duck_from`: the index
   *  of the track whose clips duck THIS one ("lower the music while the
   *  dialogue plays"). `null`/absent — the default and every pre-D-149 project
   *  — is no ducking at all. A relationship between two tracks, which is why it
   *  lives here rather than on a `Clip`.
   *
   *  `null` as well as `undefined` because Rust's `Option<usize>` serialises an
   *  explicit `null` once the field has ever been written and then cleared;
   *  every read here must treat the two the same. */
  duck_from?: number | null;
  /** D-149 — how much to duck, in **dB** (`-12` = 12 dB down). `0` (the
   *  default) is unity. Deliberately dB where `gain` above is linear: a fader
   *  level is naturally linear, a duck amount is the one audio number editors
   *  state in decibels. Rust converts once, at the point of use in
   *  `chroma_media::audio`. */
  duck_db?: number;
  /** D-149 — the one-pole attack/release time constants in milliseconds: the
   *  τ in `y(t) = target + (y₀ − target)·e^(−t/τ)`, i.e. the time to cover
   *  63.2% of the distance to the new level. Two real DSP numbers, not one
   *  "strength" dial — a fast attack puts the duck down before the first word,
   *  a slow release stops the bed pumping between them. See
   *  `DEFAULT_DUCK_ATTACK_MS`/`DEFAULT_DUCK_RELEASE_MS` for why these are
   *  defaulted to non-zero values rather than read as falsy-absent. */
  duck_attack_ms?: number;
  duck_release_ms?: number;
  /** D-226 — transitions at THIS track's edit points. Mirrors
   *  `chroma_timeline::Track::transitions`, whose `#[serde(default)]` is why
   *  this is optional here: a `project.json` written before transitions existed
   *  has no key at all, and every read below treats absent and `[]` the same. */
  transitions?: Transition[];
  /** D-229 — the style every caption on this track draws with. Mirrors
   *  `chroma_timeline::Track::caption_style`. Only meaningful when
   *  `kind === 'subtitle'`; absent means the caption defaults (see
   *  `resolveCaptionStyle`). A whole imported `.srt` is styled once here, not
   *  cue by cue — the reference Inspector's "Track Style" tab. */
  caption_style?: CaptionStyle | null;
}

/** D-226 — the two transition shapes v1 ships. Mirrors
 *  `chroma_timeline::TransitionKind` (serde `snake_case`).
 *
 *  Two, not a library, and the pair is deliberate: `cross_dissolve` is the one
 *  that needs TWO clips visible at once plus handle media, `dip_to_color` is the
 *  one that needs neither — so between them they prove both mechanisms, and a
 *  cut with no handles still has a transition that works. See D-226. */
export type TransitionKind = 'cross_dissolve' | 'dip_to_color';

/** D-226 — where a transition's window sits relative to its cut. Premiere Pro's
 *  own three, under its own names (Adobe's *Align and reposition transitions*
 *  help page): the choice decides WHICH clip has to supply handle media, which
 *  is why it is a real field and not cosmetic. Mirrors
 *  `chroma_timeline::TransitionAlignment`. */
export type TransitionAlignment = 'center_at_cut' | 'start_at_cut' | 'end_at_cut';

export const TRANSITION_ALIGNMENTS: ReadonlyArray<{ value: TransitionAlignment; label: string }> = [
  { value: 'center_at_cut', label: 'Center at Cut' },
  { value: 'start_at_cut', label: 'Start at Cut' },
  { value: 'end_at_cut', label: 'End at Cut' },
];

/** D-226 — the browsable transition palette: what the timeline's Transitions
 *  popover lists and what `editor_add_transition` accepts. One named source, so
 *  the human's palette and the agent's enum can never drift. */
export const TRANSITION_KINDS: ReadonlyArray<{
  value: TransitionKind;
  label: string;
  /** One line, shown under the palette entry and echoed by
   *  `editor_get_capabilities`, saying what this shape actually needs. */
  blurb: string;
}> = [
  {
    value: 'cross_dissolve',
    label: 'Cross Dissolve',
    blurb: 'The incoming clip fades up over the outgoing one. Needs handle media on both clips.',
  },
  {
    value: 'dip_to_color',
    label: 'Dip to Color',
    blurb: 'Both clips dip through a solid colour (black by default). Needs no handle media.',
  },
];

/** D-226 — default transition length in TIMELINE frames. One second at the
 *  project's own rate would be a `fps`-dependent constant this pure module has
 *  no access to at construction time; 24 frames is exactly one second at
 *  [`DEFAULT_FPS`] and a normal dissolve length at any rate this app targets.
 *  Resolve's own default is 1 second, for the same reason. */
export const DEFAULT_TRANSITION_FRAMES = 24;

/** One transition at one edit point (D-226, `docs/notes/transitions.md`).
 *  Mirrors `chroma_timeline::Transition` field-for-field.
 *
 *  **The clips it joins stay abutting and non-overlapping** — see the Rust
 *  type's own doc and D-226 for the two real data-model options and why this
 *  one was chosen. `at_frame` IS the cut; the window is derived from it (see
 *  [`transitionWindow`]) so a duration or alignment change can never detach the
 *  transition from the cut it was dropped on. */
export interface Transition {
  id: string;
  kind: TransitionKind;
  /** TIMELINE frame of the cut — the outgoing clip's exclusive end and the
   *  incoming clip's `start_frame`, which for two abutting clips are the same
   *  number. */
  at_frame: number;
  /** Length in TIMELINE frames. */
  duration: number;
  alignment?: TransitionAlignment;
  /** `dip_to_color` only — `#RRGGBB`. Absent is black. */
  color?: string;
}

/** D-226 — a transition's `[start, end)` TIMELINE-frame window. **Exact mirror
 *  of `chroma_timeline::Transition::window`**, integer halving and all, so the
 *  live preview and this compiler can never disagree about which frames a
 *  transition covers. */
export function transitionWindow(t: Transition): { start: number; end: number } {
  const d = Math.max(0, Math.round(t.duration));
  switch (t.alignment ?? 'center_at_cut') {
    case 'start_at_cut':
      return { start: t.at_frame, end: t.at_frame + d };
    case 'end_at_cut':
      return { start: t.at_frame - d, end: t.at_frame };
    default: {
      // `Math.floor` on the half, matching Rust's integer division for the
      // positive `d` this is only ever called with — an odd duration puts the
      // extra frame AFTER the cut, identically on both sides.
      const start = t.at_frame - Math.floor(d / 2);
      return { start, end: start + d };
    }
  }
}

/** D-226 — how many TIMELINE frames of handle each side must supply: the part
 *  of the window before the cut comes out of the INCOMING clip's head, the part
 *  at or after it out of the OUTGOING clip's tail. Mirrors
 *  `Transition::head_handle` / `tail_handle`. */
export function transitionHandles(t: Transition): { head: number; tail: number } {
  const { start, end } = transitionWindow(t);
  return { head: Math.max(0, t.at_frame - start), tail: Math.max(0, end - t.at_frame) };
}

/** D-226 — the outgoing/incoming clip indices at `atFrame` on `tr`, by exact
 *  frame match (the same fact `Transition.at_frame` is documented to mean).
 *  `-1` for a side that isn't there — a cut that drifted because one side was
 *  trimmed, which every consumer degrades on rather than erroring. */
export function transitionClipIndices(
  tr: Track,
  atFrame: number,
  fps: number,
): { outgoing: number; incoming: number } {
  return {
    outgoing: tr.clips.findIndex((c) => endFrame(c, fps) === atFrame),
    incoming: tr.clips.findIndex((c) => c.start_frame === atFrame),
  };
}

/** D-226 — every real cut on `tr`: a frame where one clip ends and the next
 *  begins, with no gap. The set of places a transition can be dropped, which the
 *  timeline's drag-to-a-cut gesture snaps to and `editor_add_transition`
 *  reports back when a caller names a frame that isn't one. Ascending, deduped. */
export function cutFrames(tr: Track, fps: number): number[] {
  const starts = new Set(tr.clips.map((c) => c.start_frame));
  const cuts = tr.clips
    .map((c) => endFrame(c, fps))
    .filter((end) => starts.has(end))
    .sort((a, b) => a - b);
  return [...new Set(cuts)];
}

/** D-226 — the outcome of checking whether a transition may be written.
 *
 *  Shaped like [`LinkCheck`] (D-138) and for the identical reason: the palette's
 *  drop target, the Inspector's duration field and `editor_add_transition` all
 *  need the SAME answer, and a disabled-state tooltip that drifts from what
 *  `applyOp` actually enforces is a bug waiting to happen. One function, three
 *  callers. */
export interface TransitionCheck {
  ok: boolean;
  /** Present only when `ok` is false — a real, actionable sentence naming what
   *  is missing and what would fix it. */
  reason?: string;
}

/** B-129/D-262 — whether an `add_clip` may put `clip` on track `track`.
 *
 *  Same shape and same reason as [`TransitionCheck`]/[`EditInCheck`]: the
 *  timeline's own drop handler, `editor_add_text_clip`/
 *  `editor_add_adjustment_clip` and `applyOp` itself all need the SAME answer,
 *  and a guard that lives in only one of them is a guard the other two walk
 *  straight past. That is exactly what B-129 was: the only track-kind check in
 *  the app sat in `TimelinePane`'s `onDrop`, so a title added any other way
 *  (the library rail's button, an MCP call) could be — and in the owner's real
 *  project was — spliced onto an AUDIO track, where it composites into
 *  nothing.
 *
 *  **One rule, deliberately narrow.** A generated picture clip
 *  ([`isGeneratedPictureClip`] — a title or an adjustment clip) belongs on a
 *  `'video'` track and nowhere else. Everything else this op places is left
 *  exactly as it was: a media clip on an audio track is an ordinary,
 *  intentional edit (that is what a detached audio clip IS), and a caption's
 *  own subtitle-track placement is D-229's, already enforced at its own write
 *  path. Widening this into a general clip-kind/track-kind matrix would be
 *  inventing rules the model has never had, on the back of a bug report about
 *  one of them.
 *
 *  A track index that does not exist is NOT refused here — `add_clip`'s own
 *  documented fallbacks (an empty timeline gets a video track made for it, an
 *  out-of-range index collapses to 0) are long-standing behaviour that several
 *  callers rely on, and both of those land the clip on a video track anyway. */
export function checkAddClip(
  tl: Timeline,
  track: number,
  clip: Pick<Clip, 'text' | 'adjustment'>,
): TransitionCheck {
  const tr = tl.tracks[track];
  if (!tr || !isGeneratedPictureClip(clip)) return { ok: true };
  if (tr.kind !== 'video') {
    const what = isTextClip(clip) ? 'A title' : 'An adjustment clip';
    return {
      ok: false,
      reason: `${what} is picture — it cannot go on the ${tr.kind} track ${track}. Put it on a video track, or add it without naming one to get a new video track above the picture.`,
    };
  }
  return { ok: true };
}

/** D-226 — may a transition of this shape/length/alignment be written at
 *  `atFrame` on `track`? The one precondition check `applyOp`'s
 *  `add_transition`/`set_transition`, the timeline drop gesture and the MCP tool
 *  all go through.
 *
 *  What it enforces, and why each one is real:
 *  - the track exists, is a **video** track and is **not locked** — the same
 *    gate every per-clip op here already applies;
 *  - `duration >= 1` — a zero-length transition renders nothing;
 *  - there is a **real cut** at `atFrame` (a clip ending there AND a clip
 *    starting there). A transition needs two clips; "fade this clip up from
 *    black at its head" is a FADE, which this model already has as
 *    `set_clip_fade` (D-147), and offering two ways to spell the same thing is
 *    exactly the two-sources-of-truth problem CLAUDE.md forbids;
 *  - the window must not swallow either neighbouring clip whole, or the cut on
 *    that clip's far side would be inside this transition's window;
 *  - it must not overlap another transition's window on the same track (which
 *    is what lets `Track::transition_at` take the first match and be right);
 *  - and for a `cross_dissolve`, **the handle media must actually exist** —
 *    `head` frames before the incoming clip's in-point and `tail` frames after
 *    the outgoing clip's out-point. This is the check that makes the refusal
 *    honest rather than the render silently freezing a frame (Premiere's own
 *    "Insufficient Media" case). The reason names the alignment that WOULD fit,
 *    since that is usually the fix. `dip_to_color` skips it entirely — it needs
 *    no handles by construction. */
export function checkTransition(
  tl: Timeline,
  track: number,
  candidate: Transition,
  fps: number,
): TransitionCheck {
  const tr = tl.tracks[track];
  if (!tr) return { ok: false, reason: `no track ${track} (0..${tl.tracks.length - 1})` };
  if (tr.kind !== 'video') {
    return { ok: false, reason: 'transitions apply to video tracks only' };
  }
  if (tr.locked) return { ok: false, reason: `track ${track} is locked` };
  const duration = Math.round(candidate.duration);
  if (!Number.isFinite(duration) || duration < 1) {
    return { ok: false, reason: 'duration must be at least 1 frame' };
  }

  const { outgoing, incoming } = transitionClipIndices(tr, candidate.at_frame, fps);
  if (outgoing < 0 || incoming < 0) {
    const cuts = cutFrames(tr, fps);
    return {
      ok: false,
      reason:
        cuts.length === 0
          ? `no cut at frame ${candidate.at_frame} on track ${track} — that track has no two clips touching end-to-start`
          : `no cut at frame ${candidate.at_frame} on track ${track} — its cuts are at ${cuts.join(', ')}`,
    };
  }
  const out = tr.clips[outgoing];
  const inc = tr.clips[incoming];

  const normalised: Transition = { ...candidate, duration };
  const { start, end } = transitionWindow(normalised);
  const { head, tail } = transitionHandles(normalised);

  // The window may not run past either neighbour's far edge: the transition
  // would then be sitting on top of a DIFFERENT cut as well, which neither
  // engine's "one transition covers this frame" resolution can represent.
  if (start < out.start_frame) {
    return {
      ok: false,
      reason: `a ${duration}-frame transition would run past the start of "${out.name}" — shorten it or use "Start at Cut"`,
    };
  }
  if (end > endFrame(inc, fps)) {
    return {
      ok: false,
      reason: `a ${duration}-frame transition would run past the end of "${inc.name}" — shorten it or use "End at Cut"`,
    };
  }

  const clash = (tr.transitions ?? []).find((t) => {
    if (t.id === candidate.id) return false;
    const w = transitionWindow(t);
    return w.start < end && start < w.end;
  });
  if (clash) {
    return {
      ok: false,
      reason: `overlaps the transition already at frame ${clash.at_frame} on this track`,
    };
  }

  if (candidate.kind === 'cross_dissolve') {
    // Handle media, in each clip's OWN source frames — `head`/`tail` are
    // TIMELINE frames, and a clip whose native rate differs from the project's
    // needs a different number of its own frames to cover the same span
    // (B-077's distinction, applied here rather than conflated).
    const headNeeded = timelineFramesToSource(inc, head, fps);
    const tailNeeded = timelineFramesToSource(out, tail, fps);
    const headHave = inc.source_start;
    const tailHave = Math.max(0, out.source_len - (out.source_start + out.duration));
    if (headNeeded > headHave || tailNeeded > tailHave) {
      const shortHead = Math.max(0, headNeeded - headHave);
      const shortTail = Math.max(0, tailNeeded - tailHave);
      const missing = [
        shortHead > 0 ? `${shortHead} frame(s) before "${inc.name}"'s in-point` : null,
        shortTail > 0 ? `${shortTail} frame(s) after "${out.name}"'s out-point` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      const alt =
        shortHead > 0 && shortTail === 0
          ? ' — try "Start at Cut", which takes no head handle'
          : shortTail > 0 && shortHead === 0
            ? ' — try "End at Cut", which takes no tail handle'
            : ' — trim the clips back, shorten the transition, or use a Dip to Color, which needs no handles';
      return {
        ok: false,
        reason: `insufficient media for a cross dissolve: needs ${missing}${alt}`,
      };
    }
  }

  return { ok: true };
}

/** D-226 — build a valid [`Transition`], the ONE construction path shared by the
 *  timeline's transition palette and `editor_add_transition` (CLAUDE.md: "the
 *  same op/store action underneath both"). Owns id generation and colour
 *  resolution, exactly as [`newMarker`] does; returns `{ error }` rather than
 *  silently substituting an unparseable colour.
 *
 *  Does NOT check placement — that is [`checkTransition`], which needs the
 *  timeline this one does not take. Callers run both, in that order. */
export function newTransition(
  kind: TransitionKind,
  atFrame: number,
  duration: number = DEFAULT_TRANSITION_FRAMES,
  alignment: TransitionAlignment = 'center_at_cut',
  color?: string | null,
): Transition | { error: string } {
  if (!TRANSITION_KINDS.some((k) => k.value === kind)) {
    return { error: `unknown transition kind "${kind}" — one of ${TRANSITION_KINDS.map((k) => k.value).join(' | ')}` };
  }
  if (!Number.isFinite(atFrame) || !Number.isFinite(duration)) {
    return { error: 'atFrame and duration must be finite numbers of timeline frames' };
  }
  const t: Transition = {
    id: `transition-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    at_frame: Math.round(atFrame),
    duration: Math.max(1, Math.round(duration)),
    alignment,
  };
  if (kind === 'dip_to_color' && color != null && color !== '') {
    // Reuses the marker palette's own resolver: same `#RGB`/`#RRGGBB`-or-name
    // grammar, one implementation, so "red" means one colour in this app.
    const hex = resolveMarkerColor(color);
    if (typeof hex !== 'string') return hex;
    t.color = hex;
  }
  return t;
}

/** D-226 — every transition on `tr`, sorted by its cut frame. Same read-side
 *  counterpart role [`markersOf`] plays for markers: a `Timeline` that arrived
 *  from a hand-built fixture or an older write still reads back in timeline
 *  order. */
export function transitionsOf(tr: Track | null | undefined): Transition[] {
  return sortedTransitions(tr?.transitions ?? []);
}

/** Cut-frame order, stable on ties — the one sort the transition ops and
 *  [`transitionsOf`] share, so the write-side invariant and the read-side
 *  fallback can never disagree about ordering (mirrors [`sortedMarkers`]). */
function sortedTransitions(transitions: readonly Transition[]): Transition[] {
  return [...transitions].sort((a, b) => a.at_frame - b.at_frame);
}

export const DEFAULT_TRACK_GAIN = 1.0;
/** Mirrors Rust's `chroma_timeline::DEFAULT_DUCK_ATTACK_MS` — fast, so the duck
 *  is already down when the first word lands. A bare falsy-absent read would
 *  give `0 ms`, which is a step function and therefore a click. */
export const DEFAULT_DUCK_ATTACK_MS = 10;
/** Mirrors Rust's `chroma_timeline::DEFAULT_DUCK_RELEASE_MS` — slow, so the bed
 *  does not pump between words. Same non-falsy-default reasoning as the attack. */
export const DEFAULT_DUCK_RELEASE_MS = 300;
/** Mirrors Rust's `default_sync_locked()` — see `Track.sync_locked`'s own
 *  doc for why this is `true`, not a bare falsy default. */
export const DEFAULT_SYNC_LOCKED = true;

export interface Timeline {
  /** Stable id (D-045) — distinguishes this timeline among a project's others. */
  id: string;
  name: string;
  rate?: Rational | null;
  tracks: Track[];
  /** D-222 — timeline-anchored annotations (roadmap item 27). Mirrors
   *  `chroma_timeline::Timeline::markers`, whose `#[serde(default)]` is why
   *  this is optional here: a `project.json` written before markers existed
   *  has no key at all, and every read below treats absent and `[]` the same.
   *  Kept **sorted by `frame`** by `applyOp` — see the `add_marker` op. */
  markers?: Marker[];
}

/** One timeline marker (D-222) — a colour-coded flag pinned to a TIMELINE
 *  frame, independent of any clip. Mirrors `chroma_timeline::Marker`
 *  field-for-field (serde snake_case; the type has no multi-word field, so
 *  the two spellings coincide).
 *
 *  **On the `Timeline`, not on a `Clip`, deliberately** — see the Rust type's
 *  own doc: a marker names a position in the edit and must survive the clip
 *  under it being trimmed, moved or deleted. */
export interface Marker {
  id: string;
  /** TIMELINE frame — the same space as `Clip.start_frame`, never source frames. */
  frame: number;
  /** CSS colour string; the GUI writes a `#RRGGBB` from [`MARKER_COLORS`]. */
  color: string;
  name?: string;
  note?: string;
}

/** The marker swatch palette — DaVinci Resolve's own sixteen marker colours,
 *  in its own order, read off the real Markers dialog in
 *  `scratch/resolve-reference/markers.jpg` (CLAUDE.md's "research the real
 *  pattern first" rule; cited in D-222).
 *
 *  **Why literal hexes and not `--color-*` tokens**, given CLAUDE.md's "one
 *  token source" rule: a marker's colour is *document content* — a choice the
 *  user made, persisted into `project.json`, and carrying meaning ("red = fix
 *  this", "green = approved") that must stay the same colour in every theme
 *  and in a colleague's copy of the project. Theme tokens are app chrome and
 *  change with the theme; binding document data to one would silently
 *  recolour a marker set when the theme changed. This constant is the single
 *  named source for the palette, so there is still exactly one definition —
 *  which is what that rule is actually protecting. */
export const MARKER_COLORS: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'blue', hex: '#3B8FE3' },
  { name: 'cyan', hex: '#3FC7D4' },
  { name: 'green', hex: '#4CAF50' },
  { name: 'yellow', hex: '#E5A93B' },
  { name: 'red', hex: '#D9434E' },
  { name: 'pink', hex: '#E255A6' },
  { name: 'purple', hex: '#8A5CD6' },
  { name: 'fuchsia', hex: '#C13BC1' },
  { name: 'rose', hex: '#E88AA8' },
  { name: 'lavender', hex: '#A79BE0' },
  { name: 'sky', hex: '#7FC4EE' },
  { name: 'mint', hex: '#8FD9A8' },
  { name: 'lemon', hex: '#D9D96B' },
  { name: 'sand', hex: '#A9793F' },
  { name: 'cocoa', hex: '#7A5A47' },
  { name: 'cream', hex: '#EFE9DC' },
];

/** The colour a marker gets when the caller didn't name one — Resolve's own
 *  default (the first swatch, Blue). */
export const DEFAULT_MARKER_COLOR = MARKER_COLORS[0].hex;

/** Resolve a caller-supplied colour to a real `#RRGGBB`: a palette NAME
 *  (`"red"`), a raw `#RGB`/`#RRGGBB` hex, or absent for the default. Returns
 *  `{ error }` for anything else rather than silently substituting, matching
 *  [`newTextLayer`]'s own convention — this is the one place the GUI's swatch
 *  row and `editor_add_marker`/`editor_set_marker` both resolve a colour, so
 *  the two can never disagree about what `"red"` means. */
export function resolveMarkerColor(color?: string | null): string | { error: string } {
  if (color == null || color === '') return DEFAULT_MARKER_COLOR;
  const named = MARKER_COLORS.find((c) => c.name === color.toLowerCase());
  if (named) return named.hex;
  if (/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    return color.startsWith('#') ? color.toUpperCase() : `#${color.toUpperCase()}`;
  }
  return {
    error: `color must be a palette name (${MARKER_COLORS.map((c) => c.name).join(' | ')}) or a #RGB/#RRGGBB hex, got "${color}"`,
  };
}

/** Build a valid [`Marker`] — the ONE construction path, shared by the
 *  timeline's own "Add marker" button/`M` shortcut and the `editor_add_marker`
 *  MCP op (CLAUDE.md: "the same op/store action underneath both"). Returns
 *  `{ error }` on a bad colour, like [`newTextLayer`] does; `frame` is floored
 *  at 0 and rounded, since a marker before the start of the timeline is not a
 *  position a user can mean. An empty/whitespace `name`/`note` is dropped
 *  rather than stored as `""`, so "unnamed" has exactly one representation. */
export function newMarker(
  frame: number,
  color?: string | null,
  name?: string | null,
  note?: string | null,
): Marker | { error: string } {
  const hex = resolveMarkerColor(color);
  if (typeof hex !== 'string') return hex;
  if (!Number.isFinite(frame)) return { error: 'frame must be a finite number of timeline frames' };
  const marker: Marker = {
    id: `marker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    frame: Math.max(0, Math.round(frame)),
    color: hex,
  };
  const trimmedName = name?.trim();
  if (trimmedName) marker.name = trimmedName;
  const trimmedNote = note?.trim();
  if (trimmedNote) marker.note = trimmedNote;
  return marker;
}

/** Every marker on `tl`, sorted by frame — the read-side counterpart to
 *  `applyOp`'s own sorted writes, so a caller that got its `Timeline` from
 *  somewhere else (a hand-built fixture, a pre-D-222 `project.json` an MCP
 *  client wrote by hand) still sees them in ruler order. */
export function markersOf(tl: Timeline | null | undefined): Marker[] {
  return sortedMarkers(tl?.markers ?? []);
}

/** Frame order, stable on ties — the one sort the marker ops and
 *  [`markersOf`] share, so the write-side invariant and the read-side
 *  fallback can never disagree about ordering. */
function sortedMarkers(markers: readonly Marker[]): Marker[] {
  return [...markers].sort((a, b) => a.frame - b.frame);
}

export const DEFAULT_FPS = 24;

/**
 * D-046 pass 3 — the `dataTransfer` MIME type a Sources-panel pool item drag
 * carries (`DraggedMedia` JSON), and `TimelinePane`'s drop handler reads. A
 * plain string constant rather than a shared type-only contract because HTML5
 * drag/drop crosses a package boundary the D-039 layer direction forbids a
 * shared `DndContext`/store from crossing (see `TimelinePane`'s doc).
 */
export const CHROMA_MEDIA_DRAG_MIME = 'application/x-chroma-media';

/**
 * D-248 — the `dataTransfer` MIME type a **generator** drag carries: a clip
 * that has no media-pool item behind it because it is generated rather than
 * imported (a title, an adjustment clip). Read by `TimelinePane`'s own
 * `onDragOver`/`onDrop`, exactly alongside `CHROMA_MEDIA_DRAG_MIME`.
 *
 * **A second MIME type rather than a `kind` field inside the media one.**
 * `dataTransfer.getData` is unreadable during `dragover` — only `.types` is
 * (the HTML5 spec constraint `TimelinePane`'s drop handler already documents)
 * — so the type name is the ONLY thing a drag's live preview can branch on.
 * Folding generators into `CHROMA_MEDIA_DRAG_MIME` would make "is this a
 * source with an audio half to place, or a generated clip that never has one"
 * unanswerable until the drop, which is precisely the question the drag
 * preview has to answer while the pointer is still moving.
 *
 * **Native HTML5, not `@dnd-kit`**, unlike the transitions palette (D-226).
 * That palette is rendered *inside* `TimelinePane`'s own `DndContext`; the
 * library rail (`EditLibraryRail.tsx`) is a sibling of the whole timeline
 * pane, and a `useDraggable` outside the provider is not a drag at all. This
 * is the same boundary the Sources panel crosses, so it uses the same
 * mechanism the Sources panel already crosses it with.
 */
export const CHROMA_GENERATOR_DRAG_MIME = 'application/x-chroma-generator';

/** D-248 — what a generator drag carries. Deliberately just the discriminator:
 *  every other field of the resulting clip (duration, the default layer, the
 *  id) is built by the same `newTextLayer`/`newTextClipFields` /
 *  `newAdjustmentLayer`/`newAdjustmentClipFields` factories the click-to-add
 *  path and the `editor_add_text_clip`/`editor_add_adjustment_clip` MCP tools
 *  already use, so a dragged title and a clicked one are byte-identical. */
export interface DraggedGenerator {
  kind: 'title' | 'adjustment';
}

/** D-248 — the human-readable name of each generator, shared by the rail's own
 *  entries and by the refusal messages, so a tooltip can never call a thing
 *  something the error does not. */
export const GENERATOR_LABELS: Record<DraggedGenerator['kind'], string> = {
  title: 'Title',
  adjustment: 'Adjustment clip',
};

// D-094 originally added `CHROMA_CLIP_MOVE_MIME` here for a native-HTML5
// cross-track clip-move drag; D-098 replaced that mechanism with a real
// `@dnd-kit/core` drag (native HTML5 drag was unreliable on Tauri's
// WKWebView — see D-098 in `docs/08-decisions.md`), so this constant has no
// producer or consumer left and was removed rather than kept as dead code.

/** What a Sources-panel drag carries — just enough to build a full-length
 *  `Clip` on drop; `frameCount`/`fps` absent (unprobed or offline media)
 *  means the drop is rejected rather than adding a zero-length clip. */
export interface DraggedMedia {
  id: string;
  sourcePath: string;
  name: string;
  frameCount?: number | null;
  /** D-129 — whether this source has a decodeable audio stream, so the drop
   *  knows whether to build a linked audio half at all. Mirrors
   *  `MediaItem.video.hasAudio` (`@chroma/bridge`), which mirrors
   *  `chroma::video::VideoInfo::has_audio`. Absent/`null` = **not known**
   *  (a pool item imported before D-129 that hasn't been re-probed), which is
   *  treated as "no audio half" — the same conservative reading
   *  `clipFromDraggedMedia` already gives an absent `frameCount`. This is the
   *  real signal D-097's `inferNewTrackKind` explicitly flagged as missing
   *  ("`DraggedMedia`/`MediaItem` carry NO real audio-vs-video signal today
   *  … without a real backend model change"). */
  hasAudio?: boolean | null;
  /** B-075/D-193 — the source's own real frame rate (`MediaItem.video.fps`),
   *  threaded onto the built `Clip` as `source_fps` — see that field's own
   *  doc for why. `null`/absent for a pool item probed before this field
   *  existed; the built clip simply has no `source_fps` either, same
   *  conservative "unknown, don't invent a number" reading `hasAudio` above
   *  already uses. */
  fps?: number | null;
}

/** Every `Clip` field except `start_frame` — a dropped clip doesn't know its
 *  timeline position yet (D-058): that depends on the *target* track's
 *  current contents (append after its last clip), which only `applyOp`'s
 *  `add_clip` case knows at the moment the op is actually applied. Building
 *  a placeholder `start_frame` here (the pre-D-058 bug: simply omitting the
 *  field) is exactly what let a dropped clip land with no real position. */
export type NewClipFields = Omit<Clip, 'start_frame'>;

/** Build a full-length clip (minus `start_frame` — see `NewClipFields`)
 *  referencing a dropped pool item, or `null` if it has no known frame count
 *  (unprobed / offline — nothing to place). */
export function clipFromDraggedMedia(media: DraggedMedia): NewClipFields | null {
  const pair = linkedClipsFromDraggedMedia(media);
  return pair && pair.video;
}

/** D-129 — the real "drop a clip, get V1 + a linked A1" pair, the owner's
 *  own ask ("in palmier and other, any time i drop a clip it … created a
 *  linked track in audio") and the default behaviour of every reference NLE
 *  (Premiere patches a dropped clip to V1 *and* A1; Resolve links the two
 *  and propagates every move/trim/delete between them).
 *
 *  Returns the video half plus, when the source really has an audio stream,
 *  a second full `Clip` for that audio — a genuinely separate, independently
 *  addressable clip (confirmed against both references: the audio half is a
 *  real clip on its own track that Unlink makes fully independent, not a
 *  sub-part of the video clip) — with both halves carrying the same
 *  `link_group`. `audio: null` for a silent source, or one whose audio status
 *  isn't known (`hasAudio` absent, a pre-D-129 pool item): no audio half is
 *  invented, and the video clip stays `link_group`-free so `chroma::audio`
 *  keeps playing its embedded stream exactly as it does today (D-050).
 *
 *  `null` overall for media with no usable frame count, same as before. */
export function linkedClipsFromDraggedMedia(
  media: DraggedMedia,
): { video: NewClipFields; audio: NewClipFields | null } | null {
  const frames = media.frameCount ?? 0;
  if (!frames || frames <= 0) return null;
  const stamp = Date.now().toString(36);
  const linkGroup = media.hasAudio ? `lg-${media.id}-${stamp}` : null;
  const common = {
    shot_id: null,
    // D-070: the pool-item link — this is the one real place a Clip gets
    // built from a known media pool item on the frontend (a Sources-panel
    // drag), so it's the one place that can set this for free.
    media_id: media.id,
    name: media.name,
    source_path: media.sourcePath,
    source_start: 0,
    duration: frames,
    source_len: frames,
    source_fps: media.fps ?? undefined,
  };
  const video: NewClipFields = { id: `${media.id}-${stamp}`, link_group: linkGroup, ...common };
  if (!linkGroup) return { video, audio: null };
  // Same source window, same length — the audio half starts life exactly
  // congruent with the picture, and only diverges if the user deliberately
  // unlinks and slips it (an L-cut).
  const audio: NewClipFields = { id: `${media.id}-${stamp}-a`, link_group: linkGroup, ...common };
  return { video, audio };
}

export function timelineFps(tl: Timeline | null): number {
  const r = tl?.rate;
  if (r && r.num > 0 && r.den > 0) return r.num / r.den;
  return DEFAULT_FPS;
}

/** Length of `tr` in frames — the furthest clip end, mirroring
 *  `chroma-timeline::Track::duration` (D-054): clips may leave a trailing
 *  gap, so this is a max over `endFrame`, not a sum of durations. `fps` —
 *  B-077 — is the project's own `timelineFps(tl)`, needed by `endFrame`. */
export function trackDuration(tr: Track, fps: number): number {
  return tr.clips.reduce((max, c) => Math.max(max, endFrame(c, fps)), 0);
}

export function timelineDuration(tl: Timeline | null): number {
  if (!tl || tl.tracks.length === 0) return 0;
  const fps = timelineFps(tl);
  return Math.max(0, ...tl.tracks.map((tr) => trackDuration(tr, fps)));
}

/** First video track index, or 0. */
export function videoTrackIndex(tl: Timeline): number {
  const i = tl.tracks.findIndex((t) => t.kind === 'video');
  return i >= 0 ? i : 0;
}

/** D-095 — where a new clip of `duration` frames should land on `tr` if
 *  dropped at `frame`, and whether making room requires shifting anything.
 *
 *  Real NLEs distinguish two cases when a Sources-panel clip is dropped over
 *  an existing track: dropped into an open gap big enough to hold it (no
 *  other clip moves — consistent with this model's normal "explicit
 *  position, overlap rejected" contract, D-054/D-058) or dropped where
 *  there's no room (between two touching/too-close clips, or before the
 *  first) — a real ripple insert, the one place this model intentionally
 *  gains ripple behaviour (`applyOp`'s `add_clip` case is the only thing
 *  that ever shifts another clip's `start_frame` out from under it;
 *  `remove`/`trim_start`/`trim_end`/`split`/`move` all stay explicit-
 *  position-only, by design — see their own doc comments).
 *
 *  Snaps `frame` to the nearest clip edge (start or end of any clip already
 *  on `tr`, or 0) within `snapFrames`, so a visually "between these two"
 *  drop doesn't need pixel-perfect aim — mirrors the snap-assist
 *  `TimelinePane` already gets for free from the timeline library's own
 *  `dragLine` (D-051), just for this drag, which the library has no
 *  cross-drag-type concept of.
 *
 *  D-100 — a third case, found live: hovering somewhere in the MIDDLE of an
 *  existing clip, too far from either of ITS OWN edges for the snap above
 *  to catch, with no open gap there either. Owner: "when i try to add a
 *  clip between two which was already added does not work" — when two
 *  clips are already touching (zero gap, the ordinary state for a real
 *  edit, not an edge case), the ONLY way into the snap branch above was a
 *  pixel-precise hit on the seam between them; everywhere else on either
 *  clip's own body fell through to "no open gap" and silently appended at
 *  the track's end instead — which reads as "does not work," not "needs a
 *  wider gap." Falls back to whichever HALF of the clip currently under
 *  `frame` is closer — insert before it if `frame`'s in its first half,
 *  after it if its second — so the clip's own full body becomes a real,
 *  unambiguous insertion target instead of a dead zone. `null` is now only
 *  a drop in a genuinely empty region too far from anything to mean
 *  anything specific — the caller falls back to plain append there.
 *
 *  `incoming` is the clip actually being placed (its `duration`/`source_fps`,
 *  B-077) rather than a bare frame count: every real caller already has the
 *  full clip (a Sources-panel drop, or an existing clip being repositioned),
 *  and its `duration` is in ITS OWN native source frames per the `Clip` doc
 *  — converting it to timeline frames needs `source_fps`, which a bare
 *  number can't carry. `fps` is the project's own `timelineFps(tl)`. */
export function computeInsertion(
  tr: Track,
  frame: number,
  incoming: Pick<Clip, 'duration' | 'source_fps'>,
  snapFrames: number,
  fps: number,
): { startFrame: number; ripple: boolean } | null {
  const clips = tr.clips;
  if (clips.length === 0) return { startFrame: Math.max(0, frame), ripple: false };

  const duration = sourceFramesToTimeline(incoming, incoming.duration, fps);
  const fitsNoOverlap = (pos: number) =>
    !clips.some((c) => pos < endFrame(c, fps) && pos + duration > c.start_frame);

  const edges = new Set<number>([0]);
  for (const c of clips) {
    edges.add(c.start_frame);
    edges.add(endFrame(c, fps));
  }
  let snapped: number | null = null;
  let bestDist = snapFrames + 1;
  edges.forEach((e) => {
    const d = Math.abs(e - frame);
    if (d <= snapFrames && d < bestDist) {
      bestDist = d;
      snapped = e;
    }
  });

  if (snapped !== null) {
    const pos: number = snapped;
    return fitsNoOverlap(pos) ? { startFrame: pos, ripple: false } : { startFrame: pos, ripple: true };
  }

  if (fitsNoOverlap(frame)) return { startFrame: Math.max(0, frame), ripple: false };

  const covering = clips.find((c) => frame >= c.start_frame && frame < endFrame(c, fps));
  if (covering) {
    const mid = covering.start_frame + sourceFramesToTimeline(covering, covering.duration, fps) / 2;
    const pos = frame < mid ? covering.start_frame : endFrame(covering, fps);
    return fitsNoOverlap(pos) ? { startFrame: pos, ripple: false } : { startFrame: pos, ripple: true };
  }

  return null;
}

/** D-104 — where an EXISTING clip should land when dragged onto `dest`
 *  (same-track reposition or cross-track move) at `intendedFrame`. Owner's
 *  explicit, absolute direction after live-testing D-096/D-100: "i should be
 *  able to drop it before any clip, between two clip or after two clip, not
 *  on top of the clip... that should not be possible" — landing mid-overlap
 *  is never a reachable outcome of a plain drag, full stop, not "allowed
 *  unless you signal otherwise." This is the exact question `computeInsertion`
 *  already answers for a brand-new clip dropped from Sources — reused here
 *  rather than a second placement algorithm, with the moving clip's own
 *  current slot excluded (by id) so it doesn't collide with itself when it's
 *  already sitting on `dest`. Falls back to appending after everything else
 *  on `dest` on the rare `computeInsertion` `null` case (a frame that's
 *  neither near a snap edge nor inside/adjacent to any clip's span, and NOT
 *  a plain open fit either), same safe default `add_clip` itself falls back
 *  to. This REVERSES D-096's "cross-track overlap allowed" policy — see the
 *  `move` `EditOp`'s own doc for why; real intentional layer-stacking (V1/V2
 *  compositing, D-088) stays possible via other means, just not as a side
 *  effect of where a drag happens to land. */
export function resolveClipLanding(
  dest: Track,
  movingClipId: string,
  moving: Pick<Clip, 'duration' | 'source_fps'>,
  intendedFrame: number,
  snapFrames: number,
  fps: number,
): { startFrame: number; ripple: boolean } {
  const withoutSelf: Track = { ...dest, clips: dest.clips.filter((c) => c.id !== movingClipId) };
  const insertion = computeInsertion(withoutSelf, Math.max(0, intendedFrame), moving, snapFrames, fps);
  if (insertion) return insertion;
  return { startFrame: nextAppendFrame(withoutSelf, fps), ripple: false };
}

/** D-105 — the exclusive `[gapStart, gapEnd)` bounds of the REAL, closeable
 *  gap containing `frame` on `tr`, or `null` if there isn't one. Mirrors
 *  `chroma-timeline::Track::gap_at` field-for-field (same two "there isn't
 *  one" cases: `frame` is inside a clip, or it's trailing empty space past
 *  the last clip — nothing after it to ripple, so not a real gap). Clips are
 *  walked by value, never assumed to be in position order (D-054). */
export function gapAt(tr: Track, frame: number, fps: number): { gapStart: number; gapEnd: number } | null {
  if (frame < 0 || clipAt(tr, frame, fps)) return null;
  let gapStart = 0;
  for (const c of tr.clips) {
    const e = endFrame(c, fps);
    if (e <= frame && e > gapStart) gapStart = e;
  }
  let gapEnd: number | null = null;
  for (const c of tr.clips) {
    if (c.start_frame > gapStart && (gapEnd === null || c.start_frame < gapEnd)) gapEnd = c.start_frame;
  }
  return gapEnd === null ? null : { gapStart, gapEnd };
}

/** Where a new clip appended to `tr` should start — right after the
 *  furthest-out clip already on it (0 for an empty track). Mirrors what
 *  `backfill_legacy_positions` reconstructs for a legacy back-to-back track,
 *  but computed directly rather than relying on that migration path (see
 *  D-058 — that reliance was the drag-and-drop bug). */
export function nextAppendFrame(tr: Track, fps: number): number {
  return trackDuration(tr, fps);
}

/** The clip with `id` on `track`, by id (not position) — the lookup both
 *  `TimelinePane` (selection UI) and `EditorInspectorPanel` (now a sibling
 *  component, not nested inside `TimelinePane`, per the "full height, not
 *  squeezed into the timeline" panel move) need for the same selected clip,
 *  kept here once rather than duplicated in both. */
export function findClip(tl: Timeline | null, track: number, id: string): { clip: Clip; index: number } | null {
  const clips = tl?.tracks[track]?.clips ?? [];
  const index = clips.findIndex((c) => c.id === id);
  return index >= 0 ? { clip: clips[index], index } : null;
}

/** The clip covering `frame` (by its real `start_frame`, D-054/D-058 — Vec
 *  order is bookkeeping only, never assumed to match position order) and
 *  the source frame inside it. Mirrors `chroma-timeline::Track::clip_at`. */
export function clipAt(
  tr: Track,
  frame: number,
  fps: number,
): { clip: Clip; index: number; sourceFrame: number } | null {
  if (frame < 0) return null;
  for (let i = 0; i < tr.clips.length; i++) {
    const c = tr.clips[i];
    if (frame >= c.start_frame && frame < endFrame(c, fps)) {
      // B-077 — `frame - c.start_frame` is a TIMELINE-frame offset into the
      // clip; converting it to c's own SOURCE frames (what `source_start`
      // is in) needs `timelineFramesToSource`, not a direct add.
      return {
        clip: c,
        index: i,
        sourceFrame: c.source_start + timelineFramesToSource(c, frame - c.start_frame, fps),
      };
    }
  }
  return null;
}

/** Shift every clip on `tr` starting at/after `threshold` by `delta` frames
 *  (positive = later, negative = earlier) — mirrors `chroma-timeline::
 *  shift_clips_at_or_after` (D-106) exactly, the one real ripple-shift
 *  primitive shared by `add_clip`'s insertion ripple, `move`'s ripple, and
 *  `remove_gap` (a real, pre-existing triplication in this file this pass
 *  cleans up rather than adding a fourth copy). Mutates `tr.clips` in place
 *  — callers already work on a `clone()`d timeline before calling this. */
function shiftClipsAtOrAfter(tr: Track, threshold: number, delta: number): void {
  for (const c of tr.clips) {
    if (c.start_frame >= threshold) c.start_frame += delta;
  }
}

/** Auto-decommission an empty track (owner, live: "if we have an empty
 *  track we auto decommission it and renumber the tracks... not
 *  unnecessary empty tracks"). Deliberately narrow, not a blanket sweep of
 *  every track in the timeline: only the ONE track a `remove`/cross-track
 *  `move` op just directly emptied gets pruned here — a track that started
 *  this op already empty (e.g. one the owner just added via `add_track` and
 *  hasn't placed a clip on yet) is left alone. Checked live against real
 *  reference behavior, not assumed: neither Premiere Pro nor DaVinci
 *  Resolve auto-removes an empty track by default (both require an
 *  explicit "Delete Empty Tracks" action) — this is a deliberate, informed
 *  deviation from that convention for this specific op class, per the
 *  owner's own explicit ask, not an oversight. `Vec`/array removal renumbers
 *  the remaining tracks by construction (index-derived labels, `labels[i]`
 *  in `TimelinePane.tsx`, are already correct with no further change) — the
 *  caller (`timelineStore.ts::applyOp`) is responsible for remapping any
 *  *selection* state that held a track index across this call, the same
 *  class of index-shift the track-reorder drag's own `trackIndexAfterMove`
 *  already has to handle. Mirrors `chroma-timeline::Timeline::{remove,
 *  move_clip}`'s own end-of-function prune exactly. */
function pruneIfEmptyTrack(tracks: Track[], trackIdx: number): void {
  if (tracks[trackIdx]?.clips.length === 0) tracks.splice(trackIdx, 1);
}

/** The sync-lock version of `shiftClipsAtOrAfter` (D-106) — mirrors
 *  `chroma-timeline::ripple_shift_with_auto_split` field-for-field. For a
 *  track receiving someone ELSE's ripple (never the track directly being
 *  edited, which keeps using the plain shift above and D-104's own
 *  reject-on-straddle contract unchanged). A clip straddling `threshold`
 *  (starts before it, ends after it) is auto-split there first — the
 *  owner's own explicit call, matching Resolve's real behavior: rejecting
 *  would make sync-lock block ripples constantly whenever a straddling clip
 *  (a music bed, room tone — sync-lock's own headline use case) sits on a
 *  synced track. The new right half gets a derived id (`${id}·${threshold}`,
 *  this file's existing `split` id convention) so the ripple-flash diff
 *  effect in `TimelinePane.tsx` picks it up and flashes it — an auto-split
 *  is automatic but never silent. */
/** B-033 — REVERTED from auto-split to reject-on-straddle, a deliberate
 *  safety rollback, not a redesign. The auto-split version (D-106/D-107)
 *  let a REPEATED ripple (several real remove_gap/move/add_clip ops in the
 *  same session, each individually correct in isolation) keep re-splitting
 *  a fragment created by a PREVIOUS ripple — confirmed on the owner's real
 *  `New.chroma` project: the same source clip ended up split into a chain
 *  of ever-smaller slivers (four consecutive 166-frame fragments of one
 *  clip) and the same clip id appearing three times on one track at wildly
 *  different positions, with the project's total duration growing instead
 *  of shrinking after closing a gap. All 93 existing single-operation unit
 *  tests passed throughout — the bug is in the cross-operation, cumulative
 *  case those tests never exercised, not in any single call's math. Rather
 *  than ship a fix for a multi-operation interaction not fully reproduced
 *  and verified under time pressure, this reverts to exactly D-104's own
 *  already-proven-safe same-track contract: a straddling clip on a
 *  sync-locked track REJECTS the whole op (same as an unresolvable
 *  same-track overlap), never splits. Auto-split may come back as a real,
 *  separately-scoped, separately-verified follow-up — see B-033. */
/** Returns *which* track index has a clip straddling `threshold` (or `null`
 *  if none does) — `applyOp` uses this to reject a ripple that can't clear a
 *  straddling clip (B-033); the visual sync-highlight in `TimelinePane.tsx`
 *  (owner, 2026-09-04: "for sync when i select on is should see all the sync
 *  selected") reuses the same predicate to find which OTHER clips a
 *  selection's own sync-locked tracks are really linked to. */
function findStraddlingSyncLockedTrack(
  tracks: Track[],
  editedTrack: number,
  threshold: number,
  fps: number,
): number | null {
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (i === editedTrack || !(t.sync_locked ?? DEFAULT_SYNC_LOCKED) || t.locked) continue;
    if (t.clips.some((c) => c.start_frame < threshold && endFrame(c, fps) > threshold)) return i;
  }
  return null;
}

/** Owner, 2026-09-04: "for sync when i select one is should see all the sync
 *  selected" — a real, proactive visual instead of a reactive error toast
 *  (see B-033's own UX follow-up for the toast approach this replaces).
 *
 *  For each selected clip, walks every OTHER `sync_locked` (and not
 *  individually `locked`) track and collects every clip on it that a ripple
 *  originating at the selected clip's own `start_frame` would touch —
 *  exactly the same two predicates `propagateSyncLockRipple`/
 *  `findStraddlingSyncLockedTrack` already use for the real ripple
 *  mechanics, not a second, only-approximately-matching definition: a clip
 *  starting at/after the threshold (would SHIFT together) or straddling it
 *  (would BLOCK the ripple, B-033). Both read as "this clip is really tied
 *  to the selection via sync-lock" — the caller renders one shared secondary
 *  highlight for the whole set, distinct from the primary selection ring. */
function collectSyncLinkedClips(
  tracks: Track[],
  editedTrack: number,
  threshold: number,
  fps: number,
): Set<string> {
  const linked = new Set<string>();
  tracks.forEach((t, i) => {
    if (i === editedTrack || !(t.sync_locked ?? DEFAULT_SYNC_LOCKED) || t.locked) return;
    for (const c of t.clips) {
      if (c.start_frame >= threshold || (c.start_frame < threshold && endFrame(c, fps) > threshold)) {
        linked.add(c.id);
      }
    }
  });
  return linked;
}

export function syncLinkedClipIds(tl: Timeline, selection: { track: number; id: string }[]): Set<string> {
  const linked = new Set<string>();
  const fps = timelineFps(tl);
  for (const sel of selection) {
    const track = tl.tracks[sel.track];
    const clip = track?.clips.find((c) => c.id === sel.id);
    if (!clip) continue;
    for (const id of collectSyncLinkedClips(tl.tracks, sel.track, clip.start_frame, fps)) linked.add(id);
  }
  return linked;
}

/** Live drag-preview variant of `syncLinkedClipIds` — same shared predicate
 *  (`collectSyncLinkedClips`), but from an explicit `(track, thresholdFrame)`
 *  pair instead of an existing selected clip's own `start_frame`. Needed
 *  because a clip mid-drag to a new track isn't a member of that track's
 *  `clips` yet, so there's no real clip to look up — `TimelinePane.tsx`'s
 *  `onDndDragMove` passes the live-resolved landing track/frame straight
 *  through instead. D-113 (owner: "if both are synced, then both should
 *  move together and hover together" — the drag-preview follow-up to
 *  D-111's selection-time highlight; D-112 is a concurrent, unrelated
 *  fork's own number — checked before claiming this one). */
export function syncLinkedClipIdsAtPosition(tl: Timeline, track: number, thresholdFrame: number): Set<string> {
  return collectSyncLinkedClips(tl.tracks, track, thresholdFrame, timelineFps(tl));
}

/** Propagate a ripple already applied to `editedTrack` (index into
 *  `tracks`) to every OTHER track whose `sync_locked` is on — mirrors
 *  `chroma-timeline::propagate_sync_lock_ripple`. A track that's BOTH
 *  sync-locked AND individually `locked` is skipped, same real judgment
 *  call as the Rust side's own doc: `locked` already means "protect this
 *  track's clips from edits through the normal ops," and a foreign ripple
 *  shifting this track's clips is exactly that. Plain shift only — callers
 *  MUST check `findStraddlingSyncLockedTrack` first and reject the whole op
 *  if it returns non-null (B-033); this function assumes that's already been
 *  done and never splits. */
function propagateSyncLockRipple(tracks: Track[], editedTrack: number, threshold: number, delta: number): void {
  tracks.forEach((t, i) => {
    if (i !== editedTrack && (t.sync_locked ?? DEFAULT_SYNC_LOCKED) && !t.locked) {
      shiftClipsAtOrAfter(t, threshold, delta);
    }
  });
}

// --------------------------------------------------------------------------- //
// A/V link groups (D-129, `docs/notes/av-linking.md`) — mirrors the Rust
// crate's own link helpers field-for-field.
// --------------------------------------------------------------------------- //

/** Every `[trackIndex, clipIndex]` whose clip belongs to `group`, ascending —
 *  mirrors `chroma-timeline::Timeline::link_group_members`. Index-based, so
 *  only valid until the next mutation. */
export function linkGroupMembers(tl: Timeline, group: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  tl.tracks.forEach((t, ti) => {
    t.clips.forEach((c, ci) => {
      if (c.link_group && c.link_group === group) out.push([ti, ci]);
    });
  });
  return out;
}

/** The group id + member locations for the clip at `(track, clip)`, or `null`
 *  when it's unlinked — mirrors Rust's `link_targets`, the lookup every
 *  link-aware op starts from. */
function linkTargets(
  tl: Timeline,
  track: number,
  clip: number,
): { group: string; members: Array<[number, number]> } | null {
  const group = tl.tracks[track]?.clips[clip]?.link_group;
  if (!group) return null;
  return { group, members: linkGroupMembers(tl, group) };
}

/** Every clip id linked to any clip in `selection` (excluding the selection's
 *  own ids) — what `TimelinePane` paints its link highlight from, so grabbing
 *  one half visibly shows the other. The link-group counterpart of
 *  `syncLinkedClipIds`, deliberately a SEPARATE set: sync-lock ("these tracks
 *  ripple together") and an A/V link ("these clips ARE one shot") are
 *  different relationships and read as different things on screen. */
export function linkedClipIds(tl: Timeline, selection: { track: number; id: string }[]): Set<string> {
  const own = new Set(selection.map((s) => s.id));
  const linked = new Set<string>();
  for (const sel of selection) {
    const group = tl.tracks[sel.track]?.clips.find((c) => c.id === sel.id)?.link_group;
    if (!group) continue;
    for (const [ti, ci] of linkGroupMembers(tl, group)) {
      const id = tl.tracks[ti].clips[ci].id;
      if (!own.has(id)) linked.add(id);
    }
  }
  return linked;
}

/** One clip's address for [`checkLink`]/the `link` op — `{ track, clip }`
 *  index pair, same addressing every other per-clip op on this surface uses. */
export interface LinkTarget {
  track: number;
  clip: number;
}

/** The result of [`checkLink`] — `ok: false` always carries a human-readable
 *  `reason`, precisely so `TimelinePane`'s Link button can surface it rather
 *  than just disabling silently (the owner's own ask: "surface a clear
 *  reason when it's not available, don't just hide the button"). */
export interface LinkCheck {
  ok: boolean;
  reason?: string;
}

/** D-138 — the shared precondition check behind `applyOp`'s `link` case AND
 *  `TimelinePane`'s Link button, so the two can never disagree about when
 *  linking is allowed: the button enables/disables and shows `reason` from
 *  exactly the same logic that decides whether `applyOp` actually mutates
 *  anything. Mirrors `chroma_timeline::Timeline::link`'s own validation
 *  order (self-link → range → lock → already-linked → kind-mismatch) so the
 *  first reason surfaced here is the first one the Rust op would reject on
 *  too, if this were ever sent through `chroma_timeline_link_clips` instead
 *  of `chroma_timeline_set`. */
export function checkLink(tl: Timeline, a: LinkTarget, b: LinkTarget): LinkCheck {
  if (a.track === b.track && a.clip === b.clip) {
    return { ok: false, reason: 'Select two different clips' };
  }
  const trackA = tl.tracks[a.track];
  const trackB = tl.tracks[b.track];
  const clipA = trackA?.clips[a.clip];
  const clipB = trackB?.clips[b.clip];
  if (!trackA || !trackB || !clipA || !clipB) {
    return { ok: false, reason: 'Clip not found' };
  }
  if (trackA.locked || trackB.locked) {
    return { ok: false, reason: 'A track in the selection is locked' };
  }
  if (clipA.link_group || clipB.link_group) {
    return { ok: false, reason: 'Already linked — unlink first' };
  }
  if (trackA.kind === trackB.kind) {
    return { ok: false, reason: 'Select one video clip and one audio clip' };
  }
  return { ok: true };
}

/** Where `startFrame` ends up once a pending ripple is applied — mirrors
 *  `chroma-timeline::start_after_ripple`. Lets a linked move be accepted or
 *  rejected before anything is mutated. */
function startAfterRipple(startFrame: number, rippled: boolean, threshold: number, delta: number): number {
  return rippled && startFrame >= threshold ? startFrame + delta : startFrame;
}

/** The clamped head-trim delta `trim_start` would really apply — mirrors
 *  `chroma-timeline::clamped_trim_start_delta`, extracted for the same D-129
 *  reason (asking every link-group member for its own clamp before mutating).
 *  Caller guarantees `clipIdx` is in range.
 *
 *  B-077 — `delta`/the return value are **timeline** frames (the UI drag is
 *  always computed against the project's own pixels-per-frame, and this is
 *  what gets added straight onto `start_frame`); the two source-frame bounds
 *  (`source_start`'s own `[0, source_len)` window) are converted to timeline
 *  frames via `sourceFramesToTimeline` before clamping against them, so `d`
 *  stays a single, consistent unit throughout. The caller (`applyOp`'s
 *  `trim_start` case) is responsible for converting the returned timeline
 *  delta back to `c`'s own source frames before touching `source_start`/
 *  `duration` (`timelineFramesToSource`) — this function never touches
 *  either field itself. */
function clampedTrimStartDelta(tr: Track, clipIdx: number, delta: number, fps: number): number {
  const c = tr.clips[clipIdx];
  const ceiling = Math.max(c.source_len, 0);
  const prevEnd = tr.clips.reduce((max, other, i) => {
    if (i === clipIdx) return max;
    const oe = endFrame(other, fps);
    return oe <= c.start_frame ? Math.max(max, oe) : max;
  }, 0);
  const lowerBound = sourceFramesToTimeline(c, -c.source_start, fps);
  const upperBound = sourceFramesToTimeline(c, Math.max(ceiling - 1, 0) - c.source_start, fps);
  const d = clampInt(delta, lowerBound, upperBound);
  return Math.max(d, prevEnd - c.start_frame);
}

/** The clamped new `duration` `trim_end` would really apply — mirrors
 *  `chroma-timeline::clamped_trim_end_duration`. Returns a new `duration`
 *  (source frames, per the `Clip` doc — the caller applies it to that field
 *  directly, unlike `clampedTrimStartDelta` above). `delta` is a TIMELINE
 *  frame delta (B-077, same UI-drag convention as `trim_start`'s), converted
 *  to `c`'s own source frames before it ever touches `duration`; the
 *  following-clip position bound (naturally a timeline-frame quantity —
 *  `nextStart - c.start_frame`) is converted the same way before being
 *  compared against the source-frame media-length bound, so `Math.min` never
 *  compares two different units again. */
function clampedTrimEndDuration(tr: Track, clipIdx: number, delta: number, fps: number): number {
  const c = tr.clips[clipIdx];
  const ceiling = Math.max(c.source_len, 0);
  const maxDurSource = Math.max(ceiling - c.source_start, 1);
  let nextStart: number | null = null;
  for (const [i, other] of tr.clips.entries()) {
    if (i === clipIdx || other.start_frame < c.start_frame) continue;
    if (nextStart === null || other.start_frame < nextStart) nextStart = other.start_frame;
  }
  const maxDurPositionSource =
    nextStart === null
      ? Infinity
      : Math.max(timelineFramesToSource(c, Math.max(nextStart - c.start_frame, 1), fps), 1);
  const maxDur = Math.max(Math.min(maxDurSource, maxDurPositionSource), 1);
  const deltaSource = timelineFramesToSource(c, delta, fps);
  return clampInt(c.duration + deltaSource, 1, maxDur);
}

/** The clamped slip delta the `slip` `EditOp` (D-195) would really apply —
 *  same TIMELINE-frame convention as `clampedTrimStartDelta`/
 *  `clampedTrimEndDuration` above (the UI drag is computed against the
 *  project's own pixels-per-frame). A slip moves `source_start` inside its
 *  OWN `[0, source_len - duration]` window — `duration` is fixed (the whole
 *  point of a slip), so unlike `clampedTrimStartDelta` there is no `prevEnd`
 *  neighbour term to fold in: `start_frame` never moves, so there's nothing
 *  for it to collide with. Caller guarantees `clipIdx` is in range. */
function clampedSlipDelta(tr: Track, clipIdx: number, delta: number, fps: number): number {
  const c = tr.clips[clipIdx];
  const maxSourceStart = Math.max(c.source_len - c.duration, 0);
  const lowerBound = sourceFramesToTimeline(c, -c.source_start, fps);
  const upperBound = sourceFramesToTimeline(c, maxSourceStart - c.source_start, fps);
  return clampInt(delta, lowerBound, upperBound);
}

// --------------------------------------------------------------------------- //
// D-235 — the shared, NEIGHBOUR-FREE trim bounds the context-sensitive trim
// tool's three new modes (ripple trim, roll, slide) are all built from.
//
// `clampedTrimStartDelta`/`clampedTrimEndDuration` above each fold a neighbour
// term into their clamp, because a plain trim leaves every other clip exactly
// where it is (D-058) and therefore MUST refuse to cross one. Ripple, roll and
// slide are precisely the modes that move the neighbour too, so that term is
// not just unnecessary for them, it is wrong — it would clamp a ripple at the
// very cut it is supposed to push through. These two helpers are the same
// clamps with only the SOURCE-media half kept, which is what those three modes
// share; they are deliberately separate functions rather than a boolean
// parameter on the existing pair, so the plain-trim path this file has had
// since D-058 is untouched, byte for byte.
// --------------------------------------------------------------------------- //

/** The TIMELINE-frame delta range (`[lo, hi]`, positive = later) within which
 *  `c`'s HEAD (in-point) may move using only its own source media:
 *  `source_start` stays ≥ 0 and at least one frame of the clip survives. The
 *  clip's OUT point is held fixed, so `duration` absorbs the whole delta. */
function headRoom(c: Clip, fps: number): [number, number] {
  return [
    sourceFramesToTimeline(c, -c.source_start, fps),
    sourceFramesToTimeline(c, Math.max(c.duration - 1, 0), fps),
  ];
}

/** [`headRoom`]'s counterpart for `c`'s TAIL (out-point), same convention:
 *  `duration` may shrink to 1 and may grow until the source media runs out
 *  (`source_start + duration <= source_len`). The clip's IN point is fixed. */
function tailRoom(c: Clip, fps: number): [number, number] {
  return [
    sourceFramesToTimeline(c, 1 - c.duration, fps),
    sourceFramesToTimeline(c, Math.max(c.source_len - c.source_start - c.duration, 0), fps),
  ];
}

/** D-235 — every `[trackIdx, clipIdx]` a one-sided edit at `(track, clip)`
 *  must apply to in lockstep: the clip itself, plus every other member of its
 *  A/V link group (D-129). `null` means REJECT THE WHOLE OP — a member's track
 *  is locked — which is the same reject-rather-than-desync discipline
 *  `trim_start`/`trim_end`/`slip` each already implement inline; this is that
 *  shared preamble, extracted so roll/slide/ripple-trim inherit it rather than
 *  growing a fourth and fifth copy of it. */
function lockstepTargets(tl: Timeline, track: number, clip: number): Array<[number, number]> | null {
  const link = linkTargets(tl, track, clip);
  if (!link) return [[track, clip]];
  if (link.members.some(([ti]) => tl.tracks[ti]?.locked)) return null;
  return link.members;
}

/** The intersection of `room` across every lockstep target — the delta range
 *  EVERY member of the group can absorb. `lo > hi` means no delta at all works
 *  and the caller must refuse, which is the range-valued form of the existing
 *  ops' "if any member clamps differently, reject the whole op" rule: rather
 *  than asking each member to clamp the raw delta and comparing the answers,
 *  the group's shared range is computed once and the delta clamped into it, so
 *  every member provably applies the identical on-screen delta. */
function lockstepRoom(
  tl: Timeline,
  targets: Array<[number, number]>,
  room: (c: Clip, fps: number) => [number, number],
  fps: number,
): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [ti, ci] of targets) {
    const c = tl.tracks[ti]?.clips[ci];
    if (!c) return [0, -1];
    const [l, h] = room(c, fps);
    lo = Math.max(lo, l);
    hi = Math.min(hi, h);
  }
  return [lo, hi];
}

/** True when any two clips on `tr` overlap in time.
 *
 *  D-235 — the RESULT check `roll` and `slide` validate themselves with. Both
 *  ops move two or three clips at once, and each of those clips may drag a
 *  whole A/V link group on other tracks along with it, so the set of
 *  neighbours that could be collided with is not knowable from the two or
 *  three indices the op names. Enumerating every member's own neighbour bound
 *  up front is the kind of thing that is subtly wrong for exactly one link
 *  topology; checking the finished timeline instead is cheap (a track holds
 *  tens of clips) and cannot be wrong. A failed check rejects the op whole —
 *  the same no-partial-application contract every link-aware op here has. */
function hasOverlap(tr: Track, fps: number): boolean {
  const sorted = [...tr.clips].sort((a, b) => a.start_frame - b.start_frame);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start_frame < endFrame(sorted[i - 1], fps)) return true;
  }
  return false;
}

/** First unlocked audio track with room for `[startFrame, startFrame +
 *  duration)` (both timeline frames — B-077, unlike `Clip.duration` this is
 *  already a footprint on the timeline, e.g. `sourceFramesToTimeline`'s
 *  output) — mirrors `chroma-timeline::Timeline::audio_track_with_room`. */
export function audioTrackWithRoom(tl: Timeline, startFrame: number, duration: number): number | null {
  const end = startFrame + duration;
  const fps = timelineFps(tl);
  const i = tl.tracks.findIndex(
    (t) =>
      t.kind === 'audio' &&
      !t.locked &&
      !t.clips.some((c) => startFrame < endFrame(c, fps) && end > c.start_frame),
  );
  return i >= 0 ? i : null;
}

/** [`audioTrackWithRoom`], appending a brand-new audio track when none has
 *  room — mirrors `chroma-timeline::Timeline::ensure_audio_track_with_room`.
 *  Mutates `tracks` in place (callers already hold a `clone()`d timeline) and
 *  uses the SAME track shape `add_track` builds, rather than a second
 *  track-creation path (D-095/D-096/D-117's one real mechanism). A fresh
 *  track is empty, so the returned index is always genuinely free — which is
 *  what makes "a dropped clip's audio half always lands somewhere valid" a
 *  guarantee with no failure branch. `duration` is a TIMELINE-frame footprint
 *  (B-077 — see [`audioTrackWithRoom`]'s own doc), not the audio clip's raw
 *  `.duration` field. */
export function ensureAudioTrackWithRoom(tl: Timeline, startFrame: number, duration: number): number {
  const existing = audioTrackWithRoom(tl, startFrame, duration);
  if (existing !== null) return existing;
  tl.tracks.push({ kind: 'audio', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
  return tl.tracks.length - 1;
}

// --------------------------------------------------------------------------- //
// pure edit ops — return a NEW timeline (or the same ref if the op is a no-op)
// --------------------------------------------------------------------------- //

function clone(tl: Timeline): Timeline {
  return typeof structuredClone === 'function'
    ? structuredClone(tl)
    : JSON.parse(JSON.stringify(tl));
}

export type EditOp =
  /** Vec **storage order** only (D-054) — does not move the clip in time.
   *  Kept for API completeness / bookkeeping; the timeline UI's clip-body
   *  drag uses `move`, below, not this. */
  | { kind: 'reorder'; track: number; from: number; to: number }
  /** `ripple` (D-235) — the RIPPLE half of the context-sensitive trim tool
   *  (roadmap item 27). Without it these are exactly what they have always
   *  been since D-058: only this clip changes, and the gap the trim opens (or
   *  the neighbour it refuses to cross) is real and stays on screen.
   *
   *  With `ripple: true` the trim additionally shifts every clip at/after this
   *  clip's own CURRENT end frame on the same track by the amount the out
   *  point moved, so no gap is opened and no neighbour blocks the trim —
   *  Blackmagic's own definition, from the reference this was built against
   *  (`scratch/resolve-reference/`, "Automatically Trim and Tighten"):
   *  "Rippling will extend or shorten the beginning or end of a clip. When you
   *  ripple an edit point, everything to the right of the edit is pushed down
   *  the timeline or pulled in to accommodate the clip's new duration."
   *
   *  A rippled `trim_start` deliberately leaves `start_frame` ALONE (unlike
   *  the plain one, which moves it and opens a gap before the clip): the head
   *  is trimmed in place, the clip's END moves earlier by the same delta, and
   *  everything downstream follows it. That is what makes a ripple leave no
   *  gap on either side. The clamp drops the neighbour term the plain trims
   *  carry — see `headRoom`/`tailRoom` — because the neighbour is exactly what
   *  a ripple is allowed to move.
   *
   *  Reuses this file's ONE ripple-shift primitive (`shiftClipsAtOrAfter` +
   *  `propagateSyncLockRipple`, and B-033's reject-on-straddle guard), the
   *  same one `add_clip`/`move`/`remove_gap` already ripple with — not a
   *  second ripple concept. */
  | { kind: 'trim_start'; track: number; clip: number; delta: number; ripple?: boolean }
  | { kind: 'trim_end'; track: number; clip: number; delta: number; ripple?: boolean }
  /** D-235 — ROLL: drag the edit POINT between two touching clips, moving the
   *  outgoing clip's out point and the incoming clip's in point together by
   *  the same delta. `clip` is the OUTGOING (left) clip; the incoming one is
   *  found by position — the clip on the same track whose `start_frame` is
   *  exactly this clip's end frame. No edit point there (a gap, or the end of
   *  the track) means there is nothing to roll and the op is refused: two
   *  edges with space between them are two independent trims, which is a
   *  different gesture and a different op.
   *
   *  The sequence's total duration is unchanged by construction — nothing but
   *  those two clips' shared boundary moves — which is exactly what
   *  distinguishes a roll from a ripple. Blackmagic's own words: "A roll trim
   *  works on both the left and right sides of an edit at the same time. While
   *  one side is shortened, the other side is extended by the same number of
   *  frames so the overall length of your timeline remains the same."
   *
   *  Both sides roll their whole A/V link group in lockstep (D-129), and the
   *  delta is clamped into the range EVERY member on BOTH sides can absorb, so
   *  a roll either happens identically everywhere or not at all. */
  | { kind: 'roll'; track: number; clip: number; delta: number }
  /** D-235 — SLIDE: move a clip along the timeline WITHOUT changing its own
   *  duration or its source window, letting its neighbours absorb the
   *  movement — the previous clip's out point and the next clip's in point
   *  each move by the same delta. Blackmagic again: "Sliding changes a clip's
   *  position on the timeline without changing its length. The clips on the
   *  left and right get shorter or longer as you slide the clip in the middle.
   *  You can think of a slide like a roll between 3 clips."
   *
   *  A neighbour is a *touching* one (its end is exactly this clip's start, or
   *  its start exactly this clip's end). With a touching neighbour on a side,
   *  that neighbour absorbs the movement; with only free space there, the
   *  clamp is that free space instead, so a slide at the head or tail of a
   *  track still works and simply cannot push past whatever is really in the
   *  way. With NO neighbour and no obstacle on either side the op is refused:
   *  nothing would absorb anything and the gesture is a plain `move`, which is
   *  a different op with different semantics (and its own overlap contract,
   *  D-104). */
  | { kind: 'slide'; track: number; clip: number; delta: number }
  /** D-195 — Task 1, `docs/notes/timeline-editing-feature-gap-analysis.md`
   *  item 1: slip a clip's SOURCE window in place — `start_frame` and
   *  `duration` are BOTH left untouched, only `source_start` moves. This is
   *  exactly what distinguishes a slip from `trim_start`/`trim_end` (which
   *  each change one of those two fixed fields instead). `delta` is a
   *  TIMELINE-frame delta, same UI-drag convention as `trim_start`/
   *  `trim_end`'s own `delta` (B-077) — converted to `c`'s own SOURCE frames
   *  before touching `source_start`. Clamped so the clip's `[source_start,
   *  source_start+duration)` window stays inside `[0, source_len)` — mirrors
   *  `trim_start`/`trim_end`'s own `source_len` bound (see
   *  `clampedSlipDelta`), just without their "can't collide with a neighbour"
   *  term, since `start_frame` never moves here — there is no neighbour to
   *  collide with.
   *
   *  D-129 — a linked A/V pair slips in lockstep (same reject-the-whole-op-
   *  rather-than-desync discipline `trim_start`/`trim_end` already use) — see
   *  `unlink`'s own doc, which already names this exact escape hatch: "the
   *  escape hatch for an L-cut — unlink, slip one half." Unlink first for an
   *  independent slip of just one half. */
  | { kind: 'slip'; track: number; clip: number; delta: number }
  | { kind: 'split'; track: number; clip: number; atFrame: number }
  | { kind: 'remove'; track: number; clip: number }
  /** D-105 — select an empty stretch of track (not a clip) and delete IT:
   *  close the gap at `frame` on `track`, shifting every clip at/after the
   *  gap's end earlier by the gap's own width. The deliberate mirror image
   *  of `remove` (a "lift," leaves a gap, see that op's own doc) — a real
   *  NLE always pairs the two: delete a CLIP and the space stays, delete a
   *  GAP and the space closes. `frame` just needs to land anywhere inside
   *  the gap being closed (`gapAt` finds its exact bounds); refused as a
   *  no-op if `frame` isn't inside a real, closeable gap on `track` (either
   *  it's inside a clip, the track is locked, or it's trailing empty space
   *  past the last clip — nothing there to ripple). */
  | { kind: 'remove_gap'; track: number; frame: number }
  /** D-046 pass 3 — drag a Sources-panel pool item onto the timeline. Appends
   *  a full-length clip referencing the media (or inserts at `atIndex`). If
   *  `track` doesn't exist yet (a brand new timeline has `tracks: []` — see
   *  `chroma_timeline_create`), a video track is created to hold it.
   *  `start_frame` (D-058) is computed by `applyOp` itself — always the end
   *  of whatever's already on the target track, i.e. a plain append, UNLESS
   *  `startFrame` is given (D-095 — a drop snapped to a specific insertion
   *  point, computed by `computeInsertion` at drop time). `ripple: true`
   *  means every clip on `track` at/after `startFrame` shifts later by the
   *  new clip's `duration` to make room — the one place this model
   *  intentionally gains ripple behaviour, see `computeInsertion`'s own doc
   *  for why (this is NOT extended to `remove`/`trim`/`split`/`move`, all of
   *  which stay explicit-position-only by design, D-054).
   *
   *  D-129 — `linkedAudio` is the dropped source's **own embedded audio, as a
   *  second real clip**: when set, this op also places it on an audio track
   *  (the first one with room at the same `startFrame`, else a brand-new one
   *  appended via the same shape `add_track` builds — see
   *  `ensureAudioTrackWithRoom`), both halves already carrying the same
   *  `link_group`. Deliberately ONE op rather than two chained ones so the
   *  pair is atomic: one history entry, one undo, and never a half-linked
   *  timeline in between. Absent = today's behaviour exactly (a silent
   *  source, or a pool item whose audio status isn't known). */
  /*
   *  B-129/D-262 — `onNewVideoTrack: true` places the clip on a **brand-new,
   *  empty video track inserted at index 0**, i.e. the top of the compositing
   *  stack (a LOWER index paints on top, D-086), and `track` is ignored.
   *
   *  This is what "add a title" means: a title is an OVERLAY, and the owner's
   *  own words for the bug were "it should be added on a new timeline meaning
   *  a new track instead of adding on top of other". Reusing an existing video
   *  track is not a smaller version of that — a title dropped into a GAP in the
   *  footage track renders over BLACK instead of over the picture, which is
   *  what the owner's real project actually contained. Resolve's own Edit page
   *  says the same thing ("drag it into the timeline **above your video
   *  tracks**"), and D-230's adjustment clip has the identical requirement for
   *  its own reason (it corrects the layers BENEATH it, so a track that already
   *  holds footage is the wrong place for it).
   *
   *  **One op, not three.** `placeDroppedClip` builds the same outcome for a
   *  DROP as `add_track` + `move_track` + `add_clip`, which is three history
   *  entries and therefore three Undos for one gesture. Folded into this op it
   *  is atomic — the same reasoning D-129 used to fold a dropped source's audio
   *  half in here, and the same shape D-239's `place_on_top` already has.
   *  A fresh track is always empty, so this branch cannot fail to place.
   */
  | {
      kind: 'add_clip';
      track: number;
      clip: NewClipFields;
      atIndex?: number;
      startFrame?: number;
      ripple?: boolean;
      linkedAudio?: NewClipFields;
      onNewVideoTrack?: boolean;
    }
  /** D-239 (roadmap item 27) — **the seven edit types on drop**: Insert,
   *  Overwrite, Replace, Fit to Fill, Place on Top, Append at End, Ripple
   *  Overwrite. One op carrying an `editType` rather than seven ops, and
   *  emphatically not a client-side sequence of existing ops — see D-239, but
   *  the short version is the same reason D-129 folded a dropped source's audio
   *  half into `add_clip` instead of chaining two ops: this store pushes **one
   *  history entry per applied op**, so a two-op Insert (split, then rippled
   *  `add_clip`) would take two Undos and leave the razor cut behind after the
   *  first. Every one of the seven is atomic here.
   *
   *  `clip` is the incoming source, exactly as `add_clip` takes it (built by
   *  `linkedClipsFromDraggedMedia` for a GUI drop, by `editor_edit_in`'s own
   *  media-pool lookup for an agent). `atFrame` is the **playhead** — the
   *  position every one of these edits is defined against in the reference
   *  ("at the location of the playhead"); `append` ignores it by definition.
   *  `track` is the DESTINATION video track.
   *
   *  The three target-taking types (`replace`, `fit_to_fill`,
   *  `ripple_overwrite`) act on **the clip covering `atFrame` on `track`**, and
   *  are refused when there isn't one. That is one rule, matching this model's
   *  existing position-is-truth contract (D-054) rather than introducing a
   *  second, selection-shaped one — the GUI honours a selection by passing that
   *  clip's own track and `start_frame`, so "replace the selected clip" and
   *  "replace what's under the playhead" are the same call.
   *
   *  Per type, in Blackmagic's own words (`scratch/resolve-reference/`,
   *  `edit-seven-ways`), and what each does here:
   *
   *  - **`insert`** — "pushes everything else down to make room for it. If the
   *    playhead is in the middle of a clip, it will split the clip." Splits the
   *    straddling clip at `atFrame` first (the same split arithmetic and the
   *    same `id`/`link_group` derivation the `split` op uses), then rippled
   *    exactly like `add_clip`'s own ripple — `shiftClipsAtOrAfter` plus
   *    `propagateSyncLockRipple`, behind B-033's reject-on-straddle guard.
   *  - **`overwrite`** — "place a new clip on the timeline at the location of
   *    the playhead, writing over whatever clip or clips were there before."
   *    Clears `[atFrame, atFrame + duration)` on the destination track
   *    ([`clearWindow`]) and places into the hole. **Nothing ripples**, which is
   *    the whole distinction from `insert`.
   *  - **`replace`** — "Replaces a single clip on the timeline with one of the
   *    exact same length. The out point of the clip you are editing in will be
   *    changed so it fits perfectly." The target's `start_frame` and its exact
   *    timeline footprint are preserved; the incoming source's `duration` is
   *    re-cut to fill it. Refused when the source is too short to cover it —
   *    silently placing something shorter would leave a gap the editor did not
   *    ask for, and Resolve refuses this case too.
   *  - **`fit_to_fill`** — "adds a speed change to speed it up or slow it down.
   *    The speed change is automatically calculated so it fits into the space
   *    you have selected." Same slot as `replace`, but the source keeps its full
   *    marked length and gets a **flat one-point D-236 speed ramp** instead —
   *    which is why this needed no new retiming concept at all. Refused when the
   *    required speed falls outside `[MIN_SPEED, MAX_SPEED]`.
   *  - **`place_on_top`** — "puts the clip on the next available video track at
   *    the location of the playhead. Great for titles, graphics or picture in
   *    picture." Walks UP the z-order (a LOWER index paints on top, D-086) from
   *    `track` for the first video track with room at `[atFrame, atFrame+dur)`,
   *    and inserts a brand-new video track at index 0 when none has any. Nothing
   *    on the track it came from is disturbed.
   *  - **`append`** — "places the source clip after the last edit on your
   *    timeline, regardless of where the playhead is located." `nextAppendFrame`
   *    on the destination track — byte-for-byte what a plain `add_clip` with no
   *    `startFrame` already did, kept as one of the seven so the overlay and the
   *    MCP tool can name it.
   *  - **`ripple_overwrite`** — "replaces a shot of one length with a shot of a
   *    different length. Longer clips … push everything down to make room, while
   *    shorter clips pull things in so there are no gaps." The target is removed
   *    outright, the incoming clip takes its `start_frame` at its OWN full
   *    length, and everything at/after the target's old end shifts by the
   *    difference (sync-locked tracks included, same B-033 guard).
   *
   *  **`linkedAudio` rides along by exactly the `add_clip` rule** — placed at
   *  the same start frame on the first audio track with room, else a fresh one
   *  (`ensureAudioTrackWithRoom`). It is deliberately NOT given its own
   *  overwrite/ripple treatment: these seven all target ONE destination track,
   *  and Resolve's own per-A/V destination patching is a separate feature (named
   *  as a follow-up in `docs/04-roadmap.md`). The consequence, stated plainly:
   *  an `overwrite` clears the picture track but its audio half lands wherever
   *  there is room rather than overwriting an audio track too. */
  | {
      kind: 'edit_in';
      editType: DropEditType;
      track: number;
      clip: NewClipFields;
      atFrame: number;
      linkedAudio?: NewClipFields;
    }
  /** D-058/D-080 — reposition a clip in time, and optionally onto a
   *  different track (`fromTrack !== toTrack`) — the drag handle / "move to
   *  another track" affordance in the panel. Mirrors
   *  `chroma-timeline::Timeline::move_clip(from_track, from_idx, to_track,
   *  to_start_frame)` field-for-field, extended with `ripple` (D-104).
   *
   *  D-104 — **overlap is rejected for every move now, same-track or
   *  cross-track**, unless `ripple: true`. This reverses D-096's "cross-track
   *  overlap allowed" policy: D-096 reasoned that since D-088's compositor
   *  renders every visible track together, two clips overlapping in time
   *  across tracks is a normal composited stack, not an error — true in
   *  principle, but live-tested and explicitly overridden by the owner:
   *  landing directly on top of another clip should never be a reachable
   *  outcome of a plain drag. The caller (`TimelinePane`'s
   *  `resolveClipLanding`, mirroring `computeInsertion`) is expected to
   *  always resolve a real, non-overlapping `startFrame` before calling this
   *  — before the first clip, snapped into an open gap, or `ripple: true`
   *  to make room between two already-touching clips (shifting every clip on
   *  `toTrack` at/after `startFrame` later by this clip's own duration,
   *  mirroring `add_clip`'s existing ripple contract) — never a silent
   *  overlap. If `startFrame` still overlaps something and `ripple` isn't
   *  set (a caller bug, not an expected path), the op is rejected (no-op)
   *  rather than corrupting the timeline. */
  | { kind: 'move'; fromTrack: number; toTrack: number; clip: number; startFrame: number; ripple?: boolean }
  /** D-080 — append a new empty track. Mirrors `chroma_timeline::Timeline::
   *  add_track`: always succeeds, no validation to mirror. */
  | { kind: 'add_track'; trackKind: 'video' | 'audio' | 'subtitle' }
  /** D-080 — remove a track and every clip on it (no confirmation/undo
   *  special-casing here — same as the Rust op, recovery is the shared
   *  undo stack's job like any other edit, D-051). Mirrors `chroma_timeline
   *  ::Timeline::remove_track`: no-op (rejected) for an out-of-range index. */
  | { kind: 'remove_track'; track: number }
  /** D-080 — set a track's linear volume multiplier (D-057's `Track.gain`).
   *  The panel's mute toggle uses this (`gain: 0` / restore to `1`) rather
   *  than a separate boolean field, matching what `chroma::audio`'s mixer
   *  already reads — "muted" has no independent representation to drift
   *  out of sync with the actual gain. No validation to mirror (the Rust
   *  field is a plain `f32` with no clamp of its own). */
  | { kind: 'set_track_gain'; track: number; gain: number }
  /** D-086/D-089 — toggle a track's lock. Mirrors `chroma_timeline::Track::
   *  locked`: always succeeds (locking is itself a track-list-level op, not
   *  gated by its own lock — matches `add_track`/`remove_track`/`move_track`'s
   *  own unlocked status in `track_mut`'s doc). */
  | { kind: 'set_track_locked'; track: number; locked: boolean }
  /** D-086/D-089 — toggle a track's visibility in the compositor. Mirrors
   *  `chroma_timeline::Track::hidden`. Always succeeds — same reasoning as
   *  `set_track_locked`. */
  | { kind: 'set_track_hidden'; track: number; hidden: boolean }
  /** D-106 — toggle a track's cross-track ripple sync. Mirrors
   *  `chroma_timeline::Track::sync_locked`. Always succeeds — same
   *  track-list-level reasoning as `set_track_locked`/`set_track_hidden`. */
  | { kind: 'set_track_sync_locked'; track: number; syncLocked: boolean }
  /** D-149 — set a track's ducking: which track triggers it (`duckFrom`, or
   *  `null` to turn ducking off) and the three real DSP numbers. Mirrors
   *  `chroma_timeline::Track`'s `duck_from`/`duck_db`/`duck_attack_ms`/
   *  `duck_release_ms`.
   *
   *  Its **own** op, not folded into `set_track_gain`, for the same reason
   *  D-147 kept `set_clip_fade` out of `set_clip_transform`: gain is a fader a
   *  mute toggle writes on every click, ducking is a routing relationship set
   *  once, and folding them would make every mute restate four ducking values
   *  it did not intend to touch.
   *
   *  Always succeeds for an in-range track — a track-level property like
   *  `set_track_gain`/`set_track_locked`, not gated by the track's own lock
   *  (which protects its clips, not its mix settings). A self-reference or an
   *  out-of-range `duckFrom` is stored as given and ignored at the point of
   *  use, matching Rust's `resolve_track_duck`: `chroma_timeline_set` stores
   *  whatever it is handed, so the consumer degrades safely regardless and this
   *  op does not need to be the only guard. */
  | {
      kind: 'set_track_duck';
      track: number;
      duckFrom: number | null;
      duckDb: number;
      duckAttackMs: number;
      duckReleaseMs: number;
    }
  /** D-129 — dissolve the COMPLETE A/V link group the clip at `(track, clip)`
   *  belongs to (not just remove that one clip from it): Palmier Pro's own
   *  documented `manage_clip_links` unlink semantics, and what Premiere's
   *  `Clip > Unlink` / Resolve's "Unlink Clips" both do. The escape hatch for
   *  an L-cut — unlink, slip one half, and (a later pass) relink. A no-op for
   *  an already-unlinked clip; refused if the clip's own track is locked.
   *  Mirrors `chroma_timeline::Timeline::unlink`. */
  | { kind: 'unlink'; track: number; clip: number }
  /** D-138, `docs/notes/av-linking.md` "Deferred" list — link two
   *  ALREADY-INDEPENDENT clips (one video-track, one audio-track) into a new
   *  A/V link group. Mirrors `chroma_timeline::Timeline::link` field-for-
   *  field, including its deliberately narrower scope vs. Palmier's own
   *  group-merging `link`: both clips must currently be unlinked, and the
   *  op is rejected whole (a no-op, same "reject rather than corrupt"
   *  discipline every other link-aware op here uses) rather than partially
   *  applied — see [`checkLink`], the shared precondition check `applyOp`
   *  and the toolbar's Link button both call, so the button's disabled-
   *  reason tooltip can never drift from what actually gets enforced.
   *  Order-independent — `{trackA, clipA}`/`{trackB, clipB}` may name
   *  either clip first, the resulting group id is the same either way. */
  | { kind: 'link'; trackA: number; clipA: number; trackB: number; clipB: number }
  /** D-086/D-089 — reorder the track list itself (compositing z-order,
   *  D-086's own doc: "track index order is compositing z-order, not
   *  cosmetic"). Mirrors `chroma_timeline::Timeline::move_track(from, to)`
   *  exactly: bounds-checked, `from === to` a genuine no-op, NOT gated by
   *  either track's lock (same track-list-vs-track-clips split as
   *  `add_track`/`remove_track`). */
  | { kind: 'move_track'; from: number; to: number }
  /** D-088/D-089 — set a clip's compositing transform (opacity/position/
   *  scale/rotation, **and D-132's four crop insets**), the interim
   *  popover's write op. Always replaces the
   *  full set together (no partial-field variant) since the UI edits one
   *  clip's transform as a single form; refused (no-op) if the clip's track
   *  is locked, same as every other per-clip op. Keyframes are a SEPARATE
   *  op (`set_clip_keyframes`, below) — a transform edit while keyframes
   *  exist is a "set the base/unkeyframed value" edit, matching how
   *  `resolve_clip_transform` (Rust, D-088) only falls back to the static
   *  fields when no keyframe covers the requested frame or none exist.
   *
   *  **D-132 — crop rides this op rather than getting a `set_clip_crop` of
   *  its own.** Both references present crop as a separate *mode* in the
   *  viewer, but that is an on-canvas affordance question, not a write-path
   *  one: crop and the D-082 five are one clip's geometry, edited from one
   *  form, and two ops would mean two history entries, two save round trips
   *  and a real ordering question between them for no gain. The fields are
   *  **required**, not optional-with-fallback, precisely because this op
   *  replaces the full set — an optional crop field would silently reset a
   *  clip's crop to zero on any caller that forgot it.
   *
   *  **D-193 — `box_width`/`box_height` are required `number | null` too,
   *  same convention `Track.set_track_duck`'s `duckFrom` already uses: an
   *  explicit `null` means "no override, derive this axis from `scale`"
   *  (the pre-D-193 behavior), a number is a real independent-axis
   *  override. Required rather than optional for the exact reason above —
   *  an omittable field could silently clear a clip's override on a caller
   *  that forgot to restate it, since `undefined` is not a legal value on a
   *  required field, only `null` (a real, deliberate choice) is. */
  | {
      kind: 'set_clip_transform';
      track: number;
      clip: number;
      opacity: number;
      position_x: number;
      position_y: number;
      scale: number;
      box_width: number | null;
      box_height: number | null;
      rotation: number;
      crop_left: number;
      crop_top: number;
      crop_right: number;
      crop_bottom: number;
    }
  /** D-089 — replace a clip's keyframe track outright (add/move/remove a
   *  keyframe is "recompute the array, then set it" client-side — mirrors
   *  the exact pattern `utils/maskKeyframes.ts`'s `upsertKeyframe`/
   *  `removeKeyframe`/`clearKeyframes` already use for mask/relight-light
   *  keyframes; this op is the timeline-clip equivalent write). `keyframes:
   *  []` and `keyframes: undefined` are both "no keyframes" — normalized to
   *  `undefined` on write so an empty array never round-trips as a
   *  keyframed clip. Refused (no-op) if the clip's track is locked. */
  | {
      kind: 'set_clip_keyframes';
      track: number;
      clip: number;
      /** D-233 — [`ClipKeyframe`], so an entry's optional `ease` map rides
       *  along. This op stays the ONE write for every keyframe change the app
       *  makes (a per-property diamond, "key all properties", a delete, and now
       *  a curve drag): the array is the unit of truth, `clipKeyframes.ts`
       *  computes the next one, and this writes it. A separate
       *  `set_keyframe_ease` op would have been a second writer to the same
       *  field with its own locked-track/normalisation rules to keep in step,
       *  for no expressiveness the array does not already have. */
      keyframes: ClipKeyframe[];
    }
  /** D-147 — set a clip's fade in/out durations and curve shapes. Refused
   *  (no-op) if the clip's track is locked, same as every other per-clip op.
   *
   *  **Its own op rather than riding `set_clip_transform`**, which is the
   *  opposite call D-132 made for crop, and deliberately so. Crop rides the
   *  transform op because crop and the D-082 five are one clip's *geometry*,
   *  edited from one form. A fade is not geometry — it is a time-domain
   *  envelope over whatever that geometry produces, it applies to audio-track
   *  clips that have no transform at all, and (unlike crop) it is the one
   *  clip property an MCP agent is expected to set on its own without
   *  touching the transform. Folding it into `set_clip_transform` would mean
   *  every fade write also restated four crop insets and five transform
   *  values it did not intend to change — precisely the "an optional field
   *  would silently reset" hazard that op's own doc names as the reason its
   *  fields are required.
   *
   *  Durations are **frames** and are floored at 0 on the way in; the curves
   *  are optional and default to `linear` (the server's own default), so a
   *  caller that only wants to change a duration need not restate them. */
  | {
      kind: 'set_clip_fade';
      track: number;
      clip: number;
      fade_in_frames: number;
      fade_out_frames: number;
      fade_in_curve?: EaseCurve;
      fade_out_curve?: EaseCurve;
    }
  /** D-236 — replace a clip's speed ramp outright. Refused (no-op) if the
   *  clip's track is locked, same as every other per-clip op.
   *
   *  **Whole-array replacement, exactly like `set_clip_keyframes`**, and for
   *  the same reason: adding, moving, deleting or re-speeding a point is
   *  "recompute the array, then set it" client-side, and a second op per
   *  gesture would be a second writer to one field with its own normalisation
   *  and locked-track rules to keep in step. `speedRamp.ts`'s
   *  `normalizeSpeedPoints` is applied on the way in, so `[]`, `undefined`,
   *  an unsorted list and a list of no-op points all store as "no ramp".
   *
   *  **Its own op rather than riding `set_clip_transform`**, for
   *  `set_clip_fade`'s reasons exactly: speed is not geometry, it applies to
   *  audio-track clips that have no transform at all, and that op's fields
   *  are required (an omitted one resets), so a speed change through it would
   *  restate — and could silently reset — the clip's whole transform.
   *
   *  **It changes the clip's timeline footprint** (`endFrame`), which no other
   *  per-clip op does. It is deliberately NOT rippling: the clips after it
   *  stay where they are, so a ramp can open a gap or overlap a neighbour
   *  exactly as a trim would, and the editor closes it with the tools that
   *  already exist (`remove_gap`, a move). Resolve behaves the same way with
   *  "ripple sequence" off, which is its own default. */
  | {
      kind: 'set_clip_speed';
      track: number;
      clip: number;
      points: SpeedPoint[];
    }
  /** D-223 — set a clip's OWN audio level: linear `volume` and normalised
   *  `pan`. Refused (no-op) if the clip's track is locked, same as every other
   *  per-clip op.
   *
   *  **Its own op, for `set_clip_fade`'s reasons exactly** (and not
   *  `set_clip_transform`'s): a level is not geometry, it applies to
   *  audio-track clips that have no transform at all, and it is a property an
   *  MCP agent sets on its own without touching the picture. Folding it into
   *  `set_clip_transform` would mean every volume nudge also restated nine
   *  geometry values it did not intend to change — the "an optional field
   *  would silently reset" hazard that op's own doc names.
   *
   *  **Distinct from `set_track_gain` (D-057/D-080), which it does not
   *  replace**: that is the whole track's fader, this is one clip on it, and
   *  the mixer multiplies both. Neither can express the other.
   *
   *  Both fields are optional and each is left exactly as it was when omitted
   *  — unlike `set_clip_fade`'s durations, which are required because a fade's
   *  two ends are authored together (a drag on one handle). Volume and pan are
   *  independent controls with independent rows, so a partial write is the
   *  normal case rather than a hazard. Values are clamped on the way in
   *  (`clampClipVolume` / `clampClipPan`). */
  | {
      kind: 'set_clip_audio';
      track: number;
      clip: number;
      volume?: number;
      pan?: number;
    }
  /** D-224 — edit ONE band of a clip's parametric EQ, or clear the whole set.
   *
   *  **Its own op, for `set_clip_audio`'s and `set_clip_fade`'s reasons
   *  exactly**: an EQ is not geometry and not a level, it applies to
   *  audio-track clips with no transform at all, and it is what an MCP agent
   *  reaches for without touching anything else on the clip.
   *
   *  **One band per op, and every field independently optional.** A band is
   *  four independent controls edited one at a time (a frequency drag, a gain
   *  nudge, a kind change) — the same partial-write shape `set_clip_audio` has
   *  and for the same reason, so a gain nudge can never restate a frequency it
   *  never looked at. Values are clamped on the way in (`clampEqBand`).
   *
   *  **`band` may address a band the clip does not have yet.** A clip with no
   *  stored EQ MATERIALISES `defaultEqBands()` — Resolve's own four-band strip,
   *  every band inert at 0 dB — before the patch lands, so the Inspector's
   *  first edit writes a whole coherent strip rather than a lone orphan band
   *  at index 2. An index outside that strip is a no-op, not a grow: the band
   *  count is an authoring decision (see `EQ_BAND_COUNT`), and a reducer that
   *  silently extended the list on a typo'd index would make a 40-band EQ
   *  reachable by accident.
   *
   *  `clear: true` drops the whole set back to no EQ — the section-level reset,
   *  and the only way back to a clip that serialises no `eq_bands` key at all.
   *  It ignores `band`/the patch fields. */
  | {
      kind: 'set_clip_eq';
      track: number;
      clip: number;
      band?: number;
      patch?: Partial<EqBand>;
      clear?: boolean;
    }
  /** D-195 — Task 2, `docs/notes/timeline-editing-feature-gap-analysis.md`
   *  item 2: replace a clip's underlying source media (`source_path`/
   *  `media_id`) IN PLACE — every other field (`start_frame`, the full
   *  compositing transform, `chroma_keyframes`, the fade fields,
   *  `link_group`) is preserved exactly. Before this op the only way to
   *  change a clip's source was remove-and-re-add, which loses all of those.
   *
   *  `source_len`/`source_fps` are the NEW source's own real probed values,
   *  resolved by the caller (`useEditorControl.ts`'s `editor_swap_clip_media`,
   *  the same media-pool lookup `editor_add_clip` already does) — this pure
   *  reducer has no access to the media pool store itself, so it cannot probe
   *  anything on its own. `source_fps` absent means the new source was never
   *  successfully probed (mirrors `Clip.source_fps`'s own doc) — this ALWAYS
   *  overwrites the clip's previous `source_fps`, it never keeps the old
   *  clip's rate, because after a swap the old rate describes a file this
   *  clip no longer points at (exactly the B-075/B-077 class of silent
   *  wrongness this closes off at the write path).
   *
   *  **Re-clamping when the new source is SHORTER than the clip's current
   *  `[source_start, source_start+duration)` window — a real judgment call,
   *  documented in D-195:** `source_start` is preserved exactly whenever it
   *  still fits inside the new source; only pinned back to the new source's
   *  own last frame when it doesn't. `duration` is then shrunk (never grown)
   *  to whatever remains of the new source from that `source_start` — the
   *  clip's own TIMELINE FOOTPRINT can shrink as a result (`start_frame`
   *  never moves, so this can open a gap after it, same as `trim_end`
   *  shortening a clip already can) rather than the whole op being refused,
   *  so a caller isn't forced to pre-compute a duration that happens to
   *  already fit before a swap is even possible. The common case — the new
   *  file is at least as long as what the window needed — is a pure
   *  preserve, no re-clamping at all.
   *
   *  **Does NOT lock-step with the clip's `link_group`**, unlike
   *  `trim_start`/`trim_end`/`slip`/`split` — their lockstep exists because
   *  both members share the SAME underlying recording and must stay in sync
   *  with it. A media swap replaces the file outright; the two halves of a
   *  link no longer necessarily share anything at all, so only the ONE named
   *  clip is touched. Refused (no-op) if its own track is locked, same as
   *  every other per-clip op. */
  | {
      kind: 'swap_media';
      track: number;
      clip: number;
      media_id: string | null;
      source_path: string;
      source_len: number;
      source_fps?: number;
    }
  /** D-260 — a source file was REPLACED IN PLACE (same path, new content:
   *  what a Motion re-render to its fixed per-scene output path is), so every
   *  clip already reading it re-reads the new file's real length and rate.
   *
   *  **Not `swap_media` in a loop, for three reasons.** (1) `swap_media`
   *  addresses ONE clip by `(track, clip)` index; a replaced file can be on any
   *  number of clips across any number of tracks, and the caller — the
   *  composition root, reacting to a render that just finished — does not know
   *  where they are, only which media changed. (2) N `swap_media` ops is N undo
   *  entries for one action, which is the same argument `import_subtitles`
   *  already makes for being one op. (3) `swap_media`'s own name is a lie here:
   *  nothing is being swapped, the clip keeps the exact `media_id` and
   *  `source_path` it had. What it shares with `swap_media` is only the
   *  re-clamp, and that is shared as real code ([`reclampToSource`]), not
   *  copied.
   *
   *  Matches by `media_id` when given, falling back to `source_path` for a clip
   *  that predates the pool link (`Clip.media_id` is nullable by design) —
   *  the same two-key resolution `editor_add_clip` already does in the other
   *  direction. Every matched clip's `source_len`/`source_fps` are overwritten
   *  with the new file's own probed values and its window re-clamped exactly as
   *  a swap would; nothing else is touched.
   *
   *  **A no-op when nothing actually changed**, and that is the common case:
   *  a re-render whose scene is the same length leaves every clip
   *  byte-identical, so this returns the original timeline, `applyOp` writes
   *  nothing and no undo entry is pushed. The picture still updates — the file
   *  on disk changed, and the preview reads the file. Locked tracks are
   *  skipped, same as every other per-clip op. */
  | {
      kind: 'refresh_media';
      media_id: string | null;
      source_path: string;
      source_len: number;
      source_fps?: number;
    }
  /** D-211 — edit a TEXT clip's own text properties (content/font/size/
   *  colour). Refused (no-op) if the clip's track is locked, and refused if
   *  the target clip is not a text clip at all — a media clip has no text
   *  layer to patch, and silently creating one would turn a video into a
   *  title.
   *
   *  **Its own op rather than riding `set_clip_transform`**, the same call
   *  D-147 made for `set_clip_fade` and for the same reason: these are not
   *  geometry. `set_clip_transform` replaces a whole geometry form in one
   *  write; a title's text/font/colour is a different form, edited
   *  independently, and folding them together would make every nudge of
   *  `position_x` restate the title's own content.
   *
   *  **`patch`, not the full set** — the opposite of `set_clip_transform`'s
   *  all-required fields, deliberately. That op's fields are required because
   *  an omitted one would silently RESET a real value to a default. Here the
   *  reducer merges against the clip's existing layer via [`newTextLayer`],
   *  so an omitted field provably keeps its current value; requiring all four
   *  would only force every caller to restate a `content` string it is not
   *  changing. A patch that fails validation (multi-line content, a bad
   *  colour) is a no-op — the caller is expected to have run `newTextLayer`
   *  itself to get the real error message. */
  | { kind: 'set_text_clip'; track: number; clip: number; patch: Partial<TextLayer> }
  /** D-229 — replace one caption cue's text. Multi-line is legal (that is the
   *  whole point of a caption), so unlike `set_text_clip` there is nothing to
   *  reject; the reducer only refuses a clip that is not a caption, for the
   *  same reason `set_text_clip` refuses one that is not a title. */
  | { kind: 'set_caption_text'; track: number; clip: number; text: string }
  /** D-229 — patch the TRACK's caption style: the reference Inspector's
   *  "Track Style" tab, and how a whole imported `.srt` is styled in one
   *  action.
   *
   *  **A `patch`, not the full record** — `set_text_clip`/`set_marker`'s call,
   *  for the same reason: the reducer merges against what is there, so an
   *  omitted field provably keeps its value rather than silently resetting to
   *  a default. Refused on a track that is not a subtitle track. */
  | { kind: 'set_caption_style'; track: number; patch: Partial<CaptionStyle> }
  /** D-229 — the per-caption "Use Track Style" checkbox. A `patch` gives this
   *  cue its own style (unticking the box, merged over whatever it resolves to
   *  now, so the override starts from what the user can currently see rather
   *  than from the bare defaults); `null` clears it back to the track's
   *  (ticking the box). */
  | { kind: 'set_caption_cue_style'; track: number; clip: number; patch: Partial<CaptionStyle> | null }
  /** D-229 — import a whole subtitle file as a NEW subtitle track, in one
   *  undoable step.
   *
   *  **One op for the whole file, not N `add_clip`s.** A 400-cue `.srt` would
   *  otherwise be 400 undo entries and 400 whole-`Timeline` snapshots (D-051
   *  snapshots the timeline per op), which is both a miserable undo experience
   *  and a real memory cost. The cues arrive already converted to frames by
   *  the Rust parser (`chroma_import_subtitles`), which is the single place
   *  milliseconds ever meet the project timebase. */
  | {
      kind: 'import_subtitles';
      cues: Array<{ id: string; start_frame: number; duration: number; text: string }>;
      style?: Partial<CaptionStyle>;
    }
  /** D-230 — patch an ADJUSTMENT clip's colour correction. A `patch`, not the
   *  full set, for exactly `set_text_clip`'s reason: the reducer merges
   *  against the clip's existing layer via [`newAdjustmentLayer`], so an
   *  omitted parameter provably keeps its value, and requiring all five would
   *  force every caller (a single slider drag included) to restate four
   *  numbers it is not changing.
   *
   *  Refused on a clip that is not already an adjustment clip — see the
   *  reducer for why that matters more here than it looks. */
  | { kind: 'set_adjustment_clip'; track: number; clip: number; patch: Partial<AdjustmentLayer> }
  /** D-222 — pin a [`Marker`] to a timeline frame. A real `EditOp`, not a
   *  store field, and that is the deliberate difference from D-216's
   *  `selection` and D-218's `previewView`: those describe how the user is
   *  *looking* at the edit (never persisted, never undoable), a marker is
   *  something the user *wrote into* the edit — it belongs in `project.json`
   *  and a `cmd-Z` after adding one must remove it, which it gets for free
   *  from D-051's whole-`Timeline` snapshot mechanism by being here.
   *
   *  The caller builds the whole `Marker` (via [`newMarker`], which owns id
   *  generation and colour resolution), exactly like `add_clip` takes a
   *  fully-built `NewClipFields` — so the GUI button and `editor_add_marker`
   *  construct one the same way rather than two.
   *
   *  **The list is kept sorted by `frame`** here (and by `set_marker` below),
   *  not at read time: markers are rendered and listed in ruler order
   *  everywhere, and sorting once on write beats re-sorting on every render.
   *  Ties keep insertion order (`Array.sort` is stable), so two markers on
   *  one frame stay in the order they were added. Never rejected — any frame
   *  is a legal place for an annotation, including past the last clip. */
  | { kind: 'add_marker'; marker: Marker }
  /** D-222 — delete the marker with this id. A no-op (rejected) for an id
   *  that isn't there, same "reject rather than corrupt" discipline every
   *  other op here uses; not gated by any track's lock, since a marker
   *  belongs to no track. */
  | { kind: 'remove_marker'; id: string }
  /** D-222 — patch an existing marker's frame/colour/name/note.
   *
   *  **A `patch`, not the full record** — the same call `set_text_clip` made
   *  and for the same reason: the reducer merges against what is already
   *  there, so an omitted field provably keeps its value, and the popover's
   *  colour swatch does not have to restate the note it is not editing.
   *  (`set_clip_transform`'s all-fields-required shape exists because an
   *  omitted field there would silently RESET a real value; there is no such
   *  hazard in a merge.) An explicit `null` for `name`/`note` CLEARS it —
   *  the popover's own "clear the title" gesture — which `undefined` cannot
   *  express in a patch. */
  | {
      kind: 'set_marker';
      id: string;
      patch: { frame?: number; color?: string; name?: string | null; note?: string | null };
    }
  /** D-226 — place a transition at an edit point on `track`. The caller builds
   *  the whole `Transition` (via [`newTransition`], which owns id generation and
   *  colour resolution), exactly like `add_clip` takes a fully-built
   *  `NewClipFields` and `add_marker` a fully-built `Marker` — so the palette's
   *  drop gesture and `editor_add_transition` construct one the same way rather
   *  than two.
   *
   *  **Refused (a no-op) unless [`checkTransition`] passes**, which is where
   *  every real precondition lives: a locked or non-video track, a frame that
   *  is not a real cut, a window that would swallow a neighbouring clip or
   *  collide with another transition, and — for a cross dissolve — handle media
   *  that does not exist. Both callers run `checkTransition` themselves first so
   *  they can SAY why; this reducer re-checks for the same reason every other op
   *  here re-validates rather than trusting its caller.
   *
   *  **The list is kept sorted by `at_frame`** on write (like `add_marker`'s
   *  own), since a track's transitions are drawn and listed in timeline order
   *  everywhere. */
  | { kind: 'add_transition'; track: number; transition: Transition }
  /** D-226 — delete the transition with this id from `track`. A no-op for an id
   *  that isn't there, and refused on a locked track — same "reject rather than
   *  corrupt" discipline every other per-track op here uses. Touches no clip:
   *  removing a transition restores the plain cut, it never re-trims anything
   *  (the clips never moved to make room for it in the first place — D-226). */
  | { kind: 'remove_transition'; track: number; id: string }
  /** D-226 — patch an existing transition's kind / duration / alignment /
   *  colour. The Inspector's own fields and `editor_set_transition` both write
   *  through this.
   *
   *  **A `patch`, not the full record** — `set_text_clip`/`set_marker`'s call,
   *  for their reason: the reducer merges against what is there, so an omitted
   *  field provably keeps its value and a duration nudge need not restate the
   *  colour. `at_frame` is deliberately NOT patchable: moving a transition to a
   *  different cut is removing it from one and adding it to another, and a patch
   *  that silently re-homed it would skip the placement checks the add path
   *  runs. The merged result must still pass [`checkTransition`], so shortening
   *  a dissolve is always allowed and lengthening one past its handles is
   *  refused with the same message the add path gives. */
  | {
      kind: 'set_transition';
      track: number;
      id: string;
      patch: {
        kind?: TransitionKind;
        duration?: number;
        alignment?: TransitionAlignment;
        color?: string | null;
      };
    };

/** Clip name at `track`/`clip` in `tl`, or a short fallback — for history
 *  labels (D-051) only, never used in the actual edit logic below. */
function clipLabel(tl: Timeline, track: number, clip: number): string {
  const name = tl.tracks[track]?.clips[clip]?.name;
  return name ? `"${name}"` : 'clip';
}

/** D-222 — the marker's own name, or its frame, for a history label. Same
 *  role and same fallback shape as [`clipLabel`] above. */
function markerLabel(tl: Timeline, id: string): string {
  const m = tl.markers?.find((x) => x.id === id);
  if (!m) return id;
  return m.name ? `"${m.name}"` : `at ${m.frame}`;
}

/** D-226 — a transition kind's display label, or the raw value for one this
 *  build doesn't know (a project written by a newer version). History-label and
 *  UI use only, never the edit logic. */
function transitionLabel(kind: TransitionKind): string {
  return TRANSITION_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** D-226 — "Cross Dissolve at 48" for the transition with `id` on `track`, or
 *  the bare id if it isn't there. Same role and same fallback shape
 *  [`markerLabel`] plays for markers. */
function transitionAtLabel(tl: Timeline, track: number, id: string): string {
  const t = tl.tracks[track]?.transitions?.find((x) => x.id === id);
  return t ? `${transitionLabel(t.kind)} at ${t.at_frame}` : id;
}

/** Human-readable one-liner for an `EditOp`, evaluated against the timeline
 *  it's about to be applied to (`before`) — used as the `label` on the
 *  `@chroma/history` entry `useEditorTimelineStore.applyOp` pushes for every
 *  op (D-051). Pure and separately testable; not used by `applyOp` itself. */
export function labelForOp(op: EditOp, before: Timeline): string {
  switch (op.kind) {
    case 'reorder':
      return `Reorder ${clipLabel(before, op.track, op.from)}`;
    // D-235 — a ripple trim says so: "Trim" and "Ripple" are two different
    // edits to undo back past, and an entry that named only the clip would be
    // indistinguishable from the plain trim right above it in the stack.
    case 'trim_start':
      return `${op.ripple ? 'Ripple' : 'Trim'} ${clipLabel(before, op.track, op.clip)} (start)`;
    case 'trim_end':
      return `${op.ripple ? 'Ripple' : 'Trim'} ${clipLabel(before, op.track, op.clip)} (end)`;
    case 'slip':
      return `Slip ${clipLabel(before, op.track, op.clip)}`;
    // D-235 — a roll is named for the EDIT POINT it moved, not for one of its
    // two clips: naming either half alone reads as a trim of that half, which
    // is the one thing a roll is not.
    case 'roll':
      return `Roll edit after ${clipLabel(before, op.track, op.clip)}`;
    case 'slide':
      return `Slide ${clipLabel(before, op.track, op.clip)}`;
    case 'split':
      return `Split ${clipLabel(before, op.track, op.clip)}`;
    case 'remove':
      return `Remove ${clipLabel(before, op.track, op.clip)}`;
    case 'remove_gap':
      return `Close gap on track ${op.track + 1}`;
    case 'add_clip':
      // B-129/D-262 — the new-track case says so: this one op also created a
      // track, so its Undo removes one, and a history entry reading only
      // `Add "Title"` would not account for the track disappearing.
      if (op.onNewVideoTrack) return `Add "${op.clip.name}" on a new video track`;
      return op.linkedAudio ? `Add "${op.clip.name}" + audio` : `Add "${op.clip.name}"`;
    // D-239 — named for the EDIT TYPE, not just the clip: "Insert" and
    // "Overwrite" of the same source are two entirely different edits to undo
    // back past, and an entry saying only `Add "clip"` for both would make the
    // history stack unreadable exactly where it matters most.
    case 'edit_in':
      return `${dropEditTypeInfo(op.editType).label} "${op.clip.name}"`;
    case 'unlink':
      return `Unlink ${clipLabel(before, op.track, op.clip)}`;
    case 'link':
      return `Link ${clipLabel(before, op.trackA, op.clipA)} + ${clipLabel(before, op.trackB, op.clipB)}`;
    case 'move': {
      const label = clipLabel(before, op.fromTrack, op.clip);
      return op.fromTrack === op.toTrack ? `Move ${label}` : `Move ${label} to another track`;
    }
    case 'add_track':
      return `Add ${op.trackKind} track`;
    case 'remove_track':
      return `Remove track ${op.track + 1}`;
    case 'set_track_gain':
      return op.gain <= 0 ? `Mute track ${op.track + 1}` : `Unmute track ${op.track + 1}`;
    case 'set_track_locked':
      return op.locked ? `Lock track ${op.track + 1}` : `Unlock track ${op.track + 1}`;
    case 'set_track_hidden':
      return op.hidden ? `Hide track ${op.track + 1}` : `Show track ${op.track + 1}`;
    case 'set_track_sync_locked':
      return op.syncLocked ? `Sync-lock track ${op.track + 1}` : `Unsync track ${op.track + 1}`;
    case 'set_track_duck':
      return op.duckFrom == null
        ? `Stop ducking track ${op.track + 1}`
        : `Duck track ${op.track + 1} from track ${op.duckFrom + 1}`;
    case 'move_track':
      return `Reorder track ${op.from + 1}`;
    case 'set_clip_fade':
      return `Fade ${clipLabel(before, op.track, op.clip)}`;
    // D-236 — a flat speed and a real ramp read very differently in an undo
    // list ("Speed 200%" vs "Speed ramp"), and which one it is is exactly
    // what the editor is undoing.
    case 'set_clip_speed': {
      const pts = normalizeSpeedPoints(op.points);
      if (pts.length === 0) return `Reset ${clipLabel(before, op.track, op.clip)} speed`;
      if (pts.length === 1) return `Speed ${clipLabel(before, op.track, op.clip)} to ${Math.round(pts[0].speed * 100)}%`;
      return `Speed ramp ${clipLabel(before, op.track, op.clip)}`;
    }
    case 'set_clip_audio':
      // D-223 — "Level" rather than "Volume": one op carries both volume and
      // pan, and an undo entry that named only one of them would be wrong
      // half the time.
      return `Set ${clipLabel(before, op.track, op.clip)} level`;
    case 'set_clip_eq':
      // D-224 — the BAND is what an editor is undoing ("that was band 2, not
      // band 3"), and a label naming only the clip would be three identical
      // entries deep in a strip edit. The clear is its own sentence for the
      // same reason `set_track_duck`'s off-case is.
      return op.clear
        ? `Clear ${clipLabel(before, op.track, op.clip)} EQ`
        : `EQ band ${(op.band ?? 0) + 1} on ${clipLabel(before, op.track, op.clip)}`;
    case 'set_clip_transform':
      return `Adjust ${clipLabel(before, op.track, op.clip)}`;
    case 'set_clip_keyframes':
      return `Keyframe ${clipLabel(before, op.track, op.clip)}`;
    case 'swap_media':
      return `Swap media on ${clipLabel(before, op.track, op.clip)}`;
    // D-260 — names the FILE, not a clip: this op has no single clip to name
    // (it touches every clip reading that file), and the reason the user is
    // seeing an undo entry at all is that the file's length changed.
    case 'refresh_media':
      return `Refresh ${op.source_path.replace(/^.*[/\\]/, '')}`;
    case 'set_text_clip':
      // The content is the one patch field worth naming in an undo label —
      // "Edit title" tells you nothing when you have three of them.
      return op.patch.content !== undefined
        ? `Set title text to "${op.patch.content}"`
        : `Edit ${clipLabel(before, op.track, op.clip)} title`;
    // D-229 — same reasoning as the title label above: the text is the one
    // thing worth naming, since "Edit caption" says nothing when a timeline
    // holds four hundred of them.
    case 'set_caption_text':
      return `Set caption to "${captionLines(op.text)[0] ?? ''}"`;
    case 'set_caption_style':
      return 'Edit subtitle track style';
    case 'set_caption_cue_style':
      return op.patch === null ? 'Use track style for caption' : 'Override caption style';
    case 'import_subtitles':
      return `Import ${op.cues.length} subtitle${op.cues.length === 1 ? '' : 's'}`;
    // D-230 — name the parameter when exactly one changed, which is what a
    // slider drag or a single MCP call produces: "Adjust exposure" is a useful
    // undo entry, "Edit adjustment clip" three times over is not.
    case 'set_adjustment_clip': {
      const keys = Object.keys(op.patch);
      return keys.length === 1
        ? `Adjust ${keys[0]} on ${clipLabel(before, op.track, op.clip)}`
        : `Edit ${clipLabel(before, op.track, op.clip)} correction`;
    }
    // D-222 — a marker's own name is the one thing worth putting in an undo
    // label ("Add marker" three times over says nothing about which).
    case 'add_marker':
      return op.marker.name ? `Add marker "${op.marker.name}"` : `Add marker at ${op.marker.frame}`;
    case 'remove_marker':
      return `Remove marker ${markerLabel(before, op.id)}`;
    case 'set_marker':
      return `Edit marker ${markerLabel(before, op.id)}`;
    // D-226 — the transition's SHAPE is what an undo entry needs to name
    // ("Add transition" says nothing when a cut has had two tried on it).
    case 'add_transition':
      return `Add ${transitionLabel(op.transition.kind)} at ${op.transition.at_frame}`;
    case 'remove_transition':
      return `Remove transition ${transitionAtLabel(before, op.track, op.id)}`;
    case 'set_transition':
      return `Edit transition ${transitionAtLabel(before, op.track, op.id)}`;
    default:
      return 'Edit timeline';
  }
}

/** Clamp `v` into `[lo, hi]` — used throughout to mirror Rust's `i64::clamp`. */
function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Point `clip` at a source of `sourceLen` frames running at `sourceFps`,
 *  re-clamping its window to fit. Mutates and returns `clip`.
 *
 *  **D-195's re-clamp policy, extracted in D-260 so its two callers share it
 *  rather than repeat it.** `source_start` is preserved exactly whenever the
 *  source is still long enough to contain it, and only pinned back to the
 *  source's own last frame when it isn't; `duration` is then shrunk (never
 *  grown) to whatever remains from there. The clip's timeline footprint can
 *  therefore shrink — `start_frame` never moves, so that can open a gap after
 *  it, exactly as `trim_end` already can — rather than the whole op being
 *  refused. See `swap_media`'s own doc for why that shape was chosen.
 *
 *  `sourceFps` is ALWAYS overwritten, including to `undefined`: an un-probed
 *  source's rate is unknown, not "whatever the file used to be", and keeping a
 *  stale rate is precisely the B-075/B-077 class of silent wrongness. Both
 *  callers are write paths for "this clip's file is not the file it was."
 *
 *  Deliberately does NOT touch `media_id`/`source_path`: `swap_media` sets
 *  those itself (they change), `refresh_media` must not (they don't). */
function reclampToSource(clip: Clip, sourceLen: number, sourceFps: number | undefined): Clip {
  const ceiling = Math.max(sourceLen, 0);
  const clampedStart = clampInt(clip.source_start, 0, Math.max(ceiling - 1, 0));
  clip.source_len = sourceLen;
  clip.source_fps = sourceFps;
  clip.source_start = clampedStart;
  clip.duration = clampInt(clip.duration, 1, Math.max(ceiling - clampedStart, 1));
  return clip;
}

/** Clamp a normalised 0–1 value (D-132's crop insets), mirroring the Rust
 *  compositor's own `clamp(0.0, 1.0)` in `crop_pixel_rect`. `NaN` — what a
 *  numeric `<input>` produces when it is cleared — becomes `0`, i.e. "no
 *  crop on this edge", rather than propagating into the stored timeline. */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

/** Where index `idx` lands after `move_track(from, to)` reorders the track
 *  list (`Vec::remove(from)` then `insert(to, _)`, exactly what the `'move_
 *  track'` case below does) — the shared selection-follow math D-094's
 *  track-reorder drag introduced (`TimelinePane.tsx`'s original local
 *  `trackIndexAfterMove`) and D-214 promoted here so `useEditorControl.ts`'s
 *  `editor_move_track` MCP op can reuse it verbatim instead of re-deriving
 *  it. Needed because `move_track` reorders WITHOUT changing the track
 *  list's length, so `timelineStore.ts::applyOp`'s own generic selection
 *  remap — gated on the list SHRINKING (see `pruneIfEmptyTrack`'s doc) —
 *  never fires for it; every `move_track` call site is responsible for
 *  calling this itself.
 *
 *  `idx === from` moves to `to` outright; anything strictly between the two
 *  endpoints shifts by one to close/open the gap `splice` leaves behind;
 *  everything else (outside the `[from, to]` span, or when `from === to`)
 *  is untouched. */
export function trackIndexAfterMove(idx: number, from: number, to: number): number {
  if (idx === from) return to;
  if (from < to) return idx > from && idx <= to ? idx - 1 : idx;
  return idx >= to && idx < from ? idx + 1 : idx;
}

/** D-235 — the rippled branch of `trim_start`/`trim_end` (see that op's own
 *  `ripple` doc for the semantics and the reference quote). Kept as one helper
 *  rather than two `case` bodies because the head and tail forms differ in
 *  exactly two expressions — which field absorbs the delta, and the sign of
 *  the downstream shift — and writing them twice is how those two drift.
 *
 *  Refused (a no-op, `tl` back unchanged) when a member's track is locked,
 *  when the group has no room for any delta at all, when the clamped delta is
 *  zero, or when a sync-locked track has a clip straddling the ripple point
 *  (B-033 — never auto-split; same guard `remove_gap` uses). */
function applyRippleTrim(
  tl: Timeline,
  track: number,
  clip: number,
  delta: number,
  edge: 'start' | 'end',
  fps: number,
): Timeline {
  const c = tl.tracks[track]?.clips[clip];
  if (!c) return tl;
  const targets = lockstepTargets(tl, track, clip);
  if (!targets) return tl;
  const [lo, hi] = lockstepRoom(tl, targets, edge === 'start' ? headRoom : tailRoom, fps);
  if (lo > hi) return tl;
  const d = clampInt(delta, lo, hi);
  if (d === 0) return tl;
  // The ripple threshold is the clip's CURRENT end frame — everything at or
  // after it closes up behind the new out point. A head ripple holds
  // `start_frame` still and shortens from the left, so the clip's end moves by
  // `-d`; a tail ripple moves it by `+d`. Clips downstream all shift by that
  // same amount, which preserves any gaps already between them (a ripple
  // re-times the sequence, it does not tidy it up).
  const shift = edge === 'start' ? -d : d;
  const threshold = endFrame(c, fps);
  if (findStraddlingSyncLockedTrack(tl.tracks, track, threshold, fps) !== null) return tl;
  const next = clone(tl);
  for (const [ti, ci] of targets) {
    const nc = next.tracks[ti].clips[ci];
    // B-077 — each member converts the shared TIMELINE delta through its OWN
    // `source_fps`, exactly as `trim_start`/`trim_end`/`slip` already do.
    const dSource = timelineFramesToSource(nc, d, fps);
    if (edge === 'start') {
      nc.source_start += dSource;
      nc.duration -= dSource;
    } else {
      nc.duration += dSource;
    }
  }
  shiftClipsAtOrAfter(next.tracks[track], threshold, shift);
  // D-106 — cross-track ripple is sync-lock's job, exactly as it is for
  // `add_clip`/`move`/`remove_gap`; a linked member on a NON-sync-locked track
  // has its own trim applied above but does not drag that track's downstream
  // clips, which is that mechanism's documented boundary, not an omission.
  propagateSyncLockRipple(next.tracks, track, threshold, shift);
  return next;
}

// --------------------------------------------------------------------------- //
// D-239 — the seven edit types. The `edit_in` op's own machinery: the shared
// precondition check (`checkEditIn`, the `checkTransition`/`checkLink` pattern
// again — one answer for the overlay's greyed-out row, the MCP tool's error
// string and `applyOp`'s own refusal) plus the three primitives its branches
// need. Everything here is pure and mutates only a `clone()`d timeline.
// --------------------------------------------------------------------------- //

/** The TIMELINE-frame footprint an about-to-be-placed clip will occupy —
 *  `endFrame` minus `start_frame`, for a clip that does not have a
 *  `start_frame` yet. Goes through `clipOutputSourceFrames`, so a clip carrying
 *  a D-236 speed ramp (which is exactly what `fit_to_fill` builds) measures its
 *  RETIMED length here, not its raw `duration`. */
function newClipFootprint(c: NewClipFields, fps: number): number {
  return sourceFramesToTimeline(c, Math.round(clipOutputSourceFrames(c)), fps);
}

/** Index of the clip covering `frame` on `tr`, or `-1`. By real position
 *  (D-054), never by Vec order — same contract as [`clipAt`], which returns the
 *  clip itself; the three target-taking edit types need the INDEX. */
function clipIndexAt(tr: Track, frame: number, fps: number): number {
  return tr.clips.findIndex((c) => frame >= c.start_frame && frame < endFrame(c, fps));
}

/** Cut the clip straddling `frame` on `tr` in two, in place — `insert`'s "if
 *  the playhead is in the middle of a clip, it will split the clip" half.
 *
 *  Deliberately the SAME arithmetic and the same derived `id`/`link_group`
 *  (`${id}·${frame}`) as the `split` op's own reducer, so an Insert's cut is
 *  indistinguishable from a razor cut at the same frame — including to the
 *  ripple-flash diff in `TimelinePane`, which keys off exactly that id. It does
 *  NOT lock-step across a link group the way `split` does: `insert` only ever
 *  cuts its own destination track, and the partner track is rippled (or not) by
 *  the sync-lock rules, which is a different question from where a razor lands.
 *  No-op when nothing straddles `frame`. */
function splitStraddlingClip(tr: Track, frame: number, fps: number): void {
  const i = tr.clips.findIndex((c) => c.start_frame < frame && endFrame(c, fps) > frame);
  if (i < 0) return;
  const left = tr.clips[i];
  const off = frame - left.start_frame;
  const offSource = timelineFramesToSource(left, off, fps);
  if (offSource <= 0 || offSource >= left.duration) return;
  const right: Clip = {
    ...left,
    id: `${left.id}·${frame}`,
    link_group: left.link_group ? `${left.link_group}·${frame}` : left.link_group,
    start_frame: frame,
    source_start: left.source_start + offSource,
    duration: left.duration - offSource,
  };
  left.duration = offSource;
  tr.clips.splice(i + 1, 0, right);
}

/** Empty `[winStart, winEnd)` on `tr`, in place — `overwrite`'s "writing over
 *  whatever clip or clips were there before".
 *
 *  Each overlapping clip is resolved by which of its ends survive: fully inside
 *  the window it is dropped, overhanging one end it is trimmed back to the
 *  window's edge, and spanning the whole window it becomes two clips (the right
 *  half taking `split`'s own derived id, since that is exactly what it is).
 *  Nothing's `start_frame` moves except a right half's, which moves to `winEnd`
 *  by construction — an overwrite ripples nothing.
 *
 *  **A dropped clip's `link_group` partners on OTHER tracks are left alone**
 *  (see the `edit_in` op's own doc on single-destination targeting). A group
 *  with one surviving member behaves exactly like an unlinked clip for every op
 *  in this file — `linkGroupMembers` simply returns fewer members — so this is
 *  a benign state, not a dangling reference.
 *
 *  Retiming caveat, stated because it is a real one: the trim arithmetic uses
 *  `timelineFramesToSource`, which is linear and therefore approximate for a
 *  clip carrying a D-236 speed ramp. That is not new behaviour introduced here
 *  — the `split` op has always cut a ramped clip the same way — and keeping the
 *  two identical is worth more than making one of them cleverer alone. */
function clearWindow(tr: Track, winStart: number, winEnd: number, fps: number): void {
  const out: Clip[] = [];
  for (const c of tr.clips) {
    const s = c.start_frame;
    const e = endFrame(c, fps);
    if (e <= winStart || s >= winEnd) {
      out.push(c);
      continue;
    }
    const keepsHead = s < winStart;
    const keepsTail = e > winEnd;
    if (keepsHead) {
      const headSource = timelineFramesToSource(c, winStart - s, fps);
      if (headSource > 0) out.push({ ...c, duration: headSource });
    }
    if (keepsTail) {
      const tailOffset = timelineFramesToSource(c, winEnd - s, fps);
      const remaining = c.duration - tailOffset;
      if (remaining > 0) {
        out.push({
          ...c,
          // Only a clip cut on BOTH sides produces a second, genuinely new
          // clip needing its own id; one merely trimmed at its head is still
          // itself, and renaming it would break selection and the Inspector.
          id: keepsHead ? `${c.id}·${winEnd}` : c.id,
          link_group: keepsHead && c.link_group ? `${c.link_group}·${winEnd}` : c.link_group,
          start_frame: winEnd,
          source_start: c.source_start + tailOffset,
          duration: remaining,
        });
      }
    }
  }
  tr.clips = out;
}

/** D-239 — which track `place_on_top` really lands on: "the next available
 *  video track at the location of the playhead."
 *
 *  **"Above" is a LOWER index** — track index order IS compositing z-order in
 *  this model and a lower index paints on top (D-086, and `move_track`'s own
 *  doc), which is the same reason D-211 puts a title on track 0. So this walks
 *  DOWN from `from - 1` looking for the first unlocked video track with real
 *  room at `[start, start+dur)`, and when none has any, inserts a brand-new
 *  video track at index 0 — the new topmost layer, empty and therefore always
 *  free, so this has no failure branch. Mutates `tl.tracks`; the caller already
 *  holds a `clone()`. */
function resolvePlaceOnTopTrack(tl: Timeline, from: number, start: number, dur: number, fps: number): number {
  const end = start + dur;
  for (let i = from - 1; i >= 0; i--) {
    const t = tl.tracks[i];
    if (t.kind !== 'video' || t.locked) continue;
    if (!t.clips.some((c) => start < endFrame(c, fps) && end > c.start_frame)) return i;
  }
  tl.tracks.unshift({ kind: 'video', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
  return 0;
}

/** D-239 — the flat speed `fit_to_fill` needs so `clip` exactly fills
 *  `targetFootprint` timeline frames, or `null` when that is outside the D-236
 *  ramp's own `[MIN_SPEED, MAX_SPEED]` range.
 *
 *  A speed is "source frames consumed per output frame", so filling a slot that
 *  wants `wanted` of the clip's OWN source frames with a source run of
 *  `clip.duration` frames is exactly `duration / wanted` — no search, no
 *  iteration, and exact by the same rounding `endFrame` uses, which is what
 *  makes the placed clip land on the target's own end frame rather than one off
 *  it. */
function fitToFillSpeed(clip: NewClipFields, targetFootprint: number, fps: number): number | null {
  const wanted = timelineFramesToSource(clip, targetFootprint, fps);
  if (wanted <= 0 || clip.duration <= 0) return null;
  const speed = clip.duration / wanted;
  if (speed < MIN_SPEED || speed > MAX_SPEED) return null;
  return speed;
}

/** D-239 — same shape and same reason as [`TransitionCheck`]/[`LinkCheck`]: the
 *  edit overlay greys a row out with this `reason`, `editor_edit_in` returns it
 *  verbatim as its error, and `applyOp` refuses on exactly the same call. */
export interface EditInCheck {
  ok: boolean;
  /** Present only when `ok` is false — a real sentence naming what is missing. */
  reason?: string;
}

/** Which track index an `edit_in` really lands on. Mirrors `add_clip`'s own
 *  fallback (out of range collapses to 0, an empty timeline gets a video track
 *  made for it), so a drop onto a brand-new project behaves identically
 *  whichever of the two ops the caller reached for. */
function editInTrackIndex(tl: Timeline, track: number): number {
  if (tl.tracks.length === 0) return 0;
  return track >= 0 && track < tl.tracks.length ? track : 0;
}

/** D-239 — everything about an edit's legality that does NOT depend on the
 *  incoming source: the destination track exists and is unlocked, `atFrame` is
 *  real, a target-taking type has a target under it, and neither rippling type
 *  is blocked by B-033's straddling sync-locked clip.
 *
 *  **Its own function because the GUI cannot ask the fuller question.** The
 *  HTML5 spec keeps `dataTransfer.getData` unreadable during `dragover` (see
 *  `EditOverlay.tsx`), so while a drag is in flight the overlay knows the edit
 *  type and the timeline but genuinely nothing about the source — not even its
 *  length. Feeding [`checkEditIn`] a stand-in clip instead would be worse than
 *  useless: a placeholder length makes the two length-dependent refusals below
 *  fire every time, so Replace and Fit to Fill would sit permanently greyed
 *  out and never accept a drop at all. This is exactly the answer the overlay
 *  can act on, and [`checkEditIn`] is this plus the two questions that need the
 *  real source. */
export function checkEditTarget(
  tl: Timeline,
  editType: DropEditType,
  track: number,
  atFrame: number,
): EditInCheck {
  const fps = timelineFps(tl);
  const trackIdx = editInTrackIndex(tl, track);
  const tr: Track | undefined = tl.tracks[trackIdx];
  if (tr && tr.locked) return { ok: false, reason: `track ${trackIdx + 1} is locked` };
  // Only `append` genuinely ignores the playhead; the other six are defined
  // against it, so a negative one is a caller bug rather than something to
  // silently clamp into a different edit.
  const at = Math.round(atFrame);
  if (editType !== 'append' && (!Number.isFinite(at) || at < 0)) {
    return { ok: false, reason: 'atFrame must be a frame at or after 0' };
  }

  const info = dropEditTypeInfo(editType);
  if (info.needsTarget) {
    if (!tr) return { ok: false, reason: 'there is no clip under the playhead to act on' };
    if (clipIndexAt(tr, at, fps) < 0) {
      return { ok: false, reason: `${info.label} needs a clip under the playhead on track ${trackIdx + 1}` };
    }
  }

  // B-033 — the two rippling types refuse rather than auto-split when a
  // sync-locked track has a clip straddling the frame they would ripple from.
  // Same guard, same threshold convention, as `add_clip`/`move`/`remove_gap`.
  if (editType === 'insert' && findStraddlingSyncLockedTrack(tl.tracks, trackIdx, at, fps) !== null) {
    return { ok: false, reason: 'a sync-locked track has a clip straddling the playhead — that ripple is refused' };
  }
  if (editType === 'ripple_overwrite' && tr) {
    const ti = clipIndexAt(tr, at, fps);
    const oldEnd = ti >= 0 ? endFrame(tr.clips[ti], fps) : at;
    if (findStraddlingSyncLockedTrack(tl.tracks, trackIdx, oldEnd, fps) !== null) {
      return { ok: false, reason: 'a sync-locked track has a clip straddling that edit point — that ripple is refused' };
    }
  }
  return { ok: true };
}

/** D-239 — the full precondition check: [`checkEditTarget`] plus the two
 *  questions that can only be answered once the real incoming source is known.
 *  `applyOp`'s `edit_in` and `editor_edit_in` both run this; the overlay runs
 *  the narrower one during the drag and this one on drop. */
export function checkEditIn(
  tl: Timeline,
  op: Extract<EditOp, { kind: 'edit_in' }>,
): EditInCheck {
  const fps = timelineFps(tl);
  const dur = newClipFootprint(op.clip, fps);
  if (!(dur > 0)) return { ok: false, reason: 'that source has no usable length to place' };

  const structural = checkEditTarget(tl, op.editType, op.track, op.atFrame);
  if (!structural.ok) return structural;

  if (op.editType === 'replace' || op.editType === 'fit_to_fill') {
    const trackIdx = editInTrackIndex(tl, op.track);
    const tr = tl.tracks[trackIdx];
    // Non-negative by `checkEditTarget`, which has already refused a
    // target-taking type with nothing under the playhead.
    const target = tr.clips[clipIndexAt(tr, Math.round(op.atFrame), fps)];
    const slot = endFrame(target, fps) - target.start_frame;
    if (op.editType === 'replace') {
      const needed = timelineFramesToSource(op.clip, slot, fps);
      if (op.clip.source_start + needed > op.clip.source_len) {
        return {
          ok: false,
          reason: `that source is too short to replace "${target.name}" at its own length — Fit to Fill retimes it instead`,
        };
      }
    } else if (fitToFillSpeed(op.clip, slot, fps) === null) {
      return {
        ok: false,
        reason: `filling "${target.name}" would need a speed outside ${MIN_SPEED}x–${MAX_SPEED}x`,
      };
    }
  }
  return { ok: true };
}

export function applyOp(tl: Timeline, op: EditOp): Timeline {
  // B-077 — the project's own timeline-frame rate, needed by every op below
  // that combines a `start_frame`-space position with a `duration`/
  // `source_start`-space (source-frame) quantity. Computed once, from the
  // ORIGINAL `tl` (never mutated by any op below), matching `timelineFps`'s
  // own "fixed for a given timeline" contract.
  const fps = timelineFps(tl);
  if (op.kind === 'add_clip') {
    // B-129/D-262 — the ONE track-kind gate, here rather than in any one
    // caller, so no path into this op can place a title or an adjustment clip
    // on an audio track. Refused as a no-op, the same way `add_transition`
    // refuses on `checkTransition`; the caller holds the `reason` string for
    // the message. Skipped for `onNewVideoTrack`, whose track is a video track
    // by construction.
    if (!op.onNewVideoTrack && !checkAddClip(tl, op.track, op.clip).ok) return tl;
    const next = clone(tl);
    if (next.tracks.length === 0)
      next.tracks.push({ kind: 'video', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
    // B-129/D-262 — a brand-new empty video track at the TOP of the stack (see
    // the op's own doc). `unshift` is exactly what `resolvePlaceOnTopTrack`
    // does for the same "there is no room above" case, so the two ops agree on
    // what "on top" means rather than each having its own idea.
    if (op.onNewVideoTrack) {
      next.tracks.unshift({ kind: 'video', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
    }
    const requested = op.onNewVideoTrack ? 0 : op.track;
    const trackIdx = requested < next.tracks.length ? requested : 0;
    const track = next.tracks[trackIdx];
    let startFrame: number;
    if (op.startFrame !== undefined) {
      // D-095 — an explicit insertion point (the caller already resolved
      // this via `computeInsertion` at drop time, snapping to a real clip
      // edge). `ripple: true` shifts every clip at/after it later by the new
      // clip's own duration to make room — `false` means it was already
      // confirmed to fit in an open gap, so nothing else moves.
      startFrame = Math.max(0, op.startFrame);
      // B-129/D-262 — a ripple is meaningless on a brand-new empty track
      // (nothing on it to push), and worse than meaningless via
      // `propagateSyncLockRipple`, which would shove every sync-locked track's
      // real clips out of the way to make room in a track that is already
      // entirely room. An overlay is added ALONGSIDE the edit, never by moving
      // it.
      if (op.ripple && !op.onNewVideoTrack) {
        // B-033 — reject upfront (checked against the ORIGINAL, pre-clone
        // tracks) if a sync-locked track has a clip straddling the
        // insertion point; never auto-split. See the doc on
        // `findStraddlingSyncLockedTrack` for why.
        if (findStraddlingSyncLockedTrack(tl.tracks, trackIdx, startFrame, fps) !== null) return tl;
        // B-077 — the ripple shifts every clip at/after `startFrame` by the
        // NEW clip's own TIMELINE-frame footprint, not its raw (source-frame)
        // `.duration` — those only coincide when the new clip's own native
        // rate happens to equal the project's.
        const dur = sourceFramesToTimeline(op.clip, op.clip.duration, fps);
        shiftClipsAtOrAfter(track, startFrame, dur);
        // D-106 — sync-locked tracks ripple too, same shift.
        propagateSyncLockRipple(next.tracks, trackIdx, startFrame, dur);
      }
    } else {
      // D-058 — always an append: the position a dragged clip lands at is
      // "after everything already on this track," computed here (the only
      // place that has both the target track's real contents and the new
      // clip at once), never left for the clip to arrive without one.
      startFrame = nextAppendFrame(track, fps);
    }
    const clip: Clip = { ...op.clip, start_frame: startFrame };
    const defaultAt = track.clips.filter((c) => c.start_frame < startFrame).length;
    const at = Math.min(Math.max(op.atIndex ?? defaultAt, 0), track.clips.length);
    track.clips.splice(at, 0, clip);
    // D-129 — the dropped source's own audio, as a second real clip on a
    // linked audio track. Placed AFTER the video half (and after any ripple
    // above) so `ensureAudioTrackWithRoom` sees the timeline's real final
    // shape: on a sync-locked audio track the ripple has already made the
    // same room there, so the existing track is normally reused; only when
    // it genuinely can't fit is a new track appended. Never fails — a fresh
    // track is always free — so there is no half-applied outcome here.
    if (op.linkedAudio) {
      const linkedDurTimeline = sourceFramesToTimeline(op.linkedAudio, op.linkedAudio.duration, fps);
      const audioTrackIdx = ensureAudioTrackWithRoom(next, startFrame, linkedDurTimeline);
      const audioTrack = next.tracks[audioTrackIdx];
      const audioClip: Clip = { ...op.linkedAudio, start_frame: startFrame };
      const audioAt = audioTrack.clips.filter((c) => c.start_frame < startFrame).length;
      audioTrack.clips.splice(audioAt, 0, audioClip);
    }
    return next;
  }

  if (op.kind === 'edit_in') {
    // D-239 — the seven edit types. `checkEditIn` is the ONLY gate: the
    // overlay's greyed row, `editor_edit_in`'s error string and this refusal
    // are the same call, so a target the UI offers is always one that applies.
    if (!checkEditIn(tl, op).ok) return tl;
    const next = clone(tl);
    if (next.tracks.length === 0)
      next.tracks.push({ kind: 'video', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
    const trackIdx = editInTrackIndex(next, op.track);
    const at = Math.max(0, Math.round(op.atFrame));
    const incomingDur = newClipFootprint(op.clip, fps);

    // Resolved by the switch below: which track the clip lands on, where, and
    // (for the two retiming/re-cutting types) what the clip itself becomes.
    let placeTrack = trackIdx;
    let startFrame = at;
    let fields: NewClipFields = op.clip;

    switch (op.editType) {
      case 'append':
        startFrame = nextAppendFrame(next.tracks[trackIdx], fps);
        break;
      case 'insert': {
        const tr = next.tracks[trackIdx];
        // Split first, THEN ripple: the right half created here starts exactly
        // at `at`, so it is caught by the `>= threshold` shift and moves with
        // everything downstream — which is what "pushes everything else down to
        // make room" means when the playhead is mid-clip.
        splitStraddlingClip(tr, at, fps);
        shiftClipsAtOrAfter(tr, at, incomingDur);
        propagateSyncLockRipple(next.tracks, trackIdx, at, incomingDur);
        break;
      }
      case 'overwrite':
        clearWindow(next.tracks[trackIdx], at, at + incomingDur, fps);
        break;
      case 'place_on_top':
        placeTrack = resolvePlaceOnTopTrack(next, trackIdx, at, incomingDur, fps);
        break;
      case 'replace':
      case 'fit_to_fill': {
        const tr = next.tracks[trackIdx];
        const ti = clipIndexAt(tr, at, fps);
        const target = tr.clips[ti];
        const slot = endFrame(target, fps) - target.start_frame;
        startFrame = target.start_frame;
        if (op.editType === 'replace') {
          // "The out point … will be changed so it fits perfectly." The source
          // is re-cut, never retimed — and any ramp the caller happened to send
          // is dropped, because a ramp is exactly what makes a `duration` stop
          // meaning the clip's own footprint.
          fields = { ...op.clip, duration: timelineFramesToSource(op.clip, slot, fps), speed_points: undefined };
        } else {
          // Non-null by `checkEditIn`, which refuses an out-of-range speed with
          // a real message rather than letting it be clamped into a wrong fit.
          const speed = fitToFillSpeed(op.clip, slot, fps);
          if (speed === null) return tl;
          fields = { ...op.clip, speed_points: [{ source_frame: op.clip.source_start, speed }] };
        }
        tr.clips.splice(ti, 1);
        break;
      }
      case 'ripple_overwrite': {
        const tr = next.tracks[trackIdx];
        const ti = clipIndexAt(tr, at, fps);
        const target = tr.clips[ti];
        const oldStart = target.start_frame;
        const oldEnd = endFrame(target, fps);
        startFrame = oldStart;
        tr.clips.splice(ti, 1);
        // "Longer clips … push everything down …, while shorter clips pull
        // things in so there are no gaps" — one signed shift of the difference,
        // from the OLD clip's own end, so the incoming clip's new end lands
        // exactly where the next clip now begins either way.
        const delta = incomingDur - (oldEnd - oldStart);
        if (delta !== 0) {
          shiftClipsAtOrAfter(tr, oldEnd, delta);
          propagateSyncLockRipple(next.tracks, trackIdx, oldEnd, delta);
        }
        break;
      }
    }

    const dest = next.tracks[placeTrack];
    const clip: Clip = { ...fields, start_frame: startFrame };
    dest.clips.splice(dest.clips.filter((c) => c.start_frame < startFrame).length, 0, clip);
    // The dropped source's audio half, by exactly `add_clip`'s rule — see the
    // op's own doc for why it is deliberately not given its own overwrite/
    // ripple treatment.
    if (op.linkedAudio) {
      const linkedDur = sourceFramesToTimeline(op.linkedAudio, op.linkedAudio.duration, fps);
      const audioTrackIdx = ensureAudioTrackWithRoom(next, startFrame, linkedDur);
      const audioTrack = next.tracks[audioTrackIdx];
      audioTrack.clips.splice(
        audioTrack.clips.filter((c) => c.start_frame < startFrame).length,
        0,
        { ...op.linkedAudio, start_frame: startFrame },
      );
    }
    return next;
  }

  if (op.kind === 'unlink') {
    // Mirrors `chroma_timeline::Timeline::unlink` — dissolves the clip's
    // COMPLETE group, no-op when it isn't linked, refused on a locked track.
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const group = tr.clips[op.clip]?.link_group;
    if (!group) return tl;
    const next = clone(tl);
    for (const t of next.tracks) {
      for (const c of t.clips) {
        if (c.link_group === group) c.link_group = null;
      }
    }
    return next;
  }

  if (op.kind === 'link') {
    // Mirrors `chroma_timeline::Timeline::link` — rejected whole (a no-op)
    // rather than partially applied, same discipline every link-aware op
    // here uses. `checkLink` is the single source of truth for why.
    const a: LinkTarget = { track: op.trackA, clip: op.clipA };
    const b: LinkTarget = { track: op.trackB, clip: op.clipB };
    if (!checkLink(tl, a, b).ok) return tl;
    const next = clone(tl);
    const trackA = next.tracks[op.trackA];
    const trackB = next.tracks[op.trackB];
    const clipA = trackA.clips[op.clipA];
    const clipB = trackB.clips[op.clipB];
    // Video-then-audio regardless of argument order, so `link(x, y)` and
    // `link(y, x)` produce the identical group id — mirrors the Rust op's
    // own order-independence.
    const [videoClip, audioClip] = trackA.kind === 'video' ? [clipA, clipB] : [clipB, clipA];
    const group = `lg-${videoClip.id}-${audioClip.id}`;
    clipA.link_group = group;
    clipB.link_group = group;
    return next;
  }

  // D-222 — marker ops. Handled first, and entirely outside the track/clip
  // machinery below, because a marker belongs to no track and no clip: there
  // is no `op.track` to bounds-check, no lock to respect, and nothing about
  // them ripples. See `Timeline.markers` and the ops' own docs.
  if (op.kind === 'add_marker') {
    const next = clone(tl);
    next.markers = sortedMarkers([...(next.markers ?? []), op.marker]);
    return next;
  }

  // D-226 — transition ops. Handled here, above the per-clip machinery below,
  // because a transition belongs to a track's edit POINT rather than to either
  // clip: no clip index to bounds-check, and nothing about one ripples (the
  // clips never moved to make room for it — see D-226). The track's own lock IS
  // respected, via `checkTransition`, since a transition is that track's
  // content.
  if (op.kind === 'add_transition') {
    if (!checkTransition(tl, op.track, op.transition, fps).ok) return tl;
    const next = clone(tl);
    const tr = next.tracks[op.track];
    tr.transitions = sortedTransitions([...(tr.transitions ?? []), op.transition]);
    return next;
  }
  if (op.kind === 'remove_transition') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    if (!(tr.transitions ?? []).some((t) => t.id === op.id)) return tl;
    const next = clone(tl);
    const nextTr = next.tracks[op.track];
    nextTr.transitions = (nextTr.transitions ?? []).filter((t) => t.id !== op.id);
    return next;
  }
  if (op.kind === 'set_transition') {
    const tr = tl.tracks[op.track];
    const current = (tr?.transitions ?? []).find((t) => t.id === op.id);
    if (!current) return tl;
    const merged: Transition = { ...current };
    if (op.patch.kind !== undefined && TRANSITION_KINDS.some((k) => k.value === op.patch.kind)) {
      merged.kind = op.patch.kind;
    }
    if (op.patch.duration !== undefined && Number.isFinite(op.patch.duration)) {
      merged.duration = Math.max(1, Math.round(op.patch.duration));
    }
    if (op.patch.alignment !== undefined && TRANSITION_ALIGNMENTS.some((a) => a.value === op.patch.alignment)) {
      merged.alignment = op.patch.alignment;
    }
    if (op.patch.color !== undefined) {
      // `null` clears back to the default (black), a real value is resolved
      // through the shared palette resolver. An unresolvable colour is a caller
      // bug, not a reason to write garbage into the document — the same posture
      // `set_marker` takes.
      if (op.patch.color === null) delete merged.color;
      else {
        const hex = resolveMarkerColor(op.patch.color);
        if (typeof hex === 'string') merged.color = hex;
      }
    }
    // The MERGED shape has to be legal, not just the patch: shortening a
    // dissolve is always fine, lengthening one past its handles is refused with
    // exactly the message the add path would have given.
    if (!checkTransition(tl, op.track, merged, fps).ok) return tl;
    const next = clone(tl);
    const nextTr = next.tracks[op.track];
    nextTr.transitions = sortedTransitions(
      (nextTr.transitions ?? []).map((t) => (t.id === op.id ? merged : t)),
    );
    return next;
  }
  if (op.kind === 'remove_marker') {
    const existing = tl.markers ?? [];
    if (!existing.some((m) => m.id === op.id)) return tl;
    const next = clone(tl);
    next.markers = (next.markers ?? []).filter((m) => m.id !== op.id);
    return next;
  }
  if (op.kind === 'set_marker') {
    const existing = tl.markers ?? [];
    const at = existing.findIndex((m) => m.id === op.id);
    if (at < 0) return tl;
    const next = clone(tl);
    const m = (next.markers ?? [])[at];
    if (op.patch.frame !== undefined) {
      // Floored/rounded on the way in, exactly as `newMarker` does, so the
      // GUI's number field and MCP's own arg can never write a fractional or
      // negative frame into `project.json`. `NaN` (a cleared numeric input)
      // leaves the frame alone rather than propagating — the same
      // `Number.isFinite` guard `set_track_duck` already applies.
      if (Number.isFinite(op.patch.frame)) m.frame = Math.max(0, Math.round(op.patch.frame));
    }
    if (op.patch.color !== undefined) {
      const hex = resolveMarkerColor(op.patch.color);
      // An unresolvable colour is a caller bug, not a reason to write garbage
      // into the document; the caller is expected to have run
      // `resolveMarkerColor` itself for the real message (same posture
      // `set_text_clip` takes for a failed `newTextLayer`).
      if (typeof hex === 'string') m.color = hex;
    }
    // `null` clears, `undefined` (absent) leaves alone — see the op's doc.
    // A whitespace-only string clears too, so "unnamed" has one
    // representation here just as it does in `newMarker`.
    if (op.patch.name !== undefined) {
      const v = op.patch.name?.trim();
      if (v) m.name = v;
      else delete m.name;
    }
    if (op.patch.note !== undefined) {
      const v = op.patch.note?.trim();
      if (v) m.note = v;
      else delete m.note;
    }
    // A frame change can reorder the list; re-sort so the invariant the
    // `add_marker` op establishes holds after every write, not just after an
    // insert.
    next.markers = sortedMarkers(next.markers ?? []);
    return next;
  }

  // D-080 — track-list-level ops: none of these operate on "the clips of one
  // already-known track" the way the switch below's remaining ops do (`move`
  // spans two tracks; `add_track`/`remove_track` mutate the list itself), so
  // they're handled before the generic `tr = tl.tracks[op.track]` guard.
  if (op.kind === 'add_track') {
    // Mirrors `chroma_timeline::Timeline::add_track` — always succeeds.
    const next = clone(tl);
    next.tracks.push({ kind: op.trackKind, clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
    return next;
  }
  if (op.kind === 'remove_track') {
    // Mirrors `Timeline::remove_track` — out-of-range is a no-op (`NoSuchTrack`).
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks.splice(op.track, 1);
    return next;
  }
  if (op.kind === 'set_track_gain') {
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].gain = op.gain;
    return next;
  }
  if (op.kind === 'set_track_locked') {
    // D-089 — not gated by the track's own current lock state, same as the
    // Rust side (`Track.locked` is a plain field write, not routed through
    // `track_mut`).
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].locked = op.locked;
    return next;
  }
  if (op.kind === 'set_track_hidden') {
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].hidden = op.hidden;
    return next;
  }
  if (op.kind === 'set_track_sync_locked') {
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].sync_locked = op.syncLocked;
    return next;
  }
  if (op.kind === 'set_track_duck') {
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    const t = next.tracks[op.track];
    t.duck_from = op.duckFrom;
    // Normalised here, on the way in, so a cleared numeric `<input>` (which
    // reads as `NaN`) can never reach `project.json` — the same reason the crop
    // insets and the fade frame counts are cleaned up here rather than left
    // entirely to the backend. Rust still degrades a nonsense value to "no
    // duck" at the point of use, because `chroma_timeline_set` stores whatever
    // it is given and an MCP write reaching the store by another route has to
    // be survivable too; the UI's own writes should be well-formed at rest.
    //
    // The time constants are floored at 0 (an "instant" attack is a legitimate
    // thing to ask for — Rust's `MIN_DUCK_TAU_SECS` makes it well-defined) and
    // `duck_db` is NOT clamped: a positive value boosts, which is unusual but
    // meaningful, the same latitude `gain > 1` already has.
    t.duck_db = Number.isFinite(op.duckDb) ? op.duckDb : 0;
    t.duck_attack_ms = Number.isFinite(op.duckAttackMs)
      ? Math.max(0, op.duckAttackMs)
      : DEFAULT_DUCK_ATTACK_MS;
    t.duck_release_ms = Number.isFinite(op.duckReleaseMs)
      ? Math.max(0, op.duckReleaseMs)
      : DEFAULT_DUCK_RELEASE_MS;
    return next;
  }
  if (op.kind === 'move_track') {
    // Mirrors `Timeline::move_track(from, to)` exactly: bounds-checked,
    // `from === to` a genuine no-op, not gated by lock (track-list
    // structure, not per-clip editing).
    if (op.from < 0 || op.from >= tl.tracks.length) return tl;
    if (op.to < 0 || op.to >= tl.tracks.length) return tl;
    if (op.from === op.to) return tl;
    const next = clone(tl);
    const [moved] = next.tracks.splice(op.from, 1);
    next.tracks.splice(op.to, 0, moved);
    return next;
  }
  if (op.kind === 'set_clip_transform') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    nc.opacity = op.opacity;
    nc.position_x = op.position_x;
    nc.position_y = op.position_y;
    nc.scale = op.scale;
    // D-193 — written verbatim, `null` included: that's the explicit
    // "clear this axis's override" value, mirroring `duck_from`'s own
    // null-clears convention. No clamp — same "the model stores what the
    // UI wrote, the consumer decides what it means" rule `scale` itself
    // already follows (unlike crop, which IS clamped here).
    nc.box_width = op.box_width;
    nc.box_height = op.box_height;
    nc.rotation = op.rotation;
    // D-132 — clamped here, on the way in, so a value out of the 0–1 inset
    // range can never reach `project.json`. The Rust compositor clamps again
    // at the point of use (it has to: `chroma_timeline_set` stores whatever
    // it is given, and MCP/agent writes don't come through this file), but
    // the UI's own writes should be well-formed at rest, not merely
    // survivable — the same reason `trim_end` clamps here rather than
    // leaving it all to the backend.
    nc.crop_left = clamp01(op.crop_left);
    nc.crop_top = clamp01(op.crop_top);
    nc.crop_right = clamp01(op.crop_right);
    nc.crop_bottom = clamp01(op.crop_bottom);
    return next;
  }
  if (op.kind === 'set_clip_keyframes') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    // normalize `[]` to `undefined` — see the op's own doc.
    nc.chroma_keyframes = op.keyframes.length > 0 ? op.keyframes : undefined;
    return next;
  }
  if (op.kind === 'set_clip_fade') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    // Floored and integral here, on the way in, so a negative or fractional
    // frame count can never reach `project.json` — the same reason the crop
    // insets are clamped here rather than left entirely to the backend. Rust
    // still treats a nonsense value as "no fade" at the point of use
    // (`fade_gain`), because `chroma_timeline_set` stores whatever it is given
    // and MCP writes reaching the store by another route must degrade safely
    // too; the UI's own writes should be well-formed at rest, not merely
    // survivable.
    //
    // NOT clamped to the clip's `duration`: a fade longer than the clip is a
    // legitimate thing to author (the two windows then overlap and multiply —
    // see `fade_gain`'s doc), and clamping would silently move a handle the
    // user placed.
    nc.fade_in_frames = Math.max(0, Math.floor(op.fade_in_frames || 0));
    nc.fade_out_frames = Math.max(0, Math.floor(op.fade_out_frames || 0));
    nc.fade_in_curve = op.fade_in_curve ?? DEFAULT_EASE_CURVE;
    nc.fade_out_curve = op.fade_out_curve ?? DEFAULT_EASE_CURVE;
    return next;
  }
  if (op.kind === 'set_clip_speed') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    // Normalised here, on the way in, so the stored document is always
    // already sorted/clamped/deduped — the same "the UI's own writes should be
    // well-formed at rest, not merely survivable" discipline the crop insets
    // and the fade durations above follow. `speedRamp.ts` normalises again at
    // READ time, because `chroma_timeline_set` stores whatever it is handed
    // (D-058) and an MCP or hand-edited write can reach the store another way.
    const points = normalizeSpeedPoints(op.points);
    nc.speed_points = points.length > 0 ? points : undefined;
    return next;
  }
  if (op.kind === 'set_clip_audio') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    // Each field independently optional — an omitted one is left exactly as
    // it was, not reset (see the op's own doc for why this differs from
    // `set_clip_fade`'s required pair). Clamped here, on the way in, for the
    // same reason the crop insets are: Rust degrades a nonsense value safely
    // at the point of use, but the UI's own writes should be well-formed at
    // rest, not merely survivable.
    if (op.volume !== undefined) nc.volume = clampClipVolume(op.volume);
    if (op.pan !== undefined) nc.pan = clampClipPan(op.pan);
    return next;
  }
  if (op.kind === 'set_clip_eq') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    if (op.clear) {
      // Already EQ-less — return the SAME timeline object, so a redundant
      // reset does not push an undo entry or re-render every consumer.
      if (!c.eq_bands || c.eq_bands.length === 0) return tl;
      const next = clone(tl);
      // `delete` rather than `= []`: an empty array would serialise as a real
      // `"eq_bands": []` key where the Rust field's own
      // `skip_serializing_if = "Vec::is_empty"` writes nothing at all, and
      // "back to no EQ" should leave the clip exactly as it was before the
      // feature was ever touched.
      delete next.tracks[op.track].clips[op.clip].eq_bands;
      return next;
    }
    const band = op.band;
    if (band === undefined || !Number.isInteger(band) || band < 0) return tl;
    // Materialise the default strip on the first real edit — see the op's own
    // doc. Read off the CURRENT clip, so a clip that already has bands keeps
    // every one of them.
    const bands = eqBandsForDisplay(c.eq_bands);
    if (band >= bands.length) return tl;
    const patched = clampEqBand({ ...bands[band], ...(op.patch ?? {}) });
    // Nothing actually changed (a re-typed identical value, a no-op MCP call)
    // — same identity short-circuit as the clear branch above.
    const before = c.eq_bands?.[band];
    if (
      before &&
      c.eq_bands?.length === bands.length &&
      before.kind === patched.kind &&
      before.freq_hz === patched.freq_hz &&
      before.gain_db === patched.gain_db &&
      before.q === patched.q &&
      before.enabled === patched.enabled
    ) {
      return tl;
    }
    bands[band] = patched;
    const next = clone(tl);
    next.tracks[op.track].clips[op.clip].eq_bands = bands;
    return next;
  }
  if (op.kind === 'swap_media') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    nc.media_id = op.media_id;
    nc.source_path = op.source_path;
    reclampToSource(nc, op.source_len, op.source_fps);
    return next;
  }
  if (op.kind === 'refresh_media') {
    // A non-positive length is "we could not probe the new file", never a real
    // answer, and acting on it would clamp every affected clip to a single
    // frame — strictly worse than leaving the trim ceiling as it was, since the
    // picture updates from the file either way. The caller already declines to
    // send one (`Root.tsx`); refusing here too means no future caller can make
    // that mistake silently.
    if (!(op.source_len > 0)) return tl;
    // Which clips read the file that changed. `media_id` is the strong link
    // when both sides have one; `source_path` is the fallback for a clip that
    // predates the pool link (`Clip.media_id` is nullable by design) — the same
    // two-key resolution `editor_add_clip` does in the other direction.
    const matches = (c: Clip) =>
      op.media_id !== null && c.media_id ? c.media_id === op.media_id : c.source_path === op.source_path;
    let next: Timeline | null = null;
    tl.tracks.forEach((tr, ti) => {
      if (tr.locked) return;
      tr.clips.forEach((c, ci) => {
        if (!matches(c)) return;
        // Clone at most once, and only if some clip genuinely changes — a
        // same-length re-render must leave the timeline (and the undo stack)
        // completely untouched. See the op's own doc. `reclampToSource` on a
        // throwaway copy is the honest test for "would this change anything",
        // and the only one that cannot drift from what the write actually does.
        const probe = reclampToSource({ ...c }, op.source_len, op.source_fps);
        if (
          probe.source_len === c.source_len &&
          probe.source_fps === c.source_fps &&
          probe.source_start === c.source_start &&
          probe.duration === c.duration
        ) {
          return;
        }
        next ??= clone(tl);
        reclampToSource(next.tracks[ti].clips[ci], op.source_len, op.source_fps);
      });
    });
    return next ?? tl;
  }
  if (op.kind === 'set_text_clip') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    // Refused for a media clip: patching a text layer onto one would silently
    // turn a video into a title (its `source_path` would still be set, and
    // the compositor's `if let Some(layer) = &clip.text` branch would then
    // draw the text and never decode the picture).
    if (!c || !isTextClip(c)) return tl;
    const merged = newTextLayer(op.patch, c.text ?? null);
    // A no-op on an invalid patch — the caller (`editor_set_text_clip`, the
    // Inspector) runs `newTextLayer` itself first and surfaces the real
    // message; this reducer is pure and has nowhere to report to.
    if ('error' in merged) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    nc.text = merged;
    // Keep the clip's NAME in step with its text, so the timeline body and
    // the undo labels say what the title actually says — but only while the
    // name has not been independently renamed away from it, which is what
    // `c.name === c.text.content` tests. Both references show a title clip
    // labelled with its own text.
    if (c.text && c.name === c.text.content) nc.name = merged.content || 'Title';
    return next;
  }
  if (op.kind === 'set_caption_text') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    // Refused for anything that is not already a caption — patching a cue onto
    // a media clip would silently stop its picture being decoded, exactly the
    // hazard `set_text_clip` guards against.
    if (!c || !isCaptionClip(c) || typeof op.text !== 'string') return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    nc.caption = { ...(c.caption ?? { text: '' }), text: op.text };
    // Keep the clip's NAME in step with its text while it has not been
    // independently renamed — same rule, and same reason, as `set_text_clip`.
    if (c.caption && c.name === (captionLines(c.caption.text)[0] || 'Caption')) {
      next.tracks[op.track].clips[op.clip].name = captionLines(op.text)[0] || 'Caption';
    }
    return next;
  }
  if (op.kind === 'set_caption_style') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked || tr.kind !== 'subtitle') return tl;
    const next = clone(tl);
    next.tracks[op.track].caption_style = { ...(tr.caption_style ?? {}), ...op.patch };
    return next;
  }
  if (op.kind === 'set_caption_cue_style') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c || !isCaptionClip(c)) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    if (op.patch === null) {
      // "Use Track Style" ticked — drop the override entirely rather than
      // storing a copy of the track's values, so a later track-style change
      // still reaches this cue.
      nc.caption = { text: nc.caption?.text ?? '' };
    } else {
      // Unticking starts the override from what the cue currently RESOLVES to,
      // not from the bare defaults: the user is departing from what they can
      // see on screen, and starting anywhere else would visibly jump.
      const base = c.caption?.style ?? tr.caption_style ?? {};
      nc.caption = { text: nc.caption?.text ?? '', style: { ...base, ...op.patch } };
    }
    return next;
  }
  if (op.kind === 'import_subtitles') {
    if (op.cues.length === 0) return tl;
    const next = clone(tl);
    next.tracks.push({
      kind: 'subtitle',
      clips: op.cues.map((cue) => ({
        ...newCaptionClipFields(cue.text, cue.duration, cue.id),
        start_frame: cue.start_frame,
      })),
      gain: DEFAULT_TRACK_GAIN,
      sync_locked: DEFAULT_SYNC_LOCKED,
      ...(op.style ? { caption_style: op.style } : {}),
    });
    return next;
  }
  if (op.kind === 'set_adjustment_clip') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    // Refused for anything that is not already an adjustment clip, and this
    // matters MORE than the equivalent guard on `set_text_clip`: patching an
    // `adjustment` onto a media clip would not merely mis-render it, it would
    // silently convert a clip that contributes picture into one that
    // contributes none — both renderers branch on `is_adjustment()` BEFORE they
    // look at `source_path`, so the clip's video would simply vanish from the
    // edit while its file reference sat there looking fine.
    if (!c || !isAdjustmentClip(c)) return tl;
    const merged = newAdjustmentLayer(op.patch, c.adjustment ?? null);
    // A no-op on an invalid patch, for `set_text_clip`'s reason: this reducer
    // is pure and has nowhere to report to; the caller surfaces the message.
    if ('error' in merged) return tl;
    const next = clone(tl);
    next.tracks[op.track].clips[op.clip].adjustment = merged;
    return next;
  }
  if (op.kind === 'move') {
    // Mirrors `Timeline::move_clip(from_track, from_idx, to_track,
    // to_start_frame)` field-for-field, including its error order (negative
    // position checked first, before either track/clip is even looked up).
    if (op.startFrame < 0) return tl;
    const src = tl.tracks[op.fromTrack];
    const c = src?.clips[op.clip];
    if (!c) return tl;
    const dest = tl.tracks[op.toTrack];
    if (!dest) return tl;
    // D-089 — mirrors Rust `move_clip`'s explicit lock check on BOTH the
    // source track (losing a clip to elsewhere) and the destination track
    // (gaining one dropped onto it).
    if (src.locked || dest.locked) return tl;
    if (op.fromTrack === op.toTrack && op.startFrame === c.start_frame) return tl; // genuine no-op
    // B-077 — `c.duration` is `c`'s own SOURCE frames; its real footprint on
    // THIS timeline (what `newEnd` needs to compare against other clips'
    // `start_frame`-space positions) is the converted, timeline-frame value.
    const movingDurTimeline = sourceFramesToTimeline(c, c.duration, fps);
    const newEnd = op.startFrame + movingDurTimeline;
    // D-104 — overlap is rejected for EVERY move now, same-track or
    // cross-track alike (reverses D-096's cross-track allowance, see this
    // op's own doc comment for why). `i === op.clip` excludes the clip's own
    // current slot from the check — only meaningful for a same-track move,
    // a no-op filter for cross-track since the clip isn't in `dest.clips` yet.
    const overlaps = dest.clips.some((other, i) => {
      if (op.fromTrack === op.toTrack && i === op.clip) return false;
      return op.startFrame < endFrame(other, fps) && newEnd > other.start_frame;
    });
    // D-104 — ripple only ever shifts clips starting AT/AFTER the landing
    // point (the real, edge-aligned case `resolveClipLanding` always
    // produces — computeInsertion's ripple positions are always an existing
    // clip's own start_frame or endFrame). A clip that starts BEFORE the
    // landing point but extends past it (straddling — not a real
    // ripple-insert scenario any NLE supports without splitting the clip
    // first) can't be cleared by this shift, so ripple can't rescue that
    // case either; reject the same as a non-ripple overlap rather than
    // leave a silently still-overlapping result.
    const straddles = dest.clips.some((other, i) => {
      if (op.fromTrack === op.toTrack && i === op.clip) return false;
      return other.start_frame < op.startFrame && endFrame(other, fps) > op.startFrame;
    });
    // B-033 — same reject-on-straddle now also covers every OTHER
    // sync-locked track this move's ripple would touch, checked against
    // the ORIGINAL tracks before any mutation.
    const syncLockBlocked =
      overlaps && op.ripple && findStraddlingSyncLockedTrack(tl.tracks, op.toTrack, op.startFrame, fps) !== null;
    if (overlaps && (!op.ripple || straddles || syncLockBlocked)) return tl;

    // D-129 — every other member of this clip's A/V link group moves by the
    // SAME delta, staying on its own track (Resolve's own "any change made to
    // one … automatically applies to the other"; a linked pair keeps sync, it
    // does not follow the video half onto the video half's new track).
    // Validated in full here, BEFORE any mutation, so a move that can't be
    // applied to every member is rejected whole rather than desyncing the
    // halves — the reject-rather-than-corrupt discipline B-033 established.
    // Mirrors `chroma-timeline::Timeline::move_clip`'s own link block.
    const rippleFires = overlaps && !!op.ripple;
    const delta = op.startFrame - c.start_frame;
    // `[track, clip id, where it must end up]` captured by STABLE id before
    // anything moves — the mutation below invalidates every clip index.
    const siblingTargets: Array<[number, string, number]> = [];
    const link = linkTargets(tl, op.fromTrack, op.clip);
    if (link) {
      for (const [ti, ci] of link.members) {
        if (ti === op.fromTrack && ci === op.clip) continue;
        const ot = tl.tracks[ti];
        if (ot.locked) return tl;
        const sib = ot.clips[ci];
        const target = sib.start_frame + delta;
        if (target < 0) return tl;
        siblingTargets.push([ti, sib.id, target]);
        // Whether THIS member's track receives the pending ripple — the same
        // predicate `propagateSyncLockRipple` uses, so the prediction here
        // and the real shift below can never disagree.
        const rippled =
          rippleFires && (ti === op.toTrack || ((ot.sync_locked ?? DEFAULT_SYNC_LOCKED) && !ot.locked));
        // B-077 — `sib`/`o` are each converted through THEIR OWN `source_fps`:
        // a link group's two members (e.g. an A/V pair) share a source file
        // in the overwhelmingly common case, but nothing here assumes it.
        const sibEnd = target + sourceFramesToTimeline(sib, sib.duration, fps);
        const clash = ot.clips.some((o, i) => {
          // Other members of the same group shift by the same delta from a
          // non-overlapping start, so they can never collide with each other.
          if (i === ci || link.members.some(([mt, mc]) => mt === ti && mc === i)) return false;
          const os = startAfterRipple(o.start_frame, rippled, op.startFrame, movingDurTimeline);
          return target < os + sourceFramesToTimeline(o, o.duration, fps) && sibEnd > os;
        });
        if (clash) return tl;
      }
    }

    const next = clone(tl);
    const [moved] = next.tracks[op.fromTrack].clips.splice(op.clip, 1);
    const destClips = next.tracks[op.toTrack].clips;
    if (overlaps && op.ripple) {
      // D-104 — mirrors `add_clip`'s own ripple contract: everything on the
      // destination track at/after the landing point shifts later by this
      // clip's own TIMELINE-frame footprint (B-077 — not its raw `.duration`)
      // to make room, rather than overlapping it.
      shiftClipsAtOrAfter(next.tracks[op.toTrack], op.startFrame, movingDurTimeline);
    }
    moved.start_frame = op.startFrame;
    destClips.push(moved);
    // D-106 — propagate to every OTHER sync-locked track, same shift, only
    // when this move's own ripple actually fired.
    if (overlaps && op.ripple) {
      propagateSyncLockRipple(next.tracks, op.toTrack, op.startFrame, movingDurTimeline);
    }
    // D-129 — place each linked sibling at the target computed (and fully
    // validated) above, resolved by its stable id rather than the index it
    // was validated with: splicing the primary out of `fromTrack` shifted
    // every later index there, and the ripple/sync shifts may have moved
    // siblings too. The target is absolute and already accounts for both, so
    // this is a plain assignment, never a second relative shift. Runs BEFORE
    // the prune below, while every track index is still the validated one.
    for (const [ti, sibId, target] of siblingTargets) {
      const sib = next.tracks[ti]?.clips.find((s) => s.id === sibId && s.id !== moved.id);
      if (sib) sib.start_frame = target;
    }
    // Auto-decommission — only the source track can have been emptied by a
    // cross-track move; a same-track move never changes clip *count* on
    // either track. Prune AFTER `toTrack`'s own mutations above, and before
    // returning, so the caller's own selection-remap sees the final shape.
    if (op.fromTrack !== op.toTrack) pruneIfEmptyTrack(next.tracks, op.fromTrack);
    return next;
  }

  const tr = tl.tracks[op.track];
  if (!tr) return tl;
  // D-089 — single choke point for the remaining per-clip ops
  // (reorder/trim_start/trim_end/slip/split/remove), mirroring Rust's own
  // single `track_mut` check (`TimelineError::TrackLocked`) rather than
  // repeating the guard in each `case` below.
  if (tr.locked) return tl;

  switch (op.kind) {
    case 'reorder': {
      const { from, to } = op;
      if (from === to || from < 0 || to < 0 || from >= tr.clips.length || to >= tr.clips.length) return tl;
      const next = clone(tl);
      const clips = next.tracks[op.track].clips;
      const [moved] = clips.splice(from, 1);
      clips.splice(to, 0, moved);
      return next;
    }
    case 'remove': {
      // D-054/D-058: a "lift", not a ripple delete — every other clip's
      // `start_frame` is untouched, so this plain splice already matches
      // `chroma-timeline::Timeline::remove` exactly; the gap it leaves is
      // implicit (nothing occupies that `start_frame` range any more).
      if (op.clip < 0 || op.clip >= tr.clips.length) return tl;
      // D-129 — deleting one member of an A/V link group deletes every
      // member (Resolve's own "…or deleting… automatically applies to the
      // other"). Refused whole if any member's track is locked; each emptied
      // track prunes, highest index first so lower ones stay valid. Mirrors
      // `chroma-timeline::Timeline::remove`.
      const link = linkTargets(tl, op.track, op.clip);
      if (link && link.members.some(([ti]) => tl.tracks[ti].locked)) return tl;
      const targets: Array<[number, number]> = link ? [...link.members] : [[op.track, op.clip]];
      targets.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      const next = clone(tl);
      for (const [ti, ci] of targets) next.tracks[ti].clips.splice(ci, 1);
      const touched = [...new Set(targets.map(([ti]) => ti))].sort((a, b) => b - a);
      for (const ti of touched) pruneIfEmptyTrack(next.tracks, ti);
      return next;
    }
    case 'remove_gap': {
      // D-105 — mirrors `chroma-timeline::Timeline::remove_gap` exactly:
      // find the real gap `frame` is inside (`gapAt`), reject as a no-op if
      // there isn't one, otherwise shift every clip at/after the gap's end
      // earlier by its width.
      const gap = gapAt(tr, op.frame, fps);
      if (!gap) return tl;
      const shift = gap.gapEnd - gap.gapStart;
      // B-033 — reject upfront if a sync-locked track has a straddling
      // clip, checked against the ORIGINAL (pre-clone) tracks.
      if (findStraddlingSyncLockedTrack(tl.tracks, op.track, gap.gapEnd, fps) !== null) return tl;
      const next = clone(tl);
      shiftClipsAtOrAfter(next.tracks[op.track], gap.gapEnd, -shift);
      // D-106 — every OTHER sync-locked track ripples too, unconditionally
      // (not gated on THAT track having a matching gap — Resolve's own real
      // behavior; see `propagateSyncLockRipple`'s own doc). The gap-*finding*
      // requirement above (`gapAt`) stays exactly as-is for `op.track` only.
      propagateSyncLockRipple(next.tracks, op.track, gap.gapEnd, -shift);
      return next;
    }
    case 'trim_start': {
      // Mirrors `chroma-timeline::Timeline::trim_start` field-for-field: the
      // clip's *end* stays fixed — `source_start` and `start_frame` shift by
      // the same clamped delta, `duration` shrinks by it.
      //
      // B-077 — `op.delta` is a TIMELINE-frame delta (the UI drag, computed
      // against the project's own pixels-per-frame — see `clampedTrimStart
      // Delta`'s own doc). `start_frame` shifts by exactly `d` (already
      // timeline-native); `source_start`/`duration` shift by `d`'s SOURCE-
      // frame equivalent, per-clip (`timelineFramesToSource`) since a linked
      // pair's two members may in principle have different `source_fps`.
      // D-235 — the rippled form is a genuinely different edit (no gap opens,
      // the neighbour is pushed instead of blocking), so it branches before
      // any of the plain-trim math below rather than post-processing it.
      if (op.ripple) return applyRippleTrim(tl, op.track, op.clip, op.delta, 'start', fps);
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const d = clampedTrimStartDelta(tr, op.clip, op.delta, fps);
      const dSource = timelineFramesToSource(c, d, fps);
      if (c.duration - dSource < 1) return tl;
      // D-129 — a linked clip trims in lockstep with every other member of
      // its group; if any member would clamp to a DIFFERENT delta (its own
      // source runs out first, a neighbour blocks it) the whole op is
      // rejected rather than leaving the halves out of sync. Unlink first for
      // a deliberate L-cut — that's what unlink is for, in both references.
      // Mirrors `chroma-timeline::Timeline::trim_start`. Compared in TIMELINE
      // frames (`d`, the amount the user actually dragged) — every member
      // must be able to absorb the SAME on-screen delta, converted to ITS
      // OWN source frames.
      const link = linkTargets(tl, op.track, op.clip);
      if (link) {
        for (const [ti, ci] of link.members) {
          if (ti === op.track && ci === op.clip) continue;
          const ot = tl.tracks[ti];
          if (ot.locked) return tl;
          const oc = ot.clips[ci];
          const oDeltaSource = timelineFramesToSource(oc, d, fps);
          if (clampedTrimStartDelta(ot, ci, op.delta, fps) !== d || oc.duration - oDeltaSource < 1) return tl;
        }
      }
      const next = clone(tl);
      const targets: Array<[number, number]> = link ? link.members : [[op.track, op.clip]];
      for (const [ti, ci] of targets) {
        const nc = next.tracks[ti].clips[ci];
        const ncDeltaSource = timelineFramesToSource(nc, d, fps);
        nc.source_start += ncDeltaSource;
        nc.start_frame += d;
        nc.duration -= ncDeltaSource;
      }
      return next;
    }
    case 'trim_end': {
      // Mirrors `chroma-timeline::Timeline::trim_end`: `start_frame` stays
      // fixed, only `duration` changes, clamped by both the source media's
      // remaining length and the nearest following clip's `start_frame` (no
      // overlap with it). `clampedTrimEndDuration` already converts `op.delta`
      // (a TIMELINE-frame delta, B-077) to `c`'s own source frames — `applied`
      // below is a `duration` (source-frame) delta throughout, needing no
      // further conversion.
      // D-235 — see the matching branch in `trim_start` above.
      if (op.ripple) return applyRippleTrim(tl, op.track, op.clip, op.delta, 'end', fps);
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const newDur = clampedTrimEndDuration(tr, op.clip, op.delta, fps);
      if (newDur === c.duration) return tl;
      const applied = newDur - c.duration;
      // D-129 — same lockstep-or-reject contract as `trim_start` above.
      const link = linkTargets(tl, op.track, op.clip);
      if (link) {
        for (const [ti, ci] of link.members) {
          if (ti === op.track && ci === op.clip) continue;
          const ot = tl.tracks[ti];
          if (ot.locked) return tl;
          if (clampedTrimEndDuration(ot, ci, op.delta, fps) - ot.clips[ci].duration !== applied) return tl;
        }
      }
      const next = clone(tl);
      const targets: Array<[number, number]> = link ? link.members : [[op.track, op.clip]];
      for (const [ti, ci] of targets) next.tracks[ti].clips[ci].duration += applied;
      return next;
    }
    case 'slip': {
      // D-195 — mirrors `trim_start`'s own structure exactly, minus the
      // `start_frame` write: `d` (a TIMELINE-frame delta, B-077 convention)
      // is clamped by `clampedSlipDelta` against the source media's own
      // bounds only (no neighbour term — `start_frame` never moves for a
      // slip), then converted per-member to that member's own SOURCE frames
      // before touching `source_start`.
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const d = clampedSlipDelta(tr, op.clip, op.delta, fps);
      if (d === 0) return tl;
      // D-129 — same lockstep-or-reject discipline as trim_start/trim_end:
      // a linked pair's two source windows must both be able to absorb the
      // exact same on-screen delta, or the whole op is rejected — see
      // `unlink`'s own doc ("the escape hatch for an L-cut — unlink, slip
      // one half").
      const link = linkTargets(tl, op.track, op.clip);
      if (link) {
        for (const [ti, ci] of link.members) {
          if (ti === op.track && ci === op.clip) continue;
          const ot = tl.tracks[ti];
          if (ot.locked) return tl;
          if (clampedSlipDelta(ot, ci, op.delta, fps) !== d) return tl;
        }
      }
      const next = clone(tl);
      const targets: Array<[number, number]> = link ? link.members : [[op.track, op.clip]];
      for (const [ti, ci] of targets) {
        const nc = next.tracks[ti].clips[ci];
        nc.source_start += timelineFramesToSource(nc, d, fps);
      }
      return next;
    }
    case 'roll': {
      // D-235 — see the op's own doc. `op.clip` is the OUTGOING clip; the
      // incoming one is whichever clip on this track starts EXACTLY where it
      // ends. Found by position, not by index+1: `Track.clips` is storage
      // order (D-054), which this model explicitly does not tie to time order.
      const left = tr.clips[op.clip];
      if (!left) return tl;
      const leftEnd = endFrame(left, fps);
      const rightIdx = tr.clips.findIndex((o, i) => i !== op.clip && o.start_frame === leftEnd);
      if (rightIdx < 0) return tl;
      const leftTargets = lockstepTargets(tl, op.track, op.clip);
      const rightTargets = lockstepTargets(tl, op.track, rightIdx);
      if (!leftTargets || !rightTargets) return tl;
      // A clip cannot be on both sides of its own edit point. This can only
      // happen if the two sides share a link group, which would double-apply
      // the delta below; refuse rather than corrupt.
      if (leftTargets.some(([lt, lc]) => rightTargets.some(([rt, rc]) => lt === rt && lc === rc))) return tl;
      const [tailLo, tailHi] = lockstepRoom(tl, leftTargets, tailRoom, fps);
      const [headLo, headHi] = lockstepRoom(tl, rightTargets, headRoom, fps);
      const lo = Math.max(tailLo, headLo);
      const hi = Math.min(tailHi, headHi);
      if (lo > hi) return tl;
      const d = clampInt(op.delta, lo, hi);
      if (d === 0) return tl;
      const next = clone(tl);
      for (const [ti, ci] of leftTargets) {
        const nc = next.tracks[ti].clips[ci];
        nc.duration += timelineFramesToSource(nc, d, fps);
      }
      for (const [ti, ci] of rightTargets) {
        const nc = next.tracks[ti].clips[ci];
        const dSource = timelineFramesToSource(nc, d, fps);
        nc.source_start += dSource;
        nc.duration -= dSource;
        nc.start_frame += d;
      }
      // Result check rather than a per-member neighbour clamp — see
      // `hasOverlap`'s own doc for why this shape, not that one.
      const touched = new Set([...leftTargets, ...rightTargets].map(([ti]) => ti));
      for (const ti of touched) {
        if (hasOverlap(next.tracks[ti], fps)) return tl;
      }
      return next;
    }
    case 'slide': {
      // D-235 — see the op's own doc. The clip keeps its duration AND its
      // source window; only `start_frame` moves, and its touching neighbours
      // absorb that movement at their own out/in points.
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const cEnd = endFrame(c, fps);
      const prevIdx = tr.clips.findIndex((o, i) => i !== op.clip && endFrame(o, fps) === c.start_frame);
      const nextIdx = tr.clips.findIndex((o, i) => i !== op.clip && o.start_frame === cEnd);
      const selfTargets = lockstepTargets(tl, op.track, op.clip);
      if (!selfTargets) return tl;
      const prevTargets = prevIdx >= 0 ? lockstepTargets(tl, op.track, prevIdx) : null;
      const nextTargets = nextIdx >= 0 ? lockstepTargets(tl, op.track, nextIdx) : null;
      if ((prevIdx >= 0 && !prevTargets) || (nextIdx >= 0 && !nextTargets)) return tl;
      let lo = -Infinity;
      let hi = Infinity;
      if (prevTargets) {
        // The previous clip grows/shrinks at its tail by the same delta.
        const [l, h] = lockstepRoom(tl, prevTargets, tailRoom, fps);
        lo = Math.max(lo, l);
        hi = Math.min(hi, h);
      } else {
        // Nothing touching on the left: the clamp is the real free space back
        // to whatever IS there (or frame 0), so a slide at the head of a track
        // still works and still cannot reverse into a neighbour.
        const prevEnd = tr.clips.reduce(
          (max, o, i) => (i === op.clip ? max : Math.max(max, endFrame(o, fps) <= c.start_frame ? endFrame(o, fps) : 0)),
          0,
        );
        lo = Math.max(lo, prevEnd - c.start_frame);
      }
      if (nextTargets) {
        // The next clip's head moves by the same delta.
        const [l, h] = lockstepRoom(tl, nextTargets, headRoom, fps);
        lo = Math.max(lo, l);
        hi = Math.min(hi, h);
      } else {
        let nextStart = Infinity;
        for (const [i, o] of tr.clips.entries()) {
          if (i !== op.clip && o.start_frame >= cEnd) nextStart = Math.min(nextStart, o.start_frame);
        }
        hi = Math.min(hi, nextStart - cEnd);
      }
      // "A slide is a roll between 3 clips" — with neither a neighbour nor an
      // obstacle on either side nothing bounds or absorbs the gesture, and it
      // is a plain `move`, not a slide.
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return tl;
      if (lo > hi) return tl;
      const d = clampInt(op.delta, lo, hi);
      if (d === 0) return tl;
      const next = clone(tl);
      for (const [ti, ci] of selfTargets) next.tracks[ti].clips[ci].start_frame += d;
      for (const [ti, ci] of prevTargets ?? []) {
        const nc = next.tracks[ti].clips[ci];
        nc.duration += timelineFramesToSource(nc, d, fps);
      }
      for (const [ti, ci] of nextTargets ?? []) {
        const nc = next.tracks[ti].clips[ci];
        const dSource = timelineFramesToSource(nc, d, fps);
        nc.source_start += dSource;
        nc.duration -= dSource;
        nc.start_frame += d;
      }
      const touchedTracks = new Set(
        [...selfTargets, ...(prevTargets ?? []), ...(nextTargets ?? [])].map(([ti]) => ti),
      );
      for (const ti of touchedTracks) {
        if (hasOverlap(next.tracks[ti], fps)) return tl;
      }
      return next;
    }
    case 'split': {
      // Mirrors `chroma-timeline::Timeline::split` — including giving the
      // right half its own `start_frame` (the D-058 bug: this used to copy
      // the left half's `start_frame` unchanged, leaving both halves
      // claiming the same timeline position).
      // B-077 — `offset`/`off` below are TIMELINE-frame offsets (`op.atFrame`
      // is a timeline position, e.g. the playhead); compared against each
      // clip's own TIMELINE-frame footprint, not its raw (source-frame)
      // `.duration`. The actual `source_start`/`duration` split further down
      // converts that timeline offset to each clip's own source frames.
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const offset = op.atFrame - c.start_frame;
      if (offset <= 0 || offset >= sourceFramesToTimeline(c, c.duration, fps)) return tl;
      // D-129 — a razor through one member of a link group cuts every member
      // at the same frame ("clicking a linked clip with the Razor Tool cuts
      // both tracks at once"), producing two INTACT pairs: left halves keep
      // the group, right halves move to a derived one (`{group}·{frame}`,
      // matching the clip-id derivation already used here). Rejected whole if
      // the frame isn't strictly inside every member (an already-slipped
      // L-cut). Mirrors `chroma-timeline::Timeline::split`.
      const link = linkTargets(tl, op.track, op.clip);
      if (link) {
        for (const [ti, ci] of link.members) {
          if (ti === op.track && ci === op.clip) continue;
          const ot = tl.tracks[ti];
          if (ot.locked) return tl;
          const o = ot.clips[ci];
          const off = op.atFrame - o.start_frame;
          if (off <= 0 || off >= sourceFramesToTimeline(o, o.duration, fps)) return tl;
        }
      }
      const rightGroup = link ? `${link.group}·${op.atFrame}` : null;
      const next = clone(tl);
      // Descending, so inserting each right half at `ci + 1` never shifts an
      // index still to be processed (only matters when two members share a
      // track — possible for a richer group, harmless for a plain pair).
      const targets: Array<[number, number]> = link ? [...link.members] : [[op.track, op.clip]];
      targets.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      for (const [ti, ci] of targets) {
        const clips = next.tracks[ti].clips;
        const left = clips[ci];
        const off = op.atFrame - left.start_frame;
        // B-077 — `off` is a TIMELINE-frame offset; `source_start`/`duration`
        // (source frames) split at ITS source-frame equivalent, `offSource`,
        // not `off` itself. `start_frame` uses the raw timeline `off`.
        const offSource = timelineFramesToSource(left, off, fps);
        const right: Clip = {
          ...left,
          id: `${left.id}·${op.atFrame}`,
          link_group: rightGroup,
          start_frame: left.start_frame + off,
          source_start: left.source_start + offSource,
          duration: left.duration - offSource,
        };
        left.duration = offSource;
        clips.splice(ci + 1, 0, right);
      }
      return next;
    }
    default:
      return tl;
  }
}
