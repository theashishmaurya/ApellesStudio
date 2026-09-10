// Apelles — the agent activity feed + `request_human` banner (D-032),
// **shell-level and cross-tab since D-295**.
//
// A fixed bottom-left dock, injected into `@apelles/shell`'s `overlay` slot by
// `Root.tsx` — it was mounted inside `App.tsx` (the Colorist tab) until D-295,
// which made a feed of what an agent is doing to the whole project visible
// from only one of the three tabs.
// - top card: the `request_human` hand-back banner (reason + "Resume agent")
// - bottom card: a newest-first list of what the agent has done, merged from
//   two sources:
//     * **Colorist grade changes** (D-032, `useAgentStore`) — the rich rows:
//       an expandable per-field diff and a jump-to-here "Undo".
//     * **Edit / Motion ops** (D-295, `@apelles/history` entries stamped
//       `source: 'agent'` by `runAsAgent` around each tab's MCP dispatcher) —
//       label, tab and time. Deliberately NO per-row undo: those live on the
//       shared LIFO undo stack, where undoing an entry that is not on top
//       would corrupt it. Cmd/Ctrl+Z is the correct control for them, and it
//       is already global (D-051).
//   Colorist rows are read from `useAgentStore` rather than from the shared
//   stack (which the D-051 bridge also pushes them onto) so the diff and the
//   jump-to-here undo survive; the shared-stack side filters
//   `tab !== 'colorist'` so nothing is listed twice.
//
// Hidden entirely when there's no activity and no pending request. Styling
// follows the sibling ColoristTransport (plain elements + the app's colour tokens).
// See docs/notes/agent-activity-feed.md.
import { useState } from 'react';
import { ChevronDown, ChevronRight, Undo2, Trash2, UserRound, X } from 'lucide-react';

import { useHistoryStore, type HistoryEntry } from '@apelles/history';

import { useAgentStore, AgentActivityEntry } from '../../store/useAgentStore';
import { restoreEditorHistorySnapshot } from '../../utils/editorHistorySnapshot';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function fmtCell(v: any): string {
  if (v == null) return '—';
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  return String(v);
}

/** Undo an op: jump the grade back to the state before it ran, and mark this
 * entry + every newer one undone (they built on this op's result). The
 * restore itself (fast-path history jump, or a snapshot-restore fallback if
 * the pre-op state scrolled off the 50-slot history stack) is shared with
 * the D-051 Colorist→shared-history bridge — see `editorHistorySnapshot.ts`. */
function undoEntry(entry: AgentActivityEntry) {
  restoreEditorHistorySnapshot(entry.historyIndexBefore, entry.adjustmentsBefore);
  useAgentStore.getState().markUndoneFrom(entry.id);
}

function RequestHumanBanner() {
  const req = useAgentStore((s) => s.pendingHumanRequest);
  const clear = useAgentStore((s) => s.clearHumanRequest);
  if (!req || req.cleared) return null;

  return (
    <div className="rounded-lg border border-amber-500/60 bg-amber-500/10 shadow-2xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <UserRound size={14} className="text-amber-400 shrink-0" />
        <span className="text-xs font-semibold text-text-primary">The agent is asking for you</span>
      </div>
      <p className="text-xs text-text-secondary leading-snug">{req.reason}</p>
      {req.roi && <p className="text-[10px] text-text-secondary">A region is highlighted on the canvas.</p>}
      <button
        onClick={clear}
        className="self-start mt-0.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-500 text-black hover:bg-amber-400"
      >
        Resume agent
      </button>
    </div>
  );
}

function DiffTable({ diff }: { diff: AgentActivityEntry['diff'] }) {
  if (diff.length === 0) return null;
  return (
    <div className="mt-1.5 rounded-md bg-bg-primary/60 border border-border-color overflow-hidden">
      {diff.slice(0, 40).map((d, i) => (
        <div
          key={i}
          className="flex items-baseline gap-2 px-2 py-1 text-[11px] border-b border-border-color last:border-b-0"
        >
          <span className="text-text-secondary shrink-0 max-w-[45%] truncate" title={d.path}>
            {d.path}
          </span>
          <span className="text-text-secondary/70 tabular-nums truncate" title={fmtCell(d.before)}>
            {fmtCell(d.before)}
          </span>
          <span className="text-text-secondary/50">→</span>
          <span className="text-text-primary tabular-nums truncate" title={fmtCell(d.after)}>
            {fmtCell(d.after)}
          </span>
        </div>
      ))}
      {diff.length > 40 && (
        <div className="px-2 py-1 text-[10px] text-text-secondary">+{diff.length - 40} more fields</div>
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: AgentActivityEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`px-2.5 py-2 border-b border-border-color last:border-b-0 ${entry.undone ? 'opacity-45' : ''}`}>
      <div className="flex items-start gap-1.5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 text-text-secondary hover:text-text-primary shrink-0"
          title={open ? 'Collapse' : 'Show diff'}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <div className="min-w-0 flex-1">
          <span
            className={`block text-xs font-medium text-text-primary truncate ${entry.undone ? 'line-through' : ''}`}
          >
            {entry.summary}
          </span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-text-secondary">{timeAgo(entry.ts)}</span>
            {entry.frame != null && <span className="text-[10px] text-text-secondary">· frame {entry.frame}</span>}
            <span className="text-[10px] text-text-secondary/60">· {entry.op}</span>
          </div>
        </div>
        <button
          onClick={() => undoEntry(entry)}
          disabled={entry.undone}
          className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
          title="Revert to before this change (drops newer feed entries)"
        >
          <Undo2 size={11} />
          Undo
        </button>
      </div>
      {open && <DiffTable diff={entry.diff} />}
    </div>
  );
}

/** D-295 — one Edit/Motion op an agent performed, read off the shared
 *  `@apelles/history` stack. No diff and no per-row Undo: see this file's
 *  module doc for why (the shared stack is LIFO; Cmd/Ctrl+Z is its control). */
function TabActivityRow({ entry }: { entry: HistoryEntry }) {
  return (
    <div className="px-2.5 py-2 border-b border-border-color last:border-b-0">
      <div className="flex items-start gap-1.5">
        {/* aligns with `ActivityRow`'s disclosure chevron, which this row has
            no use for — there is nothing to expand. */}
        <span className="mt-0.5 w-[13px] shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-text-primary truncate">{entry.label}</span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-text-secondary">{timeAgo(entry.ts)}</span>
            <span className="text-[10px] text-text-secondary/60">· {entry.tab}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AgentActivityDock() {
  const activity = useAgentStore((s) => s.activity);
  const feedOpen = useAgentStore((s) => s.feedOpen);
  const setFeedOpen = useAgentStore((s) => s.setFeedOpen);
  const clearActivity = useAgentStore((s) => s.clearActivity);
  const pending = useAgentStore((s) => s.pendingHumanRequest);
  // D-295 — the Edit/Motion half. `tab !== 'colorist'` because the D-051
  // bridge pushes Colorist grade edits onto this same stack, and those are
  // already listed (with their diff and their undo) from `useAgentStore`.
  const undoStack = useHistoryStore((s) => s.undoStack);
  const tabActivity = undoStack.filter((e) => e.source === 'agent' && e.tab !== 'colorist');

  // One list, newest first, over both sources — an agent's work is one
  // sequence of actions, and splitting it by which tab it touched would make
  // "what just happened?" two questions instead of one.
  const rows = [
    ...activity.map((e) => ({ ts: e.ts, key: `c-${e.id}`, node: <ActivityRow key={`c-${e.id}`} entry={e} /> })),
    ...tabActivity.map((e) => ({ ts: e.ts, key: `h-${e.id}`, node: <TabActivityRow key={`h-${e.id}`} entry={e} /> })),
  ].sort((a, b) => b.ts - a.ts);

  const showBanner = !!pending && !pending.cleared;
  if (rows.length === 0 && !showBanner) return null;

  return (
    <div className="fixed left-3 bottom-3 z-40 w-[340px] max-w-[calc(100vw-24px)] flex flex-col gap-2">
      {showBanner && <RequestHumanBanner />}

      {rows.length > 0 && (
        <div className="rounded-lg border border-border-color bg-surface shadow-2xl overflow-hidden flex flex-col max-h-[45vh]">
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border-color shrink-0">
            <button
              onClick={() => setFeedOpen(!feedOpen)}
              className="flex items-center gap-1.5 text-text-primary hover:text-accent"
            >
              {feedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="text-xs font-semibold">Agent activity</span>
            </button>
            <span className="text-[10px] text-text-secondary tabular-nums">{rows.length}</span>
            <div className="flex-1" />
            <button
              onClick={clearActivity}
              className="text-text-secondary hover:text-text-primary p-0.5"
              // D-295 — clears the Colorist half only. The Edit/Motion rows
              // come off the shared UNDO stack, and clearing that to tidy a
              // feed would throw away real undo history — a far worse trade
              // than a feed that still lists them.
              title="Clear the grade feed (does not revert anything, and leaves Edit/Motion undo history alone)"
            >
              <Trash2 size={12} />
            </button>
            <button
              onClick={() => setFeedOpen(false)}
              className="text-text-secondary hover:text-text-primary p-0.5"
              title="Hide"
            >
              <X size={12} />
            </button>
          </div>

          {feedOpen && (
            <div className="overflow-y-auto custom-scrollbar min-h-0">
              {rows.map((r) => r.node)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
