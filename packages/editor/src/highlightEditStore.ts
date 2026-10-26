/**
 * @apelles/editor — view state for editing a clip's highlights (D-396).
 *
 * What it is: which clip's highlight boxes the viewer is showing for editing
 * (`armedClipId`) and which highlight is selected (`selected`). Never persisted
 * and never part of the document: the boxes themselves are read back from the
 * clip every render, exactly as `DynamicZoomOverlay` does, so arming writes
 * nothing. Same shape and reasoning as the dynamic-zoom mode in
 * `timelineStore`, kept in its own tiny store so the feature does not widen the
 * 800-line timeline store.
 */

import { createSharedStore } from '@apelles/store';

interface HighlightEditState {
  /** The clip whose boxes the viewer shows and lets you drag; `null` = none. */
  armedClipId: string | null;
  /** Index into that clip's `highlights`; `null` = none selected. */
  selected: number | null;
  arm: (clipId: string | null) => void;
  select: (index: number | null) => void;
}

export const useHighlightEditStore = createSharedStore<HighlightEditState>('edit.highlights', (set) => ({
  armedClipId: null,
  selected: null,
  arm: (clipId) => set({ armedClipId: clipId, selected: null }),
  select: (index) => set({ selected: index }),
}));
