/**
 * `@apelles/editor` — the deterministic retake detector, behind D-380's
 * coverage gate (D-382).
 *
 * **What it is.** The one step both `editor_detect_retakes` and the Recut
 * panel's Retakes button take after `chroma_detect_retakes` answers: each
 * group's takes (source seconds) are handed to `chroma_gate_detected_retakes`,
 * which maps them onto the track's word view by word midpoint and runs the
 * same gate a client's proposal goes through. A group comes back `verified`
 * or `refused` (with its reason and the words its cut would lose) — the same
 * status vocabulary, and the same panel treatment, as an MCP client's group.
 *
 * **Why.** The detector over-cuts (B-246, measured by D-378's eval: 40.24 s of
 * unique speech on the Parakeet corpus); the gate refuses every one of those
 * groups (D-380 §11.4). The detector is unchanged — this only stops an unsafe
 * group reaching a person as tickable.
 *
 * **What it does NOT do.** No detection, no word rules of its own (the
 * mapping and the gate are `apelles_speech::proposal`'s, in Rust), no React,
 * and nothing destructive.
 */

import { invoke } from '@tauri-apps/api/core';

import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { groupTakes, type RetakeGroupWire } from './recut';
import type { ProposalWord } from './retakeProposals';
import { buildWordViewInput, wireViewArgs } from './retakeWordView';
import type { Timeline } from './timeline';

/** One detector group, as much of it as the gate needs. */
export interface DetectedGroupForGate {
  keep: number;
  takes: Array<{ startSecs: number; endSecs: number }>;
}

/** A detection's groups in the shape the gate takes: each delivery's span
 *  (`groupTakes` — a take can span several utterances since D-327) and the
 *  suggested keep. The panel and the MCP op both go through this, so they
 *  gate identical input. */
export function detectedForGate(groups: readonly RetakeGroupWire[]): DetectedGroupForGate[] {
  return groups.map((g) => ({
    keep: g.keep,
    takes: groupTakes(g).map((t) => ({ startSecs: t.startSecs, endSecs: t.endSecs })),
  }));
}

/** The gate's answer for one detector group. */
export interface DetectorGateResult {
  status: 'verified' | 'refused';
  /** Refused: the reason as the crate names it (`unmapped` when the group's
   *  takes could not be placed on the track's words — unchecked, so refused). */
  reason?: { kind: string; group?: number };
  reasonText?: string;
  /** Refused: the words the cut would lose. */
  offending: ProposalWord[];
  /** Per detector take, its words (empty when a take holds none). */
  takeWords: ProposalWord[][];
  /** A content refusal — a person who listened may still choose to cut it. */
  unlockable: boolean;
}

type GateWire = {
  groups: Array<{
    verdict: 'accepted' | 'refused' | 'unmapped';
    takeWords: Array<ProposalWord[] | null>;
    reason?: { kind: string; group?: number };
    reasonText?: string;
    offending?: ProposalWord[];
    waivable?: boolean;
  }>;
};

const UNCHECKED =
  'could not be placed on this track\'s words (no transcript, or no word inside a take), so it was not checked';

/** Every group refused as unchecked — what a gate that could not run means. */
function unchecked(groups: readonly DetectedGroupForGate[]): DetectorGateResult[] {
  return groups.map((g) => ({
    status: 'refused',
    reason: { kind: 'unmapped' },
    reasonText: UNCHECKED,
    offending: [],
    takeWords: g.takes.map(() => []),
    unlockable: true,
  }));
}

/**
 * Gate one detection's groups — all of them together, in the detector's order,
 * so cross-group conflicts are judged as they are for a client's set.
 *
 * `source` is the file the groups' seconds are in. A track whose view cannot
 * be built, or a source not on it, gates nothing: every group comes back
 * refused as unchecked rather than verified by default (D-318's direction).
 * An unchecked group stays unlockable — the person can still listen and cut it,
 * as they always could.
 */
export async function gateDetectorGroups(
  tl: Timeline,
  track: number,
  source: string,
  groups: readonly DetectedGroupForGate[],
): Promise<DetectorGateResult[]> {
  if (groups.length === 0) return [];
  const st = useMediaUnderstandingStore.getState();
  const input = buildWordViewInput(tl, track, st.transcripts, st.recoveriesFor, st.transcriptErrors);
  if ('error' in input) return unchecked(groups);
  const sourceIndex = input.sources.findIndex((s) => s.path === source);
  if (sourceIndex < 0) return unchecked(groups);

  let answer: GateWire;
  try {
    answer = await invoke<GateWire>('chroma_gate_detected_retakes', {
      ...wireViewArgs(input),
      groups: groups.map((g) => ({ source: sourceIndex, keep: g.keep, takes: g.takes })),
    });
  } catch {
    // A gate that failed to run verified nothing.
    return unchecked(groups);
  }
  return groups.map((g, i) => {
    const v = answer.groups[i];
    const takeWords = g.takes.map((_, ti) => v?.takeWords?.[ti] ?? []);
    if (v?.verdict === 'accepted') {
      return { status: 'verified', offending: [], takeWords, unlockable: false };
    }
    if (v?.verdict === 'refused') {
      return {
        status: 'refused',
        reason: v.reason,
        reasonText: v.reasonText,
        offending: v.offending ?? [],
        takeWords,
        unlockable: !!v.waivable,
      };
    }
    return { ...unchecked([g])[0], takeWords };
  });
}
