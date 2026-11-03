/**
 * @apelles/editor — **the render-path export compiler** (D-350; the remux
 * only since D-452).
 *
 * What it is: the ffmpeg argv that turns the app's rendered picture into the
 * finished file — the concat demuxer over the video-only segments the app's
 * own GPU engine and VideoToolbox encoder wrote (`chroma::edit_render`), plus
 * the whole timeline's **audio mix**, `-c:v copy`, the output. And the typed
 * plan that tells the renderer what to draw: size, frame count, rate, format
 * and the document itself.
 *
 * What it does NOT do, and this is the whole point: compile a picture. No
 * video filter graph, no video encoder. The picture is drawn by the one GPU
 * render engine the Edit preview uses (D-449) and compressed in process
 * (D-452); a second, hand-synchronised implementation of compositing maths in
 * ffmpeg filters was the named cause of the preview-vs-export parity-bug
 * lineage (B-201/B-208/B-218/B-223) and of B-228/B-229/B-230's resource
 * blowups.
 *
 * What it DOES compile: the **audio mix**, reusing `timelineExportAudio.ts`'s
 * per-source construction (D-197) completely unchanged — gain, fades,
 * ducking, EQ, speed ramps, the `amix normalize=0` + `asoftclip=tanh`
 * topology. Each video clip's embedded audio gets its own `-i` at exactly the
 * clip's own `[source_start, +duration)` window
 * (`docs/notes/export-gpu-compositor.md` §4).
 *
 * The export-time Clip exceptions (`speedOverrides` / `fitOverrides` /
 * `freezeOverrides`) never reach this compiler: `clipExceptions.ts` writes them
 * into the timeline it is handed as ordinary clip data (D-448), and the
 * compositor draws that same document.
 */
import type { Clip, Timeline } from './timeline';
import { resolveSpeedSegments } from './speedRamp';
import type { TimelineExportOptions } from './exportTimeline';
import { audioCodecArgs, type ExportFormat } from './exportFormat';
import {
  audioRefBracket,
  audioRefMapArg,
  buildAudioSourceChain,
  resolveDuckForTrack,
  type AudioRef,
} from './timelineExportAudio';

/** The concat list's input index in the remux argv — always 0, since it is
 *  always the first `-i`. Audio inputs therefore start at 1. */
const MUX_VIDEO_INPUT_IDX = 0;

/** One clip's own trim window as an `-ss`/`-t` input pair, in OUTPUT seconds at
 *  the clip's own native rate (B-075: `source_start`/`duration` are SOURCE
 *  frames, `start_frame` is a timeline frame). */
function clipInputArgs(clip: Clip, clipFps: number): string[] {
  return [
    '-ss',
    String(clip.source_start / clipFps),
    '-t',
    String(clip.duration / clipFps),
    '-i',
    clip.source_path,
  ];
}

/** Everything the audio half of a pipe export compiles to. */
interface AudioGraph {
  /** `-ss`/`-t`/`-i` triples, in argv order, starting at input index 1. */
  inputs: string[];
  /** `-filter_complex` steps, `;`-joined by the caller. */
  filterSteps: string[];
  /** What to `-map` for sound, or `null` for a timeline with none. */
  mapArg: string | null;
}

/**
 * The audio mix for `timeline`, with every source opening its own input.
 *
 * Walks exactly the sources `buildExportFfmpegArgs`' own audio pass does, in
 * the same order, with the same inclusion rules — a video-track clip's embedded
 * audio (unless A/V-linked per D-129, or `hasAudioOverrides` says its source has
 * none, or it is a text/adjustment clip with no media), then every non-muted
 * audio track's clips (B-228: `gain === 0` contributes provably nothing and is
 * skipped outright) — and hands each to the same
 * `buildAudioSourceChain`/`resolveDuckForTrack` this repo already trusts.
 */
function buildPipeAudioGraph(timeline: Timeline, opts: TimelineExportOptions): AudioGraph {
  const inputs: string[] = [];
  const filterSteps: string[] = [];
  const audioRefs: AudioRef[] = [];
  let inputIdx = MUX_VIDEO_INPUT_IDX + 1;
  let labelSeq = 0;

  const duckCache = new Map<number, ReturnType<typeof resolveDuckForTrack>>();
  const duckForTrack = (idx: number) => {
    if (!duckCache.has(idx)) duckCache.set(idx, resolveDuckForTrack(timeline, idx, opts.fps));
    return duckCache.get(idx) ?? null;
  };

  const addSource = (clip: Clip, trackIndex: number, gain: number) => {
    const clipFps = clip.source_fps ?? opts.fps;
    inputs.push(...clipInputArgs(clip, clipFps));
    const thisInputIdx = inputIdx++;
    const { steps, ref } = buildAudioSourceChain({
      srcRef: `[${thisInputIdx}:a]`,
      clip,
      clipFps,
      gain,
      // The clip's own ramp (D-236), which is also where an export-time speed
      // override lives by now (D-448, `clipExceptions.ts`) — exactly what the
      // picture is retimed by.
      speedSegments: resolveSpeedSegments(clip, undefined),
      startSec: clip.start_frame / opts.fps,
      duck: duckForTrack(trackIndex),
      idLabel: `au${labelSeq++}`,
      sourceChannels: opts.audioChannelsOverrides?.[clip.id],
    });
    filterSteps.push(...steps);
    audioRefs.push(ref);
  };

  // Embedded video-clip audio. Walked in `tracks` order rather than the picture
  // path's reverse paint order — the mix is a sum, so source order is
  // unobservable in the output, and this is the order the audio-track walk
  // below already uses.
  timeline.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'video' || track.hidden) return;
    for (const clip of track.clips) {
      if (clip.text || clip.adjustment) continue; // generated layers: no media
      if (clip.link_group) continue; // D-129: externalised to a linked audio clip
      if (!(opts.hasAudioOverrides?.[clip.id] ?? false)) continue;
      // D-057 — a video track's own embedded audio is at unity, as in the
      // ffmpeg path and in the live mixer.
      addSource(clip, trackIndex, 1);
    }
  });

  // Genuine audio tracks. NOT filtered by `track.hidden` — `hidden` is a
  // picture-only concept, matching `resolve_audio_track_positions`.
  timeline.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'audio') return;
    if ((track.gain ?? 1) === 0) return; // B-228
    for (const clip of track.clips) {
      if (!(opts.hasAudioOverrides?.[clip.id] ?? true)) continue;
      addSource(clip, trackIndex, track.gain ?? 1);
    }
  });

  if (audioRefs.length === 0) return { inputs, filterSteps, mapArg: null };
  if (audioRefs.length === 1) {
    return { inputs, filterSteps, mapArg: audioRefMapArg(audioRefs[0]) };
  }
  const mixInputs = audioRefs.map(audioRefBracket).join('');
  filterSteps.push(`${mixInputs}amix=inputs=${audioRefs.length}:duration=longest:normalize=0[mixa]`);
  filterSteps.push(`[mixa]asoftclip=type=tanh[outa]`);
  return { inputs, filterSteps, mapArg: '[outa]' };
}

/** D-360 — the placeholder the Rust side replaces with the concat list of
 *  the rendered segments. A whole-argument token, substituted exactly once;
 *  its Rust twin is `CONCAT_LIST_TOKEN` in `chroma::edit_render`.
 *
 *  A placeholder rather than the real path because the renderer is the only
 *  side that knows where its temporary directory is — and a token is the
 *  smallest hole to leave in "the caller compiles the whole argv", which is
 *  D-350's split and is what keeps the mapping and the audio graph compiled in
 *  exactly one place. */
export const CONCAT_LIST_TOKEN = '{{APELLES_CONCAT_LIST}}';

/**
 * What `chroma_render_timeline_export` needs beyond the argv: what to draw and
 * how to compress it (D-452: the encoder is in process, so these are typed).
 *
 * One exported type rather than the same inline object literal in
 * `editorExport.ts`'s compile result, its `runCompiledExport` parameter and
 * `exportQueueStore`'s frozen job: they are three views of one payload.
 *
 * Mirrors `chroma::edit_render::TimelineRenderRequest` minus `args`.
 */
export interface TimelineRenderPlan {
  width: number;
  height: number;
  frames: number;
  /** The export's frame rate (the encoder's clock; the Rust side snaps an
   *  NTSC rate to n·1000/1001). */
  fps: number;
  /** D-441 — what the picture is compressed as. */
  format: ExportFormat;
  /** D-448 — the document the compositor draws: the timeline this plan's sound
   *  was compiled from, Clip exceptions applied. Frozen into a queued job with
   *  the argv, so the picture and the sound come from one copy. */
  timeline?: Timeline;
}

export interface PipeExportPlan {
  /** The remux argv: the rendered segments' concat list (as
   *  {@link CONCAT_LIST_TOKEN}), the audio mix, `-c:v copy`, the output. */
  args: string[];
  /** How many frames the renderer draws. */
  frames: number;
  width: number;
  height: number;
}

/**
 * Compile `timeline` into the render path's plan: the remux argv, and the
 * frame count the renderer must draw.
 *
 * `frames` is `round(totalDurationSec * fps)` over the same duration the remux
 * puts in its `-t`, so the picture's length and the file's cannot disagree.
 */
export function buildPipeExportPlan(
  timeline: Timeline,
  outPath: string,
  opts: TimelineExportOptions,
  totalDurationSec: number,
): PipeExportPlan {
  const audio = buildPipeAudioGraph(timeline, opts);
  return {
    args: buildMuxArgs(audio, outPath, opts, totalDurationSec),
    frames: Math.max(0, Math.round(totalDurationSec * opts.fps)),
    width: opts.width,
    height: opts.height,
  };
}

/**
 * D-360/D-452 — stitch the segments and mux the sound.
 *
 * The concat demuxer is input 0, exactly where the pipe was, so **every audio
 * input keeps the index `buildPipeAudioGraph` already gave it** and the audio
 * graph is reused verbatim rather than recompiled for this step. That is the
 * whole reason the concat list is the first input and not the last.
 *
 * `-t` is kept, and kept identical to the single-stream argv's, for the same
 * reason it exists there: the audio must not run the output past the picture.
 * Keeping it the same expression is also what makes the two paths agree about
 * an export's length rather than agreeing by coincidence.
 */
function buildMuxArgs(
  audio: AudioGraph,
  outPath: string,
  opts: TimelineExportOptions,
  totalDurationSec: number,
): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'concat',
    // The list holds absolute paths into the renderer's own temporary
    // directory, which `-safe 1` (the default) refuses outright.
    '-safe',
    '0',
    '-i',
    CONCAT_LIST_TOKEN,
    ...audio.inputs,
  ];
  if (audio.filterSteps.length > 0) {
    args.push('-filter_complex_threads', '2', '-filter_complex', audio.filterSteps.join(';'));
  }
  args.push('-map', `${MUX_VIDEO_INPUT_IDX}:v`);
  if (audio.mapArg) args.push('-map', audio.mapArg, ...audioCodecArgs(opts.format ?? 'h264'));
  args.push('-c:v', 'copy');
  args.push('-t', String(totalDurationSec), outPath);
  return args;
}
