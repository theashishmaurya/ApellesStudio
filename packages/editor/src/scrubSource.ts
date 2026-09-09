/**
 * @apelles/editor — "what audio is under the playhead, and where in its own
 * source file" (D-232, roadmap item 27 — audio scrubbing + waveform toggle).
 *
 * What it is: the ONE pure resolver behind both halves of D-232 — the grain the
 * scrub engine reads (`scrubAudio.ts` → `chroma_audio_scrub_update`) and the
 * envelope the viewer's waveform strip draws (`ScrubWaveform.tsx` →
 * `chroma_audio_waveform`) — plus the window arithmetic that strip needs. Both
 * ask the same question and must never get different answers, which is why it
 * is one function in one file rather than two lookups written twice.
 *
 * What it does NOT do: any IPC, any React, any mixing. It resolves exactly one
 * source, where `chroma_audio_play` resolves and mixes all of them — see
 * `scrubSourceAt`'s own note for why that difference is deliberate.
 *
 * **Why this lives on the frontend at all**, when every other timeline→media
 * conversion is Rust's: a scrub update fires on every pointer move of a drag,
 * and the Rust path (`chroma::edit::resolve_video_position`) re-reads and clones
 * the whole active `Timeline` out of the project manifest per call. This side
 * already holds that `Timeline` in memory, and `clipAt` below is already the
 * pointwise mirror of `apelles_timeline::Track::clip_at` that every other Edit-tab
 * UI decision resolves through. The Rust command takes a bare source path plus
 * source seconds — exactly the shape `chroma_audio_waveform` has taken since
 * D-051, and for the same reason. See D-232.
 */

import {
  clipAt,
  isGeneratedClip,
  timelineFps,
  type Clip,
  type Timeline,
  type Track,
} from './timeline';

/** A resolved scrub/monitor source: a media file and a second inside it —
 *  mirrors `apelles_media::scrub::ScrubSource` field for field. */
export interface ScrubSource {
  /** the clip's own `source_path`, verbatim */
  path: string;
  /** where in that file the playhead currently is, in the file's own seconds */
  sourceSecs: number;
  /** the clip this came from — what `ScrubWaveform` bounds its window by, and
   *  what makes a re-resolve at the same path but a different clip visible. */
  clip: Clip;
  /** the track it lives on, for the same reason */
  track: number;
  /**
   * The linear level this source is heard at — `track.gain × clip.volume`,
   * the STATIC half of the chain `Clip.volume`'s own doc spells out
   * (`track.gain × clip.volume × fade × …`).
   *
   * **B-110.** Before this, a scrub carried no level at all: `gain` was read
   * only to *skip* a track muted to exactly zero, so every monitored source
   * played at unity while playback played it at whatever the mixer's `gain`
   * said. On the owner's own reel that is a music bed set to `0.4` monitored
   * 8 dB hot — the same clip, at a level the timeline does not have.
   *
   * Deliberately the static level only. A fade, a duck, a pan, an EQ band and
   * a KEYFRAMED `volume` are all envelope/DSP the scrub engine does not run
   * (see `apelles_media::scrub`'s module doc) — this is the one scalar that
   * makes "the same clip" mean "at the same loudness".
   */
  gain: number;
}

/** `track.gain × clip.volume`, both defaulting to unity — see
 *  {@link ScrubSource.gain}. Clamped at zero so a nonsense negative in a hand-
 *  edited manifest cannot phase-invert the monitor. */
function levelFor(track: Track, clip: Clip): number {
  const trackGain = track.gain ?? 1;
  const clipVolume = clip.volume ?? 1;
  return Math.max(0, trackGain * clipVolume);
}

/** A clip carries real, decodable audio only if it points at a real file: a
 *  text / adjustment / caption clip is generated, has no `source_path`, and
 *  must never be handed to the decoder. */
function hasMedia(c: Clip): boolean {
  return !!c.source_path && !isGeneratedClip(c);
}

/** Where inside its own source file this clip is at timeline `frame`, in that
 *  file's seconds. `sourceFrame` is already in the clip's own source-frame
 *  space (`clipAt` does that conversion, B-077), so this divides by the SOURCE's
 *  rate — `source_fps` when the clip records one (B-075/D-193), else the
 *  project's, which is the same fallback `timelineExport.ts` makes. */
function sourceSecsAt(c: Clip, sourceFrame: number, fps: number): number {
  const rate = c.source_fps && c.source_fps > 0 ? c.source_fps : fps;
  return rate > 0 ? sourceFrame / rate : 0;
}

/**
 * The one audio source to monitor at timeline `frame`, or `null` when there is
 * nothing audible there (a gap, a title, past the end) — an ordinary state that
 * must read as silence, not as an error.
 *
 * **Priority mirrors `chroma_audio_play`'s own resolution**, in the same
 * track-index order (lowest index wins — `Timeline::resolve_video_clip_at`'s
 * convention):
 *   1. a clip on a genuine audio track, skipping tracks muted to `gain: 0`;
 *   2. otherwise the topmost video clip's embedded audio — unless it carries a
 *      `link_group`, which since D-129 means its sound has been externalised
 *      into a linked audio clip and its embedded stream must not be played.
 *
 * **One source, not a mix** — the one real divergence from `chroma_audio_play`,
 * and a deliberate one. That command mixes every active source; a scrub would
 * have to re-anchor a separate decoder per source on every window crossing, N
 * times the stall, for a monitoring aid whose question is "what is at this
 * frame". D-232 records it, and it is a roadmap follow-up rather than a hidden
 * gap. The muted-track skip above exists *because* of it: with only one source
 * to pick, picking a track the user muted would make scrub audible where
 * playback is silent.
 */
export function scrubSourceAt(tl: Timeline | null, frame: number): ScrubSource | null {
  if (!tl || frame < 0) return null;
  const fps = timelineFps(tl);

  const audible = (tr: Track): boolean => (tr.gain ?? 1) > 0;

  for (let i = 0; i < tl.tracks.length; i++) {
    const tr = tl.tracks[i];
    if (tr.kind !== 'audio' || !audible(tr)) continue;
    const at = clipAt(tr, frame, fps);
    if (!at || !hasMedia(at.clip)) continue;
    return {
      path: at.clip.source_path,
      sourceSecs: sourceSecsAt(at.clip, at.sourceFrame, fps),
      clip: at.clip,
      track: i,
      gain: levelFor(tr, at.clip),
    };
  }

  for (let i = 0; i < tl.tracks.length; i++) {
    const tr = tl.tracks[i];
    if (tr.kind !== 'video') continue;
    const at = clipAt(tr, frame, fps);
    if (!at) continue;
    // D-129 — this clip's audio lives in a linked audio clip, which the walk
    // above already had its chance at. Unconditional, exactly as the Rust side
    // is: an L-cut that moved the audio half elsewhere means the picture really
    // is silent here.
    if (at.clip.link_group) return null;
    if (!hasMedia(at.clip)) return null;
    return {
      path: at.clip.source_path,
      sourceSecs: sourceSecsAt(at.clip, at.sourceFrame, fps),
      clip: at.clip,
      track: i,
      gain: levelFor(tr, at.clip),
    };
  }

  return null;
}

/**
 * How many seconds of source the viewer's waveform strip shows, total — the
 * playhead sits at its centre, so this is ±2 s.
 *
 * **Why a window and not the whole timeline** (the reading of
 * `scratch/resolve-reference/scrubbing.jpg` D-232 argues for): a full-duration
 * overview of a real edit is ~1 px per second, which shows you nothing you could
 * scrub *to*. Four seconds across a ~900 px viewer is ~225 px/s — fine enough to
 * see a word boundary or a transient and put the playhead on it, which is the
 * whole job of a waveform in a scrubbing context.
 */
export const WAVEFORM_WINDOW_SECS = 4;

/**
 * How the strip's peaks are actually FETCHED: in fixed, snapped tiles rather
 * than for the moving window itself.
 *
 * **This is the D-128 defect, avoided rather than rediscovered.** The window
 * above slides continuously with the playhead, so its `(start, duration)` pair
 * is different on every single frame — and `chroma_audio_waveform`'s Rust cache
 * is keyed on exactly that pair (rounded to whole ms). Requesting the window
 * directly would therefore miss the cache every frame and pay a full
 * `symphonia` decode per playhead move, which is precisely what D-128 found and
 * fixed for the timeline's own clip waveforms ("what is fetched no longer
 * depends on how it is drawn"). Fetching a snapped tile means the request
 * changes at most once per {@link WAVEFORM_TILE_SECS} of source traversed, and
 * everything between is index arithmetic on peaks already in hand.
 *
 * Three tiles wide, anchored one tile behind: any window of up to
 * `2 × WAVEFORM_TILE_SECS` centred anywhere inside the middle tile is fully
 * covered, in both directions, with no seam case to special-handle.
 */
export const WAVEFORM_TILE_SECS = 4;

/** Peak pairs requested per second of tile. At a ~900 px viewer drawing a 4 s
 *  window that is ~2.2 buckets per pixel — visually saturated, and well under
 *  the 128/s the Rust side caches, so a tile is a re-bucket of cached peaks
 *  rather than a decode (D-128). */
export const WAVEFORM_PEAKS_PER_SEC = 100;

/** One snapped peaks request — the arguments `chroma_audio_waveform` is called
 *  with, for a tile that fully contains the drawn window. */
export interface WaveformTile {
  startSecs: number;
  durationSecs: number;
  buckets: number;
}

/** The tile covering `sourceSecs`. Stable across every playhead position inside
 *  the same tile, which is the whole point — see {@link WAVEFORM_TILE_SECS}. */
export function waveformTileFor(sourceSecs: number): WaveformTile {
  const at = Number.isFinite(sourceSecs) ? Math.max(0, sourceSecs) : 0;
  const index = Math.floor(at / WAVEFORM_TILE_SECS);
  const startSecs = Math.max(0, (index - 1) * WAVEFORM_TILE_SECS);
  const endSecs = (index + 2) * WAVEFORM_TILE_SECS;
  const durationSecs = endSecs - startSecs;
  return {
    startSecs,
    durationSecs,
    buckets: Math.round(durationSecs * WAVEFORM_PEAKS_PER_SEC),
  };
}

/** One waveform strip's request: the source range to fetch peaks for, and where
 *  in the drawn strip the clip's own material actually starts and ends. */
export interface WaveformWindow {
  path: string;
  /** source second the strip's left edge corresponds to */
  startSecs: number;
  /** always {@link WAVEFORM_WINDOW_SECS} — the strip's width is a fixed span of
   *  time, so the playhead line never moves and the picture scrolls under it */
  durationSecs: number;
  /** where the playhead sits across the strip, `0..1` — always 0.5 except at
   *  the very head of a source, where the window is clamped forward */
  playheadFraction: number;
  /** `0..1` fractions of the strip covered by the CLIP's own trimmed extent;
   *  outside it the strip is drawn dim, because that source material is not on
   *  the timeline here. This is the reference image's brighter-region-inside-a-
   *  wider-strip, read literally. */
  clipStartFraction: number;
  clipEndFraction: number;
}

/**
 * The source range the strip should draw for a resolved scrub source.
 *
 * Clamped at the head of the file (a playhead 0.5 s into a source cannot show
 * 2 s of lead-in that does not exist) — which is the one case the playhead line
 * is not dead centre, and `playheadFraction` is how the drawing code knows.
 */
export function waveformWindowAt(
  source: ScrubSource,
  fps: number,
  windowSecs: number = WAVEFORM_WINDOW_SECS,
): WaveformWindow {
  const span = windowSecs > 0 ? windowSecs : WAVEFORM_WINDOW_SECS;
  const startSecs = Math.max(0, source.sourceSecs - span / 2);
  const fraction = (secs: number) => Math.min(1, Math.max(0, (secs - startSecs) / span));

  const rate = source.clip.source_fps && source.clip.source_fps > 0 ? source.clip.source_fps : fps;
  const clipStart = rate > 0 ? source.clip.source_start / rate : 0;
  const clipEnd = rate > 0 ? (source.clip.source_start + source.clip.duration) / rate : 0;

  return {
    path: source.path,
    startSecs,
    durationSecs: span,
    playheadFraction: fraction(source.sourceSecs),
    clipStartFraction: fraction(clipStart),
    clipEndFraction: fraction(clipEnd),
  };
}
