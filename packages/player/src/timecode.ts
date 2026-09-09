/**
 * `fmtTimecode` — single source of truth for the `HH:MM:SS:FF` readout used by
 * every `<Player>` transport bar. Moved here from `@apelles/editor`'s
 * `PreviewPane.tsx` (D-039 roadmap "Next" item 1) — `@apelles/editor` now
 * imports it from here instead of keeping its own copy.
 */
export function fmtTimecode(frame: number, fps?: number): string {
  // no fps (or a non-positive one) → frame counter only, per the Player prop
  // contract ("fps omitted → frame counter only"). Also the safe fallback for
  // a caller passing 0/NaN before its source is ready.
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) {
    return `f${Math.round(frame)}`;
  }
  const totalSecs = frame / fps;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  const f = Math.round(frame % fps);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}
