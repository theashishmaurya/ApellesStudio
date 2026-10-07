/**
 * @apelles/motion — the Motion→Edit link, computed (D-260).
 *
 * What it is: the one function that answers "which Edit-tab clips does each
 *   Motion scene feed?", from two plain arrays — the project's media pool and
 *   the open timeline's tracks.
 * What it does: reads each pool item's `motionSceneId` stamp (the provenance
 *   D-260 records at render time) and resolves it to every clip on the timeline
 *   reading that item.
 * What it also does (B-242/D-371): answers the inverse question — "is it safe
 *   to RENAME this scene?" — since a scene's `id` is the key that link is made
 *   of. `checkSceneRename` at the bottom of this file.
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

// ---------------------------------------------------------------------------
// B-242/D-371 — renaming a scene
// ---------------------------------------------------------------------------

/** The scene fields a rename check reads. Structurally satisfied by
 *  `schema.ts`'s `Scene`; declared rather than imported for the same reason
 *  every other shape in this file is — this stays a pure predicate over plain
 *  data. */
export interface RenameableScene {
  id: string;
}

/** `{ok:false}` carries `overridable` so a caller can tell the two classes of
 *  refusal apart: a BROKEN one (no id, an id that is not a usable filename, a
 *  collision with another scene) produces a document that does not work and
 *  has no legitimate override, while the LINK one is a real tradeoff the
 *  person making it is allowed to accept. */
export type SceneRenameCheck =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: string; overridable: boolean };

/** Characters that would stop a scene id being usable as the FILENAME
 *  `motion_render` builds out of it. `default_output_path`
 *  (`app/src-tauri/src/chroma/motion.rs`) joins the id straight onto
 *  `<project>.chroma/motion/renders/` with a `.mp4` suffix and does no
 *  escaping of its own — so a `/` makes a subdirectory, a `..` segment walks
 *  OUT of the project, and a control character produces a path no shell or
 *  Finder can address. The scene id is a display name, but it is also a path
 *  component, and this is the boundary where that second fact has to be
 *  enforced.
 *
 *  Split into a two-character class plus an explicit code-point scan, rather
 *  than one regex carrying an escaped control-character range, so this file
 *  contains no escaped control characters of its own — one that decays into a
 *  LITERAL control byte in the source is invisible in every diff and review
 *  that would have to check it. */
const ILLEGAL_SCENE_ID_CHARS = /[/\\]/;

/** Any C0 control character or DEL. See `ILLEGAL_SCENE_ID_CHARS` above. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * B-242/D-371 — is renaming `scenes[sceneIndex]` to `nextId` safe, and if
 * not, exactly why?
 *
 * **Why a scene rename needs a check at all.** `scene.id` is the scene's
 * DISPLAY NAME (the layer panel's section header, the scene selector,
 * `motion_get_state`'s per-scene row) — but it is simultaneously two things
 * that are not display names, and both break silently when it moves:
 *
 *  1. **It names the rendered file.** `default_output_path` writes a scene to
 *     `<project>.chroma/motion/renders/<id>.mp4` (D-180). Rename the scene and
 *     the next `motion_render` writes a DIFFERENT file; the old one stays on
 *     disk under the old name, orphaned.
 *  2. **It is the key of the Motion→Edit link.** `computeEditLinks` above
 *     resolves a scene to its Edit-tab clips through the `motionSceneId` stamp
 *     written onto the media-pool item at render time (D-260). That stamp is a
 *     copy of the id, not a reference to the scene, and nothing in this
 *     package can write it (the pool is reached through an injected read-only
 *     accessor — D-039's layer direction forbids `@apelles/motion` importing
 *     `@apelles/bridge` or `@apelles/editor`). So a rename does not follow it:
 *     the renamed scene reads as "never rendered", the stale stamp keeps
 *     pointing at the old file, and D-260's whole promise — "a re-render
 *     refreshes the placed Edit clips" — is void in exactly the way B-219
 *     described for a copied project.
 *
 * **So it REFUSES rather than following the references.** Following them would
 * mean renaming a file on disk, rewriting the pool item's `sourcePath` and
 * stamp, and rewriting every placed clip's `source_path` — three layers this
 * one cannot reach, for the structural reason above. A refusal that NAMES the
 * clips it would orphan is the honest answer, and it is this repo's
 * established shape for the situation (`checkRemoveGap`/B-227,
 * `checkSplit`/B-197: one pre-flight predicate, shared by the GUI gesture and
 * the MCP tool, returning a reason a caller can print).
 *
 * **The link test is `renderStaleness`' test, not a second one.**
 * `links[id] !== undefined && links[id].refreshedByRender !== false` — a link
 * into a DIFFERENT project (the B-219 filesystem-copy case) is not a render
 * this project owns, so renaming past it orphans nothing of ours. One rule,
 * not two.
 *
 * **`links === undefined` allows the rename**, and that is not a loophole:
 * `undefined` means no link map reached this tab at all, which in the shipped
 * app cannot happen (`Root.tsx` always computes one) and in the standalone
 * Motion harness means there is no Edit timeline mounted to hold a clip. There
 * is no third case where link data is missing but links exist.
 *
 * `force` lifts ONLY the link refusal. A scene's name is a thing people
 * legitimately change after shipping a cut, the damage is recoverable
 * (re-render under the new name, re-place or re-link the clip), and a rule
 * that made a rendered scene's name permanent forever would be a worse bug
 * than the one this fixes. It does not lift a collision or an unusable id —
 * those produce a document that is wrong, not a tradeoff.
 */
export function checkSceneRename(
  scenes: readonly RenameableScene[],
  sceneIndex: number,
  nextId: unknown,
  links: MotionEditLinks | undefined,
  opts: { force?: boolean } = {},
): SceneRenameCheck {
  const scene = scenes[sceneIndex];
  if (!scene) {
    return {
      ok: false,
      reason: `no scene at index ${sceneIndex} (0..${scenes.length - 1})`,
      overridable: false,
    };
  }
  const from = scene.id;

  if (typeof nextId !== 'string') {
    return {
      ok: false,
      reason:
        `a scene id must be a non-empty string — got ${JSON.stringify(nextId)}. ` +
        'It is the scene\'s display name AND the name of the file motion_render writes, ' +
        'so it cannot be deleted or set to a non-string.',
      overridable: false,
    };
  }
  if (nextId.trim() === '') {
    return {
      ok: false,
      reason:
        'a scene id cannot be empty or whitespace-only — it is what the layer panel, the scene ' +
        'selector and motion_render\'s output filename all show, so a blank one is indistinguishable ' +
        'from every other blank scene.',
      overridable: false,
    };
  }
  if (nextId !== nextId.trim()) {
    return {
      ok: false,
      reason: `a scene id cannot start or end with whitespace (got ${JSON.stringify(nextId)}) — the padding is invisible on screen and silently part of the rendered filename.`,
      overridable: false,
    };
  }
  if (ILLEGAL_SCENE_ID_CHARS.test(nextId) || hasControlChar(nextId) || nextId === '.' || nextId === '..') {
    return {
      ok: false,
      reason:
        `${JSON.stringify(nextId)} is not usable as a scene id: motion_render writes the scene to ` +
        'motion/renders/<id>.mp4, so an id may not contain "/", "\\" or a control character, and may ' +
        'not be "." or "..".',
      overridable: false,
    };
  }

  // Renaming to what it already is changes nothing and can orphan nothing.
  if (nextId === from) return { ok: true, from, to: nextId };

  const collision = scenes.findIndex((s, i) => i !== sceneIndex && s.id === nextId);
  if (collision !== -1) {
    return {
      ok: false,
      reason:
        `scene ${collision} is already called ${JSON.stringify(nextId)}. Two scenes sharing an id ` +
        'render to the same motion/renders/<id>.mp4 file (the second overwrites the first) and ' +
        'cannot be told apart by the Motion→Edit link, which is keyed by id.',
      overridable: false,
    };
  }

  const link = links?.[from];
  if (link && link.refreshedByRender !== false && !opts.force) {
    const where =
      link.clips.length > 0
        ? `${link.clips.length} clip(s) on the Edit timeline read it (${link.clips.map((c) => c.name).join(', ')})`
        : 'its render is in Sources but not placed on the timeline';
    return {
      ok: false,
      reason:
        `renaming ${JSON.stringify(from)} to ${JSON.stringify(nextId)} would orphan its render: ` +
        `${where}, through ${link.sourcePath ?? 'its pool item'}. That link is a motionSceneId stamp ` +
        'copied onto the pool item when the scene was rendered — a rename does not follow it, so the ' +
        'clips would keep reading the OLD file while a re-render writes ' +
        `motion/renders/${nextId}.mp4 and never refreshes them. Re-render under the new name and ` +
        're-place the clips, or pass force: true to rename anyway and accept the broken link.',
      overridable: true,
    };
  }

  return { ok: true, from, to: nextId };
}
