/**
 * Whether a Motion video render carries an audio stream (B-368).
 *
 * What it is: the one rule `render.mts` applies to `renderMedia`'s `muted`
 * option. A manifest produces sound in exactly one way: its soundtrack
 * (D-413), and only when `soundtrack.render` is `true` (`Video.tsx`'s
 * `SoundtrackAudio` draws nothing otherwise). No other primitive plays audio.
 * A render with no sound source used to be muxed with a silent AAC track
 * (measured -91 dB), which the Edit tab's probe then reported as `hasAudio`,
 * so placing the scene added a junk linked audio clip.
 *
 * What it does NOT do: read or validate the manifest (the app's zod schema
 * does that); it only answers the audio question from the props file's shape.
 * Kept in its own module because `render.mts` runs its argument parsing at
 * import time, so a test cannot import it.
 */

/** True when the manifest has a soundtrack that is muxed into the render. */
export function manifestRendersAudio(props: Record<string, unknown>): boolean {
  const soundtrack = props.soundtrack;
  if (typeof soundtrack !== "object" || soundtrack === null) return false;
  return (soundtrack as { render?: unknown }).render === true;
}
