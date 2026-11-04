/**
 * @apelles/editor — a media tile's conversion state (D-453), drawn inside its
 * `MediaThumbnail` well.
 *
 * What it is: the Sources tile's "converting 42%" — a source the macOS media
 * engine cannot open is converted once into optimized media, and until that is
 * done the tile says so: waiting, a determinate bar with the percentage and a
 * Cancel, or (failed / cancelled) a warning with a way to convert it again.
 *
 * What it does NOT do: act on its own. Cancel and convert-again are the
 * caller's (the Sources panel wires them to `useMediaPoolStore`'s
 * `cancelConversion` and `reprobeMedia`, the same store actions
 * `editor_cancel_media_conversion` and `editor_reprobe_media` reach).
 */
import { ArrowsClockwiseIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import type { MediaConversion } from '@apelles/bridge';
import { Progress, cn } from '@apelles/ui';

export interface MediaConversionOverlayProps {
  conversion: MediaConversion;
  name: string;
  onCancel: () => void;
  onConvertAgain: () => void;
}

export function MediaConversionOverlay({ conversion, name, onCancel, onConvertAgain }: MediaConversionOverlayProps) {
  if (conversion.state === 'ready') return null;
  const percent = Math.floor(conversion.progress * 100);
  const active = conversion.state === 'queued' || conversion.state === 'converting';
  const label =
    conversion.state === 'converting'
      ? `Converting ${percent}%`
      : conversion.state === 'queued'
        ? 'Waiting to convert'
        : conversion.state === 'failed'
          ? 'Failed'
          : 'Cancelled';
  return (
    <div
      data-chroma-tile-conversion={conversion.state}
      className="absolute inset-0 flex flex-col justify-end gap-1 bg-bg-primary/70 p-1.5"
      title={conversion.error ?? `${name}: ${label.toLowerCase()} — it can be previewed once it is converted`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 text-[10px] leading-tight text-text-primary">
        {!active && <WarningIcon className="size-3 shrink-0 text-amber-400" aria-hidden />}
        <span className="min-w-0 flex-1 truncate tabular-nums">{label}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (active) onCancel();
            else onConvertAgain();
          }}
          aria-label={active ? `Cancel converting ${name}` : `Convert ${name} again`}
          title={active ? 'Cancel the conversion' : 'Convert again'}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border border-border-color bg-bg-primary',
            active ? 'hover:border-destructive hover:text-destructive' : 'hover:border-accent',
          )}
        >
          {active ? <XIcon className="size-2.5" /> : <ArrowsClockwiseIcon className="size-2.5" />}
        </button>
      </div>
      {active && (
        <Progress value={conversion.state === 'queued' ? null : percent} aria-label={`${name}: ${label}`} />
      )}
    </div>
  );
}
