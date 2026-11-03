/**
 * The v0.3.0 Inspector panel redesign interactions (B-365 / B-366, D-442 /
 * D-443; `docs/notes/panel-redesign.md` "As built"), driven on the live app:
 * - crop in the viewer: the Crop header's button arms crop mode, dragging the
 *   left edge handle writes `crop_left` AND keeps the picture in place (the
 *   box shrinks to the kept part), as ONE undo step; Esc ends the mode;
 * - the EQ graph is the control: dragging a numbered dot writes that band's
 *   frequency and gain as ONE undo step, and the Inspector's band row then
 *   shows that band; the MCP `preset` writes the same table the menu does.
 *
 * What it does NOT do: judge the look (the screenshots in
 * `scratch/ui-compare/inspector-v030/` do), or hear the EQ.
 */

import type { Scenario } from '../scenario.ts';
import { clip, selector } from '../targets.ts';
import { FPS_GUARD, THREE_CLIPS } from './common.ts';

const INSPECTOR = '[data-chroma-panel="clip-inspector"]';
const CROP_TOGGLE = `${INSPECTOR} [data-crop-toggle]`;
const LEFT_HANDLE = '[data-crop-overlay] [data-crop-handle="crop_left"]';
const SOURCE_RECT = '[data-crop-overlay] [data-crop-source]';
/** Band 3's dot (index 2) on the EQ graph. */
const BAND3_DOT = `${INSPECTOR} [data-chroma-eq-point="2"]`;
const EQ_GRAPH = `${INSPECTOR} [data-chroma-eq-graph]`;

export const PANEL_REDESIGN_SCENARIOS: Scenario[] = [
  {
    id: 'inspector-crop-in-viewer',
    title: 'The Crop button puts the viewer in crop mode; dragging an edge crops in place as ONE undo step',
    area: 'inspector',
    reference: 'Final Cut Pro Crop (Trim) in the viewer; the approved revision-2 mockup ("crop should be interactive"), D-443',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'debug_set_editor_inspector', args: { open: true } },
      { op: 'editor_set_playhead', args: { frame: 135 }, label: 'park the playhead over clip b' },
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) }, label: 'select clip b' },
      { op: 'debug_set_inspector_tab', args: { tab: 'video' } },
      { op: 'debug_set_inspector_section', args: { id: 'crop', open: true } },
      { wait: 250 },
      { reachable: { selector: CROP_TOGGLE, reason: 'the Crop section header carries the crop-mode button (D-443)' } },
      { pointer: { action: 'click', target: selector(CROP_TOGGLE) }, label: 'enter crop mode' },
      { wait: 300 },
      { reachable: { selector: LEFT_HANDLE, reason: 'crop mode draws four edge handles in the viewer' } },
      { capture: 'timeline', as: 'before' },
      {
        pointer: {
          action: 'drag',
          target: selector(LEFT_HANDLE, { fx: 0.5, fy: 0.5 }),
          to: selector(SOURCE_RECT, { fx: 0.2, fy: 0.5 }),
          steps: 12,
          durationMs: 400,
          watch: { selectors: ['[data-crop-overlay] [data-crop-kept]'] },
        },
        measure: true,
        label: 'drag the left edge in to about 20 %',
      },
      { waitFor: { path: 'timeline.clips.b.cropLeft', op: 'near', value: 0.2, tolerance: 0.04 }, label: 'the clip took the crop' },
      {
        expect: [
          { path: 'timeline.clips.b.scale', op: 'lt', value: { ref: 'before.clips.b.scale' }, label: 'the box shrank to the kept part' },
          { path: 'timeline.clips.b.positionX', op: 'gt', value: { ref: 'before.clips.b.positionX' }, label: 'and moved right: the picture stayed in place' },
        ],
      },
      { op: 'undo', label: 'one undo' },
      { waitFor: { path: 'timeline.clips.b.cropLeft', op: 'eq', value: 0 }, label: 'one undo restored the crop: the drag was one step' },
      { key: { keys: ['Escape'] }, label: 'Esc ends crop mode' },
      { wait: 200 },
      { capture: 'dom', selector: CROP_TOGGLE, as: 'toggleAfter' },
      { expect: { path: 'toggleAfter.attrs.aria-pressed', op: 'eq', value: 'false', label: 'the crop button is released' } },
    ],
  },
  {
    id: 'inspector-eq-dot-drag',
    title: 'Dragging an EQ dot writes that band’s frequency and gain as ONE undo step; the MCP preset uses the same table',
    area: 'inspector',
    reference: 'Logic Channel EQ / Final Cut EQ: drag the band’s dot; the approved revision-2 mockup ("the graph is the control"), D-442',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'debug_set_editor_inspector', args: { open: true } },
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) }, label: 'select clip b' },
      { op: 'debug_set_inspector_tab', args: { tab: 'audio' } },
      { op: 'debug_set_inspector_section', args: { id: 'eq', open: true } },
      { wait: 300 },
      { reachable: { selector: BAND3_DOT, reason: 'the EQ graph shows a numbered dot per band (D-442)' } },
      {
        pointer: {
          action: 'drag',
          target: selector(BAND3_DOT, { fx: 0.5, fy: 0.5 }),
          to: selector(EQ_GRAPH, { fx: 0.82, fy: 0.3 }),
          steps: 12,
          durationMs: 400,
          watch: { selectors: [`${INSPECTOR} [data-chroma-eq-tip]`] },
        },
        measure: true,
        label: 'drag band 3 up and to the right',
      },
      { waitFor: { path: 'timeline.clips.b.eqBands.2.gain_db', op: 'gt', value: 3 }, label: 'band 3 took a boost' },
      { expect: { path: 'timeline.clips.b.eqBands.2.freq_hz', op: 'gt', value: 2500, label: 'and a higher frequency' } },
      { capture: 'dom', selector: `${INSPECTOR} [data-chroma-eq-band-row]`, as: 'row' },
      { expect: { path: 'row.attrs.data-chroma-eq-band-row', op: 'eq', value: '2', label: 'the band row shows the dragged band' } },
      { op: 'undo', label: 'one undo' },
      { waitFor: { path: 'timeline.clips.b.eqBands', op: 'eq', value: [] }, label: 'one undo removed the EQ: the drag was one step' },
      { op: 'editor_set_clip_eq', args: { track: 0, clip: 1, preset: 'Voice clarity' }, label: 'the AI half: the same preset table' },
      { waitFor: { path: 'timeline.clips.b.eqBands.0.kind', op: 'eq', value: 'high_pass' } },
      { capture: 'dom', selector: `${INSPECTOR} [data-chroma-eq-preset]`, as: 'preset' },
      { expect: { path: 'preset.attrs.data-chroma-eq-preset', op: 'eq', value: 'Voice clarity', label: 'the GUI names the MCP-set preset' } },
    ],
  },
];
