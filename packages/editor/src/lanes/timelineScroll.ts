/**
 * @apelles/editor — the timeline's scroll position, outside React state (D-437 S8;
 * plan `docs/notes/timeline-lanes.md` §2.3).
 *
 * What it is: a tiny per-pane store (zustand's vanilla `createStore`, one
 * instance per `TimelinePane`, made in a `useState` initialiser) holding the
 * lanes' scroller's `left`/`top`. The scroller's `scroll` event, the zoom
 * anchor and the mount adoption are its only writers; the DOM stays the source
 * of truth and this is its mirror, so B-291's two-copy echo loop cannot come
 * back (nothing writes the scroller FROM this store).
 *
 * Why: a scroll used to be `setScrollLeft`/`setScrollTop` on the pane, which
 * re-rendered the whole ~4000-line pane every scroll frame. Now a scroll
 * renders the pane zero times. Readers:
 *   - event handlers (drops, clicks, drags, the marquee, the skimmer, the
 *     playback follower) read `getState()` at the moment of the event;
 *   - imperative sinks (the header column's `translateY`, the playhead, the
 *     edit area's view attributes) are written by the pane's one `subscribe`;
 *   - the few components whose output depends on the scroll subscribe through
 *     `useTimelineScroll` with a selector, so they re-render only when the
 *     value they select changes: `TimelineLanes` selects the window bucket
 *     (`windowScrollLeft`), so it re-renders once per half viewport of scroll;
 *     the pinned strips (ruler, beat lane, markers, curve lane) select `left`.
 *
 * Content-space overlays (transitions, gap selection, drag ghosts, the marquee,
 * the drop zones and the height zones) need no reader at all: they live inside
 * the scroller's content and ride native scrolling.
 *
 * What it does NOT do: scroll anything (writes go to the scroller element), or
 * hold the zoom (`timelineView.ts`).
 */
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface TimelineScrollState {
  /** The scroller's `scrollLeft`, px. */
  left: number;
  /** The scroller's `scrollTop`, px. */
  top: number;
}

export type TimelineScrollStore = StoreApi<TimelineScrollState>;

/** A fresh store at the origin. One per pane: `useState(createTimelineScrollStore)`. */
export function createTimelineScrollStore(): TimelineScrollStore {
  return createStore<TimelineScrollState>()(() => ({ left: 0, top: 0 }));
}

/** Write a position; a no-op (no listener runs) when it is the one already held,
 *  so an echo of a write that was already mirrored costs nothing. */
export function setTimelineScroll(store: TimelineScrollStore, left: number, top: number): void {
  const cur = store.getState();
  if (cur.left === left && cur.top === top) return;
  store.setState({ left, top });
}

/** Subscribe a component to one derived value of the scroll position. It
 *  re-renders only when the selected value changes (`Object.is`), so select a
 *  primitive. */
export function useTimelineScroll<T>(store: TimelineScrollStore, select: (s: TimelineScrollState) => T): T {
  return useStore(store, select);
}

const selectLeft = (s: TimelineScrollState) => s.left;

/** Renders `children(scrollLeft)` and re-renders on a horizontal scroll, without
 *  re-rendering its parent: how the pane hands the live `scrollLeft` to the
 *  pinned strips (ruler, beat lane, markers, curve lane) that draw in viewport
 *  coordinates, while those components keep a plain `scrollLeft: number` prop. */
export function WithScrollLeft({ store, children }: { store: TimelineScrollStore; children: (scrollLeft: number) => ReactNode }) {
  const left = useTimelineScroll(store, selectLeft);
  return children(left);
}
