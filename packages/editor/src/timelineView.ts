/**
 * timelineView.ts — the Edit timeline's own VIEW state: its horizontal zoom.
 *
 * What it is: a tiny zustand store holding `pxPerSec`, how many CSS pixels one
 *   second of timeline spans. It used to be `useState` inside `TimelinePane`,
 *   which left the zoom unreachable from anything but that component's buttons
 *   and wheel handler — a human-only control, and a state the UI test harness
 *   could neither reset between scenarios nor read (D-434 / H2). Now the pane,
 *   `editor_set_timeline_view` and `editor_get_state.timelineView` all use this
 *   one value (D-432's planned view-settings tool, first field: zoom).
 *
 * What it does NOT do: anchor a zoom (the pane's `zoomBy` captures the frame
 *   under the cursor / playhead and restores it after layout — a view gesture,
 *   so it stays in the pane; a zoom set through here keeps `scrollLeft` as it
 *   is), persist anything, or sit on the undo stack. It is display-only UI
 *   state, like the preview viewport (D-218): never in `project.json`, never
 *   undoable.
 */

import { create } from 'zustand';

import { DEFAULT_PX_PER_SEC, MAX_PX_PER_SEC, MIN_PX_PER_SEC } from './ruler';

/** `pxPerSec` clamped into the zoom range the ruler's tick ladder is sized for. */
export function clampPxPerSec(pxPerSec: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec));
}

/** The toolbar's readout: percent of the default zoom (90 px/s = 100 %). */
export function timelineZoomPct(pxPerSec: number): number {
  return Math.round((pxPerSec / DEFAULT_PX_PER_SEC) * 100);
}

interface TimelineViewState {
  pxPerSec: number;
  /** Always clamped, so no caller can leave the ruler outside its ladder. */
  setPxPerSec: (pxPerSec: number) => void;
}

export const useTimelineViewStore = create<TimelineViewState>((set) => ({
  pxPerSec: DEFAULT_PX_PER_SEC,
  setPxPerSec: (pxPerSec) => set({ pxPerSec: clampPxPerSec(pxPerSec) }),
}));
