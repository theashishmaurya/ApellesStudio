/**
 * `@apelles/editor` — the Music edits panel's Preview: hear a music edit before
 * it is applied (D-442, B-364; owner decision 2026-11-03).
 *
 * **What it is.** {@link previewMusicEdit} computes the edited timeline with the
 * same pure reducer the `music_edits` op runs (`applyMusicEdits`), hands it to
 * the audio path as a temporary override (`chroma_audio_preview_set`, which only
 * the mixer's source resolution reads — `chroma::edit::set_audio_preview`), then
 * plays from {@link PREVIEW_PREROLL_SECONDS} before the range to
 * {@link PREVIEW_POSTROLL_SECONDS} after it. {@link stopMusicPreview} clears the
 * override; it runs by itself when playback stops for any reason, when the
 * timeline changes (an edit, a switch), or when the window has played out.
 *
 * **Non-committing and deterministic.** Nothing is dispatched to the store,
 * nothing is saved, nothing reaches the undo history: the document the person
 * sees and the one on disk are untouched, and the picture is unchanged (a music
 * edit never moves picture). The same range and the same timeline always build
 * the same preview document, because the reducer is pure.
 *
 * **What it does NOT do.** Apply anything (`musicEditOps.ts`), or preview for an
 * agent — an agent cannot listen; `editor_music_edit` / `editor_propose_music_
 * edits` answer with the outcome in words, the same reducer's results.
 */
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

import { afterPaint } from './afterPaint';
import { applyMusicEdits, timelineFps, type MusicEditRange, type Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** How much of the music before the edit the preview plays, seconds. */
export const PREVIEW_PREROLL_SECONDS = 2;
/** How much after the music comes back, seconds. */
export const PREVIEW_POSTROLL_SECONDS = 2;

/** Which preview is playing (the range's key), for the button's Stop state. */
export const useMusicPreviewStore = create<{ playing: string | null }>(() => ({ playing: null }));

/** The key a range previews under: one Stop button lights, not every Preview. */
export function previewKey(r: MusicEditRange): string {
  return `${r.track}:${r.start}:${r.end}`;
}

let unsubscribe: (() => void) | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

/** Clear the audio override and stop following playback. Safe to call when no
 *  preview is running. Leaves playback itself to the caller (a Stop click
 *  pauses; playback that already stopped needs nothing). */
export function stopMusicPreview(): void {
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  if (useMusicPreviewStore.getState().playing === null) return;
  useMusicPreviewStore.setState({ playing: null });
  void invoke('chroma_audio_preview_set', { timeline: null }).catch(() => {});
}

const nextPaint = () => new Promise<void>((resolve) => afterPaint(resolve));

/**
 * Play `range` as it would sound once applied, without applying it. Resolves
 * once playback has started, or with the reducer's own reason when the edit
 * cannot land (no music under the range, …), in which case nothing plays.
 */
export async function previewMusicEdit(range: MusicEditRange): Promise<{ ok: true } | { error: string }> {
  stopMusicPreview();
  const store = useEditorTimelineStore.getState();
  const tl: Timeline | null = store.timeline;
  if (!tl) return { error: 'Open a project first.' };
  const fps = timelineFps(tl);
  const dry = applyMusicEdits(tl, [range], fps);
  if (!dry.results[0]?.applied) return { error: dry.results[0]?.reason ?? 'This music edit would change nothing.' };

  if (store.playing) {
    // Stop the running session first, so the new one starts from the preview's
    // own pre-roll with the override in place rather than being folded into the
    // same render as a no-op toggle.
    store.setPlaying(false);
    await nextPaint();
  }
  try {
    await invoke('chroma_audio_preview_set', { timeline: dry.timeline });
  } catch (e: unknown) {
    return { error: `The preview could not start: ${e instanceof Error ? e.message : String(e)}` };
  }
  const key = previewKey(range);
  useMusicPreviewStore.setState({ playing: key });
  const from = Math.max(0, range.start - Math.round(PREVIEW_PREROLL_SECONDS * fps));
  const until = range.end + Math.round(PREVIEW_POSTROLL_SECONDS * fps);
  store.setPlayhead(from);
  store.setPlaying(true);

  // Ends with playback, with any edit or timeline switch (the preview document
  // would then be stale), and after the window has played out.
  unsubscribe = useEditorTimelineStore.subscribe((s, prev) => {
    if ((prev.playing && !s.playing) || s.timeline !== tl) stopMusicPreview();
  });
  const rate = useEditorTimelineStore.getState().playbackRate || 1;
  stopTimer = setTimeout(() => {
    if (useMusicPreviewStore.getState().playing !== key) return;
    useEditorTimelineStore.getState().setPlaying(false);
    stopMusicPreview();
  }, (((until - from) / fps) * 1000) / rate);
  return { ok: true };
}
