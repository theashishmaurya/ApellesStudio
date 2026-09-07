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
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';

import { useMediaPoolStore } from '@chroma/bridge';

import { useEditorTimelineStore, type Selection } from './timelineStore';
import {
  timelineDuration,
  FADE_PRESETS,
  DEFAULT_FADE_CURVE,
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_TITLE_SECONDS,
  fadePresetName,
  gapAt,
  isTextClip,
  newTextClipFields,
  newTextLayer,
  timelineFps,
  type FadeCurve,
  type Clip,
  type NewClipFields,
  type TextLayer,
  type Timeline,
} from './timeline';
import { buildFcpxml, type ClipSourceInfo } from './timelineInterchange';
import { runEditorExport } from './editorExport';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { loadTextFonts, textFontsSync } from './textFonts';

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

/** D-216 — one resolved `editor_set_selection` entry: the `{track, id}` pair
 *  the store's `selection` actually holds, plus the clip's index, its name and
 *  its track's flags, all reported straight back to the caller. */
interface ResolvedSelectionClip {
  track: number;
  clip: number;
  id: string;
  name: string;
  trackLocked: boolean;
  trackHidden: boolean;
}

/** D-216 — resolve ONE `editor_set_selection` entry against the live timeline.
 *
 *  Accepts EITHER the `clip` INDEX every other mutating `editor_*` op takes
 *  (via [`resolveClip`], so the "no clip N on track M (0..K)" error shape is
 *  identical) or the `clipId` `editor_get_state` reports back. The two halves
 *  of this surface genuinely speak different dialects — reads hand out ids,
 *  writes take indices — and forcing a caller to convert would cost an
 *  `editor_get_timeline` round trip to answer a question it already had the
 *  answer to. `clipId` wins when both are given, since it is the more
 *  specific of the two (an index is only meaningful against a particular
 *  moment of the track's Vec order; an id survives a reorder — D-054).
 *
 *  Resolving at all is the point: a selection of a clip that does not exist
 *  would be stored happily, return `ok`, and render nothing — the same silent
 *  no-op class of bug B-053 was. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one entry of the untyped `chroma://request` args array, same as every op handler's own `a`
function resolveSelectionEntry(tl: Timeline, entry: any): ResolvedSelectionClip | { error: string } {
  const track = Math.round(Number(entry?.track));
  const tr = tl.tracks[track];
  if (!tr) return { error: `no track ${track} (0..${tl.tracks.length - 1})` };
  const flags = { trackLocked: !!tr.locked, trackHidden: !!tr.hidden };
  if (entry?.clipId !== undefined && entry?.clipId !== null) {
    const id = String(entry.clipId);
    const clip = tr.clips.findIndex((c) => c.id === id);
    if (clip < 0) {
      return { error: `no clip with id "${id}" on track ${track} — ids come from editor_get_timeline / editor_get_state` };
    }
    return { track, clip, id, name: tr.clips[clip].name, ...flags };
  }
  const found = resolveClip(tl, entry?.track, entry?.clip);
  if ('error' in found) return found;
  return { track: found.track, clip: found.clip, id: found.c.id, name: found.c.name, ...flags };
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
        // D-211 — `null` for an ordinary media clip; the whole text layer for
        // a title, so a caller can read back what it wrote without a second
        // round trip and can tell the two kinds of clip apart from this one
        // response (there is no `kind` field on a clip — being a title IS
        // having a text layer, see `chroma_timeline::Clip::text`).
        text: c.text ?? null,
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

/** D-201 — module-scope helpers so the request listener's `try/catch` below
 *  contains no `||` / `?.` / `??` "value blocks", which the React Compiler
 *  cannot lower inside a `try/catch` (and one of them anywhere in the hook
 *  makes it skip auto-memoizing the whole file). Each is exactly the
 *  expression it replaced, extracted verbatim — no behaviour change.
 *  See `docs/notes/react-compiler-coverage.md`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the untyped `chroma://request` payload these replace
const opArgs = (args: any): any => args || {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ditto: an op handler's result is an open record by contract
const opError = (result: any): string | null => result?.error ?? null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ditto: a thrown value is `unknown` in practice
const thrownMessage = (e: any): string => String(e?.message || e);

/** Why a timeline op can't run right now, in the caller's terms.
 *
 *  B-083/D-203 — this was a fixed `{ error: 'no timeline — open a project
 *  first' }` object, which is now also what an agent would see during the
 *  brief reload a project *switch* triggers: telling it to open the project
 *  it just opened. The store already distinguishes the three real cases
 *  (`openProjectKey`/`status`), so say which one it is. */
function noTimeline(): { error: string } {
  const s = useEditorTimelineStore.getState();
  if (s.openProjectKey === null) return { error: 'no timeline — open a project first' };
  if (s.status === 'error') return { error: `the open project's timeline failed to load: ${s.error}` };
  // A project IS open and the fetch isn't in a failed state, so the only thing
  // between the caller and a timeline is the fetch itself still being in
  // flight — which, for a caller that just switched projects, it briefly is.
  return { error: 'the timeline is still loading (the project was just opened or switched) — retry' };
}

/** Mount once from `EditorTab.tsx`. No arguments — see this file's own
 *  module doc comment for why (both stores it reads are module-level). */
export function useEditorControl(): void {
  useEffect(() => {
    const OPS: Record<string, (args: any) => any> = {
      // ---- read / seek / selection ----------------------------------------
      editor_get_state: () => {
        const s = useEditorTimelineStore.getState();
        return {
          projectOpen: s.openProjectKey !== null,
          // B-083 — *which* project the Edit tab believes is open, so a
          // stale-state report like that one is answerable from one call.
          openProject: s.openProjectKey,
          status: s.status,
          error: s.error,
          playhead: s.playhead,
          playing: s.playing,
          hasTimeline: !!s.timeline,
          // What is selected right now — the same `selection`/`selectedGap`
          // pair every selection path writes (timeline click, marquee, canvas
          // click-to-select), so a caller can both read the user's current
          // selection and confirm its own selecting gesture landed.
          //
          // Added while chasing B-085's follow-up: selection was the one piece
          // of Edit-tab state NOTHING outside the webview could observe, so a
          // selection bug could only be caught by eyeballing the window — which
          // is precisely how the WKWebView half of B-085 shipped as "fixed".
          // D-216 — `editor_set_selection` is the write half of this pair.
          selection: s.selection,
          selectedGap: s.selectedGap,
        };
      },

      editor_get_timeline: () => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
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

      // D-216 (roadmap item 26) — the WRITE half of `editor_get_state`'s
      // `selection`/`selectedGap`, which were readable and not writable, so
      // nothing outside a human's mouse could put a clip into the state where
      // `TransformOverlay` even mounts. That left the entire on-canvas
      // transform surface agent-undrivable and agent-unverifiable, which is
      // exactly how D-209/B-093 had to ship with its pointer tier unchecked.
      //
      // **Deliberately NOT an `EditOp`, and deliberately not undoable** — see
      // D-216. `selection`/`selectedGap` are fields of the STORE, not of
      // `Timeline`, so D-051's whole-`Timeline` undo snapshots have never
      // carried selection and nothing here persists to `project.json`. Every
      // GUI selection path (`TimelinePane`'s clip click, its marquee, its
      // empty-area gap click, `useCanvasClipPick`'s rule 6) calls the same two
      // plain store actions and pushes nothing onto the shared history, so an
      // MCP selection that WAS undoable would behave differently from the
      // identical human click AND would sit between the user and their last
      // real edit on the next cmd-Z.
      //
      // Drives the SAME `setSelection`/`setSelectedGap` pair, in the same
      // order those paths call them — not a parallel selection path.
      editor_set_selection: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();

        const clipsArg = a?.clips;
        const gapArg = a?.gap;
        const hasClips = clipsArg !== undefined && clipsArg !== null;
        const hasGap = gapArg !== undefined && gapArg !== null;
        // D-105 — a clip selection and a gap selection are mutually exclusive
        // in the store itself (each setter clears the other), so asking for
        // both is a caller error with no meaningful answer, not something to
        // silently resolve by picking one.
        if (hasClips && hasGap) {
          return { error: 'clips and gap are mutually exclusive (D-105) — pass one or the other, not both' };
        }
        if (!hasClips && !hasGap) {
          return {
            error:
              'pass clips (an array of {track, clip} or {track, clipId}; [] clears everything) or gap ({track, frame})',
          };
        }

        const { setSelection, setSelectedGap } = useEditorTimelineStore.getState();

        if (hasGap) {
          const track = Math.round(Number(gapArg?.track));
          const tr = tl.tracks[track];
          if (!tr) return { error: `no track ${track} (0..${tl.tracks.length - 1})` };
          const frame = Math.round(Number(gapArg?.frame));
          if (!Number.isFinite(frame)) return { error: 'gap.frame must be a finite timeline frame' };
          // The SAME `gapAt` test `TimelinePane`'s own empty-area click makes
          // before it selects a gap, and the same one `remove_gap`'s reducer
          // makes before it closes one — so this op can never produce a gap
          // selection the GUI could not have produced, or one `editor_remove_gap`
          // would then refuse as a no-op.
          const gap = gapAt(tr, frame, timelineFps(tl));
          if (!gap) {
            return {
              error: `frame ${frame} on track ${track} is not inside a real, closeable gap (a gap needs a clip after it — trailing empty space past the last clip is not one)`,
            };
          }
          setSelection([]);
          setSelectedGap({ track, frame });
          const after = useEditorTimelineStore.getState();
          return {
            ok: true,
            selection: after.selection,
            selectedGap: after.selectedGap,
            // The gap's real bounds, so a caller can hand `gapStart` straight
            // to `editor_remove_gap` (or measure what closing it would shift)
            // without a second round trip.
            gapStart: gap.gapStart,
            gapEnd: gap.gapEnd,
            singleClipSelected: false,
          };
        }

        if (!Array.isArray(clipsArg)) {
          return { error: 'clips must be an array of {track, clip} or {track, clipId} ([] clears the selection)' };
        }
        const resolved: ResolvedSelectionClip[] = [];
        for (const entry of clipsArg) {
          const hit = resolveSelectionEntry(tl, entry);
          if ('error' in hit) return hit;
          // A repeated clip is meaningless in a selection — the GUI's own
          // cmd-click toggle can never produce one — so it is dropped rather
          // than failing the whole call, and the read-back below shows the
          // caller exactly what it got.
          if (!resolved.some((r) => r.track === hit.track && r.id === hit.id)) resolved.push(hit);
        }

        const next: Selection[] = resolved.map((r) => ({ track: r.track, id: r.id }));
        setSelectedGap(null);
        setSelection(next);

        const after = useEditorTimelineStore.getState();
        return {
          ok: true,
          selection: after.selection,
          selectedGap: after.selectedGap,
          clips: resolved,
          // The one derived fact this op exists to make reachable: the
          // on-canvas transform box (`TransformOverlay`) and the Inspector's
          // clip form both draw only for a selection of EXACTLY one clip —
          // the Phase-1 multi-select fallback both already apply. A caller
          // driving/verifying the canvas surface needs this to be true; a
          // clip whose track is `trackLocked` still gets the box but no
          // draggable corner handles.
          singleClipSelected: after.selection.length === 1,
        };
      },

      // ---- media pool -------------------------------------------------------
      editor_import_media: async (a) => {
        const paths: unknown = a?.paths;
        if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string') || paths.length === 0) {
          return { error: 'paths must be a non-empty array of absolute file paths' };
        }
        const result = await useMediaPoolStore.getState().importPaths(paths as string[], a?.folder);
        if (!result.ok) return { error: result.error ?? 'import failed' };
        // B-073/B-082's own root mechanism: `chroma_media_import`'s Rust side
        // reports `added: []` for a path already in the pool's DISK manifest
        // (e.g. seeded by `new_project`'s own `media_paths`, which never goes
        // through this store's `importPaths` at all) — but `useMediaPoolStore
        // .items` (this store, populated ONLY by `importPaths` appending its
        // own `added` or by an explicit `refresh()`) stays EMPTY for that item
        // regardless, since nothing ever appended it. `editor_add_clip`'s own
        // lookup reads `items`, so it fails with "no pool item matching" for
        // a path this very tool just reported success for. Mirrors the same
        // "added came back empty, refresh anyway" fallback `main.tsx`'s own
        // `onMotionRendered` already uses for the identical symptom.
        let added = result.added ?? [];
        if (added.length === 0) {
          await useMediaPoolStore.getState().refresh();
          const items = useMediaPoolStore.getState().items;
          const pathSet = new Set(paths as string[]);
          added = items.filter((m) => pathSet.has(m.sourcePath));
        }
        return {
          ok: true,
          added: added.map((m) => ({
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

      // Roadmap item 23 (2026-09-07) — the minimal fix for "the media pool
      // has no way to recover a stuck/wrong item": wrap the SAME
      // `chroma_media_remove`/`removeMedia` path `SourcesPanel.tsx`'s own
      // delete UI already uses, not new removal logic. Reports which
      // requested ids are still referenced (via `Clip.media_id`) by a clip
      // on the ACTIVE timeline before removing them, since that is the one
      // honest thing worth telling a caller: `chroma_media_remove` does not
      // touch clips at all (see its own Rust doc), and a `Clip`'s
      // `source_path` is an independent copy resolved at drop time, never
      // re-read from the pool afterward — so a referenced clip does NOT go
      // offline, error, or get cascade-removed. Only its `media_id`
      // back-link goes stale (harmless: nothing re-resolves a clip through
      // it at playback/render time, only legacy shot-grade migration does).
      editor_remove_media: async (a) => {
        const ids: unknown = a?.ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || ids.length === 0) {
          return { error: 'ids must be a non-empty array of media-pool item ids' };
        }
        const idSet = new Set(ids as string[]);
        const tl = useEditorTimelineStore.getState().timeline;
        const stillReferencedBy: { track: number; clip: number; clipId: string; mediaId: string }[] = [];
        if (tl) {
          tl.tracks.forEach((tr, trackIdx) => {
            tr.clips.forEach((c, clipIdx) => {
              if (c.media_id && idSet.has(c.media_id)) {
                stillReferencedBy.push({ track: trackIdx, clip: clipIdx, clipId: c.id, mediaId: c.media_id });
              }
            });
          });
        }
        const result = await useMediaPoolStore.getState().removeMedia(ids as string[]);
        if (!result.ok) return { error: result.error ?? 'remove failed' };
        return { ok: true, removed: ids, stillReferencedBy };
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

      // ---- text / title clips (D-211) --------------------------------------
      // The AI half of the same primitive the Edit tab's own "Add title"
      // button drives, both through the SAME `newTextClipFields` + `add_clip`
      // / `set_text_clip` ops (CLAUDE.md: "the same op/store action
      // underneath both"). No new placement path: a title is a `Clip`, so it
      // is placed by the ordinary `add_clip` op and gets ripple / explicit
      // `startFrame` / auto track creation for free.
      editor_text_fonts: async () => {
        const fonts = await loadTextFonts();
        // The exact layer a title gets with nothing specified — reported so a
        // caller can see the real defaults rather than infer them, and built
        // by the same validator every write path uses. `newTextLayer({})`
        // cannot fail (an empty patch is always valid), but the union is
        // narrowed rather than cast: a cast would silently start lying if
        // that ever stopped being true.
        const defaults = newTextLayer({});
        return {
          ok: true,
          fonts: fonts.map((f) => ({ key: f.key, label: f.label, available: f.path !== null })),
          defaultTitle: 'error' in defaults ? null : defaults,
        };
      },

      editor_add_text_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();

        const layer = newTextLayer({
          content: typeof a?.content === 'string' ? a.content : '',
          font: a?.font !== undefined ? String(a.font) : undefined,
          size: a?.size !== undefined ? Number(a.size) : undefined,
          color: a?.color !== undefined ? String(a.color) : undefined,
        });
        if ('error' in layer) return layer;
        if (!layer.content) return { error: 'content must be a non-empty single line of text' };
        // A font key the backend has no file for would compile to a
        // `drawtext` ffmpeg cannot run — refused HERE, at the write, rather
        // than at export time on a timeline the caller has already built.
        const fonts = textFontsSync();
        const known = fonts.find((f) => f.key === layer.font);
        if (fonts.length > 0 && !known?.path) {
          const usable = fonts.filter((f) => f.path).map((f) => f.key).join(' | ');
          return { error: `no font file for "${layer.font}" on this machine — one of ${usable} (see editor_text_fonts)` };
        }

        const track = Math.round(Number(a?.track));
        if (!Number.isFinite(track) || track < 0) return { error: 'track must be a track index (0 = topmost)' };
        const fps = timelineFps(tl);
        const duration =
          a?.duration !== undefined
            ? Math.round(Number(a.duration))
            : Math.round(DEFAULT_TITLE_SECONDS * fps);
        if (!Number.isFinite(duration) || duration <= 0) {
          return { error: 'duration must be a positive number of TIMELINE frames' };
        }

        const clip: NewClipFields = newTextClipFields(layer, duration, a?.name);
        useEditorTimelineStore.getState().applyOp({
          kind: 'add_clip',
          track,
          clip,
          startFrame: a?.startFrame !== undefined ? Math.round(Number(a.startFrame)) : undefined,
          ripple: !!a?.ripple,
        });

        const after = useEditorTimelineStore.getState().timeline;
        const placed = after?.tracks[track]?.clips.find((c) => c.id === clip.id);
        if (!placed) {
          return { error: 'add_clip did not place the title — check the track index (and that it is a video track)' };
        }
        return {
          ok: true,
          track,
          clip: after?.tracks[track]?.clips.findIndex((c) => c.id === clip.id) ?? -1,
          clipId: placed.id,
          startFrame: placed.start_frame,
          duration: placed.duration,
          text: placed.text ?? null,
        };
      },

      editor_set_text_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        if (!isTextClip(found.c)) {
          return { error: `clip ${found.clip} on track ${found.track} is a media clip, not a title — editor_set_text_clip only edits text clips` };
        }
        // Only the fields actually mentioned are patched — the reducer merges
        // against the clip's existing layer, so this can never silently reset
        // a title's content while changing its colour.
        const patch: Partial<TextLayer> = {};
        if (a?.content !== undefined) patch.content = String(a.content);
        if (a?.font !== undefined) patch.font = String(a.font);
        if (a?.size !== undefined) patch.size = Number(a.size);
        if (a?.color !== undefined) patch.color = String(a.color);
        if (Object.keys(patch).length === 0) {
          return { error: 'nothing to change — pass at least one of content / font / size / color' };
        }
        // Validate here, where there is somewhere to report to: `applyOp`'s
        // own reducer is pure and can only no-op on a bad patch.
        const merged = newTextLayer(patch, found.c.text ?? null);
        if ('error' in merged) return merged;
        const fonts = textFontsSync();
        const known = fonts.find((f) => f.key === merged.font);
        if (fonts.length > 0 && !known?.path) {
          const usable = fonts.filter((f) => f.path).map((f) => f.key).join(' | ');
          return { error: `no font file for "${merged.font}" on this machine — one of ${usable} (see editor_text_fonts)` };
        }

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_text_clip',
          track: found.track,
          clip: found.clip,
          patch,
        });
        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return { ok: true, track: found.track, clip: found.clip, text: after?.text ?? null };
      },

      editor_split_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const atFrame = Math.round(Number(a?.atFrame));
        if (!Number.isFinite(atFrame)) return { error: 'atFrame must be a finite number' };
        useEditorTimelineStore.getState().applyOp({ kind: 'split', track: found.track, clip: found.clip, atFrame });
        return { ok: true, track: found.track };
      },

      editor_remove_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: found.track, clip: found.clip });
        return { ok: true, track: found.track };
      },

      editor_remove_gap: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const track = Math.round(Number(a?.track));
        const frame = Math.round(Number(a?.frame));
        if (!Number.isFinite(frame)) return { error: 'frame must be a finite number' };
        useEditorTimelineStore.getState().applyOp({ kind: 'remove_gap', track, frame });
        return { ok: true, track };
      },

      editor_trim_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const edge = a?.edge === 'start' ? 'trim_start' : a?.edge === 'end' ? 'trim_end' : null;
        if (!edge) return { error: `edge must be "start" or "end"` };
        const delta = Math.round(Number(a?.delta));
        if (!Number.isFinite(delta)) return { error: 'delta must be a finite number of frames' };
        useEditorTimelineStore.getState().applyOp({ kind: edge, track: found.track, clip: found.clip, delta });
        return { ok: true, track: found.track };
      },

      // D-195 — Task 1 (docs/notes/timeline-editing-feature-gap-analysis.md
      // item 1): slip the clip's source window without moving it on the
      // timeline. `delta` is the same TIMELINE-frame-delta convention
      // `editor_trim_clip` uses.
      editor_slip_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const delta = Math.round(Number(a?.delta));
        if (!Number.isFinite(delta)) return { error: 'delta must be a finite number of frames' };
        useEditorTimelineStore.getState().applyOp({ kind: 'slip', track: found.track, clip: found.clip, delta });
        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          sourceStart: after?.source_start ?? found.c.source_start,
          duration: after?.duration ?? found.c.duration,
        };
      },

      editor_move_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
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

      // D-195 — Task 2 (docs/notes/timeline-editing-feature-gap-analysis.md
      // item 2): replace a clip's underlying source media in place, keeping
      // start_frame/transform/keyframes/fades/link_group exactly as they
      // were. Resolves the NEW media the same way `editor_add_clip` resolves
      // a dropped one (mediaId or sourcePath, looked up in the pool, real
      // frame count required) — the pure `swap_media` `EditOp` itself has no
      // access to the media pool store, so this is where that lookup has to
      // happen; see the op's own doc in `timeline.ts` for the re-clamp
      // policy when the new source is shorter than the clip's current
      // [source_start, source_start+duration) window.
      editor_swap_clip_media: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        const items = useMediaPoolStore.getState().items;
        const media = items.find((m) => m.id === a?.mediaId || m.sourcePath === a?.sourcePath);
        if (!media) return { error: `no pool item matching mediaId/sourcePath — call editor_import_media first` };
        const frames = media.video?.frameCount;
        if (!frames || frames <= 0) return { error: `${media.name} has no known frame count (offline, or not a probeable video)` };

        useEditorTimelineStore.getState().applyOp({
          kind: 'swap_media',
          track: found.track,
          clip: found.clip,
          media_id: media.id,
          source_path: media.sourcePath,
          source_len: frames,
          source_fps: media.video?.fps ?? undefined,
        });

        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          sourcePath: after?.source_path ?? media.sourcePath,
          sourceStart: after?.source_start ?? 0,
          duration: after?.duration ?? 0,
          sourceLen: after?.source_len ?? frames,
          sourceFps: after?.source_fps ?? null,
        };
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
        if (!tl) return noTimeline();
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
        // D-211 — a TEXT clip only honours opacity and position, in BOTH
        // renderers (`chroma::edit::resolve_text_clip_transform`, and the
        // export's `drawtext`, which has no scale/rotate/crop at all). Refuse
        // a non-default value for one of the others rather than storing it
        // and rendering nothing: a silently-ignored transform value is
        // exactly B-053, and an agent that set `scale` and saw no change
        // would have no way to find out why. Restating a field at its own
        // default is fine — the GUI's own transform form does it on every
        // write.
        if (isTextClip(c)) {
          const ignored = (
            [
              ['scale', a?.scale, 1],
              ['rotation', a?.rotation, 0],
              ['crop_left', a?.crop_left, 0],
              ['crop_top', a?.crop_top, 0],
              ['crop_right', a?.crop_right, 0],
              ['crop_bottom', a?.crop_bottom, 0],
              ['box_width', a?.box_width, null],
              ['box_height', a?.box_height, null],
            ] as const
          )
            .filter(([, v, dflt]) => v !== undefined && v !== null && Number(v) !== dflt)
            .map(([name]) => name);
          if (ignored.length > 0) {
            return {
              error: `a text clip only supports opacity and position_x/position_y — ${ignored.join(', ')} would be silently ignored by both the preview and the export. Use the title's own \`size\` (editor_set_text_clip) to make it bigger.`,
            };
          }
        }
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
        if (!tl) return noTimeline();
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

      // ---- export (Phase 2/3, D-183; D-201 real audio mixing; D-198
      // extracted the real body into `editorExport.ts` so the Edit tab's own
      // GUI Export dialog + queue can call the EXACT same compile+run logic
      // rather than a parallel implementation) --------------------------
      editor_export: (a) => runEditorExport(a ?? {}),

      // ---- interchange export (D-196) — timelineInterchange.ts compiles the
      // Timeline to a real FCPXML 1.7 document; chroma_write_text_file just
      // writes the string to disk. See timelineInterchange.ts's own header
      // doc for the full, precise scope (what maps, what doesn't) and D-196
      // in docs/08-decisions.md for the field-mapping table. -----------------
      editor_export_fcpxml: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();

        const outPath = a?.outPath;
        if (typeof outPath !== 'string' || !outPath) return { error: 'outPath must be a non-empty absolute file path' };
        const width = Math.round(Number(a?.width));
        const height = Math.round(Number(a?.height));
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          return { error: 'width and height must be positive numbers (the output composition size)' };
        }
        let fps: number | undefined;
        if (a?.fps !== undefined) {
          fps = Number(a.fps);
          if (!Number.isFinite(fps) || fps <= 0) return { error: 'fps must be a positive number' };
        }

        // Real per-clip native resolution/hasAudio, when known — the media
        // pool's own probed `MediaItem.video` for whichever pool item
        // `Clip.media_id` names (D-070's unified clip identity). Closes the
        // exact "this pure module can't probe a source file" gap
        // `timelineInterchange.ts`'s own `ClipSourceInfo` doc names — a clip
        // built before D-070, or from an offline/unprobed source, simply has
        // no entry and the compiler falls back to its own documented
        // canvas-aspect approximation (surfaced in `warnings`).
        const poolItems = useMediaPoolStore.getState().items;
        const sourceInfo: Record<string, ClipSourceInfo> = {};
        for (const track of tl.tracks) {
          for (const clip of track.clips) {
            if (!clip.media_id) continue;
            const item = poolItems.find((m) => m.id === clip.media_id);
            if (!item?.video) continue;
            sourceInfo[clip.id] = {
              width: item.video.width,
              height: item.video.height,
              hasAudio: item.video.hasAudio ?? undefined,
            };
          }
        }

        const { xml, warnings } = buildFcpxml(tl, {
          fps,
          width,
          height,
          projectName: typeof a?.projectName === 'string' ? a.projectName : undefined,
          sourceInfo,
        });

        try {
          await invoke('chroma_write_text_file', { path: outPath, contents: xml });
        } catch (e) {
          return { error: `failed to write ${outPath}: ${String(e)}` };
        }

        return { ok: true, outPath, warnings };
      },

      // ---- fade (D-147) + duck (D-149) — moved from useChromaControl.ts ---
      editor_set_clip_fade: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
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
        if (!tl) return noTimeline();
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

    // D-211/D-212 — warm the font catalogue once, at Edit-tab mount. The
    // export compiler reads it SYNCHRONOUSLY (the queue compiles a job's argv
    // at enqueue time, D-198), so it has to already be there; doing it here
    // rather than lazily at the first export means a title's font is resolved
    // long before anyone can queue one. Idempotent — see `textFonts.ts`.
    void loadTextFonts();

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
        const result = await fn(opArgs(args));
        const error = opError(result);
        respond({ ok: !error, error, result });
      } catch (e) {
        respond({ ok: false, error: thrownMessage(e), result: null });
      }
    });

    return () => {
      safeUnlisten(unlistenP);
    };
    // D-201 — `[]` is honest, and the suppression that used to sit here is
    // gone. `useEditorControl` takes no arguments and this effect closes over
    // nothing from a component scope: every store it touches is reached
    // through `getState()` on a module-level store, and `EDITOR_OP_PREFIX`,
    // `listen`/`emit` and `safeUnlisten` are module-level too. Suppressing ANY
    // react-hooks lint rule also switches the React Compiler off for the whole
    // file (see `docs/notes/react-compiler-coverage.md`), so a stale
    // suppression is not free.
  }, []);
}
