/**
 * `<Player>` — the one shared preview component all 3 tabs embed (D-039
 * roadmap "Next" item 1). Canvas viewport + title strip + transport bar.
 *
 * **Fully controlled and presentational only.** It renders whatever `surface`
 * the caller hands it (an `<img>`, a `<canvas>`, an `@remotion/player`, a wgpu
 * surface — this package doesn't know or care) and calls back on every
 * interaction; it owns no frame-fetch, no IPC, no timeline model, no
 * playback-loop state. That logic is tab-owned and lives in the caller
 * (`@chroma/editor`'s `chroma_timeline_frame` fetch + rAF play loop is the
 * reference pattern — see `packages/editor/src/PreviewPane.tsx`).
 *
 * Every optional prop's control is **omitted, not disabled**, when its
 * callback isn't supplied — a tab that doesn't support fullscreen just
 * doesn't render the button. This is what lets Motion and Colorist adopt this
 * component later without the Editor's choices constraining them.
 */

import { useCallback, type ReactNode } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from 'lucide-react';
import { Button, Slider, cn } from '@chroma/ui';

import { fmtTimecode } from './timecode';

export interface PlayerProps {
  /** Whatever the tab renders inside the viewport — an `<img>`, `<canvas>`, `@remotion/player`, etc. */
  surface: ReactNode;
  /** Clip / shot / composition name, shown in the title strip. */
  title?: string;
  /** '‹' nav — only rendered if provided. */
  onPrev?: () => void;
  /** '›' nav — only rendered if provided. */
  onNext?: () => void;
  /** The '…' slot — caller supplies its own dropdown content (trigger included). */
  menu?: ReactNode;

  frame: number;
  /** Last valid frame index. */
  total: number;
  /** For the timecode readout; omit → frame counter only. */
  fps?: number;
  playing: boolean;
  onPlayPause: () => void;
  /** ±1 frame. */
  onStep: (delta: number) => void;
  /** Optional scrub bar; omit → no scrub bar rendered. */
  onSeek?: (frame: number) => void;
  /** Omit → button hidden. */
  onSkipStart?: () => void;
  /** Omit → button hidden. */
  onSkipEnd?: () => void;

  /** Omit → button hidden. */
  onSnapshot?: () => void;
  /** Omit → button hidden. */
  onFullscreen?: () => void;
  /** e.g. 1 — omit → rate control hidden. */
  rate?: number;
  onRateChange?: (rate: number) => void;
  /** 'fit' or a percentage — omit → zoom control hidden. */
  zoom?: 'fit' | number;
  onZoomChange?: (zoom: 'fit' | number) => void;

  className?: string;
}

const RATE_STEPS = [0.5, 1, 2] as const;
const ZOOM_STEPS: ReadonlyArray<'fit' | number> = ['fit', 50, 100, 200];

function cycle<T>(steps: readonly T[], current: T): T {
  const i = steps.indexOf(current);
  return steps[(i + 1) % steps.length] ?? steps[0];
}

function formatZoom(zoom: 'fit' | number): string {
  return zoom === 'fit' ? 'Fit' : `${Math.round(zoom)}%`;
}

export function Player({
  surface,
  title,
  onPrev,
  onNext,
  menu,
  frame,
  total,
  fps,
  playing,
  onPlayPause,
  onStep,
  onSeek,
  onSkipStart,
  onSkipEnd,
  onSnapshot,
  onFullscreen,
  rate,
  onRateChange,
  zoom,
  onZoomChange,
  className,
}: PlayerProps) {
  const showTitleStrip = Boolean(title || onPrev || onNext || menu);
  const hasDuration = total > 0;

  // Base UI's Slider is generic over `number | readonly number[]` (range
  // sliders use an array, one value per thumb) — we only ever pass a single
  // value, but the callback type still has to account for the array case.
  const handleSeek = useCallback(
    (value: number | readonly number[]) => {
      const f = Array.isArray(value) ? value[0] : (value as number);
      onSeek?.(Math.round(f));
    },
    [onSeek],
  );

  return (
    <div className={cn('flex flex-col min-h-0 flex-1 bg-bg-primary', className)}>
      {showTitleStrip && (
        <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border-color bg-surface text-text-primary">
          <div className="flex items-center gap-1 min-w-0">
            {onPrev && (
              <Button variant="ghost" size="icon-xs" onClick={onPrev} title="Previous" aria-label="Previous">
                <ChevronLeft />
              </Button>
            )}
            <span className="min-w-0 truncate text-xs font-medium text-text-secondary">{title}</span>
            {onNext && (
              <Button variant="ghost" size="icon-xs" onClick={onNext} title="Next" aria-label="Next">
                <ChevronRight />
              </Button>
            )}
          </div>
          {menu}
        </div>
      )}

      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-black/40">{surface}</div>

      <div className="shrink-0 flex flex-col border-t border-border-color bg-surface text-text-primary">
        {onSeek && (
          <div className="px-3 pt-2">
            <Slider
              value={frame}
              min={0}
              max={hasDuration ? total : 1}
              step={1}
              disabled={!hasDuration}
              onValueChange={handleSeek}
              aria-label="Seek"
            />
          </div>
        )}

        <div className="flex items-center gap-1 px-3 py-2">
          {onSkipStart && (
            <Button variant="ghost" size="icon-sm" onClick={onSkipStart} title="Skip to start" aria-label="Skip to start">
              <SkipBack />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => onStep(-1)} title="Step back one frame" aria-label="Step back one frame">
            <StepBack />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onPlayPause}
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onStep(1)} title="Step forward one frame" aria-label="Step forward one frame">
            <StepForward />
          </Button>
          {onSkipEnd && (
            <Button variant="ghost" size="icon-sm" onClick={onSkipEnd} title="Skip to end" aria-label="Skip to end">
              <SkipForward />
            </Button>
          )}

          <span className="ml-2 text-xs tabular-nums text-text-secondary">
            {fmtTimecode(frame, fps)} / {fmtTimecode(total, fps)}
          </span>

          <div className="flex-1" />

          {onSnapshot && (
            <Button variant="ghost" size="icon-sm" onClick={onSnapshot} title="Snapshot" aria-label="Snapshot">
              <Camera />
            </Button>
          )}
          {onFullscreen && (
            <Button variant="ghost" size="icon-sm" onClick={onFullscreen} title="Fullscreen" aria-label="Fullscreen">
              <Maximize />
            </Button>
          )}

          {rate !== undefined &&
            (onRateChange ? (
              <Button
                variant="ghost"
                size="sm"
                className="tabular-nums"
                onClick={() => onRateChange(cycle(RATE_STEPS, rate as (typeof RATE_STEPS)[number]))}
                title="Playback rate"
                aria-label="Playback rate"
              >
                {rate}×
              </Button>
            ) : (
              <span className="px-2 text-xs tabular-nums text-text-secondary">{rate}×</span>
            ))}

          {zoom !== undefined &&
            (onZoomChange ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onZoomChange(cycle(ZOOM_STEPS, zoom))}
                title="Zoom"
                aria-label="Zoom"
              >
                <Search />
                {formatZoom(zoom)}
              </Button>
            ) : (
              <span className="px-2 text-xs text-text-secondary">{formatZoom(zoom)}</span>
            ))}
        </div>
      </div>
    </div>
  );
}
