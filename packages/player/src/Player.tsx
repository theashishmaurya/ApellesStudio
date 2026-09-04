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
  Minimize,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Volume1,
  Volume2,
  VolumeX,
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
  /** Omit → button hidden. Reflects real fullscreen state — the caller
   *  should keep this in sync with the browser's own `fullscreenchange`
   *  event, not just its own click handler, since Esc/other exits happen
   *  outside this component's control. */
  onFullscreen?: () => void;
  isFullscreen?: boolean;
  /** Master preview-monitoring volume, `0..1` — omit `onMuteToggle` →
   *  the whole mute/volume control hidden, matching every other optional
   *  control here. `volume`/`onVolumeChange` are independently optional on
   *  top of that: a caller can offer mute-only with no slider by omitting
   *  them (`volume` then just informs the muted-icon's own visual state via
   *  `muted`). This is playback *monitoring* volume, not project data — see
   *  `chroma_audio_set_volume`'s own doc in `audio.rs` for why it's a
   *  separate primitive from any project-level per-track gain. */
  muted?: boolean;
  onMuteToggle?: () => void;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
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
  isFullscreen,
  muted,
  onMuteToggle,
  volume,
  onVolumeChange,
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

  const handleVolumeSeek = useCallback(
    (value: number | readonly number[]) => {
      const v = Array.isArray(value) ? value[0] : (value as number);
      onVolumeChange?.(v);
    },
    [onVolumeChange],
  );

  const showMute = Boolean(onMuteToggle);
  const VolumeIcon = muted ? VolumeX : (volume ?? 1) < 0.5 ? Volume1 : Volume2;

  return (
    <div className={cn('flex flex-col min-h-0 flex-1 bg-bg-primary', className)}>
      {showTitleStrip && (
        // B-051/D-131: `pl-10` (not the uniform `px-3` every other edge
        // uses) reserves the footprint of `@chroma/shell`'s Sources-panel
        // toggle — `absolute top-2 left-2 h-6 w-6` (`Shell.tsx`), i.e. an
        // 8px-inset 24px chip whose right edge lands at x=32px. D-120
        // deliberately floats that toggle over whichever tab is active, at
        // the content area's top-left corner, specifically so it's reachable
        // no matter which tab or panel state is showing — so it always sits
        // on top of *this* strip's top-left corner too, not just in Edit.
        // D-126 made the chip legible (opaque bg+border+shadow) but never
        // gave this strip the matching padding, so its own "Timeline" text
        // still started at the strip's default 12px and sat directly under
        // the chip. `pl-10` = 40px clears the chip's 32px edge with an 8px
        // gap; unconditional (not just when a Sources panel is actually
        // mounted) because the toggle is genuinely shell-level, not
        // Edit-tab-specific, so any tab embedding this shared component can
        // have it floating over this same corner.
        <div className="shrink-0 flex items-center justify-between gap-2 pl-10 pr-3 py-1.5 border-b border-border-color bg-surface text-text-primary">
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
              // B-050/D-131: `@chroma/ui`'s Slider wrapper (matching upstream
              // shadcn's own convention) only recognises an *array* value/
              // defaultValue as "a real controlled value" — a bare number
              // falls through to its `[min, max]` fallback and renders 2
              // `Thumb`s instead of 1 (Base UI's `Root` itself accepts a raw
              // number fine; only this wrapper's own thumb-count `_values`
              // memo cared). Both extra thumbs land on index 0 (Base UI's
              // `SliderThumb` forces `index = 0` whenever the real slider
              // state has a single value, `range = sliderValues.length > 1`),
              // so the two DOM thumbs stacked exactly on top of each other —
              // harmless-looking, but duplicate focusable/ARIA nodes.
              value={[frame]}
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

          {showMute && (
            <div className="flex items-center gap-1 group/volume">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onMuteToggle}
                title={muted ? 'Unmute' : 'Mute'}
                aria-label={muted ? 'Unmute' : 'Mute'}
                aria-pressed={muted}
              >
                <VolumeIcon />
              </Button>
              {onVolumeChange && (
                <div className="w-0 overflow-hidden group-hover/volume:w-16 focus-within:w-16 transition-[width] duration-150">
                  <Slider
                    // B-050/D-131: see the seek slider's comment above — same
                    // wrap-in-array fix, same reason.
                    value={[muted ? 0 : (volume ?? 1)]}
                    min={0}
                    max={1}
                    step={0.01}
                    onValueChange={handleVolumeSeek}
                    aria-label="Volume"
                  />
                </div>
              )}
            </div>
          )}
          {onSnapshot && (
            <Button variant="ghost" size="icon-sm" onClick={onSnapshot} title="Snapshot" aria-label="Snapshot">
              <Camera />
            </Button>
          )}
          {onFullscreen && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize /> : <Maximize />}
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
