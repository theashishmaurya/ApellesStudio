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
/** D-199 — the same D-142 precedent as `TimelinePane` above, extended to the
 *  preview pane: `app/harness.html`'s isolated browser harness mounts this
 *  to drive real-layout/real-paint checks of the canvas-boundary overlay and
 *  on-canvas transform handles (server-composited pixels themselves are
 *  proven separately, through the real Rust `timeline_frame` code path — see
 *  `docs/notes/preview-canvas-boundary.md` — the harness's job is the React
 *  layer: does the returned frame render, does the boundary land in the
 *  right place, does dragging commit). */
export { PreviewPane } from './PreviewPane';
export { TimelineSwitcher } from './TimelineSwitcher';
export { useEditorTimelineStore } from './timelineStore';
export type { TimelineSummary } from './timelineStore';
/** D-219 (debug tooling piece 5) — the preview's own frame-timing ring
 *  buffers. Exported for `@chroma/debug`'s `debug_frame_timing` op, which
 *  reads them; `PreviewPane` writes them. Both writes and the reader are
 *  compile-time gated out of a production build (see `previewTiming.ts`), so
 *  this export tree-shakes away with them. */
export {
  previewTimingReport,
  recordPreviewTiming,
  resetPreviewTiming,
  TIMING_CAPACITY,
} from './previewTiming';
export type { PreviewTimingReport, ChannelTimingReport, PreviewTimingChannel } from './previewTiming';
/** D-198 — the Edit tab's own Export button/dialog/queue. Exported
 *  alongside `TimelinePane` (which already renders it in its own toolbar)
 *  for the same D-142 harness-mounting reason `TimelinePane` itself is —
 *  and for any future call site that wants the button standalone. */
export { EditorExportDialog } from './EditorExportDialog';
export { useExportQueueStore } from './exportQueueStore';
export type { ExportJob, ExportJobStatus } from './exportQueueStore';
/** D-189 — media understanding (transcript + "what changed on screen"), cached
 *  by source path. Exported because the results are Edit-tab data a future
 *  panel will read, not just something the `editor_*` control ops consume. */
export { useMediaUnderstandingStore } from './mediaUnderstandingStore';
export type {
  Transcript,
  TranscriptSegment,
  TranscriptWord,
  VideoAnalysis,
  VideoEvent,
} from './mediaUnderstandingStore';
export type { Timeline, Track, Clip, EditOp, DraggedMedia, EaseCurve } from './timeline';
export {
  // D-147 — fade curve presets + the curve→preset-name match, exported for
  // the MCP bridge: `useChromaControl`'s `set_clip_fade` accepts a preset name
  // and `get_timeline` reports one back.
  EASE_PRESETS,
  DEFAULT_EASE_CURVE,
  easePresetName,
  // D-147 — `get_timeline` reports the timeline's own duration.
  timelineDuration,
  // D-149 — the ducking migration defaults, exported for the MCP bridge:
  // `get_timeline` reports a track's attack/release and `set_track_duck`
  // fills them in when the caller omits one. Non-zero, so an absent field
  // must never be read as falsy (0 ms is a step function, i.e. a click).
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  CHROMA_MEDIA_DRAG_MIME,
  clipFromDraggedMedia,
  // D-129 — A/V link groups (`docs/notes/av-linking.md`).
  linkedClipsFromDraggedMedia,
  linkGroupMembers,
  linkedClipIds,
  audioTrackWithRoom,
  ensureAudioTrackWithRoom,
} from './timeline';
