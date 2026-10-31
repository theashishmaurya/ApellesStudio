/**
 * @apelles/editor — the clip block's anatomy (D-432 P2, `docs/notes/ui-redesign.md` §4.3).
 *
 * What it is: the pure layout rules of one clip on the Edit timeline, in the
 * Final Cut Pro arrangement the owner picked — a thin NAME STRIP across the
 * top, the FILMSTRIP under it, and the clip's own audio as a WAVEFORM BAND
 * inside the same block — as a function of the track height, plus the width
 * thresholds below which the label, the badges and the cut hairline drop out.
 *
 * What it does NOT do: render anything, know about React, or decide colours
 * (those are the opaque `--color-clip-*` tokens, `clipKindOf` below only names
 * which family a clip draws from). The heights are view geometry, not
 * document data.
 *
 * Numbers (spec §4.3, with Palmier Pro's real thresholds for the widths):
 * - clip height = track height − 2 (1 px inset top and bottom);
 * - strip 14 px below a 76 px track, 16 px from 76 up;
 * - band = round((H − strip) × ratio) from the default 52 px track up, none
 *   below it; ratio 0.3 by default (the FCP Clip Appearance popover's knob);
 * - below 26 px the clip is "labels only": the name sits in the body, no bands;
 * - label at width ≥ 28 px, badges at ≥ 120 px, the cut hairline at ≥ 8 px.
 */

import type { Clip, Track } from './timeline';

/** The default track height (spec "M"), the timeline's row height today. */
export const CLIP_TRACK_HEIGHT_M = 52;
/** At and above this track height the strip is 16 px and its label 11 px. */
export const CLIP_STRIP_TALL_FROM = 76;
export const CLIP_STRIP_PX = 14;
export const CLIP_STRIP_TALL_PX = 16;
/** Below this track height the clip shows only a label (FCP's labels-only mode). */
export const CLIP_LABELS_ONLY_BELOW = 26;
/** The default share of the area under the strip given to the waveform band. */
export const CLIP_BAND_RATIO = 0.3;
/** 1 px inset at the top and the bottom of every clip inside its lane. */
export const CLIP_VERTICAL_INSET_PX = 1;
/** Width thresholds (px): a label, the strip badges, the left-edge cut hairline. */
export const CLIP_LABEL_MIN_WIDTH = 28;
export const CLIP_BADGES_MIN_WIDTH = 120;
export const CLIP_HAIRLINE_MIN_WIDTH = 8;

/** Which colour family and anatomy a clip draws from. */
export type ClipKind = 'video' | 'audio' | 'text' | 'caption' | 'adjustment';

export function clipKindOf(clip: Pick<Clip, 'text' | 'caption' | 'adjustment'>, trackKind: Track['kind']): ClipKind {
  if (clip.text) return 'text';
  if (clip.caption) return 'caption';
  if (clip.adjustment) return 'adjustment';
  return trackKind === 'audio' ? 'audio' : 'video';
}

export interface ClipAnatomy {
  /** the clip's own height inside its lane */
  height: number;
  /** the name strip's height; equal to `height` in labels-only mode */
  strip: number;
  /** the filmstrip band (video) — 0 for every other kind */
  film: number;
  /** the video's own waveform band — 0 for every other kind and below M */
  band: number;
  /** the waveform area under the strip of an audio clip — 0 for other kinds */
  wave: number;
  /** the label font: `2xs` (10 px) on a 14 px strip, `xs` (11 px) on a 16 px one */
  labelSize: '2xs' | 'xs';
  /** below `CLIP_LABELS_ONLY_BELOW`: name in the body, no bands */
  labelsOnly: boolean;
}

/** The vertical split of one clip of `kind` on a track `trackHeight` px tall. */
export function clipAnatomy(trackHeight: number, kind: ClipKind, bandRatio: number = CLIP_BAND_RATIO): ClipAnatomy {
  const height = Math.max(0, trackHeight - 2 * CLIP_VERTICAL_INSET_PX);
  const tall = trackHeight >= CLIP_STRIP_TALL_FROM;
  const labelSize = tall ? 'xs' : '2xs';
  if (trackHeight < CLIP_LABELS_ONLY_BELOW) {
    return { height, strip: height, film: 0, band: 0, wave: 0, labelSize, labelsOnly: true };
  }
  const strip = tall ? CLIP_STRIP_TALL_PX : CLIP_STRIP_PX;
  const below = Math.max(0, height - strip);
  if (kind === 'video') {
    const ratio = Math.min(1, Math.max(0, bandRatio));
    const band = trackHeight >= CLIP_TRACK_HEIGHT_M ? Math.round(below * ratio) : 0;
    return { height, strip, film: below - band, band, wave: 0, labelSize, labelsOnly: false };
  }
  if (kind === 'audio') return { height, strip, film: 0, band: 0, wave: below, labelSize, labelsOnly: false };
  // Titles, captions and adjustment clips have no picture and no sound: the
  // strip names them and the body below is their flat kind colour.
  return { height, strip, film: 0, band: 0, wave: 0, labelSize, labelsOnly: false };
}

/** What a clip `widthPx` wide has room to show. */
export function clipChrome(widthPx: number): { label: boolean; badges: boolean; hairline: boolean } {
  return {
    label: widthPx >= CLIP_LABEL_MIN_WIDTH,
    badges: widthPx >= CLIP_BADGES_MIN_WIDTH,
    hairline: widthPx >= CLIP_HAIRLINE_MIN_WIDTH,
  };
}

/** How the cut at a clip's LEFT edge is drawn: no cut (nothing butts against
 *  it), a plain hairline, or FCP's dashed through-edit hairline — the two
 *  sides come from the same source with a contiguous source range, which is
 *  exactly what a split produces. `prev` is the clip that ends where `clip`
 *  starts on the same track, if any. */
export function cutStyleAt(
  clip: Pick<Clip, 'source_path' | 'source_start' | 'source_fps'>,
  prev: Pick<Clip, 'source_path' | 'source_start' | 'duration' | 'source_fps'> | null,
): 'none' | 'cut' | 'through' {
  if (!prev) return 'none';
  const through =
    !!clip.source_path &&
    prev.source_path === clip.source_path &&
    (prev.source_fps ?? null) === (clip.source_fps ?? null) &&
    prev.source_start + prev.duration === clip.source_start;
  return through ? 'through' : 'cut';
}
