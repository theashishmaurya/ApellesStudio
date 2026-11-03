/**
 * @apelles/editor — **the export's Clip exceptions, written into the timeline
 * the compositor draws (D-448).**
 *
 * What it is: two pure functions, [`applySpeedAndStretch`] and [`applyHoldLastFrame`], that turn the three
 * export-time, per-clip choices — `speedOverrides` (D-183), `fitOverrides`
 * "Stretch to fill" (B-074) and `freezeOverrides` "Hold last frame" (D-188) —
 * into ordinary clip data on a COPY of the timeline:
 *
 * - a speed override is a one-run speed ramp (`speed_points`), which the
 *   compositor (`Clip::source_frame_at`) and the audio compiler
 *   (`resolveSpeedSegments`) already play — a flat speed has always been a
 *   one-segment ramp (`speed_ramp.rs`'s own doc). A clip that already carries
 *   a ramp keeps it: the override never applied to one;
 * - "Stretch to fill" is `Clip.stretch`;
 * - "Hold last frame" is `Clip.hold_until_frame`, the export's last frame.
 *
 * The export then compiles its sound from, and renders its picture from, that
 * one copy, so the two cannot disagree about what a Clip exception means.
 *
 * What it does NOT do: change the stored document (the exceptions are a
 * property of one export, as they have always been), validate the maps (the
 * caller already has), or refuse a speed change next to a transition (the
 * caller's `transitionClipsWithSpeedChange` does, for every renderer).
 */
import type { Clip, Timeline } from './timeline';

export interface ClipExceptions {
  speedOverrides?: Record<string, number>;
  fitOverrides?: Record<string, 'fit' | 'stretch'>;
  freezeOverrides?: Record<string, boolean>;
}

/** Whether `ex` asks for anything at all. */
export function hasClipExceptions(ex: ClipExceptions): boolean {
  return (
    Object.values(ex.speedOverrides ?? {}).some((s) => s !== 1) ||
    Object.values(ex.fitOverrides ?? {}).some((f) => f === 'stretch') ||
    Object.values(ex.freezeOverrides ?? {}).some(Boolean)
  );
}

/**
 * The speed and stretch exceptions applied to a copy of `tl`. Hold-last-frame
 * needs the export's length, which itself depends on the speed changes, so it
 * is the second step, [`applyHoldLastFrame`].
 */
export function applySpeedAndStretch(tl: Timeline, ex: ClipExceptions): Timeline {
  if (!hasClipExceptions(ex)) return tl;
  const clip = (c: Clip): Clip => {
    let out = c;
    const speed = ex.speedOverrides?.[c.id];
    if (speed !== undefined && speed !== 1 && !(c.speed_points?.length)) {
      out = { ...out, speed_points: [{ source_frame: c.source_start, speed }] };
    }
    if (ex.fitOverrides?.[c.id] === 'stretch') out = { ...out, stretch: true };
    return out;
  };
  // Every track: a speed override retimes an audio clip as well (its sound is
  // compiled from the same ramp).
  return { ...tl, tracks: tl.tracks.map((t) => (t.kind === 'subtitle' ? t : { ...t, clips: t.clips.map(clip) })) };
}

/** The hold-last-frame exceptions applied to a copy of `tl`: each held clip
 *  keeps its last frame on screen up to `endFrame` (the export's length in
 *  timeline frames). A clip that already reaches it is unchanged. */
export function applyHoldLastFrame(tl: Timeline, ex: ClipExceptions, endFrame: number): Timeline {
  const held = ex.freezeOverrides ?? {};
  if (!Object.values(held).some(Boolean)) return tl;
  return {
    ...tl,
    tracks: tl.tracks.map((t) =>
      t.kind === 'video'
        ? { ...t, clips: t.clips.map((c) => (held[c.id] ? { ...c, hold_until_frame: endFrame } : c)) }
        : t,
    ),
  };
}
