// Chroma — agent activity feed + `request_human` handoff (D-032).
//
// A running, newest-first record of every grade change the grading agent made
// through the MCP / control bridge (D-020), plus the single-slot `request_human`
// hand-back. Kept separate from useEditorStore / useChromaStore so the fork diff
// stays localised (same rationale as useChromaStore — docs/08 D-003).
//
// Session-only: not persisted, not part of grade.json. See
// docs/notes/agent-activity-feed.md.
import { create } from 'zustand';
import { Adjustments } from '../utils/adjustments';

export interface FieldDiff {
  /** dotted path into the grade doc, e.g. `colorGrading.shadows.hue` or
   * `mask "Depth Haze".dehaze` */
  path: string;
  before: any;
  after: any;
}

export interface AgentActivityEntry {
  id: string;
  op: string;
  args: any;
  ts: number;
  /** human-readable one-liner ("primary: exposure +0.35, temp −8") */
  summary: string;
  /** transport frame when the op ran — context only, not part of the grade */
  frame: number | null;
  /** useEditorStore.historyIndex captured *before* the op — undo target */
  historyIndexBefore: number;
  /** full grade snapshot before the op — undo fallback + diff base */
  adjustmentsBefore: Adjustments;
  /** full grade snapshot after the op — diff target (history[] evicts at 50) */
  adjustmentsAfter: Adjustments;
  diff: FieldDiff[];
  /** true once this entry (or a newer one) has been reverted */
  undone: boolean;
}

export interface HumanRequest {
  reason: string;
  /** normalised 0..1, top-left origin; null when the agent gave no region */
  roi: { x: number; y: number; w: number; h: number } | null;
  ts: number;
  /** the user has acknowledged / resumed — the agent's next get_state sees this */
  cleared: boolean;
}

const MAX_ENTRIES = 50;

interface AgentState {
  activity: AgentActivityEntry[];
  pendingHumanRequest: HumanRequest | null;
  feedOpen: boolean;
  /** which shot's feed `activity` currently is (multi-shot session, D-033) */
  activeShotKey: string | null;
  /** parked feeds for the non-active shots, keyed by clip path */
  shotFeeds: Record<string, AgentActivityEntry[]>;

  recordActivity: (entry: AgentActivityEntry) => void;
  /** mark `id` and every *newer* (lower-index) entry as undone */
  markUndoneFrom: (id: string) => void;
  clearActivity: () => void;
  /** switch the visible feed to `key`'s shot: park the current feed, restore
   *  the target's (empty if unseen). `null` = no shot loaded. (D-033) */
  scopeToShot: (key: string | null) => void;

  postHumanRequest: (reason: string, roi: HumanRequest['roi']) => void;
  clearHumanRequest: () => void;
  setFeedOpen: (open: boolean) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  activity: [],
  pendingHumanRequest: null,
  feedOpen: true,
  activeShotKey: null,
  shotFeeds: {},

  recordActivity: (entry) =>
    set((s) => ({ activity: [entry, ...s.activity].slice(0, MAX_ENTRIES), feedOpen: true })),

  scopeToShot: (key) =>
    set((s) => {
      if (key === s.activeShotKey) return s;
      const shotFeeds = { ...s.shotFeeds };
      if (s.activeShotKey) shotFeeds[s.activeShotKey] = s.activity;
      const activity = key ? shotFeeds[key] ?? [] : [];
      if (key) delete shotFeeds[key];
      return { shotFeeds, activity, activeShotKey: key };
    }),

  markUndoneFrom: (id) =>
    set((s) => {
      const idx = s.activity.findIndex((e) => e.id === id);
      if (idx < 0) return s;
      return {
        activity: s.activity.map((e, i) => (i <= idx ? { ...e, undone: true } : e)),
      };
    }),

  clearActivity: () => set({ activity: [] }),

  postHumanRequest: (reason, roi) =>
    set({ pendingHumanRequest: { reason, roi, ts: Date.now(), cleared: false } }),

  clearHumanRequest: () =>
    set((s) => ({
      pendingHumanRequest: s.pendingHumanRequest
        ? { ...s.pendingHumanRequest, cleared: true }
        : null,
    })),

  setFeedOpen: (feedOpen) => set({ feedOpen }),
}));
