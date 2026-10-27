/**
 * @apelles/bridge — the beat-analysis binding and its session cache (D-413).
 *
 * What it is: the one typed call over `chroma_detect_beats` (Rust
 * `app/src-tauri/src/chroma/beats.rs` → `apelles_beat::source::analyze_file`)
 * plus a shared store of answers, keyed by (path, meter, tempo hint). Both the
 * Edit tab (beat lane, beat snapping, `editor_detect_beats`) and the Motion tab
 * (soundtrack beats, `motion_time_to_music`) read the grid through here, so a
 * person and an agent see the same beats and a file is asked about once per
 * session; the Rust side caches across sessions by content hash.
 *
 * What it does NOT do: analyse anything, or map beats onto clips or scenes
 * (`@apelles/beats` has the maths; each tab maps its own objects). A failed
 * analysis is remembered as an error until asked again with `force`.
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect } from 'react';
import type { FileBeats } from '@apelles/beats';
import { createSharedStore } from '@apelles/store';

export interface BeatQuery {
  path: string;
  meter?: number | null;
  tempoHintBpm?: number | null;
}

export type BeatEntry =
  | { state: 'running' }
  | { state: 'done'; beats: FileBeats }
  | { state: 'error'; error: string };

interface BeatStoreState {
  entries: Record<string, BeatEntry>;
  setEntry: (key: string, entry: BeatEntry) => void;
}

/** The session cache. A process-wide singleton (HMR-safe, D-358). */
export const useBeatStore = createSharedStore<BeatStoreState>('apelles.bridge.beats', (set) => ({
  entries: {},
  setEntry: (key, entry) => set((s) => ({ entries: { ...s.entries, [key]: entry } })),
}));

/** The cache key of one question. */
export function beatKey(q: BeatQuery): string {
  return JSON.stringify([q.path, q.meter ?? null, q.tempoHintBpm ?? null]);
}

/** In-flight requests, so two callers asking at once share one analysis. */
const inflight = new Map<string, Promise<FileBeats>>();

/** The beats of `q.path`: from this session's cache unless `force`, else from
 *  the backend (which answers from its own content-hash cache when it can). */
export function detectBeats(q: BeatQuery, force = false): Promise<FileBeats> {
  const key = beatKey(q);
  const cur = useBeatStore.getState().entries[key];
  if (!force && cur?.state === 'done') return Promise.resolve(cur.beats);
  const running = inflight.get(key);
  if (!force && running) return running;
  useBeatStore.getState().setEntry(key, { state: 'running' });
  const p = invoke<FileBeats>('chroma_detect_beats', {
    path: q.path,
    meter: q.meter ?? null,
    tempoHintBpm: q.tempoHintBpm ?? null,
    force,
  })
    .then((beats) => {
      useBeatStore.getState().setEntry(key, { state: 'done', beats });
      return beats;
    })
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      useBeatStore.getState().setEntry(key, { state: 'error', error });
      throw new Error(error);
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** The cached entry for `q`, or `undefined` when nothing was asked yet. */
export function beatEntry(q: BeatQuery): BeatEntry | undefined {
  return useBeatStore.getState().entries[beatKey(q)];
}

/** React: the entry for `q` (or `null` for "nothing to analyse"), starting the
 *  analysis the first time it is asked for. Re-renders when it lands. */
export function useBeats(q: BeatQuery | null): BeatEntry | undefined {
  const key = q ? beatKey(q) : null;
  const entry = useBeatStore((s) => (key ? s.entries[key] : undefined));
  const path = q?.path ?? null;
  const meter = q?.meter ?? null;
  const hint = q?.tempoHintBpm ?? null;
  useEffect(() => {
    if (path === null) return;
    const q2: BeatQuery = { path, meter, tempoHintBpm: hint };
    if (beatEntry(q2) === undefined) {
      // The rejection is already recorded in the store as an `error` entry.
      detectBeats(q2).catch(() => undefined);
    }
  }, [path, meter, hint]);
  return entry;
}
