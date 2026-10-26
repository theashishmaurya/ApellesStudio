/**
 * @apelles/editor — the Edit timeline's write-ahead journal (B-274, D-402).
 *
 * **What it is.** Every change the timeline store makes to the active timeline
 * (an `applyOp`, an undo/redo snapshot) is appended to `<project>/edit-journal
 * .jsonl` by the Rust side the moment it happens, numbered with a per-project
 * sequence. The debounced `chroma_timeline_set` save then tells the backend
 * which sequence number the saved timeline includes (`journalSeq`), which the
 * manifest records atomically with the timeline itself. So at any moment
 * `project.json` plus the journal entries numbered after its recorded sequence
 * IS the timeline the store held.
 *
 * **Why.** macOS replaces the WKWebView's web content process under memory
 * pressure, with no `pagehide` and no chance to run anything (B-274). Whatever
 * sat on the ~400 ms save debounce died with it. A journal append leaves the
 * page as an IPC message the moment the edit is made, and the Rust process
 * (which outlives the web process) writes it; the window left is the time to
 * post one message, not 400 ms of edits.
 *
 * **What this module does.** The entry shape, and [`replayJournal`]: the pure
 * fold a freshly loaded page uses to bring the persisted timeline back up to
 * the last edit. Ops replay through the same pure `applyOp` the store applies
 * them with, so a replayed edit is the edit, not a re-derivation of it.
 *
 * **What it does NOT do.** No I/O (the store owns the two Tauri calls), and it
 * journals only the Edit timeline. The media pool, the Colorist grade and the
 * Motion manifest have their own persistence and are not covered. An OS crash
 * or power loss can still lose journal lines the kernel had not flushed: the
 * threat this answers is a process dying, not the machine.
 */
import { applyOp as applyOpPure, type EditOp, type Timeline } from './timeline';

/** One journal line. `seq` is per project and strictly increasing across page
 *  loads (a new page continues from the highest number it finds). `timelineId`
 *  scopes the entry to the timeline it was made on, so an entry is never
 *  replayed onto a different one after a switch. */
export type EditJournalEntry =
  | { seq: number; timelineId: string; kind: 'op'; op: EditOp }
  | { seq: number; timelineId: string; kind: 'snapshot'; timeline: Timeline };

/** What `chroma_edit_journal_read` answers: the sequence the persisted
 *  manifest records as included (`null` for a project never saved with one),
 *  and every parseable entry still on disk, in any order. */
export interface EditJournalState {
  savedSeq: number | null;
  entries: EditJournalEntry[];
}

export interface ReplayOutcome {
  timeline: Timeline;
  /** entries that changed the timeline */
  applied: number;
  /** entries for this timeline that no longer apply (the reducer refused
   *  them); counted so a caller can say so rather than hide it */
  skipped: number;
  /** the highest sequence number seen anywhere in the journal or the
   *  manifest: where this page's own numbering continues from */
  lastSeq: number;
}

/** Whether `value` is shaped like a journal entry. The journal is our own
 *  file, but it is read back from disk after a crash, so a malformed line is
 *  dropped rather than trusted. */
export function isJournalEntry(value: unknown): value is EditJournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 1) return false;
  if (typeof v.timelineId !== 'string') return false;
  if (v.kind === 'op') return typeof v.op === 'object' && v.op !== null;
  if (v.kind === 'snapshot') return typeof v.timeline === 'object' && v.timeline !== null;
  return false;
}

/** Bring `base` (the persisted active timeline) up to the last journalled edit.
 *  Only entries for `base`'s own timeline numbered after `savedSeq` apply, in
 *  sequence order; a snapshot replaces the timeline, an op goes through the
 *  pure reducer. Pure: `base` is never mutated. */
export function replayJournal(base: Timeline, state: EditJournalState): ReplayOutcome {
  const saved = state.savedSeq ?? 0;
  let lastSeq = saved;
  for (const e of state.entries) lastSeq = Math.max(lastSeq, e.seq);
  const pending = state.entries
    .filter((e) => e.seq > saved && e.timelineId === base.id)
    .sort((a, b) => a.seq - b.seq);
  let timeline = base;
  let applied = 0;
  let skipped = 0;
  for (const e of pending) {
    if (e.kind === 'snapshot') {
      timeline = e.timeline;
      applied += 1;
      continue;
    }
    const next = applyOpPure(timeline, e.op);
    if (next === timeline) {
      skipped += 1;
      continue;
    }
    timeline = next;
    applied += 1;
  }
  return { timeline, applied, skipped, lastSeq };
}
