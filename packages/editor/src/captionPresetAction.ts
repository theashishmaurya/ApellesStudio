// @apelles/editor — applying a caption preset (D-243).
//
// **What it is:** the ONE action that turns a preset id into timeline edits —
// find or create a subtitle track, write the preset's style onto it, and
// optionally drop a caption on it.
//
// **Why it is its own module rather than living in the panel.** CLAUDE.md's
// standing rule: every feature is built for a human AND an AI, through the
// same op underneath. `CaptionLibrary.tsx` calls this when a library tile is
// clicked; `editor_add_caption_preset` calls exactly the same function. There
// is no second code path that could drift, and no behaviour the GUI has that
// MCP does not.
//
// **What it does NOT do:** it does not own the preset data (`captionPresets.ts`
// does), it does not render, and it invents no new op — it composes the
// existing `add_track` / `set_caption_style` / `add_clip` ops, so undo,
// history labels and persistence all work on a preset exactly as they work on
// anything else.
//
// **B-361 — `captionWithPreset` is the click.** `applyCaptionPreset` (below)
// is the low-level "style a track, optionally drop ONE sample caption"
// primitive. A creator who clicks a look wants their VIDEO captioned in it, not
// a "Every great video starts..." placeholder, so the library tile and
// `editor_add_caption_preset` both call `captionWithPreset`: restyle the
// captions already there, else caption from the timeline's transcript (starting
// the transcription if there is none yet), and use the sample only when asked.

import { captionPresetById, captionPresetIds } from './captionPresets';
import { captionsForTimeline } from './captionsFromTranscript';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { transcriptSources } from './timelineTranscript';
import {
  newCaptionClipFields,
  timelineFps,
  type Timeline,
} from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** How long a caption dropped from the library runs, in seconds, when the
 *  caller names no duration.
 *
 *  Long enough that an ANIMATED preset actually reads as animated when it
 *  lands — a 1s cue of six words gives each word 160ms, which is under the
 *  default entrance and would look like a glitch rather than a build. */
export const DEFAULT_PRESET_CAPTION_SECONDS = 3;

/** The sample text a preset drops with when the caller names none.
 *
 *  Real words rather than "Lorem ipsum": the point of dropping a preset is to
 *  SEE the animation, and per-word timing is derived from word lengths, so
 *  placeholder text of the wrong shape would misrepresent the look. */
export const DEFAULT_PRESET_CAPTION_TEXT = 'Every great video starts with a single frame';

/** What `applyCaptionPreset` returns — the same `{ok}`/`{error}` shape every
 *  `editor_*` op uses, so the MCP tool can return it unchanged. */
export type ApplyPresetResult =
  | { ok: true; track: number; preset: string; clip?: number; id?: string }
  | { error: string };

/** The index of the first subtitle track, or `null` if the timeline has none. */
export function firstSubtitleTrack(tl: Timeline): number | null {
  const i = (tl.tracks ?? []).findIndex((t) => t.kind === 'subtitle');
  return i === -1 ? null : i;
}

/**
 * Apply a preset, creating what it needs.
 *
 * - `track` omitted → the first existing subtitle track is styled, or a new
 *   one is created if there is none. That is what makes a single click in the
 *   library "just work" on an empty timeline, which is the whole point of the
 *   panel.
 * - `text` given (or `placeCaption`) → a caption is also dropped at
 *   `startFrame` (default: the playhead), so the preset is immediately
 *   visible rather than being an invisible style change on an empty track.
 *
 * Every mutation goes through `applyOp`, so the whole thing is undoable.
 */
export function applyCaptionPreset(a: {
  presetId: string;
  track?: number;
  text?: string;
  startFrame?: number;
  durationFrames?: number;
  /** Drop a caption as well as styling the track. Defaults to true when
   *  `text` is given, false otherwise. */
  placeCaption?: boolean;
}): ApplyPresetResult {
  const store = useEditorTimelineStore.getState();
  const tl = store.timeline;
  if (!tl) return { error: 'no timeline — open a project first' };

  const preset = captionPresetById(a.presetId);
  if (!preset) {
    return {
      error: `unknown caption preset "${a.presetId}" — valid ids: ${captionPresetIds().join(', ')}`,
    };
  }

  // 1. Resolve the target track, creating one if needed.
  let track: number;
  if (a.track !== undefined) {
    const idx = Math.round(Number(a.track));
    const tr = tl.tracks?.[idx];
    if (!tr) return { error: `no track ${idx}` };
    if (tr.kind !== 'subtitle') {
      return {
        error: `track ${idx} is a ${tr.kind} track — a caption preset applies to a subtitle track`,
      };
    }
    if (tr.locked) return { error: `track ${idx} is locked — unlock it first` };
    track = idx;
  } else {
    const existing = firstSubtitleTrack(tl);
    if (existing !== null && !tl.tracks[existing].locked) {
      track = existing;
    } else {
      store.applyOp({ kind: 'add_track', trackKind: 'subtitle' });
      const after = useEditorTimelineStore.getState().timeline;
      const created = after ? firstSubtitleTrack(after) : null;
      if (created === null) return { error: 'could not create a subtitle track' };
      // `add_track` appends, so when several subtitle tracks exist the new one
      // is the LAST, not the first.
      const lastSubtitle = (after?.tracks ?? []).reduce(
        (best, t, i) => (t.kind === 'subtitle' ? i : best),
        created,
      );
      track = lastSubtitle;
    }
  }

  // 2. The style. A whole-style patch, not a merge of selected fields: a
  //    preset IS the look, and leaving a previous preset's accent colour
  //    behind would make the library's tiles lie about what they apply.
  store.applyOp({ kind: 'set_caption_style', track, patch: preset.style });

  // 3. Optionally drop a caption so the preset is visible immediately.
  const place = a.placeCaption ?? a.text !== undefined;
  if (!place) return { ok: true, track, preset: preset.id };

  const text = (a.text ?? DEFAULT_PRESET_CAPTION_TEXT).trim();
  if (!text) return { error: 'text must be a non-empty caption' };
  const fps = timelineFps(tl);
  const duration =
    a.durationFrames !== undefined
      ? Math.round(Number(a.durationFrames))
      : Math.round(DEFAULT_PRESET_CAPTION_SECONDS * fps);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { error: 'durationFrames must be a positive number of TIMELINE frames' };
  }
  // No explicit frame: the playhead, moved past any caption already covering it
  // so the sample lands instead of failing on an occupied frame (B-361).
  let startFrame =
    a.startFrame !== undefined
      ? Math.round(Number(a.startFrame))
      : useEditorTimelineStore.getState().playhead;
  if (a.startFrame === undefined) {
    const clips = tl.tracks[track]?.clips ?? [];
    for (let moved = true; moved; ) {
      const hit = clips.find(
        (c) => c.start_frame < startFrame + duration && c.start_frame + c.duration > startFrame,
      );
      moved = !!hit;
      if (hit) startFrame = hit.start_frame + hit.duration;
    }
  }

  const clip = newCaptionClipFields(text, duration);
  store.applyOp({ kind: 'add_clip', track, clip, startFrame });

  const after = useEditorTimelineStore.getState().timeline;
  const placed = after?.tracks[track]?.clips.find((c) => c.id === clip.id);
  if (!placed) {
    // The style still landed, so this is a partial success reported as a real
    // failure rather than a silent one — the caller can retry at a free frame.
    return { error: 'the preset was applied but the caption did not fit — is that frame occupied?' };
  }
  return {
    ok: true,
    track,
    preset: preset.id,
    clip: after?.tracks[track].clips.indexOf(placed),
    id: clip.id,
  };
}

// --------------------------------------------------------------------------- //
// B-361 - the preset click: caption the video, not a placeholder
// --------------------------------------------------------------------------- //

/** `auto` = caption the video (restyle, else from the transcript); `sample` =
 *  the explicit placeholder preview. */
export type CaptionPresetMode = 'auto' | 'sample';

/** What `captionWithPreset` reports. `transcribing` is not a failure: it means
 *  the transcription was started (or is still running) and the call must be
 *  repeated once it lands - the same start-then-poll contract every
 *  transcript-backed op has. */
export type CaptionWithPresetResult =
  | { ok: true; outcome: 'restyled' | 'generated'; track: number; preset: string; cues: number }
  | { ok: true; outcome: 'styled'; track: number; preset: string }
  | {
      ok: true;
      outcome: 'transcribing';
      preset: string;
      pending: number;
      total: number;
      note: string;
    }
  | ({ outcome: 'sample' } & Extract<ApplyPresetResult, { ok: true }>)
  | { error: string };

/** The track whose captions a preset click restyles: the one named, else the
 *  first unlocked subtitle track that has any captions on it. */
function trackWithCaptions(tl: Timeline, wanted: number | undefined): number | null {
  if (wanted !== undefined) {
    const t = tl.tracks?.[wanted];
    return t && t.kind === 'subtitle' && t.clips.length > 0 ? wanted : null;
  }
  const i = (tl.tracks ?? []).findIndex((t) => t.kind === 'subtitle' && !t.locked && t.clips.length > 0);
  return i === -1 ? null : i;
}

/**
 * Click a caption look. The ONE path behind the library tile and
 * `editor_add_caption_preset`.
 *
 * 1. The subtitle track already has captions: restyle them.
 * 2. None, and the timeline's speech has a transcript: generate captions from
 *    it (`captionsForTimeline`) onto a new subtitle track carrying the style.
 * 3. No transcript yet: start transcribing every source and answer
 *    `transcribing`; calling again once it is done generates (2).
 * 4. `mode: 'sample'` (or a given `text`): the old placeholder caption, only
 *    because it was asked for.
 *
 * `placeCaption: false` keeps its meaning: style the track and add nothing.
 * `retry` (default true) restarts a transcription that previously failed; the
 * GUI's wait loop passes false so a failure is reported once, not retried
 * forever.
 */
export function captionWithPreset(a: {
  presetId: string;
  mode?: CaptionPresetMode;
  track?: number;
  text?: string;
  startFrame?: number;
  durationFrames?: number;
  placeCaption?: boolean;
  force?: boolean;
  retry?: boolean;
}): CaptionWithPresetResult {
  const mode = a.text !== undefined ? 'sample' : (a.mode ?? 'auto');
  if (mode !== 'auto' && mode !== 'sample') return { error: 'mode must be "auto" or "sample"' };
  if (a.placeCaption === false) {
    const r = applyCaptionPreset({ ...a, placeCaption: false });
    return 'error' in r ? r : { ok: true, outcome: 'styled', track: r.track, preset: r.preset };
  }
  if (mode === 'sample') {
    const r = applyCaptionPreset({ ...a, placeCaption: true });
    return 'error' in r ? r : { ...r, outcome: 'sample' };
  }

  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) return { error: 'no timeline - open a project first' };
  const preset = captionPresetById(a.presetId);
  if (!preset) {
    return {
      error: `unknown caption preset "${a.presetId}" - valid ids: ${captionPresetIds().join(', ')}`,
    };
  }

  // 1. Captions already there: restyle, nothing placed.
  const existing = trackWithCaptions(tl, a.track);
  if (existing !== null) {
    const r = applyCaptionPreset({ presetId: preset.id, track: existing, placeCaption: false });
    if ('error' in r) return r;
    return {
      ok: true,
      outcome: 'restyled',
      track: existing,
      preset: preset.id,
      cues: useEditorTimelineStore.getState().timeline?.tracks[existing]?.clips.length ?? 0,
    };
  }
  if (a.track !== undefined) {
    const t = tl.tracks?.[a.track];
    if (!t) return { error: `no track ${a.track}` };
    if (t.kind !== 'subtitle') {
      return { error: `track ${a.track} is a ${t.kind} track - a caption preset applies to a subtitle track` };
    }
  }

  // 2/3. Nothing to restyle: caption the speech.
  const sources = transcriptSources(tl);
  if (sources.length === 0) {
    return {
      error:
        'there is no speech to caption on this timeline (no video clips or unlinked audio such as a voice-over) - pass mode="sample" to preview the look with sample text',
    };
  }
  const media = useMediaUnderstandingStore.getState();
  for (const s of sources) {
    const status = media.transcriptStatus(s.path);
    // A failed transcript is reported, not silently restarted, unless the
    // caller asked to retry.
    if (status.phase === 'error' && a.retry === false && !a.force) {
      return { error: `transcribing ${s.path} failed: ${status.error ?? 'unknown error'}` };
    }
    media.startTranscript(s.path, { wordTimestamps: true, force: !!a.force });
  }
  const fresh = useMediaUnderstandingStore.getState();
  const states = sources.map((s) => ({ path: s.path, status: fresh.transcriptStatus(s.path) }));
  const failed = states.find((s) => s.status.phase === 'error');
  if (failed) return { error: `transcribing ${failed.path} failed: ${failed.status.error ?? 'unknown error'}` };
  const pending = states.filter((s) => s.status.phase !== 'done').length;
  if (pending > 0) {
    return {
      ok: true,
      outcome: 'transcribing',
      preset: preset.id,
      pending,
      total: sources.length,
      note: `transcribing ${pending} of ${sources.length} source files - captions in this style are created when it finishes; call editor_add_caption_preset again then (or poll editor_get_transcript_status)`,
    };
  }
  const recoveries = Object.fromEntries(sources.map((s) => [s.path, fresh.recoveriesFor(s.path)]));
  const captions = captionsForTimeline(tl, fresh.transcripts, recoveries);
  if (captions.length === 0) {
    return {
      error:
        'the timeline transcript has no word-level timestamps to caption from - the clips may be silent, or every word was cut; pass mode="sample" to preview the look with sample text',
    };
  }
  useEditorTimelineStore.getState().applyOp({
    kind: 'import_subtitles',
    cues: captions,
    style: preset.style,
  });
  const after = useEditorTimelineStore.getState().timeline;
  return {
    ok: true,
    outcome: 'generated',
    track: (after?.tracks.length ?? 1) - 1,
    preset: preset.id,
    cues: captions.length,
  };
}
