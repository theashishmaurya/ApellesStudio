/**
 * @apelles/editor — **what an export reads off the timeline before the
 * compositor draws it** (D-448).
 *
 * What it is: the options every export is compiled with
 * ([`TimelineExportOptions`]), the export's length
 * ([`exportTotalDurationSec`]), and the two pre-flight refusals for a title or
 * caption whose font this machine has no file for ([`textClipsMissingFonts`],
 * [`captionClipsMissingFonts`]). `editorExport.ts` calls them; the argv itself
 * is `timelinePipeExport.ts`.
 *
 * What it does NOT do: build a picture. There is one image engine for export,
 * the app's own compositor (`chroma::edit_render`), the same one the Edit
 * preview draws with. The ffmpeg filter-graph compiler that used to live in
 * `timelineExport.ts` was deleted by D-448 once a parity check on copies of
 * the owner's projects showed the compositor matching or beating it
 * (`docs/perf/2026-11-03-export-parity-report.md`).
 */
import type { Clip, Timeline } from './timeline';
import { endFrame, transitionWindow, transitionsOf } from './timeline';
import { resolveCaptionStyle } from './caption';
import { rampOutputSourceFrames, resolveSpeedSegments } from './speedRamp';
import type { ExportEncoder, ExportFormat } from './exportFormat';

export interface TimelineExportOptions {
  /** The export's frame rate. */
  fps: number;
  /** The output size, pixels. */
  width: number;
  height: number;
  /** D-197 — which clips' sources carry a decodeable audio stream, keyed by
   *  `Clip.id`, resolved by the caller from the media pool's probe. Absent for
   *  a clip: `false` on a video track (do not invent a stream ffmpeg would
   *  then fail to find), `true` on an audio track. */
  hasAudioOverrides?: Record<string, boolean>;
  /** B-101/D-269 — each clip's source audio channel count, from the same
   *  probe. Absent = unknown, which keeps the plain stereo upmix. */
  audioChannelsOverrides?: Record<string, number>;
  /** D-441 — the file format; `h264` when absent. */
  format?: ExportFormat;
  /** D-446 — the encoder; `software` when absent (only the panel's and
   *  `editor_export`'s compile default to hardware). */
  encoder?: ExportEncoder;
}

/** How many of a clip's own source frames it plays, after its speed ramp. */
function outputSourceFrames(clip: Clip): number {
  return rampOutputSourceFrames(resolveSpeedSegments(clip, undefined));
}

/**
 * The export's length in seconds: the end of the last thing that plays — a
 * visible video track's clip or transition window, or an audio clip. Hidden
 * video tracks do not count; audio tracks always do.
 */
export function exportTotalDurationSec(timeline: Timeline, opts: Pick<TimelineExportOptions, 'fps'>): number {
  let max = 0;
  const naturalEnd = (clip: Clip): number => {
    const clipFps = clip.source_fps ?? opts.fps;
    return clip.start_frame / opts.fps + outputSourceFrames(clip) / clipFps;
  };
  for (const track of timeline.tracks) {
    if (track.kind === 'video' && !track.hidden) {
      for (const clip of track.clips) max = Math.max(max, naturalEnd(clip));
      for (const t of transitionsOf(track)) {
        const { start, end } = transitionWindow(t);
        // A dangling transition (one side trimmed away) draws as a cut.
        const outgoing = track.clips.some((c) => endFrame(c, opts.fps) === t.at_frame);
        const incoming = track.clips.some((c) => c.start_frame === t.at_frame);
        if (end > start && outgoing && incoming) max = Math.max(max, end / opts.fps);
      }
    } else if (track.kind === 'audio') {
      for (const clip of track.clips) max = Math.max(max, naturalEnd(clip));
    }
  }
  return max;
}

/** D-211/D-212 — every title clip whose `TextLayer.font` key this machine has
 *  no file for. Checked before an export is queued, so a missing font is a
 *  named refusal rather than a title missing from the file. */
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

/** D-229/D-212 — the caption counterpart of [`textClipsMissingFonts`]: every
 *  caption on a visible subtitle track whose resolved font has no file. */
export function captionClipsMissingFonts(
  timeline: Timeline,
  fontFiles: Record<string, string> | undefined,
): Array<{ clipId: string; font: string }> {
  const missing: Array<{ clipId: string; font: string }> = [];
  for (const track of timeline.tracks) {
    if (track.kind !== 'subtitle' || track.hidden) continue;
    for (const clip of track.clips) {
      if (!clip.caption) continue;
      const font = resolveCaptionStyle(clip.caption.style, track.caption_style).font;
      if (!fontFiles?.[font]) missing.push({ clipId: clip.id, font });
    }
  }
  return missing;
}
