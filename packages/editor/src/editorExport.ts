/**
 * @apelles/editor — the real `editor_export` compiler+runner (D-198,
 * `docs/notes/export-dialog-queue.md`), extracted out of `useEditorControl
 * .ts`'s `OPS` map so the SAME logic backs both the MCP/control-bridge
 * `editor_export` op AND the Edit tab's own GUI Export dialog + queue
 * (`EditorExportDialog.tsx`, `exportQueueStore.ts`) — one implementation,
 * two callers, per this repo's own "wire the GUI through the same op, not a
 * parallel implementation" rule.
 *
 * Split into two functions on purpose:
 * - [`compileEditorExportArgs`] does validation + `buildExportFfmpegArgs`
 *   compilation ONLY — no I/O. This is what the export QUEUE calls at
 *   ENQUEUE time, so a job's compiled ffmpeg argv is a real snapshot of the
 *   timeline at the moment it was queued, not silently re-derived (and
 *   potentially different) at the moment it actually runs, possibly
 *   minutes later and after further edits.
 * - [`runEditorExport`] is `compileEditorExportArgs` + the actual
 *   `chroma_run_ffmpeg` invocation in one blocking call — what the MCP op
 *   needs (a single call that both compiles AND runs, then reports the
 *   outcome). [`runCompiledExport`] is the same invocation alone, for the
 *   queue's own runner, which already has a job's frozen `args`.
 */
import { invoke } from '@tauri-apps/api/core';
import { useMediaPoolStore } from '@apelles/bridge';

import { useEditorTimelineStore } from './timelineStore';
import { timelineFps, transitionClipIndices, type Timeline } from './timeline';
import {
  buildExportFfmpegArgs,
  captionClipsMissingFonts,
  captionClipsMissingMetrics,
  captionsForExport,
  textClipsMissingFonts,
  type TimelineExportOptions,
} from './timelineExport';
import { loadTextFonts, textFontPaths } from './textFonts';
// D-243 — the per-word advances an animated caption is laid out from.
import { captionMetricsSnapshot, warmCaptionMetrics } from './captionMetrics';
import { captionLayout, captionLines } from './caption';
import { captionAnimationOf, isPerWordAnim, isSingleWordAnim } from './captionAnim';
// D-236 — a clip's own persisted speed ramp, which clashes with a transition
// for exactly the reason an export-time flat override does.
import { hasSpeedRamp } from './speedRamp';
// D-256 — each graded clip's baked Colorist grade, as a `.cube` for `lut3d`.
import { gradeLutPathsSnapshot, gradeLutsAreWarm, warmGradeLuts } from './gradeLuts';

/** Mirrors `app/src-tauri/src/chroma/ffmpeg_run.rs`'s `FfmpegRunOutcome` —
 *  copied by hand, same reason `useEditorControl.ts`'s own copy already
 *  gives (no shared types package between this package and the Rust crate). */
interface FfmpegRunOutcome {
  ok: boolean;
  stdout_tail: string;
  stderr_tail: string;
}

export interface CompiledExport {
  ok: true;
  outPath: string;
  args: string[];
}

export interface CompileError {
  error: string;
}

/**
 * D-197 — which clips' sources are known to carry a real decodeable audio
 * stream, keyed by `Clip.id`. `buildExportFfmpegArgs` is pure (no store
 * access, per its own header doc) and cannot resolve this itself; this is
 * the one place a real caller CAN, from the media pool's own probed
 * `MediaVideoInfo.hasAudio` (D-129) — see `TimelineExportOptions.
 * hasAudioOverrides`'s own doc for the exact conservative-default reasoning
 * (video clips default `false`, audio-track clips default `true`).
 */
function resolveHasAudioOverrides(tl: Timeline): Record<string, boolean> {
  const items = useMediaPoolStore.getState().items;
  const out: Record<string, boolean> = {};
  for (const track of tl.tracks) {
    for (const clip of track.clips) {
      const media = items.find((m) => m.id === clip.media_id || m.sourcePath === clip.source_path);
      const probed = media?.video?.hasAudio;
      out[clip.id] = track.kind === 'audio' ? probed !== false : probed === true;
    }
  }
  return out;
}

/**
 * B-101/D-269 — every clip's source **audio channel count**, from the media
 * pool's own probed `MediaVideoInfo.audioChannels`, for
 * `TimelineExportOptions.audioChannelsOverrides`. Same
 * the-compiler-stays-pure/the-caller-supplies-the-fact split as
 * `resolveHasAudioOverrides` right above, reading the same pool items.
 *
 * A clip whose source was never probed for this — an offline item, or one
 * pooled before the field existed and not yet reached by
 * `backfill_audio_facts` — is simply **absent** from the record rather than
 * defaulted. The compiler reads absence as "unknown" and keeps its pre-B-101
 * upmix; writing a `0` or a guessed `2` here would turn "we don't know" into a
 * confident wrong answer, which is the same mistake `hasAudio`'s own `null`
 * sentinel exists to prevent.
 */
function resolveAudioChannelsOverrides(tl: Timeline): Record<string, number> {
  const items = useMediaPoolStore.getState().items;
  const out: Record<string, number> = {};
  for (const track of tl.tracks) {
    for (const clip of track.clips) {
      const media = items.find((m) => m.id === clip.media_id || m.sourcePath === clip.source_path);
      const channels = media?.video?.audioChannels;
      if (typeof channels === 'number' && channels > 0) out[clip.id] = channels;
    }
  }
  return out;
}

/** D-226 — the names of every clip that is joined by a transition AND has a
 *  speed change on it: either an export-time `speedOverrides` entry, or
 *  (D-236) its own persisted speed ramp. See the refusal at the point of use
 *  for why the combination is not compilable — it is the same reason for both,
 *  since a ramp is exactly a speed change whose factor varies. */
function transitionClipsWithSpeedChange(
  tl: Timeline,
  speedOverrides: Record<string, number> | undefined,
  fps: number,
): string[] {
  const names = new Set<string>();
  for (const track of tl.tracks) {
    for (const t of track.transitions ?? []) {
      const { outgoing, incoming } = transitionClipIndices(track, t.at_frame, fps);
      for (const idx of [outgoing, incoming]) {
        const clip = idx >= 0 ? track.clips[idx] : undefined;
        if (!clip) continue;
        if ((speedOverrides?.[clip.id] ?? 1) !== 1 || hasSpeedRamp(clip)) names.add(clip.name || clip.id);
      }
    }
  }
  return [...names];
}

/** `{ ok: true; value }` / `{ ok: false; error }` rather than a bare
 *  `Record<string, T> | { error: string }` union — TypeScript's `in`-based
 *  narrowing doesn't discriminate a plain index-signature type
 *  (`Record<string, T>`) from an `{ error: string }` shape (a `Record<string,
 *  T>` type-checks as possibly having an `'error'` key too), so an untagged
 *  union silently fails to narrow at the call site. A real `ok` discriminant
 *  is the standard fix, not a cast. */
function parseClipIdRecord<T>(
  raw: unknown,
  label: string,
  validate: (v: unknown) => v is T,
  describe: string,
): { ok: true; value: Record<string, T> } | { ok: false; error: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${label} must be an object of {clipId: ${describe}}` };
  }
  const out: Record<string, T> = {};
  for (const [clipId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!validate(v)) return { ok: false, error: `${label}["${clipId}"] must be ${describe}` };
    out[clipId] = v;
  }
  return { ok: true, value: out };
}

/**
 * Validate `a` (the same loose `any` args shape every `editor_*` op reads —
 * MCP args, or now a plain object the GUI dialog builds directly) against
 * the CURRENT active timeline, and compile it to a real ffmpeg argv. No I/O.
 */
export function compileEditorExportArgs(a: {
  outPath?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
  speedOverrides?: unknown;
  fitOverrides?: unknown;
  freezeOverrides?: unknown;
}): CompiledExport | CompileError {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return { error: 'no timeline — open a project first' };

  const outPath = a?.outPath;
  if (typeof outPath !== 'string' || !outPath) return { error: 'outPath must be a non-empty absolute file path' };
  const width = Math.round(Number(a?.width));
  const height = Math.round(Number(a?.height));
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { error: 'width and height must be positive numbers (the output composition size)' };
  }
  const fps = a?.fps !== undefined ? Number(a.fps) : timelineFps(tl);
  if (!Number.isFinite(fps) || fps <= 0) return { error: 'fps must be a positive number' };

  const speedParsed = parseClipIdRecord<number>(
    a?.speedOverrides,
    'speedOverrides',
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    'a positive number',
  );
  if (speedParsed && !speedParsed.ok) return { error: speedParsed.error };
  const speedOverrides = speedParsed?.value;

  const fitParsed = parseClipIdRecord<'fit' | 'stretch'>(
    a?.fitOverrides,
    'fitOverrides',
    (v): v is 'fit' | 'stretch' => v === 'fit' || v === 'stretch',
    '"fit" or "stretch"',
  );
  if (fitParsed && !fitParsed.ok) return { error: fitParsed.error };
  const fitOverrides = fitParsed?.value;

  const freezeOverridesRaw = a?.freezeOverrides;
  let freezeOverrides: Record<string, boolean> | undefined;
  if (freezeOverridesRaw !== undefined) {
    if (typeof freezeOverridesRaw !== 'object' || freezeOverridesRaw === null || Array.isArray(freezeOverridesRaw)) {
      return { error: 'freezeOverrides must be an object of {clipId: boolean}' };
    }
    freezeOverrides = {};
    for (const [clipId, val] of Object.entries(freezeOverridesRaw as Record<string, unknown>)) {
      freezeOverrides[clipId] = !!val;
    }
  }

  // D-211/D-212 — the font FILE for each text clip's font key, from the
  // backend's own catalogue (the same resolution the live preview rasterises
  // with, which is what makes the exported title match the previewed one).
  // Read synchronously from the module cache `useEditorControl` warms at
  // mount — see `textFonts.ts`'s own doc for why the cache exists.
  const fontFiles = textFontPaths();
  // D-229 — captions resolve fonts through the SAME catalogue, so they are
  // checked in the same place and refused for the same reason. Concatenated
  // rather than checked separately so the user gets one message naming every
  // unrenderable font, not one error per kind of clip.
  const missingFonts = [
    ...textClipsMissingFonts(tl, fontFiles),
    ...captionClipsMissingFonts(tl, fontFiles, fps),
  ];
  if (missingFonts.length > 0) {
    // Refused rather than compiled-and-let-ffmpeg-fail: a `drawtext` with an
    // unresolvable `fontfile=` takes the WHOLE export down with an opaque
    // libfreetype message, and silently dropping the title would ship a file
    // that disagrees with what the preview showed.
    const names = [...new Set(missingFonts.map((m) => m.font))].join(', ');
    return {
      error: `no font file for ${names} — ${missingFonts.length} text clip(s) cannot be rendered. Pick a different font in the Inspector, or check chroma_text_fonts for which families this machine has.`,
    };
  }

  // D-226 — a speed override on a clip that a transition joins is refused
  // outright rather than compiled into something wrong. `speedOverrides` is an
  // export-time-only knob that changes a clip's on-timeline FOOTPRINT (see that
  // option's own doc), so the cut a transition names is no longer where that
  // clip's edge lands, and the blend would drift from it by exactly the speed
  // factor. Named here, at compile time, for `textClipsMissingFonts`' own
  // reason: this is where a real reason can be reported, and the compiler
  // itself (`transitionPlansFor`) only skips such a transition defensively.
  //
  // D-236 — checked unconditionally now, not only when `speedOverrides` was
  // passed: a speed ramp lives on the CLIP, so the clash can exist in a
  // document nobody handed an override to.
  {
    const clashing = transitionClipsWithSpeedChange(tl, speedOverrides, fps);
    if (clashing.length > 0) {
      return {
        error: `a speed change is not supported on a clip joined by a transition (${clashing.join(', ')}) — a speed change moves the clip's edge away from the cut the transition sits on. Remove the transition, or export that clip's speed change separately.`,
      };
    }
  }

  // D-243 — the measured per-word advances an ANIMATED caption is laid out
  // from, read synchronously from the module cache `runEditorExport` warms,
  // exactly as `fontFiles` is read from its own. Static captions need none.
  const captionMetrics = captionMetricsSnapshot();
  const missingMetrics = captionClipsMissingMetrics(tl, captionMetrics, fps, width, height);
  if (missingMetrics.length > 0) {
    // Refused for the same reason a missing font is: without a word's advance
    // the compiler would place it at x=0, stacking the line on itself — an
    // export that silently disagrees with the preview, which is the exact
    // defect class this repo keeps closing.
    const words = [...new Set(missingMetrics.map((m) => m.word))].slice(0, 8).join(', ');
    return {
      error: `no measured width for ${missingMetrics.length} word(s) of an animated caption (${words}) — the caption metrics cache is cold. This is warmed automatically by runEditorExport; if you are calling compileEditorExportArgs directly, await warmCaptionMetrics first.`,
    };
  }

  // D-256 — the baked Colorist grade for every graded clip, read synchronously
  // from the module cache `runEditorExport` warms, exactly as `fontFiles` and
  // `captionMetrics` are read from theirs.
  //
  // **A cold cache is a refusal, not a fallback**, for `captionClipsMissing
  // Metrics`' reason in its sharpest form: compiling anyway would produce a
  // file with no grade in it while the Edit preview plainly showed one — a
  // silent preview-vs-export divergence, which is the exact defect D-256 exists
  // to close. `gradeLutsAreWarm` is checked rather than "is the map non-empty"
  // because an empty map is also the correct, common answer for a timeline
  // whose clips are simply ungraded.
  if (!gradeLutsAreWarm(tl)) {
    return {
      error:
        'the Colorist grade cache is cold, so this export could silently drop a clip’s grade. This is warmed automatically by runEditorExport; if you are calling compileEditorExportArgs directly (the export queue does), await warmGradeLuts(timeline) first.',
    };
  }
  const gradeLutPaths = gradeLutPathsSnapshot();

  const opts: TimelineExportOptions = {
    fps,
    width,
    height,
    speedOverrides,
    fitOverrides,
    freezeOverrides,
    hasAudioOverrides: resolveHasAudioOverrides(tl),
    audioChannelsOverrides: resolveAudioChannelsOverrides(tl),
    fontFiles,
    captionMetrics,
    gradeLutPaths,
  };
  const args = buildExportFfmpegArgs(tl, outPath, opts);
  return { ok: true, outPath, args };
}

/**
 * D-243 — measure every word of every ANIMATED caption on the current
 * timeline, so the synchronous compiler can read them out of the module cache.
 *
 * **Why the composition size is a parameter.** A word's measurement is taken
 * at the caption's RESOLVED font size in pixels, and that resolves against the
 * output height (`size` is a fraction of it). Exporting the same timeline at
 * 1080p and at 720p therefore needs two different measurements of the same
 * word, which is exactly why `captionMetricKey` includes `fontPx`. Passing the
 * dimensions in rather than assuming the timeline's own is what keeps the
 * warmed cache correct for the export actually about to run.
 *
 * A no-op for a timeline whose captions are all static — they carry no
 * per-word layout, and ffmpeg measures a whole line itself.
 */
export async function warmAnimatedCaptionMetrics(
  width: number,
  height: number,
  fps: number,
): Promise<void> {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return;
  }
  const requests: Array<{ font: string; fontPx: number; text: string; durSecs: number }> = [];
  for (const c of captionsForExport(tl, fps)) {
    const anim = captionAnimationOf(c.style);
    if (!isPerWordAnim(anim.kind)) continue;
    const lines = captionLines(c.cue.text);
    if (lines.length === 0) continue;
    const layout = captionLayout(
      c.style,
      width,
      height,
      isSingleWordAnim(anim.kind) ? 1 : lines.length,
    );
    requests.push({
      font: c.style.font,
      fontPx: layout.font_px,
      text: c.cue.text,
      durSecs: Math.max(0, c.endSec - c.startSec),
    });
  }
  if (requests.length === 0) return;
  await warmCaptionMetrics(requests);
}

export interface EditorExportResult {
  ok: boolean;
  error: string | null;
  outPath: string;
  stdoutTail?: string;
  stderrTail?: string;
  args?: string[];
}

/** Compile + actually run — what the MCP `editor_export` op calls. */
export async function runEditorExport(
  a: Parameters<typeof compileEditorExportArgs>[0],
): Promise<EditorExportResult | CompileError> {
  // D-211 — the ONE place the (synchronous) compiler's font-catalogue read
  // can be guaranteed warm before it runs: an MCP `editor_export` can be the
  // very first thing an agent does after opening a project, before the
  // Inspector has ever rendered a font picker. Idempotent and a no-op once
  // loaded (see `textFonts.ts`), so this costs nothing on every later call.
  await loadTextFonts();
  // D-243 — and the per-word advances every ANIMATED caption needs, for the
  // identical reason: the compiler below is synchronous, so anything it needs
  // from the backend has to already be in memory. Derived from the timeline
  // the compiler is about to read, and a no-op for a timeline whose captions
  // are all static.
  {
    const tl = useEditorTimelineStore.getState().timeline;
    const w = Math.round(Number(a?.width));
    const h = Math.round(Number(a?.height));
    const fps = a?.fps !== undefined ? Number(a.fps) : tl ? timelineFps(tl) : NaN;
    await warmAnimatedCaptionMetrics(w, h, fps);
    // D-256 — and each graded clip's baked Colorist grade, for the identical
    // reason. Throws on a bake failure rather than exporting an ungraded file;
    // caught here so an MCP `editor_export` gets a real message instead of an
    // unhandled rejection.
    if (tl) {
      try {
        await warmGradeLuts(tl);
      } catch (e) {
        return { error: `could not bake a clip's Colorist grade for export: ${String((e as Error)?.message ?? e)}` };
      }
    }
  }
  const compiled = compileEditorExportArgs(a);
  if (!('ok' in compiled)) return compiled;
  const outcome = await invoke<FfmpegRunOutcome>('chroma_run_ffmpeg', { args: compiled.args });
  return {
    ok: outcome.ok,
    error: outcome.ok ? null : outcome.stderr_tail || 'ffmpeg failed with no stderr output',
    outPath: compiled.outPath,
    stdoutTail: outcome.stdout_tail,
    stderrTail: outcome.stderr_tail,
    args: compiled.args,
  };
}

/** Run an ALREADY-COMPILED export's argv (from [`compileEditorExportArgs`])
 *  — what the export queue calls once a job reaches the front. Never
 *  re-reads the (possibly since-edited) timeline — the argv was frozen at
 *  enqueue time. */
export async function runCompiledExport(
  args: string[],
): Promise<{ ok: boolean; error: string | null; stdoutTail: string; stderrTail: string }> {
  const outcome = await invoke<FfmpegRunOutcome>('chroma_run_ffmpeg', { args });
  return {
    ok: outcome.ok,
    error: outcome.ok ? null : outcome.stderr_tail || 'ffmpeg failed with no stderr output',
    stdoutTail: outcome.stdout_tail,
    stderrTail: outcome.stderr_tail,
  };
}
