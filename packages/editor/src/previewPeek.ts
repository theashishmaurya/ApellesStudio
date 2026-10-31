/**
 * previewPeek.ts — what the Edit viewer shows INSTEAD of the playhead's frame,
 * for a moment (D-432 P3, `docs/notes/ui-redesign.md` §4.6 skimmer, §5.1
 * two-up).
 *
 * What it is: a tiny zustand store with two transient requests the timeline
 * makes of the viewer, neither of which moves the playhead:
 *   - **`skimFrame`** — skimming (S): the timeline frame under the pointer.
 *     `PreviewPane` subscribes outside React and fetches that frame through its
 *     own latest-wins `chroma_timeline_frame` path; `null` puts the playhead's
 *     frame back. The timeline writes it at most once per animation frame and
 *     only when the frame number changes.
 *   - **`twoUp`** — a roll, slip or slide being dragged: the two frames either
 *     side of the edit (outgoing | incoming), as source frames, with their
 *     labels and timecodes. `TwoUpViewer` draws them over the picture.
 *
 * What it does NOT do: persist, sit on the undo stack, or touch the timeline.
 * Writing here never re-renders `TimelinePane` (it does not subscribe).
 */

import { create } from 'zustand';

/** One half of the two-up viewer: a frame of a clip's source. */
export interface TwoUpHalf {
  /** the clip's source file; `''` for a clip with no picture (a title) */
  sourcePath: string;
  /** the frame in the source's own time base */
  sourceFrame: number;
  /** "Out" / "In" / "Start" / "End" */
  label: string;
  /** the half's TIMELINE frame, shown as timecode under it */
  timelineFrame: number;
}

export interface TwoUpView {
  left: TwoUpHalf;
  right: TwoUpHalf;
}

interface PreviewPeekState {
  skimFrame: number | null;
  twoUp: TwoUpView | null;
  setSkimFrame: (frame: number | null) => void;
  setTwoUp: (view: TwoUpView | null) => void;
}

const sameHalf = (a: TwoUpHalf, b: TwoUpHalf) =>
  a.sourcePath === b.sourcePath && a.sourceFrame === b.sourceFrame && a.label === b.label && a.timelineFrame === b.timelineFrame;

export const usePreviewPeekStore = create<PreviewPeekState>((set, get) => ({
  skimFrame: null,
  twoUp: null,
  setSkimFrame: (frame) => {
    if (get().skimFrame !== frame) set({ skimFrame: frame });
  },
  setTwoUp: (view) => {
    const cur = get().twoUp;
    // Unchanged halves set nothing: a drag that stays on a frame costs no
    // render of the viewer.
    if (view === cur || (view && cur && sameHalf(view.left, cur.left) && sameHalf(view.right, cur.right))) return;
    set({ twoUp: view });
  },
}));
