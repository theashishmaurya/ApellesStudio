import { useEffect } from 'react';

import { useEditorStore } from '../store/useEditorStore';
import { restoreEditorHistorySnapshot } from '../utils/editorHistorySnapshot';
import { diffAdjustments, summarizeActivity } from '../utils/agentActivity';
import { useHistoryStore } from '@apelles/history';

/**
 * D-051 — bridges the Colorist's pre-existing `useEditorStore` grade history
 * into the shared `@apelles/history` stack, WITHOUT touching `useEditorStore`
 * itself (its internals — `pushHistory`/`undo`/`redo`/`goToHistoryIndex` —
 * are unchanged; this only observes them). Mounted once in App.tsx next to
 * `useChromaControl()`/`useProjectAutosave()`.
 *
 * Distinguishing a genuine new edit ("push") from mere navigation
 * (undo/redo/goToHistoryIndex) or a fresh-image reset (`resetHistory`):
 *
 * - `pushHistory` always replaces `history` with a **new array** (`slice` +
 *   `push`, `.shift()` past the 50-cap) whose length is >= 2 (it appends to
 *   an array that had >= 1 element already).
 * - `undo`/`redo`/`goToHistoryIndex` only ever change `historyIndex` — same
 *   `history` array reference.
 * - `resetHistory` (loading a different image/shot) also replaces `history`
 *   with a new array, but always exactly `[initialState]` — length 1.
 *
 * So: `history` reference changed AND length >= 2 ⇒ a real push; reference
 * changed AND length === 1 ⇒ a reset (not a user edit — skipped, same as
 * D-032 not logging `seek`/`open`). Reference unchanged ⇒ pure navigation,
 * nothing to record (the shared-history entry the navigation is *for*, if
 * any, was already pushed when the edit itself happened).
 *
 * The "before" state for a push is `prevState.history[prevState.historyIndex]`
 * — the state the store was sitting on the instant before this push replaced
 * `history` — and zustand's `subscribe` hands us `prevState` directly, so no
 * manual index bookkeeping is needed.
 *
 * `undo()`/`redo()` on the pushed entry reuse the exact same snapshot-restore
 * primitive as the D-032 activity feed's jump-to-here undo
 * (`restoreEditorHistorySnapshot` — fast-path `goToHistoryIndex` jump, or a
 * fallback forward-push of the snapshot if it scrolled off the 50-slot
 * stack). `historyIndexBefore`/`historyIndexAfter` are captured at push time
 * as a fast-path hint only; they're allowed to go stale (further edits can
 * shift what's at that index, or shift it off the stack entirely) because
 * the fallback keys off a deep-equality check against the snapshot itself,
 * never off the index alone. Same documented limitation as D-032: if the
 * timeline branches (an edit after a local, non-shared undo/redo) an older
 * shared-history entry's "after" state may no longer be reachable by index —
 * its `undo()` still lands on a real, coherent prior state (the snapshot),
 * just not necessarily one still visible in the local history slider.
 */
export function useColoristHistoryBridge() {
  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe((state, prevState) => {
      if (state.history === prevState.history) return; // pure navigation
      if (state.history.length === 1) return; // resetHistory — new image, not an edit

      const beforeIndex = prevState.historyIndex;
      const afterIndex = state.historyIndex;
      const before = prevState.history[beforeIndex];
      const after = state.adjustments;
      if (before === undefined) return; // defensive — shouldn't happen, never push a broken entry

      const label = summarizeActivity('grade', before, after, diffAdjustments(before, after));

      useHistoryStore.getState().push({
        tab: 'colorist',
        label,
        undo: () => restoreEditorHistorySnapshot(beforeIndex, before),
        redo: () => restoreEditorHistorySnapshot(afterIndex, after),
      });
    });

    return unsubscribe;
  }, []);
}
