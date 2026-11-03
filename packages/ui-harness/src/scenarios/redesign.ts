/**
 * The v0.3.0 gap-closure interactions (D-432, B-359 / B-354;
 * `docs/notes/ui-redesign.md` §6e), driven on the live app:
 * - an Inspector inline slider drag is ONE undo step;
 * - the track header's ID pill sets and clears the target track (D-440), and
 *   the MCP tool and the pill drive the same flag;
 * - the toolbar's zoom slider zooms the timeline.
 *
 * What it does NOT do: judge the look (the screenshot comparison against the
 * mockup does), or measure perf beyond the default budget on each gesture.
 */

import type { Scenario } from '../scenario.ts';
import { clip, selector, testid, TIMELINE_TEST_IDS } from '../targets.ts';
import { FPS_GUARD, THREE_CLIPS } from './common.ts';

/** The Opacity row's slider (the Compositing section, Video tab). */
const OPACITY_SLIDER = '[data-chroma-panel="clip-inspector"] [data-slot="slider-field"]:has(input[aria-label="Opacity"]) [data-slot="inline-slider"]';
/** One track header's ID pill. */
const pill = (track: number) =>
  `[data-testid="${TIMELINE_TEST_IDS.trackHeader}"][data-chroma-track="${track}"] [data-testid="${TIMELINE_TEST_IDS.trackBadge}"]`;

export const REDESIGN_SCENARIOS: Scenario[] = [
  {
    id: 'inspector-slider-drag-one-undo',
    title: 'Dragging the Inspector Opacity slider changes the clip live and is ONE undo step',
    area: 'inspector',
    reference: 'Final Cut / Resolve Inspector sliders; D-432 §4.10 ("the commit to history lands on pointer-up as one undo step")',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'debug_set_editor_inspector', args: { open: true } },
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) }, label: 'select clip b' },
      { op: 'debug_set_inspector_tab', args: { tab: 'video' } },
      { op: 'debug_set_inspector_section', args: { id: 'compositing', open: true } },
      { wait: 250 },
      { reachable: { selector: OPACITY_SLIDER, reason: 'the Opacity row has an inline slider (B-359 item 2)' } },
      {
        pointer: { action: 'drag', target: selector(OPACITY_SLIDER, { fx: 0.98, fy: 0.5 }), to: selector(OPACITY_SLIDER, { fx: 0.3, fy: 0.5 }), steps: 12, durationMs: 400 },
        measure: true,
        label: 'drag Opacity from 100 % to about 30 %',
      },
      { waitFor: { path: 'timeline.clips.b.opacity', op: 'lt', value: 0.6 }, label: 'the clip took the dragged opacity' },
      { op: 'undo', label: 'one undo' },
      { waitFor: { path: 'timeline.clips.b.opacity', op: 'eq', value: 1 }, label: 'one undo restored the start: the drag was one step' },
    ],
  },
  {
    id: 'track-target-pill-click',
    title: 'Clicking a track’s ID pill targets the track; again clears it; the MCP tool drives the same flag',
    area: 'tracks',
    reference: 'Premiere track targeting / Resolve destination track; the approved mockup’s accent V1 pill (D-440)',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: selector(pill(1)) }, measure: true, label: 'click V2’s pill' },
      { waitFor: { path: 'timeline.targetTrack', op: 'eq', value: 1 } },
      { capture: 'dom', selector: pill(1), as: 'pillOn' },
      { expect: { path: 'pillOn.attrs.aria-pressed', op: 'eq', value: 'true', label: 'the pill reads as pressed (accent)' } },
      { pointer: { action: 'click', target: selector(pill(1)) }, label: 'click it again' },
      { waitFor: { path: 'timeline.targetTrack', op: 'eq', value: null } },
      { op: 'editor_set_target_track', args: { track: 0 }, label: 'the AI half' },
      { waitFor: { path: 'timeline.targetTrack', op: 'eq', value: 0 } },
      { capture: 'dom', selector: pill(0), as: 'pillMcp' },
      { expect: { path: 'pillMcp.attrs.aria-pressed', op: 'eq', value: 'true', label: 'the GUI shows the MCP-set target' } },
    ],
  },
  {
    id: 'zoom-toolbar-slider',
    title: 'Dragging the toolbar zoom slider right zooms the timeline in',
    area: 'zoom',
    reference: 'Final Cut’s timeline zoom slider (D-432 §4.9); B-354 replaced the − 20% + readout',
    fixture: THREE_CLIPS,
    steps: [
      { capture: 'view', as: 'before' },
      {
        pointer: {
          action: 'drag',
          target: testid(TIMELINE_TEST_IDS.toolbarZoomSlider, { fx: 0.5, fy: 0.5 }),
          to: testid(TIMELINE_TEST_IDS.toolbarZoomSlider, { fx: 0.85, fy: 0.5 }),
          steps: 8,
          durationMs: 300,
        },
        measure: true,
      },
      { waitFor: { path: 'view.pxPerSec', op: 'gt', value: { ref: 'before.pxPerSec' } } },
    ],
  },
];
