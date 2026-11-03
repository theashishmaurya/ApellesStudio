'use client';

import * as React from 'react';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';

import { cn } from '../../lib/utils';
import { NumberScrubber, type NumberScrubberProps } from './number-scrubber';

/**
 * The Inspector's inline slider and its slider + number pair (D-432 §4.10,
 * v0.3.0 gap closure, B-359 item 2; `docs/notes/ui-redesign.md` §6e).
 *
 * **What it is.**
 * - `InlineSlider`: Base UI's `Slider` (pointer capture, keyboard stepping,
 *   the ARIA slider role all come from the library) drawn the way the spec
 *   draws an Inspector slider: a 3 px track with no fill and a 12 px
 *   `text-primary` thumb with a hairline ring. Double-click resets
 *   (`onReset`), as Final Cut's and Resolve's Inspector sliders do.
 * - `SliderField`: an `InlineSlider` beside a 56 px `NumberScrubber`, the row
 *   control for a property with a natural range (Scale, Rotation, Opacity).
 *   Both halves drive one value through one `onChange`.
 *
 * **One gesture, one bracket.** A slider drag (or one key press on the thumb)
 * calls `onScrubStart` before its first change and `onScrubEnd` after its last,
 * the same pair a field scrub calls, so a caller that brackets undo with them
 * (`@apelles/editor`'s `InspectorNumber`) gets exactly one undo entry per drag
 * from either half. Changes during a drag are coalesced to one `onChange` per
 * animation frame (the spec's "one store op per frame"); the last value is
 * flushed synchronously before `onScrubEnd`.
 *
 * **The slider's range is not the value's range.** `sliderMin` / `sliderMax`
 * are the comfortable span a hand drags through (Scale 0–4); the field keeps
 * its own `min` / `max`, so a typed `6` is legal and simply pins the thumb at
 * the end.
 *
 * **The detent** (v0.3.0 Inspector redesign, B-366): a slider given a
 * `detent` (the property's default: Scale 100 %, Rotation 0°, Opacity 100 %,
 * Volume 0 dB) draws a hairline tick there and snaps a drag that passes
 * within {@link SLIDER_FIELD.DETENT_SNAP_FRACTION} of the span onto it, as
 * Final Cut's and Logic's faders catch unity. Typing is never snapped.
 *
 * **What it does NOT do.** Hold a value (controlled only), know what the
 * number means, or animate anything.
 */

/** Restated geometry for tests (the classes below are the source). */
export const SLIDER_FIELD = {
  /** `h-[3px]` track */
  TRACK_PX: 3,
  /** `size-3` thumb */
  THUMB_PX: 12,
  /** `w-14` value field */
  FIELD_PX: 56,
  /** A drag this close to the detent (as a fraction of the slider span)
   *  lands exactly on it: 2 % is ~2 px on the Inspector's ~100 px track. */
  DETENT_SNAP_FRACTION: 0.02,
} as const;

/** `value` snapped onto `detent` when within the snap band of `[min, max]`. */
export function snapToDetent(value: number, detent: number | undefined, min: number, max: number): number {
  if (detent === undefined || !Number.isFinite(value)) return value;
  return Math.abs(value - detent) <= Math.abs(max - min) * SLIDER_FIELD.DETENT_SNAP_FRACTION ? detent : value;
}

export interface InlineSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shift + arrow / PageUp / PageDown step; default ten steps. */
  largeStep?: number;
  onValueChange: (value: number) => void;
  /** The gesture ended: pointer up, or a key press finished. */
  onValueCommitted?: () => void;
  /** Double-click: back to the default. */
  onReset?: () => void;
  /** The default value: a tick on the track and a snap point for a drag. */
  detent?: number;
  disabled?: boolean;
  'aria-label'?: string;
  /** What a screen reader hears for the value (`"112 %"`). */
  getAriaValueText?: (value: number) => string;
  className?: string;
  'data-testid'?: string;
}

function InlineSlider({
  value,
  min,
  max,
  step = 1,
  largeStep,
  onValueChange,
  onValueCommitted,
  onReset,
  detent,
  disabled = false,
  'aria-label': ariaLabel,
  getAriaValueText,
  className,
  'data-testid': testId,
}: InlineSliderProps) {
  const shown = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const detentPct = detent !== undefined && max > min && detent >= min && detent <= max ? ((detent - min) / (max - min)) * 100 : null;
  return (
    <SliderPrimitive.Root
      data-slot="inline-slider"
      data-testid={testId}
      value={shown}
      min={min}
      max={max}
      step={step}
      largeStep={largeStep ?? step * 10}
      disabled={disabled}
      onValueChange={(v) => onValueChange(snapToDetent(Array.isArray(v) ? (v[0] as number) : (v as number), detent, min, max))}
      onValueCommitted={() => onValueCommitted?.()}
      className={cn('group/inline-slider min-w-0 flex-1', className)}
    >
      <SliderPrimitive.Control
        className="relative flex h-3 w-full touch-none items-center select-none data-disabled:opacity-50"
        onDoubleClick={disabled || !onReset ? undefined : () => onReset()}
      >
        <SliderPrimitive.Track
          data-slot="inline-slider-track"
          className="bg-border-color relative h-[3px] w-full rounded-full"
        />
        {detentPct !== null && (
          <span
            aria-hidden
            data-slot="inline-slider-detent"
            className="bg-text-tertiary pointer-events-none absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${detentPct}%` }}
          />
        )}
        <SliderPrimitive.Thumb
          data-slot="inline-slider-thumb"
          aria-label={ariaLabel}
          getAriaValueText={getAriaValueText ? (_formatted, v) => getAriaValueText(v) : undefined}
          className="bg-text-primary ring-bg-primary/40 block size-3 rounded-full ring-1 outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring data-disabled:pointer-events-none"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export interface SliderFieldProps extends NumberScrubberProps {
  /** The slider's span (the field keeps `min` / `max`). */
  sliderMin: number;
  sliderMax: number;
  /** The slider's step; default the field's `step`. */
  sliderStep?: number;
  /** Double-click on the slider. */
  onReset?: () => void;
  /** The default value: a tick on the track, and a drag snaps onto it. */
  detent?: number;
}

function SliderField({
  sliderMin,
  sliderMax,
  sliderStep,
  onReset,
  detent,
  className,
  ...field
}: SliderFieldProps) {
  const { value, step = 1, onChange, onScrubStart, onScrubEnd, disabled, unit } = field;
  // Read by the slider's callbacks, which outlive the render that made them.
  const latest = React.useRef({ onChange, onScrubStart, onScrubEnd, min: field.min, max: field.max });
  latest.current = { onChange, onScrubStart, onScrubEnd, min: field.min, max: field.max };
  const gesture = React.useRef<{
    pending: number | null;
    last: number;
    frame: number | null;
    /** Removes the window listeners that end the gesture. */
    stop: AbortController;
  } | null>(null);

  const flush = () => {
    const g = gesture.current;
    if (!g) return;
    if (g.frame !== null) {
      cancelAnimationFrame(g.frame);
      g.frame = null;
    }
    if (g.pending !== null && g.pending !== g.last) {
      g.last = g.pending;
      latest.current.onChange(g.pending);
    }
    g.pending = null;
  };

  const end = () => {
    const g = gesture.current;
    if (!g) return;
    flush();
    g.stop.abort();
    gesture.current = null;
    latest.current.onScrubEnd?.();
  };

  // Unmount mid-drag (the Inspector re-targets): land the value, close the bracket.
  React.useEffect(() => () => end(), []);

  const onSliderChange = (raw: number) => {
    const { min, max } = latest.current;
    const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, raw));
    if (!gesture.current) {
      const stop = new AbortController();
      gesture.current = { pending: null, last: value, frame: null, stop };
      // Base UI skips `onValueCommitted` when a drag ends where it began, so
      // the release itself also closes the bracket (idempotent with the
      // commit). A key press ends on its key-up.
      for (const type of ['pointerup', 'pointercancel', 'keyup'] as const) {
        window.addEventListener(type, end, { signal: stop.signal });
      }
      latest.current.onScrubStart?.();
    }
    const g = gesture.current;
    g.pending = next;
    if (g.frame === null) {
      g.frame = requestAnimationFrame(() => {
        if (gesture.current !== g) return;
        g.frame = null;
        if (g.pending !== null && g.pending !== g.last) {
          g.last = g.pending;
          latest.current.onChange(g.pending);
        }
        g.pending = null;
      });
    }
  };

  return (
    <div data-slot="slider-field" className={cn('flex min-w-0 flex-1 items-center gap-2', className)}>
      <InlineSlider
        value={value}
        min={sliderMin}
        max={sliderMax}
        step={sliderStep ?? step}
        disabled={disabled}
        onValueChange={onSliderChange}
        onValueCommitted={end}
        onReset={onReset}
        detent={detent}
        aria-label={field['aria-label'] ? `${field['aria-label']} slider` : undefined}
        getAriaValueText={(v) => `${v}${unit ?? ''}`}
      />
      <NumberScrubber {...field} className="w-14 shrink-0" />
    </div>
  );
}

export { InlineSlider, SliderField };
