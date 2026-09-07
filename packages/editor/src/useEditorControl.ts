/**
 * @chroma/editor — the Edit-tab half of the Chroma control server bridge
 * (D-020's architecture, reused a third time — see `docs/notes/
 * mcp-architecture.md` for the full pattern this hook follows, and D-183
 * for why this file exists at all: the owner's own live "why are we
 * building chroma when you want to do it with ffmpeg… build all the MCP
 * and register the MCP its our own tool" — the Edit tab had no control
 * surface at all before this pass, only Colorist (`useChromaControl.ts`)
 * and Motion (`@chroma/motion`'s `useMotionControl.ts`) did.
 *
 * **Same event pair as both existing hooks, no Rust changes.** Listens on
 * the SAME `chroma://request`/`chroma://response/<id>` Tauri events
 * `control.rs` already emits/awaits (`app/src-tauri/src/chroma/control.rs`
 * has never needed an op-name change to carry a new tab's ops — it forwards
 * `{op,args}` blind). Every op here is namespaced `editor_*`, mirroring
 * Motion's own OPT-IN convention exactly (`MOTION_OP_PREFIX`,
 * `@chroma/motion/src/useMotionControl.ts`) — NOT Colorist's own
 * opt-OUT/catch-all shape, which `docs/notes/mcp-architecture.md` calls
 * out as the one NOT to copy. `useChromaControl.ts` has its own matching
 * skip for `editor_*` (D-183) so the two listeners never race for the
 * one-shot response slot `control.rs`'s `app.once(...)` hands out per
 * request id.
 *
 * **No ref/argument plumbing needed, unlike Motion.** `useEditorTimelineStore`
 * and `@chroma/bridge`'s `useMediaPoolStore` are real module-level zustand
 * stores, reachable via `.getState()` from any JS context independent of
 * React's render cycle — the exact same reason `useChromaControl.ts` never
 * needed a ref for Colorist's own `useEditorStore`. `useMotionControl.ts`
 * needs a ref ONLY because `useMotionManifest`'s state is deliberately
 * component-local (that file's own doc comment: "nothing outside this tab
 * needs it"). So this hook takes no arguments at all and is mounted
 * unconditionally from `EditorTab.tsx`, exactly like `useChromaControl()`
 * is mounted from `App.tsx` with none either.
 *
 * **D-183 also moved three ops IN, not just added new ones**: `get_timeline`
 * (renamed `editor_get_timeline`), `set_clip_fade` (`editor_set_clip_fade`)
 * and `set_track_duck` (`editor_set_track_duck`) all used to live in
 * `useChromaControl.ts`'s own `OPS` map despite being pure Edit-tab
 * concerns (`docs/notes/mcp-architecture.md`'s "every tab owns its own ops"
 * rule) — moved here verbatim (same logic, same read-back-after-write
 * convention), removed from Colorist's file.
 */
import { useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

import { useMediaPoolStore } from '@chroma/bridge';

import { useEditorTimelineStore } from './timelineStore';
import {
  timelineDuration,
  timelineFps,
  FADE_PRESETS,
  DEFAULT_FADE_CURVE,
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  fadePresetName,
  type FadeCurve,
  type Clip,
  type NewClipFields,
  type Timeline,
} from './timeline';
import { buildExportFfmpegArgs } from './timelineExport';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';

/** Mirrors `app/src-tauri/src/chroma/ffmpeg_run.rs`'s `FfmpegRunOutcome` —
 *  no shared types package between this package and the Rust crate exists
 *  (Motion's `MotionRenderResult` in `manifestIO.ts` is the same kind of
 *  duplicate-by-hand DTO for the same reason), so this is copied by hand. */
interface FfmpegRunOutcome {
  ok: boolean;
  stdout_tail: string;
  stderr_tail: string;
}

const EDITOR_OP_PREFIX = 'editor_';

/** B-032/B-034/D-112's own fix, copied verbatim from `useMotionControl.ts` —
 *  `listen()`'s cleanup is `unlistenPromise.then((f) => f())`, and Tauri's
 *  own `_unlisten` is itself `async`, so a dev-mode HMR race can make that
 *  inner call reject as an unhandled promise rejection rather than a
 *  catchable synchronous throw. Chaining `.catch(() => {})` onto the SAME
 *  promise (not a second `try`/`catch`) is what actually silences it. */
function safeUnlisten(unlistenPromise: Promise<(() => void) | undefined | void>): void {
  unlistenPromise
    .then((f) => {
      const result: unknown = f?.();
      return Promise.resolve(result);
    })
    .catch(() => {
      /* the listener is already gone either way (HMR teardown race) */
    });
}

/** One track/clip index pair, parsed + range-checked once so every op below
 *  reports the SAME "no track N (0..M)" / "no clip N on track M (0..K)"
 *  shape `set_clip_fade`'s own pre-D-183 error strings already used —
 *  copied as a convention, not a new one invented for this pass. `null`
 *  (with the error already on `err`) when either index doesn't resolve. */
function resolveClip(
  tl: Timeline,
  trackArg: unknown,
  clipArg: unknown,
): { track: number; clip: number; tr: Timeline['tracks'][number]; c: Clip } | { error: string } {
  const track = Math.round(Number(trackArg));
  const tr = tl.tracks[track];
  if (!tr) return { error: `no track ${track} (0..${tl.tracks.length - 1})` };
  const clip = Math.round(Number(clipArg));
  const c = tr.clips[clip];
  if (!c) return { error: `no clip ${clip} on track ${track} (0..${tr.clips.length - 1})` };
  return { track, clip, tr, c };
}

/** Resolve the media file the D-189 analysis ops should look at, from any of
 *  the three things a caller might reasonably have: a media-pool `mediaId`, a
 *  pool item's `sourcePath`, or a bare absolute `path` that isn't in the pool
 *  at all. The third is deliberate — "what's in this file?" is a question you
 *  most want answered BEFORE deciding whether to import it, so requiring an
 *  import first would put the tool on the wrong side of its own use case.
 *  A pool lookup still wins when it matches, so `sourcePath` behaves
 *  identically whether or not the file has been imported. */
function resolveMediaPath(a: any): { path: string } | { error: string } {
  const items = useMediaPoolStore.getState().items;
  const media = items.find((m) => m.id === a?.mediaId || m.sourcePath === a?.sourcePath);
  if (media) return { path: media.sourcePath };
  if (a?.mediaId) return { error: `no pool item with mediaId "${a.mediaId}"` };
  const path = a?.path ?? a?.sourcePath;
  if (typeof path !== 'string' || !path) {
    return { error: 'pass mediaId, sourcePath, or an absolute path' };
  }
  return { path };
}

/** The D-189 transcript response, shared by the start op and its status op so
 *  the two can never report the same job differently. `state` mirrors the
 *  sidecar's own job vocabulary (`running` / `done` / `error`) plus `idle`
 *  ("never asked"), so a poller reads one field to decide what to do next. */
function transcriptResult(path: string) {
  const status = useMediaUnderstandingStore.getState().transcriptStatus(path);
  if (status.phase === 'error') return { error: status.error ?? 'transcription failed' };
  if (status.phase !== 'done') {
    return { ok: true, path, state: status.phase, note: 'poll editor_get_transcript_status' };
  }
  const t = status.result;
  return {
    ok: true,
    path,
    state: 'done',
    language: t?.language,
    model: t?.model,
    text: t?.text,
    segments: t?.segments ?? [],
    words: t?.words ?? [],
  };
}

/** The D-189 video-analysis response. Same contract as [`transcriptResult`]. */
function analysisResult(path: string) {
  const status = useMediaUnderstandingStore.getState().analysisStatus(path);
  if (status.phase === 'error') return { error: status.error ?? 'video analysis failed' };
  if (status.phase !== 'done') {
    return { ok: true, path, state: status.phase, note: 'poll editor_analyze_video_status' };
  }
  const a = status.result;
  return {
    ok: true,
    path,
    state: 'done',
    question: a?.question,
    events: a?.events ?? [],
    meta: a?._meta,
    // Surfaced as a top-level field, not buried in `meta`, because it is the
    // one thing a caller must act on: candidates were silently dropped at the
    // cap, so raise `maxCandidates` and re-run.
    truncated: a?._meta?.truncated ?? false,
  };
}

/** The exact clip-fade shape `get_timeline` (pre-D-183, `useChromaControl
 *  .ts`) already reported per clip — reused verbatim so `editor_get_timeline`
 *  is byte-for-byte the same response shape under its new name. */
function timelineDto(tl: Timeline) {
  return {
    id: tl.id,
    name: tl.name,
    durationFrames: timelineDuration(tl),
    tracks: tl.tracks.map((t, ti) => ({
      index: ti,
      kind: t.kind,
      gain: t.gain ?? 1,
      locked: !!t.locked,
      hidden: !!t.hidden,
      duckFrom: t.duck_from ?? null,
      duckDb: t.duck_db ?? 0,
      duckAttackMs: t.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS,
      duckReleaseMs: t.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS,
      clips: t.clips.map((c, ci) => ({
        index: ci,
        id: c.id,
        name: c.name,
        sourcePath: c.source_path,
        startFrame: c.start_frame,
        duration: c.duration,
        sourceStart: c.source_start,
        sourceLen: c.source_len,
        // B-077 — `duration`/`sourceStart` are in the clip's OWN native
        // frames, `startFrame` is a TIMELINE frame (`chroma-timeline::Clip`'s
        // own doc) — the exact distinction that silently displayed a 47.86s
        // clip's real length as 88s before this fix. A caller computing this
        // clip's real length/end needs `sourceFps` (falls back to the
        // timeline's own rate — `durationFrames` above — when absent: a
        // clip probed before this field existed, or genuinely same-rate).
        sourceFps: c.source_fps ?? null,
        linkGroup: c.link_group ?? null,
        opacity: c.opacity ?? 1,
        positionX: c.position_x ?? 0,
        positionY: c.position_y ?? 0,
        scale: c.scale ?? 1,
        rotation: c.rotation ?? 0,
        cropLeft: c.crop_left ?? 0,
        cropTop: c.crop_top ?? 0,
        cropRight: c.crop_right ?? 0,
        cropBottom: c.crop_bottom ?? 0,
        keyframes: c.chroma_keyframes ?? [],
        fadeInFrames: c.fade_in_frames ?? 0,
        fadeOutFrames: c.fade_out_frames ?? 0,
        fadeInCurve: c.fade_in_curve ?? DEFAULT_FADE_CURVE,
        fadeOutCurve: c.fade_out_curve ?? DEFAULT_FADE_CURVE,
        fadeInCurveName: fadePresetName(c.fade_in_curve),
        fadeOutCurveName: fadePresetName(c.fade_out_curve),
      })),
    })),
  };
}

/** A fade curve arrives as either a preset name ("ease-in") or four control
 *  points (`[x1,y1,x2,y2]` or `{x1,y1,x2,y2}`) — copied verbatim from the
 *  pre-D-183 `set_clip_fade`. An unknown NAME is reported rather than
 *  silently substituted. */
function parseCurve(v: unknown, which: string): FadeCurve | { error: string } | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const hit = FADE_PRESETS.find((p) => p.name === v);
    return (
      hit?.curve ?? {
        error: `unknown ${which} "${v}" — one of ${FADE_PRESETS.map((p) => p.name).join(' | ')}, or four control points [x1,y1,x2,y2]`,
      }
    );
  }
  const pts = Array.isArray(v) ? v : [(v as any)?.x1, (v as any)?.y1, (v as any)?.x2, (v as any)?.y2];
  if (pts.length !== 4 || pts.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n))) {
    return { error: `${which} must be a preset name or four finite numbers [x1,y1,x2,y2]` };
  }
  return { x1: pts[0], y1: pts[1], x2: pts[2], y2: pts[3] };
}

/** Mount once from `EditorTab.tsx`. No arguments — see this file's own
 *  module doc comment for why (both stores it reads are module-level). */
export function useEditorControl(): void {
  useEffect(() => {
    const noTimeline = { error: 'no timeline — open a project first' };

    const OPS: Record<string, (args: any) => any> = {
      // ---- read/seek ------------------------------------------------------
      editor_get_state: () => {
        const s = useEditorTimelineStore.getState();
        return {
          projectOpen: s.projectOpen,
          status: s.status,
          error: s.error,
          playhead: s.playhead,
          playing: s.playing,
          hasTimeline: !!s.timeline,
        };
      },

      editor_get_timeline: () => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        return timelineDto(tl);
      },

      editor_set_playhead: (a) => {
        const frame = Math.round(Number(a?.frame));
        if (!Number.isFinite(frame)) return { error: 'frame must be a finite number' };
        useEditorTimelineStore.getState().setPlayhead(frame);
        return { ok: true, playhead: useEditorTimelineStore.getState().playhead };
      },

      editor_set_playing: (a) => {
        useEditorTimelineStore.getState().setPlaying(!!a?.playing);
        return { ok: true, playing: useEditorTimelineStore.getState().playing };
      },

      // ---- media pool -------------------------------------------------------
      editor_import_media: async (a) => {
        const paths: unknown = a?.paths;
        if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string') || paths.length === 0) {
          return { error: 'paths must be a non-empty array of absolute file paths' };
        }
        const result = await useMediaPoolStore.getState().importPaths(paths as string[], a?.folder);
        if (!result.ok) return { error: result.error ?? 'import failed' };
        return {
          ok: true,
          added: (result.added ?? []).map((m) => ({
            id: m.id,
            sourcePath: m.sourcePath,
            name: m.name,
            offline: m.offline,
            video: m.video
              ? { width: m.video.width, height: m.video.height, fps: m.video.fps, frameCount: m.video.frameCount, durationSecs: m.video.durationSecs }
              : null,
          })),
        };
      },

      // ---- clip placement / trim / ripple-delete --------------------------
      // D-182/D-183 — this trio (`add_clip`+`split`+`remove`+`remove_gap`) is
      // ALL the "cut a gap out of a recording" surface needs: place a
      // full-length clip, split it at the gap's two edges, remove the
      // now-isolated gap segment, close the gap it leaves — no new EditOp
      // had to be invented, every one already existed.
      editor_add_clip: (a) => {
        const items = useMediaPoolStore.getState().items;
        const media = items.find((m) => m.id === a?.mediaId || m.sourcePath === a?.sourcePath);
        if (!media) return { error: `no pool item matching mediaId/sourcePath — call editor_import_media first` };
        const frames = media.video?.frameCount;
        if (!frames || frames <= 0) return { error: `${media.name} has no known frame count (offline, or not a probeable video)` };

        const track = Math.round(Number(a?.track));
        const sourceStart = a?.sourceStart !== undefined ? Math.round(Number(a.sourceStart)) : 0;
        const duration = a?.duration !== undefined ? Math.round(Number(a.duration)) : frames - sourceStart;
        if (!Number.isFinite(sourceStart) || sourceStart < 0 || sourceStart >= frames) {
          return { error: `sourceStart must be within [0, ${frames}) frames of the source` };
        }
        if (!Number.isFinite(duration) || duration <= 0 || sourceStart + duration > frames) {
          return { error: `duration must be > 0 and sourceStart+duration must be <= ${frames} (the source's own length)` };
        }

        const clip: NewClipFields = {
          id: `${media.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          shot_id: null,
          media_id: media.id,
          link_group: null,
          name: a?.name || media.name,
          source_path: media.sourcePath,
          source_start: sourceStart,
          duration,
          source_len: frames,
          source_fps: media.video?.fps ?? undefined,
        };

        useEditorTimelineStore.getState().applyOp({
          kind: 'add_clip',
          track,
          clip,
          atIndex: a?.atIndex !== undefined ? Math.round(Number(a.atIndex)) : undefined,
          startFrame: a?.startFrame !== undefined ? Math.round(Number(a.startFrame)) : undefined,
          ripple: !!a?.ripple,
        });

        const tl = useEditorTimelineStore.getState().timeline;
        const placed = tl?.tracks[track]?.clips.find((c) => c.id === clip.id);
        if (!placed) return { error: 'add_clip did not place the clip — check track index / project state' };
        return { ok: true, track, clipId: placed.id, startFrame: placed.start_frame, duration: placed.duration };
      },

      editor_split_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const atFrame = Math.round(Number(a?.atFrame));
        if (!Number.isFinite(atFrame)) return { error: 'atFrame must be a finite number' };
        useEditorTimelineStore.getState().applyOp({ kind: 'split', track: found.track, clip: found.clip, atFrame });
        return { ok: true, track: found.track };
      },

      editor_remove_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: found.track, clip: found.clip });
        return { ok: true, track: found.track };
      },

      editor_remove_gap: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const track = Math.round(Number(a?.track));
        const frame = Math.round(Number(a?.frame));
        if (!Number.isFinite(frame)) return { error: 'frame must be a finite number' };
        useEditorTimelineStore.getState().applyOp({ kind: 'remove_gap', track, frame });
        return { ok: true, track };
      },

      editor_trim_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const edge = a?.edge === 'start' ? 'trim_start' : a?.edge === 'end' ? 'trim_end' : null;
        if (!edge) return { error: `edge must be "start" or "end"` };
        const delta = Math.round(Number(a?.delta));
        if (!Number.isFinite(delta)) return { error: 'delta must be a finite number of frames' };
        useEditorTimelineStore.getState().applyOp({ kind: edge, track: found.track, clip: found.clip, delta });
        return { ok: true, track: found.track };
      },

      editor_move_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const found = resolveClip(tl, a?.fromTrack, a?.clip);
        if ('error' in found) return found;
        const toTrack = a?.toTrack !== undefined ? Math.round(Number(a.toTrack)) : found.track;
        const startFrame = Math.round(Number(a?.startFrame));
        if (!Number.isFinite(startFrame)) return { error: 'startFrame must be a finite number' };
        useEditorTimelineStore.getState().applyOp({
          kind: 'move',
          fromTrack: found.track,
          toTrack,
          clip: found.clip,
          startFrame,
          ripple: !!a?.ripple,
        });
        return { ok: true, fromTrack: found.track, toTrack };
      },

      // ---- tracks ----------------------------------------------------------
      editor_add_track: (a) => {
        const trackKind = a?.trackKind === 'audio' ? 'audio' : 'video';
        useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind });
        const tl = useEditorTimelineStore.getState().timeline;
        return { ok: true, track: (tl?.tracks.length ?? 1) - 1 };
      },

      // ---- compositing transform + keyframes (D-182's stacking + zoom) ----
      editor_set_clip_transform: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        const num = (v: unknown, fallback: number) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : fallback;
        };
        // D-193 — `box_width`/`box_height` are `number | null` on the real
        // op (`null` = no override, an explicit, meaningful value — see
        // that op's own doc), so they need their OWN reader rather than
        // `num`'s "coerce or fall back to a number" contract: an explicit
        // `null` in the args object clears the override, `undefined`
        // (omitted) keeps the clip's current value, matching every other
        // field's "only state what changes" convenience on this tool.
        const numOrNull = (v: unknown, fallback: number | null): number | null => {
          if (v === null) return null;
          if (v === undefined) return fallback;
          const n = Number(v);
          return Number.isFinite(n) ? n : fallback;
        };
        const c = found.c;
        // Every field required by the real EditOp — read the clip's OWN
        // current values as defaults (same "only state what changes"
        // convenience `set_clip_fade` already gives a caller) so a partial
        // args object (e.g. just `{scale: 1.5}`) never silently resets the
        // other fields to 0/1, which the op's own contract (`timeline.ts`'s
        // `set_clip_transform` doc: "the fields are REQUIRED... an optional
        // field would silently reset") explicitly warns against.
        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_transform',
          track: found.track,
          clip: found.clip,
          opacity: num(a?.opacity, c.opacity ?? 1),
          position_x: num(a?.position_x, c.position_x ?? 0),
          position_y: num(a?.position_y, c.position_y ?? 0),
          scale: num(a?.scale, c.scale ?? 1),
          box_width: numOrNull(a?.box_width, c.box_width ?? null),
          box_height: numOrNull(a?.box_height, c.box_height ?? null),
          rotation: num(a?.rotation, c.rotation ?? 0),
          crop_left: num(a?.crop_left, c.crop_left ?? 0),
          crop_top: num(a?.crop_top, c.crop_top ?? 0),
          crop_right: num(a?.crop_right, c.crop_right ?? 0),
          crop_bottom: num(a?.crop_bottom, c.crop_bottom ?? 0),
        });
        return { ok: true, track: found.track, clip: found.clip };
      },

      editor_set_clip_keyframes: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        const keyframes = a?.keyframes;
        if (!Array.isArray(keyframes)) return { error: 'keyframes must be an array of {frame, params}' };
        for (const k of keyframes) {
          if (typeof k?.frame !== 'number' || typeof k?.params !== 'object' || k.params === null) {
            return { error: 'each keyframe needs a numeric frame and a params object' };
          }
        }
        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_keyframes',
          track: found.track,
          clip: found.clip,
          keyframes,
        });
        return { ok: true, track: found.track, clip: found.clip, count: keyframes.length };
      },

      // ---- export (Phase 2/3, D-183) — timelineExport.ts compiles the
      // Timeline to an ffmpeg argv; chroma_run_ffmpeg just spawns it -------
      editor_export: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;

        const outPath = a?.outPath;
        if (typeof outPath !== 'string' || !outPath) return { error: 'outPath must be a non-empty absolute file path' };
        const width = Math.round(Number(a?.width));
        const height = Math.round(Number(a?.height));
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          return { error: 'width and height must be positive numbers (the output composition size)' };
        }
        const fps = a?.fps !== undefined ? Number(a.fps) : timelineFps(tl);
        if (!Number.isFinite(fps) || fps <= 0) return { error: 'fps must be a positive number' };

        let speedOverrides: Record<string, number> | undefined;
        if (a?.speedOverrides !== undefined) {
          if (typeof a.speedOverrides !== 'object' || a.speedOverrides === null || Array.isArray(a.speedOverrides)) {
            return { error: 'speedOverrides must be an object of {clipId: multiplier}' };
          }
          speedOverrides = {};
          for (const [clipId, mult] of Object.entries(a.speedOverrides as Record<string, unknown>)) {
            const n = Number(mult);
            if (!Number.isFinite(n) || n <= 0) return { error: `speedOverrides["${clipId}"] must be a positive number` };
            speedOverrides[clipId] = n;
          }
        }

        let fitOverrides: Record<string, 'fit' | 'stretch'> | undefined;
        if (a?.fitOverrides !== undefined) {
          if (typeof a.fitOverrides !== 'object' || a.fitOverrides === null || Array.isArray(a.fitOverrides)) {
            return { error: 'fitOverrides must be an object of {clipId: "fit" | "stretch"}' };
          }
          fitOverrides = {};
          for (const [clipId, mode] of Object.entries(a.fitOverrides as Record<string, unknown>)) {
            if (mode !== 'fit' && mode !== 'stretch') {
              return { error: `fitOverrides["${clipId}"] must be "fit" or "stretch"` };
            }
            fitOverrides[clipId] = mode;
          }
        }

        let freezeOverrides: Record<string, boolean> | undefined;
        if (a?.freezeOverrides !== undefined) {
          if (typeof a.freezeOverrides !== 'object' || a.freezeOverrides === null || Array.isArray(a.freezeOverrides)) {
            return { error: 'freezeOverrides must be an object of {clipId: boolean}' };
          }
          freezeOverrides = {};
          for (const [clipId, val] of Object.entries(a.freezeOverrides as Record<string, unknown>)) {
            freezeOverrides[clipId] = !!val;
          }
        }

        const args = buildExportFfmpegArgs(tl, outPath, { fps, width, height, speedOverrides, fitOverrides, freezeOverrides });
        const outcome = await invoke<FfmpegRunOutcome>('chroma_run_ffmpeg', { args });
        return {
          ok: outcome.ok,
          error: outcome.ok ? null : (outcome.stderr_tail || 'ffmpeg failed with no stderr output'),
          outPath,
          stdoutTail: outcome.stdout_tail,
          stderrTail: outcome.stderr_tail,
          args,
        };
      },

      // ---- fade (D-147) + duck (D-149) — moved from useChromaControl.ts ---
      editor_set_clip_fade: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        const c = found.c;

        const inCurve = parseCurve(a?.fade_in_curve, 'fade_in_curve');
        if (inCurve && 'error' in inCurve) return inCurve;
        const outCurve = parseCurve(a?.fade_out_curve, 'fade_out_curve');
        if (outCurve && 'error' in outCurve) return outCurve;

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_fade',
          track: found.track,
          clip: found.clip,
          fade_in_frames: Number(a?.fade_in_frames ?? c.fade_in_frames ?? 0),
          fade_out_frames: Number(a?.fade_out_frames ?? c.fade_out_frames ?? 0),
          fade_in_curve: inCurve ?? c.fade_in_curve ?? DEFAULT_FADE_CURVE,
          fade_out_curve: outCurve ?? c.fade_out_curve ?? DEFAULT_FADE_CURVE,
        });

        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          name: after?.name ?? c.name,
          fadeInFrames: after?.fade_in_frames ?? 0,
          fadeOutFrames: after?.fade_out_frames ?? 0,
          fadeInCurve: after?.fade_in_curve ?? DEFAULT_FADE_CURVE,
          fadeOutCurve: after?.fade_out_curve ?? DEFAULT_FADE_CURVE,
          fadeInCurveName: fadePresetName(after?.fade_in_curve),
          fadeOutCurveName: fadePresetName(after?.fade_out_curve),
          note: 'a fade on a video clip fades its picture AND its embedded audio together',
        };
      },

      editor_set_track_duck: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline;
        const track = Math.round(Number(a?.track));
        const tr = tl.tracks[track];
        if (!tr) return { error: `no track ${track} (0..${tl.tracks.length - 1})` };

        let duckFrom: number | null;
        const raw = a?.duck_from;
        if (raw == null || raw === 'off' || raw === false) {
          duckFrom = null;
        } else {
          duckFrom = Math.round(Number(raw));
          if (!Number.isFinite(duckFrom) || duckFrom < 0 || duckFrom >= tl.tracks.length) {
            return { error: `duck_from ${raw} is not a track (0..${tl.tracks.length - 1}), or null to turn ducking off` };
          }
          if (duckFrom === track) return { error: `a track cannot duck from itself (track ${track})` };
        }

        const num = (v: unknown, fallback: number) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : fallback;
        };

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_track_duck',
          track,
          duckFrom,
          duckDb: num(a?.duck_db, tr.duck_db ?? 0),
          duckAttackMs: num(a?.attack_ms, tr.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS),
          duckReleaseMs: num(a?.release_ms, tr.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS),
        });

        const after = useEditorTimelineStore.getState().timeline?.tracks[track];
        return {
          ok: true,
          track,
          kind: after?.kind ?? tr.kind,
          duckFrom: after?.duck_from ?? null,
          duckDb: after?.duck_db ?? 0,
          attackMs: after?.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS,
          releaseMs: after?.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS,
        };
      },

      // ---- media understanding (D-189) — read-only analysis of a file ----
      //
      // These two are the ONE documented exception to "a mutating op must go
      // through the same store action a GUI click does" (docs/notes/
      // mcp-architecture.md): they mutate nothing. They ask the `ai-media/`
      // sidecar a question about a file on disk and cache the answer, so there
      // is no undo history to preserve and no GUI state to keep in sync.
      //
      // They resolve a media-pool item the same way `editor_add_clip` does
      // (`mediaId` or `sourcePath`), so an agent that has just called
      // `editor_import_media` can pass either — but a bare absolute path that
      // isn't in the pool is also accepted, since "should I import this?" is
      // exactly the sort of question you'd want to answer BEFORE importing.
      //
      // **These START a job and return; they do not block on it.** That is
      // forced, not a style choice: `chroma::control`'s `BRIDGE_TIMEOUT` is 20
      // seconds (app/src-tauri/src/chroma/control.rs), a transcript takes tens
      // of seconds and an analysis runs at roughly 4x realtime, so an op that
      // awaited the result would 504 every time and the answer would never
      // reach a caller. Start, then poll `*_status` — the same shape
      // `depth_track`/`depth_track_status` already uses for the same reason.
      //
      // Results are CACHED by path, so a start call for an already-analysed
      // file returns `state: "done"` with the result immediately, and the
      // poll is skipped entirely. Pass `force: true` to re-run anyway.
      editor_get_transcript: (a) => {
        const path = resolveMediaPath(a);
        if ('error' in path) return path;
        const store = useMediaUnderstandingStore.getState();
        store.startTranscript(path.path, {
          language: typeof a?.language === 'string' ? a.language : undefined,
          wordTimestamps: a?.wordTimestamps === undefined ? undefined : !!a.wordTimestamps,
          force: !!a?.force,
        });
        return transcriptResult(path.path);
      },

      editor_get_transcript_status: (a) => {
        const path = resolveMediaPath(a);
        if ('error' in path) return path;
        return transcriptResult(path.path);
      },

      editor_analyze_video: (a) => {
        const path = resolveMediaPath(a);
        if ('error' in path) return path;
        const num = (v: unknown): number | undefined => {
          if (v === undefined || v === null) return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        useMediaUnderstandingStore.getState().startAnalysis(path.path, {
          question: typeof a?.question === 'string' ? a.question : undefined,
          sceneThreshold: num(a?.sceneThreshold),
          minGapS: num(a?.minGapS),
          maxCandidates: num(a?.maxCandidates),
          force: !!a?.force,
        });
        return analysisResult(path.path);
      },

      editor_analyze_video_status: (a) => {
        const path = resolveMediaPath(a);
        if ('error' in path) return path;
        return analysisResult(path.path);
      },

      // ---- track-level toggles — trivial 1:1 EditOp wrappers --------------
      editor_set_track_gain: (a) => {
        const track = Math.round(Number(a?.track));
        const gain = Number(a?.gain);
        if (!Number.isFinite(gain)) return { error: 'gain must be a finite number' };
        useEditorTimelineStore.getState().applyOp({ kind: 'set_track_gain', track, gain });
        return { ok: true, track, gain };
      },
      editor_set_track_locked: (a) => {
        const track = Math.round(Number(a?.track));
        useEditorTimelineStore.getState().applyOp({ kind: 'set_track_locked', track, locked: !!a?.locked });
        return { ok: true, track, locked: !!a?.locked };
      },
      editor_set_track_hidden: (a) => {
        const track = Math.round(Number(a?.track));
        useEditorTimelineStore.getState().applyOp({ kind: 'set_track_hidden', track, hidden: !!a?.hidden });
        return { ok: true, track, hidden: !!a?.hidden };
      },
    };

    const unlistenP = listen('chroma://request', async (ev: any) => {
      const payload = ev?.payload || {};
      const { id, op, args } = payload;
      if (typeof op !== 'string' || !op.startsWith(EDITOR_OP_PREFIX)) {
        // Not ours — leave it for useChromaControl.ts's Colorist registry
        // (or Motion's) to claim. Responding here would race a real handler
        // elsewhere for the one-shot response slot; see this file's own
        // module doc comment.
        return;
      }

      const respond = (body: any) => emit(`chroma://response/${id}`, body);
      const fn = OPS[op];
      if (!fn) {
        respond({ ok: false, error: `unknown editor op: ${op}` });
        return;
      }

      try {
        const result = await fn(args || {});
        respond({ ok: !result?.error, error: result?.error ?? null, result });
      } catch (e: any) {
        respond({ ok: false, error: String(e?.message || e), result: null });
      }
    });

    return () => {
      safeUnlisten(unlistenP);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
