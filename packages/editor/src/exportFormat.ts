/**
 * @apelles/editor — the Edit export's file formats (D-441, B-367).
 *
 * **What it is.** The one table of what the Edit export can write and the
 * ffmpeg codec arguments each one means, used by both renderers' argv
 * compilers (`timelineExport.ts`'s filter graph and `timelinePipeExport.ts`'s
 * compositor pipe) so a format is spelled once:
 *
 * - `h264` — H.264 in an `.mp4`, the delivery file (YouTube, Shorts, posts).
 *   The compositor path writes `libx264 -crf 18 yuv420p`; the filter path keeps
 *   ffmpeg's own `.mp4` default, exactly as it did before formats existed, so
 *   an H.264 export's bytes do not change (its parity tests pin that).
 * - `prores_hq` — Apple ProRes 422 HQ in a `.mov` with 24-bit PCM sound, the
 *   master (`prores_ks -profile:v 3`, 10-bit 4:2:2), the same profile the
 *   Colorist export already writes (`chroma::export`).
 *
 * **What it does NOT do.** Choose sizes, rates or loudness (that is
 * `exportPresets.ts`), or run anything.
 */

export type ExportFormat = 'h264' | 'prores_hq';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['h264', 'prores_hq'];

export interface ExportFormatInfo {
  /** What the panel and the summary line call it. */
  label: string;
  /** The output file's extension, without the dot. */
  ext: string;
}

export const EXPORT_FORMAT_INFO: Record<ExportFormat, ExportFormatInfo> = {
  h264: { label: 'H.264 MP4', ext: 'mp4' },
  prores_hq: { label: 'ProRes 422 HQ', ext: 'mov' },
};

/** Typical video bitrate at 1920×1080, 30 fps, bits per second — the basis of
 *  the Export panel's "≈ size" (scaled by pixels × frame rate). H.264 at CRF 18
 *  lands around 14–15 Mb/s on talking-head footage; ProRes 422 HQ's published
 *  target rate at 1080p30 is 220 Mb/s (Apple's ProRes white paper). An
 *  estimate, shown with "≈", never a promise. */
const BASE_BITS_PER_SECOND: Record<ExportFormat, number> = {
  h264: 14_500_000,
  prores_hq: 220_000_000,
};
const BASE_PIXEL_RATE = 1920 * 1080 * 30;
/** AAC 192 kb/s for the delivery file; 24-bit 48 kHz stereo PCM for the master. */
const AUDIO_BITS_PER_SECOND: Record<ExportFormat, number> = {
  h264: 192_000,
  prores_hq: 2_304_000,
};

/** The Export panel's file-size estimate, in bytes. */
export function estimateExportBytes(format: ExportFormat, width: number, height: number, fps: number, seconds: number): number {
  if (!(width > 0 && height > 0 && fps > 0 && seconds > 0)) return 0;
  const video = BASE_BITS_PER_SECOND[format] * ((width * height * fps) / BASE_PIXEL_RATE);
  return Math.round(((video + AUDIO_BITS_PER_SECOND[format]) * seconds) / 8);
}

/** "≈ 840 MB" / "≈ 2.9 GB". */
export function fmtApproxSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `≈ ${(mb / 1000).toFixed(1)} GB`;
  return `≈ ${Math.max(1, Math.round(mb))} MB`;
}

/** The ProRes profile number for 422 HQ (`prores_ks`: 0 proxy … 3 HQ, 4 4444). */
export const PRORES_HQ_PROFILE = '3';

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
}

/** The video codec tail of the compositor path's encoders (single stream and
 *  each segment). Every segment is encoded with the same arguments, so the
 *  concat demuxer's "identical codec and parameters" precondition holds. */
export function pipeVideoCodecArgs(format: ExportFormat): string[] {
  if (format === 'prores_hq') return proresVideoArgs();
  return ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p'];
}

/** The video codec tail of the filter-graph path. Empty for H.264: that path
 *  has always left the codec to ffmpeg's `.mp4` default. */
export function filterVideoCodecArgs(format: ExportFormat): string[] {
  return format === 'prores_hq' ? proresVideoArgs() : [];
}

/** The audio codec, for whichever argv carries the sound. Empty for H.264 (the
 *  `.mp4` default, AAC); 24-bit PCM for the master. */
export function audioCodecArgs(format: ExportFormat): string[] {
  return format === 'prores_hq' ? ['-c:a', 'pcm_s24le'] : [];
}

function proresVideoArgs(): string[] {
  return ['-c:v', 'prores_ks', '-profile:v', PRORES_HQ_PROFILE, '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
}

/** The output path's extension, lower-cased, without the dot ('' when none). */
export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Refuse an output path whose container cannot hold `format`: a ProRes master
 *  is a `.mov` (the mp4 muxer does not take ProRes). H.264 keeps the long-
 *  standing contract — the container follows the path's extension. `null`
 *  when it fits. */
export function formatPathMismatch(format: ExportFormat, outPath: string): string | null {
  if (format !== 'prores_hq') return null;
  const ext = extensionOf(outPath);
  return ext === 'mov' ? null : `a ProRes 422 HQ master is written as a .mov file — this outPath ends in ".${ext}"`;
}
