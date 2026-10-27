/**
 * `@apelles/editor` — React: the open timeline's beat grid, analysed on
 * demand (D-413).
 *
 * Reads the grid track's files through `@apelles/bridge`'s shared beat store
 * (starting any analysis not yet asked for) and places the answers on the
 * timeline with `beatGrid.ts`'s `timelineBeats`, the same function the MCP ops
 * call. Re-renders when an analysis lands; nothing is recomputed while the
 * timeline and the store are unchanged.
 */
import { useEffect, useMemo } from 'react';
import { beatEntry, beatKey, detectBeats, useBeatStore } from '@apelles/bridge';
import type { FileBeats } from '@apelles/beats';
import { gridQueries, gridTrackIndex, timelineBeats, type TimelineBeat } from './beatGrid';
import type { Timeline } from './timeline';

export interface TimelineBeatsView {
  /** The grid track, or `null` when no track has its beats shown. */
  track: number | null;
  beats: TimelineBeat[];
  /** Files still being analysed. */
  pending: string[];
  /** Files whose analysis failed, with the reason. */
  errors: Array<{ path: string; error: string }>;
  /** Tempo of the first analysed file, for the readout (0 when none). */
  tempoBpm: number;
}

const EMPTY: TimelineBeatsView = { track: null, beats: [], pending: [], errors: [], tempoBpm: 0 };

export function useTimelineBeats(tl: Timeline | null): TimelineBeatsView {
  const queries = useMemo(() => {
    const t = gridTrackIndex(tl);
    return t === null || !tl ? [] : gridQueries(tl.tracks[t]);
  }, [tl]);
  const entries = useBeatStore((s) => s.entries);

  useEffect(() => {
    // A rejection is recorded in the store as an `error` entry, shown below.
    for (const q of queries) {
      if (beatEntry(q) === undefined) detectBeats(q).catch(() => undefined);
    }
  }, [queries]);

  return useMemo(() => {
    if (!tl || queries.length === 0) return EMPTY;
    const byPath = new Map<string, FileBeats>();
    const errors: Array<{ path: string; error: string }> = [];
    for (const q of queries) {
      const e = entries[beatKey(q)];
      if (e?.state === 'done') byPath.set(q.path, e.beats);
      else if (e?.state === 'error') errors.push({ path: q.path, error: e.error });
    }
    const placed = timelineBeats(tl, (p) => byPath.get(p));
    const failed = new Set(errors.map((e) => e.path));
    const first = [...byPath.values()][0];
    return {
      track: placed.track,
      beats: placed.beats,
      pending: placed.pending.filter((p) => !failed.has(p)),
      errors,
      tempoBpm: first?.analysis.tempoBpm ?? 0,
    };
  }, [tl, queries, entries]);
}
