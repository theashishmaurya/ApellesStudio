/**
 * @chroma/player — the shared preview component (D-039 roadmap "Next" item 1).
 *
 * Presentational only: no `@tauri-apps/api`, no zustand, no video/decode logic
 * of any kind. It's chrome around a `surface` the caller renders — see
 * `Player.tsx` for the full contract and `README.md` for an example call site.
 */

export { Player } from './Player';
export type { PlayerProps } from './Player';
export { fmtTimecode } from './timecode';
