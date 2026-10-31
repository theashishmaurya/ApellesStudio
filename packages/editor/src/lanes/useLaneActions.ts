/**
 * @apelles/editor — the lanes' stable action object (D-437 S3a, plan §2.2).
 *
 * What it is: a hook that turns "the latest handlers from the pane" into ONE
 * object whose identity never changes, so a memoised `LaneClip` that receives it
 * as a prop is not re-rendered when the pane re-renders. Each method reads the
 * latest handler through a ref at CALL time (in an event handler); the ref is
 * written in a layout effect, never during render, which is what keeps the React
 * Compiler from bailing out of the file that uses it ("Cannot access refs during
 * render", D-201) and is the same pattern as the pane's `zoomByRef`.
 *
 * What it does NOT do: decide what a click or a press means — that stays in the
 * pane's handlers (selection rules, the edit-gesture claim, the curve lane).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ClipKeyframeParam } from '../timeline';

/** What a lane clip can ask the pane to do. */
export interface LaneActions {
  /** `useEditGesture`'s press handler: runs in the capture phase, before dnd-kit's. */
  onClipPointerDownCapture: (e: ReactPointerEvent<HTMLDivElement>, track: number, clipId: string) => void;
  /** A click on the clip's slot: selection (plain / Shift range / Cmd toggle). */
  onClipClick: (e: ReactMouseEvent<HTMLElement>, track: number, clipId: string) => void;
  /** The keyframes badge: open the curve lane on `param`, or `null` to close it. */
  onToggleCurve: (track: number, clipId: string, param: ClipKeyframeParam | null) => void;
}

/** A `LaneActions` with a permanent identity that forwards to `latest`. */
export function useLaneActions(latest: LaneActions): LaneActions {
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  });
  const [actions] = useState<LaneActions>(() => ({
    onClipPointerDownCapture: (e, track, clipId) => latestRef.current.onClipPointerDownCapture(e, track, clipId),
    onClipClick: (e, track, clipId) => latestRef.current.onClipClick(e, track, clipId),
    onToggleCurve: (track, clipId, param) => latestRef.current.onToggleCurve(track, clipId, param),
  }));
  return actions;
}
