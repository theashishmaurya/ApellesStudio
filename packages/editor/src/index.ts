/**
 * @chroma/editor — the Edit tab (D-041, MVP).
 *
 * Single-video-track timeline of the open project's shots, scrub + play with a
 * lightweight decode→jpeg preview (independent of the Colorist render path),
 * and basic edits (reorder / trim / split / remove) persisted in the `.chroma`
 * project via the `chroma-timeline` crate.
 *
 * Deferred to later tracked steps: multi-track, audio, transitions, transcript
 * cut, GPU compositing, grade-in-preview, OTIO export, MCP tools.
 */

export { EditorTab } from './EditorTab';
export { useEditorTimelineStore } from './timelineStore';
export type { Timeline, Track, Clip, EditOp } from './timeline';
