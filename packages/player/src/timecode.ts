/**
 * `fmtTimecode` — single source of truth for the `HH:MM:SS:FF` readout used by
 * every `<Player>` transport bar. Moved here from `@apelles/editor`'s
 * `PreviewPane.tsx` (D-039 roadmap "Next" item 1) — `@apelles/editor` now
 * imports it from here instead of keeping its own copy.
 *
 * D-328 added [`parseTimecode`], its inverse, when the marker popover needed a
 * timecode field the user can TYPE INTO rather than only read. It lives beside
 * `fmtTimecode` deliberately: a formatter and a parser that disagree about what
 * `00:00:04:12` means is the kind of bug that only shows up as a marker landing
 * on the wrong frame, so the round trip is pinned by a test in this package
 * rather than the two halves living in different packages.
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

/**
 * `HH:MM:SS:FF` → a frame count — [`fmtTimecode`]'s inverse (D-328).
 *
 * Returns `null` for anything it cannot read, rather than a silent `0`: a
 * timecode field that turns a typo into "go to the start of the timeline" is
 * worse than one that refuses and keeps the old value, which is what every
 * caller does with the `null`.
 *
 * **Accepts short forms, the way a real NLE's timecode field does**, counting
 * from the RIGHT so the smallest unit is always frames: `12` is 12 frames,
 * `4:12` is 4 seconds 12 frames, `1:04:12` is a minute in, and the full
 * `00:01:04:12` is the same thing spelled out. A field that forced all four
 * segments would make typing a two-second duration a chore, and the
 * right-anchored reading is unambiguous because the segment count decides the
 * meaning. A bare number is therefore FRAMES, which also keeps every frame
 * value the pre-D-328 numeric field accepted working unchanged.
 *
 * Segments may not be negative (a `-` anywhere is a refusal, since a negative
 * timecode is not a position), and minutes/seconds above 59 are accepted rather
 * than refused — `00:00:90:00` is a legal way to type 90 seconds, and clamping
 * or refusing it would be a surprise in a field people type fast.
 */
export function parseTimecode(text: string, fps?: number): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A non-positive or missing fps has no frames-per-second to multiply by, so
  // only a bare frame count can be meant — mirrors `fmtTimecode`'s own
  // "no fps → frame counter only" fallback rather than inventing a rate.
  const rate = fps !== undefined && Number.isFinite(fps) && fps > 0 ? fps : null;

  const segments = trimmed.split(':');
  if (segments.length > 4) return null;
  const nums: number[] = [];
  for (const seg of segments) {
    // Reject `-1`, `1.5`, `1e3`, `` and stray spaces in one place: a timecode
    // segment is digits and nothing else.
    if (!/^\d+$/.test(seg.trim())) return null;
    nums.push(Number(seg.trim()));
  }

  // Right-anchored: the last segment is always frames, then seconds, minutes,
  // hours as they are present.
  const frames = nums[nums.length - 1] ?? 0;
  const secs = nums[nums.length - 2] ?? 0;
  const mins = nums[nums.length - 3] ?? 0;
  const hours = nums[nums.length - 4] ?? 0;

  if (rate === null) {
    // Without a rate only the bare-frames form is meaningful; anything with a
    // colon in it would need a rate to resolve.
    return nums.length === 1 ? frames : null;
  }
  return Math.round((hours * 3600 + mins * 60 + secs) * rate) + frames;
}
