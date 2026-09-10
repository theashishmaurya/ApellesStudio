/**
 * @apelles/player — the shared preview component (D-039 roadmap "Next" item 1).
 *
 * Presentational only: no `@tauri-apps/api`, no zustand, no video/decode logic
 * of any kind. It's chrome around a `surface` the caller renders — see
 * `Player.tsx` for the full contract and `README.md` for an example call site.
 */

export { Player } from './Player';
export type { PlayerProps } from './Player';
export { fmtTimecode } from './timecode';
// D-280 — the transport's playback-rate model. Exported because the tab that
// owns the value needs the same bounds, presets and formatting the control
// renders with; a second copy in the tab is the drift this prevents.
export {
  clampPlaybackRate,
  DEFAULT_PLAYBACK_RATE,
  formatPlaybackRate,
  isDefaultPlaybackRate,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  PLAYBACK_RATE_PRESETS,
  PLAYBACK_RATE_STEP,
} from './playbackRate';
export { useContentBox } from './useContentBox';
export type { ContentBox, ContentSize } from './useContentBox';
