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

import { timelineFramesToSource } from './timeline';

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
 *  `source_start + timeline_frames_to_source(...)`, the same value
 *  `resolve_clip_transform` receives as `source_frame`), NOT the absolute
 *  timeline position. Clamped to the clip's own source window since the
 *  playhead may sit outside the clip when nothing is actually selected there.
 *
 *  **B-079 — now fps-corrected, in the SAME change as `Track::clip_at`'s own
 *  Rust fix**, per that bug's own entry in `docs/BUGS.md` (fixing this TS
 *  half alone, before Rust's, would have desynced authoring from playback —
 *  see the entry for why). `fps` is the project's own `timelineFps(tl)`;
 *  `timelineFramesToSource` (B-077) converts the TIMELINE-frame offset
 *  `playhead - clip.start_frame` into the clip's own SOURCE frames via
 *  `clip.source_fps` (falling back to `fps` — a 1:1 ratio — when absent),
 *  exactly mirroring `Track::clip_at`'s now-fixed formula. Identical to the
 *  pre-fix plain subtraction whenever `source_fps` is absent or equals
 *  `fps` — every same-native-fps clip computes the same source frame either
 *  way. */
export function clipSourceFrame(
  clip: { source_start: number; start_frame: number; source_len: number; source_fps?: number },
  playhead: number,
  fps: number,
): number {
  const raw = clip.source_start + timelineFramesToSource(clip, playhead - clip.start_frame, fps);
  return Math.max(0, Math.min(clip.source_len - 1, raw));
}
