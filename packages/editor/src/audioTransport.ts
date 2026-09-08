/**
 * @chroma/editor — the Edit tab's audio-transport request stamp (D-130, moved
 * here from `PreviewPane.tsx` by D-232).
 *
 * What it is: one monotonic counter for **every** command that claims the Rust
 * audio transport — `chroma_audio_play`, `chroma_audio_stop`, and D-232's
 * `chroma_audio_scrub_begin`/`chroma_audio_scrub_end`.
 *
 * **Why it had to move.** There is exactly one transport in Rust
 * (`chroma_media::audio`'s `SESSION`), and `begin_request` drops any request
 * whose stamp is at or below the newest it has accepted. Two counters would
 * therefore not be two independent orderings — they would be one ordering fed
 * by two sources that can each hand out a stamp the other has already used, so
 * a real scrub could be dropped as "stale" by a play that came first, or vice
 * versa. A scrub superseding playback (and playback superseding a scrub) is
 * D-232's whole coexistence story, and it rests on this being one counter.
 *
 * Seeded from `Date.now()` rather than 1 so a page reload (dev HMR, or a webview
 * reload in the shipped app) still produces stamps above whatever the previous
 * page reached — the Rust high-water mark lives in the process, which outlives
 * the page. That holds unless a page issues more than one transport command per
 * elapsed millisecond of its whole lifetime, which a user-driven transport
 * never does. (Scrub POSITION updates are not transport commands and carry no
 * stamp at all — see `chroma_media::scrub::update` for why a level needs no
 * ordering token.)
 *
 * Same request-token pattern `timelineStore.ts`'s `load()` uses for the same
 * class of bug (B-034 / D-112).
 */

let audioSeq = Date.now();

/** The next transport stamp. Strictly increasing for the life of the page. */
export function nextAudioSeq(): number {
  return ++audioSeq;
}
