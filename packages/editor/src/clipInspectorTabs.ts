/**
 * @apelles/editor — which tabs the clip Inspector offers, and which one is
 * actually showing (D-246).
 *
 * **What it is.** The whole tab model for `ClipInspectorPanel`, as pure
 * functions: the tab ids and their labels, which of them a given clip has
 * anything to put in, and how a requested tab resolves against that set.
 *
 * **What it does NOT do.** It does not decide which SECTION goes in which tab
 * — that is `ClipInspectorPanel.tsx`'s own JSX, where the sections are — and
 * it holds no state. The selected tab lives in `timelineStore`
 * (`inspectorTab`) for the same reason `inspectorOpen` does: `debug_set_
 * inspector_tab` drives it from outside React and must drive the SAME state
 * the human's own click drives.
 *
 * **Why a tab set at all (D-246).** Every clip property was one vertical
 * scroll: Transform, Crop, Dynamic Zoom, Speed, Fade, Volume/Pan, a four-band
 * EQ with its response graph, Keyframes. The reference NLE (DaVinci Resolve,
 * `scratch/resolve-reference/`) splits exactly this into Inspector tabs —
 * Video / Audio / Effects / File — with Transform, Cropping, Dynamic Zoom and
 * Speed Change on the Video tab and Volume, Pan and the Clip Equalizer on the
 * Audio one. We match the split, with the two tabs we actually have content
 * for.
 *
 * **Availability is per clip, and it is not cosmetic.** A text clip has no
 * audio at all — `ClipInspectorPanel` already hid its Volume/Pan and EQ
 * sections (D-211/D-223/D-224) — so it gets no Audio tab rather than an empty
 * one, and the tab bar is not drawn at all when only one tab is left, which
 * leaves a title's Inspector exactly the panel it was before this existed.
 */
import type { Clip } from './timeline';

/** The clip Inspector's tabs, in the order they render. Resolve's own order
 *  (Video before Audio) — and the one the sections already had down the old
 *  single scroll, so nothing moves relative to anything else. */
export const CLIP_INSPECTOR_TABS = ['video', 'audio'] as const;

export type ClipInspectorTab = (typeof CLIP_INSPECTOR_TABS)[number];

export const CLIP_INSPECTOR_TAB_LABELS: Readonly<Record<ClipInspectorTab, string>> = {
  video: 'Video',
  audio: 'Audio',
};

/** The tab a clip Inspector shows when nothing else has been chosen. Video,
 *  because every clip type has one and it is where the geometry a user
 *  reaches for first lives. */
export const DEFAULT_CLIP_INSPECTOR_TAB: ClipInspectorTab = 'video';

/** Which tabs this clip has real content for.
 *
 *  Only the text-clip case removes one today, and it mirrors exactly the
 *  gating the sections themselves already carry (`!clip.text` on Audio and
 *  EQ): a generated title has no audio stream, so an Audio tab would be an
 *  empty panel. Everything else — video, audio-track, caption and adjustment
 *  clips — keeps both, because every one of them renders at least one section
 *  in each. */
export function clipInspectorTabs(clip: Clip): readonly ClipInspectorTab[] {
  if (clip.text) return ['video'];
  return CLIP_INSPECTOR_TABS;
}

/** The tab actually shown: the requested one when this clip has it, else the
 *  first one it does have.
 *
 *  The fallback is a DISPLAY resolution, not a write — selecting a title
 *  while the Audio tab is open shows the title's Video tab without forgetting
 *  that Audio is where the user was, so selecting a video clip again lands
 *  back on Audio. That stickiness is deliberate: a panel that silently reset
 *  its own tab on every selection change is the kind of state-loss that makes
 *  a user stop trusting the panel. */
export function resolveClipInspectorTab(
  requested: ClipInspectorTab,
  available: readonly ClipInspectorTab[],
): ClipInspectorTab {
  if (available.includes(requested)) return requested;
  return available[0] ?? DEFAULT_CLIP_INSPECTOR_TAB;
}

/** Parse an untyped tab id (the `debug_set_inspector_tab` op's argument), or
 *  say why it is not one. Kept here rather than in `@apelles/debug`'s
 *  `uiState.ts` so the accepted set has exactly one definition — the same
 *  reason `SHELL_TABS` lives next to its own store. */
export function parseClipInspectorTab(raw: unknown): ClipInspectorTab | null {
  if (typeof raw !== 'string') return null;
  const normalised = raw.trim().toLowerCase() as ClipInspectorTab;
  return CLIP_INSPECTOR_TABS.includes(normalised) ? normalised : null;
}
