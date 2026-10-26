/**
 * @apelles/bridge — the frontend↔backend seam (D-039).
 *
 * Will hold: typed `@tauri-apps/api` command bindings (one per
 * `#[tauri::command]`), the shared zustand stores, and the control-bridge hook
 * `useChromaControl` (D-020) currently at `app/src/hooks/useChromaControl.ts`.
 *
 * Status: D-039 migration step 1 stub, still mostly unfilled — its first real
 * content is the D-044 media-pool store (`./media`), joined by D-315's AI-env
 * bootstrap state (`./aiEnv`), which is here because it is the one seam both
 * `app/src` and `packages/editor` can read.
 */

export { useMediaPoolStore } from './media';
export type { MediaItem, MediaVideoInfo, MediaImageInfo } from './media';

export { trackEvent } from './telemetry';
export type { TelemetryEvent } from './telemetry';

export { safeUnlisten } from './tauriListeners';

export { classifyPageStart, pageStart, watchPageUnload } from './pageLifecycle';
export type { MarkerStorage, PageStart } from './pageLifecycle';

export { newBridgeClaim } from './controlBridge';
export type { BridgeClaim, BridgeClaimWire } from './controlBridge';

export {
  AI_ENV_STATUS_EVENT,
  aiEnvHeadline,
  aiEnvIsBuilding,
  aiEnvIsWorking,
  aiEnvNotice,
  aiEnvProgressLabel,
  aiEnvWarning,
  useAiEnv,
  useAiEnvStore,
  watchAiEnv,
} from './aiEnv';
export type { AiEnvPhase, AiEnvStatus } from './aiEnv';
