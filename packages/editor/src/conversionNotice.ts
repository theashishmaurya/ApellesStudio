/**
 * @apelles/editor — which sources under the playhead cannot be shown yet
 * because their conversion to optimized media has not finished (D-453).
 *
 * What it is: a pure function over the store's data — the timeline, the
 * playhead and the media pool — so the preview can say "converting
 * `clip.mkv`, 42%" instead of showing black or a raw decode error, and so the
 * same answer is available to anything else that needs it.
 *
 * What it does NOT do: ask the backend anything, or decide what converting
 * means (`@apelles/bridge`'s `awaitsConversion` does; the pool item's
 * `conversion` is the backend's live answer).
 */
import { awaitsConversion, type MediaConversion, type MediaItem } from '@apelles/bridge';

import { clipAt, timelineFps, type Timeline } from './timeline';

/** One source under the playhead that is still converting (or failed to). */
export interface PendingConversion {
  /** The pool item, for a Cancel or a re-probe. */
  mediaId: string;
  name: string;
  sourcePath: string;
  conversion: MediaConversion;
}

/** The sources on visible video tracks at `frame` whose conversion is not
 *  `ready`, one entry per source, in track order (the topmost first). Empty —
 *  and cheap: one pass over the pool — when nothing in the pool awaits one. */
export function conversionsAt(tl: Timeline | null, frame: number, items: readonly MediaItem[]): PendingConversion[] {
  if (!tl) return [];
  const waiting = new Map<string, MediaItem>();
  for (const it of items) {
    if (awaitsConversion(it)) waiting.set(it.sourcePath, it);
  }
  if (waiting.size === 0) return [];
  const fps = timelineFps(tl);
  const out: PendingConversion[] = [];
  const seen = new Set<string>();
  for (const track of tl.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    const hit = clipAt(track, frame, fps);
    const path = hit?.clip.source_path;
    if (!path || seen.has(path)) continue;
    const item = waiting.get(path);
    if (!item?.conversion) continue;
    seen.add(path);
    out.push({ mediaId: item.id, name: item.name, sourcePath: path, conversion: item.conversion });
  }
  return out;
}

/** A stable key for `conversionsAt`'s answer, so a store selector re-renders
 *  its subscriber only when what it would show changes (a playhead tick that
 *  stays inside the same clips changes nothing). */
export function conversionsKey(pending: readonly PendingConversion[]): string {
  return pending
    .map((p) => `${p.mediaId}:${p.conversion.state}:${Math.floor(p.conversion.progress * 100)}`)
    .join('|');
}
