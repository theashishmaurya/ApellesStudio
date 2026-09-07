/**
 * @chroma/editor — pure timeline → FCPXML interchange compiler (D-196), the
 * Edit tab's "move this edit to another NLE" export.
 *
 * What it is: takes the SAME `Timeline` model `timelineExport.ts` compiles to
 * an ffmpeg argv (D-183) and compiles it instead to a real, standard **FCPXML
 * 1.7** document — the Final Cut Pro X XML Interchange Format DaVinci Resolve
 * and Final Cut Pro both import natively. Pure — no Tauri, no React, no store
 * access, no I/O, exactly `timelineExport.ts`'s own contract; the caller
 * (`useEditorControl.ts`'s `editor_export_fcpxml` op) writes the returned
 * string to disk.
 *
 * What it does NOT do (see D-196 for the full field-mapping table and why):
 *   - Does not emit XMEML/FCP7 XML (the Premiere-targeted sibling format) —
 *     scoped out this pass as a precise, separately-researched follow-up, not
 *     attempted here.
 *   - Does not animate `chroma_keyframes` (per-clip position/scale/rotation/
 *     opacity/crop animation) or `fade_in_frames`/`fade_out_frames` — only a
 *     clip's STATIC/base transform, crop, and opacity are exported. FCPXML
 *     genuinely supports keyframing these via `<param>`/`<keyframeAnimation>`
 *     nested under the relevant `adjust-*` element, but the exact intrinsic
 *     `param name`/`key` Final Cut expects for its BUILT-IN adjustments
 *     (as opposed to a named third-party filter plugin, which declares its
 *     own parameter names) could not be confirmed from the DTD or any
 *     available spec material without guessing — see this module's own
 *     `KNOWN GAPS` block below and D-196.
 *   - Does not export `Track.duck_from`/`duck_db`/`duck_attack_ms`/
 *     `duck_release_ms` (dynamic audio ducking automation) — FCPXML has no
 *     static equivalent (audio volume automation is explicitly outside what
 *     this interchange format carries, matching real editors' own documented
 *     FCPXML export limits).
 *   - Does not honor `editor_export`'s ffmpeg-only, non-persisted export-time
 *     parameters (`speedOverrides`/`fitOverrides`/`freezeOverrides`) — those
 *     exist purely to steer the ffmpeg render path (`timelineExport.ts`) and
 *     have no `Clip` field backing them to read here. A real interchange
 *     speed change is a different FCPXML mechanism entirely
 *     (`conform-rate`/`timeMap`, DTD-confirmed elements) — not attempted.
 *   - Does not know a clip's real SOURCE pixel resolution unless the caller
 *     supplies it via `sourceInfo` (this module has no I/O to probe a file
 *     itself) — falls back to assuming the OUTPUT canvas's own aspect ratio,
 *     which is exact for a plain full-canvas clip and approximate for a
 *     scaled/cropped/PIP one; every such approximation is reported in the
 *     returned `warnings` array rather than silently applied.
 *
 * Spec grounding (D-196): every element/attribute this module emits was
 * checked against Apple's own published FCPXML v1.7 DTD (the newest version
 * Apple ever released in machine-checkable DTD form — later versions are
 * documented in prose only), a verbatim copy of which lives at
 * `./__fixtures__/fcpxml-1.7.dtd` and is what `timelineInterchange.test.ts`
 * validates every generated fixture against with a real DTD validator
 * (`libxml2`/`xmllint`), not just a parser round-trip.
 */

import type { Clip, Rational, Timeline, Track } from './timeline';
import { timelineDuration, timelineFps } from './timeline';

// --------------------------------------------------------------------------- //
// Rational time — FCPXML's own `%time;` grammar: "<num>/<den>s" (or a bare
// "<n>s" for a whole-second value), a 64-bit-numerator/32-bit-denominator
// fraction of a second (DTD comment, `__fixtures__/fcpxml-1.7.dtd`). Building
// this from a real `Rational` frame rate (not a rounded float) is what keeps
// every offset/duration/start EXACT rather than accumulating drift over a
// long timeline — the same reason `Timeline.rate` is a `Rational` in the
// first place (see that field's own doc).
// --------------------------------------------------------------------------- //

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

/** `frames` (an integer count at `rate`) as an FCPXML `%time;` string, exactly
 *  — `frames * rate.den / rate.num` seconds, reduced to lowest terms. `"0s"`
 *  for zero rather than `"0/1s"` (both parse identically, but real FCPXML
 *  files always use the bare form for zero). */
export function rationalTimeString(frames: number, rate: Rational): string {
  const num = Math.round(frames) * rate.den;
  const den = rate.num;
  if (num === 0) return '0s';
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}

/** A plain fps float (`Clip.source_fps`, always a measured/probed number, not
 *  a fraction) as the nearest real broadcast `Rational` — snaps to the
 *  standard NTSC family (23.976/29.97/47.952/59.94/119.88, each really
 *  `whole*1000/1001`) within a tight tolerance, since those are exactly the
 *  rates a probed float is near-always rounding error away from, and FCPXML's
 *  own convention (`frameDuration="1001/30000s"`, the DTD's own worked
 *  example) is to spell them as that exact fraction, never a decimal
 *  approximation. Anything else (an exact integer rate, or a genuinely
 *  unusual probed value) reduces `round(fps*1000)/1000` to lowest terms —
 *  exact for integer rates, a documented, honest thousandth-of-a-frame
 *  approximation otherwise. */
export function fpsToRational(fps: number): Rational {
  const ntscWholes = [24, 25, 30, 48, 50, 60, 120];
  for (const whole of ntscWholes) {
    const ntscRate = (whole * 1000) / 1001;
    if (Math.abs(fps - ntscRate) < 0.01) return { num: whole * 1000, den: 1001 };
  }
  const integerRates = [12, 15, 24, 25, 30, 48, 50, 60, 100, 120];
  for (const whole of integerRates) {
    if (Math.abs(fps - whole) < 0.001) return { num: whole, den: 1 };
  }
  const num = Math.round(fps * 1000);
  const g = gcd(num, 1000);
  return { num: num / g, den: 1000 / g };
}

/** The project's own exact rate as a `Rational` — mirrors `timelineFps`'s
 *  fallback (an absent/invalid `Timeline.rate` is `DEFAULT_FPS`/1), but
 *  returns the fraction itself rather than the reduced-to-a-float ratio, so
 *  every timeline-space time value this module emits stays exact. */
function timelineRational(tl: Timeline): Rational {
  const r = tl.rate;
  if (r && r.num > 0 && r.den > 0) return r;
  return { num: timelineFps(tl), den: 1 };
}

/** `clip`'s own native rate as a `Rational` — B-075's `source_fps` (a plain
 *  float) converted via `fpsToRational`, or the project's own rate when
 *  absent (the exact fallback `sourceFramesToTimeline` already uses, per its
 *  own doc: the ratio is `1` either way for a same-rate clip, never a
 *  behavior change for the common case). */
function clipSourceRational(clip: Clip, projectRate: Rational): Rational {
  return clip.source_fps && clip.source_fps > 0 ? fpsToRational(clip.source_fps) : projectRate;
}

// --------------------------------------------------------------------------- //
// XML text escaping — attribute values only need the five predefined XML
// entities (no CDATA sections anywhere in this compiler's output).
// --------------------------------------------------------------------------- //

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `path` as a `file://` URL — FCPXML's `asset/@src` grammar (DTD comment:
 *  "file: URL"). Assumes `path` is already absolute (every real caller's
 *  `source_path` is, per `Clip`'s own doc) — this only adds the scheme and
 *  percent-encodes the handful of characters a bare filesystem path can
 *  legally contain that a URL can't (space, `#`, `?`, `%` itself), rather
 *  than pulling in a full URL/path library for one conversion. */
function fileUrl(path: string): string {
  const encoded = path
    .split('/')
    .map((seg) => seg.replace(/%/g, '%25').replace(/ /g, '%20').replace(/#/g, '%23').replace(/\?/g, '%3F'))
    .join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

// --------------------------------------------------------------------------- //
// Options + the per-clip source metadata this compiler cannot probe itself
// --------------------------------------------------------------------------- //

/** What this module needs to know about a clip's SOURCE media beyond what
 *  `Clip` itself carries, to convert Chroma's canvas-fraction transform
 *  (`scale`/`box_width`/`box_height`/`position_x`/`position_y`, all D-136/
 *  D-193 fractions of the OUTPUT composition) into FCPXML's `adjust-transform`
 *  (a multiplier of the clip's OWN NATIVE pixel size, plus a point offset from
 *  frame centre) — the identical "this pure module has no I/O to probe a
 *  source's real resolution" gap `timelineExport.ts`'s own `fitOverrides` doc
 *  already names (B-074/D-184). The caller (`useEditorControl.ts`) has real
 *  probed dimensions for any clip whose `media_id` resolves in the media
 *  pool (`MediaItem.video.width`/`height`/`hasAudio`) and should pass them
 *  here; a clip missing an entry gets the documented canvas-aspect fallback
 *  (see `resolveNativeSize`) and a `warnings` entry when that fallback is
 *  actually load-bearing (a non-default transform/crop on that clip). */
export interface ClipSourceInfo {
  width?: number;
  height?: number;
  /** Whether the SOURCE FILE (not this one clip's placement of it) has a
   *  decodeable audio stream — mirrors `MediaItem.video.hasAudio`. Absent =
   *  unknown; `resources`' `asset/@hasAudio` conservatively defaults to `1`
   *  in that case (a silent source with `hasAudio="1"` costs nothing — no
   *  audio samples are found — while a real source wrongly marked `"0"`
   *  could make a target app refuse to expose an audio component a linked
   *  audio clip needs). */
  hasAudio?: boolean;
}

export interface FcpxmlExportOptions {
  /** Output composition rate — defaults to the timeline's own exact
   *  `Rational` rate (`Timeline.rate`) when omitted, which is ALWAYS exact;
   *  only pass this to deliberately conform to a different rate than the
   *  timeline's own. A plain float override is converted via `fpsToRational`
   *  (an approximation for a non-integer, non-NTSC-family value — see that
   *  function's own doc). */
  fps?: number;
  /** The output composition's pixel size — every clip's `position_x`/
   *  `position_y`/`scale`/`box_width`/`box_height` (D-136/D-193) are
   *  fractions of this, exactly as `timelineExport.ts`'s own `opts.width`/
   *  `height` already are. */
  width: number;
  height: number;
  /** `<project name="...">` — defaults to `timeline.name`. */
  projectName?: string;
  /** `<event name="...">` this project lands in — defaults to
   *  `"Chroma Export"`, matching every real FCPXML export's own convention
   *  of always having SOME event to file the project under. */
  eventName?: string;
  /** Per-clip source metadata this module cannot probe itself — see
   *  `ClipSourceInfo`'s own doc. Keyed by `Clip.id`. */
  sourceInfo?: Record<string, ClipSourceInfo>;
}

export interface FcpxmlExportResult {
  xml: string;
  /** Every place this compile fell back to a documented approximation
   *  (no `sourceInfo` for a clip whose transform/crop actually needs it) or
   *  silently-would-have-dropped-data case worth surfacing (a clip on a
   *  track this format can't place, an animated field only a base value was
   *  taken from) — human-readable, one entry per real occurrence. Empty for
   *  a timeline this compiler could losslessly (within its documented v1
   *  scope) represent. */
  warnings: string[];
}

// --------------------------------------------------------------------------- //
// Geometry — canvas-fraction (Chroma) -> native-multiplier + centre-offset
// (FCPXML `adjust-transform`) conversion. See `ClipSourceInfo`'s own doc for
// why the native size may be a documented fallback rather than the real one.
// --------------------------------------------------------------------------- //

interface ResolvedBox {
  /** This clip's real rendered width/height in OUTPUT PIXELS — the same
   *  quantity `buildClipFilterChain` (`timelineExport.ts`) computes via
   *  `opts.width * (box_width ?? scale)`, `-2`-style aspect-derived height
   *  for the `'fit'` default. */
  widthPx: number;
  heightPx: number;
  /** Top-left corner, in output pixels — D-136's own convention
   *  (`position_x`/`position_y` are the fraction of the canvas the clip's
   *  own top-left corner sits at). */
  topLeftXPx: number;
  topLeftYPx: number;
}

function resolveBox(clip: Clip, opts: FcpxmlExportOptions, nativeAspect: number): ResolvedBox {
  const scale = clip.scale ?? 1;
  const widthPx = clip.box_width != null ? opts.width * clip.box_width : opts.width * scale;
  const heightPx =
    clip.box_height != null
      ? opts.height * clip.box_height
      : // 'fit' default (B-074/D-193's own documented default, no
        // `fitOverrides` concept here — interchange export always uses the
        // undistorted, aspect-preserving reading): derive height from the
        // clip's own real (post-crop) aspect ratio, exactly like ffmpeg's
        // `-2` does.
        widthPx / nativeAspect;
  return {
    widthPx,
    heightPx,
    topLeftXPx: (clip.position_x ?? 0) * opts.width,
    topLeftYPx: (clip.position_y ?? 0) * opts.height,
  };
}

/** `adjust-transform`'s own `"x y"` pair: the clip's CENTRE, offset from the
 *  FRAME's centre, in output pixels — FCPXML's coordinate convention (DTD:
 *  `position CDATA "0 0"`, no unit given beyond "matches the format's own
 *  pixel dimensions", confirmed against every real FCPXML example found —
 *  `Y+` is UP, the opposite of D-136's own top-down pixel convention, hence
 *  the sign flip on `y`). */
function transformPosition(box: ResolvedBox, opts: FcpxmlExportOptions): string {
  const centreX = box.topLeftXPx + box.widthPx / 2;
  const centreY = box.topLeftYPx + box.heightPx / 2;
  const x = centreX - opts.width / 2;
  const y = opts.height / 2 - centreY;
  return `${round4(x)} ${round4(y)}`;
}

/** `adjust-transform`'s own `"sx sy"` scale pair — a MULTIPLIER of the
 *  clip's OWN NATIVE (post-crop) pixel size, fundamentally different from
 *  Chroma's `scale` (a fraction of the OUTPUT canvas, `timelineExport.ts`'s
 *  own B-074 doc) — this is the actual unit conversion between the two
 *  models, not a value passed through. `nativeWidth`/`nativeHeight` are
 *  already post-crop (the caller applies `adjust-crop` from the SAME
 *  original asset dimensions independently — FCP applies crop before
 *  transform in its own render pipeline, same order this function assumes). */
function transformScale(box: ResolvedBox, nativeWidthPostCrop: number, nativeHeightPostCrop: number): string {
  const sx = nativeWidthPostCrop > 0 ? box.widthPx / nativeWidthPostCrop : 1;
  const sy = nativeHeightPostCrop > 0 ? box.heightPx / nativeHeightPostCrop : 1;
  return `${round4(sx)} ${round4(sy)}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// --------------------------------------------------------------------------- //
// Resources — one <format> per distinct rate/size, one <asset> per distinct
// source_path (real FCP convention: an asset is deduplicated by its own
// identity, not re-declared per clip that trims it differently).
// --------------------------------------------------------------------------- //

interface FormatResource {
  id: string;
  rate: Rational;
  width: number;
  height: number;
}

interface AssetResource {
  id: string;
  sourcePath: string;
  formatId: string;
  usedByVideoTrack: boolean;
  usedByAudioTrack: boolean;
  hasAudio: boolean;
}

function formatKey(rate: Rational, width: number, height: number): string {
  return `${rate.num}/${rate.den}@${width}x${height}`;
}

/**
 * Compile `timeline` to a real, standard FCPXML 1.7 document (D-196). See
 * this module's own header doc for the full, precise scope (what maps, what
 * doesn't) and `docs/08-decisions.md`'s D-196 entry for the field-mapping
 * table this implements.
 */
export function buildFcpxml(timeline: Timeline, opts: FcpxmlExportOptions): FcpxmlExportResult {
  const warnings: string[] = [];
  const projectRate = opts.fps !== undefined ? fpsToRational(opts.fps) : timelineRational(timeline);
  const totalFrames = timelineDuration(timeline);

  const sequenceFormat: FormatResource = { id: 'fmt-sequence', rate: projectRate, width: opts.width, height: opts.height };
  const formats = new Map<string, FormatResource>([[formatKey(projectRate, opts.width, opts.height), sequenceFormat]]);
  let formatCounter = 1;
  function formatFor(rate: Rational, width: number, height: number): FormatResource {
    const key = formatKey(rate, width, height);
    const existing = formats.get(key);
    if (existing) return existing;
    const created: FormatResource = { id: `fmt${++formatCounter}`, rate, width, height };
    formats.set(key, created);
    return created;
  }

  const assets = new Map<string, AssetResource>();
  let assetCounter = 0;
  function assetFor(clip: Clip, trackKind: Track['kind']): AssetResource {
    const existing = assets.get(clip.source_path);
    const info = opts.sourceInfo?.[clip.id];
    if (existing) {
      if (trackKind === 'video') existing.usedByVideoTrack = true;
      if (trackKind === 'audio') existing.usedByAudioTrack = true;
      if (info?.hasAudio) existing.hasAudio = true;
      return existing;
    }
    const nativeRate = clipSourceRational(clip, projectRate);
    // Asset native size, for the format resource: real (`sourceInfo`) or the
    // sequence's own size (the same documented fallback `resolveNativeSize`
    // uses for the transform math below).
    const nativeWidth = info?.width ?? opts.width;
    const nativeHeight = info?.height ?? opts.height;
    const created: AssetResource = {
      id: `asset${++assetCounter}`,
      sourcePath: clip.source_path,
      formatId: formatFor(nativeRate, nativeWidth, nativeHeight).id,
      usedByVideoTrack: trackKind === 'video',
      usedByAudioTrack: trackKind === 'audio',
      // Conservative default (see `ClipSourceInfo.hasAudio`'s own doc) —
      // `true` unless the caller positively knows otherwise.
      hasAudio: info?.hasAudio ?? true,
    };
    assets.set(clip.source_path, created);
    return created;
  }

  const videoTracks = timeline.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.kind === 'video' && !track.hidden);
  const audioTracks = timeline.tracks.map((track, index) => ({ track, index })).filter(({ track }) => track.kind === 'audio');

  // Lane assignment (D-196): FCPXML's own rule (DTD comment on `ao_attrs`) is
  // "positive lane = anchored ABOVE its parent, higher = more foreground."
  // Chroma's own compositing contract (`chroma_timeline::edit::
  // composite_video_frame`, mirrored by `timelineExport.ts`'s own doc) is
  // "track index 0 is the highest z-priority" — so track 0 gets the HIGHEST
  // lane number, and the back-most video track gets lane 1 (never 0 — a
  // `%anchor_item;` attached to the backbone `<gap>` below MUST have a
  // non-zero lane per the DTD's own comment on `anchor_item`). Audio tracks
  // get negative lanes (their own relative order has no effect on the actual
  // mix — DTD/real-world note — this only keeps them out of the video lane
  // numbering, never actually read as a stacking order).
  const videoLaneFor = new Map<number, number>();
  videoTracks.forEach(({ index }, i) => videoLaneFor.set(index, videoTracks.length - i));
  const audioLaneFor = new Map<number, number>();
  audioTracks.forEach(({ index }, i) => audioLaneFor.set(index, -(i + 1)));

  const clipXmlParts: string[] = [];

  function nativeAspectAndPostCrop(
    clip: Clip,
  ): { aspect: number; postCropWidth: number; postCropHeight: number; approximated: boolean } {
    const info = opts.sourceInfo?.[clip.id];
    const nativeWidth = info?.width ?? opts.width;
    const nativeHeight = info?.height ?? opts.height;
    const cl = clip.crop_left ?? 0;
    const ct = clip.crop_top ?? 0;
    const cr = clip.crop_right ?? 0;
    const cb = clip.crop_bottom ?? 0;
    const postCropWidth = nativeWidth * (1 - cl - cr);
    const postCropHeight = nativeHeight * (1 - ct - cb);
    return { aspect: postCropWidth / postCropHeight, postCropWidth, postCropHeight, approximated: !info };
  }

  function buildClip(clip: Clip, trackKind: Track['kind'], lane: number, srcEnable: 'all' | 'audio' | 'video'): void {
    const asset = assetFor(clip, trackKind);
    const nativeRate = clipSourceRational(clip, projectRate);
    const offset = rationalTimeString(clip.start_frame, projectRate);
    const start = rationalTimeString(clip.source_start, nativeRate);
    const duration = rationalTimeString(clip.duration, nativeRate);

    const attrs: string[] = [
      `ref="${asset.id}"`,
      `lane="${lane}"`,
      `offset="${offset}"`,
      `name="${xmlEscape(clip.name)}"`,
      `start="${start}"`,
      `duration="${duration}"`,
    ];
    if (srcEnable !== 'all') attrs.push(`srcEnable="${srcEnable}"`);

    const children: string[] = [];

    // Child order below is NOT arbitrary — it mirrors `asset-clip`'s own DTD
    // content model exactly (`%intrinsic-params;` expands to
    // `(adjust-crop?, ..., adjust-transform?, adjust-blend?, ...,
    // adjust-volume?, ...)`, a SEQUENCE not a choice group), which a real DTD
    // validator enforces — `adjust-crop` before `adjust-transform` before
    // `adjust-blend` before `adjust-volume`, always.
    if (trackKind === 'video') {
      const cl = clip.crop_left ?? 0;
      const ct = clip.crop_top ?? 0;
      const cr = clip.crop_right ?? 0;
      const cb = clip.crop_bottom ?? 0;
      if (cl !== 0 || ct !== 0 || cr !== 0 || cb !== 0) {
        // D-132's crop is left/right normalised by the SOURCE's own WIDTH,
        // top/bottom by its HEIGHT. FCPXML's `trim-rect` (DTD comment:
        // "crop values as a percentage of ORIGINAL FRAME HEIGHT") normalises
        // ALL FOUR edges by height — left/right need the source's real aspect
        // ratio to convert correctly; top/bottom are already the same unit
        // and pass through as a plain percentage.
        const { aspect, approximated } = nativeAspectAndPostCrop(clip);
        if (approximated && (cl !== 0 || cr !== 0)) {
          warnings.push(
            `clip "${clip.name}" (${clip.id}): crop_left/crop_right converted to FCPXML's height-relative ` +
              `trim-rect using the OUTPUT CANVAS aspect ratio (no sourceInfo supplied) — pass ` +
              `sourceInfo[clip.id] = {width,height} for an exact conversion if this clip's source ` +
              `isn't already the same aspect ratio as the canvas.`,
          );
        }
        children.push(
          `<adjust-crop mode="trim"><trim-rect left="${round4(cl * aspect * 100)}" top="${round4(ct * 100)}" ` +
            `right="${round4(cr * aspect * 100)}" bottom="${round4(cb * 100)}"/></adjust-crop>`,
        );
      }

      const { aspect, postCropWidth, postCropHeight, approximated } = nativeAspectAndPostCrop(clip);
      const box = resolveBox(clip, opts, aspect);
      const hasRealTransform =
        (clip.position_x ?? 0) !== 0 ||
        (clip.position_y ?? 0) !== 0 ||
        (clip.scale ?? 1) !== 1 ||
        clip.box_width != null ||
        clip.box_height != null ||
        (clip.rotation ?? 0) !== 0;
      if (approximated && hasRealTransform) {
        warnings.push(
          `clip "${clip.name}" (${clip.id}): position/scale converted to FCPXML's adjust-transform using the ` +
            `OUTPUT CANVAS size as a stand-in for the source's real native resolution (no sourceInfo supplied) — ` +
            `pass sourceInfo[clip.id] = {width,height} for an exact conversion.`,
        );
      }
      const position = transformPosition(box, opts);
      const scale = transformScale(box, postCropWidth, postCropHeight);
      const rotation = clip.rotation ?? 0;
      children.push(`<adjust-transform position="${position}" scale="${scale}" rotation="${round4(rotation)}"/>`);

      const opacity = clip.opacity ?? 1;
      if (opacity !== 1) {
        children.push(`<adjust-blend amount="${round4(opacity)}"/>`);
      }
    }

    // Video-track clips never carry `adjust-volume` here — `Track.gain`'s
    // own doc is explicit that a video track's embedded audio "stays
    // hardcoded at unity" (D-057's scoping); only a real AUDIO-track clip's
    // gain is exported (handled directly in the audio-track loop below,
    // since `gain` is a per-TRACK quantity this per-clip function has no
    // reason to take as a parameter).
    clipXmlParts.push(`<asset-clip ${attrs.join(' ')}>${children.join('')}</asset-clip>`);
  }

  // ------------------------------------------------------------------- //
  // Emit every real clip, video tracks first then audio (order within the
  // backbone gap doesn't matter — every clip carries its own absolute
  // `offset` — but grouping keeps the output readable/diffable).
  // ------------------------------------------------------------------- //
  for (const { track, index } of videoTracks) {
    const lane = videoLaneFor.get(index)!;
    for (const clip of track.clips) {
      const srcEnable: 'all' | 'video' = clip.link_group ? 'video' : 'all';
      buildClip(clip, 'video', lane, srcEnable);
    }
  }
  for (const { track, index } of audioTracks) {
    const lane = audioLaneFor.get(index)!;
    const gain = track.gain ?? 1;
    const gainDb = gain > 0 ? 20 * Math.log10(gain) : -96;
    for (const clip of track.clips) {
      const asset = assetFor(clip, 'audio');
      const nativeRate = clipSourceRational(clip, projectRate);
      const offset = rationalTimeString(clip.start_frame, projectRate);
      const start = rationalTimeString(clip.source_start, nativeRate);
      const duration = rationalTimeString(clip.duration, nativeRate);
      const attrs = [
        `ref="${asset.id}"`,
        `lane="${lane}"`,
        `offset="${offset}"`,
        `name="${xmlEscape(clip.name)}"`,
        `start="${start}"`,
        `duration="${duration}"`,
        // A video-linked audio half (D-129) reads only the audio component
        // of the same shared asset the video half also references.
        ...(clip.link_group ? ['srcEnable="audio"'] : []),
      ];
      const children: string[] = [];
      if (gainDb !== 0) children.push(`<adjust-volume amount="${round4(gainDb)}dB"/>`);
      clipXmlParts.push(`<asset-clip ${attrs.join(' ')}>${children.join('')}</asset-clip>`);
    }
  }

  if (videoTracks.length === 0 && audioTracks.length === 0) {
    warnings.push('timeline has no visible video or audio tracks — exported an empty sequence.');
  }
  if (timeline.tracks.some((t) => t.kind === 'video' && t.hidden)) {
    warnings.push('one or more hidden video tracks were skipped entirely (matches the ffmpeg exporter\'s own v1 scope).');
  }
  const anyDucked = timeline.tracks.some((t) => t.kind === 'audio' && t.duck_from != null);
  if (anyDucked) {
    warnings.push(
      'one or more audio tracks use ducking (Track.duck_from) — FCPXML has no static audio-automation ' +
        'equivalent for this (matches the format\'s own documented exclusion of audio volume automation); not exported.',
    );
  }
  const anyFades = timeline.tracks.some((t) => t.clips.some((c) => (c.fade_in_frames ?? 0) > 0 || (c.fade_out_frames ?? 0) > 0));
  if (anyFades) {
    warnings.push(
      'one or more clips have a fade (Clip.fade_in_frames/fade_out_frames) — not exported this pass (see this ' +
        "module's own header doc's KNOWN GAPS); only the clip's steady-state values are carried.",
    );
  }
  const anyKeyframed = timeline.tracks.some((t) => t.clips.some((c) => (c.chroma_keyframes?.length ?? 0) > 0));
  if (anyKeyframed) {
    warnings.push(
      'one or more clips have chroma_keyframes (animated transform) — not exported this pass (see this module\'s ' +
        "own header doc's KNOWN GAPS); only the clip's static/base transform values are carried.",
    );
  }

  // ------------------------------------------------------------------- //
  // Resources + document assembly
  // ------------------------------------------------------------------- //
  const formatXml = [...formats.values()]
    .map(
      (f) =>
        `<format id="${f.id}" name="FFVideoFormatRateUndefined" frameDuration="${rationalTimeString(1, f.rate)}" ` +
        `width="${f.width}" height="${f.height}"/>`,
    )
    .join('');

  const assetXml = [...assets.values()]
    .map((a) => {
      const hasVideo = a.usedByVideoTrack ? '1' : '0';
      const hasAudio = a.hasAudio ? '1' : '0';
      const name = xmlEscape(a.sourcePath.split('/').pop() ?? a.sourcePath);
      return (
        `<asset id="${a.id}" name="${name}" src="${xmlEscape(fileUrl(a.sourcePath))}" ` +
        `format="${a.formatId}" hasVideo="${hasVideo}" hasAudio="${hasAudio}"` +
        (a.hasAudio ? ' audioSources="1" audioChannels="2" audioRate="48000"' : '') +
        `/>`
      );
    })
    .join('');

  const totalDurationStr = rationalTimeString(totalFrames, projectRate);
  const projectName = xmlEscape(opts.projectName ?? timeline.name);
  const eventName = xmlEscape(opts.eventName ?? 'Chroma Export');

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE fcpxml>\n' +
    '<fcpxml version="1.7">' +
    `<resources>${formatXml}${assetXml}</resources>` +
    '<library>' +
    `<event name="${eventName}">` +
    `<project name="${projectName}">` +
    `<sequence format="${sequenceFormat.id}" duration="${totalDurationStr}" tcStart="0s" tcFormat="NDF">` +
    '<spine>' +
    `<gap name="Chroma Timeline" offset="0s" duration="${totalDurationStr}">${clipXmlParts.join('')}</gap>` +
    '</spine>' +
    '</sequence>' +
    '</project>' +
    '</event>' +
    '</library>' +
    '</fcpxml>';

  return { xml, warnings };
}
