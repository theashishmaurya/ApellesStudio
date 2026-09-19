/**
 * @apelles/editor — **the D-350 render-path export compiler.**
 *
 * What it is: the ffmpeg argv for an export whose PICTURE arrives as one raw
 * RGBA stream on stdin — composited by the app's own live-preview compositor
 * (`app/src-tauri/src/chroma/edit_render.rs`, which spawns this argv and writes
 * the frames) instead of by an ffmpeg `-filter_complex` graph.
 *
 * What it does NOT do, and this is the whole point: it emits **no video filter
 * graph at all**. No `overlay`, no per-clip `crop`/`scale`/`setpts`, no `geq`
 * corner mask, no `drawtext`, no `lut3d`. Every one of those is a second,
 * hand-synchronised implementation of compositing maths the Rust compositor
 * already owns — the named cause of this project's whole preview-vs-export
 * parity-bug lineage (B-201/B-208/B-218/B-223) and, via the per-clip `-i` and
 * per-filter-instance thread pools they imply, of B-228/B-229/B-230's measured
 * resource blowups. Here the encoder has exactly ONE video input, a pipe,
 * whatever the clip count.
 *
 * What it DOES still compile: the **audio mix**, reusing
 * `timelineExportAudio.ts`'s per-source construction (D-197) completely
 * unchanged — gain, fades, ducking, EQ, speed ramps, the `amix normalize=0` +
 * `asoftclip=tanh` topology. D-350 explicitly scoped audio out: it already
 * works, is well tested, and was never part of the resource pathology.
 *
 * **The one structural difference from `timelineExport.ts`'s audio walk.** There,
 * a video clip's embedded audio rides the `-i` that clip's PICTURE already
 * opened, and a transition has widened that input into its handle media, so the
 * audio is `atrim`med back to the clip's own window afterwards. Here the picture
 * opens no inputs at all, so embedded audio gets its own `-i` at exactly the
 * clip's own `[source_start, +duration)` window — which is the same audio, by a
 * shorter route, with no `atrim` needed. `docs/notes/export-gpu-compositor.md` §4.
 *
 * Phase 1 deliberately refuses `speedOverrides` / `freezeOverrides` /
 * `fitOverrides`: those are export-time-only knobs the live preview's compositor
 * has no notion of, so honouring them in the sound while the picture ignored
 * them would desync the two. See `pipeExportUnsupported`.
 */
import type { Clip, Timeline } from './timeline';
import { resolveSpeedSegments } from './speedRamp';
import type { TimelineExportOptions } from './timelineExport';
import {
  audioRefBracket,
  audioRefMapArg,
  buildAudioSourceChain,
  resolveDuckForTrack,
  type AudioRef,
} from './timelineExportAudio';

/** The raw-video input the compositor's frames arrive on. Its Rust twin is
 *  `chroma::edit_render::pipe_input_args`; `timelinePipeExport.test.ts` and
 *  `edit_render.rs`'s own `pipe_input_args_declare_rgba_at_the_render_size`
 *  are the cross-engine pair that keeps them agreeing, the same pattern
 *  D-338/B-201 established for placement.
 *
 *  `rgba`, not `rgb24`: the compositor's canvas IS an `image::RgbaImage`, so
 *  this is the one pixel format it can hand over with no conversion pass at
 *  all. The 33% extra pipe traffic is a memcpy through a kernel buffer; a
 *  per-frame full-buffer RGBA→RGB conversion is a pass over every pixel in
 *  userspace. Measured in `docs/notes/export-gpu-compositor.md` §6. */
export function pipeVideoInputArgs(width: number, height: number, fps: number): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgba',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    String(fps),
    '-i',
    '-',
  ];
}

/** The video input's index in the compiled argv — always 0, since the pipe is
 *  always the first `-i`. Audio inputs therefore start at 1. */
const PIPE_VIDEO_INPUT_IDX = 0;

/**
 * Which of this export's requested options the D-350 path cannot honour yet, by
 * name — empty for a timeline it can render exactly.
 *
 * Each of these changes a clip's on-timeline FOOTPRINT or framing at export
 * time only. The compositor renders the document as the Edit tab shows it, so
 * an option the preview has never heard of would move the sound (compiled here)
 * relative to the picture (compiled there). Refusing is the only honest answer
 * until the model itself carries them; `docs/04-roadmap.md`'s D-350 phase-2
 * line tracks it.
 *
 * A clip's OWN persisted speed ramp (D-236) is NOT in this list: the preview
 * resolves it (`Clip::source_frame_at`), so both halves already agree about it.
 */
export function pipeExportUnsupported(opts: TimelineExportOptions): string[] {
  const named: string[] = [];
  if (opts.speedOverrides && Object.keys(opts.speedOverrides).length > 0) named.push('speedOverrides');
  if (opts.freezeOverrides && Object.values(opts.freezeOverrides).some(Boolean)) named.push('freezeOverrides');
  if (opts.fitOverrides && Object.keys(opts.fitOverrides).length > 0) named.push('fitOverrides');
  return named;
}

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
  let inputIdx = PIPE_VIDEO_INPUT_IDX + 1;
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
      // No `speedOverrides` — `pipeExportUnsupported` has already refused any
      // export carrying one, so this is the clip's own persisted ramp (D-236)
      // or nothing, which is exactly what the picture is retimed by.
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

/** The output codec tail. h.264/`yuv420p` — the same default
 *  `chroma::export`'s single-clip renderer uses, and the same one the old
 *  filter-graph path got from ffmpeg's own extension-driven default for `.mp4`. */
function videoCodecArgs(): string[] {
  return ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p'];
}

/** D-360 — the placeholder the Rust side replaces with a segment's own output
 *  file, and the one it replaces with the concat list. Whole-argument tokens,
 *  substituted exactly once each; their Rust twins are `SEGMENT_OUT_TOKEN` /
 *  `CONCAT_LIST_TOKEN` in `chroma::edit_render`.
 *
 *  A placeholder rather than the real path because the renderer is the only
 *  side that knows where its temporary directory is — and a token is the
 *  smallest hole to leave in "the caller compiles the whole argv", which is
 *  D-350's split and is what keeps the encode settings, the mapping and the
 *  audio graph compiled in exactly one place. */
export const SEGMENT_OUT_TOKEN = '{{APELLES_SEGMENT_OUT}}';
export const CONCAT_LIST_TOKEN = '{{APELLES_CONCAT_LIST}}';

/** D-360 — the two extra argvs a contiguous-segment render needs. */
export interface PipeExportSegments {
  /** One segment's own encode: the raw-video input, and a VIDEO-ONLY output.
   *  No audio, and no `-t`: a segment's length is however many frames the
   *  compositor writes before closing the pipe. */
  segmentArgs: string[];
  /** The concat demuxer over the finished segments, plus the whole timeline's
   *  audio mix. Video is `-c:v copy`: every segment came out of the same
   *  encoder with the same settings at the same size, so the concat demuxer's
   *  own precondition holds and re-encoding the picture a second time would
   *  cost a full generation of quality for nothing. */
  concatArgs: string[];
}

/**
 * What `chroma_render_timeline_export` needs beyond the argv — the typed
 * restatement of the geometry that argv declares, plus D-360's segment argvs.
 *
 * One exported type rather than the same inline object literal in
 * `editorExport.ts`'s compile result, its `runCompiledExport` parameter and
 * `exportQueueStore`'s frozen job: they are three views of one payload, and
 * D-360 adding a field to three hand-copied shapes is exactly how the fourth
 * one gets missed.
 *
 * Mirrors `chroma::edit_render::TimelineRenderRequest` minus `args`.
 */
export interface TimelineRenderPlan {
  width: number;
  height: number;
  frames: number;
  /** D-360. Absent on a job frozen before D-360 existed, which then renders
   *  as a single stream exactly as it was queued to. */
  segments?: PipeExportSegments;
}

export interface PipeExportPlan {
  /** The complete ffmpeg argv — `chroma_render_timeline_export` spawns it. */
  args: string[];
  /** How many frames the compositor must write into the pipe. */
  frames: number;
  width: number;
  height: number;
  /** D-360. Always compiled; whether it is USED is the renderer's call, since
   *  only it knows the core count — see `plan_segment_count`. */
  segments: PipeExportSegments;
}

/**
 * Compile `timeline` into the D-350 render path's plan: the ffmpeg argv, and
 * the frame count the compositor must feed it.
 *
 * `frames` is `round(totalDurationSec * fps)` over the same duration the old
 * path puts in its output `-t` — imported from `timelineExport.ts` rather than
 * recomputed, so the two paths cannot disagree about an export's length.
 */
export function buildPipeExportPlan(
  timeline: Timeline,
  outPath: string,
  opts: TimelineExportOptions,
  totalDurationSec: number,
): PipeExportPlan {
  const audio = buildPipeAudioGraph(timeline, opts);
  const args = [
    ...pipeVideoInputArgs(opts.width, opts.height, opts.fps),
    ...audio.inputs,
  ];
  if (audio.filterSteps.length > 0) {
    // B-229's cap is kept even though this graph is now audio-only and tiny:
    // the flag costs nothing, and an audio graph on a heavily-cut project can
    // still carry a few hundred filter instances.
    args.push('-filter_complex_threads', '2', '-filter_complex', audio.filterSteps.join(';'));
  }
  args.push('-map', `${PIPE_VIDEO_INPUT_IDX}:v`);
  if (audio.mapArg) args.push('-map', audio.mapArg);
  args.push(...videoCodecArgs());
  // `-r`/`-t` for the same reason the old path carries them: the pipe is a raw
  // stream with no container timing of its own, and the audio inputs must not
  // be allowed to run the output past the picture.
  args.push('-r', String(opts.fps), '-t', String(totalDurationSec), outPath);
  return {
    args,
    frames: Math.max(0, Math.round(totalDurationSec * opts.fps)),
    width: opts.width,
    height: opts.height,
    segments: {
      segmentArgs: buildSegmentArgs(opts),
      concatArgs: buildConcatArgs(audio, outPath, opts, totalDurationSec),
    },
  };
}

/**
 * D-360 — one segment's encode.
 *
 * The same raw-video input and the same codec tail as the single-stream argv,
 * so every segment is byte-comparable with every other and the concat
 * demuxer's "identical codec and parameters" precondition holds by
 * construction rather than by inspection.
 *
 * **What it deliberately does NOT carry**, and both matter:
 * - **no audio.** The mix is compiled for the whole timeline — `amix`, the
 *   ducking envelopes, `asoftclip` — and has no notion of a frame range to be
 *   cut at. It is muxed once, at the concat step, over the finished picture.
 * - **no `-t`.** The single-stream argv bounds its output by duration because
 *   its audio inputs would otherwise run past the picture. A segment has no
 *   audio, and its length is exactly the frames the compositor writes before
 *   closing the pipe — a duration bound here could only disagree with that.
 */
function buildSegmentArgs(opts: TimelineExportOptions): string[] {
  return [
    ...pipeVideoInputArgs(opts.width, opts.height, opts.fps),
    '-map',
    `${PIPE_VIDEO_INPUT_IDX}:v`,
    ...videoCodecArgs(),
    '-r',
    String(opts.fps),
    SEGMENT_OUT_TOKEN,
  ];
}

/**
 * D-360 — stitch the segments and mux the sound.
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
function buildConcatArgs(
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
  args.push('-map', `${PIPE_VIDEO_INPUT_IDX}:v`);
  if (audio.mapArg) args.push('-map', audio.mapArg);
  args.push('-c:v', 'copy');
  args.push('-t', String(totalDurationSec), outPath);
  return args;
}
