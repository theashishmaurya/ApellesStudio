/**
 * targets.ts — named places on the timeline, for scenarios (D-434).
 *
 * What it is: small builders over the timeline's stable test ids
 *   (`TIMELINE_TEST_IDS`) and the library's own class names
 *   (`TIMELINE_LIBRARY_SELECTORS`), so a scenario says `trimRight(id)` rather
 *   than spelling a selector — and a renamed hook is one edit in
 *   `@apelles/editor`, not a sweep through every scenario.
 *
 * What it does NOT do: resolve anything. These return target DESCRIPTIONS;
 *   the app resolves them against its live DOM (`debug_pointer`), and the
 *   frame-addressed ones (`atFrame`) are resolved by the runner from the view
 *   readout.
 */

import { TIMELINE_LIBRARY_SELECTORS as LIB, TIMELINE_TEST_IDS as ID } from '@apelles/editor/src/timelineTestIds.ts';

import type { Value } from './assertions.ts';
import type { FrameOffset, FrameTarget, TargetRef } from './scenario.ts';

/** How far inside a clip edge a trim press lands — a clip's own edge-trim
 *  zone is 8 px wide (D-432 P2), so 3 px is well inside it and clear of the
 *  neighbour's. */
export const EDGE_INSET_PX = 3;

const q = (value: string) => value.replace(/["\\]/g, '\\$&');

/** The placeholder a selector carries for a fixture clip's id, which only
 *  exists once the fixture is built; the runner substitutes the real id
 *  (`substituteIds`) just before the gesture is sent. */
export const clipIdToken = (name: string) => `@clip:${name}`;
export const markerIdToken = (name: string) => `@marker:${name}`;

/** The selector for one fixture clip's body, by its fixture name. */
export const clipSelector = (name: string) => `[data-testid="${ID.clip}"][data-chroma-clip-id="${clipIdToken(name)}"]`;

export const testid = (id: string, at?: { fx?: number; fy?: number; dx?: number; dy?: number }, nth?: number): TargetRef => ({
  testid: id,
  ...(at ? { at } : {}),
  ...(nth !== undefined ? { nth } : {}),
});

export const selector = (sel: string, at?: { fx?: number; fy?: number; dx?: number; dy?: number }): TargetRef => ({
  selector: sel,
  ...(at ? { at } : {}),
});

/** A clip body; `fx`/`fy` place the press (e.g. `fy: 0.2` = the slip band). */
export const clip = (name: string, at?: { fx?: number; fy?: number; dx?: number; dy?: number }) => selector(clipSelector(name), at);

/** A clip's left / right edge-trim zone (D-432 P2: the clip's own zones,
 *  which replaced the library's interact.js stretch handles). */
export const trimLeft = (name: string): TargetRef => selector(`${clipSelector(name)} [data-testid="${ID.clipTrimStart}"]`);
export const trimRight = (name: string): TargetRef => selector(`${clipSelector(name)} [data-testid="${ID.clipTrimEnd}"]`);

/** A point inside a clip, `px` from its left/right edge (an edge trim aimed by
 *  geometry rather than by the library's handle element). */
export const clipEdge = (name: string, side: 'left' | 'right', px: number = EDGE_INSET_PX) =>
  clip(name, side === 'left' ? { fx: 0, dx: px } : { fx: 1, dx: -px });

/** The ruler at a fraction of its width. */
export const ruler = (fx = 0.5): TargetRef => selector(`[data-testid="${ID.ruler}"]`, { fx, fy: 0.5 });
/** D-432 P3 — track N's header bottom-edge height zone. */
export const trackHeightZone = (track: number) =>
  selector(`[data-testid="${ID.trackHeightResize}"][data-chroma-track="${track}"]`, { fy: 0.5 });
/** Where a human grabs the playhead to scrub (H16): its head band, the strip
 *  under the ruler (`.timeline-editor-cursor-area`, B-346: the only part of the
 *  playhead that takes the pointer, B-349). A drag from there scrubs live (the
 *  ruler scrubs too since P3's own `TimelineRuler`, B-350, and has its own
 *  scenario, `scrub-ruler-drag`). The band is centred on the playhead wherever it is, so the
 *  press lands on it exactly and `expectHit` can stay on. */
export const playheadGrab = (): TargetRef => selector(LIB.playheadBand, { fx: 0.5, fy: 0.5 });

export const trackHeader = (track: number, at?: { fx?: number; fy?: number }) =>
  selector(`[data-testid="${ID.trackHeader}"][data-chroma-track="${track}"]`, at);

export const trimTool = (tool: string) => selector(`[data-testid="${ID.trimTool}"][data-chroma-trim-tool="${q(tool)}"]`);
export const marker = (name: string) => selector(`[data-testid="${ID.marker}"][data-chroma-marker="${markerIdToken(name)}"]`);
export const editArea = (at?: { fx?: number; fy?: number; dx?: number; dy?: number }) => testid(ID.editArea, at);
/** By `id` (H7): react-resizable-panels 4.x derives `data-testid` from it. */
export const headerResize = (): TargetRef => selector(`#${ID.headerResize}`);

/** TIMELINE frame `frame` on `track` (resolved by the runner from the view readout). */
export const atFrame = (frame: Value, track: number | 'ruler', fy?: number): FrameTarget => ({ frame, track, ...(fy !== undefined ? { fy } : {}) });

/** `frames` timeline frames right (and `tracks` rows down) of the previous point. */
export const byFrames = (frames: Value, tracks?: number): FrameOffset => ({ byFrames: frames, ...(tracks !== undefined ? { byTracks: tracks } : {}) });

/** `{ref}` shorthand for a captured value, with optional arithmetic. */
export const ref = (path: string, plus?: number): Value => ({ ref: path, ...(plus !== undefined ? { plus } : {}) });

export { ID as TIMELINE_TEST_IDS, LIB as TIMELINE_LIBRARY_SELECTORS };
