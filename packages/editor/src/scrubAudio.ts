/**
 * @chroma/editor — the tape-scrub gesture driver (D-232, roadmap item 27).
 *
 * What it is: three module-level functions that turn "the user is dragging the
 * playhead" into the Rust scrub transport. Two independent surfaces make that
 * gesture — the timeline's own cursor drag (`TimelinePane.tsx`, through
 * `@xzdarcy/react-timeline-editor`'s `onCursorDragStart/Drag/DragEnd`) and the
 * player's position bar (`PreviewPane.tsx`) — and both must drive the SAME
 * transport, so this is module state rather than a hook's.
 *
 * **Why module-level and not a hook or a store slice.** It holds no rendered
 * state: nothing here re-renders anything, and there is nothing for React to
 * subscribe to. It reads the live timeline straight off `useEditorTimelineStore`
 * — the same thing `useEditorControl.ts` does for the same reason (see that
 * file's own module doc) — so no surface has to prop-drill a timeline into its
 * pointer handler.
 *
 * What it does NOT do: decide what a scrub sounds like (that is
 * `chroma_media::scrub`), move the playhead (each surface's own drag handler
 * already does, through `setPlayhead`), or produce sound while merely paused.
 * Scrub audio exists for the duration of a real pointer drag and no longer —
 * `end()` is called on pointer-up AND on unmount mid-drag, because a scrub that
 * outlived its gesture would hold the output device open forever.
 */

import { invoke } from '@tauri-apps/api/core';

import { nextAudioSeq } from './audioTransport';
import { scrubSourceAt } from './scrubSource';
import { useEditorTimelineStore } from './timelineStore';

/** Whether a scrub gesture is currently live. Guards `update`, so a stray
 *  pointer-move after the drag ended cannot restart the read head, and makes
 *  `end()` idempotent (both surfaces' cleanup paths can call it). */
let scrubbing = false;

/** The Rust command args for the source under `frame`, or the "nothing audible
 *  here" shape — a `null` path, which `chroma_audio_scrub_*` reads as silence
 *  rather than as an error.
 *
 *  `gain` (B-110) is the resolved source's own static level — see
 *  `ScrubSource.gain`. Without it every monitored source played at unity, which
 *  is a different loudness from the one the timeline actually has. */
function argsAt(frame: number): {
  sourcePath: string | null;
  sourceSecs: number;
  gain: number;
} {
  const source = scrubSourceAt(useEditorTimelineStore.getState().timeline, Math.round(frame));
  return source
    ? { sourcePath: source.path, sourceSecs: source.sourceSecs, gain: source.gain }
    : { sourcePath: null, sourceSecs: 0, gain: 1 };
}

/**
 * Pointer down on the playhead — claim the transport and start monitoring at
 * `frame`.
 *
 * Claiming it stops whatever was playing, which is correct and is why it goes
 * through the shared `nextAudioSeq()`: grabbing the playhead mid-playback is a
 * scrub, not playback plus a scrub. The `playing` flag is deliberately NOT
 * cleared here — each surface's own drag handler already pauses the transport
 * the way it always did, and this file owning that too would give the two
 * surfaces two different ways to pause.
 */
export function beginScrub(frame: number): void {
  scrubbing = true;
  invoke('chroma_audio_scrub_begin', { ...argsAt(frame), seq: nextAudioSeq() }).catch((e) => {
    // A device failure must not take the drag itself down — the picture is
    // still scrubbing correctly, there is just no sound. Same non-fatal
    // treatment `PreviewPane` gives a failed `chroma_audio_play`.
    console.warn('chroma_audio_scrub_begin failed:', e);
  });
}

/**
 * Pointer moved — steer the read head. Called for every move of the drag, so it
 * stays deliberately cheap: one pure resolve plus one fire-and-forget invoke of
 * a *blocking* command that does nothing but store into a mutex.
 *
 * No sequencing token: a position is a level, not an edge, and last-writer-wins
 * is exactly right (see `chroma_media::scrub::update`).
 */
export function updateScrub(frame: number): void {
  if (!scrubbing) return;
  invoke('chroma_audio_scrub_update', argsAt(frame)).catch(() => {});
}

/** Pointer up, or the surface unmounting mid-drag. Idempotent. */
export function endScrub(): void {
  if (!scrubbing) return;
  scrubbing = false;
  invoke('chroma_audio_scrub_end', { seq: nextAudioSeq() }).catch(() => {});
}

/** Whether a scrub gesture is live — for the surfaces that need to know not to
 *  fight it (the preview's own audio effect, which must not start a play
 *  session under a running scrub). */
export function isScrubbing(): boolean {
  return scrubbing;
}
