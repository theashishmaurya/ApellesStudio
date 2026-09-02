/**
 * @chroma/bridge — the frontend↔backend seam (D-039).
 *
 * Will hold: typed `@tauri-apps/api` command bindings (one per
 * `#[tauri::command]`), the shared zustand stores, and the control-bridge hook
 * `useChromaControl` (D-020) currently at `app/src/hooks/useChromaControl.ts`.
 *
 * Status: D-039 migration step 1 stub, still mostly unfilled — its first real
 * content is the D-044 media-pool store (`./media`).
 */

export { useMediaPoolStore } from './media';
export type { MediaItem, MediaVideoInfo } from './media';
