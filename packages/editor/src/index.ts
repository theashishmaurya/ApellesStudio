/**
 * @chroma/editor — the Editing tab (D-039, new/greenfield).
 *
 * Will hold: the timeline strip (`react-timeline-editor` based), the transcript
 * pane (whisper word-timestamps → EDL), and the trim / ripple / roll UI, reading
 * the `chroma-timeline` model over `@chroma/bridge`.
 *
 * Status: D-039 3-tab-shell step — placeholder tab only.
 */

export { EditorTab } from './EditorTab';
