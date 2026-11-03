/**
 * @apelles/editor — the Edit export's file formats (D-441, B-367).
 *
 * **What it is.** The one table of what the Edit export can write:
 *
 * - `h264` — H.264 in an `.mp4`, the delivery file (YouTube, Shorts, posts).
 * - `prores_hq` — Apple ProRes 422 HQ in a `.mov` with 24-bit PCM sound, the
 *   master (10-bit 4:2:2), the same profile the Colorist export already writes
 *   (`chroma::export`).
 *
 * The picture is compressed in process on Apple's VideoToolbox media engine
 * (D-452, `apelles_media::vt_encode`): H.264 at the quality D-446 measured
 * equal to libx264 CRF 18, ProRes 422 HQ fed BGRA. There is no encoder
 * choice: D-446's "Encoder: hardware | software" ran ffmpeg's libx264 /
 * `prores_ks` as the software arm, and the export no longer runs an ffmpeg
 * encoder at all (D-452 removed it, with the option).
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

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
}

/** The audio codec, for the remux that carries the sound. Empty for H.264 (the
 *  `.mp4` default, AAC); 24-bit PCM for the master. */
export function audioCodecArgs(format: ExportFormat): string[] {
  return format === 'prores_hq' ? ['-c:a', 'pcm_s24le'] : [];
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
