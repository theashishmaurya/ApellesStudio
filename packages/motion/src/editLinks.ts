/**
 * @chroma/motion — the Motion→Edit link, computed (D-260).
 *
 * What it is: the one function that answers "which Edit-tab clips does each
 *   Motion scene feed?", from two plain arrays — the project's media pool and
 *   the open timeline's tracks.
 * What it does: reads each pool item's `motionSceneId` stamp (the provenance
 *   D-260 records at render time) and resolves it to every clip on the timeline
 *   reading that item.
 * What it does NOT do: no IO, no stores, no React, no path arithmetic. It never
 *   derives a scene's render path — the stamp is the link, precisely so that
 *   `motion.rs`'s `default_output_path` stays the ONE place project-relative
 *   render paths are computed (its own doc says so) and a render to a
 *   caller-named path links just as well as a default one.
 *
 * **Why the parameters are structural, not imported types.** Answering this
 * needs the media pool (`@chroma/bridge`'s `MediaItem`) and the Edit timeline
 * (`@chroma/editor`'s `Timeline`), and D-039's layer direction (app → tabs →
 * services → domain) forbids a tab package importing either — the same
 * constraint that makes `onRendered` a prop rather than a direct
 * `useMediaPoolStore` call (D-062). Declaring the minimum shape this function
 * actually reads, instead of importing the full types, keeps the dependency at
 * zero while staying exactly as type-safe at the call site: the composition
 * root passes its real `MediaItem[]` and `Timeline.tracks`, and structural
 * typing checks them against these. The alternative — a second copy of the
 * types in another package — is the copy-paste this repo's rules forbid.
 */

import type { MotionEditLink, MotionEditLinkClip, MotionEditLinks } from './motionOps';

/** The media-pool fields this reads. Structurally satisfied by
 *  `@chroma/bridge`'s `MediaItem`. */
export interface EditLinkMediaItem {
  id: string;
  sourcePath: string;
  motionSceneId?: string | null;
}

/** The clip fields this reads. Structurally satisfied by `@chroma/editor`'s
 *  `Clip`. */
export interface EditLinkClip {
  id: string;
  name: string;
  media_id?: string | null;
  source_path: string;
}

/** The track fields this reads. Structurally satisfied by `@chroma/editor`'s
 *  `Track`. */
export interface EditLinkTrack {
  clips: readonly EditLinkClip[];
}

/**
 * Every rendered scene's Edit-tab footprint: its pool item, and every clip on
 * `tracks` reading it. Keyed by scene id.
 *
 * **Built from the media pool, not from the manifest**, so it needs no scene
 * list at all: the stamp on a pool item IS the record that a scene was
 * rendered. A scene with no stamped item is therefore simply **absent from the
 * result**, not present with an empty `clips` — "never rendered into this
 * project" and "rendered but not placed" are genuinely different states, and
 * both callers (`motion_get_edit_links`'s `rendered` flag, the layer list's
 * badge) distinguish them. It also means the map cannot go stale against an
 * unsaved manifest edit the way a scene-list-driven one would.
 *
 * A clip matches its pool item by `media_id` when the clip carries one, and by
 * `source_path` otherwise — `Clip.media_id` is nullable by design (a clip can
 * predate the pool link), and this is the same two-key resolution
 * `editor_add_clip` performs in the other direction. Deliberately the same rule
 * as `refresh_media`'s own matcher, so what the badge counts is exactly what a
 * re-render refreshes.
 *
 * If two pool items somehow carry the same scene id — only reachable by hand-
 * editing `project.json` — the first wins and the second is ignored, rather
 * than the counts being silently summed across two different files.
 */
export function computeEditLinks(
  media: readonly EditLinkMediaItem[],
  tracks: readonly EditLinkTrack[],
): MotionEditLinks {
  const links: MotionEditLinks = {};
  for (const item of media) {
    const sceneId = item.motionSceneId;
    if (!sceneId || links[sceneId]) continue;
    const clips: MotionEditLinkClip[] = [];
    tracks.forEach((track, trackIndex) => {
      track.clips.forEach((clip, clipIndex) => {
        if (!clipReadsItem(clip, item)) return;
        clips.push({ track: trackIndex, clip: clipIndex, clipId: clip.id, name: clip.name });
      });
    });
    const link: MotionEditLink = { mediaId: item.id, sourcePath: item.sourcePath, clips };
    links[sceneId] = link;
  }
  return links;
}

/**
 * Does `clip` read `item`'s file? `media_id` when the clip carries one,
 * `source_path` otherwise.
 *
 * Exported because the composition root needs the identical question answered
 * one more time — "how many clips did that re-render just refresh?" — and
 * because it must stay in step with `@chroma/editor`'s `refresh_media` matcher.
 * A second hand-written copy of the rule at either call site is how the badge
 * and the refresh would come to disagree about which clips are affected.
 */
export function clipReadsItem(clip: EditLinkClip, item: EditLinkMediaItem): boolean {
  return clip.media_id ? clip.media_id === item.id : clip.source_path === item.sourcePath;
}
