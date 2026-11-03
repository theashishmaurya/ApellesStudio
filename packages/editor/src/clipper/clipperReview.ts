/**
 * `@apelles/editor` — the Clipper review's actions and its keys (D-445, B-363).
 *
 * **What it is.** The few things a person does while reviewing shorts, shared by
 * the list in the browser and the review surface in the viewer area:
 * {@link reviewShort} (Approve / Skip, and back to "to review" when pressed
 * again — the same `setClipProposal` status write `editor_set_clip_proposal`
 * makes), {@link moveReview} (the previous / next short), and
 * {@link onClipperReviewKey}: A approves, X skips, ↑ / ↓ move. The keys belong
 * to the Clipper while focus is inside it: the handler calls `preventDefault`,
 * which the app's one shortcut dispatcher (`@apelles/keymap`) treats as "taken"
 * — so ↑ / ↓ stay the timeline's previous / next edit point everywhere else.
 *
 * **What it does NOT do.** Judge, build or render anything (`clipperOps.ts`).
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { setClipProposal } from './clipperOps';
import { useClipperStore } from './clipperStore';
import type { ClipRun } from './clipperTypes';

type Notify = (n: { ok: boolean; message: string }) => void;

/** The run under review and the selected short (the first one when nothing is
 *  selected yet). */
export function reviewTarget(): { run: ClipRun; id: string } | null {
  const s = useClipperStore.getState();
  const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
  if (!run || run.proposals.length === 0) return null;
  const id = s.selectedProposalId && run.proposals.some((p) => p.id === s.selectedProposalId) ? s.selectedProposalId : run.proposals[0].id;
  return { run, id };
}

/** Select the short `delta` places from the current one (clamped). */
export function moveReview(delta: number): void {
  const t = reviewTarget();
  if (!t) return;
  const i = t.run.proposals.findIndex((p) => p.id === t.id);
  const next = t.run.proposals[Math.max(0, Math.min(t.run.proposals.length - 1, i + delta))];
  if (next) useClipperStore.getState().selectProposal(next.id);
}

/**
 * Approve or skip short `id`; pressing the same again puts it back to review.
 * After a decision the next short still to review is selected, the way a
 * review board moves on.
 */
export async function reviewShort(run: ClipRun, id: string, action: 'approve' | 'skip', notify: Notify): Promise<void> {
  const p = run.proposals.find((x) => x.id === id);
  if (!p) return;
  if (p.status === 'built') {
    notify({ ok: false, message: 'This short is made already; open it from its card.' });
    return;
  }
  const target = action === 'approve' ? 'accepted' : 'rejected';
  if (target === 'accepted' && p.verdict.verdict === 'refused' && p.status !== 'accepted') {
    notify({ ok: false, message: 'This short needs a fix before it can be approved: move its start or end first.' });
    return;
  }
  const status = p.status === target ? 'pending' : target;
  const out = await setClipProposal({ runId: run.id, id, status });
  if ('error' in out) {
    notify({ ok: false, message: out.error });
    return;
  }
  if (status === 'pending') return;
  const fresh = useClipperStore.getState().runs[run.id] ?? run;
  const at = fresh.proposals.findIndex((x) => x.id === id);
  const after = [...fresh.proposals.slice(at + 1), ...fresh.proposals.slice(0, at)];
  const next = after.find((x) => x.status === 'pending');
  if (next) useClipperStore.getState().selectProposal(next.id);
}

/** True when the key is typed into a field rather than meant for the review. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** The review keys, for any element inside the Clipper (list or surface). */
export function onClipperReviewKey(e: ReactKeyboardEvent, notify: Notify): void {
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  const key = e.key.toLowerCase();
  if (key !== 'a' && key !== 'x' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const t = reviewTarget();
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'ArrowUp') return moveReview(-1);
  if (e.key === 'ArrowDown') return moveReview(1);
  void reviewShort(t.run, t.id, key === 'a' ? 'approve' : 'skip', notify);
}
