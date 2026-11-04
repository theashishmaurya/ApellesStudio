/**
 * @apelles/editor — the preview's "this clip is still being converted" state
 * (D-453).
 *
 * What it is: `usePendingConversionsAtPlayhead`, the sources under the playhead
 * whose one conversion to optimized media has not finished, and
 * `PreviewConversionNotice`, what the preview shows in place of the picture
 * while there are any: the file, how far along it is, and a Cancel (or, for a
 * failed or cancelled one, a way to convert it again) — never a black frame or
 * a raw decode error. The Cancel is the Sources tile's own store action
 * (`cancelConversion`), and `editor_cancel_media_conversion` the same thing for
 * an agent.
 *
 * What it does NOT do: render the picture, or poll. The pool item's
 * `conversion` is pushed by the backend's progress event (`@apelles/bridge`).
 */
import { useMemo } from 'react';
import { ArrowsClockwiseIcon, CircleNotchIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import { awaitsConversion, useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { Button, Progress } from '@apelles/ui';

import { conversionsAt, conversionsKey, type PendingConversion } from './conversionNotice';
import { useEditorTimelineStore } from './timelineStore';

/** A key for the pool items that await a conversion — empty when none do, which
 *  is the common case and lets the timeline selector below do no work. */
function waitingKey(items: readonly MediaItem[]): string {
  let key = '';
  for (const it of items) {
    if (awaitsConversion(it) && it.conversion) {
      key += `${it.id}:${it.conversion.state}:${Math.floor(it.conversion.progress * 100)}|`;
    }
  }
  return key;
}

/** The pending conversions at the playhead right now, read from both stores
 *  outside React (the hook below re-derives it only when its key changes). */
function pendingNow(): PendingConversion[] {
  const { timeline, playhead } = useEditorTimelineStore.getState();
  return conversionsAt(timeline, playhead, useMediaPoolStore.getState().items);
}

/** `conversionsAt`'s key for the playhead in `timeline`'s store state, against
 *  the pool as it is now. */
function pendingKeyAt(timeline: Parameters<typeof conversionsAt>[0], playhead: number): string {
  return conversionsKey(conversionsAt(timeline, playhead, useMediaPoolStore.getState().items));
}

/** The sources under the playhead that cannot be shown yet. Re-renders its
 *  caller only when that answer changes, not on every playhead tick. */
export function usePendingConversionsAtPlayhead(): PendingConversion[] {
  const poolKey = useMediaPoolStore((s) => waitingKey(s.items));
  const key = useEditorTimelineStore((s) => (poolKey ? pendingKeyAt(s.timeline, s.playhead) : ''));
  return useMemo(() => (key ? pendingNow() : []), [key]);
}

function NoticeRow({ pending }: { pending: PendingConversion }) {
  const cancelConversion = useMediaPoolStore((s) => s.cancelConversion);
  const reprobeMedia = useMediaPoolStore((s) => s.reprobeMedia);
  const { conversion, name, mediaId } = pending;
  const percent = Math.floor(conversion.progress * 100);
  const active = conversion.state === 'queued' || conversion.state === 'converting';
  const headline =
    conversion.state === 'converting'
      ? `Converting ${name} for playback — ${percent}%`
      : conversion.state === 'queued'
        ? `${name} is waiting to be converted for playback`
        : conversion.state === 'failed'
          ? `${name} could not be converted`
          : `${name} was not converted`;
  return (
    <div data-chroma-conversion-notice={conversion.state} className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-2 text-sm text-text-primary">
        {active ? (
          <CircleNotchIcon className="size-4 shrink-0 animate-spin text-text-secondary" aria-hidden />
        ) : (
          <WarningIcon className="size-4 shrink-0 text-amber-400" aria-hidden />
        )}
        <span className="min-w-0 truncate">{headline}</span>
      </div>
      {active && <Progress value={conversion.state === 'queued' ? null : percent} aria-label={headline} />}
      {conversion.state === 'failed' && conversion.error && (
        <p className="line-clamp-3 text-2xs text-text-secondary" title={conversion.error}>
          {conversion.error}
        </p>
      )}
      <div className="flex justify-end">
        {active ? (
          <Button variant="ghost" size="xs" onClick={() => void cancelConversion([mediaId])} className="gap-1">
            <XIcon className="size-3" aria-hidden /> Cancel
          </Button>
        ) : (
          <Button variant="secondary" size="xs" onClick={() => void reprobeMedia([mediaId])} className="gap-1">
            <ArrowsClockwiseIcon className="size-3" aria-hidden /> Convert again
          </Button>
        )}
      </div>
    </div>
  );
}

/** What the preview shows instead of the picture while a source under the
 *  playhead is still converting: a source the macOS media engine cannot open
 *  is converted once on import (Final Cut's optimized media), and it cannot be
 *  drawn until that is done. */
export function PreviewConversionNotice({ pending }: { pending: readonly PendingConversion[] }) {
  return (
    <div
      data-chroma-preview-conversion
      className="flex w-full max-w-sm flex-col gap-4 rounded-md border border-border-color bg-surface p-4"
    >
      {pending.map((p) => (
        <NoticeRow key={p.mediaId} pending={p} />
      ))}
      <p className="text-2xs text-text-tertiary">
        This format is converted once so the Mac's media engine can play it; the original file is left as it is.
      </p>
    </div>
  );
}
