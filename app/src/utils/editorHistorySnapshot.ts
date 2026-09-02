// Chroma — shared "restore a grade snapshot" primitive (D-032 / D-051).
//
// Both the D-032 agent-activity feed's jump-to-here undo
// (`AgentActivityDock.tsx`) and the D-051 Colorist→shared-history bridge
// (`coloristHistoryBridge.ts`) need the same operation: put
// `useEditorStore.adjustments` back to a specific historical value. The fast
// path is a real `goToHistoryIndex` jump (keeps the local Colorist history
// slider/index correct); the documented fallback (originally D-032, kept
// verbatim) is a plain `setEditor` + `pushHistory` of the snapshot itself
// when the target has scrolled off the 50-slot `history[]` stack — which
// happens, since neither caller knows or controls what else has been edited
// since the snapshot was taken.
//
// Extracted from `AgentActivityDock.tsx`'s `undoEntry` (D-051) so the two
// callers share one implementation instead of drifting. Not folded into
// `agentActivity.ts` — that file is explicitly "no store, no side effects",
// this function is neither.
import { useEditorStore } from '../store/useEditorStore';
import { useChromaStore } from '../store/useChromaStore';
import { Adjustments } from './adjustments';

/**
 * Restore `snapshot` to `useEditorStore.adjustments`.
 *
 * `targetIndex` is a best-effort hint — the index `snapshot` sat at in
 * `history[]` at the moment it was captured — used only if
 * `history[targetIndex]` still deep-equals `snapshot` (nothing has pushed it
 * off the stack since). Otherwise falls back to a plain set + forward push
 * of the snapshot. Always bumps the frame nonce so the preview re-renders
 * (this bypasses the normal edit path that would otherwise trigger it).
 */
export function restoreEditorHistorySnapshot(targetIndex: number, snapshot: Adjustments): void {
  const ed = useEditorStore.getState();
  const hist = ed.history;

  let jumped = false;
  try {
    if (
      targetIndex >= 0 &&
      targetIndex < hist.length &&
      JSON.stringify(hist[targetIndex]) === JSON.stringify(snapshot)
    ) {
      ed.goToHistoryIndex(targetIndex);
      jumped = true;
    }
  } catch {
    /* fall through to snapshot restore */
  }
  if (!jumped) {
    // the target state scrolled off the 50-slot history stack — restore the
    // snapshot as a new forward edit (docs/notes/agent-activity-feed.md).
    ed.setEditor({ adjustments: snapshot });
    ed.pushHistory(snapshot);
  }
  useChromaStore.getState().bumpFrameNonce();
}
