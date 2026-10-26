/**
 * @apelles/editor — the Edit-tab half of the Apelles control server bridge
 * (D-020's architecture, reused a third time — see `docs/notes/
 * mcp-architecture.md` for the full pattern this hook follows, and D-183
 * for why this file exists at all: the owner's own live "why are we
 * building chroma when you want to do it with ffmpeg… build all the MCP
 * and register the MCP its our own tool" — the Edit tab had no control
 * surface at all before this pass, only Colorist (`useChromaControl.ts`)
 * and Motion (`@apelles/motion`'s `useMotionControl.ts`) did.
 *
 * **Same event pair as both existing hooks, no Rust changes.** Listens on
 * the SAME `chroma://request`/`chroma://response/<id>` Tauri events
 * `control.rs` already emits/awaits (`app/src-tauri/src/chroma/control.rs`
 * has never needed an op-name change to carry a new tab's ops — it forwards
 * `{op,args}` blind). Every op here is namespaced `editor_*`, mirroring
 * Motion's own OPT-IN convention exactly (`MOTION_OP_PREFIX`,
 * `@apelles/motion/src/useMotionControl.ts`) — NOT Colorist's own
 * opt-OUT/catch-all shape, which `docs/notes/mcp-architecture.md` calls
 * out as the one NOT to copy. `useChromaControl.ts` has its own matching
 * skip for `editor_*` (D-183) so the two listeners never race for the
 * one-shot response slot `control.rs`'s `app.once(...)` hands out per
 * request id.
 *
 * **No ref/argument plumbing needed, unlike Motion.** `useEditorTimelineStore`
 * and `@apelles/bridge`'s `useMediaPoolStore` are real module-level zustand
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
 *
 * **D-266 — the media pool's read/organise half, and audio monitoring.**
 * `editor_list_media` / `_list_media_folders` / `_create_media_folder` /
 * `_move_media` complete the pool surface `editor_import_media` (D-183) and
 * `editor_remove_media` (roadmap item 23) started: each wraps the
 * `useMediaPoolStore` action the Sources panel's own list, "New folder" button
 * and drag-onto-a-bin already call, so there is one store action and one
 * `chroma_media_*` command under both interfaces. `editor_list_media` reads
 * through `refresh()` rather than off the cached `items` array, and names its
 * unusable rows in words — that is B-073's own "which item is the broken one"
 * question, previously answerable only by reading `project.json` by hand.
 * `editor_set_audio_monitor` / `editor_get_audio_level` are the audio half;
 * see their own comments below for why play/stop needed nothing new.
 */
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
// D-318 — the seconds↔frames edge shared with the Recut panel, so the human's
// cut and the agent's land on the same frame.
import {
  DEFAULT_MIN_SILENCE_MS,
  clipSourceRangeSecs,
  groupTakes,
  spanToFrames,
  type RetakeGroupWire,
} from './recut';
// D-342/B-216 — the whole-track half of those two detectors: what a sweep
// looks at, and how N per-clip answers fold into one readable report.
import {
  RETAKE_SWEEP,
  SILENCE_SWEEP,
  sweepReport,
  sweepTargets,
  type SweepClipResult,
} from './recutSweep';
// D-364/B-237 — a restart whose two halves ended up in different clips is only
// visible to the detector if the clips that were one continuous take are put
// back together before it reads them, and taken apart again after.
import {
  clipRuns,
  mergeRunUtterances,
  runGapSecs,
  takeSegments,
  type ClipRun,
} from './recutRuns';
import { listen, emit } from '@tauri-apps/api/event';

import { newBridgeClaim, useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { runAsAgent } from '@apelles/history';
// B-217/D-358 — the cross-store project-identity guard; see the dispatcher below.
import { assertProjectIdentity } from '@apelles/store';
// D-280 — the transport's own rate bounds, from the package that owns the
// transport. The same pair the store clamps to and the Rust session clamps to.
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from '@apelles/player';

import { useEditorTimelineStore, type Selection } from './timelineStore';
// D-243 — the caption preset library and the one action that applies it,
// shared verbatim with `CaptionLibrary.tsx` so the agent and the human cannot
// drift apart.
import { CAPTION_PRESETS } from './captionPresets';
import { applyCaptionPreset } from './captionPresetAction';
import { resolveCaptionStyle } from './caption';
import {
  captionAnimationOf,
  resolveCaptionAnimation,
  type CaptionAnimation,
  type CaptionAnimKind,
} from './captionAnim';
// D-233 — the curve editor's own model helpers, shared verbatim with the GUI
// (`ClipCurveEditor.tsx` / `EditorInspectorPanel.tsx`) rather than reimplemented
// here: one write path for the human and the agent, per CLAUDE.md.
import { animatedParams, paramKeyframeFrames, setClipKeyframeEase } from './clipKeyframes';
import { validateHighlights } from './clipHighlights';
import { suggestClipHighlights } from './highlightSuggestOp';
import { liveSuggestDeps } from './highlightSuggestLive';
import {
  checkAddClip,
  clipOutputSourceFrames,
  timelineDuration,
  CLIP_KEYFRAME_DEFAULTS,
  EASE_PRESETS,
  DEFAULT_EASE_CURVE,
  DEFAULT_CAPTION_FONT,
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_FPS,
  DEFAULT_TEXT_FONT,
  DEFAULT_TITLE_SECONDS,
  EQ_BAND_KINDS,
  isGeneratedClip,
  describeEqBand,
  eqBandsForDisplay,
  eqKindUsesGain,
  eqResponseDb,
  easePresetName,
  endFrame,
  hasActiveEq,
  gapAt,
  // D-239 — the seven edit types, shared with the GUI's own edit overlay.
  checkEditIn,
  isDropEditType,
  videoTrackIndex,
  DROP_EDIT_TYPES,
  isAdjustmentClip,
  isCaptionClip,
  isTextClip,
  ADJUSTMENT_PARAMS,
  newCaptionClipFields,
  MARKER_COLORS,
  markerEndFrame,
  markersOf,
  mediaSourceFacts,
  newAdjustmentClipFields,
  newAdjustmentLayer,
  newMarker,
  newTextClipFields,
  newTextLayer,
  panGains,
  resolveMarkerColor,
  timelineFps,
  applyRippleDeleteRanges,
  checkRemoveGap,
  checkTrim,
  linkGroupMembers,
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
  type DraggedMedia,
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
import { DETECT_GRACE_MS, settleWithin } from './settle';
import { getWordTranscript, proposeRetakes, retranscribeWords } from './retakeProposalOps';
import { detectedForGate, gateDetectorGroups, type DetectorGateResult } from './detectorGate';

/** What a retake answer says about the gate behind its `status` (D-382). */
const GATE_NOTE =
  'Each group carries `status`: "verified" means the coverage gate checked that every word a cut would ' +
  'remove survives in the kept take; "refused" names the words it would lose (`offending`) — do not cut a ' +
  'refused group unless the person has listened and asks for it.';
// D-236 — the speed ramp. `MIN_SPEED`/`MAX_SPEED` are shared with the GUI and
// with Rust so an agent, the Inspector and the preview all agree on the range.
import { MIN_SPEED, MAX_SPEED, resolveSpeedSegments, type SpeedPoint } from './speedRamp';

/** D-236/D-241 — is this a speed an agent may store?
 *
 *  Refused, not clamped: a speed outside the range is a request the caller got
 *  wrong, and silently retiming to 20x instead of the 200x it asked for is
 *  worse than saying so. (The MODEL still clamps — `chroma_timeline_set`
 *  stores whatever it is handed, so a document reaching the store another way
 *  must degrade safely; see `clampSpeed`.)
 *
 *  D-241 — the range is on the MAGNITUDE and either sign is accepted, which is
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
// D-329 — the whole timeline's transcript, the same stitch the Index panel
// renders, so `editor_get_timeline_transcript` and the GUI cannot disagree.
import { stitchTimelineTranscript, transcriptSources } from './timelineTranscript';
// D-256 — the baked Colorist grade for each clip, behind `editor_get_grade_status`.
import { warmGradeLuts } from './gradeLuts';
import {
  darkKey,
  retakeKey,
  retakeRequestKey,
  silenceKey,
  useMediaUnderstandingStore,
  type AnalysisPhase,
  type AnalysisStatus,
  type DarkDetectionArgs,
  type RetakeDetection,
  type RetakeDetectionArgs,
  type SilenceDetection,
  type SilenceDetectionArgs,
  type Transcript,
} from './mediaUnderstandingStore';
// D-349/B-216 — dark regions: where the ASR silently dropped speech, and the
// one shared step that scans for it, re-reads those windows and splices the
// recovered words back in. The SAME step the Recut panel runs, so the human's
// recut and the agent's cannot read two different transcripts of one file.
import { runTranscriptView, type RunTranscriptView } from './darkRecovery';
import type { DarkDetection, DarkRegionWire } from './darkRegions';
// D-238 — auto-captioning from the D-189 transcript. The grouping algorithm
// and the seconds->frames conversion are the ONE new thing this feature
// needed; both the GUI button and this hook's own op call them, then dispatch
// the SAME `import_subtitles` op the `.srt` importer already uses.
import {
  generatedCuesToCaptions,
  groupTranscriptIntoCues,
  sanitiseIdStem,
} from './captionsFromTranscript';
import { composeFontStyleKey, fontStyleOf, loadTextFonts, textFontsSync } from './textFonts';
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

/** B-071 — this registry's own cold-start handshake, announced on
 *  `chroma://bridge-ready` once `listen()` below has actually resolved.
 *
 *  `control.rs` binds its HTTP port in the Tauri `.setup()` hook, long before
 *  the webview loads and this effect runs, and a `chroma://request` emitted
 *  before this subscription exists is lost outright (Tauri does not buffer
 *  events). The first `editor_*` call after an app restart therefore used to
 *  sit out the whole 20s budget and come back a timeout, then succeed on the
 *  retry — the app had finished starting in the meantime. The control server now
 *  waits for this announcement before forwarding an `editor_*` op to anyone.
 *
 *  `defers: []` — this registry claims its prefix and nothing else; the catch-all
 *  in `app/src/hooks/useChromaControl.ts` is the only one with anything to
 *  defer. The event name is spelled out here rather than imported, matching how
 *  `chroma://request`/`chroma://response/` already are in all four registries. */

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

/** [`resolveClip`]'s success branch, named so the helpers that pass one around
 *  don't have to restate its shape. */
type ResolvedClip = Exclude<ReturnType<typeof resolveClip>, { error: string }>;

/** The raw argument bag an op handler is handed off the wire. Untrusted and
 *  unvalidated by construction — every field is `unknown` until the handler
 *  checks it, which is what the `resolve*`/`num` helpers below are for. */
type OpArgs = Record<string, unknown> | undefined;

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

/** D-266 — whether `editor_add_clip` would accept this pool item. It needs a
 *  positive probed `frameCount` and nothing else: an item can be `offline`
 *  (source missing right now) and still be placeable from its remembered
 *  probe, and an item that is online but never probed successfully cannot.
 *  Shares `editor_add_clip`'s own guard rather than restating it, so the two
 *  can never disagree about what "usable" means. */
function isPlaceable(m: MediaItem): boolean {
  // D-292 — the rate is irrelevant to the null-vs-not answer this asks: a still
  // is always placeable (its span is synthesized, whatever the rate), and
  // footage is placeable exactly when it has a positive probed frame count.
  // `DEFAULT_FPS` is a stand-in here, never a length.
  return mediaSourceFacts(draggedMediaOf(m), DEFAULT_FPS) !== null;
}

/** D-292 — a pool item as the timeline model's own `DraggedMedia` payload.
 *
 *  **The one adapter between `@apelles/bridge`'s `MediaItem` (what the pool
 *  holds) and `@apelles/editor`'s `DraggedMedia` (what a clip is built from).**
 *  Every `editor_*` tool that places or relinks a clip used to reach into
 *  `media.video?.frameCount` / `media.video?.fps` itself — four copies of the
 *  same reach, all four of which silently rejected a still image, since a still
 *  has no `video` at all. Funnelling them through this one mapper is what makes
 *  the GUI drop (which already goes through `DraggedMedia`) and the MCP call
 *  place *the same clip*, per CLAUDE.md's "the same op/store action underneath
 *  both".
 *
 *  `timeline.ts` deliberately does not import `@apelles/bridge` (it is the pure
 *  model), which is why the adapter lives here rather than there. */
function draggedMediaOf(m: MediaItem): DraggedMedia {
  return {
    id: m.id,
    sourcePath: m.sourcePath,
    name: m.name,
    frameCount: m.video?.frameCount ?? null,
    hasAudio: m.video?.hasAudio ?? null,
    fps: m.video?.fps ?? null,
  };
}

/** D-292 — `mediaSourceFacts` for a pool item, with the refusal message every
 *  `editor_*` placement tool reports when a source has no usable extent. One
 *  message, one condition, four call sites. */
function placementFacts(
  m: MediaItem,
  fps: number,
): NonNullable<ReturnType<typeof mediaSourceFacts>> | { error: string } {
  const facts = mediaSourceFacts(draggedMediaOf(m), fps);
  return (
    facts ?? {
      error: `${m.name} has no known frame count (offline, or not a probeable video or still image)`,
    }
  );
}

/** D-266 — one media-pool item as `editor_list_media`/`_move_media` report it.
 *
 *  Deliberately NOT the raw `MediaItem`: `thumb` is a base64 JPEG data URL,
 *  which would swamp an agent's context with an unreadable blob for every row
 *  (a 50-item pool is megabytes of it), so the presence of a thumbnail is
 *  reported as a boolean and the bytes stay in the GUI where they mean
 *  something.
 *
 *  `problem` is the B-073 field. That bug is a pool item stuck with no probed
 *  metadata after a transient probe failure, and until this tool existed the
 *  only way to find WHICH item it was was to read `project.json` by hand — so
 *  every unusable row states in words what is wrong with it and what fixes it,
 *  rather than leaving a caller to notice a missing `video` key. */
function mediaItemDto(m: MediaItem) {
  const placeable = isPlaceable(m);
  return {
    id: m.id,
    name: m.name,
    sourcePath: m.sourcePath,
    // `null`, not undefined/absent: the pool ROOT is a real place an item can
    // be, and a missing key reads as "unknown" rather than "at the root".
    folder: m.folder && m.folder.trim() ? m.folder : null,
    added: m.added,
    offline: m.offline,
    video: m.video
      ? {
          width: m.video.width,
          height: m.video.height,
          fps: m.video.fps,
          frameCount: m.video.frameCount,
          durationSecs: m.video.durationSecs,
          // D-129 — `null`/absent genuinely means "not probed for this yet",
          // NOT "silent"; passed through as-is rather than defaulted to false,
          // which would turn "unknown" into a confident wrong answer.
          hasAudio: m.video.hasAudio ?? null,
        }
      : null,
    // D-292 — a STILL IMAGE source. Mutually exclusive with `video`: a row has
    // one or the other, never both, and an agent reads which key is present to
    // know what kind of source it is looking at. A still has no fps, duration
    // or frame count to report — see `MediaImageInfo` in Rust for why those are
    // absent rather than zeroed.
    image: m.image ? { width: m.image.width, height: m.image.height } : null,
    hasThumb: !!m.thumb,
    // D-260 — set only on a Motion render's own output file.
    motionSceneId: m.motionSceneId ?? null,
    usable: placeable,
    problem: placeable
      ? undefined
      : m.offline
        ? 'source file is missing from disk right now, and nothing probed is stored — editor_add_clip will refuse this item. Restore the file, then editor_reprobe_media this id.'
        : 'no probed source metadata (no video frameCount, and not a still image) — editor_add_clip will refuse this item. This is B-073: the first probe failed. Call editor_reprobe_media with this id to re-probe it in place.',
  };
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
 *  is byte-for-byte the same response shape under its new name. Exported
 *  (only for `useEditorControl.test.ts`, B-203) so this pure serializer can
 *  be unit-tested directly rather than through the Tauri event round trip
 *  the rest of this hook needs — it has a correct answer, the same
 *  reasoning CLAUDE.md's Testing section gives for the grade-doc/mask-
 *  geometry unit tests. */
export function timelineDto(tl: Timeline) {
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
        // frames, `startFrame` is a TIMELINE frame (`apelles-timeline::Clip`'s
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
        // B-203 — the ONLY size mechanism with real preview/export parity
        // (`scale` means different things in the two engines, see B-201) was
        // writable via `editor_set_clip_transform` and persisted, but this
        // DTO never reported it back — the natural verification (set it,
        // read it back) read as "the write silently did nothing." `null`
        // (not `0`/`1`) for "no override, derive from `scale`", the same
        // explicit-null convention every other nullable field on this clip
        // uses (`linkGroup`, `text`) and the one `timeline.ts`'s own
        // `Clip.box_width`/`box_height` doc requires: a cleared override
        // must round-trip as `null`, not vanish.
        boxWidth: c.box_width ?? null,
        boxHeight: c.box_height ?? null,
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
        // having a text layer, see `apelles_timeline::Clip::text`).
        text: c.text ?? null,
        // D-396 / B-270 — the clip's phrase highlights, in the same shape
        // `editor_set_clip_highlights` takes and returns (`{box, at, dur,
        // color?, opacity?}`), so an agent can read back what it wrote with
        // the same call every other clip property comes from. `[]` for none.
        highlights: c.highlights ?? [],
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
  return {
    id: m.id,
    frame: m.frame,
    color: m.color,
    // D-328 — the span, normalised the same way `name`/`note` are: an absent
    // duration is reported as an explicit `0`, and `endFrame` is derived here
    // rather than left to the caller so an agent never has to know whether the
    // end is inclusive (it is — see `markerEndFrame`). A point marker is
    // therefore `durationFrames: 0, endFrame === frame`, which reads correctly
    // without the caller special-casing absence.
    durationFrames: m.duration_frames ?? 0,
    endFrame: markerEndFrame(m),
    name: m.name ?? null,
    note: m.note ?? null,
  };
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
/** `currentFont` is the style's font BEFORE this patch — the track's own for
 *  a new import, or the resolved (cue-or-track) font for an existing style —
 *  so `bold`/`italic` alone (no `font`) composes against what is already
 *  there rather than against nothing. See D-240's `composeFontStyleKey`.
 *  `baseAnim` is the caller's CURRENT resolved animation (D-243), merged onto
 *  rather than overwritten for the same reason. */
function captionStylePatch(
  a: any,
  currentFont: string,
  baseAnim?: CaptionAnimation | null,
): Partial<CaptionStyle> {
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
  // D-240 — `bold`/`italic` are composed into `font` HERE, the one place a
  // caption style patch is built for both the GUI and every MCP caller
  // (`editor_import_subtitles`, `editor_set_caption_style`). Neither survives
  // as its own stored field — see `textFonts.ts::composeFontStyleKey`.
  if (a?.bold !== undefined || a?.italic !== undefined) {
    const fonts = textFontsSync();
    const baseFont = patch.font ?? currentFont;
    const cur = fontStyleOf(fonts, baseFont);
    const bold = a?.bold !== undefined ? !!a.bold : cur.bold;
    const italic = a?.italic !== undefined ? !!a.italic : cur.italic;
    patch.font = composeFontStyleKey(fonts, baseFont, bold, italic);
  }
  // D-243 — the ANIMATION half. Merged onto the caller's CURRENT resolved
  // animation (passed in as `baseAnim`) rather than written as a fragment, for
  // the same reason the Inspector's own `patchAnim` does it: a partial write
  // onto a style that carries no animation key would leave the other fields
  // implicitly tracking future default changes.
  const animPatch = captionAnimationPatch(a, baseAnim);
  if (animPatch) patch.animation = animPatch;
  return patch;
}

/** The animation fields of an `editor_set_caption_style` call, or `null` when
 *  the caller named none.
 *
 *  `baseAnim` is the animation currently in effect, so a caller changing one knob
 *  keeps the rest — the same merge the Inspector performs. A colour explicitly
 *  passed as `null` clears back to "use the caption colour", which is the only
 *  way to undo an accent through this tool. */
function captionAnimationPatch(a: any, baseAnim?: CaptionAnimation | null): CaptionAnimation | null {
  const base = resolveCaptionAnimation(baseAnim ?? null);
  let touched = false;
  const next: CaptionAnimation = { ...base };
  const kindOf = (v: unknown): CaptionAnimKind | null => {
    const s = String(v);
    return s === 'none' || s === 'highlight' || s === 'karaoke' || s === 'slam' || s === 'build'
      ? s
      : null;
  };
  if (a?.animation !== undefined) {
    const k = kindOf(a.animation);
    // Anything else is DROPPED rather than stored, the same rule `align`
    // above follows: a kind neither renderer knows would silently render as
    // static — an invisible wrong answer.
    if (k) {
      next.kind = k;
      touched = true;
    }
  }
  const colour = (key: 'active_color' | 'spoken_color' | 'upcoming_color' | 'active_box_color', v: unknown) => {
    next[key] = v === null ? null : String(v);
    touched = true;
  };
  if (a?.activeColor !== undefined) colour('active_color', a.activeColor);
  if (a?.spokenColor !== undefined) colour('spoken_color', a.spokenColor);
  if (a?.upcomingColor !== undefined) colour('upcoming_color', a.upcomingColor);
  if (a?.highlightColor !== undefined) colour('active_box_color', a.highlightColor);
  if (a?.highlightOpacity !== undefined) {
    next.active_box_opacity = Number(a.highlightOpacity);
    touched = true;
  }
  if (a?.highlightPadX !== undefined) {
    next.active_box_pad_x = Number(a.highlightPadX);
    touched = true;
  }
  if (a?.highlightPadY !== undefined) {
    next.active_box_pad_y = Number(a.highlightPadY);
    touched = true;
  }
  if (a?.enterSecs !== undefined) {
    next.enter_secs = Number(a.enterSecs);
    touched = true;
  }
  if (a?.enterRise !== undefined) {
    next.enter_rise = Number(a.enterRise);
    touched = true;
  }
  if (a?.wordGap !== undefined) {
    next.word_gap = Number(a.wordGap);
    touched = true;
  }
  return touched ? next : null;
}

/** Everything `editor_detect_silences` and its `_status` twin both need,
 *  resolved once (B-188/D-321).
 *
 *  The start op and the status op MUST derive the same cache key from the same
 *  arguments or a poll would look up a detection nobody started, so the
 *  resolution lives here rather than being written twice. */
function resolveSilenceArgs(
  a: OpArgs,
):
  | { error: string }
  | {
      found: ResolvedClip;
      c: Clip;
      fps: number;
      args: SilenceDetectionArgs;
      key: string;
      minSilenceMs: number;
    } {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return noTimeline();
  const found = resolveClip(tl, a?.track, a?.clip);
  if ('error' in found) return found;
  const c = found.c;
  if (!c.source_path) {
    return { error: 'that clip is generated (a title or adjustment) and has no audio to analyse' };
  }

  const requested = a?.minSilenceMs === undefined ? undefined : Number(a.minSilenceMs);
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    return { error: 'minSilenceMs must be a positive number of milliseconds' };
  }

  const fps = timelineFps(tl);
  const range = clipSourceRangeSecs(c, fps);
  const args: SilenceDetectionArgs = {
    path: c.source_path,
    startSecs: range.startSecs,
    durationSecs: range.durationSecs,
    minSilenceMs: requested,
  };
  return {
    found,
    c,
    fps,
    args,
    key: silenceKey(args),
    minSilenceMs: requested ?? DEFAULT_MIN_SILENCE_MS,
  };
}

/** The silence-detection response, shared by the start op and its status op so
 *  the two can never report the same detection differently — the same contract
 *  [`transcriptResult`] establishes for D-189's pair. */
function silenceEnvelope(
  status: AnalysisStatus<SilenceDetection>,
  found: ResolvedClip,
  c: Clip,
  fps: number,
  minSilenceMs: number,
) {
  if (status.phase === 'error') return { error: status.error ?? 'silence detection failed' };
  const head = {
    ok: true as const,
    track: found.track,
    clip: found.clip,
    clipId: c.id,
    source: c.source_path,
    minSilenceMs,
  };
  if (status.phase !== 'done') {
    return {
      ...head,
      state: status.phase,
      note:
        status.phase === 'running'
          ? 'still analysing this clip — poll editor_detect_silences_status'
          : 'nothing has been started for this clip — call editor_detect_silences',
    };
  }
  const silences = silenceSpansDto(status, c, fps);
  return {
    ...head,
    state: 'done',
    silences,
    note:
      silences.length === 0
        ? 'no silence found in this clip at that threshold'
        : 'nothing was cut — pass these ranges to editor_ripple_delete_ranges to apply them',
  };
}

/** [`resolveSilenceArgs`]'s retake twin. Carries a third outcome the silence
 *  one cannot have: retakes are a fact about WORDS, so when the transcript is
 *  not ready yet there is nothing to key a detection on and the caller is sent
 *  to `editor_get_transcript_status` — the pre-existing D-318 behaviour, kept
 *  verbatim rather than folded into the new job vocabulary, because "the
 *  transcript isn't ready" and "the detection is still running" are genuinely
 *  different states with different things to poll.
 *
 *  `start` is true for `editor_detect_retakes` and false for its `_status`
 *  twin; `drive` in the result says whether this call advances the job (a start,
 *  or a poll continuing a request a start recorded — B-249). */
function resolveRetakeArgs(
  a: OpArgs,
  start: boolean,
):
  | { error: string }
  | { pending: Record<string, unknown> }
  | {
      found: ResolvedClip;
      c: Clip;
      fps: number;
      args: RetakeDetectionArgs;
      key: string;
      run: ClipRun;
      rv: RunTranscriptView;
      request: string;
      drive: boolean;
    } {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return noTimeline();
  const found = resolveClip(tl, a?.track, a?.clip);
  if ('error' in found) return found;
  const c = found.c;
  if (!c.source_path) {
    return { error: 'that clip is generated (a title or adjustment) and has no speech to analyse' };
  }

  const fps = timelineFps(tl);
  const tuning = retakeTuning(a);
  const recover = recoverRequested(a);
  // D-364/B-237 — a named clip is still ANSWERED about on its own, but it is
  // READ as part of the continuous take it belongs to. Scoping the view to one
  // clip is what made a restart whose halves sit in two clips structurally
  // undetectable, and a human reviewing clip K in the Recut panel wants the
  // stumble K is part of, not the half of it that happens to fall inside K.
  // Building the run here (rather than only in the sweep) also means one clip
  // and a sweep derive the IDENTICAL `RetakeDetectionArgs`, so they share a
  // cache key and can never report the same material differently.
  const run = runFor(tl, found.track, found.clip, c, fps, tuning.windowSecs);

  // B-249 — the start call RECORDS its request; the `_status` twin carries a
  // recorded request on (`drive`) and is a pure read for anything else. The
  // chain behind one request (transcript, D-349 scan, one recovery per window,
  // grouping) can only advance a step at a time as each lands, so a status
  // poll that never advanced it stalled at whichever step it had reached.
  const store = useMediaUnderstandingStore.getState();
  const request = retakeRequestFor(run, recover, tuning);
  if (start) store.requestRetakes(request);
  const drive = start || store.retakeRequested(request);

  const transcript = store.transcriptStatus(c.source_path);
  if (transcript.phase === 'error') {
    store.settleRetakeRequest(request);
    return { error: transcript.error ?? 'transcription failed' };
  }
  if (transcript.phase !== 'done') {
    if (!drive) return { pending: { ok: true, source: c.source_path, ...retakesNotRequested() } };
    store.startTranscript(c.source_path, { wordTimestamps: true });
    return {
      pending: {
        ok: true,
        source: c.source_path,
        state: transcript.phase === 'idle' ? 'running' : transcript.phase,
        note: 'a transcript is needed first — poll editor_get_transcript_status, then call this again',
      },
    };
  }

  const rv = runTranscriptView(
    run,
    transcript.result as Transcript,
    recover,
    // Only a requested job advances (B-249): the start call itself, or a poll
    // continuing one. A status read nobody asked for starts no scan and no
    // re-read of its own.
    drive,
    // `force` retries a scan or a re-read that FAILED — which is the only way
    // to retry one, since a failure otherwise degrades to the raw transcript
    // rather than spinning (see `clipTranscriptView`).
    !!a?.force,
    fps,
  );
  if (rv.pending) {
    return {
      pending: {
        ok: true,
        source: c.source_path,
        ...(drive ? recoveryPending(rv.pending) : retakesNotRequested()),
      },
    };
  }

  const args = retakeArgsFor(rv, tuning);
  return { found, c, fps, args, key: retakeKey(args), run, rv, request, drive };
}

/** The key a start call records its retake request under (B-249) — the run and
 *  every knob that decides what the request leads to. Shared by the single-clip
 *  path and the sweep so a sweep's start and a single clip's poll (or the other
 *  way round) are the same request, exactly as they share `retakeKey`. */
function retakeRequestFor(run: ClipRun, recover: boolean, tuning: RetakeTuning): string {
  return retakeRequestKey({
    path: run.source,
    startSecs: run.startSecs,
    durationSecs: run.durationSecs,
    recoverDarkRegions: recover,
    ...tuning,
  });
}

/** A `_status` read for a retake job no start call asked for, whose words are
 *  not all in yet (B-249). Nothing will advance it — a status read starts
 *  nothing — so the note says what will. */
function retakesNotRequested(): { state: 'idle'; note: string } {
  return {
    state: 'idle',
    note: 'no editor_detect_retakes call has asked about this clip, and a status read starts nothing — call editor_detect_retakes',
  };
}

/** Settle a retake request once its grouping has a terminal answer (B-249):
 *  from then on there is nothing left to carry on, and a later poll must not
 *  re-run a grouping that failed. */
function settleIfAnswered(request: string, phase: AnalysisPhase): void {
  if (phase === 'done' || phase === 'error') {
    useMediaUnderstandingStore.getState().settleRetakeRequest(request);
  }
}

/** The retake tuning knobs, parsed once.
 *
 *  Shared by the single-clip path and the sweep because D-364 makes both build
 *  the same `RetakeDetectionArgs` for the same run: two copies of this parsing
 *  that ever disagreed would split one detection into two cache entries. */
interface RetakeTuning {
  similarity?: number;
  windowSecs?: number;
  minWords?: number;
  maxSpanUtterances?: number;
  phraseMinWords?: number;
}

function retakeTuning(a: OpArgs): RetakeTuning {
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    similarity: num(a?.similarity),
    windowSecs: num(a?.windowSecs),
    minWords: a?.minWords === undefined ? undefined : Math.round(Number(a.minWords)),
    maxSpanUtterances:
      a?.maxSpanUtterances === undefined
        ? undefined
        : Math.max(1, Math.round(Number(a.maxSpanUtterances))),
    // 0 is meaningful here — it turns the phrase signal off (D-365) — so this
    // one floors at 0 rather than at 1 the way `maxSpanUtterances` does.
    phraseMinWords:
      a?.phraseMinWords === undefined
        ? undefined
        : Math.max(0, Math.round(Number(a.phraseMinWords))),
  };
}

/** The run one named clip belongs to (D-364).
 *
 *  Falls back to a run of just that clip when the clip is not something a sweep
 *  would analyse at all — a still with a source path, which `sweepTargets`
 *  excludes but the single-clip tool has always accepted. The answer for such a
 *  clip is then exactly what it was before D-364. */
function runFor(
  tl: Timeline,
  track: number,
  clip: number,
  c: Clip,
  fps: number,
  windowSecs: number | undefined,
): ClipRun {
  const source = c.source_path ?? '';
  const { targets } = sweepTargets(tl.tracks[track]);
  const found = clipRuns(targets, fps, runGapSecs(windowSecs)).find((r) =>
    r.targets.some((t) => t.clip === clip),
  );
  if (found) return found;
  const range = clipSourceRangeSecs(c, fps);
  return { source, targets: [{ clip, c, source }], ...range };
}

/** The detection arguments for one run. The run's own source range is the key's
 *  range, so every clip of a run asks one identical question exactly once.
 *
 *  The utterances are rebuilt field by field rather than passed through: D-349's
 *  `recovered` flag is local bookkeeping (see [`Utterance`]) and has no business
 *  crossing the wire into the detector. */
function retakeArgsFor(rv: RunTranscriptView, tuning: RetakeTuning): RetakeDetectionArgs {
  return {
    path: rv.run.source,
    startSecs: rv.run.startSecs,
    durationSecs: rv.run.durationSecs,
    utterances: rv.utterances.map((u) => ({ start: u.start, end: u.end, text: u.text })),
    recovered: rv.recovered,
    ...tuning,
  };
}

/** Should this call scan for and recover dropped speech before grouping?
 *
 *  **Default ON** (D-349). Reading the raw whole-file transcript is not a
 *  neutral default for THIS tool: the material the ASR drops was measured (on Whisper) biased
 *  towards retakes, so a grouper reading it is blind in exactly the place it is looking.
 *  `recoverDarkRegions: false` opts out — worth it when the caller already knows
 *  the file is clean and wants the answer in one round trip instead of three. */
function recoverRequested(a: OpArgs): boolean {
  return a?.recoverDarkRegions !== false;
}

/** The envelope for a call whose answer is waiting on the recovery rather than
 *  on the grouping. Deliberately the SAME `state: "transcribing"` the
 *  transcript-not-ready branch uses: in both cases the words are not all here
 *  yet and the move is to poll, so an agent that already handles one handles
 *  this. The note says which of the two it is. */
function recoveryPending(pending: 'scanning' | 'recovering'): {
  state: 'transcribing';
  note: string;
} {
  return {
    state: 'transcribing',
    note:
      pending === 'scanning'
        ? 'scanning for speech the ASR did not transcribe (D-349) — poll editor_detect_retakes_status (each poll carries the job on: re-reads, then grouping), or pass recoverDarkRegions: false to group the raw transcript now'
        : 're-transcribing the dropped speech this clip contains — poll editor_detect_retakes_status; the recovered words are spliced in and the grouping starts by itself once they land',
  };
}

/** Every retake group in one detection, as a caller sees it: one entry per
 *  DELIVERY via `groupTakes` — a delivery can span several transcript
 *  utterances since D-327, and `keep` indexes takes. Building one entry per
 *  member (which is what this did before D-327) would make `keep` point at a
 *  fragment and invite an agent to cut the rest of the keeper.
 *
 *  Shared by the single-clip envelope and the whole-track sweep (D-342) so the
 *  two cannot report the same group differently. */
function retakeGroupsDto(
  status: AnalysisStatus<RetakeDetection>,
  run: ClipRun,
  fps: number,
  gates?: readonly DetectorGateResult[],
) {
  return (status.result?.groups ?? [])
    .map((g, gi) => ({
      similarity: g.similarity,
      keep: g.keep,
      // D-382 — the coverage gate's verdict on this group, as for a client's.
      ...gateDto(gates?.[gi]),
      takes: groupTakes(g).map((t) => {
        const segments = takeSegments(run, t.startSecs, t.endSecs, fps);
        return {
          text: t.text,
          startSecs: t.startSecs,
          endSecs: t.endSecs,
          // Every clip this delivery lands in, and where in each. A take that
          // spans several is the normal case after a fine-grained silence cut,
          // and is exactly what B-237 was blind to.
          clips: segments.map((s) => s.clip),
          segments: segments.map((s) => ({ clip: s.clip, clipId: s.clipId, ...s.span })),
          // The flat frame fields stay EXACTLY as they were for a take that
          // lives in one clip, which is every take this tool has ever returned.
          // They are deliberately absent when a take spans several: one
          // `{startFrame, endFrame}` cannot describe two clips' worth of cut,
          // and emitting a clamped one would quietly under-cut. A caller that
          // reads them blindly gets nothing rather than something wrong; the
          // ranges to cut are in `segments`.
          ...(segments.length === 1
            ? {
                sourceStartFrame: segments[0].span.sourceStartFrame,
                sourceEndFrame: segments[0].span.sourceEndFrame,
                startFrame: segments[0].span.startFrame,
                endFrame: segments[0].span.endFrame,
              }
            : {}),
        };
      }),
    }))
    // A group none of whose takes land on a real frame has nothing to review:
    // the material it was found in is no longer on the timeline.
    .filter((g) => g.takes.some((t) => t.segments.length > 0));
}

/** One detector group's gate verdict as the MCP answer carries it (D-382):
 *  `status` in the same vocabulary `editor_propose_retakes` uses, and for a
 *  refusal the reason and the words its cut would lose. */
function gateDto(gate: DetectorGateResult | undefined) {
  if (!gate) return {};
  return gate.status === 'verified'
    ? { status: 'verified' as const }
    : {
        status: 'refused' as const,
        reason: gate.reason,
        reasonText: gate.reasonText,
        offending: gate.offending,
      };
}

/** Run one detection's groups through the coverage gate (D-382). `undefined`
 *  while there is nothing to gate (not done yet). */
async function gateDetection(
  status: AnalysisStatus<RetakeDetection>,
  run: ClipRun,
  track: number,
): Promise<DetectorGateResult[] | undefined> {
  if (status.phase !== 'done' || !status.result) return undefined;
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return undefined;
  return gateDetectorGroups(tl, track, run.source, detectedForGate(status.result.groups));
}

/** The clip a group is reported under: the earliest one any of its takes
 *  touches. Reported ONCE, not once per clip it spans — a sweep's caller acts
 *  on the `flagged` list as a whole, and repeating a group under each of its
 *  clips would make one stumble look like three. */
function groupHomeClip(g: { takes: Array<{ clips: number[] }> }): number | null {
  const clips = g.takes.flatMap((t) => t.clips);
  return clips.length === 0 ? null : Math.min(...clips);
}

/** Every silence in one detection, in the three frame spaces a caller needs.
 *  Shared by the single-clip envelope and the sweep, for the same reason
 *  [`retakeGroupsDto`] is. */
function silenceSpansDto(status: AnalysisStatus<SilenceDetection>, c: Clip, fps: number) {
  return (status.result?.silences ?? []).map((s) => spanToFrames(c, s.start_secs, s.end_secs, fps));
}

/** [`silenceEnvelope`]'s retake twin. */
async function retakeEnvelope(
  status: AnalysisStatus<RetakeDetection>,
  found: ResolvedClip,
  c: Clip,
  fps: number,
  utterances: number,
  rv: RunTranscriptView,
) {
  if (status.phase === 'error') return { error: status.error ?? 'retake detection failed' };
  const head = {
    ok: true as const,
    track: found.track,
    clip: found.clip,
    clipId: c.id,
    source: c.source_path,
    utterances,
    // D-364/B-237 — say plainly when the answer was read over more than the one
    // clip that was asked about, and which clips that was. Omitted for a clip
    // that is its own run, which is the answer's pre-D-364 shape exactly.
    ...(rv.run.targets.length > 1
      ? { readAcrossClips: rv.run.targets.map((t) => t.clip) }
      : {}),
    // D-349 — a caller is entitled to know the transcript it is being told about
    // is NOT the one the ASR handed us.
    ...darkSummary(rv),
  };
  if (status.phase !== 'done') {
    return {
      ...head,
      state: status.phase,
      note:
        status.phase === 'running'
          ? 'still analysing this clip — poll editor_detect_retakes_status'
          : 'nothing has been started for this clip — call editor_detect_retakes',
    };
  }
  // Only the groups that actually touch the clip that was asked about. The
  // detection is read over the whole run (D-364), but "tell me about clip K"
  // still answers about clip K — a group entirely inside K's neighbours is not
  // K's business, and a group STRADDLING K is, which is the case that used to
  // be missing altogether.
  const gates = await gateDetection(status, rv.run, found.track);
  const groups = retakeGroupsDto(status, rv.run, fps, gates).filter((g) =>
    g.takes.some((t) => t.clips.includes(found.clip)),
  );
  return {
    ...head,
    state: 'done',
    groups,
    note:
      groups.length === 0
        ? 'no retakes found in this clip'
        : 'nothing was cut — `keep` is a SUGGESTION (the last take); cut the others with editor_ripple_delete_ranges. ' +
          GATE_NOTE,
  };
}


/** [`resolveSilenceArgs`]'s dark-region twin (D-349).
 *
 *  Like the retake resolver it can come back `pending`, and for the same
 *  reason: a dark region is defined against the transcript's own WORDS, so
 *  without a word-level transcript there is nothing to compare the VAD to. */
function resolveDarkArgs(
  a: OpArgs,
):
  | { error: string }
  | { pending: Record<string, unknown> }
  | {
      found: ResolvedClip;
      c: Clip;
      fps: number;
      args: DarkDetectionArgs;
      key: string;
    } {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return noTimeline();
  const found = resolveClip(tl, a?.track, a?.clip);
  if ('error' in found) return found;
  const c = found.c;
  if (!c.source_path) {
    return { error: 'that clip is generated (a title or adjustment) and has no audio to analyse' };
  }

  const num = (v: unknown, name: string): number | undefined | { error: string } => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return { error: `${name} must be a positive number` };
    return n;
  };
  const minDarkSecs = num(a?.minDarkSecs, 'minDarkSecs');
  if (typeof minDarkSecs === 'object') return minDarkSecs;
  const maxWordSecs = num(a?.maxWordSecs, 'maxWordSecs');
  if (typeof maxWordSecs === 'object') return maxWordSecs;
  const rmsFloorScale = num(a?.rmsFloorScale, 'rmsFloorScale');
  if (typeof rmsFloorScale === 'object') return rmsFloorScale;

  const transcript = useMediaUnderstandingStore.getState().transcriptStatus(c.source_path);
  if (transcript.phase === 'error') {
    return { error: transcript.error ?? 'transcription failed' };
  }
  if (transcript.phase !== 'done') {
    useMediaUnderstandingStore.getState().startTranscript(c.source_path, { wordTimestamps: true });
    return {
      pending: {
        ok: true,
        source: c.source_path,
        state: transcript.phase === 'idle' ? 'running' : transcript.phase,
        note: 'a word-level transcript is needed first — poll editor_get_transcript_status, then call this again',
      },
    };
  }
  const words = (transcript.result?.words ?? []).map((w) => ({ start: w.start, end: w.end }));
  if (words.length === 0) {
    return {
      error:
        "this source's transcript has no word timings, and a dark region is defined against " +
        'individual words — re-run editor_get_transcript with wordTimestamps (the default)',
    };
  }

  const fps = timelineFps(tl);
  const range = clipSourceRangeSecs(c, fps);
  const args: DarkDetectionArgs = {
    path: c.source_path,
    startSecs: range.startSecs,
    durationSecs: range.durationSecs,
    words,
    minDarkSecs,
    maxWordSecs,
    rmsFloorScale,
  };
  return { found, c, fps, args, key: darkKey(args) };
}

/** [`silenceEnvelope`]'s dark-region twin. Every region comes back in all three
 *  frame spaces through the same `spanToFrames` the other two detectors use, so
 *  a dark region, a silence and a retake take can be compared frame for frame. */
function darkEnvelope(
  status: AnalysisStatus<DarkDetection>,
  found: ResolvedClip,
  c: Clip,
  fps: number,
) {
  if (status.phase === 'error') return { error: status.error ?? 'the dark-region scan failed' };
  const head = {
    ok: true as const,
    track: found.track,
    clip: found.clip,
    clipId: c.id,
    source: c.source_path,
  };
  if (status.phase !== 'done' || !status.result) {
    return {
      ...head,
      state: status.phase,
      note:
        status.phase === 'running'
          ? 'still scanning this clip — poll editor_detect_dark_regions_status'
          : 'nothing has been started for this clip — call editor_detect_dark_regions',
    };
  }
  const d = status.result;
  const regions = d.regions.map((r: DarkRegionWire) => ({
    ...spanToFrames(c, r.start_secs, r.end_secs, fps),
    stretchStartSecs: r.stretch_start_secs,
    stretchEndSecs: r.stretch_end_secs,
    stretchSpeechSecs: r.stretch_speech_secs,
    rmsPeak: r.rms_peak,
  }));
  return {
    ...head,
    state: 'done',
    regions,
    // The gate's own workings. Without these "no dark regions" is ambiguous
    // between "this file is clean" and "nothing here could be calibrated".
    rmsFloor: d.rms_floor,
    calibrationSpans: d.calibration_spans,
    gatedOut: d.gated_out,
    speechSecs: d.speech_secs,
    coveredSecs: d.covered_secs,
    note:
      regions.length === 0
        ? d.rms_floor === null
          ? 'no dropped speech found — but too few well-transcribed utterances in this range to calibrate the amplitude gate, so this answer is ungated'
          : 'no dropped speech found in this clip'
        : 'these ranges contain speech the transcript does not account for; nothing was cut. ' +
          'editor_detect_retakes re-transcribes them and splices the words in automatically — ' +
          'this tool only reports them',
  };
}

/** What a retake answer says about the dark-region pass behind it (D-349).
 *
 *  `darkRegions` is how many holes the scan found in this clip's range;
 *  `recoveredUtterances` is how many of the grouped utterances exist only
 *  because the app went back for them; `unreadDarkRegions` lists the regions
 *  still holding speech-like sound no re-read could put words to (D-387). All
 *  three are omitted entirely when no scan ran (`recoverDarkRegions: false`,
 *  or a transcript with no word timings) — a zero would claim a clean scan that never happened. */
function darkSummary(rv: RunTranscriptView): Record<string, unknown> {
  // Summed over the run's clips (D-364). A run of one — the only shape that
  // existed before it — reduces to exactly the old numbers.
  const scanned = rv.views.filter((v) => v.detection);
  const error = rv.views.find((v) => v.error)?.error;
  if (scanned.length === 0) {
    return error ? { darkScanError: error } : {};
  }
  return {
    darkRegions: scanned.reduce((n, v) => n + (v.detection?.regions.length ?? 0), 0),
    recoveredUtterances: rv.recovered,
    unreadDarkRegions: rv.unread.map(unreadWire),
    ...(error ? { darkScanError: error } : {}),
  };
}

/** One region no recovery could read (D-387), as a retake answer lists it:
 *  absolute source seconds and its RMS peak, so a caller can seek there and
 *  listen. Listing them is the point — a count alone would not say where the
 *  transcript is still blind. */
function unreadWire(r: DarkRegionWire): Record<string, number> {
  return { startSecs: r.start_secs, endSecs: r.end_secs, rmsPeak: r.rms_peak };
}

/** Is this call a whole-track SWEEP rather than a single-clip question?
 *
 *  D-342/B-216 — `clip` became optional on both detectors and both of their
 *  `_status` twins rather than four new `*_all` tool names, so an agent that
 *  already knows `editor_detect_retakes` gets the sweep by leaving one
 *  argument out instead of by learning a second tool. Omitting `clip` was a
 *  plain error before this (`resolveClip` reported `no clip NaN on track 0`),
 *  so nothing that used to work changes meaning. */
function isSweep(a: OpArgs): boolean {
  return a?.clip === undefined || a?.clip === null;
}

/** The track a sweep runs over, parsed and range-checked with the SAME error
 *  string `resolveClip` gives, so "no track 7" reads identically whether you
 *  named a clip or not. */
function resolveSweepTrack(
  a: OpArgs,
): { error: string } | { tl: Timeline; track: number; tr: Timeline['tracks'][number]; fps: number } {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return noTimeline();
  const track = Math.round(Number(a?.track));
  const tr = tl.tracks[track];
  if (!tr) return { error: `no track ${track} (0..${tl.tracks.length - 1})` };
  return { tl, track, tr, fps: timelineFps(tl) };
}

/** One RUN's place in a retake sweep: which clips, and the cache key its one
 *  detection will land under (D-364 — the unit was a clip before B-237, and a
 *  clip-scoped view is what made a restart spanning two clips invisible).
 *  `key` is `null` for a run whose transcript has not arrived — there is
 *  nothing to key a grouping on until there are words. */
interface SweepJob {
  run: ClipRun;
  key: string | null;
  /** The run's [`retakeRequestFor`] key (B-249). */
  request: string;
  /** Whether this call advances the run: a start call, or a poll carrying on a
   *  request a start call recorded. A run nothing drives reports `idle`. */
  drive: boolean;
  /** Set when the run failed before any detection could start (a transcript
   *  that errored), so the sweep reports the real reason rather than an eternal
   *  `running`. */
  failure?: string;
  /** The merged, D-349-recovered view behind this run's utterances, when there
   *  is one. Absent for a run whose transcript has not arrived yet. */
  rv?: RunTranscriptView;
}

/** Wait for a whole sweep the same way `settleWithin` waits for one clip.
 *
 *  Deliberately ONE shared grace window for the batch, not `DETECT_GRACE_MS`
 *  per clip: the budget exists to stay inside `chroma::control`'s 20 s bridge
 *  timeout, and a per-clip budget would blow it on the second clip. Anything
 *  still going when the window closes comes back `state: "running"` with its
 *  answer still being computed INTO THE STORE, exactly as a single-clip call
 *  does (D-321) — which is what makes the sweep pollable instead of a request
 *  that can time out and throw N answers away. */
async function settleSweep(anyRunning: () => boolean): Promise<void> {
  await settleWithin(() => ({ phase: anyRunning() ? 'running' : 'done' }), DETECT_GRACE_MS);
}

/** `editor_detect_silences` / `_status` with `clip` omitted: every analysable
 *  clip on one track, in ONE dispatch (D-342). */
async function silenceSweep(a: OpArgs, start: boolean) {
  const resolved = resolveSweepTrack(a);
  if ('error' in resolved) return resolved;
  const { track, tr, fps } = resolved;

  const requested = a?.minSilenceMs === undefined ? undefined : Number(a.minSilenceMs);
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    return { error: 'minSilenceMs must be a positive number of milliseconds' };
  }

  const { targets, skipped } = sweepTargets(tr);
  const jobs = targets.map((target) => {
    const range = clipSourceRangeSecs(target.c, fps);
    const args: SilenceDetectionArgs = {
      path: target.source,
      startSecs: range.startSecs,
      durationSecs: range.durationSecs,
      minSilenceMs: requested,
    };
    // Two clips trimmed to the same range of the same file share a key, so the
    // store already collapses them into one detection — a sweep of a track cut
    // out of one source does not re-decode anything twice.
    if (start) useMediaUnderstandingStore.getState().startSilenceDetection(args, !!a?.force);
    return { target, key: silenceKey(args), args };
  });

  const read = (key: string) =>
    useMediaUnderstandingStore.getState().silenceDetectionStatus(key);
  if (start) await settleSweep(() => jobs.some((j) => read(j.key).phase === 'running'));

  const results: SweepClipResult[] = jobs.map(({ target, key }) => {
    const status = read(key);
    return {
      clip: target.clip,
      clipId: target.c.id,
      source: target.source,
      state: status.phase,
      findings: status.phase === 'done' ? silenceSpansDto(status, target.c, fps) : [],
      ...(status.phase === 'error' ? { error: status.error ?? 'silence detection failed' } : {}),
    };
  });

  return {
    ...sweepReport(SILENCE_SWEEP, track, results, skipped),
    minSilenceMs: requested ?? DEFAULT_MIN_SILENCE_MS,
  };
}

/** [`silenceSweep`]'s retake twin.
 *
 *  The extra state it has to carry is the transcript. A retake is a fact about
 *  WORDS, and on a 75-clip talking-head track those words come from a handful
 *  of source FILES — so the transcript is started once per file (the store
 *  keys it by path), never once per clip, exactly as
 *  `editor_get_timeline_transcript` does (D-329). A clip whose file is still
 *  being transcribed reports `transcribing` and the rest of the sweep carries
 *  on: one missing transcript must not cost the caller the other 74 answers,
 *  which is the whole failure B-216 is about. */
async function retakeSweep(a: OpArgs, start: boolean) {
  const resolved = resolveSweepTrack(a);
  if ('error' in resolved) return resolved;
  const { track, tr, fps } = resolved;

  const tuning = retakeTuning(a);

  const { targets, skipped } = sweepTargets(tr);

  // One transcript per FILE, started before anything is grouped, so N clips off
  // one source cost one transcription rather than N.
  if (start) {
    for (const source of new Set(targets.map((t) => t.source))) {
      const phase = useMediaUnderstandingStore.getState().transcriptStatus(source).phase;
      if (phase === 'done' || phase === 'running') continue;
      useMediaUnderstandingStore.getState().startTranscript(source, { wordTimestamps: true });
    }
  }

  const recover = recoverRequested(a);
  // D-364/B-237 — the sweep's unit is a RUN of clips cut from one continuous
  // stretch of one source, not a clip. Detection runs once per run over the
  // merged view, so a restart whose two halves were split across clips by an
  // earlier silence cut is inside one view for the first time.
  const runs = clipRuns(targets, fps, runGapSecs(tuning.windowSecs));
  const store = useMediaUnderstandingStore.getState();
  const jobs: SweepJob[] = runs.map((run) => {
    // B-249 — the start call records one request per run; a status poll
    // carries a recorded one on and only reads the rest (see
    // `resolveRetakeArgs`, which keys the same request for one named clip).
    const request = retakeRequestFor(run, recover, tuning);
    if (start) store.requestRetakes(request);
    const drive = start || store.retakeRequested(request);

    const transcript = store.transcriptStatus(run.source);
    if (transcript.phase === 'error') {
      store.settleRetakeRequest(request);
      return { run, key: null, request, drive, failure: transcript.error ?? 'transcription failed' };
    }
    if (transcript.phase !== 'done') return { run, key: null, request, drive };

    // The D-349 scan and splice still happen per CLIP, with the same keys and
    // the same windows — only the grouping input is merged. A sweep that
    // grouped the raw transcript while a single-clip call grouped the recovered
    // one would be two detectors again, which is the drift B-216 is made of.
    const rv = runTranscriptView(
      run,
      transcript.result as Transcript,
      recover,
      drive,
      !!a?.force,
      fps,
    );
    // Still scanning or still recovering: the words are not all here, which is
    // the same thing `transcribing` already means on this track.
    if (rv.pending) return { run, key: null, request, drive, rv };

    const args = retakeArgsFor(rv, tuning);
    const key = retakeKey(args);
    // A start call (re)starts the grouping as it always has; a poll carrying a
    // request on starts it only from `idle`, so it never re-runs a failure.
    if (start) store.startRetakeDetection(args, !!a?.force);
    else if (drive && store.retakeDetectionStatus(key).phase === 'idle') {
      store.startRetakeDetection(args, false);
    }
    return { run, key, request, drive, rv };
  });

  const read = (key: string) => useMediaUnderstandingStore.getState().retakeDetectionStatus(key);
  if (jobs.some((j) => j.drive)) {
    await settleSweep(() => jobs.some((j) => j.key !== null && read(j.key).phase === 'running'));
  }

  // A run's answer is reported against the CLIPS it was read over, so the
  // report's shape is unchanged — one row per clip, `flagged` acted on the same
  // way. A group that spans several clips is reported once, under the earliest
  // clip it touches, with every clip and frame range it covers inside it.
  const results: SweepClipResult[] = [];
  for (const { run, key, failure, request, drive } of jobs) {
    const heads = run.targets.map((t) => ({
      clip: t.clip,
      clipId: t.c.id,
      source: t.source,
    }));
    if (failure) {
      for (const head of heads) results.push({ ...head, state: 'error', findings: [], error: failure });
      continue;
    }
    if (key === null) {
      // No key means no words yet: the grouping has not been asked for, and the
      // thing to wait on is the transcript — or, since D-349, the scan/recovery
      // that is still going and getting the rest of the words. A run nothing
      // drives (B-249: a status read of a run no start call asked for) is
      // `idle` instead — nothing is going to bring its words in.
      const state = drive ? 'transcribing' : 'idle';
      for (const head of heads) results.push({ ...head, state, findings: [] });
      continue;
    }
    const status = read(key);
    settleIfAnswered(request, status.phase);
    const groups =
      status.phase === 'done'
        ? retakeGroupsDto(status, run, fps, await gateDetection(status, run, track))
        : [];
    for (const head of heads) {
      results.push({
        ...head,
        state: status.phase,
        findings: groups.filter((g) => groupHomeClip(g) === head.clip),
        ...(status.phase === 'error' ? { error: status.error ?? 'retake detection failed' } : {}),
      });
    }
  }

  // The recovery is a fact about the whole sweep, not about one clip, so it is
  // summarised once at the top rather than repeated on 75 rows (the same "full
  // detail only where there is something to act on" rule the report itself
  // keeps). `darkRegions: 0` on a sweep that ran IS information — it says the
  // track was scanned and was clean.
  const scannedViews = jobs.flatMap((j) => j.rv?.views.filter((v) => v.detection) ?? []);
  return {
    ...sweepReport(RETAKE_SWEEP, track, results, skipped),
    ...(recover && scannedViews.length > 0
      ? {
          darkRegions: scannedViews.reduce((n, v) => n + (v.detection?.regions.length ?? 0), 0),
          recoveredUtterances: jobs.reduce((n, j) => n + (j.rv?.recovered ?? 0), 0),
          unreadDarkRegions: jobs.flatMap((j) => j.rv?.unread ?? []).map(unreadWire),
          darkScanned: scannedViews.length,
        }
      : {}),
    // D-364/B-237 — how the track was actually read. `runs < analysable` is the
    // signal that clips were merged back into continuous takes before grouping,
    // which is the whole point of the fix and is otherwise invisible.
    runs: runs.length,
  };
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
          // D-266 — the master monitoring volume + mute, the read half of
          // `editor_set_audio_monitor`. Reported here for the same reason
          // `previewZoom` is: it silently changes what `editor_set_playing`
          // produces (a muted transport plays exactly the same timeline and
          // makes no sound), so a caller reasoning about audio needs it in the
          // one state call rather than by inference.
          monitor: { volume: s.monitorVolume, muted: s.monitorMuted },
          // D-280 — the transport's PLAYBACK rate, the read half of
          // `editor_set_playback_rate`. Reported for the same reason
          // `previewZoom` and `monitor` are: it silently changes what
          // `editor_set_playing` does (playback runs `playbackRate` times
          // faster and the playhead lands somewhere else after N seconds), so a
          // caller reasoning about the transport needs it in the one state call
          // rather than by inference. NOT any clip's speed — that is per-clip,
          // in `editor_get_timeline`.
          playbackRate: s.playbackRate,
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
        const s = useEditorTimelineStore.getState();
        return {
          ok: true,
          playing: s.playing,
          // D-280 — said here, not just in `editor_get_state`, because it
          // changes what this very call did: at 4x, five seconds of wall clock
          // moves the playhead twenty seconds down the timeline.
          playbackRate: s.playbackRate,
        };
      },

      // ---- D-280: the transport's playback RATE ---------------------------
      //
      // The MCP half of the preview playback-rate control (roadmap, owner
      // request 2026-09-10). Same store action the human's transport control
      // writes, per CLAUDE.md's human-AND-AI rule.
      //
      // **Deliberately separate from `editor_set_clip_speed`, and the two must
      // not be confused.** That one edits a CLIP: it is persisted, undoable,
      // changes the clip's duration on the timeline, and is baked into the
      // export. This one changes how fast the preview PLAYS and touches nothing
      // — an export taken at 4x preview renders exactly what an export at 1x
      // renders. The tool's own doc in `mcp/server.py` says so at the top,
      // because "make this faster" is genuinely ambiguous between the two.

      editor_set_playback_rate: (a) => {
        if (a?.rate === undefined || a?.rate === null) {
          return {
            error:
              'pass rate: timeline seconds played per real second (1 = normal, 2/3/4 = faster review, 0.5 = slower). To change a CLIP\'s speed instead, use editor_set_clip_speed.',
          };
        }
        const rate = Number(a.rate);
        if (!Number.isFinite(rate) || rate <= 0) {
          return { error: 'rate must be a finite number greater than 0' };
        }
        useEditorTimelineStore.getState().setPlaybackRate(rate);
        const s = useEditorTimelineStore.getState();
        return {
          ok: true,
          playbackRate: s.playbackRate,
          playing: s.playing,
          // Never a silent no-op (B-053's shape): an out-of-range request is
          // honoured as the clamp and says so, rather than reporting back a
          // number the caller did not ask for with no explanation.
          note:
            rate !== s.playbackRate
              ? `rate ${rate} is outside ${MIN_PLAYBACK_RATE}..${MAX_PLAYBACK_RATE} and was clamped to ${s.playbackRate}`
              : undefined,
        };
      },

      // ---- D-266: audio monitoring ----------------------------------------
      //
      // **There is only ONE transport, and this is not it.** `editor_set_playing`
      // already starts and stops the audio: `PreviewPane`'s own effect keys
      // `chroma_audio_play`/`chroma_audio_stop` off the store's `playing` flag,
      // so picture and sound are one play/pause and always have been. The
      // tracking doc listed "audio playback transport" as a zero-coverage gap
      // over four hypothetical command names; three of those four were already
      // covered (`_play`/`_stop` by `editor_set_playing`, `_waveform` by
      // D-232's `editor_get_waveform`). What genuinely had no tool is the pair
      // below — the monitoring LEVEL a human sets by ear, and the output level
      // an agent has no ear for. See D-266.
      //
      // The scrub commands (`chroma_audio_scrub_*`) deliberately still have no
      // tool, on D-232's own reasoning: a tape-scrub's entire content is
      // "audio, now, while my hand moves", which an agent cannot hear.

      editor_set_audio_monitor: (a) => {
        const wantsVolume = a?.volume !== undefined && a?.volume !== null;
        const wantsMuted = a?.muted !== undefined && a?.muted !== null;
        if (!wantsVolume && !wantsMuted) {
          return { error: 'pass volume (0..1), muted (true/false), or both' };
        }
        const volume = wantsVolume ? Number(a.volume) : undefined;
        if (volume !== undefined && !Number.isFinite(volume)) {
          return { error: 'volume must be a finite number in 0..1' };
        }
        useEditorTimelineStore.getState().setAudioMonitor({
          volume,
          muted: wantsMuted ? !!a.muted : undefined,
        });
        const s = useEditorTimelineStore.getState();
        return {
          ok: true,
          volume: s.monitorVolume,
          muted: s.monitorMuted,
          // Never a silent no-op (B-053's shape): an out-of-range request is
          // honoured as the clamp `chroma_audio_set_volume` itself applies,
          // and says so rather than reporting back a number the caller did not
          // ask for with no explanation.
          note:
            volume !== undefined && volume !== s.monitorVolume
              ? `volume ${volume} is outside 0..1 and was clamped to ${s.monitorVolume}`
              : undefined,
          // The one thing that makes this reading unambiguous: what the output
          // callback is actually multiplying by right now.
          effectiveVolume: s.monitorMuted ? 0 : s.monitorVolume,
        };
      },

      // The agent's ears. A human verifies "is sound really coming out" by
      // listening; nothing in the GUI shows it, because for a human nothing
      // needs to. This is the same information, as a number — D-232's own
      // reasoning for `editor_get_waveform` ("what an agent actually needs
      // from the same capability is the *information* a human gets by ear"),
      // applied to the live output rather than to the file.
      editor_get_audio_level: async () => {
        const [rms, peak] = await invoke<[number, number]>('chroma_audio_level');
        const s = useEditorTimelineStore.getState();
        return {
          ok: true,
          rms,
          peak,
          playing: s.playing,
          muted: s.monitorMuted,
          volume: s.monitorVolume,
          // The measurement window is ~1 second of real output (see
          // `build_typed` in `crates/chroma-media/src/audio.rs`), so this is a
          // "did non-silent PCM reach the device recently" probe and NOT a
          // meter: it lags a change by up to a second and is stale, not zero,
          // for that long after a stop.
          windowSecs: 1,
          note:
            !s.playing
              ? 'nothing is playing — this is the last measured window, not a live reading. Call editor_set_playing first, wait ~1s, then read again.'
              : rms === 0 && peak === 0
                ? 'playing, but the last measured window was pure silence: either the first window has not completed yet (wait ~1s), or nothing audible is under the playhead, or the monitor is muted.'
                : undefined,
        };
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
          // before it selects a gap, so this op can never produce a gap
          // selection the GUI could not have produced. Being selectable is NOT
          // the same as being closeable, though (B-236): on a sync-locked
          // timeline `remove_gap` also refuses when another track has a clip
          // straddling the gap's end (B-033). The response says which, from the
          // same `checkRemoveGap` the GUI's Close Gap button and
          // `editor_remove_gap` both run.
          const gap = gapAt(tr, frame, timelineFps(tl));
          if (!gap) {
            return {
              error: `frame ${frame} on track ${track} is not inside a real, closeable gap (a gap needs a clip after it — trailing empty space past the last clip is not one)`,
            };
          }
          const closeCheck = checkRemoveGap(tl, track, frame, timelineFps(tl));
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
            // B-236 — whether `editor_remove_gap` would close it, and if not,
            // the exact reason the GUI's (disabled) Close Gap button shows.
            closeable: closeCheck.ok,
            ...(closeCheck.ok ? {} : { closeRefusedReason: closeCheck.reason }),
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
      //
      // D-266 — the pool's read + organise half. Every one of these four wraps
      // a `useMediaPoolStore` action the Sources panel's own UI already calls
      // (`refresh` behind its list, `createFolder` behind "New folder",
      // `moveToFolder` behind its drag-onto-a-bin), so the agent and the human
      // go through one store action into one `chroma_media_*` command, per
      // CLAUDE.md's one-op-under-both-interfaces rule. No new backend, no new
      // pool logic.
      editor_list_media: async () => {
        // Read from DISK, not from whatever this store happens to be holding.
        // The pool store is populated by `importPaths` appending its own
        // result or by an explicit `refresh()`, so an item seeded another way
        // — `new_project`'s `media_paths`, another window, a hand-edited
        // manifest — is simply absent from `items` until something refreshes.
        // That divergence IS B-073/B-082's mechanism, and a list tool whose
        // whole job is "tell me what is really in the pool" must not inherit
        // it.
        const res = await useMediaPoolStore.getState().refresh();
        if (!res.ok) return { error: res.error ?? 'could not read the media pool' };
        const s = useMediaPoolStore.getState();
        return {
          ok: true,
          projectOpen: s.openProjectKey !== null,
          openProject: s.openProjectKey,
          count: s.items.length,
          folders: s.folders,
          items: s.items.map(mediaItemDto),
          // B-073's own question, answered in the list rather than left for the
          // caller to derive: WHICH item is the broken one. `editor_add_clip`
          // refuses any item with no probed frame count, and that refusal is
          // the symptom a session actually hits — so the list names the
          // unusable items up front instead of handing back an opaque array.
          unusable: s.items.filter((m) => !isPlaceable(m)).map((m) => m.id),
        };
      },

      // B-073 — the action `editor_list_media`'s own `usable: false` / `problem`
      // report has always pointed at and never had. Same store action, same
      // `chroma_media_reprobe` command, as the Sources panel's own "Re-probe"
      // row action — one op under both interfaces.
      //
      // Reports every requested item's usability AFTER the re-probe, and
      // `stillUnusable` up front, because "I re-probed it" is not the answer a
      // caller needs; "can I place a clip from it now" is. A source that is
      // still unavailable comes back honestly unusable rather than as a
      // success that fails at the next `editor_add_clip`.
      editor_reprobe_media: async (a) => {
        const ids: unknown = a?.ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || ids.length === 0) {
          return { error: 'ids must be a non-empty array of media-pool item ids (editor_list_media reports them, and names the unusable ones in `unusable`)' };
        }
        const res = await useMediaPoolStore.getState().reprobeMedia(ids as string[]);
        if (!res.ok) return { error: res.error ?? 'could not re-probe the media' };
        const items = res.items ?? [];
        const unknownIds = (ids as string[]).filter((id) => !items.some((m) => m.id === id));
        return {
          ok: true,
          items: items.map(mediaItemDto),
          stillUnusable: items.filter((m) => !isPlaceable(m)).map((m) => m.id),
          // An id that is not in the pool at all is skipped by the backend
          // rather than failing the batch — say so instead of letting it look
          // like a silent success.
          unknownIds,
        };
      },

      editor_list_media_folders: async () => {
        const res = await useMediaPoolStore.getState().refresh();
        if (!res.ok) return { error: res.error ?? 'could not read the media pool' };
        const s = useMediaPoolStore.getState();
        // Item counts alongside the bare paths: a folder list whose rows can't
        // be told apart by how full they are answers half the question an
        // agent asks it ("where did my imports go").
        const counts = new Map<string, number>();
        for (const m of s.items) {
          const key = m.folder && m.folder.trim() ? m.folder : '';
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return {
          ok: true,
          // The pool ROOT is not a folder and never appears in `folders` — it
          // is what `folder: null` means — but it does hold items, so it is
          // reported separately rather than silently dropped.
          root: { items: counts.get('') ?? 0 },
          folders: s.folders.map((path) => ({ path, items: counts.get(path) ?? 0 })),
        };
      },

      editor_create_media_folder: async (a) => {
        const path = typeof a?.path === 'string' ? a.path.trim() : '';
        if (!path) return { error: 'path must be a non-empty bin path, e.g. "b-roll" or "b-roll/day1"' };
        const res = await useMediaPoolStore.getState().createFolder(path);
        if (!res.ok) return { error: res.error ?? 'could not create the folder' };
        // Idempotent on the Rust side (D-059) — creating an existing bin is a
        // no-op that still returns the full list, so report whether this call
        // actually added anything rather than implying it always does.
        const folders = useMediaPoolStore.getState().folders;
        return { ok: true, path, created: folders.includes(path), folders };
      },

      editor_move_media: async (a) => {
        const id = typeof a?.id === 'string' ? a.id : '';
        if (!id) return { error: 'id must be a media-pool item id (editor_list_media reports them)' };
        // `folder: null` is a real, meaningful value here (move back to the
        // pool root), so it cannot double as "unspecified" — an omitted
        // `folder` is rejected rather than silently rooting the item.
        if (a?.folder === undefined) {
          return { error: 'pass folder: "<bin path>" to file the item, or folder: null to move it to the pool root' };
        }
        const folder =
          a.folder === null || (typeof a.folder === 'string' && !a.folder.trim())
            ? null
            : String(a.folder);
        const res = await useMediaPoolStore.getState().moveToFolder(id, folder);
        if (!res.ok) return { error: res.error ?? 'could not move the item' };
        const moved = useMediaPoolStore.getState().items.find((m) => m.id === id);
        return {
          ok: true,
          item: moved ? mediaItemDto(moved) : null,
          folders: useMediaPoolStore.getState().folders,
        };
      },

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

      // D-400 — Openverse audio: search, import (with its credit) and read the
      // credits back. MCP-first by the owner's call (no GUI panel), and the
      // only network calls in the Edit path: each is one explicit tool call,
      // made by Rust (`chroma/audio_library.rs`), never by the webview.
      editor_search_audio: async (a) => {
        const query = typeof a?.query === 'string' ? a.query.trim() : '';
        if (!query) return { error: 'query is required (what to search for, e.g. "rain on a window")' };
        // Built before the `try`: the React Compiler (D-201) bails out on
        // conditional values inside one.
        const searchArgs = {
          query,
          kind: a?.kind ?? null,
          minSecs: a?.minSecs ?? null,
          maxSecs: a?.maxSecs ?? null,
          licenses: Array.isArray(a?.licenses) ? a.licenses : null,
          page: a?.page ?? null,
          pageSize: a?.pageSize ?? null,
        };
        try {
          return await invoke('chroma_audio_search', searchArgs);
        } catch (e) {
          return { error: thrownMessage(e) };
        }
      },

      editor_import_audio: async (a) => {
        const openverseId = typeof a?.openverseId === 'string' ? a.openverseId.trim() : '';
        if (!openverseId) return { error: 'openverse_id is required (an `id` from editor_search_audio)' };
        const place = a?.track !== undefined && a?.track !== null;
        let saved: { path: string; projectFile: string; credit: string; downloaded: boolean };
        try {
          saved = await invoke('chroma_audio_download', { openverseId });
        } catch (e) {
          return { error: thrownMessage(e) };
        }
        const imported = await OPS.editor_import_media({ paths: [saved.path] });
        if (imported?.error) return { error: `downloaded ${saved.projectFile} but the import failed: ${imported.error}`, saved };
        const media = imported.added?.[0];
        if (!media) return { error: `downloaded ${saved.projectFile} but the media pool did not accept it`, saved };
        if (!place) return { ok: true, saved, media };
        const placed = await OPS.editor_add_clip({
          mediaId: media.id,
          track: a.track,
          startFrame: a?.startFrame ?? undefined,
        });
        if (placed?.error) {
          return { error: `imported ${saved.projectFile} but placing it failed: ${placed.error}`, saved, media };
        }
        return { ok: true, saved, media, placed };
      },

      editor_get_credits: async () => {
        try {
          return await invoke('chroma_audio_credits');
        } catch (e) {
          return { error: thrownMessage(e) };
        }
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
        // D-292 — the source's extent, for a still image as well as for
        // footage. A still has no `video` at all, so the old
        // `media.video?.frameCount` reach rejected every one of them here.
        const facts = placementFacts(media, timelineFps(useEditorTimelineStore.getState().timeline));
        if ('error' in facts) return facts;
        const frames = facts.sourceLen;

        const track = Math.round(Number(a?.track));
        const sourceStart = a?.sourceStart !== undefined ? Math.round(Number(a.sourceStart)) : 0;
        // D-292 — a still's default is its SYNTHESIZED span
        // (`DEFAULT_TITLE_SECONDS`), not "all of it": `sourceLen` for a still is
        // a one-hour trim ceiling, and placing an hour-long clip because the
        // caller omitted `duration` would be absurd. Footage keeps its
        // pre-D-292 "the rest of the file" default exactly. An explicit
        // `duration` always wins, for both.
        const duration =
          a?.duration !== undefined
            ? Math.round(Number(a.duration))
            : facts.still
              ? facts.defaultDuration
              : frames - sourceStart;
        if (!Number.isFinite(sourceStart) || sourceStart < 0 || sourceStart >= frames) {
          return { error: `sourceStart must be within [0, ${frames}) frames of the source` };
        }
        if (!Number.isFinite(duration) || duration <= 0 || sourceStart + duration > frames) {
          return { error: `duration must be > 0 and sourceStart+duration must be <= ${frames} (the source's own length)` };
        }

        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        // D-129 parity fix (previously MCP-only asymmetry) — a dropped clip
        // gets a linked audio half exactly like a Sources-panel drag does
        // (`linkedClipsFromDraggedMedia`'s own gate, mirrored here): only when
        // the source is known to have audio and isn't a still. `hasAudio` is
        // `null`/absent for an unprobed source, which this treats as "no,"
        // same as the drag path — an agent that needs the link retroactively
        // can `editor_reprobe_media` then re-add.
        const linkGroup = media.video?.hasAudio && !facts.still ? `lg-${media.id}-${stamp}` : null;

        const clip: NewClipFields = {
          id: `${media.id}-${stamp}`,
          shot_id: null,
          media_id: media.id,
          link_group: linkGroup,
          name: a?.name || media.name,
          source_path: media.sourcePath,
          source_start: sourceStart,
          duration,
          source_len: frames,
          source_fps: facts.sourceFps,
        };
        // Same source window as the video half — it only diverges later if
        // the user deliberately unlinks and slips it (an L-cut), same as a
        // dragged clip's linked audio starts life.
        const linkedAudio: NewClipFields | undefined = linkGroup
          ? { ...clip, id: `${media.id}-${stamp}-a`, link_group: linkGroup }
          : undefined;

        const startFrame = a?.startFrame !== undefined ? Math.round(Number(a.startFrame)) : undefined;
        const ripple = !!a?.ripple;
        // B-131 — an explicit `track`+`startFrame` used to splice straight
        // into a span another clip already covered, with no refusal at all;
        // `checkAddClip` now answers that occupancy question (the same one
        // `move`'s own `overlaps` check answers for a repositioned clip), so
        // this call gets a real, actionable reason instead of a silent
        // overlap or an opaque "check track index / project state".
        const tlBefore = useEditorTimelineStore.getState().timeline;
        if (tlBefore) {
          const check = checkAddClip(tlBefore, track, clip, timelineFps(tlBefore), startFrame, ripple);
          if (!check.ok) return { error: check.reason ?? 'that track cannot hold this clip' };
        }

        // B-259 — a source with no picture at all (an audio file: probed as
        // 0x0) on an empty timeline gets an AUDIO track, not a video one.
        const audioOnly = !facts.still && media.video?.width === 0 && media.video?.height === 0;

        useEditorTimelineStore.getState().applyOp({
          kind: 'add_clip',
          track,
          clip,
          linkedAudio,
          atIndex: a?.atIndex !== undefined ? Math.round(Number(a.atIndex)) : undefined,
          startFrame,
          ripple,
          newTrackKind: audioOnly ? 'audio' : 'video',
        });

        const tl = useEditorTimelineStore.getState().timeline;
        const placed = tl?.tracks[track]?.clips.find((c) => c.id === clip.id);
        if (!placed) return { error: 'add_clip did not place the clip — check track index / project state' };
        // D-129 parity — report the linked audio half's own location too, so
        // an agent doesn't have to call get_timeline just to discover
        // `ensureAudioTrackWithRoom` picked (or created) an audio track for it.
        let linkedAudioResult: { track: number; clipId: string } | undefined;
        if (linkedAudio && tl) {
          for (let t = 0; t < tl.tracks.length; t++) {
            const found = tl.tracks[t].clips.find((c) => c.id === linkedAudio.id);
            if (found) {
              linkedAudioResult = { track: t, clipId: found.id };
              break;
            }
          }
        }
        return {
          ok: true,
          track,
          clipId: placed.id,
          startFrame: placed.start_frame,
          duration: placed.duration,
          linkedAudio: linkedAudioResult ?? null,
        };
      },

      // D-239 (roadmap item 27) — the AI half of the seven edit types, running
      // the SAME `edit_in` `EditOp` the preview's edit overlay applies (see
      // `EditOverlay.tsx`), so the human's drop and the agent's call cannot
      // diverge in semantics. Deliberately NOT seven tools: they are one edit
      // with a `editType` discriminator in the reference itself ("the edit
      // overlay … letting you quickly choose between …"), and seven near-
      // identical tools would be seven docstrings to keep in sync.
      //
      // The media lookup is `editor_add_clip`'s, verbatim in shape — an agent
      // identifies a source the one way it always has, by `mediaId` or
      // `sourcePath` against the pool. B-163 — it now also gets the same
      // D-129 linked-audio half `editor_add_clip` does (mirrors
      // `linkedClipsFromDraggedMedia`'s own gate), rather than the GUI drag's
      // linking being a property of the drag alone.
      editor_edit_in: (a) => {
        if (!isDropEditType(a?.editType)) {
          return { error: `editType must be one of: ${DROP_EDIT_TYPES.map((t) => t.type).join(', ')}` };
        }
        const items = useMediaPoolStore.getState().items;
        const media = items.find((m) => m.id === a?.mediaId || m.sourcePath === a?.sourcePath);
        if (!media) return { error: `no pool item matching mediaId/sourcePath — call editor_import_media first` };

        const store = useEditorTimelineStore.getState();
        const timeline = store.timeline;
        if (!timeline) return { error: 'no timeline is open' };

        // D-292 — `editor_add_clip`'s own source-extent resolution, verbatim in
        // shape (see there for the still-vs-footage default-duration rule).
        const facts = placementFacts(media, timelineFps(timeline));
        if ('error' in facts) return facts;
        const frames = facts.sourceLen;

        const sourceStart = a?.sourceStart !== undefined ? Math.round(Number(a.sourceStart)) : 0;
        const duration =
          a?.duration !== undefined
            ? Math.round(Number(a.duration))
            : facts.still
              ? facts.defaultDuration
              : frames - sourceStart;
        if (!Number.isFinite(sourceStart) || sourceStart < 0 || sourceStart >= frames) {
          return { error: `sourceStart must be within [0, ${frames}) frames of the source` };
        }
        if (!Number.isFinite(duration) || duration <= 0 || sourceStart + duration > frames) {
          return { error: `duration must be > 0 and sourceStart+duration must be <= ${frames} (the source's own length)` };
        }

        const track = a?.track !== undefined ? Math.round(Number(a.track)) : videoTrackIndex(timeline);
        // The playhead is the default on purpose: every one of the seven is
        // defined against it in the reference, and an agent that has just
        // called `editor_set_playhead` should not have to restate the number.
        const atFrame = a?.atFrame !== undefined ? Math.round(Number(a.atFrame)) : store.playhead;

        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        // B-163 — same gate as `editor_add_clip`/`linkedClipsFromDraggedMedia`.
        const linkGroup = media.video?.hasAudio && !facts.still ? `lg-${media.id}-${stamp}` : null;
        const clipId = `${media.id}-${stamp}`;
        const clip: NewClipFields = {
          id: clipId,
          shot_id: null,
          media_id: media.id,
          link_group: linkGroup,
          name: a?.name || media.name,
          source_path: media.sourcePath,
          source_start: sourceStart,
          duration,
          source_len: frames,
          source_fps: facts.sourceFps,
        };
        const linkedAudio: NewClipFields | undefined = linkGroup
          ? { ...clip, id: `${media.id}-${stamp}-a`, link_group: linkGroup }
          : undefined;
        const op = { kind: 'edit_in' as const, editType: a.editType, track, clip, atFrame, linkedAudio };

        // The FULL check (the overlay can only run its `checkEditTarget` half
        // mid-drag — see that function's own doc), reported here as the real
        // error string rather than an opaque no-op, which is the whole reason
        // it is a separate function from the reducer.
        const check = checkEditIn(timeline, op);
        if (!check.ok) return { error: check.reason ?? 'that edit is not possible here' };

        store.applyOp(op);

        const after = useEditorTimelineStore.getState().timeline;
        let placedTrack = -1;
        let placed: Clip | undefined;
        after?.tracks.forEach((tr, i) => {
          const hit = tr.clips.find((c) => c.id === clipId);
          if (hit) {
            placedTrack = i;
            placed = hit;
          }
        });
        if (!placed) return { error: `${a.editType} did not place the clip — check the track index / project state` };
        const fps = timelineFps(after);
        // B-163 parity — same as `editor_add_clip`: report where the linked
        // audio half actually landed rather than leaving an agent to
        // `get_timeline` for it.
        let linkedAudioResult: { track: number; clipId: string } | undefined;
        if (linkedAudio && after) {
          for (let t = 0; t < after.tracks.length; t++) {
            const found = after.tracks[t].clips.find((c) => c.id === linkedAudio.id);
            if (found) {
              linkedAudioResult = { track: t, clipId: found.id };
              break;
            }
          }
        }
        return {
          ok: true,
          editType: a.editType,
          // The track it REALLY landed on, which `place_on_top` may have
          // created — an agent that assumes its own `track` came back would be
          // addressing the wrong one on the very next call.
          track: placedTrack,
          clipId: placed.id,
          startFrame: placed.start_frame,
          endFrame: endFrame(placed, fps),
          duration: placed.duration,
          speedPoints: placed.speed_points ?? null,
          trackCount: after?.tracks.length ?? 0,
          linkedAudio: linkedAudioResult ?? null,
        };
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
          // D-240 — `group`/`bold`/`italic` let a caller see which keys are
          // siblings without guessing from the label string; most callers
          // won't need this and should just pass `bold`/`italic` on
          // `editor_add_text_clip`/`editor_set_text_clip` directly.
          fonts: fonts.map((f) => ({
            key: f.key,
            label: f.label,
            available: f.path !== null,
            group: f.group,
            bold: f.bold,
            italic: f.italic,
          })),
          defaultTitle: 'error' in defaults ? null : defaults,
        };
      },

      editor_add_text_clip: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();

        // D-240 — `bold`/`italic` compose into `font` HERE, before
        // `newTextLayer` ever sees it: neither survives as its own field on
        // `TextLayer` (D-212's `font` stays the one stored catalogue key).
        let font = a?.font !== undefined ? String(a.font) : undefined;
        if (a?.bold !== undefined || a?.italic !== undefined) {
          const fonts = textFontsSync();
          const baseFont = font ?? DEFAULT_TEXT_FONT;
          const cur = fontStyleOf(fonts, baseFont);
          const bold = a?.bold !== undefined ? !!a.bold : cur.bold;
          const italic = a?.italic !== undefined ? !!a.italic : cur.italic;
          font = composeFontStyleKey(fonts, baseFont, bold, italic);
        }
        const layer = newTextLayer({
          content: typeof a?.content === 'string' ? a.content : '',
          font,
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

        // B-129/D-262 — `track` is OPTIONAL now, and omitting it is the
        // recommended call: the title goes on a brand-new video track above
        // the picture, in one op, exactly as the GUI's own Titles button does
        // (CLAUDE.md's "the same op/store action underneath both"). It used to
        // be mandatory, and the tool's docstring had to teach a three-call
        // `editor_add_track` → `editor_move_track` → `editor_add_text_clip`
        // dance to get a title above existing footage; an agent that skipped
        // it dropped the title onto whatever track that index happened to be —
        // which in the owner's real project was an AUDIO track.
        const onNewVideoTrack = a?.track === undefined || a.track === null;
        const track = onNewVideoTrack ? 0 : Math.round(Number(a.track));
        if (!Number.isFinite(track) || track < 0) {
          return { error: 'track must be a track index (0 = topmost), or omitted for a new video track above the picture' };
        }
        const fps = timelineFps(tl);
        const duration =
          a?.duration !== undefined
            ? Math.round(Number(a.duration))
            : Math.round(DEFAULT_TITLE_SECONDS * fps);
        if (!Number.isFinite(duration) || duration <= 0) {
          return { error: 'duration must be a positive number of TIMELINE frames' };
        }

        const clip: NewClipFields = newTextClipFields(layer, duration, a?.name);
        const startFrame = a?.startFrame !== undefined ? Math.round(Number(a.startFrame)) : undefined;
        const ripple = !!a?.ripple;
        // The same `checkAddClip` the reducer refuses on, asked here so the
        // refusal is a real sentence rather than a silent no-op — the posture
        // `editor_add_transition`/`editor_edit_in` already take. B-131 —
        // `checkAddClip` now also answers the occupancy question, so this
        // catches a conflicting `startFrame` too, not just a bad track kind.
        if (!onNewVideoTrack) {
          const check = checkAddClip(tl, track, clip, fps, startFrame, ripple);
          if (!check.ok) return { error: check.reason ?? 'that track cannot hold a title' };
        }
        useEditorTimelineStore.getState().applyOp({
          kind: 'add_clip',
          track,
          clip,
          startFrame,
          ripple,
          onNewVideoTrack,
        });

        const after = useEditorTimelineStore.getState().timeline;
        const placed = after?.tracks[track]?.clips.find((c) => c.id === clip.id);
        if (!placed) {
          return { error: 'add_clip did not place the title — the space at that startFrame on that track is occupied (pass ripple=true, or a different startFrame)' };
        }
        return {
          ok: true,
          // The track it REALLY landed on, and whether this call created it —
          // an agent that assumed its own index came back would address the
          // wrong track on the very next call, since a new track at 0
          // renumbers every existing one. Same disclosure `editor_edit_in`
          // makes for `place_on_top`.
          track,
          createdTrack: onNewVideoTrack,
          trackCount: after?.tracks.length ?? 0,
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
        // D-240 — `bold`/`italic` compose against whatever `font` this patch
        // is about to set, or the clip's CURRENT font if this patch does not
        // touch `font` at all — never against nothing, since a
        // bold-only patch on an existing title must not reset its family.
        if (a?.bold !== undefined || a?.italic !== undefined) {
          const fonts = textFontsSync();
          const baseFont = patch.font ?? found.c.text?.font ?? DEFAULT_TEXT_FONT;
          const cur = fontStyleOf(fonts, baseFont);
          const bold = a?.bold !== undefined ? !!a.bold : cur.bold;
          const italic = a?.italic !== undefined ? !!a.italic : cur.italic;
          patch.font = composeFontStyleKey(fonts, baseFont, bold, italic);
        }
        if (Object.keys(patch).length === 0) {
          return { error: 'nothing to change — pass at least one of content / font / size / color / bold / italic' };
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

        // A brand-new track has no "current" style yet — bold/italic with no
        // font compose against the family the caller's own `font` names, or
        // the catalogue default.
        const style = captionStylePatch(a, a?.font !== undefined ? String(a.font) : DEFAULT_CAPTION_FONT);
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

      // D-238 — generate captions straight from the D-189 transcript instead
      // of requiring a hand-authored `.srt`. Reuses `import_subtitles`
      // (D-229) verbatim for the actual timeline mutation — the only new work
      // is turning transcript words into cues, which
      // `groupTranscriptIntoCues`/`generatedCuesToCaptions` do (shared with
      // the GUI's own "Captions from Transcript" button, see
      // `CaptionsFromTranscriptButton.tsx`).
      //
      // **Auto-starts the transcript job** rather than requiring
      // `editor_get_transcript` be called first: the same start-then-poll
      // shape those D-189 ops use (`chroma::control`'s 20 s bridge ceiling —
      // see this file's own "media understanding" section above), reported
      // through the identical `state` vocabulary, so a caller that has
      // already fetched the transcript (or gets a `state: "done"` on this
      // very first call, since results are cached by path) pays no extra
      // round trip.
      editor_generate_captions_from_transcript: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const path = resolveMediaPath(a);
        if ('error' in path) return path;

        const store = useMediaUnderstandingStore.getState();
        store.startTranscript(path.path, {
          wordTimestamps: true,
          force: !!a?.force,
        });
        const status = store.transcriptStatus(path.path);
        if (status.phase === 'error') return { error: status.error ?? 'transcription failed' };
        if (status.phase !== 'done') {
          return {
            ok: true,
            path: path.path,
            state: status.phase,
            note: 'transcribing — call editor_generate_captions_from_transcript again once state is "done" (or poll editor_get_transcript_status)',
          };
        }

        const transcript = status.result;
        const num = (v: unknown): number | undefined => {
          if (v === undefined || v === null) return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const cues = groupTranscriptIntoCues(transcript?.segments ?? [], {
          maxWords: num(a?.maxWords),
          maxDurationS: num(a?.maxDurationS),
          maxPauseGapS: num(a?.maxPauseGapS),
        });
        if (cues.length === 0) {
          return {
            error:
              'the transcript has no word-level timestamps to group into cues — re-run with word_timestamps (the default) enabled, or the file may be silent',
          };
        }

        const fps = timelineFps(tl);
        const offsetFrames = a?.offsetFrames !== undefined ? Math.round(Number(a.offsetFrames)) : 0;
        const stem = path.path.split(/[/\\]/).pop()?.replace(/\.[^./\\]+$/, '') ?? 'transcript';
        const idPrefix = `cap-${sanitiseIdStem(stem)}-`;
        const captions = generatedCuesToCaptions(cues, fps, offsetFrames, idPrefix);

        // A brand-new track has no "current" style yet — bold/italic with no
        // font compose against the family the caller's own `font` names, or
        // the catalogue default (same rule as the .srt import path above).
        const style = captionStylePatch(a, a?.font !== undefined ? String(a.font) : DEFAULT_CAPTION_FONT);
        useEditorTimelineStore.getState().applyOp({
          kind: 'import_subtitles',
          cues: captions,
          ...(Object.keys(style).length > 0 ? { style } : {}),
        });
        const after = useEditorTimelineStore.getState().timeline;
        return {
          ok: true,
          track: (after?.tracks.length ?? 1) - 1,
          cues: captions.length,
          sourceName: stem,
          language: transcript?.language,
        };
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

      // D-243 — the preset library, as the agent sees it. The GUI half is
      // `CaptionLibrary.tsx`'s Styles tab; both read the SAME `captionPresets.ts`
      // and both place through the SAME `applyCaptionPreset`, so an agent can
      // reach every look a human can (CLAUDE.md).
      editor_list_caption_presets: () => ({
        ok: true,
        presets: CAPTION_PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          group: p.group,
          description: p.description,
          note: p.note,
          animation: captionAnimationOf(p.style).kind,
          style: p.style,
        })),
      }),

      editor_add_caption_preset: (a) =>
        applyCaptionPreset({
          presetId: String(a?.preset ?? ''),
          track: a?.track !== undefined && a.track !== null ? Math.round(Number(a.track)) : undefined,
          text: typeof a?.text === 'string' ? a.text : undefined,
          startFrame:
            a?.startFrame !== undefined && a.startFrame !== null
              ? Math.round(Number(a.startFrame))
              : undefined,
          durationFrames:
            a?.duration !== undefined && a.duration !== null
              ? Math.round(Number(a.duration))
              : undefined,
          // An agent asking for a preset almost always wants to SEE it, the
          // same as a click in the library does. `placeCaption: false` is the
          // explicit way to restyle a track that already has cues on it.
          placeCaption: a?.placeCaption !== undefined ? !!a.placeCaption : true,
        }),

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

        // The base this patch composes against: the cue's own resolved style
        // if `clip` names one (falling through to the track's, exactly as the
        // Inspector's `resolveCaptionStyle` does), else the track's. Both
        // `bold`/`italic` (D-240) and the animation fields (D-243) read from
        // the same resolved base, so a caller changing one knob keeps the
        // rest of the font composition and the rest of the animation intact.
        const baseStyle = resolveCaptionStyle(
          cueIndex !== null ? tr.clips[cueIndex]?.caption?.style : null,
          tr.caption_style,
        );
        const patch = captionStylePatch(a, baseStyle.font, baseStyle.animation);
        if (Object.keys(patch).length === 0) {
          return {
            error:
              'nothing to change — pass at least one of font / size / color / box_enabled / box_color / box_opacity / box_padding / line_spacing / align / position_x / position_y / animation / activeColor / spokenColor / upcomingColor / highlightColor / highlightOpacity / highlightPadX / highlightPadY / enterSecs / enterRise / wordGap (or useTrackStyle:true with a clip)',
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

        // B-129/D-262 — optional `track`, same contract and same underlying
        // op as `editor_add_text_clip` above: omitted means a brand-new video
        // track at the top of the stack, which for an adjustment clip is also
        // the position that grades the whole edit.
        const onNewVideoTrack = a?.track === undefined || a.track === null;
        const track = onNewVideoTrack ? 0 : Math.round(Number(a.track));
        if (!Number.isFinite(track) || track < 0) {
          return { error: 'track must be a track index (0 = topmost), or omitted for a new video track above the picture. An adjustment clip affects the tracks BELOW it, so the topmost track grades the whole edit' };
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
        const startFrame = a?.startFrame !== undefined ? Math.round(Number(a.startFrame)) : undefined;
        const ripple = !!a?.ripple;
        // B-131 — `checkAddClip` also answers the occupancy question now, so
        // a conflicting `startFrame` is refused with a real reason here too.
        if (!onNewVideoTrack) {
          const check = checkAddClip(tl, track, clip, fps, startFrame, ripple);
          if (!check.ok) return { error: check.reason ?? 'that track cannot hold an adjustment clip' };
        }
        useEditorTimelineStore.getState().applyOp({
          kind: 'add_clip',
          track,
          clip,
          startFrame,
          ripple,
          onNewVideoTrack,
        });

        const after = useEditorTimelineStore.getState().timeline;
        const placed = after?.tracks[track]?.clips.find((c) => c.id === clip.id);
        if (!placed) {
          return { error: 'add_clip did not place the adjustment clip — the space at that startFrame on that track is occupied (pass ripple=true, or a different startFrame)' };
        }
        return {
          ok: true,
          track,
          createdTrack: onNewVideoTrack,
          trackCount: after?.tracks.length ?? 0,
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
        // B-221 — removing one half of an A/V link group silently removes
        // the other half too (D-129, the reducer's own `remove` case
        // groups by `link_group` before splicing). Work out the intended
        // targets the same way the reducer does, then confirm post-op
        // which of those ids are actually gone — a locked-track refusal
        // removes nothing, so this never over-reports a no-op as a
        // deletion.
        const group = found.c.link_group;
        const targets: Array<[number, number]> = group ? linkGroupMembers(tl, group) : [[found.track, found.clip]];
        const before = targets.map(([ti, ci]) => ({ track: ti, clip: ci, id: tl.tracks[ti].clips[ci].id }));
        useEditorTimelineStore.getState().applyOp({ kind: 'remove', track: found.track, clip: found.clip });
        const after = useEditorTimelineStore.getState().timeline;
        const stillPresent = new Set<string>();
        after?.tracks.forEach((t) => t.clips.forEach((c) => stillPresent.add(c.id)));
        const removed = before.filter((b) => !stillPresent.has(b.id)).map(({ track, clip, id }) => ({ track, clip, id }));
        return { ok: true, track: found.track, removed };
      },

      editor_remove_gap: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const track = Math.round(Number(a?.track));
        const frame = Math.round(Number(a?.frame));
        if (!Number.isFinite(frame)) return { error: 'frame must be a finite number' };
        // B-227 — this used to call `applyOp` and report `{ok: true}`
        // regardless, even on one of `applyOp`'s own silent `return tl`
        // (unchanged) rejection paths — the same silent-no-op class as
        // B-215/B-197, one level up. `checkRemoveGap` runs the identical
        // precondition check the reducer itself uses BEFORE dispatching, so
        // a rejection comes back as a real, specific `error` instead of a
        // false success; the reference-equality check below is a backstop
        // for any rejection path this pre-check doesn't (yet) mirror.
        const check = checkRemoveGap(tl, track, frame, timelineFps(tl));
        if (!check.ok) return { error: check.reason };
        useEditorTimelineStore.getState().applyOp({ kind: 'remove_gap', track, frame });
        if (useEditorTimelineStore.getState().timeline === tl) {
          return { error: 'remove_gap made no change for an unrecognised reason — this is a bug, please file it' };
        }
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
        const ripple = a?.ripple === true;
        // B-215 — this used to call `applyOp` and report `{ok: true, track}`
        // regardless, including on every one of the reducer's silent
        // `return tl` rejection paths (the clamp made no difference, a link
        // member disagreed, a sync-locked track straddles the ripple point).
        // That is exactly the false success B-227 fixed for `editor_remove_gap`;
        // `checkTrim` is the same pattern — the identical precondition logic
        // the reducer itself now calls, run BEFORE dispatching so a refusal
        // comes back naming the real constraint. The reference-equality check
        // after dispatch is the same backstop B-227 left, for any future
        // rejection path this pre-check does not yet mirror.
        const checkEdge = a?.edge === 'start' ? 'start' : 'end';
        const check = checkTrim(tl, found.track, found.clip, checkEdge, delta, ripple, timelineFps(tl));
        if (!check.ok) return { error: check.reason };
        useEditorTimelineStore
          .getState()
          .applyOp({ kind: edge, track: found.track, clip: found.clip, delta, ripple });
        if (useEditorTimelineStore.getState().timeline === tl) {
          return { error: 'trim made no change for an unrecognised reason — this is a bug, please file it' };
        }
        // B-215/B-220 — report what actually landed, not just that something
        // did: the clamp routinely applies less than the delta asked for, and
        // the whole of B-215 was a caller unable to tell those apart.
        const after = useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          startFrame: after?.start_frame ?? check.newStartFrame,
          duration: after?.duration ?? check.newDuration,
        };
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
        // D-292 — relinking a clip to a STILL is as real as relinking it to
        // another clip; same shared extent resolution as `editor_add_clip`.
        // `swap_media`'s own re-clamp policy then holds the clip's existing
        // window inside the new source's extent, which for a still is the
        // one-hour ceiling — i.e. relinking footage to a still never shortens
        // the clip.
        const facts = placementFacts(media, timelineFps(tl));
        if ('error' in facts) return facts;
        const frames = facts.sourceLen;

        useEditorTimelineStore.getState().applyOp({
          kind: 'swap_media',
          track: found.track,
          clip: found.clip,
          media_id: media.id,
          source_path: media.sourcePath,
          source_len: frames,
          source_fps: facts.sourceFps,
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
        // B-115 — an optional insertion INDEX, so an agent can add a track
        // above existing footage in one call, exactly as the human's
        // drag-above-the-top-track gesture now does. It is not a new
        // primitive: it runs the same `add_track` + `move_track` pair
        // `TimelinePane`'s own boundary drop runs (`placeDroppedClip`), which
        // is also the recipe `editor_add_track`/`editor_move_track` already
        // documented as two calls. Omitted = append, unchanged.
        const before = useEditorTimelineStore.getState().timeline?.tracks.length ?? 0;
        const rawIndex = a?.index;
        const wantsIndex = rawIndex !== undefined && rawIndex !== null;
        const index = wantsIndex ? Math.round(Number(rawIndex)) : before;
        if (wantsIndex && (!Number.isFinite(index) || index < 0 || index > before)) {
          return {
            error: `index must be 0..${before} (0 = the top of the compositing stack, ${before} = append at the bottom); got ${String(rawIndex)}`,
          };
        }
        useEditorTimelineStore.getState().applyOp({ kind: 'add_track', trackKind });
        if (index !== before) {
          useEditorTimelineStore.getState().applyOp({ kind: 'move_track', from: before, to: index });
          // Same selection-follow `editor_move_track` and the GUI's own
          // boundary drop do — `move_track` keeps the list length, so the
          // store's generic remap never fires for it.
          useEditorTimelineStore
            .getState()
            .setSelection((prev) => prev.map((s) => ({ ...s, track: trackIndexAfterMove(s.track, before, index) })));
        }
        return { ok: true, track: index };
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
              ['corner_radius', a?.corner_radius, 0],
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
              ['corner_radius', a?.corner_radius, 0],
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
          corner_radius: num(a?.corner_radius, c.corner_radius ?? 0),
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
            // D-344 — restated, not reset: this op clears the box override
            // only, and every other field has to survive it unchanged.
            corner_radius: c.corner_radius ?? 0,
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

      // D-256 — which clips on this timeline carry a real Colorist grade, and
      // what baking it had to drop. The AI half of a feature whose human half
      // is simply "the preview and the export show the grade": there is no
      // toggle to mirror, so what an agent needs instead is the ability to SEE
      // the state a human can see by looking at the picture. Runs the same
      // bake the export path runs (memoised, so asking is cheap and asking
      // twice is free).
      editor_get_grade_status: async () => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        let baked: { luts: Record<string, string>; warnings: string[] };
        try {
          baked = await warmGradeLuts(tl);
        } catch (e) {
          return { error: `could not bake a clip's Colorist grade: ${String((e as Error)?.message ?? e)}` };
        }
        const clips: Array<{ clipId: string; name: string; graded: boolean }> = [];
        for (const track of tl.tracks) {
          for (const clip of track.clips) {
            if (clip.text || clip.adjustment || track.kind === 'audio') continue;
            clips.push({ clipId: clip.id, name: clip.name, graded: !!baked.luts[clip.id] });
          }
        }
        return {
          clips,
          gradedCount: clips.filter((c) => c.graded).length,
          // Each entry names a clip whose exported pixels will legitimately
          // differ from the Colorist tab (a mask, a Colorist crop — see
          // `editor_get_capabilities`' `colorist_grade.what_it_carries`).
          warnings: baked.warnings,
        };
      },

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

      // ---- speed ramp (D-236, reverse D-241) ----------------------------- //
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

      // ---- clip highlights: the highlighter-pen sweep (D-396) ------------- //
      //
      // REPLACES the clip's whole list, like `editor_set_clip_keyframes`: the
      // caller (an agent building a video, the Inspector's rows) already holds
      // the whole of it, and one op shape serves add, remove and retime. `[]`
      // clears. Validated up front and named, rather than silently dropping an
      // unrenderable entry the way the reducer's own sanitiser would.
      editor_set_clip_highlights: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        if (found.tr.locked) return { error: `track ${found.track} is locked — unlock it first` };
        if (found.tr.kind !== 'video') {
          return {
            error: `track ${found.track} is a ${found.tr.kind} track — a highlight is drawn on a video or still clip`,
          };
        }
        if (isGeneratedClip(found.c)) {
          return {
            error: `clip ${found.clip} is a title, caption or adjustment clip — it has no picture to highlight`,
          };
        }
        const checked = validateHighlights(a?.highlights);
        if ('error' in checked) return checked;
        useEditorTimelineStore.getState().applyOp({
          kind: 'set_clip_highlights',
          track: found.track,
          clip: found.clip,
          highlights: checked.highlights,
        });
        const stored =
          useEditorTimelineStore.getState().timeline?.tracks[found.track]?.clips[found.clip]?.highlights ?? [];
        return {
          ok: true,
          track: found.track,
          clip: found.clip,
          name: found.c.name,
          // What was actually STORED (frames rounded to whole numbers, boxes
          // ordered and clamped), so a caller reads this rather than assuming
          // its request landed verbatim.
          highlights: stored,
          note:
            stored.length === 0
              ? 'highlights cleared — this clip renders exactly as before'
              : 'drawn on the clip’s own picture before its crop, scale and keyframes, so each box follows every push-in; `at` is a clip SOURCE frame (the axis editor_set_clip_keyframes uses), and a swept highlight stays for the rest of the clip',
        };
      },

      // Read-only: returns a suggestion and writes nothing. The same function
      // the Inspector's "Suggest from transcript" button calls (D-396/D-397).
      editor_suggest_clip_highlights: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const found = resolveClip(tl, a?.track, a?.clip);
        if ('error' in found) return found;
        const outcome = await suggestClipHighlights(liveSuggestDeps(), found.track, found.clip);
        if ('error' in outcome) return outcome;
        const common = { ok: true, track: found.track, clip: found.clip, name: found.c.name };
        if (outcome.status === 'transcribing') {
          return {
            ...common,
            ...outcome,
            note: 'a source that plays over this clip is still being transcribed — call again in a moment',
          };
        }
        if (outcome.status === 'needs_transcript') {
          return {
            ...common,
            ...outcome,
            note: 'nothing playing over this clip has a transcript yet — run editor_get_transcript on the narration source (or editor_get_timeline_transcript) and call again',
          };
        }
        return {
          ...common,
          ...outcome,
          applied: false,
          note: 'a suggestion only — nothing was written. Review it, then apply with editor_set_clip_highlights (pass `highlights` back as-is).',
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
        // D-328 — `durationFrames` is optional and defaults to a POINT marker,
        // so every pre-D-328 caller keeps working unchanged.
        const marker = newMarker(frame, a?.color, a?.name, a?.note, a?.durationFrames);
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

        const patch: {
          frame?: number;
          color?: string;
          duration_frames?: number | null;
          name?: string | null;
          note?: string | null;
        } = {};
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
        // D-328 — same three-way convention: absent leaves the span alone,
        // `null` (or 0, or a negative) clears it back to a point marker. A
        // non-numeric value is rejected here rather than silently normalised to
        // "point", for the reason the colour check above spells out: an agent
        // that mistyped needs telling, not `ok: true` and a marker it did not
        // mean. `null` is the one non-number that is a real instruction.
        if (a?.durationFrames !== undefined) {
          if (a.durationFrames === null) patch.duration_frames = null;
          else {
            const d = Number(a.durationFrames);
            if (!Number.isFinite(d)) {
              return { error: 'durationFrames must be a finite number of frames, or null to clear it' };
            }
            patch.duration_frames = d;
          }
        }
        if (Object.keys(patch).length === 0) {
          return { error: 'nothing to set — pass at least one of frame, color, durationFrames, name, note' };
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

      // D-329 — the whole timeline's speech, in TIMELINE frames.
      //
      // This exists because `editor_get_transcript` above answers per FILE in
      // source seconds, and a timeline is a reordered set of trimmed windows
      // onto those files. Without this an agent asking "what does this
      // sequence say?" would have to fetch each file, filter each clip's
      // window and convert source seconds to timeline frames itself — which is
      // precisely the arithmetic B-077 shipped wrong (a clip's `duration`/
      // `source_start` are its OWN native frames, so the conversion needs
      // `source_fps`). The Index panel gets this from
      // `stitchTimelineTranscript`; so does this op, deliberately the same
      // function, so the human and the agent can never be told different
      // things about the same timeline.
      editor_get_timeline_transcript: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return { error: 'no timeline is open' };

        const store = useMediaUnderstandingStore.getState();
        const sources = transcriptSources(tl);
        if (sources.length === 0) {
          return {
            ok: true,
            fps: timelineFps(tl),
            sources: [],
            rows: [],
            pending: 0,
            note: 'no dialogue-bearing video clips on this timeline',
          };
        }

        // `start: true` kicks a job for every file that has none — one per
        // FILE, never one per clip. Cached files short-circuit inside the
        // store, so this is free for anything already done, and a previous
        // failure is not sticky, so it doubles as the retry.
        if (a?.start) {
          for (const s of sources) {
            if (store.transcriptStatus(s.path).phase === 'done') continue;
            store.startTranscript(s.path, { wordTimestamps: true });
          }
        }

        const fresh = useMediaUnderstandingStore.getState();
        const reported = sources.map((s) => {
          const status = fresh.transcriptStatus(s.path);
          return {
            path: s.path,
            clipCount: s.clipCount,
            state: status.phase,
            ...(status.phase === 'error' ? { error: status.error } : {}),
          };
        });

        // D-349 — whatever the recut pass has already recovered is spliced in,
        // so the transcript a reader gets here and the one the retake grouper
        // reads are the same transcript. This tool never STARTS a scan or a
        // recovery: it reports the timeline's speech, and kicking off a transcription
        // passes from a read would be a surprise. `editor_detect_dark_regions`
        // and `editor_detect_retakes` are the tools that do that.
        const recoveries = Object.fromEntries(
          sources.map((s) => [s.path, fresh.recoveriesFor(s.path)]),
        );
        const rows = stitchTimelineTranscript(tl, fresh.transcripts, recoveries);
        const recovered = rows.filter((r) => r.recovered).length;
        const pending = reported.filter((s) => s.state !== 'done').length;
        return {
          ok: true,
          fps: timelineFps(tl),
          sources: reported,
          rows,
          recovered,
          pending,
          ...(pending > 0
            ? {
                note: `${pending} of ${reported.length} source files have no transcript yet — rows cover only the ones that do. Call again with start=true to transcribe them, then poll this tool until pending is 0`,
              }
            : {}),
        };
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

      // ---- recut: find the dead air and the retakes (D-318) ---------------
      // Both detectors are READ-ONLY — they propose spans and never cut. The
      // cutting is `editor_ripple_delete_ranges` below, which the human's
      // Recut panel drives through the same store op, so neither interface has
      // a capability the other lacks (CLAUDE.md).
      //
      // **Both are START-then-POLL (B-188/D-321), with a fast path.** They run
      // the detection through the `mediaUnderstanding` store — the same place
      // transcripts live — and wait up to `DETECT_GRACE_MS` for it. A normal
      // recut finishes inside that window and comes back `state: "done"` in
      // one call; one that does not comes back `state: "running"` with its
      // answer still being computed INTO THE STORE, where the matching
      // `_status` op will find it. Before D-321 the op simply `await`ed the
      // detection inside the bridge round trip, so a detection that outran the
      // caller's timeout had its result thrown away with nowhere to land —
      // which is exactly what B-188 hit on a real 16-minute 4K file.
      //
      // **`clip` is OPTIONAL on all four** (D-342, fixes B-216). Omit it and
      // the op sweeps every analysable clip on `track` — inside THIS ONE
      // dispatch, not as N calls. That is not a convenience: `control.rs`'s
      // `serve()` is a single-threaded, one-request-at-a-time HTTP loop, so a
      // client-side loop over 75 clips queues 75 round trips no matter how
      // concurrently the caller issues them, while the per-clip analysis
      // itself is cheap. Naming a `clip` keeps the exact single-clip
      // behaviour, byte for byte.
      editor_detect_silences: async (a) => {
        if (isSweep(a)) return await silenceSweep(a, true);
        const resolved = resolveSilenceArgs(a);
        if ('error' in resolved) return resolved;
        const { found, c, fps, args, key, minSilenceMs } = resolved;

        useMediaUnderstandingStore.getState().startSilenceDetection(args, !!a?.force);
        const status = await settleWithin(
          () => useMediaUnderstandingStore.getState().silenceDetectionStatus(key),
          DETECT_GRACE_MS,
        );
        return silenceEnvelope(status, found, c, fps, minSilenceMs);
      },

      editor_detect_silences_status: async (a) => {
        if (isSweep(a)) return await silenceSweep(a, false);
        const resolved = resolveSilenceArgs(a);
        if ('error' in resolved) return resolved;
        const { found, c, fps, key, minSilenceMs } = resolved;
        const status = useMediaUnderstandingStore.getState().silenceDetectionStatus(key);
        return silenceEnvelope(status, found, c, fps, minSilenceMs);
      },

      editor_detect_retakes: async (a) => {
        if (isSweep(a)) return await retakeSweep(a, true);
        const resolved = resolveRetakeArgs(a, true);
        if ('error' in resolved) return resolved;
        if ('pending' in resolved) return resolved.pending;
        const { found, c, fps, args, key, rv, request } = resolved;

        useMediaUnderstandingStore.getState().startRetakeDetection(args, !!a?.force);
        const status = await settleWithin(
          () => useMediaUnderstandingStore.getState().retakeDetectionStatus(key),
          DETECT_GRACE_MS,
        );
        settleIfAnswered(request, status.phase);
        return await retakeEnvelope(status, found, c, fps, args.utterances.length, rv);
      },

      // B-249 — a pure read, EXCEPT for a job a start call asked for: that one
      // it carries on, all the way to the grouping. The grouping is started
      // only from `idle`, never re-run from `error`, so a poll retries nothing.
      editor_detect_retakes_status: async (a) => {
        if (isSweep(a)) return await retakeSweep(a, false);
        const resolved = resolveRetakeArgs(a, false);
        if ('error' in resolved) return resolved;
        if ('pending' in resolved) return resolved.pending;
        const { found, c, fps, args, key, rv, request, drive } = resolved;
        const read = () => useMediaUnderstandingStore.getState().retakeDetectionStatus(key);
        let status = read();
        if (drive && status.phase === 'idle') {
          useMediaUnderstandingStore.getState().startRetakeDetection(args, false);
          status = await settleWithin(read, DETECT_GRACE_MS);
        }
        settleIfAnswered(request, status.phase);
        return await retakeEnvelope(status, found, c, fps, args.utterances.length, rv);
      },

      // **`editor_detect_dark_regions` (D-349, B-216)** — the third detector,
      // and the only one that reads BOTH signals: where the VAD hears a voice
      // and the transcript has no words, the ASR silently declined to transcribe
      // real speech. Measured at roughly one dropped multi-second region per
      // three minutes of raw footage across two independent camera originals,
      // and *biased towards retakes*, which is why `editor_detect_retakes` runs
      // this automatically and splices the result rather than leaving it as a
      // separate report nobody would think to run.
      //
      // This tool exists on its own anyway, for two real jobs the automatic
      // pass does not do: auditing a source BEFORE cutting it ("how much of
      // this file did the ASR not read?"), and answering "why did content
      // appear in my transcript that was not there before?" with the exact
      // ranges and the amplitude evidence behind each one.
      //
      // Synchronous-with-a-grace-window, like the other two: the scan is a VAD
      // pass over one clip's range and usually finishes inside it, and anything
      // slower comes back `running` with its answer still being computed into
      // the store (D-321).
      editor_detect_dark_regions: async (a) => {
        const resolved = resolveDarkArgs(a);
        if ('error' in resolved) return resolved;
        if ('pending' in resolved) return resolved.pending;
        const { found, c, fps, args, key } = resolved;

        useMediaUnderstandingStore.getState().startDarkDetection(args, !!a?.force);
        const status = await settleWithin(
          () => useMediaUnderstandingStore.getState().darkDetectionStatus(key),
          DETECT_GRACE_MS,
        );
        return darkEnvelope(status, found, c, fps);
      },

      editor_detect_dark_regions_status: async (a) => {
        const resolved = resolveDarkArgs(a);
        if ('error' in resolved) return resolved;
        if ('pending' in resolved) return resolved.pending;
        const { found, c, fps, key } = resolved;
        const status = useMediaUnderstandingStore.getState().darkDetectionStatus(key);
        return darkEnvelope(status, found, c, fps);
      },

      // **Retakes judged by the MCP client (D-380 step 2).** The client reads
      // the track's word-indexed view, proposes groups as word ranges, and
      // resolves refusals itself (narrow, re-transcribe, confirm with a reason,
      // or drop). The app renders, gates, re-runs its own ASR on request, and
      // stores the result for the Recut panel — no model, no judgement, and
      // nothing cut. `editor_detect_retakes` above stays the deterministic
      // fallback, behind the same gate (D-382).
      editor_get_word_transcript: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        return await getWordTranscript(tl, a);
      },

      editor_propose_retakes: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        return await proposeRetakes(tl, a);
      },

      editor_retranscribe_words: async (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        return await retranscribeWords(tl, a);
      },

      editor_ripple_delete_ranges: (a) => {
        const tl = useEditorTimelineStore.getState().timeline;
        if (!tl) return noTimeline();
        const track = Math.round(Number(a?.track));
        if (!Number.isFinite(track) || !tl.tracks[track]) {
          return { error: `no track ${track} (0..${tl.tracks.length - 1})` };
        }
        if (!Array.isArray(a?.ranges)) {
          return { error: 'ranges must be an array of {startFrame, endFrame} in TIMELINE frames' };
        }
        const ranges = a.ranges.map((r: unknown) => {
          const row = r as { startFrame?: unknown; endFrame?: unknown };
          return { start: Math.round(Number(row?.startFrame)), end: Math.round(Number(row?.endFrame)) };
        });
        if (ranges.some((r: { start: number; end: number }) => !Number.isFinite(r.start) || !Number.isFinite(r.end))) {
          return { error: 'every range needs a finite startFrame and endFrame' };
        }

        // B-197 — a batch's honest answer is per-range, not a boolean. The
        // pure `applyRippleDeleteRanges` is run here first as a dry run purely
        // to learn WHICH ranges land and why the rest do not; the store then
        // applies the op for real, through the identical pure function, so the
        // two cannot disagree (`checkRemoveGap`/`checkTrim`'s pre-check
        // pattern, B-227/B-215, with a list instead of one verdict). The old
        // `after === before` reference check stayed true for a batch that
        // dropped 2 of 87 ranges — it can only see a TOTAL no-op — and that
        // false `{ok: true}` is the whole of B-197.
        const dry = applyRippleDeleteRanges(tl, track, ranges, timelineFps(tl));
        const skipped = dry.results.filter((r) => !r.applied);
        if (dry.results.length === 0) {
          return { error: 'no range describes real material — every one was empty, inverted, or before frame 0' };
        }
        if (dry.timeline === tl) {
          return {
            error: `nothing was cut — none of the ${dry.results.length} range(s) could be applied`,
            track,
            skipped: skipped.map((r) => ({ startFrame: r.start, endFrame: r.end, reason: r.reason })),
          };
        }

        useEditorTimelineStore.getState().applyOp({ kind: 'ripple_delete_ranges', track, ranges });

        const applied = dry.results.length - skipped.length;
        if (skipped.length > 0) {
          return {
            ok: false,
            error:
              `${skipped.length} of ${dry.results.length} ranges were NOT cut — see \`skipped\` for which and why. ` +
              `The other ${applied} WERE applied (as one undo entry): re-read the timeline before acting on any ` +
              `frame number you had, and undo if you would rather start over.`,
            track,
            requested: dry.results.length,
            applied,
            skipped: skipped.map((r) => ({ startFrame: r.start, endFrame: r.end, reason: r.reason })),
          };
        }
        return {
          ok: true,
          track,
          ranges: dry.results.length,
          applied,
          note: 'applied as ONE edit, so a single undo reverses all of it',
        };
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

    // B-272 — this subscription's identity. The control server addresses every
    // request to ONE announced instance, so a leaked older subscription (a
    // failed unlisten across HMR) hears the event and ignores it.
    const bridge = newBridgeClaim(EDITOR_OP_PREFIX);
    const unlistenP = listen('chroma://request', async (ev: any) => {
      const payload = ev?.payload || {};
      const { id, op, args } = payload;
      if (!bridge.isForMe(payload)) return;
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
        // B-217/D-358 — refuse to run while the app's stores disagree about
        // which project is open. This registry is where that mattered most: an
        // `editor_*` write against an Edit tab still holding the OUTGOING
        // project's timeline lands one project's document in another project's
        // file, with no error anywhere. Reads are guarded too — `editor_get_state`
        // reporting the wrong project confidently is how B-217 stayed invisible.
        await assertProjectIdentity(op);

        // D-298 — every `@apelles/history` push inside this window is stamped
        // `source: 'agent'`, which is the whole of this tab's agent-activity
        // instrumentation: one wrapper at the dispatcher, not a line in each
        // of the ~90 handlers. The shell-level feed reads those entries, so
        // work an agent does here is finally visible from any tab.
        const result = await runAsAgent(() => fn(opArgs(args)));
        const error = opError(result);
        respond({ ok: !error, error, result });
      } catch (e) {
        respond({ ok: false, error: thrownMessage(e), result: null });
      }
    });

    // B-071 — announce only once the subscription has genuinely landed (the
    // promise resolving is that fact), and only if this effect is still live.
    let subscribed = true;
    void unlistenP.then(() => {
      if (subscribed) void emit('chroma://bridge-ready', bridge.claim);
    });

    return () => {
      subscribed = false;
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
