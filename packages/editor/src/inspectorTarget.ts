/**
 * @apelles/editor — which clip of an A/V-linked pair an Inspector facet edits
 * (B-334, D-430).
 *
 * **What it is.** The one resolver for "given the clip the user (or an agent)
 * pointed at, which clip does the VIDEO facet / the AUDIO facet actually read
 * and write". A linked pair (D-129) is two real `Clip`s — a picture on a video
 * track and its sound on an audio track — but the user thinks of it as one shot,
 * exactly as Premiere's and Resolve's Inspectors present it: Video-tab controls
 * drive the picture, Audio-tab controls drive the sound, whichever half was
 * clicked.
 *
 * **Why it exists.** Before it, every Inspector section read the SELECTED clip.
 * Selecting the picture half and opening the Audio tab showed (and edited) the
 * picture half's own `volume` / `pan` / EQ / keyframes — fields the mixer never
 * reads once the sound lives in a linked audio clip (D-129: the video clip's
 * embedded stream is suppressed), so the tab displayed 10.6 while the audible
 * level, on the partner, was 0.55. Selecting the audio half and opening the
 * Video tab edited a transform nothing draws, and the canvas drew the box for
 * it. One resolver, used by every Inspector section, the canvas overlay and the
 * MCP tools, makes that class of mismatch impossible.
 *
 * **Rules.**
 *  - Unlinked clip: it is its own target for both facets (a video clip's
 *    embedded audio is audible; nothing changes for it).
 *  - Linked, `audio` facet: the group member on an AUDIO track. A linked
 *    picture whose audio half is gone is silent (D-129) — no target, so no
 *    control shows a value the mix does not use.
 *  - Linked, `video` facet: the group member on a non-audio track. A linked
 *    audio clip whose picture is gone falls back to itself (the panel keeps its
 *    own sections; the canvas box separately stands aside for any audio-track
 *    clip via {@link canvasTarget}).
 *
 * **What it does NOT do.** It never mutates anything and holds no state. Stray
 * audio fields already stored on a linked picture clip (the legacy of the old
 * behaviour) are neither read nor cleared — see D-430 for why they are ignored
 * rather than migrated.
 */
import { findClip, linkGroupMembers, type Clip, type Timeline } from './timeline';

/** Which half of a clip an Inspector tab / MCP parameter speaks to. */
export type ClipFacet = 'video' | 'audio';

/** A resolved clip, addressed the way every op addresses one. */
export interface ClipTarget {
  track: number;
  /** Index within `track.clips` — valid until the next mutation. */
  index: number;
  clip: Clip;
}

/** The target for `facet` of the clip at `(track, index)`, or `null`.
 *  The index-addressed form is what the MCP handlers use; the Inspector goes
 *  through {@link inspectorTarget}. */
export function facetTarget(
  tl: Timeline | null | undefined,
  track: number,
  index: number,
  facet: ClipFacet,
): ClipTarget | null {
  const own = tl?.tracks[track]?.clips[index];
  if (!tl || !own) return null;
  const self: ClipTarget = { track, index, clip: own };
  if (!own.link_group) return self;

  const onAudioTrack = tl.tracks[track].kind === 'audio';
  if (facet === 'audio' ? onAudioTrack : !onAudioTrack) return self;

  for (const [ti, ci] of linkGroupMembers(tl, own.link_group)) {
    if (ti === track && ci === index) continue;
    if ((tl.tracks[ti].kind === 'audio') === (facet === 'audio')) {
      return { track: ti, index: ci, clip: tl.tracks[ti].clips[ci] };
    }
  }
  // No partner of the wanted kind. A picture with no audio half is silent, so
  // the audio facet has nothing to show; an audio clip with no picture keeps
  // itself for the video facet (see the module doc).
  return facet === 'audio' ? null : self;
}

/** [`facetTarget`] for the Inspector's selection (`{track, id}`), or `null`
 *  when nothing is selected / the clip is gone. */
export function inspectorTarget(
  tl: Timeline | null | undefined,
  selected: { track: number; id: string } | null,
  facet: ClipFacet,
): ClipTarget | null {
  if (!tl || !selected) return null;
  const found = findClip(tl, selected.track, selected.id);
  return found ? facetTarget(tl, selected.track, found.index, facet) : null;
}

/** The clip every on-canvas surface (transform box, dynamic-zoom boxes,
 *  highlight boxes) belongs to for a selection: the PICTURE half of a linked
 *  pair, whichever half is selected — or `null` when there is no picture to
 *  draw on. An audio-track clip has no frame to put a box on, whatever its
 *  source file contains, so it never yields a target. */
export function canvasTarget(
  tl: Timeline | null | undefined,
  selected: { track: number; id: string } | null,
): ClipTarget | null {
  const target = inspectorTarget(tl, selected, 'video');
  return target && tl?.tracks[target.track]?.kind !== 'audio' ? target : null;
}

/** The facet a keyframed property belongs to: volume and pan are the sound's,
 *  every other keyframeable property is the picture's. */
export function paramFacet(param: string): ClipFacet {
  return param === 'volume' || param === 'pan' ? 'audio' : 'video';
}
