/**
 * @apelles/bridge — the Edit tab's audio transport commands (D-049, D-130,
 * D-280; bound here by D-454 when the preview's play path moved behind the
 * bridge, D-447).
 *
 * What it is: typed bindings over `chroma::audio`'s play / stop / monitor
 * volume commands. `seq` is the caller's monotonic request stamp
 * (`@apelles/editor`'s `nextAudioSeq`), which the backend uses to drop a
 * request a newer one has overtaken (D-130).
 *
 * What it does NOT do: decide when to play — the Edit preview's transport
 * does — or carry samples.
 */
import { invoke } from '@tauri-apps/api/core';

/** Play the timeline's sound from `startFrame` at `rate` (D-280). */
export function audioPlay(startFrame: number, seq: number, rate: number): Promise<void> {
  return invoke('chroma_audio_play', { startFrame, seq, rate });
}

/** Stop the sound (a no-op if a newer request has overtaken this one). */
export function audioStop(seq: number): Promise<void> {
  return invoke('chroma_audio_stop', { seq });
}

/** The monitor volume, 0-1 (D-126): not project data. */
export function audioSetVolume(volume: number): Promise<void> {
  return invoke('chroma_audio_set_volume', { volume });
}
