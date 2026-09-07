/**
 * @chroma/editor — clip transform keyframe CRUD (D-090, Phase 4 of the P0
 * full-NLE effort).
 *
 * `Clip.chroma_keyframes` (D-086/D-088) is the RAW `[{frame, params}]` array
 * itself, not a `parameters.chromaKeyframes`-wrapped object the way
 * `app/src/utils/maskKeyframes.ts`'s mask/relight-light keyframes are — see
 * `chroma_timeline::edit::resolve_clip_transform` (Rust), which wraps the
 * clip's own array into a synthetic `{chromaKeyframes: [...]}` object only at
 * the moment it hands it to the shared `chroma::keyframes::parse_keyframes`.
 * `packages/editor` cannot import `app/src/utils/maskKeyframes.ts` (a
 * different package — the D-039 layer direction runs app -> editor, not the
 * reverse), so this is a small, separate mirror of that file's upsert/
 * remove/clear pattern, scoped to just the CRUD this UI needs (no
 * interpolation — that stays the Rust engine's job at render time, same
 * reasoning `resolve_clip_transform` already documents).
 */

export interface ClipKeyframe {
  frame: number;
  params: Record<string, unknown>;
}

/** Upsert a keyframe at `frame`, returning a NEW array (frame-sorted). An
 *  existing key at that exact frame is replaced — mirrors `maskKeyframes.ts`'s
 *  `upsertKeyframe`. */
export function upsertClipKeyframe(
  existing: ClipKeyframe[] | undefined,
  frame: number,
  params: Record<string, unknown>,
): ClipKeyframe[] {
  const f = Math.max(0, Math.round(frame));
  const kfs = (existing ?? []).filter((k) => k.frame !== f);
  kfs.push({ frame: f, params: { ...params } });
  kfs.sort((a, b) => a.frame - b.frame);
  return kfs;
}

/** Remove the keyframe at `frame`. Returns `undefined` when none remain (so
 *  the clip goes back to fully static — `set_clip_keyframes` normalizes `[]`
 *  the same way, this just saves a round trip through that). */
export function removeClipKeyframe(existing: ClipKeyframe[] | undefined, frame: number): ClipKeyframe[] | undefined {
  const f = Math.round(frame);
  const kfs = (existing ?? []).filter((k) => k.frame !== f);
  return kfs.length === 0 ? undefined : kfs;
}

/** Remove every keyframe. */
export function clearClipKeyframes(): ClipKeyframe[] | undefined {
  return undefined;
}

/** The clip's own SOURCE frame at the given timeline `playhead` frame —
 *  keyframes are interpolated against this (mirrors `Track::clip_at`'s
 *  `source_start + (frame - start_frame)`, the same value `resolve_clip_
 *  transform` receives as `source_frame`), NOT the absolute timeline
 *  position. Clamped to the clip's own source window since the playhead may
 *  sit outside the clip when nothing is actually selected there.
 *
 *  **B-079 — deliberately NOT fps-corrected, unlike the rest of `@chroma/
 *  editor` post-B-077.** This intentionally mirrors `Track::clip_at`'s
 *  CURRENT (still-wrong-for-mixed-fps) Rust formula byte for byte: Rust's
 *  `resolve_clip_transform` is what actually interpolates a keyframe at
 *  playback/render time, fed by that same unconverted `Track::clip_at`. If
 *  this function alone were made fps-aware, the Inspector would show/store a
 *  keyframe at the CORRECT source frame while playback kept applying it at
 *  Rust's wrong one — a new authoring/playback mismatch, worse than today's
 *  "both sides agree, wrongly." Fix this in the SAME change as B-079's Rust
 *  half, never before it — see that bug's own entry in `docs/BUGS.md`. */
export function clipSourceFrame(clip: { source_start: number; start_frame: number; source_len: number }, playhead: number): number {
  const raw = clip.source_start + (playhead - clip.start_frame);
  return Math.max(0, Math.min(clip.source_len - 1, raw));
}
