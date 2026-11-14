/**
 * @apelles/editor — the lanes' stable action object (D-437 S3a, plan §2.2).
 *
 * What it is: the `LaneActions` shape, bound to the generic fixed-identity
 * forwarder `useStableActions` (B-377/D-461 generalised this hook's own
 * mechanism, which the toolbar and the track headers now share): ONE object
 * whose identity never changes, so a memoised `LaneClip` that receives it as a
 * prop is not re-rendered when the pane re-renders.
 *
 * What it does NOT do: decide what a click or a press means — that stays in the
 * pane's handlers (selection rules, the edit-gesture claim, the curve lane).
 */
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ClipKeyframeParam } from '../timeline';
import { useStableActions } from '../useStableActions';

/** What a lane clip can ask the pane to do. */
export type LaneActions = {
  /** `useEditGesture`'s press handler: runs in the capture phase, before dnd-kit's. */
  onClipPointerDownCapture: (e: ReactPointerEvent<HTMLDivElement>, track: number, clipId: string) => void;
  /** A click on the clip's slot: selection (plain / Shift range / Cmd toggle). */
  onClipClick: (e: ReactMouseEvent<HTMLElement>, track: number, clipId: string) => void;
  /** The keyframes badge: open the curve lane on `param`, or `null` to close it. */
  onToggleCurve: (track: number, clipId: string, param: ClipKeyframeParam | null) => void;
};

/** A `LaneActions` with a permanent identity that forwards to `latest`. */
export function useLaneActions(latest: LaneActions): LaneActions {
  return useStableActions(latest);
}
