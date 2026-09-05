/**
 * @chroma/editor — the Edit tab (D-041 MVP; timeline switcher + drag-to-track
 * D-046 pass 3).
 *
 * Single-video-track timeline of the open project's shots, scrub + play with a
 * lightweight decode→jpeg preview (independent of the Colorist render path),
 * and basic edits (reorder / trim / split / remove / add via drag-from-Sources)
 * persisted in the `.chroma` project via the `chroma-timeline` crate. A
 * project can hold several named timelines (D-045); `TimelineSwitcher`
 * (D-046) is the first UI for that.
 *
 * Deferred to later tracked steps: multi-track, audio, transitions, transcript
 * cut, GPU compositing, grade-in-preview, OTIO export, MCP tools.
 */

export { EditorTab } from './EditorTab';
/** Exported alongside `EditorTab` (D-142) so `app/harness.html`'s permanent
 *  isolated pointer-gesture harness — and any future one — can mount the
 *  timeline strip standalone, matching the precedent D-095 established
 *  (mounting `TimelinePane` alone sidesteps `PreviewPane`'s own decode/canvas
 *  surface and the full app's Tauri-IPC boot chain, neither relevant to a
 *  pointer-gesture check) without reaching past this package's public API to
 *  do it. */
export { TimelinePane } from './TimelinePane';
export { TimelineSwitcher } from './TimelineSwitcher';
export { useEditorTimelineStore } from './timelineStore';
export type { TimelineSummary } from './timelineStore';
export type { Timeline, Track, Clip, EditOp, DraggedMedia, FadeCurve } from './timeline';
export {
  // D-147 — fade curve presets + the curve→preset-name match, exported for
  // the MCP bridge: `useChromaControl`'s `set_clip_fade` accepts a preset name
  // and `get_timeline` reports one back.
  FADE_PRESETS,
  DEFAULT_FADE_CURVE,
  fadePresetName,
  // D-147 — `get_timeline` reports the timeline's own duration.
  timelineDuration,
  CHROMA_MEDIA_DRAG_MIME,
  clipFromDraggedMedia,
  // D-129 — A/V link groups (`docs/notes/av-linking.md`).
  linkedClipsFromDraggedMedia,
  linkGroupMembers,
  linkedClipIds,
  audioTrackWithRoom,
  ensureAudioTrackWithRoom,
} from './timeline';
