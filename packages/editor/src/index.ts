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
export { TimelineSwitcher } from './TimelineSwitcher';
export { useEditorTimelineStore } from './timelineStore';
export type { TimelineSummary } from './timelineStore';
export type { Timeline, Track, Clip, EditOp, DraggedMedia } from './timeline';
export {
  CHROMA_MEDIA_DRAG_MIME,
  clipFromDraggedMedia,
  // D-129 — A/V link groups (`docs/notes/av-linking.md`).
  linkedClipsFromDraggedMedia,
  linkGroupMembers,
  linkedClipIds,
  audioTrackWithRoom,
  ensureAudioTrackWithRoom,
} from './timeline';
