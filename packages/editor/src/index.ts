/**
 * @apelles/editor — the Edit tab (D-041 MVP; timeline switcher + drag-to-track
 * D-046 pass 3).
 *
 * Single-video-track timeline of the open project's shots, scrub + play with a
 * lightweight decode→jpeg preview (independent of the Colorist render path),
 * and basic edits (reorder / trim / split / remove / add via drag-from-Sources)
 * persisted in the `.chroma` project via the `apelles-timeline` crate. A
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
/** B-124 — the same D-142/D-199 precedent again, for the clip Inspector.
 *  `app/harness.html`'s `?mode=inspector` mounts this standalone so a real
 *  Chromium tab can measure what the Video/Audio tab split actually PAINTS —
 *  the thing jsdom structurally cannot see, and the thing that let a
 *  both-panels-visible bug ship green (see that bug's entry in
 *  `docs/BUGS.md`). */
export { EditorInspectorPanel } from './EditorInspectorPanel';
/** D-263 — the Edit tab's library rail and its docked library column. Both are
 *  mounted by the composition root (`app/src/Root.tsx`) into `@apelles/shell`'s
 *  per-tab `libraryRail` / `libraryPanel` slots rather than by `EditorTab`
 *  itself, because they must sit to the LEFT of the shell-level Sources
 *  column; `Shell` renders whatever node it is handed and still imports
 *  nothing from this package (D-251's own injection pattern). */
export { EditLibraryRail } from './EditLibraryRail';
export type { EditLibraryRailProps } from './EditLibraryRail';
export { EditLibraryPanel } from './EditLibraryPanel';
/** D-274 — the project-level output-spec form (Resolution/Frame Rate/Colour
 *  Space), shared between this package's own docked `ProjectSettingsPanel`
 *  (`EditorInspectorPanel`'s "nothing selected" branch) and `app/src`'s
 *  `ProjectSettingsModal.tsx`, which renders this same component inside its
 *  dialog rather than keeping a second, duplicated copy of these controls.
 *  See `ProjectSettingsForm.tsx`'s own module doc. */
export { ProjectSettingsForm } from './ProjectSettingsForm';
export type { ProjectSettingsValue } from './ProjectSettingsForm';
/** D-263 — the library-mode model, exported for the same reason the clip
 *  Inspector's tab model below is: `Root.tsx` reads the active mode to decide
 *  whether the Edit tab is taking the shell's docked column over, and
 *  `@apelles/debug` reports it, both against this one list rather than a
 *  restated copy. */
export {
  EDIT_LIBRARY_MODES,
  EDIT_LIBRARY_MODE_LABELS,
  DEFAULT_EDIT_LIBRARY_MODE,
  parseEditLibraryMode,
} from './editLibrary';
export type { EditLibraryMode } from './editLibrary';
export { TimelineSwitcher } from './TimelineSwitcher';
export { useEditorTimelineStore } from './timelineStore';
// D-246 — the clip Inspector's tab model. Exported for `@apelles/debug`'s
// `debug_set_inspector_tab`, which validates against the same list the panel
// renders rather than restating it.
export {
  CLIP_INSPECTOR_TABS,
  CLIP_INSPECTOR_TAB_LABELS,
  DEFAULT_CLIP_INSPECTOR_TAB,
  clipInspectorTabs,
  parseClipInspectorTab,
  resolveClipInspectorTab,
} from './clipInspectorTabs';
export type { ClipInspectorTab } from './clipInspectorTabs';
export type { TimelineSummary } from './timelineStore';
// D-252 — the popover/dialog panel registry. Exported for `@apelles/debug`'s
// `debug_set_popover_open`, which validates against the same id list the
// panels themselves register with via `usePanelOpen` rather than restating
// it. See `panelRegistry.ts`'s module doc for why a shared map + one op
// generalises D-219/D-246's own bespoke-field pattern to N popovers.
export { PANEL_IDS, parsePanelId, usePanelOpen } from './panelRegistry';
export type { PanelId } from './panelRegistry';
/** D-252 exported `CaptionPanel` here for `@apelles/debug`'s DOM proof that
 *  `debug_set_popover_open` opens a REAL popover. D-263 docked that content
 *  (`CaptionLibrary.tsx`), so the popover — and its `caption-panel` panel id —
 *  are gone; that proof test then drove `CanvasSettingsPopover` instead.
 *  D-275 retired THAT popover too (D-274's docked Project Settings panel
 *  covers the same fields), so the same proof now drives
 *  `EditorExportDialog`/`'export-dialog'` instead — the other real
 *  registered popover, already exported below for its own real GUI use. */
/** D-219 (debug tooling piece 5) — the preview's own frame-timing ring
 *  buffers. Exported for `@apelles/debug`'s `debug_frame_timing` op, which
 *  reads them; `PreviewPane` writes them. Both writes and the reader are
 *  compile-time gated out of a production build (see `previewTiming.ts`), so
 *  this export tree-shakes away with them. */
export {
  previewTimingReport,
  recordPreviewSpan,
  recordPreviewTiming,
  resetPreviewTiming,
  TIMING_CAPACITY,
} from './previewTiming';
export type {
  PreviewTimingReport,
  ChannelTimingReport,
  PreviewTimingChannel,
  PreviewSpanChannel,
  SpanTimingReport,
} from './previewTiming';
/** D-198 — the Edit tab's own Export button/dialog/queue. Exported for the
 *  same D-142 harness-mounting reason `TimelinePane` itself is, and for any
 *  call site that wants the button standalone. D-249 moved where the app
 *  mounts it — `EditorTab` now hands it to the preview's own title strip
 *  (`PreviewPane`'s `headerActions` slot) rather than the timeline toolbar —
 *  but the component is unchanged. */
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
