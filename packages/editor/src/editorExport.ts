/**
 * @chroma/editor — the real `editor_export` compiler+runner (D-198,
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
import { useMediaPoolStore } from '@chroma/bridge';

import { useEditorTimelineStore } from './timelineStore';
import { timelineFps, transitionClipIndices, type Timeline } from './timeline';
import { buildExportFfmpegArgs, textClipsMissingFonts, type TimelineExportOptions } from './timelineExport';
import { loadTextFonts, textFontPaths } from './textFonts';

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

/** D-226 — the names of every clip that both carries a `speedOverrides` entry
 *  and is joined by a transition. See the refusal at the point of use for why
 *  the combination is not compilable. */
function transitionClipsWithSpeedOverride(
  tl: Timeline,
  speedOverrides: Record<string, number>,
  fps: number,
): string[] {
  const names = new Set<string>();
  for (const track of tl.tracks) {
    for (const t of track.transitions ?? []) {
      const { outgoing, incoming } = transitionClipIndices(track, t.at_frame, fps);
      for (const idx of [outgoing, incoming]) {
        const clip = idx >= 0 ? track.clips[idx] : undefined;
        if (clip && (speedOverrides[clip.id] ?? 1) !== 1) names.add(clip.name || clip.id);
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
  const missingFonts = textClipsMissingFonts(tl, fontFiles);
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
  if (speedOverrides) {
    const clashing = transitionClipsWithSpeedOverride(tl, speedOverrides, fps);
    if (clashing.length > 0) {
      return {
        error: `speed overrides are not supported on a clip joined by a transition (${clashing.join(', ')}) — a speed change moves the clip's edge away from the cut the transition sits on. Remove the transition, or export that clip's speed change separately.`,
      };
    }
  }

  const opts: TimelineExportOptions = {
    fps,
    width,
    height,
    speedOverrides,
    fitOverrides,
    freezeOverrides,
    hasAudioOverrides: resolveHasAudioOverrides(tl),
    fontFiles,
  };
  const args = buildExportFfmpegArgs(tl, outPath, opts);
  return { ok: true, outPath, args };
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
