/**
 * @apelles/motion — the Motion→Edit link, computed (D-260).
 *
 * What it is: the one function that answers "which Edit-tab clips does each
 *   Motion scene feed?", from two plain arrays — the project's media pool and
 *   the open timeline's tracks.
 * What it does: reads each pool item's `motionSceneId` stamp (the provenance
 *   D-260 records at render time) and resolves it to every clip on the timeline
 *   reading that item.
 * What it does NOT do: no IO, no stores, no React. It never DERIVES a scene's
 *   render path — the stamp is the link, precisely so that `motion.rs`'s
 *   `default_output_path` stays the ONE place project-relative render paths are
 *   computed (its own doc says so) and a render to a caller-named path links
 *   just as well as a default one.
 *
 * **B-219/D-359 — the one path question it now DOES answer: is the linked file
 * inside the open project?** A project copied on the filesystem (Finder, `cp
 * -R` — there is no in-app copy operation) inherits `project.json` verbatim, so
 * its Motion pool items still carry the ORIGINAL project's absolute
 * `source_path`. A `motion_render` in the copy writes into the COPY's own
 * `motion/renders/`, which those stale items do not point at — so the promised
 * "a re-render refreshes the placed Edit clips" (D-260) is silently void, and
 * this map, which is what `motion_get_edit_links` answers from, used to confirm
 * it would work. Containment in the project root is the smallest fact that
 * separates the two cases, and it needs no copy of `default_output_path`'s
 * math: a render of a scene in THIS project writes inside THIS project, so a
 * stamped item outside it cannot be what one refreshes, whatever its name. It
 * is a necessary condition rather than a sufficient one — deliberately, since
 * the sufficient one would mean re-deriving the render path here and being
 * wrong for every caller-named output. It is also exactly the condition B-219
 * is made of.
 *
 * **Why the parameters are structural, not imported types.** Answering this
 * needs the media pool (`@apelles/bridge`'s `MediaItem`) and the Edit timeline
 * (`@apelles/editor`'s `Timeline`), and D-039's layer direction (app → tabs →
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
 *  `@apelles/bridge`'s `MediaItem`. */
export interface EditLinkMediaItem {
  id: string;
  sourcePath: string;
  motionSceneId?: string | null;
}

/** The clip fields this reads. Structurally satisfied by `@apelles/editor`'s
 *  `Clip`. */
export interface EditLinkClip {
  id: string;
  name: string;
  media_id?: string | null;
  source_path: string;
}

/** The track fields this reads. Structurally satisfied by `@apelles/editor`'s
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
 * If two pool items carry the same scene id, ONE of them wins and the other is
 * ignored, rather than the counts being silently summed across two different
 * files. **B-219 decides which**: an item inside `projectDir` beats one outside
 * it, whatever the pool order — the copied-project case puts the stale,
 * unreachable item FIRST (it is the inherited one; the copy's own render is
 * appended after it), so "the first wins" reported precisely the wrong file. A
 * tie between two items that are both inside, or both outside, still goes to
 * the first, which is the hand-edited `project.json` case that rule was written
 * for.
 *
 * `projectDir` is the open project's root (`<name>.chroma`). Omitting it keeps
 * every link's `refreshedByRender` at `null` — "not asked", never `true`: a
 * caller with no project root must not be told a render will land.
 */
export function computeEditLinks(
  media: readonly EditLinkMediaItem[],
  tracks: readonly EditLinkTrack[],
  projectDir?: string | null,
): MotionEditLinks {
  const chosen = new Map<string, EditLinkMediaItem>();
  for (const item of media) {
    const sceneId = item.motionSceneId;
    if (!sceneId) continue;
    const held = chosen.get(sceneId);
    if (!held) {
      chosen.set(sceneId, item);
      continue;
    }
    // B-219 — the only case that overturns "the first wins".
    if (isInsideProject(held, projectDir) === false && isInsideProject(item, projectDir) === true) {
      chosen.set(sceneId, item);
    }
  }

  const links: MotionEditLinks = {};
  for (const [sceneId, item] of chosen) {
    const clips: MotionEditLinkClip[] = [];
    tracks.forEach((track, trackIndex) => {
      track.clips.forEach((clip, clipIndex) => {
        if (!clipReadsItem(clip, item)) return;
        clips.push({ track: trackIndex, clip: clipIndex, clipId: clip.id, name: clip.name });
      });
    });
    const link: MotionEditLink = {
      mediaId: item.id,
      sourcePath: item.sourcePath,
      clips,
      refreshedByRender: isInsideProject(item, projectDir),
    };
    links[sceneId] = link;
  }
  return links;
}

/**
 * B-219 — does `item`'s file live inside `projectDir`? `null` when no project
 * root was supplied and the question therefore has no answer here.
 *
 * A prefix test on the string, not a resolved/normalised path compare: both
 * sides are absolute paths produced by the SAME backend (`project.rs`'s open
 * path and `motion.rs`'s `default_output_path`, both built from the one
 * `state::current_project()` root), so there is no `..`, no symlink hop and no
 * case-folding difference between them to normalise away. The segment boundary
 * is the whole subtlety and it is handled explicitly below — without it
 * `/Movies/c040.chroma` would "contain" `/Movies/c040.chroma-recut`, which is
 * the exact pair of names this bug was found on. Deliberately not a dependency:
 * this is a boundary check on two strings, and `node:path` is not available in
 * the webview bundle at all.
 */
function isInsideProject(item: EditLinkMediaItem, projectDir?: string | null): boolean | null {
  if (!projectDir) return null;
  const root = projectDir.endsWith('/') ? projectDir.slice(0, -1) : projectDir;
  if (root === '') return null;
  return item.sourcePath === root || item.sourcePath.startsWith(`${root}/`);
}

/**
 * Does `clip` read `item`'s file? `media_id` when the clip carries one,
 * `source_path` otherwise.
 *
 * Exported because the composition root needs the identical question answered
 * one more time — "how many clips did that re-render just refresh?" — and
 * because it must stay in step with `@apelles/editor`'s `refresh_media` matcher.
 * A second hand-written copy of the rule at either call site is how the badge
 * and the refresh would come to disagree about which clips are affected.
 */
export function clipReadsItem(clip: EditLinkClip, item: EditLinkMediaItem): boolean {
  return clip.media_id ? clip.media_id === item.id : clip.source_path === item.sourcePath;
}
