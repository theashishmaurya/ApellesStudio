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
 *
 * **Layout (D-432 P5, `docs/notes/ui-redesign.md` §4.11).** Three rows, flat
 * `surface` panels split by `divider` lines, as Final Cut's viewer:
 * - **Header (28 px):** caller's `headerStart`, the format line, the title
 *   centred, then zoom, the caller's view controls, the waveform toggle, the
 *   `menu` slot and the caller's `headerEnd`.
 * - **Picture**, then the optional waveform band, then a **3 px scrub bar**
 *   (`ScrubBar`, 12 px hit area) — the owner chose to keep a thin one rather
 *   than the old thick slider or none (D-432 answers).
 * - **Transport (40 px):** the timecode in `--color-playhead` on the left;
 *   previous edit, frame back, play (28 px), frame forward, next edit centred;
 *   rate, volume, snapshot and fullscreen on the right.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  WaveformIcon,
  CameraIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CornersOutIcon,
  CornersInIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SpeakerLowIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  MinusIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import {
  Button,
  InlineSlider,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrubBar,
  ScrubbableNumberInput,
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
  /** Clip / shot / composition name, centred in the viewer header. */
  title?: string;
  /** D-432 P5 — the format line at the header's left (`3840×2160 · 24p`),
   *  in place of a size chip painted over the picture. */
  formatLabel?: string;
  /** D-432 P5 — caller-owned controls at the header's far left (the Edit
   *  tab's browser toggle). */
  headerStart?: ReactNode;
  /** D-432 P5 — caller-owned controls at the header's far right (the Edit
   *  tab's Inspector toggle). */
  headerEnd?: ReactNode;
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
  /** The transport's outer-left button (`SkipBack`). Omit → button hidden.
   *  What it skips to is the caller's: the Edit tab goes to the previous edit
   *  point, and says so through {@link skipLabels}. */
  onSkipStart?: () => void;
  /** The outer-right button (`SkipForward`). Omit → button hidden. */
  onSkipEnd?: () => void;
  /** The two skip buttons' accessible names / tooltips. Default
   *  `Skip to start` / `Skip to end`. */
  skipLabels?: { start: string; end: string };

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
   * Placement: the transport row's right group, before volume (D-432 P5,
   * spec §4.11). D-280 put it beside the timecode on the left; the redesign's
   * transport puts only the timecode there and centres the buttons.
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
   * Drawn in the viewer header's right group (D-432 P5): a small minus, the
   * readout — `Fit` at `1`, else `{pct}%` — and a small plus. `onZoomReset`
   * makes the readout a button that returns to fit.
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
   * **between the picture and the scrub bar** — the placement
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
  /** D-431 — extra caller-owned view controls (the Edit tab's Safe Area
   *  menu), rendered in the viewer header's right group with the zoom and the
   *  waveform toggle (D-432 P5). Presentational: this component owns no state
   *  for them. */
  viewControls?: ReactNode;

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
            className={cn('h-6 px-1.5 text-xs tabular-nums text-text-secondary hover:text-text-primary', !off && 'text-accent-text')}
            title={
              off
                ? 'Playback rate — review the timeline faster or slower (audio stays in pitch)'
                : `Playing at ${label} — the timeline itself is unchanged`
            }
            aria-label="Playback rate"
          >
            {label}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-56 p-2 text-xs">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Playback rate presets">
            {PLAYBACK_RATE_PRESETS.map((preset) => (
              <Button
                key={preset}
                variant={preset === rate ? 'default' : 'ghost'}
                size="sm"
                className="h-6 flex-1 px-2 text-xs tabular-nums"
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
              className="h-6 w-20 px-1 text-xs"
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
          <p className="text-2xs leading-snug text-text-tertiary">
            Preview only — this does not change any clip&apos;s speed or the export.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const DEFAULT_SKIP_LABELS = { start: 'Skip to start', end: 'Skip to end' } as const;

/** A 24 px ghost icon button, the size every header / transport control uses. */
/** The transport's volume (D-432 §4.11, v0.3.0 / B-354): `SpeakerHigh` opens a
 *  popover with the mute toggle, a slider and the level in percent, as Final
 *  Cut's and Resolve's viewers do, instead of a slider that slid out on hover
 *  and was unreachable from the keyboard. With no `onVolumeChange` the button
 *  just toggles mute (nothing else to show). */
function VolumeControl({
  volume,
  muted,
  onVolumeChange,
  onMuteToggle,
}: {
  volume: number;
  muted: boolean;
  onVolumeChange?: (volume: number) => void;
  onMuteToggle?: () => void;
}) {
  const Icon = muted ? SpeakerSlashIcon : volume < 0.5 ? SpeakerLowIcon : SpeakerHighIcon;
  if (!onVolumeChange) {
    return (
      <IconButton label={muted ? 'Unmute' : 'Mute'} onClick={onMuteToggle} pressed={muted}>
        <Icon />
      </IconButton>
    );
  }
  const pct = Math.round((muted ? 0 : volume) * 100);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            title={muted ? 'Volume (muted)' : `Volume ${pct}%`}
            aria-label="Volume"
            data-chroma-volume-trigger=""
            className={cn(
              'size-6 text-text-secondary hover:text-text-primary data-[popup-open]:bg-bg-secondary [&_svg]:size-4',
              muted && 'text-accent-text',
            )}
          >
            <Icon />
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-48 p-2 text-xs" data-chroma-volume-popover="">
        <div className="flex items-center gap-2">
          {onMuteToggle && (
            <IconButton label={muted ? 'Unmute' : 'Mute'} onClick={onMuteToggle} pressed={muted}>
              <Icon />
            </IconButton>
          )}
          <InlineSlider
            value={muted ? 0 : volume}
            min={0}
            max={1}
            step={0.01}
            aria-label="Volume level"
            getAriaValueText={(v) => `${Math.round(v * 100)}%`}
            onValueChange={onVolumeChange}
            onReset={() => onVolumeChange(1)}
          />
          <span className="w-9 shrink-0 text-right font-mono tabular-nums text-text-secondary">{pct}%</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IconButton({
  label,
  onClick,
  pressed,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        'size-6 text-text-secondary hover:text-text-primary [&_svg]:size-4',
        pressed && 'text-accent-text',
        className,
      )}
    >
      {children}
    </Button>
  );
}

export function Player({
  surface,
  title,
  formatLabel,
  headerStart,
  headerEnd,
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
  skipLabels = DEFAULT_SKIP_LABELS,
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
  viewControls,
  className,
}: PlayerProps) {
  const showHeader = Boolean(
    title || formatLabel || headerStart || headerEnd || onPrev || onNext || menu || zoom !== undefined || viewControls || onWaveformToggle,
  );
  const hasDuration = total > 0;

  // D-232 — the scrub bar's own gesture state. A ref, not state: nothing
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

  const handleSeek = useCallback(
    (value: number) => {
      const f = Math.round(value);
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

  const showMute = Boolean(onMuteToggle);
  const zoomLabel = zoom === undefined ? '' : zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`;

  return (
    // `data-preview-hole`: a host that shows its picture on a native layer
    // under the webview makes these two transparent (D-451).
    <div data-preview-hole className={cn('flex min-h-0 flex-1 flex-col bg-bg-primary', className)}>
      {showHeader && (
        // A three-column grid so the title stays truly centred whatever the
        // two side groups hold; each side truncates rather than pushing it.
        <div
          data-player-header
          className="grid h-7 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-divider bg-surface px-1.5 text-text-primary"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {headerStart}
            {formatLabel && (
              <span data-player-format className="min-w-0 truncate text-xs text-text-secondary">
                {formatLabel}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-center gap-1">
            {onPrev && (
              <IconButton label="Previous" onClick={onPrev}>
                <CaretLeftIcon />
              </IconButton>
            )}
            {title && <span className="min-w-0 truncate text-xs font-medium text-text-primary">{title}</span>}
            {onNext && (
              <IconButton label="Next" onClick={onNext}>
                <CaretRightIcon />
              </IconButton>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-end gap-0.5">
            {/* D-218 — the preview's own zoom. All the math is the caller's —
                see `PlayerProps.zoom`. */}
            {zoom !== undefined && (
              <div className="flex items-center" role="group" aria-label="Viewer zoom">
                <IconButton label="Zoom out" onClick={onZoomOut} disabled={!onZoomOut} className="size-5 [&_svg]:size-3">
                  <MinusIcon />
                </IconButton>
                {onZoomReset ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 min-w-9 px-1 text-xs tabular-nums text-text-secondary hover:text-text-primary"
                    onClick={onZoomReset}
                    title="Back to fit"
                    aria-label="Reset zoom to fit"
                  >
                    {zoomLabel}
                  </Button>
                ) : (
                  <span className="min-w-9 text-center text-xs tabular-nums text-text-secondary">{zoomLabel}</span>
                )}
                <IconButton label="Zoom in" onClick={onZoomIn} disabled={!onZoomIn} className="size-5 [&_svg]:size-3">
                  <PlusIcon />
                </IconButton>
              </div>
            )}
            {viewControls}
            {/* D-232 — what this viewer tells you about the AUDIO at this
                position, a view toggle like the safe areas beside it. */}
            {onWaveformToggle && (
              <IconButton
                label={waveformOn ? 'Hide the audio waveform' : 'Show the audio waveform'}
                onClick={onWaveformToggle}
                pressed={!!waveformOn}
              >
                <WaveformIcon />
              </IconButton>
            )}
            {menu}
            {headerEnd}
          </div>
        </div>
      )}

      <div data-preview-hole className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
        {surface}
      </div>

      <div className="flex shrink-0 flex-col border-t border-divider bg-surface text-text-primary">
        {/* D-232 — the waveform band sits between the picture and the scrub
            bar, full width, as the Resolve reference has it. */}
        {waveformOn && waveform && <div className="border-b border-divider">{waveform}</div>}
        {onSeek && (
          <ScrubBar
            value={frame}
            min={0}
            max={hasDuration ? total : 1}
            step={1}
            largeStep={10}
            disabled={!hasDuration}
            onValueChange={handleSeek}
            onValueCommitted={handleSeekCommit}
            aria-label="Seek"
            className="-mt-1.5"
          />
        )}

        <div data-player-transport className="grid h-10 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3">
          {/* `fmtTimecode` always returns exactly "HH:MM:SS:FF", and the mono
              stack gives every character the same advance, so the readout's
              width is constant and the row never jitters while it ticks. */}
          <span
            data-player-timecode
            className="min-w-0 truncate font-mono text-base font-semibold tabular-nums text-playhead"
          >
            {fmtTimecode(frame, fps)}
          </span>

          <div className="flex items-center gap-1">
            {onSkipStart && (
              <IconButton label={skipLabels.start} onClick={onSkipStart}>
                <SkipBackIcon />
              </IconButton>
            )}
            <IconButton label="Step back one frame" onClick={() => onStep(-1)}>
              <CaretLeftIcon />
            </IconButton>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onPlayPause}
              title={playing ? 'Pause' : 'Play'}
              aria-label={playing ? 'Pause' : 'Play'}
              className="size-7 rounded-sm bg-bg-secondary text-text-primary hover:bg-card-active [&_svg]:size-4"
            >
              {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
            </Button>
            <IconButton label="Step forward one frame" onClick={() => onStep(1)}>
              <CaretRightIcon />
            </IconButton>
            {onSkipEnd && (
              <IconButton label={skipLabels.end} onClick={onSkipEnd}>
                <SkipForwardIcon />
              </IconButton>
            )}
          </div>

          <div className="flex min-w-0 items-center justify-end gap-0.5">
            {/* D-280 — the playback rate. */}
            {rate !== undefined && <RateControl rate={rate} onRateChange={onRateChange} />}
            {showMute && (
              <VolumeControl
                volume={volume ?? 1}
                muted={!!muted}
                onVolumeChange={onVolumeChange}
                onMuteToggle={onMuteToggle}
              />
            )}
            {onSnapshot && (
              <IconButton label="Snapshot" onClick={onSnapshot}>
                <CameraIcon />
              </IconButton>
            )}
            {onFullscreen && (
              <IconButton
                label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={onFullscreen}
                pressed={isFullscreen}
              >
                {isFullscreen ? <CornersInIcon /> : <CornersOutIcon />}
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
