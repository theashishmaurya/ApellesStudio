/**
 * `@apelles/editor` — a gated clip proposal built into a short's timeline
 * (D-411 §4, §5.1; Phase 1: centre crop).
 *
 * **What it is.** One pure function, [`buildShortBody`]: the proposal's
 * resolved source ranges (the clean-cut gate's answer, `apelles_clipper`)
 * laid back to back as ordinary clips on an ordinary timeline at the short's
 * own size, then tightened and captioned through the ops every Edit tool
 * uses:
 *
 * - **Clips point at the original media** (no nesting): one video clip per
 *   range, with a linked audio half when the source has sound (D-129's pair,
 *   the same `linkedClipsFromDraggedMedia` a Sources drop builds). A range from
 *   a long timeline copies that clip's audio settings (volume, pan, EQ); its
 *   grade is carried by the caller (`gradePairs`), since grades are files.
 * - **Framing: centre crop, fill.** The scale that covers the frame
 *   ([`coverTransform`]), centred — Phase 3 replaces it with subject-aware
 *   reframing. The result says when that is an upscale beyond
 *   [`UPSCALE_WARN`] (FCP's caveat: a 1080p source holds 608x1080 natively).
 * - **Tightening** — the dead air and reviewed retakes inside each range —
 *   is `applyRippleDeleteRanges`, the Recut panel's Cut, on the built
 *   timeline: one reported list of results, nothing hidden.
 * - **Captions** come from the built timeline's own transcript
 *   (`captionsForTimeline`, D-411 Phase 0), so they follow every cut and
 *   tightened pause, styled by the run's choice (brand kit or preset) scaled
 *   for the frame ([`captionStyleForFrame`]).
 *
 * **What it does NOT do.** Any I/O: creating the timeline, writing it,
 * copying grades and hashing its content are the op layer's
 * (`clipperOps.ts`). It never judges: the ranges are the client's, checked.
 */
import { captionsForTimeline } from '../captionsFromTranscript';
import type { CaptionStyle } from '../caption';
import type { RecoveredWindow } from '../darkRegions';
import type { Transcript } from '../mediaUnderstandingStore';
import {
  applyOp,
  applyRippleDeleteRanges,
  DEFAULT_SYNC_LOCKED,
  DEFAULT_TRACK_GAIN,
  linkedClipsFromDraggedMedia,
  sourceFramesToTimeline,
  timelineFps,
  type Clip,
  type OutputSpec,
  type RippleDeleteRangeResult,
  type Timeline,
  type TimelineOrigin,
  type Track,
} from '../timeline';
import type { ClipperPiece, ClipperViewInput } from './clipperSource';
import type { Resolved } from './clipperTypes';

/** A crop that magnifies the source more than this is reported (FCP Smart
 *  Conform's quality caveat, D-411 §3.3). */
export const UPSCALE_WARN = 1.5;

/** The lowest a caption's last line may sit on a short, as a fraction of the
 *  frame height from the top: above the bottom fifth, where Reels, Shorts and
 *  TikTok draw their own buttons and captions (D-411 §4.3). */
export const SHORT_CAPTION_MAX_Y = 0.78;

/** What a build needs to know about one source file. */
export interface SourceMedia {
  mediaId: string;
  name: string;
  path: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  hasAudio: boolean;
}

/** The transform that makes a `src` frame COVER `out`, centred: the larger of
 *  the two axis ratios, so no edge of the frame is empty (D-136 units: scale
 *  1 is one source pixel per output pixel; position is the box's top-left as
 *  a fraction of the output). */
export function coverTransform(src: { width: number; height: number }, out: OutputSpec): { scale: number; position_x: number; position_y: number } {
  const scale = Math.max(out.width / src.width, out.height / src.height);
  const boxW = (src.width * scale) / out.width;
  const boxH = (src.height * scale) / out.height;
  return { scale, position_x: (1 - boxW) / 2, position_y: (1 - boxH) / 2 };
}

/** A caption preset's style laid out for a short's frame: the presets are
 *  sized as a fraction of a LANDSCAPE frame's height, so on a portrait frame
 *  the same type would be nearly twice as tall. Scaling by the short edge over
 *  the height keeps the type the size it is on a 1080p landscape frame; the
 *  last line is lifted out of the platforms' bottom band. */
export function captionStyleForFrame(style: Partial<CaptionStyle>, out: OutputSpec): CaptionStyle {
  const k = Math.min(out.width, out.height) / out.height;
  const next: CaptionStyle = { ...style };
  if (typeof style.size === 'number') next.size = style.size * k;
  if (typeof style.position_y === 'number') next.position_y = Math.min(style.position_y, SHORT_CAPTION_MAX_Y);
  else next.position_y = SHORT_CAPTION_MAX_Y;
  return next;
}

export interface BuildInput {
  /** The new (empty) timeline: its id, name and rate are kept. */
  base: Timeline;
  output: OutputSpec;
  view: Pick<ClipperViewInput, 'sources' | 'pieces'>;
  resolved: Resolved;
  /** Facts about the source file at a view source index. */
  mediaFor: (path: string) => SourceMedia | null;
  /** Play the hook range first (`settings.hook_first`). */
  hookFirst: boolean;
  /** `null` = no captions. */
  captionStyle: Partial<CaptionStyle> | null;
  transcripts: Readonly<Record<string, Transcript>>;
  recoveries: Readonly<Record<string, readonly RecoveredWindow[]>>;
  origin: TimelineOrigin;
}

export interface BuildResult {
  timeline: Timeline;
  /** Each tightening cut's outcome on the built timeline (B-197's shape). */
  tightened: RippleDeleteRangeResult[];
  /** Long-form clip id -> the short's clip playing it (grades to carry). */
  gradePairs: Array<{ from: string; to: string }>;
  captions: number;
  warnings: string[];
}

/** Build a short's body. Refused with a reason when a range's source is not
 *  a usable media file. */
export function buildShortBody(input: BuildInput): BuildResult | { error: string } {
  const fps = timelineFps(input.base);
  const ranges = input.resolved.ranges.filter((r) => input.hookFirst || r.role !== 'hook');
  const warnings: string[] = [];
  const facts: SourceMedia[] = [];
  for (const r of ranges) {
    const path = input.view.sources[r.source]?.path;
    const media = path ? input.mediaFor(path) : null;
    if (!media) return { error: `the source of a range (${path ?? `source ${r.source}`}) is not a probed media file in this project` };
    facts.push(media);
  }
  const hasPicture = facts.some((m) => m.width > 0 && m.height > 0);
  const hasSound = facts.some((m) => m.hasAudio);
  const video: Track = { kind: 'video', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED };
  const audio: Track = { kind: 'audio', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED };
  const gradePairs: Array<{ from: string; to: string }> = [];
  const placed: Array<{ clip: Clip; srcStart: number; rate: number; cuts: Resolved['ranges'][number]['cuts'] }> = [];
  const stem = input.base.id.slice(0, 8);
  let cursor = 0;
  let worstUpscale = 0;

  ranges.forEach((r, k) => {
    const m = facts[k];
    const rate = m.fps > 0 ? m.fps : fps;
    const srcStart = Math.max(0, Math.round(r.start_secs * rate));
    const srcEnd = Math.min(m.frameCount > 0 ? m.frameCount : Number.POSITIVE_INFINITY, Math.round(r.end_secs * rate));
    const length = srcEnd - srcStart;
    if (length <= 0) return;
    const pair = linkedClipsFromDraggedMedia(
      { id: m.mediaId, sourcePath: m.path, name: m.name, frameCount: m.frameCount, hasAudio: m.hasAudio && hasPicture, fps: m.fps },
      fps,
    );
    if (!pair) return;
    const piece: ClipperPiece | undefined = input.view.pieces[r.piece];
    const longClip = piece?.clip?.c;
    const id = `${stem}-c${k}`;
    const group = pair.audio ? `lg-${stem}-${k}` : null;
    const common = { source_start: srcStart, duration: length, start_frame: cursor, link_group: group };
    const sound = longClip
      ? {
          ...(longClip.volume !== undefined ? { volume: longClip.volume } : {}),
          ...(longClip.pan !== undefined ? { pan: longClip.pan } : {}),
          ...(longClip.eq_bands ? { eq_bands: longClip.eq_bands } : {}),
        }
      : {};
    if (hasPicture) {
      const v: Clip = { ...pair.video, ...common, id };
      if (m.width > 0 && m.height > 0) {
        const t = coverTransform({ width: m.width, height: m.height }, input.output);
        worstUpscale = Math.max(worstUpscale, t.scale);
        Object.assign(v, t);
      }
      if (!pair.audio) Object.assign(v, sound);
      video.clips.push(v);
      placed.push({ clip: v, srcStart, rate, cuts: r.cuts });
      if (longClip && longClip.id) gradePairs.push({ from: longClip.id, to: id });
      if (pair.audio) audio.clips.push({ ...pair.audio, ...common, id: `${id}-a`, ...sound });
    } else {
      const a: Clip = { ...pair.video, ...common, id, link_group: null, ...sound };
      audio.clips.push(a);
      placed.push({ clip: a, srcStart, rate, cuts: r.cuts });
    }
    cursor += sourceFramesToTimeline(placed[placed.length - 1].clip, length, fps);
  });

  if (placed.length === 0) return { error: 'every range of this proposal is empty after rounding to frames' };
  if (worstUpscale > UPSCALE_WARN) {
    warnings.push(
      `the ${input.output.width}x${input.output.height} crop magnifies the source ${worstUpscale.toFixed(2)}x (above ${UPSCALE_WARN}x); a higher-resolution source would be sharper`,
    );
  }
  if (!hasPicture) warnings.push('the source has no picture: the short is sound only (and has no captions — captions follow video clips)');

  const tracks: Track[] = [];
  if (hasPicture) tracks.push(video);
  if (audio.clips.length > 0) tracks.push(audio);
  let timeline: Timeline = { ...input.base, tracks, markers: [], output: { ...input.output }, origin: input.origin };

  // Tightening: every cut as timeline frames of the clip that plays it, then
  // the one ripple delete on the picture (or sound-only) track.
  const rippleTrack = 0;
  const ranges2 = placed.flatMap((p) =>
    p.cuts.map((c) => ({
      start: p.clip.start_frame + sourceFramesToTimeline(p.clip, Math.round(c.start_secs * p.rate) - p.srcStart, fps),
      end: p.clip.start_frame + sourceFramesToTimeline(p.clip, Math.round(c.end_secs * p.rate) - p.srcStart, fps),
    })),
  ).filter((x) => x.end > x.start);
  let tightened: RippleDeleteRangeResult[] = [];
  if (ranges2.length > 0) {
    const out = applyRippleDeleteRanges(timeline, rippleTrack, ranges2, fps);
    timeline = out.timeline;
    tightened = out.results;
    const refused = out.results.filter((x) => !x.applied);
    if (refused.length > 0) warnings.push(`${refused.length} tightening cut(s) could not be made: ${refused[0].reason ?? 'refused'}`);
  }

  let captions = 0;
  if (input.captionStyle && hasPicture) {
    const cues = captionsForTimeline(timeline, input.transcripts, input.recoveries);
    if (cues.length > 0) {
      timeline = applyOp(timeline, {
        kind: 'import_subtitles',
        cues,
        style: captionStyleForFrame(input.captionStyle, input.output),
      });
      captions = cues.length;
    } else {
      warnings.push('no captions: the short has no transcribed words');
    }
  }
  return { timeline, tightened, gradePairs, captions, warnings };
}
