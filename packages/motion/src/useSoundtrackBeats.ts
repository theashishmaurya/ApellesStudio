/**
 * @apelles/motion — React: the open document's soundtrack beats (D-413).
 *
 * Resolves the soundtrack's asset file in the project's asset folder and reads
 * its analysis through `@apelles/bridge`'s shared, cached `useBeats` — the same
 * cache `motion_get_beats` / `motion_time_to_music` fill through
 * `manifestIO.soundtrackBeats`, so the GUI and the ops never analyse twice.
 */
import { useEffect, useState } from 'react';
import type { BeatAnalysis } from '@apelles/beats';
import { useBeats } from '@apelles/bridge';
import { assetFileName } from '@apelles/motion-engine/src/lib/assetId';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { getAssetsDir } from './manifestIO';

export type SoundtrackBeatsView =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; analysis: BeatAnalysis }
  | { status: 'error'; error: string };

export function useSoundtrackBeats(manifest: Manifest | null): SoundtrackBeatsView {
  const st = manifest?.soundtrack;
  const [dir, setDir] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const hasSoundtrack = st !== undefined;
  useEffect(() => {
    if (!hasSoundtrack) return;
    let live = true;
    getAssetsDir().then(
      (d) => {
        if (live) setDir(d);
      },
      (e: unknown) => {
        if (live) setDirError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [hasSoundtrack]);
  const entry = useBeats(
    st && dir
      ? {
          path: `${dir.replace(/[\\/]+$/, '')}/${assetFileName(st.src)}`,
          meter: st.meter ?? null,
          tempoHintBpm: st.tempoHint ?? null,
        }
      : null,
  );
  if (!st) return { status: 'none' };
  if (dirError) return { status: 'error', error: dirError };
  if (!entry || entry.state === 'running') return { status: 'loading' };
  if (entry.state === 'error') return { status: 'error', error: entry.error };
  return { status: 'ready', analysis: entry.beats.analysis };
}
