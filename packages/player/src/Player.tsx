/**
 * `<Player>` — the one shared preview component all 3 tabs embed (D-039
 * roadmap "Next" item 1). Canvas viewport + title strip + transport bar.
 *
 * **Fully controlled and presentational only.** It renders whatever `surface`
 * the caller hands it (an `<img>`, a `<canvas>`, an `@remotion/player`, a wgpu
 * surface — this package doesn't know or care) and calls back on every
 * interaction; it owns no frame-fetch, no IPC, no timeline model, no
 * playback-loop state. That logic is tab-owned and lives in the caller
 * (`@apelles/editor`'s `chroma_timeline_frame` fetch + rAF play loop is the
 * reference pattern — see `packages/editor/src/PreviewPane.tsx`).
 *
 * Every optional prop's control is **omitted, not disabled**, when its
 * callback isn't supplied — a tab that doesn't support fullscreen just
 * doesn't render the button. This is what lets Motion and Colorist adopt this
 * component later without the Editor's choices constraining them.
 *
 * D-280 added a real PLAYBACK-RATE control to the transport cluster
 * (`RateControl` below, model in `playbackRate.ts`). It replaces a vestigial
 * `0.5 / 1 / 2` cycle button that had shipped with this component from the
 * start and that **no caller had ever passed `rate` to** — so nothing was
 * removed from any tab's UI, only from this file. Like every other control
 * here it stays presentational: the tab holds the value, clamps it, and
 * decides what a rate means for its own playback loop and audio session.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  AudioWaveform,
  Camera,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Volume1,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrubbableNumberInput,
  Slider,
  cn,
} from '@apelles/ui';

import { fmtTimecode } from './timecode';
import {
  formatPlaybackRate,
  isDefaultPlaybackRate,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  PLAYBACK_RATE_PRESETS,
  PLAYBACK_RATE_STEP,
} from './playbackRate';

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
  /**
   * The position bar's drag became a real GESTURE (D-232) — pointer down and
   * moving, or the first keyboard step. Paired with {@link onSeekEnd}, which
   * always follows, including if this component unmounts mid-drag.
   *
   * This exists so a caller can drive *tape-style scrub audio*, which needs to
   * know that a drag is in progress and not merely that the frame changed —
   * `onSeek` alone cannot tell a drag apart from a programmatic seek. The
   * gesture detection is this component's own (it owns the slider); what a
   * gesture *means* is the caller's, which is why these are two bare
   * notifications and not an audio prop. Omit both → nothing changes.
   *
   * A keyboard arrow on the focused slider produces a start/end pair around a
   * single frame step. That is a real, if very short, gesture and is left as
   * one rather than special-cased.
   */
  onSeekStart?: (frame: number) => void;
  /** The position-bar gesture ended — pointer up, keyup, or unmount. */
  onSeekEnd?: () => void;
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
  /**
   * PLAYBACK rate — how many timeline seconds the transport plays per real
   * second (D-280). `1` is ordinary playback. Omit `rate` → the whole control
   * is hidden, matching every other optional control here; supply `rate` with
   * no `onRateChange` and it renders as a read-only readout.
   *
   * **This is the transport's rate, not any clip's Speed/Retime property**
   * (D-236). It changes how fast the user WATCHES and nothing else: no clip is
   * touched, nothing is persisted, nothing about an export changes. The two
   * are easy to confuse and easy to keep apart — see `playbackRate.ts`.
   *
   * The presets, the bounds and the readout format are `playbackRate.ts`'s, not
   * this component's and not the caller's, because the control renders all
   * three; the caller's only job is to hold the value and to clamp what comes
   * back (`clampPlaybackRate`), the same division of labour {@link zoom} has.
   *
   * Placement is deliberate: the control sits in the LEFT cluster with the
   * transport buttons and the timecode, because that is what the owner's
   * reference screenshot points at and because a shuttle rate is a fact about
   * the transport, not about the viewport (which is what the right-hand cluster
   * holds).
   */
  rate?: number;
  onRateChange?: (rate: number) => void;

  /**
   * Viewport magnification of whatever the tab renders into `surface`, as a
   * multiplier where `1` means "fit the viewport" — shown as a percentage
   * (`1` → `100%`).
   *
   * **Presentational only, and deliberately step-less** (D-218). This
   * component owns no zoom math at all: no bounds, no step factor, no
   * clamping, no notion of what the picture even is. The three callbacks
   * below are pure intent — "the user asked to go in / out / back to fit" —
   * and the tab decides what that means for its own surface, which is the
   * only place that CAN decide (the Edit tab's own zoom composes with a
   * `useContentBox`-derived coordinate space that this package hands out but
   * knows nothing about). Omit `zoom` → the whole cluster is hidden, matching
   * every other optional control here.
   *
   * Shape mirrors `TimelinePane.tsx`'s own already-shipped timeline zoom
   * control exactly — a ghost `ZoomOut` button, a `{pct}%` readout, a ghost
   * `ZoomIn` button — so the two zooms in one tab read as the same kind of
   * control. `onZoomReset` additionally makes the readout itself clickable
   * (the timeline's is a plain `<span>`, having no pan to get lost in).
   */
  zoom?: number;
  /** Omit → the zoom-in button is rendered disabled (e.g. at max zoom). */
  onZoomIn?: () => void;
  /** Omit → the zoom-out button is rendered disabled (e.g. at min zoom). */
  onZoomOut?: () => void;
  /** Omit → the percentage readout stays a plain, non-interactive label. */
  onZoomReset?: () => void;

  /**
   * An audio waveform strip for the current position (D-232), rendered
   * **between the picture and the position bar** — the placement
   * DaVinci Resolve's own viewer uses (`scratch/resolve-reference/scrubbing.jpg`:
   * a full-width waveform band directly under the picture, directly above the
   * position bar, with a playhead line through it).
   *
   * Presentational only, exactly like `surface`: this component renders
   * whatever node it is handed and knows nothing about audio, peaks or
   * playheads. Shown only when {@link waveformOn}; the toggle button next to
   * the transport appears only when {@link onWaveformToggle} is supplied,
   * matching every other optional control here.
   */
  waveform?: ReactNode;
  waveformOn?: boolean;
  /** Omit → the waveform toggle button is hidden. */
  onWaveformToggle?: () => void;

  className?: string;
}

/**
 * D-280 — the playback-rate control: a readout that opens a preset list plus a
 * custom field, sitting with the transport buttons.
 *
 * **Why a menu and not a keyboard shuttle.** Resolve, Premiere and Final Cut all
 * drive playback rate from J/K/L rather than from a control in the transport
 * bar — but J is *reverse* play, and neither this component's callers nor the
 * audio engine underneath them can run the transport backwards today. Shipping
 * K and L without J would be a half-implementation of an idiom every editor
 * already has muscle memory for, which is worse than not claiming the keys at
 * all; the menu is the media-player idiom (QuickTime, VLC, YouTube) and is what
 * the owner's reference screenshot asks for. See D-280, and the roadmap line
 * that tracks real JKL shuttling as its own item.
 *
 * Rendered as its own component so the hook-free `Player` body stays flat and
 * so the popover's own state does not re-render the whole transport on every
 * open — this bar re-renders on every playhead tick during playback.
 */
function RateControl({
  rate,
  onRateChange,
}: {
  rate: number;
  onRateChange?: (rate: number) => void;
}) {
  const label = formatPlaybackRate(rate);
  const off = isDefaultPlaybackRate(rate);

  // Read-only: a caller that reports a rate but offers no way to change it.
  // Omitted-not-disabled is this component's rule for whole controls; a
  // readout that is genuinely informative is the one exception the original
  // `rate` prop already made, and it is kept.
  if (!onRateChange) {
    return (
      <span className="px-2 text-xs tabular-nums text-text-secondary" aria-label="Playback rate">
        {label}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-7 gap-1 px-1.5 text-xs tabular-nums', !off && 'text-accent')}
            title={
              off
                ? 'Playback rate — review the timeline faster or slower (audio stays in pitch)'
                : `Playing at ${label} — the timeline itself is unchanged`
            }
            aria-label="Playback rate"
          >
            <Gauge className="size-3.5" />
            {label}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-56 p-2 text-xs">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Playback rate presets">
            {PLAYBACK_RATE_PRESETS.map((preset) => (
              <Button
                key={preset}
                variant={preset === rate ? 'default' : 'ghost'}
                size="sm"
                className="h-6 flex-1 px-2 text-[11px] tabular-nums"
                aria-pressed={preset === rate}
                onClick={() => onRateChange(preset)}
              >
                {formatPlaybackRate(preset)}
              </Button>
            ))}
          </div>
          <label className="flex items-center justify-between gap-2">
            <span className="text-text-secondary">Custom</span>
            <ScrubbableNumberInput
              className="h-6 w-20 px-1 text-[11px]"
              value={rate}
              step={PLAYBACK_RATE_STEP}
              min={MIN_PLAYBACK_RATE}
              max={MAX_PLAYBACK_RATE}
              onValueChange={onRateChange}
              aria-label="Custom playback rate"
            />
          </label>
          {/* The one thing a user could plausibly get wrong about this control,
              said once, where they are looking — the Inspector's Speed field is
              a different feature that edits the cut. */}
          <p className="text-[10px] leading-snug text-text-secondary/70">
            Preview only — this does not change any clip&apos;s speed or the export.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
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
  onSeekStart,
  onSeekEnd,
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
  onZoomIn,
  onZoomOut,
  onZoomReset,
  waveform,
  waveformOn,
  onWaveformToggle,
  className,
}: PlayerProps) {
  const showTitleStrip = Boolean(title || onPrev || onNext || menu);
  const hasDuration = total > 0;

  // D-232 — the position bar's own gesture state. A ref, not state: nothing
  // renders differently mid-drag, and re-rendering the transport on every
  // pointer move of a scrub is exactly the jank the perf rule forbids.
  const seekDragging = useRef(false);
  // The end callback is also fired from an unmount cleanup, which must not
  // re-run every time the caller passes a new closure — so the cleanup reads
  // the latest one through a ref rather than closing over it.
  const onSeekEndRef = useRef(onSeekEnd);
  onSeekEndRef.current = onSeekEnd;
  useEffect(
    () => () => {
      // Unmounting mid-drag (a tab switch, a project close) still ends the
      // gesture — otherwise a scrub started here would outlive the control
      // that started it and hold the audio device open.
      if (seekDragging.current) {
        seekDragging.current = false;
        onSeekEndRef.current?.();
      }
    },
    [],
  );

  // Base UI's Slider is generic over `number | readonly number[]` (range
  // sliders use an array, one value per thumb) — we only ever pass a single
  // value, but the callback type still has to account for the array case.
  const handleSeek = useCallback(
    (value: number | readonly number[]) => {
      const f = Math.round(Array.isArray(value) ? value[0] : (value as number));
      if (!seekDragging.current) {
        seekDragging.current = true;
        onSeekStart?.(f);
      }
      onSeek?.(f);
    },
    [onSeek, onSeekStart],
  );

  /** Base UI fires this on pointerup / keyup — the real end of the gesture,
   *  which `onValueChange` cannot report. */
  const handleSeekCommit = useCallback(() => {
    if (!seekDragging.current) return;
    seekDragging.current = false;
    onSeekEnd?.();
  }, [onSeekEnd]);

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
        // uses) reserves the footprint of `@apelles/shell`'s Sources-panel
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
        // B-118 — the right end needed the mirror of `pl-10`, and never had
        // it. D-118 put the Edit tab's Inspector toggle at `absolute top-2
        // right-2 h-6 w-6` — the same 8px-inset 24px chip as Sources' on the
        // left, so its LEFT edge lands 32px in from this strip's right edge —
        // but this strip kept a bare `pr-3` (12px), so anything in the `menu`
        // slot sat under that chip and the strip read as unpadded and
        // lopsided: 40px of clearance on one side, 12px on the other, with a
        // floating control overlapping the short side. The owner flagged
        // exactly that ("timeline header has no padding, not properly
        // aligned"). `pr-10` is the same 40px reservation `pl-10` makes, for
        // the same 24px chip, so the strip is now symmetric and nothing in it
        // can be covered. `min-h-8` gives it a stable height whether or not it
        // has any `menu` content, so the label does not shift vertically when
        // an action appears beside it.
        <div className="shrink-0 flex min-h-8 items-center justify-between gap-2 pl-10 pr-10 py-1.5 border-b border-border-color bg-surface text-text-primary">
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
          {menu && <div className="flex shrink-0 items-center gap-1">{menu}</div>}
        </div>
      )}

      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-black/40">{surface}</div>

      <div className="shrink-0 flex flex-col border-t border-border-color bg-surface text-text-primary">
        {/* D-232 — the waveform band sits between the picture and the position
            bar, full width, exactly as the Resolve reference has it. Rendered
            above the `border-t` divider's content so the two read as one
            stacked axis (waveform over position bar), which is what makes the
            playhead line and the slider thumb legible as the same position. */}
        {waveformOn && waveform && (
          <div className="border-b border-border-color">{waveform}</div>
        )}
        {onSeek && (
          <div className="px-3 pt-2">
            <Slider
              // B-050/D-131: `@apelles/ui`'s Slider wrapper (matching upstream
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
              // D-232 — the gesture's real end. See `handleSeekCommit`.
              onValueCommitted={handleSeekCommit}
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

          {/* D-280 — the playback-rate control, in the LEFT cluster with the
              transport buttons and the timecode (where the owner's reference
              screenshot puts it), not in the right-hand viewport cluster. It
              follows the timecode rather than splitting play from it: the two
              have always been adjacent and a shuttle rate reads naturally as
              "…and at this speed". */}
          {rate !== undefined && (
            <div className="ml-1">
              <RateControl rate={rate} onRateChange={onRateChange} />
            </div>
          )}

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
          {/* D-232 — the waveform toggle, next to mute/volume because it is the
              same kind of thing: a control over what this viewer tells you
              about the AUDIO at this position. Omitted, not disabled, when the
              caller supplies no handler — this component's standing rule. */}
          {onWaveformToggle && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onWaveformToggle}
              title={waveformOn ? 'Hide the audio waveform' : 'Show the audio waveform'}
              aria-label={waveformOn ? 'Hide the audio waveform' : 'Show the audio waveform'}
              aria-pressed={!!waveformOn}
              className={waveformOn ? 'text-accent' : undefined}
            >
              <AudioWaveform />
            </Button>
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

          {/* D-218 — the preview's own zoom cluster, shaped exactly like the
              one `TimelinePane.tsx`'s toolbar already ships for the timeline
              (ghost ZoomOut / `{pct}%` / ghost ZoomIn, same lucide icons,
              same `w-10 tabular-nums` readout), so the two controls in this
              tab read as the same kind of control rather than two inventions.
              All the math is the caller's — see `PlayerProps.zoom`. */}
          {zoom !== undefined && (
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onZoomOut}
                disabled={!onZoomOut}
                title="Zoom out (or ctrl/pinch-scroll over the preview)"
                aria-label="Zoom out"
              >
                <ZoomOut />
              </Button>
              {onZoomReset ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-10 px-0 text-[11px] tabular-nums text-text-secondary/70"
                  onClick={onZoomReset}
                  title="Reset to fit (100%)"
                  aria-label="Reset zoom to fit"
                >
                  {Math.round(zoom * 100)}%
                </Button>
              ) : (
                <span className="w-10 text-center text-[11px] tabular-nums text-text-secondary/70">
                  {Math.round(zoom * 100)}%
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onZoomIn}
                disabled={!onZoomIn}
                title="Zoom in (or ctrl/pinch-scroll over the preview)"
                aria-label="Zoom in"
              >
                <ZoomIn />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
