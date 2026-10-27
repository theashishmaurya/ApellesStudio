/**
 * @apelles/motion — the Motion tab's render-runtime banner (D-417).
 *
 * What it is: one thin, non-blocking strip under the toolbar that says what
 * Motion's render runtime (Node.js + Chrome Headless Shell + the Remotion
 * compositor, downloaded on demand) is doing: downloading with a progress bar,
 * failed with a reason and Retry, missing / outdated / damaged with Download.
 * When the runtime is ready it renders nothing. Editing never waits for it;
 * only Render, Still and the component check do (they are disabled with the
 * same reason, `motionRuntimeBlockedReason`).
 *
 * What it does NOT do: start the download by itself (`MotionTab` runs
 * `useMotionRuntimeAutoInstall`, the "first time the tab opens" rule), or
 * offer removal — "Remove Motion runtime" is in Settings beside the AI
 * environment, where a person manages what is installed.
 *
 * Pure presentation over a status: the store is read by the caller, so the
 * DOM test drives every state without Tauri.
 */
import { CircleNotchIcon, DownloadSimpleIcon, WarningIcon } from '@phosphor-icons/react';
import {
  formatMegabytes,
  motionRuntimeHeadline,
  motionRuntimeProgress,
  type MotionRuntimeStatus,
} from '@apelles/bridge';
import { Button } from './Button';

export interface MotionRuntimeBannerProps {
  status: MotionRuntimeStatus;
  /** A request (install) is in flight. */
  busy: boolean;
  /** Why the last install request was refused, if it was. */
  actionError: string | null;
  onInstall: () => void;
}

export function MotionRuntimeBanner({ status, busy, actionError, onInstall }: MotionRuntimeBannerProps) {
  const headline = motionRuntimeHeadline(status);
  if (headline === null) return null;
  const pct = motionRuntimeProgress(status);
  const failed = status.state === 'failed';
  const working = status.state === 'installing' || status.state === 'removing';
  return (
    <div
      role="status"
      aria-live="polite"
      data-motion-runtime-state={status.state}
      className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-border-color bg-surface/60 text-xs"
    >
      {working ? (
        <CircleNotchIcon size={14} className="shrink-0 animate-spin text-accent" aria-hidden />
      ) : failed ? (
        <WarningIcon size={14} className="shrink-0 text-red-400" aria-hidden />
      ) : (
        <DownloadSimpleIcon size={14} className="shrink-0 text-text-secondary" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-text-primary truncate" title={status.detail}>
          {headline}
        </p>
        {failed && status.error && (
          <p className="text-[11px] text-red-400 truncate" title={status.error}>
            {status.error}
          </p>
        )}
        {!failed && !working && (
          <p className="text-[11px] text-text-secondary truncate">
            Editing works now. Render, Still and the component check need it.
          </p>
        )}
        {actionError && (
          <p className="text-[11px] text-red-400 truncate" title={actionError}>
            {actionError}
          </p>
        )}
        {pct !== null && (
          <div
            className="mt-1 h-1 w-full overflow-hidden rounded-full bg-card-active"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label="Motion renderer download"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {status.canInstall && !working && (
        <Button variant={failed ? 'primary' : 'secondary'} disabled={busy} onClick={onInstall}>
          {failed ? 'Retry' : `Download (${formatMegabytes(status.downloadBytes)})`}
        </Button>
      )}
    </div>
  );
}
