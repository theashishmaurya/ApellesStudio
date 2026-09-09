/**
 * @apelles/bridge — local-only user-action telemetry (D-093).
 *
 * `trackEvent(name, props)` is the one function every package/tab reaches
 * for to record "a user did X." It does NOT call out to any network/
 * analytics SDK — it reuses the existing `frontend_log` Tauri command
 * (`app/src-tauri/src/lib.rs`, already wired to `log::info!`) with a
 * `[telemetry]` prefix and a JSON payload, so events land in the same
 * `app_log_dir()/app.log` this whole project already tails for debugging.
 * No new Rust command, no new storage — see `docs/notes/telemetry.md` for
 * the full design, the grep recipe to query events out of `app.log`, and
 * the list of what's wired up vs. still a manual follow-up.
 *
 * Call sites should pass small, JSON-serializable `props` (ids, enum-like
 * strings, counts) — never a whole object graph (a `RelightLight`, a
 * `Timeline`) and never anything sensitive (file contents, absolute paths
 * outside the project). This is a debugging/adoption signal, not an audit
 * log.
 */

import { invoke } from '@tauri-apps/api/core';

// Mirrors `Invokes.FrontendLog` (`app/src/components/ui/AppProperties.tsx`)
// by value rather than by import: that enum lives in `app`, which depends
// on `@apelles/bridge` (D-039 layer direction), not the other way around.
const FRONTEND_LOG_INVOKE = 'frontend_log';
const TELEMETRY_PREFIX = '[telemetry]';

export interface TelemetryEvent {
  event: string;
  props?: Record<string, unknown>;
  ts: number;
}

/**
 * Record a user action. Fire-and-forget, best-effort, never throws — a
 * telemetry call must never be the reason a click handler fails.
 */
export function trackEvent(event: string, props?: Record<string, unknown>): void {
  const payload: TelemetryEvent = { event, ts: Date.now(), ...(props ? { props } : {}) };

  let message: string;
  try {
    message = `${TELEMETRY_PREFIX} ${JSON.stringify(payload)}`;
  } catch {
    // a prop wasn't JSON-serializable (a circular ref, a class instance) —
    // still record that the event happened rather than dropping it silently
    message = `${TELEMETRY_PREFIX} ${JSON.stringify({ event, ts: payload.ts, propsError: 'unserializable' })}`;
  }

  void invoke(FRONTEND_LOG_INVOKE, { level: 'info', message }).catch(() => {
    // local-only, best-effort — no network, nothing to retry, nothing to surface
  });
}
