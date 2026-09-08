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
 *
 * **D-222 — timeline markers.** `editor_add_marker` / `editor_list_markers` /
 * `editor_set_marker` / `editor_remove_marker`, driving the same
 * `add_marker`/`set_marker`/`remove_marker` `EditOp`s the ruler's own flag
 * strip does. Unlike `editor_set_selection` (D-216) and
 * `editor_set_preview_zoom` (D-218), which write store-only view state, these
 * write real document content: a marker is persisted into `project.json` and
 * undone by the ordinary shared undo stack.
 *
 * **D-226 — transitions.** `editor_list_transitions` / `_add_transition` /
 * `_set_transition` / `_remove_transition`, driving the same
 * `add_transition`/`set_transition`/`remove_transition` `EditOp`s the
 * timeline's own palette drag and badge popover do. Every one takes a `track`
 * (unlike the marker ops above): a transition lives at a cut on ONE track.
 * `transitionDto` reports each one's DERIVED window and handle split alongside
 * its stored fields, and `editor_list_transitions` also reports each video
 * track's real `cuts` — an agent's first question is "where can one go", and
 * neither answer is obvious from the raw fields. Every write runs the same
 * `checkTransition` the GUI does first, so an agent gets the real reason a
 * human would rather than a silent no-op from the reducer.
 */
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';

import { useMediaPoolStore } from '@chroma/bridge';

import { useEditorTimelineStore, type Selection } from './timelineStore';
// D-233 — the curve editor's own model helpers, shared verbatim with the GUI
// (`ClipCurveEditor.tsx` / `EditorInspectorPanel.tsx`) rather than reimplemented
// here: one write path for the human and the agent, per CLAUDE.md.
import { animatedParams, paramKeyframeFrames, setClipKeyframeEase } from './clipKeyframes';
import {
  clipOutputSourceFrames,
  timelineDuration,
  CLIP_KEYFRAME_DEFAULTS,
  EASE_PRESETS,
  DEFAULT_EASE_CURVE,
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_TITLE_SECONDS,
  EQ_BAND_KINDS,
  describeEqBand,
  eqBandsForDisplay,
  eqKindUsesGain,
  eqResponseDb,
  easePresetName,
  hasActiveEq,
  gapAt,
  isAdjustmentClip,
  isCaptionClip,
  isTextClip,
  ADJUSTMENT_PARAMS,
  newCaptionClipFields,
  MARKER_COLORS,
  markersOf,
  newAdjustmentClipFields,
  newAdjustmentLayer,
  newMarker,
  newTextClipFields,
  newTextLayer,
  panGains,
  resolveMarkerColor,
  timelineFps,
  trackIndexAfterMove,
  checkTransition,
  cutFrames,
  newTransition,
  transitionHandles,
  transitionWindow,
  transitionsOf,
  TRANSITION_ALIGNMENTS,
  TRANSITION_KINDS,
  DEFAULT_TRANSITION_FRAMES,
  type AdjustmentLayer,
  type ClipKeyframeParam,
  type EaseCurve,
  type Clip,
  type EqBand,
  type EqBandKind,
  type Marker,
  type NewClipFields,
  type CaptionStyle,
  type TextLayer,
  type Timeline,
  type Transition,
  type TransitionAlignment,
  type TransitionKind,
} from './timeline';
import {
  applyDynamicZoom,
  defaultDynamicZoomEnd,
  dynamicZoomFramings,
  dynamicZoomIsStatic,
  dynamicZoomSpan,
  type DynamicZoomFraming,
} from './dynamicZoom';
import { scrubSourceAt, waveformWindowAt, WAVEFORM_WINDOW_SECS } from './scrubSource';
// D-236 — the speed ramp. `MIN_SPEED`/`MAX_SPEED` are shared with the GUI and
// with Rust so an agent, the Inspector and the preview all agree on the range.
import { MIN_SPEED, MAX_SPEED, resolveSpeedSegments, type SpeedPoint } from './speedRamp';

/** D-236/D-240 — is this a speed an agent may store?
 *
 *  Refused, not clamped: a speed outside the range is a request the caller got
 *  wrong, and silently retiming to 20x instead of the 200x it asked for is
 *  worse than saying so. (The MODEL still clamps — `chroma_timeline_set`
 *  stores whatever it is handed, so a document reaching the store another way
 *  must degrade safely; see `clampSpeed`.)
 *
 *  D-240 — the range is on the MAGNITUDE and either sign is accepted, which is
 *  the whole difference between "this tool cannot reverse a clip" and "it can".
 *  `0` is still refused: it is not slow, it is a clip that never advances. */
function isAcceptableSpeed(speed: number): boolean {
  if (!Number.isFinite(speed)) return false;
  const magnitude = Math.abs(speed);
  return magnitude >= MIN_SPEED && magnitude <= MAX_SPEED;
}

/** The one sentence every speed refusal above ends with, so the flat and the
 *  ramped path cannot describe the same range two different ways. */
const SPEED_RANGE_HELP =
  `must be between ${MIN_SPEED} and ${MAX_SPEED}, or between -${MAX_SPEED} and -${MIN_SPEED} ` +
  `to play that run in reverse (1 = normal, -1 = backwards at recorded speed)`;
import { buildFcpxml, type ClipSourceInfo } from './timelineInterchange';
import { runEditorExport } from './editorExport';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { loadTextFonts, textFontsSync } from './textFonts';
import {
  clampPreviewZoom,
  FIT_ZOOM,
  isFitView,
  MAX_PREVIEW_ZOOM,
  MIN_PREVIEW_ZOOM,
  panLimit,
  previewZoomPct,
} from './previewZoom';

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
      // D-226 — this track's transitions, in cut order, alongside its clips so
      // `editor_get_timeline` stays one call for "what is on this timeline".
      transitions: transitionsOf(t).map(transitionDto),
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
        fadeInCurve: c.fade_in_curve ?? DEFAULT_EASE_CURVE,
        fadeOutCurve: c.fade_out_curve ?? DEFAULT_EASE_CURVE,
        fadeInCurveName: easePresetName(c.fade_in_curve),
        fadeOutCurveName: easePresetName(c.fade_out_curve),
        // D-223 — this clip's own level, so an agent can read it back before
        // deciding what to write (and can tell a clip that is already quiet
        // from a track that is). Defaulted here the same way every field
        // above is: a pre-D-223 clip carries neither key.
        volume: c.volume ?? 1,
        pan: c.pan ?? 0,
        // D-224 — this clip's EQ bands, so an agent can read what is there
        // before deciding what to change, and `eqActive` so it can tell a
        // materialised-but-flat four-band strip (which does NOTHING) from a
        // real filter without re-deriving `is_active` itself. `[]` for a clip
        // with no EQ, defaulted here the same way every field above is.
        eqBands: c.eq_bands ?? [],
        eqActive: hasActiveEq(c.eq_bands),
        // D-211 — `null` for an ordinary media clip; the whole text layer for
        // a title, so a caller can read back what it wrote without a second
        // round trip and can tell the two kinds of clip apart from this one
        // response (there is no `kind` field on a clip — being a title IS
        // having a text layer, see `chroma_timeline::Clip::text`).
        text: c.text ?? null,
      })),
    })),
    // D-222 — reported alongside the tracks so `editor_get_timeline` is still
    // one call for "what is on this timeline". Frame-sorted (`markersOf`), the
    // same order the ruler draws them in.
    markers: markersOf(tl).map(markerDto),
  };
}

/** One marker, in the camelCase-ish shape every `editor_*` response uses.
 *  Flat and near-identical to the stored record — a marker has nothing to
 *  derive — but routed through one function so `editor_get_timeline`,
 *  `editor_list_markers` and each mutating op can never report it differently.
 *  `name`/`note` are normalised to an explicit `null` rather than omitted, so
 *  a caller reading a response never has to distinguish absent from empty. */
function markerDto(m: Marker) {
  return { id: m.id, frame: m.frame, color: m.color, name: m.name ?? null, note: m.note ?? null };
}

/** D-222 — "no marker with that id", with the ids that DO exist, so a caller
 *  that guessed or held a stale id can recover in one round trip. Mirrors
 *  `resolveClip`'s own "no track N (0..M)" convention of naming the valid
 *  range in the error itself. */
/** D-226 — one transition, in the same camelCase-ish shape every `editor_*`
 *  response uses, with its DERIVED window and handle split reported alongside
 *  the stored fields.
 *
 *  Deriving them here rather than leaving an agent to redo
 *  `transitionWindow`/`transitionHandles` from `atFrame`/`duration`/`alignment`
 *  is the whole point: those three numbers do not obviously add up to "which
 *  frames does this cover and which clip pays for it", and an agent that
 *  guessed would guess the integer halving wrong. One function, so
 *  `editor_get_timeline`, `editor_list_transitions` and each mutating op can
 *  never report it differently. */
function transitionDto(t: Transition) {
  const { start, end } = transitionWindow(t);
  const { head, tail } = transitionHandles(t);
  return {
    id: t.id,
    kind: t.kind,
    atFrame: t.at_frame,
    duration: t.duration,
    alignment: t.alignment ?? 'center_at_cut',
    color: t.color ?? null,
    windowStartFrame: start,
    windowEndFrame: end,
    headHandleFrames: head,
    tailHandleFrames: tail,
  };
}

/** D-226 — "no transition with that id on this track", with the ids that DO
 *  exist. Same one-round-trip-recovery convention `markerNotFound` uses. */
function transitionNotFound(tl: Timeline, track: number, id: string): string {
  const ids = (tl.tracks[track]?.transitions ?? []).map((t) => t.id);
  return ids.length === 0
    ? `no transition "${id}" — track ${track} has none`
    : `no transition "${id}" on track ${track} — existing ids: ${ids.join(', ')}`;
}

function markerNotFound(tl: Timeline, id: string): string {
  const ids = (tl.markers ?? []).map((m) => m.id);
  return ids.length === 0
    ? `no marker "${id}" — this timeline has no markers`
    : `no marker "${id}" — existing ids: ${ids.join(', ')}`;
}

/** A fade curve arrives as either a preset name ("ease-in") or four control
 *  points (`[x1,y1,x2,y2]` or `{x1,y1,x2,y2}`) — copied verbatim from the
 *  pre-D-183 `set_clip_fade`. An unknown NAME is reported rather than
 *  silently substituted. */
function parseCurve(v: unknown, which: string): EaseCurve | { error: string } | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const hit = EASE_PRESETS.find((p) => p.name === v);
    return (
      hit?.curve ?? {
        error: `unknown ${which} "${v}" — one of ${EASE_PRESETS.map((p) => p.name).join(' | ')}, or four control points [x1,y1,x2,y2]`,
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
/** D-224 — the frequencies `editor_set_clip_eq` reports its resulting curve
 *  at: the standard decade/half-decade grid an EQ is actually read on, and the
 *  same axis labels Resolve's own Clip Equalizer graph carries
 *  (`scratch/resolve-reference/soundtrack.jpg`: 62 · 250 · 1K · 4K · 16K),
 *  extended at the bottom so a high-pass's own effect is visible.
 *
 *  Reported because an agent cannot otherwise tell what it did: "I set band 2
 *  to −6 dB at 950 Hz" says nothing about the CURVE, which is the sum of every
 *  band. This is the same "return the measurement, for free" contract the
 *  grading tools hold to. */
const EQ_REPORT_FREQS = [60, 120, 250, 500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** D-229 — how long a caption added with no explicit `duration` lasts.
 *
 *  Two seconds, not `DEFAULT_TITLE_SECONDS`: a caption is a line of speech,
 *  and two seconds is the middle of the broadcast-standard range for one
 *  (roughly 1–6 s, at ~17 characters per second). A title's default is a
 *  different thing for a different job, which is why this is its own constant
 *  rather than a reuse. */
const DEFAULT_CAPTION_SECONDS = 2;

/** D-229 — one cue as `chroma_import_subtitles` returns it: already parsed
 *  and already converted to the project's own timebase by the Rust side. */
interface ImportedCaption {
  id: string;
  start_frame: number;
  duration: number;
  text: string;
}

/** D-229 — the `CaptionStyle` fields present in a control-op's arguments, and
 *  only those.
 *
 *  **Only what was actually passed** — an absent key must not become a
 *  default, or "change the colour" would silently reset the size, the
 *  position and the box. The same patch discipline `editor_set_text_clip`
 *  follows, factored out here because both the track style and the per-cue
 *  override read it. */
function captionStylePatch(a: any): Partial<CaptionStyle> {
  const patch: Partial<CaptionStyle> = {};
  if (a?.font !== undefined) patch.font = String(a.font);
  if (a?.size !== undefined) patch.size = Number(a.size);
  if (a?.color !== undefined) patch.color = String(a.color);
  if (a?.boxEnabled !== undefined) patch.box_enabled = !!a.boxEnabled;
  if (a?.boxColor !== undefined) patch.box_color = String(a.boxColor);
  if (a?.boxOpacity !== undefined) patch.box_opacity = Number(a.boxOpacity);
  if (a?.boxPadding !== undefined) patch.box_padding = Number(a.boxPadding);
  if (a?.lineSpacing !== undefined) patch.line_spacing = Number(a.lineSpacing);
  if (a?.align !== undefined) {
    const v = String(a.align);
    // Anything else is dropped rather than stored: the model would carry a
    // value neither renderer knows, which both would then silently treat as
    // "centre" — an invisible wrong answer.
    if (v === 'left' || v === 'center' || v === 'right') patch.align = v;
  }
  if (a?.positionX !== undefined) patch.position_x = Number(a.positionX);
  if (a?.positionY !== undefined) patch.position_y = Number(a.positionY);
  return patch;
}

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
          // D-218 — the preview's VIEWPORT zoom/pan. Reported because a
          // screenshot of the preview is uninterpretable without it: at a
          // non-fit view the picture on screen is a crop of the composition,
          // so "the clip is off the left edge" may mean the clip moved or may
          // mean the viewport is panned. Display-only — it is not any clip's
          // `scale`/`position_*` and changes nothing about what renders.
          previewZoom: {
            zoom: s.previewView.zoom,
            pct: previewZoomPct(s.previewView.zoom),
            panX: s.previewView.panX,
            panY: s.previewView.panY,
            fit: isFitView(s.previewView),
          },
          // D-232 — whether the viewer's audio waveform strip is showing. The
          // read half of `editor_set_waveform_view`, and reported for the same
          // reason `previewZoom` above is: a screenshot of the preview is
          // ambiguous without it (the strip changes what the transport area
          // even contains).
          waveformView: s.waveformView,
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

      // ---- D-232: the waveform strip, both halves --------------------------
      //
      // CLAUDE.md's standing rule is that a GUI affordance and an MCP surface
      // land together, driving the same store action. These two are that for
      // roadmap item 27's waveform half.
      //
      // **The scrub half deliberately has no tool of its own**, and that is a
      // decision rather than an omission: tape-scrub is a live pointer drag
      // whose entire content is "audio, now, while my hand moves" — an agent
      // cannot hear it, and there is nothing a `editor_scrub(from, to)` would
      // do that `editor_set_playhead` does not already do better and
      // observably. What an agent actually needs from the same capability is
      // the *information* a human gets by ear, and that is
      // `editor_get_waveform` below: the same envelope the strip draws, as
      // numbers. See D-232.

      editor_set_waveform_view: (a) => {
        if (a?.open === undefined || a?.open === null) {
          return { error: 'pass open: true to show the waveform strip, false to hide it' };
        }
        useEditorTimelineStore.getState().setWaveformView(!!a.open);
        return { ok: true, waveformView: useEditorTimelineStore.getState().waveformView };
      },

      editor_get_waveform: async (a) => {
        const s = useEditorTimelineStore.getState();
        if (!s.timeline) return noTimeline();
        const frame = a?.frame === undefined || a?.frame === null ? s.playhead : Math.round(Number(a.frame));
        if (!Number.isFinite(frame)) return { error: 'frame must be a finite timeline frame' };

        // The SAME resolver the strip and the scrub engine use — an agent
        // reading this and a human looking at the strip cannot be told two
        // different things about what is under the playhead.
        const source = scrubSourceAt(s.timeline, frame);
        if (!source) {
          return {
            frame,
            source: null,
            note: 'no audible source under this frame (a gap, a generated clip, a muted track, or past the end)',
          };
        }

        const windowSecs = Number(a?.windowSecs ?? WAVEFORM_WINDOW_SECS);
        if (!Number.isFinite(windowSecs) || windowSecs <= 0) {
          return { error: 'windowSecs must be a positive number of seconds' };
        }
        const buckets = Math.round(Number(a?.buckets ?? 64));
        if (!Number.isFinite(buckets) || buckets <= 0 || buckets > 2000) {
          return { error: 'buckets must be between 1 and 2000' };
        }

        const win = waveformWindowAt(source, timelineFps(s.timeline), windowSecs);
        // Straight to the backend at the caller's own bucket count rather than
        // through `getPeaks`'s tile cache: an agent asks once for a specific
        // window, where the strip asks continuously for a sliding one, so the
        // tiling that makes the strip cheap would only add a re-bucketing step
        // here. Rust caches the decode either way (D-128).
        const peaks = await invoke<[number, number][]>('chroma_audio_waveform', {
          sourcePath: win.path,
          startSecs: win.startSecs,
          durationSecs: win.durationSecs,
          buckets,
        });
        return {
          frame,
          source: {
            path: source.path,
            sourceSecs: source.sourceSecs,
            track: source.track,
            clipId: source.clip.id,
            // B-110 — the level this source is MONITORED at, which is also the
            // level playback mixes it at (`track.gain × clip.volume`). An agent
            // cannot hear that a scrub is 8 dB hot, so it gets the number: this
            // is the same "the envelope as numbers" reasoning D-232 used to
            // justify shipping no `editor_scrub` at all. Note the `peaks` below
            // are the SOURCE's own, unscaled — this is what they are heard at.
            gain: source.gain,
          },
          window: {
            startSecs: win.startSecs,
            durationSecs: win.durationSecs,
            playheadFraction: win.playheadFraction,
            clipStartFraction: win.clipStartFraction,
            clipEndFraction: win.clipEndFraction,
          },
          // `[min, max]` per bucket, both in -1..1 — exactly what the strip
          // draws and what `chroma_audio_waveform` returns.
          peaks,
        };
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

      // D-218 (roadmap item 25) — the AI half of the preview's viewport zoom,
      // landed in the same pass as its GUI half (CLAUDE.md: a GUI-only
      // control is half a feature). Same store action the toolbar buttons and
      // the ctrl-wheel gesture drive, so there is one clamping rule and one
      // source of truth, not a parallel path.
      //
      // **Display-only, and NOT undoable** — exactly D-216's reasoning for
      // `editor_set_selection`: `previewView` is a field of the STORE, not of
      // `Timeline`, so it never reaches `project.json` and D-051's
      // whole-`Timeline` undo snapshots have never carried it. A zoom that
      // sat on the undo stack would put itself between the user and their
      // last real edit on the next cmd-Z.
      editor_set_preview_zoom: (a) => {
        const raw = a?.zoom;
        // `"fit"` is accepted as a name for the default view because that is
        // what the GUI's own reset control is called; it is exactly
        // `zoom: 1, panX: 0, panY: 0`, not a separate mode.
        const wantsFit = raw === 'fit' || raw === null;
        const zoom = wantsFit ? FIT_ZOOM : Number(raw);
        if (raw === undefined) return { error: 'pass zoom (a multiplier, 1 = fit) or zoom="fit"' };
        if (!Number.isFinite(zoom) || zoom <= 0) {
          return { error: `zoom must be a positive multiplier (1 = fit, ${MIN_PREVIEW_ZOOM}..${MAX_PREVIEW_ZOOM}) or "fit"` };
        }
        const clamped = clampPreviewZoom(zoom);
        // Report a request that was out of range rather than silently
        // honouring something else — the same "never a silent no-op" bar
        // every other op here holds to (B-053's shape).
        const clampedNote =
          clamped !== zoom
            ? `zoom ${zoom} is outside ${MIN_PREVIEW_ZOOM}..${MAX_PREVIEW_ZOOM} and was clamped to ${clamped}`
            : undefined;

        // Pan defaults to "keep looking at the same place", except on an
        // explicit fit, which recentres — that is what "fit" means.
        const prev = useEditorTimelineStore.getState().previewView;
        const panX = wantsFit ? 0 : a?.panX !== undefined ? Number(a.panX) : prev.panX;
        const panY = wantsFit ? 0 : a?.panY !== undefined ? Number(a.panY) : prev.panY;
        if (!Number.isFinite(panX) || !Number.isFinite(panY)) {
          return { error: 'panX/panY must be finite numbers (fractions of the fitted picture, 0 = centred)' };
        }

        useEditorTimelineStore.getState().setPreviewView({ zoom: clamped, panX, panY });
        const after = useEditorTimelineStore.getState().previewView;
        return {
          ok: true,
          zoom: after.zoom,
          pct: previewZoomPct(after.zoom),
          panX: after.panX,
          panY: after.panY,
          fit: isFitView(after),
          // The pan a given zoom actually permits, so a caller that wants to
          // look at a corner can compute a legal pan instead of guessing and
          // being clamped.
          panLimit: panLimit(after.zoom),
          note: clampedNote,
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

      // --- Subtitles / captions (D-229) ---------------------------------- //
      //
      // (`captionStylePatch` and `DEFAULT_CAPTION_SECONDS` live just below
      // this hook, next to the other module-level helpers.)
      //
      // Every one of these drives the SAME store op the GUI's own Inspector
      // and Import button drive (CLAUDE.md: "the same op/store action
      // underneath both"), so there is one validation, one undo entry and one
      // reducer per capability rather than a parallel MCP path.

      editor_import_subtitles: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const path = typeof a?.path === 'string' ? a.path : '';
        if (!path) return { error: 'path must be the path to a .srt or .vtt file' };
        // The Rust command does the parsing AND the ms→frames conversion, so
        // the GUI and this path cannot round a cue differently. A parse
        // failure comes back as a real message naming the offending line.
        // Computed BEFORE the `try`, deliberately: the React Compiler bails
        // out of a whole function containing a conditional/optional-chaining
        // "value block" inside a try/catch (D-201 keeps this package at zero
        // bailouts, enforced by `reactCompiler.test.ts`), and a hoisted local
        // reads better here anyway.
        const offsetFrames =
          a?.offsetFrames !== undefined ? Math.round(Number(a.offsetFrames)) : null;
        let imported: { cues: ImportedCaption[]; source_name: string };
        try {
          imported = await invoke<{ cues: ImportedCaption[]; source_name: string }>(
            'chroma_import_subtitles',
            { path, offsetFrames },
          );
        } catch (e) {
          return { error: String(e) };
        }
        if (imported.cues.length === 0) return { error: 'that file contained no cues' };

        const style = captionStylePatch(a);
        useEditorTimelineStore.getState().applyOp({
          kind: 'import_subtitles',
          cues: imported.cues,
          ...(Object.keys(style).length > 0 ? { style } : {}),
        });
        const after = useEditorTimelineStore.getState().timeline;
        return {
          ok: true,
          track: (after?.tracks.length ?? 1) - 1,
          cues: imported.cues.length,
          sourceName: imported.source_name,
        };
      },

      editor_export_subtitles: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const track = Math.round(Number(a?.track));
        const tr = tl.tracks[track];
        if (!tr) return { error: `no track ${track}` };
        if (tr.kind !== 'subtitle') return { error: `track ${track} is not a subtitle track` };
        const path = typeof a?.path === 'string' ? a.path : '';
        if (!path) return { error: 'path must be where to write the .srt or .vtt file' };
        try {
          const written = await invoke<number>('chroma_export_subtitles', { track, path });
          return { ok: true, track, cues: written, path };
        } catch (e) {
          return { error: String(e) };
        }
      },

      editor_add_caption: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const track = Math.round(Number(a?.track));
        const tr = tl.tracks[track];
        if (!tr) return { error: `no track ${track}` };
        // Refused on a video/audio track rather than silently creating a
        // caption the compositor's caption resolver will never find — the
        // resolver only walks subtitle tracks, so this would be an invisible
        // clip.
        if (tr.kind !== 'subtitle') {
          return {
            error: `track ${track} is a ${tr.kind} track — a caption needs a subtitle track (editor_add_track kind="subtitle")`,
          };
        }
        const text = typeof a?.text === 'string' ? a.text : '';
        if (!text.trim()) return { error: 'text must be a non-empty caption' };
        const fps = timelineFps(tl);
        const duration =
          a?.duration !== undefined
            ? Math.round(Number(a.duration))
            : Math.round(DEFAULT_CAPTION_SECONDS * fps);
        if (!Number.isFinite(duration) || duration <= 0) {
          return { error: 'duration must be a positive number of TIMELINE frames' };
        }
        const clip = newCaptionClipFields(text, duration);
        useEditorTimelineStore.getState().applyOp({
          kind: 'add_clip',
          track,
          clip,
          startFrame: a?.startFrame !== undefined ? Math.round(Number(a.startFrame)) : undefined,
        });
        const after = useEditorTimelineStore.getState().timeline;
        const placed = after?.tracks[track]?.clips.find((c) => c.id === clip.id);
        if (!placed) return { error: 'add_clip did not place the caption — is that frame already occupied?' };
        return { ok: true, track, clip: after?.tracks[track].clips.indexOf(placed), id: clip.id };
      },

      editor_set_caption: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        if (!isCaptionClip(found.c)) {
          return { error: `clip ${found.clip} on track ${found.track} is not a caption` };
        }
        if (typeof a?.text !== 'string') return { error: 'text must be a string' };
        useEditorTimelineStore.getState().applyOp({
          kind: 'set_caption_text',
          track: found.track,
          clip: found.clip,
          text: a.text,
        });
        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return { ok: true, track: found.track, clip: found.clip, caption: after?.caption ?? null };
      },

      editor_set_caption_style: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const track = Math.round(Number(a?.track));
        const tr = tl.tracks[track];
        if (!tr) return { error: `no track ${track}` };
        if (tr.kind !== 'subtitle') return { error: `track ${track} is not a subtitle track` };
        if (tr.locked) return { error: `track ${track} is locked — unlock it first` };

        // `useTrackStyle: true` is the reference Inspector's own checkbox:
        // drop a cue's override and go back to the track's style.
        const cueIndex = a?.clip !== undefined && a.clip !== null ? Math.round(Number(a.clip)) : null;
        if (cueIndex !== null && a?.useTrackStyle === true) {
          const c = tr.clips[cueIndex];
          if (!c || !isCaptionClip(c)) return { error: `clip ${cueIndex} on track ${track} is not a caption` };
          useEditorTimelineStore
            .getState()
            .applyOp({ kind: 'set_caption_cue_style', track, clip: cueIndex, patch: null });
          return { ok: true, track, clip: cueIndex, usingTrackStyle: true };
        }

        const patch = captionStylePatch(a);
        if (Object.keys(patch).length === 0) {
          return {
            error:
              'nothing to change — pass at least one of font / size / color / box_enabled / box_color / box_opacity / box_padding / line_spacing / align / position_x / position_y (or useTrackStyle:true with a clip)',
          };
        }
        // A font key the backend has no file for would compile to a
        // `drawtext` ffmpeg cannot run — refused HERE, at the write, exactly
        // as `editor_set_text_clip` does, rather than at export time.
        if (patch.font !== undefined) {
          const fonts = textFontsSync();
          const known = fonts.find((f) => f.key === patch.font);
          if (fonts.length > 0 && !known?.path) {
            const usable = fonts.filter((f) => f.path).map((f) => f.key).join(' | ');
            return { error: `no font file for "${patch.font}" on this machine — one of ${usable} (see editor_text_fonts)` };
          }
        }

        if (cueIndex !== null) {
          const c = tr.clips[cueIndex];
          if (!c || !isCaptionClip(c)) return { error: `clip ${cueIndex} on track ${track} is not a caption` };
          useEditorTimelineStore
            .getState()
            .applyOp({ kind: 'set_caption_cue_style', track, clip: cueIndex, patch });
          const after = useEditorTimelineStore.getState().timeline?.tracks[track]?.clips[cueIndex];
          return { ok: true, track, clip: cueIndex, style: after?.caption?.style ?? null };
        }
        useEditorTimelineStore.getState().applyOp({ kind: 'set_caption_style', track, patch });
        const after = useEditorTimelineStore.getState().timeline?.tracks[track];
        return { ok: true, track, style: after?.caption_style ?? null };
      },

      // ---- adjustment clips (D-230) ----------------------------------------
      // The AI half of the Edit tab's own "Adjust" button, both through the
      // SAME `newAdjustmentClipFields` + `add_clip` / `set_adjustment_clip`
      // ops. No new placement path, exactly as for a title: an adjustment
      // clip is a `Clip`, so `add_clip` places it and ripple / explicit
      // `startFrame` / auto track creation all come for free.

      editor_add_adjustment_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();

        // Every parameter is optional and defaults to identity — adding a
        // neutral adjustment clip and grading it afterwards is a legitimate
        // (and, for an agent working iteratively, the natural) two-step.
        const layer = newAdjustmentLayer({
          exposure: a?.exposure !== undefined ? Number(a.exposure) : undefined,
          contrast: a?.contrast !== undefined ? Number(a.contrast) : undefined,
          saturation: a?.saturation !== undefined ? Number(a.saturation) : undefined,
          temperature: a?.temperature !== undefined ? Number(a.temperature) : undefined,
          tint: a?.tint !== undefined ? Number(a.tint) : undefined,
        });
        if ('error' in layer) return layer;

        const track = Math.round(Number(a?.track));
        if (!Number.isFinite(track) || track < 0) {
          return { error: 'track must be a track index (0 = topmost). An adjustment clip affects the tracks BELOW it, so 0 grades the whole edit' };
        }
        const fps = timelineFps(tl);
        const duration =
          a?.duration !== undefined
            ? Math.round(Number(a.duration))
            : Math.round(DEFAULT_TITLE_SECONDS * fps);
        if (!Number.isFinite(duration) || duration <= 0) {
          return { error: 'duration must be a positive number of TIMELINE frames' };
        }

        const clip: NewClipFields = newAdjustmentClipFields(layer, duration, a?.name);
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
          return { error: 'add_clip did not place the adjustment clip — check the track index (and that it is a video track)' };
        }
        return {
          ok: true,
          track,
          clip: after?.tracks[track]?.clips.findIndex((c) => c.id === clip.id) ?? -1,
          clipId: placed.id,
          startFrame: placed.start_frame,
          duration: placed.duration,
          adjustment: placed.adjustment ?? null,
          // Said explicitly in the RESULT, not just the tool description: the
          // single most common way to get this wrong is to place it on the
          // bottom track and wonder why nothing changed.
          affects: `every visible video track with an index greater than ${track}, for frames ${placed.start_frame}..${placed.start_frame + placed.duration - 1}`,
        };
      },

      editor_set_adjustment_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        if (!isAdjustmentClip(found.c)) {
          return { error: `clip ${found.clip} on track ${found.track} is not an adjustment clip — editor_set_adjustment_clip only edits clips created by editor_add_adjustment_clip` };
        }
        // Only the parameters actually mentioned are patched; the reducer
        // merges against the clip's existing layer, so changing saturation can
        // never silently reset exposure.
        const patch: Partial<AdjustmentLayer> = {};
        for (const key of ADJUSTMENT_PARAMS) {
          if (a?.[key] !== undefined) patch[key] = Number(a[key]);
        }
        if (Object.keys(patch).length === 0) {
          return { error: `nothing to change — pass at least one of ${ADJUSTMENT_PARAMS.join(' / ')}` };
        }
        // Validate here, where there is somewhere to report to: `applyOp`'s
        // reducer is pure and can only no-op on a bad patch.
        const merged = newAdjustmentLayer(patch, found.c.adjustment ?? null);
        if ('error' in merged) return merged;

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_adjustment_clip',
          track: found.track,
          clip: found.clip,
          patch,
        });
        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          adjustment: after?.adjustment ?? null,
        };
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
        // D-235 — `ripple` is the MCP half of the context-sensitive trim
        // tool's ripple mode, the same `EditOp` field the GUI's armed edge
        // drag sets. Absent/false is the pre-D-235 behaviour byte for byte.
        useEditorTimelineStore
          .getState()
          .applyOp({ kind: edge, track: found.track, clip: found.clip, delta, ripple: a?.ripple === true });
        return { ok: true, track: found.track };
      },

      // D-235 — roll and slide, the two genuinely new ops of the
      // context-sensitive trim tool (roadmap item 27). Exposed here in the
      // same pass as the GUI gesture, per CLAUDE.md's human-AND-AI rule:
      // `slip` already had an MCP tool and no gesture (D-195), which is the
      // same half-a-feature gap from the other side.
      editor_roll_edit: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const delta = Math.round(Number(a?.delta));
        if (!Number.isFinite(delta)) return { error: 'delta must be a finite number of frames' };
        useEditorTimelineStore.getState().applyOp({ kind: 'roll', track: found.track, clip: found.clip, delta });
        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          // The out point of the outgoing clip IS the edit point that moved —
          // reporting it back is what lets a caller confirm the roll landed
          // where it asked, including when the clamp shortened it.
          duration: after?.clips[found.clip]?.duration ?? found.c.duration,
        };
      },

      editor_slide_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const delta = Math.round(Number(a?.delta));
        if (!Number.isFinite(delta)) return { error: 'delta must be a finite number of frames' };
        useEditorTimelineStore.getState().applyOp({ kind: 'slide', track: found.track, clip: found.clip, delta });
        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          startFrame: after?.start_frame ?? found.c.start_frame,
        };
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
        // D-229 — an explicit three-way match, not `=== 'audio' ? … : 'video'`.
        // That two-way ternary silently coerced every unrecognised value to
        // 'video', so a caller asking for a subtitle track would have got a
        // video one and no error — and then every caption placed on it would
        // have been invisible. An unknown kind still falls back to 'video'
        // (unchanged), but a real one is now honoured.
        const requested = a?.trackKind;
        const trackKind =
          requested === 'audio' ? 'audio' : requested === 'subtitle' ? 'subtitle' : 'video';
        useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind });
        const tl = useEditorTimelineStore.getState().timeline;
        return { ok: true, track: (tl?.tracks.length ?? 1) - 1 };
      },
      // D-214 — `editor_add_track` only ever APPENDS (roadmap item 24(e)),
      // which lands a newly-added track at the HIGHEST index — the BOTTOM of
      // the z-order stack (D-086: lower track index paints on top). Getting a
      // new track compositing above existing footage needs a second, real
      // move — this wraps the SAME `move_track` primitive `TimelinePane.tsx`'s
      // drag-to-reorder header rows already use, so an agent gets exactly the
      // human GUI's reorder, not a second implementation. Bounds-checked
      // up front (unlike the raw `EditOp`, which silently no-ops out of
      // range) so a bad index comes back as a clear tool error instead of a
      // quiet non-edit.
      editor_move_track: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const from = Math.round(Number(a?.from));
        const to = Math.round(Number(a?.to));
        if (!Number.isFinite(from) || from < 0 || from >= tl.tracks.length) {
          return { error: `no track at from=${a?.from} (timeline has ${tl.tracks.length} track(s))` };
        }
        if (!Number.isFinite(to) || to < 0 || to >= tl.tracks.length) {
          return { error: `no track at to=${a?.to} (timeline has ${tl.tracks.length} track(s))` };
        }
        useEditorTimelineStore.getState().applyOp({ kind: 'move_track', from, to });
        // Selection-follow (same math as `TimelinePane.tsx`'s `doMoveTrack`,
        // `trackIndexAfterMove` in `./timeline`): `move_track` reorders the
        // list WITHOUT changing its length, so `timelineStore.ts::applyOp`'s
        // own generic remap — gated on the list SHRINKING — never fires here.
        // Without this, a human's on-screen clip selection would silently
        // point at the wrong track the moment an agent reorders tracks under
        // it. `selectedGap` is left as-is, matching `doMoveTrack` itself —
        // a gap selection has no stable identity to follow either way.
        useEditorTimelineStore.getState().setSelection((prev) => prev.map((s) => ({ ...s, track: trackIndexAfterMove(s.track, from, to) })));
        return { ok: true, from, to };
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
        // D-230 — the same refusal for an ADJUSTMENT clip, and a wider one:
        // its correction is always FULL-FRAME, so neither geometry field nor
        // the crop insets nor `position_*` mean anything in either renderer.
        // Only `opacity` does (as the correction's mix amount). Refusing is
        // the same B-053 reasoning as the text case above — an agent that set
        // `scale` on an adjustment clip and saw no change would have no way to
        // find out why. Restating a field at its own default stays fine, which
        // is what lets the GUI's own transform form keep writing every field.
        if (isAdjustmentClip(c)) {
          const ignored = (
            [
              ['position_x', a?.position_x, 0],
              ['position_y', a?.position_y, 0],
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
              error: `an adjustment clip's correction is always full-frame — ${ignored.join(', ')} would be silently ignored by both the preview and the export. Only opacity applies (it is how strongly the correction is mixed in); use editor_set_adjustment_clip for the correction itself, and move/trim the clip to change which layers and which span it covers.`,
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
        // D-230 — an ADJUSTMENT clip has nothing keyframeable. Its correction
        // is compiled to ffmpeg filter coefficients that are fixed at filter
        // init, so even its `opacity` (the correction's mix amount, the one
        // transform field it honours at all) is read statically by BOTH
        // renderers. Storing keyframes here would animate nothing anywhere —
        // refused rather than silently ignored, same B-053 reasoning as
        // `editor_set_clip_transform`'s own refusals above. Note this differs
        // from a TEXT clip, whose opacity/position keyframes really do animate.
        if (isAdjustmentClip(found.c) && keyframes.length > 0) {
          return {
            error:
              'an adjustment clip cannot be keyframed — its correction compiles to ffmpeg filter coefficients that are fixed when the filter starts, so both the preview and the export read its opacity statically. Set a constant strength with editor_set_clip_transform\'s `opacity`, or split the clip and give each half its own correction.',
          };
        }
        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_keyframes',
          track: found.track,
          clip: found.clip,
          keyframes,
        });
        return { ok: true, track: found.track, clip: found.clip, count: keyframes.length };
      },

      /**
       * D-233 — set (or clear) the cubic-bezier EASE shaping one animated
       * property's segment, between the keyframe at `frame` and that
       * property's next keyframe.
       *
       * The agent half of the timeline curve editor. `frame` names the key the
       * segment STARTS at, in the clip's own source frames — the same axis
       * `editor_set_clip_keyframes` writes and `editor_get_state` reports.
       * `curve` takes a preset name or four control points, exactly as
       * `editor_set_clip_fade`'s curves do (one parser, `parseCurve`); `null`
       * clears the ease back to linear.
       *
       * Refuses rather than silently doing nothing when the named frame is not
       * actually a keyframe of that property — an agent that mistyped a frame
       * should hear about it, not get `{ok: true}` for a write that changed
       * nothing (the same B-053 posture every refusal in this file takes).
       */
      editor_set_keyframe_ease: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };

        const param = a?.param;
        if (typeof param !== 'string' || !(param in CLIP_KEYFRAME_DEFAULTS)) {
          return { error: `param must be one of ${Object.keys(CLIP_KEYFRAME_DEFAULTS).join(' | ')}` };
        }
        const frame = Number(a?.frame);
        if (!Number.isFinite(frame)) {
          return { error: 'frame must be a number (the clip source frame the segment starts at)' };
        }

        let curve: EaseCurve | null = null;
        if (a?.curve != null) {
          const parsed = parseCurve(a.curve, 'curve');
          if (parsed && 'error' in parsed) return parsed;
          curve = parsed ?? null;
        }

        const before = found.c.chroma_keyframes;
        const next = setClipKeyframeEase(before, frame, param as ClipKeyframeParam, curve);
        if (next === before) {
          const frames = paramKeyframeFrames(before, param as ClipKeyframeParam);
          if (frames.length === 0) {
            return {
              error: `${param} is not animated on this clip — keyframe it first with editor_set_clip_keyframes`,
            };
          }
          if (!frames.includes(Math.round(frame))) {
            return { error: `no ${param} keyframe at frame ${frame} — this clip's are: ${frames.join(', ')}` };
          }
          // A real key, and the write was genuinely a no-op: clearing an ease
          // that was already linear. Honest success, with nothing applied.
          return {
            ok: true,
            track: found.track,
            clip: found.clip,
            param,
            frame: Math.round(frame),
            curve: null,
            changed: false,
          };
        }

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_keyframes',
          track: found.track,
          clip: found.clip,
          keyframes: next ?? [],
        });
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          param,
          frame: Math.round(frame),
          curve,
          curveName: curve ? easePresetName(curve) : 'linear',
          changed: true,
        };
      },

      /**
       * D-233 — open the timeline's curve editor lane on one clip property, or
       * close it (`param: null`).
       *
       * UI state, like `editor_set_preview_zoom` (D-218): it changes what is on
       * screen and nothing in `project.json`. It exists so an agent that has
       * just eased a curve can SHOW the human the curve it eased, and so a
       * human asking "show me the opacity curve" gets the same lane the
       * Inspector's own button opens — the one target, in the store, that both
       * affordances already share.
       */
      editor_set_curve_editor: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        if (a?.param == null) {
          useEditorTimelineStore.getState().setCurveEditor(null);
          return { ok: true, open: false };
        }
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const param = a.param;
        if (typeof param !== 'string' || !(param in CLIP_KEYFRAME_DEFAULTS)) {
          return {
            error: `param must be one of ${Object.keys(CLIP_KEYFRAME_DEFAULTS).join(' | ')}, or null to close`,
          };
        }
        const animated = animatedParams(found.c.chroma_keyframes);
        if (!animated.includes(param as ClipKeyframeParam)) {
          return {
            error:
              animated.length === 0
                ? 'this clip has no animated properties — there is no curve to show'
                : `${param} is not animated on this clip — animated: ${animated.join(', ')}`,
          };
        }
        useEditorTimelineStore
          .getState()
          .setCurveEditor({ track: found.track, id: found.c.id, param: param as ClipKeyframeParam });
        return { ok: true, open: true, track: found.track, clip: found.clip, param };
      },

      /**
       * D-234 — dynamic zoom, the agent half of the same feature the viewer's
       * green/red boxes are (CLAUDE.md's human+AI parity rule). The box→
       * keyframe math is entirely well-defined, so there is a real agent
       * equivalent of the gesture: name the two framings, get the animation.
       *
       * Everything it does goes through `dynamicZoom.ts`'s own
       * `applyDynamicZoom` — the SAME pure function the on-canvas drag commits
       * through, writing the SAME `set_clip_keyframes` op — so an agent's
       * dynamic zoom and a human's are not merely equivalent, they are
       * literally the same code path with the framings arriving from a
       * different place.
       *
       * Both framings are optional, and the defaults are the useful ones: an
       * omitted `start` is the clip's CURRENT framing at its first frame (so
       * "punch in on this clip" is one argument), and an omitted `end` is that
       * pushed in by `DYNAMIC_ZOOM_DEFAULT_PUSH`. Each framing's own three
       * fields are individually optional too, defaulting to the corresponding
       * end's resolved value, so `{scale: 1.4}` means "same position, zoomed to
       * 1.4" rather than silently recentring the shot.
       */
      editor_set_dynamic_zoom: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        const c = found.c;
        // The same two refusals `editor_set_clip_transform`/`_keyframes` make,
        // and for B-053's reason: a title's `scale` is pinned server-side and
        // an adjustment clip's correction is full-frame, so a dynamic zoom on
        // either would store a real animation that no frame of any render
        // reflects. Refused, not silently ignored.
        if (isTextClip(c)) {
          return {
            error:
              "a text clip's scale is pinned to 1 by both renderers, so a dynamic zoom would animate nothing. Use editor_set_text_clip's `size`, or put the title over a video clip and zoom that.",
          };
        }
        if (isAdjustmentClip(c)) {
          return {
            error:
              "an adjustment clip's correction is always full-frame — it has no geometry to zoom. Apply the dynamic zoom to the video clip underneath it instead.",
          };
        }

        const curveName = a?.ease === undefined || a?.ease === null ? 'linear' : String(a.ease);
        const preset = EASE_PRESETS.find((p) => p.name === curveName);
        if (!preset) {
          return { error: `ease must be one of ${EASE_PRESETS.map((p) => p.name).join(', ')}` };
        }

        const current = dynamicZoomFramings(c);
        // Same shape every other handler here spells locally: an absent field
        // means "leave it", not "zero it".
        const num = (v: unknown, fallback: number) => (v === undefined || v === null ? fallback : Number(v));
        // A partial framing object fills its missing fields from the end it is
        // replacing — never from zero, which would silently recentre a shot an
        // agent only meant to scale.
        const framing = (raw: unknown, base: DynamicZoomFraming): DynamicZoomFraming | { error: string } => {
          if (raw === undefined || raw === null) return base;
          if (typeof raw !== 'object') return { error: 'start/end must be objects of {position_x, position_y, scale}' };
          const o = raw as Record<string, unknown>;
          const out = {
            position_x: num(o.position_x, base.position_x),
            position_y: num(o.position_y, base.position_y),
            scale: num(o.scale, base.scale),
          };
          if (!Number.isFinite(out.position_x) || !Number.isFinite(out.position_y) || !Number.isFinite(out.scale)) {
            return { error: 'start/end fields must be finite numbers' };
          }
          if (out.scale <= 0) return { error: 'scale must be greater than 0' };
          return out;
        };

        const start = framing(a?.start, current.start);
        if ('error' in start) return start;
        // An omitted `end` on a clip with no zoom yet is the default push-in;
        // on a clip that already has one it is that clip's own end framing, so
        // re-easing or re-starting a zoom does not silently reset the other
        // end.
        const endBase = dynamicZoomIsStatic(current.start, current.end)
          ? defaultDynamicZoomEnd(start)
          : current.end;
        const end = framing(a?.end, endBase);
        if ('error' in end) return end;

        // D-193 — an independent box-size override beats `scale` outright in
        // the compositor, so clear it or the animation animates nothing. The
        // same extra op the on-canvas commit emits.
        if ((c.box_width ?? null) !== null || (c.box_height ?? null) !== null) {
          useEditorTimelineStore.getState().applyOp({
            kind: 'set_clip_transform',
            track: found.track,
            clip: found.clip,
            opacity: c.opacity ?? 1,
            position_x: c.position_x ?? 0,
            position_y: c.position_y ?? 0,
            scale: c.scale ?? 1,
            box_width: null,
            box_height: null,
            rotation: c.rotation ?? 0,
            crop_left: c.crop_left ?? 0,
            crop_top: c.crop_top ?? 0,
            crop_right: c.crop_right ?? 0,
            crop_bottom: c.crop_bottom ?? 0,
          });
        }

        const span = dynamicZoomSpan(c);
        const keyframes = applyDynamicZoom(c.chroma_keyframes, start, end, span.first, span.last, preset.curve);
        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_keyframes',
          track: found.track,
          clip: found.clip,
          keyframes,
        });
        // Arm the viewer's own boxes on the same clip, so a human looking at
        // the app sees exactly what the agent just authored, on the surface
        // they would have authored it on themselves.
        useEditorTimelineStore.getState().setDynamicZoom({ clipId: c.id, curve: preset.curve });
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          start,
          end,
          ease: preset.name,
          first_frame: span.first,
          last_frame: span.last,
          keyframe_count: keyframes.length,
          // Stated rather than left to be inferred: two identical framings are
          // a legal write that animates nothing, and an agent that asked for a
          // zoom should be told it got a hold.
          animates: !dynamicZoomIsStatic(start, end),
        };
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
          fade_in_curve: inCurve ?? c.fade_in_curve ?? DEFAULT_EASE_CURVE,
          fade_out_curve: outCurve ?? c.fade_out_curve ?? DEFAULT_EASE_CURVE,
        });

        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          name: after?.name ?? c.name,
          fadeInFrames: after?.fade_in_frames ?? 0,
          fadeOutFrames: after?.fade_out_frames ?? 0,
          fadeInCurve: after?.fade_in_curve ?? DEFAULT_EASE_CURVE,
          fadeOutCurve: after?.fade_out_curve ?? DEFAULT_EASE_CURVE,
          fadeInCurveName: easePresetName(after?.fade_in_curve),
          fadeOutCurveName: easePresetName(after?.fade_out_curve),
          note: 'a fade on a video clip fades its picture AND its embedded audio together',
        };
      },

      // ---- speed ramp (D-236, reverse D-240) ----------------------------- //
      //
      // The AI half of the Inspector's own Speed section, over the same
      // `set_clip_speed` op and the same `Clip.speed_points` — CLAUDE.md's
      // "every feature is built for a human AND an AI" rule, not a follow-up.
      //
      // Two shapes, because the two real requests are genuinely different:
      // `speed` alone is "make this whole clip 2x" (a one-segment ramp, which
      // is the flat case expressed in the ramped model rather than a separate
      // concept), and `points` is a real ramp. `points: []` / `speed: 1`
      // clears the ramp, since `normalizeSpeedPoints` drops an identity point.
      editor_set_clip_speed: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        const c = found.c;

        const rawPoints = a?.points;
        if (rawPoints !== undefined && !Array.isArray(rawPoints)) {
          return { error: 'points must be a list of {source_frame, speed} objects' };
        }
        if (rawPoints !== undefined && a?.speed !== undefined) {
          return { error: 'pass either speed (a flat multiplier) or points (a ramp), not both' };
        }

        let next: SpeedPoint[];
        if (Array.isArray(rawPoints)) {
          const parsed: SpeedPoint[] = [];
          for (const [i, p] of rawPoints.entries()) {
            const frame = Number((p as { source_frame?: unknown })?.source_frame);
            const speed = Number((p as { speed?: unknown })?.speed);
            if (!Number.isFinite(frame)) {
              return { error: `points[${i}].source_frame must be a source frame number` };
            }
            // Refused, not clamped: a speed outside the range is a request the
            // caller got wrong, and silently retiming to 20x instead of the
            // 200x it asked for is worse than saying so. (The MODEL still
            // clamps — `chroma_timeline_set` stores whatever it is handed, so
            // a document reaching the store another way must degrade safely.)
            if (!isAcceptableSpeed(speed)) {
              return { error: `points[${i}].speed ${SPEED_RANGE_HELP}` };
            }
            parsed.push({ source_frame: Math.round(frame), speed });
          }
          next = parsed;
        } else if (a?.speed !== undefined) {
          const speed = Number(a.speed);
          if (!isAcceptableSpeed(speed)) {
            return { error: `speed ${SPEED_RANGE_HELP}` };
          }
          next = [{ source_frame: c.source_start, speed }];
        } else {
          return { error: 'pass speed (a flat multiplier) or points (a ramp)' };
        }

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_speed',
          track: found.track,
          clip: found.clip,
          points: next,
        });

        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        const segments = after ? resolveSpeedSegments(after) : [];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          name: after?.name ?? c.name,
          points: after?.speed_points ?? [],
          // The resolved runs, because that — not the point list — is what
          // actually plays, and an agent that just trimmed the clip needs to
          // see which of its points still bite.
          segments: segments.map((s) => ({
            sourceFrames: [s.startSourceFrame, s.endSourceFrame],
            speed: s.speed,
          })),
          sourceFrames: c.duration,
          outputFrames: after ? Math.round(clipOutputSourceFrames(after)) : c.duration,
          note:
            'a retime changes this clip\'s length on the timeline but not its start_frame — ' +
            'neighbouring clips do not move, so close or fill the gap yourself. ' +
            'Picture and sound are retimed together.',
        };
      },

      // ---- per-clip level (D-223) ---------------------------------------- //
      //
      // Its own op rather than two more fields on `editor_set_clip_transform`,
      // for the reason `set_clip_audio`'s own doc gives: a level is not
      // geometry, it applies to audio-track clips with no transform at all,
      // and that tool REQUIRES its nine geometry values (an omitted one
      // resets), so a volume nudge through it would restate — and could
      // silently reset — a clip's whole compositing transform.
      editor_set_clip_audio: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        const c = found.c;

        // Both optional and independent — an omitted one is left exactly as it
        // is (the reducer's own contract), so an agent setting only pan cannot
        // accidentally reset a volume it never looked at. Rejected rather than
        // coerced when present and unusable, so a typo is reported instead of
        // silently becoming 0 (= silence) or NaN.
        const num = (v: unknown, name: string): number | { error: string } | undefined => {
          if (v === undefined || v === null) return undefined;
          const n = Number(v);
          if (!Number.isFinite(n)) return { error: `${name} must be a finite number, got ${String(v)}` };
          return n;
        };
        const volume = num(a?.volume, 'volume');
        if (volume !== undefined && typeof volume === 'object') return volume;
        const pan = num(a?.pan, 'pan');
        if (pan !== undefined && typeof pan === 'object') return pan;
        if (volume === undefined && pan === undefined) {
          return { error: 'set at least one of volume or pan' };
        }

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_audio',
          track: found.track,
          clip: found.clip,
          ...(volume !== undefined ? { volume } : {}),
          ...(pan !== undefined ? { pan } : {}),
        });

        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        const storedPan = after?.pan ?? 0;
        const [left, right] = panGains(storedPan);
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          name: after?.name ?? c.name,
          // What was actually STORED — values are clamped on the way in
          // (volume floored at 0, pan to [-1, 1]), so a caller should read
          // these rather than assume its request landed verbatim.
          volume: after?.volume ?? 1,
          pan: storedPan,
          // The real per-channel multipliers this pan resolves to, so a caller
          // reasoning about level does not have to re-derive the pan law.
          panGainLeft: left,
          panGainRight: right,
          trackGain: found.tr.gain ?? 1,
          note: 'clip volume multiplies with the track gain, the clip fade and any duck — it does not replace them',
        };
      },

      // ---- per-clip parametric EQ (D-224) -------------------------------- //
      //
      // Its own op rather than more fields on `editor_set_clip_audio`, for
      // that tool's own reason applied one level further: an EQ is not a
      // level, it is four bands × four controls, and folding sixteen optional
      // parameters into a two-parameter level tool would make BOTH unreadable.
      // One BAND per call, every field independently optional, exactly the
      // partial-write shape `editor_set_clip_audio` established.
      editor_set_clip_eq: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };

        const report = (note: string) => {
          const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
          const bands = after?.eq_bands ?? [];
          return {
            ok: true,
            track: found.track,
            clip: found.clip,
            name: after?.name ?? found.c.name,
            // What was actually STORED — every field is clamped on the way in
            // (20 Hz…20 kHz, ±24 dB, Q 0.1…20), so a caller should read these
            // rather than assume its request landed verbatim.
            bands,
            summary: bands.map(describeEqBand),
            // Whether ANY band is doing something. A four-band strip whose
            // gains are all 0 dB is completely inert, and an agent that could
            // not tell that apart from a real filter would happily report
            // "EQ applied" for a no-op.
            eqActive: hasActiveEq(bands),
            // The real curve at the frequencies an editor actually reasons
            // about, so a caller can check its own move landed without
            // re-implementing a biquad. dB, at the export's own design rate.
            responseDb: EQ_REPORT_FREQS.map((f) => ({
              hz: f,
              db: Number(eqResponseDb(bands, f).toFixed(3)),
            })),
            note,
          };
        };

        if (a?.clear === true) {
          useEditorTimelineStore.getState().applyOp({
            kind: 'set_clip_eq',
            track: found.track,
            clip: found.clip,
            clear: true,
          });
          return report('EQ removed — this clip is unfiltered again');
        }

        const band = Math.round(Number(a?.band));
        if (!Number.isFinite(band) || band < 0) {
          return { error: 'band must be a 0-based band index (or pass clear: true to remove the EQ)' };
        }
        // The strip a clip with no EQ yet is ABOUT to get, so an out-of-range
        // index is reported against the real band count rather than against 0.
        const bandCount = eqBandsForDisplay(found.c.eq_bands).length;
        if (band >= bandCount) {
          return { error: `no band ${band} (0..${bandCount - 1})` };
        }

        const patch: Partial<EqBand> = {};
        if (a?.kind != null) {
          const kind = String(a.kind) as EqBandKind;
          if (!EQ_BAND_KINDS.includes(kind)) {
            return { error: `kind must be one of ${EQ_BAND_KINDS.join(', ')}, got ${String(a.kind)}` };
          }
          patch.kind = kind;
        }
        // Rejected rather than coerced when present and unusable, so a typo is
        // reported instead of silently becoming a 0 Hz corner.
        for (const [key, raw] of [
          ['freq_hz', a?.freq_hz],
          ['gain_db', a?.gain_db],
          ['q', a?.q],
        ] as const) {
          if (raw == null) continue;
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            return { error: `${key} must be a finite number, got ${String(raw)}` };
          }
          patch[key] = n;
        }
        if (a?.enabled != null) patch.enabled = a.enabled !== false;
        if (Object.keys(patch).length === 0) {
          return { error: 'set at least one of kind, freq_hz, gain_db, q, enabled — or pass clear: true' };
        }

        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_eq',
          track: found.track,
          clip: found.clip,
          band,
          patch,
        });

        const stored = useEditorTimelineStore
          .getState()
          .timeline?.tracks[found.track]?.clips[found.clip]?.eq_bands?.[band];
        // A band whose kind has no gain (high/low pass) ignores `gain_db`
        // entirely — said here rather than left for the caller to notice that
        // its requested boost changed nothing.
        const gainIgnored =
          stored != null && patch.gain_db !== undefined && !eqKindUsesGain(stored.kind);
        return report(
          gainIgnored
            ? `band ${band + 1} is a ${stored?.kind} — it has no gain, so gain_db was stored but does nothing`
            : 'the EQ applies before this clip’s volume, fade and duck, in the preview and the render alike',
        );
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

      // ---- markers (D-222, roadmap item 27) -------------------------------
      //
      // The agent half of `Timeline.markers`. All four drive the exact same
      // `add_marker`/`set_marker`/`remove_marker` `EditOp`s the ruler's own
      // flag strip does (`TimelineMarkers.tsx`), through the same
      // `applyOp` — so a marker an agent drops is persisted and undoable
      // identically to one a human dropped, and there is no second write path
      // to keep in step (CLAUDE.md's human+AI parity rule).
      //
      // No `track` argument anywhere here, deliberately: a marker belongs to
      // the timeline, not to a track or a clip (see `Timeline.markers`).

      editor_list_markers: () => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        return { markers: markersOf(tl).map(markerDto), palette: MARKER_COLORS.map((c) => c.name) };
      },

      editor_add_marker: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        // `frame` defaults to the playhead — the same thing the GUI's own
        // button/`M` shortcut does, so "put a marker here" needs no argument
        // once the agent has seeked.
        const frame = a?.frame == null ? useEditorTimelineStore.getState().playhead : Math.round(Number(a.frame));
        const marker = newMarker(frame, a?.color, a?.name, a?.note);
        if ('error' in marker) return marker;
        useEditorTimelineStore.getState().applyOp({ kind: 'add_marker', marker });
        return { ok: true, marker: markerDto(marker) };
      },

      editor_remove_marker: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const id = String(a?.id ?? '');
        const hit = (tl.markers ?? []).find((m) => m.id === id);
        if (!hit) return { error: markerNotFound(tl, id) };
        useEditorTimelineStore.getState().applyOp({ kind: 'remove_marker', id });
        return { ok: true, removed: markerDto(hit) };
      },

      editor_set_marker: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const id = String(a?.id ?? '');
        if (!(tl.markers ?? []).some((m) => m.id === id)) return { error: markerNotFound(tl, id) };

        const patch: { frame?: number; color?: string; name?: string | null; note?: string | null } = {};
        if (a?.frame != null) {
          const frame = Math.round(Number(a.frame));
          if (!Number.isFinite(frame)) return { error: 'frame must be a finite number of timeline frames' };
          patch.frame = frame;
        }
        if (a?.color != null) {
          // Validated HERE rather than left to the reducer (which silently
          // keeps the old colour for an unresolvable one, so the document can
          // never hold garbage) — an agent that mistyped a colour name needs
          // to be told, not to get `ok: true` and an unchanged marker.
          const hex = resolveMarkerColor(String(a.color));
          if (typeof hex !== 'string') return hex;
          patch.color = hex;
        }
        // `null` clears the field, an absent key leaves it alone — the op's
        // own convention, passed straight through.
        if (a?.name !== undefined) patch.name = a.name == null ? null : String(a.name);
        if (a?.note !== undefined) patch.note = a.note == null ? null : String(a.note);
        if (Object.keys(patch).length === 0) {
          return { error: 'nothing to set — pass at least one of frame, color, name, note' };
        }

        useEditorTimelineStore.getState().applyOp({ kind: 'set_marker', id, patch });
        const after = useEditorTimelineStore.getState().timeline?.markers?.find((m) => m.id === id);
        return { ok: true, marker: after ? markerDto(after) : null };
      },

      // ---- transitions (D-226, roadmap item 27) ---------------------------
      //
      // The agent half of `Track.transitions`. All four drive the exact same
      // `add_transition`/`set_transition`/`remove_transition` `EditOp`s the
      // timeline's own palette drag and badge popover do
      // (`TimelineTransitions.tsx`), through the same `applyOp` — so a
      // transition an agent drops is persisted, rendered and undoable
      // identically to one a human dropped, and there is no second write path
      // to keep in step (CLAUDE.md's human+AI parity rule).
      //
      // Every one of these takes a `track`, unlike the marker ops above: a
      // transition lives at a cut on ONE track (see `Track.transitions`).

      editor_list_transitions: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const fps = timelineFps(tl);
        const tracks =
          a?.track == null
            ? tl.tracks.map((_, i) => i)
            : [Math.round(Number(a.track))];
        const out = tracks
          .filter((i) => tl.tracks[i])
          .map((i) => ({
            track: i,
            kind: tl.tracks[i].kind,
            // The legal drop targets, reported alongside what is already
            // there: "where CAN one go" is the question an agent has before
            // `editor_add_transition`, and it is not derivable from the clip
            // list without re-implementing `cutFrames`' own end==start match.
            cuts: tl.tracks[i].kind === 'video' ? cutFrames(tl.tracks[i], fps) : [],
            transitions: transitionsOf(tl.tracks[i]).map(transitionDto),
          }));
        return {
          tracks: out,
          kinds: TRANSITION_KINDS.map((k) => ({ value: k.value, label: k.label, needs: k.blurb })),
          alignments: TRANSITION_ALIGNMENTS.map((x) => x.value),
          defaultDurationFrames: DEFAULT_TRANSITION_FRAMES,
        };
      },

      editor_add_transition: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const fps = timelineFps(tl);
        const track = Math.round(Number(a?.track));
        if (!Number.isFinite(track) || !tl.tracks[track]) {
          return { error: `track must be 0..${tl.tracks.length - 1}` };
        }
        const kind = String(a?.kind ?? 'cross_dissolve') as TransitionKind;
        // `atFrame` defaults to the cut nearest the playhead — the same
        // "act where the user is looking" default `editor_add_marker` takes,
        // so "put a dissolve on this cut" needs no arithmetic once the agent
        // has seeked. Reported explicitly in the response so the agent knows
        // which cut it actually got.
        const cuts = cutFrames(tl.tracks[track], fps);
        let atFrame: number;
        if (a?.atFrame == null) {
          const playhead = useEditorTimelineStore.getState().playhead;
          if (cuts.length === 0) {
            return { error: `track ${track} has no cut — a transition needs two clips touching end to start` };
          }
          atFrame = cuts.reduce((best, c) =>
            Math.abs(c - playhead) < Math.abs(best - playhead) ? c : best,
          );
        } else {
          atFrame = Math.round(Number(a.atFrame));
        }
        const built = newTransition(
          kind,
          atFrame,
          a?.durationFrames == null ? DEFAULT_TRANSITION_FRAMES : Math.round(Number(a.durationFrames)),
          (a?.alignment == null ? 'center_at_cut' : String(a.alignment)) as TransitionAlignment,
          a?.color == null ? null : String(a.color),
        );
        if ('error' in built) return built;
        // The SAME precondition the GUI drop runs, so an agent gets the same
        // real reason a human would ("insufficient media … try End at Cut")
        // rather than a silent no-op from the reducer.
        const check = checkTransition(tl, track, built, fps);
        if (!check.ok) return { error: check.reason ?? 'that transition cannot go there' };
        useEditorTimelineStore.getState().applyOp({ kind: 'add_transition', track, transition: built });
        return { ok: true, track, transition: transitionDto(built) };
      },

      editor_set_transition: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const fps = timelineFps(tl);
        const track = Math.round(Number(a?.track));
        const id = String(a?.id ?? '');
        const current = (tl.tracks[track]?.transitions ?? []).find((t) => t.id === id);
        if (!current) return { error: transitionNotFound(tl, track, id) };

        const patch: {
          kind?: TransitionKind;
          duration?: number;
          alignment?: TransitionAlignment;
          color?: string | null;
        } = {};
        if (a?.kind != null) {
          const k = String(a.kind);
          if (!TRANSITION_KINDS.some((x) => x.value === k)) {
            return { error: `unknown kind "${k}" — one of ${TRANSITION_KINDS.map((x) => x.value).join(' | ')}` };
          }
          patch.kind = k as TransitionKind;
        }
        if (a?.durationFrames != null) {
          const d = Math.round(Number(a.durationFrames));
          if (!Number.isFinite(d) || d < 1) return { error: 'durationFrames must be at least 1' };
          patch.duration = d;
        }
        if (a?.alignment != null) {
          const al = String(a.alignment);
          if (!TRANSITION_ALIGNMENTS.some((x) => x.value === al)) {
            return { error: `unknown alignment "${al}" — one of ${TRANSITION_ALIGNMENTS.map((x) => x.value).join(' | ')}` };
          }
          patch.alignment = al as TransitionAlignment;
        }
        // An explicit empty string clears the colour back to black (the
        // model's own default), matching `editor_set_marker`'s own
        // ""-clears-a-field convention.
        if (a?.color !== undefined) {
          if (a.color === null || a.color === '') patch.color = null;
          else {
            const hex = resolveMarkerColor(String(a.color));
            if (typeof hex !== 'string') return hex;
            patch.color = hex;
          }
        }
        if (Object.keys(patch).length === 0) {
          return { error: 'nothing to set — pass at least one of kind, durationFrames, alignment, color' };
        }
        // Validated against the MERGED shape, exactly as the reducer does, so
        // a refusal explains itself instead of silently no-op-ing.
        const merged: Transition = {
          ...current,
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.duration !== undefined ? { duration: patch.duration } : {}),
          ...(patch.alignment !== undefined ? { alignment: patch.alignment } : {}),
          ...(patch.color !== undefined
            ? patch.color === null
              ? { color: undefined }
              : { color: patch.color }
            : {}),
        };
        const check = checkTransition(tl, track, merged, fps);
        if (!check.ok) return { error: check.reason ?? 'that change is not legal here' };
        useEditorTimelineStore.getState().applyOp({ kind: 'set_transition', track, id, patch });
        const after = useEditorTimelineStore
          .getState()
          .timeline?.tracks[track]?.transitions?.find((t) => t.id === id);
        return { ok: true, track, transition: after ? transitionDto(after) : null };
      },

      editor_remove_transition: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const track = Math.round(Number(a?.track));
        const id = String(a?.id ?? '');
        const hit = (tl.tracks[track]?.transitions ?? []).find((t) => t.id === id);
        if (!hit) return { error: transitionNotFound(tl, track, id) };
        useEditorTimelineStore.getState().applyOp({ kind: 'remove_transition', track, id });
        return { ok: true, track, removed: transitionDto(hit) };
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
