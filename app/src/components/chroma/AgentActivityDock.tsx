// Chroma — the agent activity feed + `request_human` banner (D-032).
//
// A fixed bottom-left dock, mounted once in App.tsx next to useChromaControl().
// - top card: the `request_human` hand-back banner (reason + "Resume agent")
// - bottom card: a newest-first list of every grade change the agent made
//   through the MCP / control bridge, each with an expandable per-field diff
//   and a jump-to-here "Undo".
//
// Hidden entirely when there's no activity and no pending request. Styling
// follows the sibling ChromaTimeline (plain elements + the app's colour tokens).
// See docs/notes/agent-activity-feed.md.
import { useState } from 'react';
import { ChevronDown, ChevronRight, Undo2, Trash2, UserRound, X } from 'lucide-react';

import { useAgentStore, AgentActivityEntry } from '../../store/useAgentStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useChromaStore } from '../../store/useChromaStore';

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
 * entry + every newer one undone (they built on this op's result). */
function undoEntry(entry: AgentActivityEntry) {
  const ed = useEditorStore.getState();
  const target = entry.historyIndexBefore;
  const hist = ed.history;

  let jumped = false;
  try {
    if (
      target >= 0 &&
      target < hist.length &&
      JSON.stringify(hist[target]) === JSON.stringify(entry.adjustmentsBefore)
    ) {
      ed.goToHistoryIndex(target);
      jumped = true;
    }
  } catch {
    /* fall through to snapshot restore */
  }
  if (!jumped) {
    // the pre-op state scrolled off the 50-slot history stack — restore the
    // snapshot as a new forward edit (docs/notes/agent-activity-feed.md).
    ed.setEditor({ adjustments: entry.adjustmentsBefore });
    ed.pushHistory(entry.adjustmentsBefore);
  }
  useChromaStore.getState().bumpFrameNonce();
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

export default function AgentActivityDock() {
  const activity = useAgentStore((s) => s.activity);
  const feedOpen = useAgentStore((s) => s.feedOpen);
  const setFeedOpen = useAgentStore((s) => s.setFeedOpen);
  const clearActivity = useAgentStore((s) => s.clearActivity);
  const pending = useAgentStore((s) => s.pendingHumanRequest);

  const showBanner = !!pending && !pending.cleared;
  if (activity.length === 0 && !showBanner) return null;

  return (
    <div className="fixed left-3 bottom-3 z-40 w-[340px] max-w-[calc(100vw-24px)] flex flex-col gap-2">
      {showBanner && <RequestHumanBanner />}

      {activity.length > 0 && (
        <div className="rounded-lg border border-border-color bg-surface shadow-2xl overflow-hidden flex flex-col max-h-[45vh]">
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border-color shrink-0">
            <button
              onClick={() => setFeedOpen(!feedOpen)}
              className="flex items-center gap-1.5 text-text-primary hover:text-accent"
            >
              {feedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="text-xs font-semibold">Agent activity</span>
            </button>
            <span className="text-[10px] text-text-secondary tabular-nums">{activity.length}</span>
            <div className="flex-1" />
            <button
              onClick={clearActivity}
              className="text-text-secondary hover:text-text-primary p-0.5"
              title="Clear the feed (does not revert any grade)"
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
              {activity.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
