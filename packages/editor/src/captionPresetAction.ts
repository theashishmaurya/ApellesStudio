// @chroma/editor — applying a caption preset (D-243).
//
// **What it is:** the ONE action that turns a preset id into timeline edits —
// find or create a subtitle track, write the preset's style onto it, and
// optionally drop a caption on it.
//
// **Why it is its own module rather than living in the panel.** CLAUDE.md's
// standing rule: every feature is built for a human AND an AI, through the
// same op underneath. `CaptionPanel.tsx` calls this when a library tile is
// clicked; `editor_add_caption_preset` calls exactly the same function. There
// is no second code path that could drift, and no behaviour the GUI has that
// MCP does not.
//
// **What it does NOT do:** it does not own the preset data (`captionPresets.ts`
// does), it does not render, and it invents no new op — it composes the
// existing `add_track` / `set_caption_style` / `add_clip` ops, so undo,
// history labels and persistence all work on a preset exactly as they work on
// anything else.

import { captionPresetById, captionPresetIds } from './captionPresets';
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
  const startFrame =
    a.startFrame !== undefined
      ? Math.round(Number(a.startFrame))
      : useEditorTimelineStore.getState().playhead;

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
