/**
 * @apelles/ui — NumberScrubber: the Inspector's number field (D-432, P4).
 *
 * **What it is.** A compact value field (`role="spinbutton"`) with the three
 * ways Resolve / FCP / After Effects let you set a number:
 *
 *  - **Drag** it horizontally to scrub — one `step` per pixel, Shift = ×10
 *    (coarse), Alt/Option = ×0.1 (fine). Escape mid-drag restores the
 *    pre-drag value.
 *  - **Click** it (movement under {@link NUMBER_SCRUBBER.CLICK_SLOP_PX}) to
 *    type: the whole value is selected, Enter commits, Escape reverts,
 *    blur commits. The text accepts arithmetic — `+10`, `*2`, `-=5`,
 *    `(1920-40)/2` — see `lib/number-expression.ts`.
 *  - **Keyboard** — ↑/↓ step the value (Shift ×10, Alt ×0.1), whether the
 *    field is focused or being typed in.
 *
 * **What it does NOT do.** It has no label, no keyframe controls and no
 * knowledge of any panel (`InspectorRow` supplies those). It stores nothing:
 * `value` is controlled, `onChange` is absolute (never a delta).
 *
 * **Performance (D-432 §4.10).** While a scrub is in flight the field renders
 * its own live value from local state, so the digits follow the pointer at the
 * display's frame rate without waiting for the document round trip. The
 * parent is notified at most once per animation frame (`onChange` is
 * coalesced through `requestAnimationFrame`, with the final value flushed
 * synchronously on release), and `onScrubStart` / `onScrubEnd` bracket the
 * gesture so the caller can fold every tick into ONE undo step. Nothing else
 * re-renders per pointer move.
 *
 * **No pointer lock — a deliberate deviation from the spec's "use it if
 * available".** B-136 / D-271 established, live, that Pointer Lock's
 * mandatory "cursor hidden" banner makes it unusable for a per-field gesture
 * in this app's WKWebView. Instead the pointer is captured on the field
 * (`setPointerCapture`) with window-level listeners as a fallback, so a scrub
 * keeps tracking past the field and past the window edge, and the cursor is a
 * STATIC `ew-resize` (never changed on press — the WebKit mousedown cursor
 * freeze B-136 documents is only a problem for a cursor that *changes*).
 *
 * Sibling: `ScrubbableNumberInput` (a native `type="number"` input) stays for
 * the app's plain forms; this is the Inspector's component.
 */
import * as React from 'react';

import { cn } from '../../lib/utils';
import { evaluateNumberExpression } from '../../lib/number-expression';
import { clampNumber, displayDecimals, SCRUB_DECIMALS_MAX, stepDecimals } from '../../hooks/use-number-scrub';

/** The gesture's declared feel; every number is named, none is a tuning accident. */
export const NUMBER_SCRUBBER = {
  /** Horizontal travel per `step`. The spec's "1 step per px". Callers pick
   *  a `step` that makes 1 px a sensible nudge (a 0.01 fraction, a degree). */
  PX_PER_STEP: 1,
  /** Movement under this is a click (enter text edit), not a scrub. */
  CLICK_SLOP_PX: 3,
  /** Shift — ten steps per pixel. Adobe's reading, as in `useNumberScrub`. */
  COARSE_FACTOR: 10,
  /** Alt / Option — a tenth of a step per pixel. */
  FINE_FACTOR: 0.1,
} as const;

/** Which sensitivity a modifier state asks for; Shift wins over Alt. */
export function scrubberFactor(modifiers: { shiftKey: boolean; altKey: boolean }): number {
  if (modifiers.shiftKey) return NUMBER_SCRUBBER.COARSE_FACTOR;
  if (modifiers.altKey) return NUMBER_SCRUBBER.FINE_FACTOR;
  return 1;
}

/** Round away float dust (`0.1 + 0.2`) without losing real precision. */
function tidy(value: number, decimals: number): number {
  return Number(value.toFixed(Math.min(decimals, SCRUB_DECIMALS_MAX)));
}

/** The value a scrub of `dxPx` from `startValue` lands on (DOM-free, tested). */
export function scrubberValue(startValue: number, dxPx: number, step: number, factor: number): number {
  const notches = Math.round(dxPx / NUMBER_SCRUBBER.PX_PER_STEP);
  const decimals = stepDecimals(step) + (factor < 1 ? 1 : 0);
  return tidy(startValue + notches * step * factor, decimals);
}

export interface NumberScrubberProps {
  /** The stored value (controlled). */
  value: number;
  /** Every change: a throttled scrub tick, a typed commit, an arrow step.
   *  Absolute, never a delta. */
  onChange: (value: number) => void;
  /** A scrub began / ended (ended also on Escape). Bracket for undo grouping. */
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  /** Arrow-key step and scrub notch. Default 1. */
  step?: number;
  min?: number;
  max?: number;
  /** Suffix shown (and tolerated when typed): `%`, `°`, `px`. */
  unit?: string;
  /** Fixed decimals to display; default derives from `step` (one finer). */
  precision?: number;
  /** A short inline prefix (`X`, `W`) for paired fields. */
  prefix?: string;
  disabled?: boolean;
  /** Accessible name — required in practice; the visible label lives outside. */
  'aria-label'?: string;
  title?: string;
  className?: string;
}

function NumberScrubber({
  value,
  onChange,
  onScrubStart,
  onScrubEnd,
  step = 1,
  min,
  max,
  unit,
  precision,
  prefix,
  disabled = false,
  'aria-label': ariaLabel,
  title,
  className,
}: NumberScrubberProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);
  // The typed text while editing. A ref mirrors it so Enter → blur reads the
  // text synchronously rather than a stale render's.
  const [draft, setDraftState] = React.useState<string | null>(null);
  const draftRef = React.useRef<string | null>(null);
  // The prop value the draft was started against. If `value` moves while a
  // draft is pinned (undo, a keyframe walk, an MCP write — anything but this
  // field's own commit, which clears the draft first) the draft is stale and
  // the real value must show immediately, not on blur (B-135).
  const draftBaseRef = React.useRef(value);
  const setDraft = (text: string | null) => {
    if (draftRef.current === null && text !== null) draftBaseRef.current = value;
    draftRef.current = text;
    setDraftState(text);
  };
  if (draft !== null && value !== draftBaseRef.current) {
    draftRef.current = null;
    setDraftState(null);
  }
  // The value shown mid-scrub (null = show the prop).
  const [live, setLive] = React.useState<number | null>(null);
  const [scrubbing, setScrubbing] = React.useState(false);

  // Handlers registered imperatively for the gesture must read current props.
  const latest = React.useRef({ value, step, min, max, unit, onChange, onScrubStart, onScrubEnd });
  latest.current = { value, step, min, max, unit, onChange, onScrubStart, onScrubEnd };

  const stopGesture = React.useRef<() => void>(() => {});
  React.useEffect(() => () => stopGesture.current(), []);

  const decimals = precision ?? displayDecimals(step);
  const format = (v: number): string => (precision != null ? v.toFixed(precision) : String(tidy(v, decimals)));
  const shownValue = live ?? value;

  const clamp = (v: number): number => clampNumber(v, min, max);
  /** Typed and stepped results keep full precision (only float dust is shaved) — the rounding is display-only. */
  const keepDecimals = SCRUB_DECIMALS_MAX;

  // ---- typing ----------------------------------------------------------------

  const commitDraft = () => {
    const text = draftRef.current;
    setDraft(null);
    if (text === null) return;
    const result = evaluateNumberExpression(text, latest.current.value, latest.current.unit);
    if (result === null) return; // not arithmetic: the field snaps back
    const next = clamp(tidy(result, keepDecimals));
    if (next !== latest.current.value) latest.current.onChange(next);
  };

  const stepBy = (direction: 1 | -1, modifiers: { shiftKey: boolean; altKey: boolean }) => {
    const text = draftRef.current;
    const typed = text === null ? null : evaluateNumberExpression(text, value, unit);
    const base = typed ?? value;
    const next = clamp(tidy(base + direction * step * scrubberFactor(modifiers), keepDecimals));
    if (text !== null) setDraft(String(next));
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      stepBy(e.key === 'ArrowUp' ? 1 : -1, e);
    }
  };

  // ---- scrubbing -------------------------------------------------------------

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0 || !e.isPrimary) return;
    // Already editing: a press places the caret / selects text, never scrubs.
    if (document.activeElement === inputRef.current) return;
    if (scrubbing) return;

    const wrapper = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startValue = latest.current.value;
    let active = false;
    let lastEmitted = startValue;
    let pending: number | null = null;
    let frame: number | null = null;

    if (typeof wrapper.setPointerCapture === 'function') {
      try {
        wrapper.setPointerCapture(pointerId);
      } catch {
        // The pointer is already gone; the window listeners still finish.
      }
    }

    const emit = () => {
      frame = null;
      if (pending === null || pending === lastEmitted) return;
      lastEmitted = pending;
      latest.current.onChange(pending);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      if (!active) {
        if (Math.abs(dx) < NUMBER_SCRUBBER.CLICK_SLOP_PX) return;
        active = true;
        setScrubbing(true);
        // A scrub is not a text edit: drop the caret / any selection.
        inputRef.current?.blur();
        latest.current.onScrubStart?.();
      }
      ev.preventDefault();
      const { step: s, min: lo, max: hi } = latest.current;
      const next = clampNumber(scrubberValue(startValue, dx, s, scrubberFactor(ev)), lo, hi);
      pending = next;
      setLive(next);
      if (frame === null) frame = requestAnimationFrame(emit);
    };

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      if (typeof wrapper.releasePointerCapture === 'function') {
        try {
          wrapper.releasePointerCapture(pointerId);
        } catch {
          // Already released.
        }
      }
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      stopGesture.current = () => {};
      if (active) {
        // The final value always lands, synchronously, before the bracket closes.
        if (commit) emit();
        else if (lastEmitted !== startValue) latest.current.onChange(startValue);
        latest.current.onScrubEnd?.();
        setLive(null);
        setScrubbing(false);
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const wasScrub = active;
      finish(true);
      if (!wasScrub) {
        // A click: enter text edit with everything selected.
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && active) {
        ev.preventDefault();
        finish(false);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    // Unmount mid-scrub (the Inspector re-targets): land the value, close the bracket.
    stopGesture.current = () => finish(true);
  };

  // ---- render ----------------------------------------------------------------

  const shown = focused ? (draft ?? String(value)) : format(shownValue);
  const valueText = `${format(shownValue)}${unit ?? ''}`;

  return (
    <div
      data-slot="number-scrubber"
      data-scrubbing={scrubbing ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cn(
        'bg-bg-secondary flex h-[22px] min-w-0 items-center gap-1 rounded-sm px-1.5 text-sm tabular-nums',
        // No `select-none` at rest: Safari/WebKit stops accepting typing in an
        // input whose ancestor has `user-select: none`. Only while scrubbing.
        'cursor-ew-resize hover:bg-card-active focus-within:cursor-text focus-within:ring-1 focus-within:ring-ring',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[scrubbing]:bg-card-active data-[scrubbing]:select-none',
        className,
      )}
      onPointerDown={onPointerDown}
      title={title}
    >
      {prefix && <span className="text-text-tertiary text-xs">{prefix}</span>}
      <input
        ref={inputRef}
        type="text"
        role="spinbutton"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-valuenow={shownValue}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={valueText}
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          commitDraft();
          setFocused(false);
        }}
        className={cn(
          'text-text-primary min-w-0 flex-1 cursor-[inherit] bg-transparent text-right outline-none',
          'selection:bg-accent selection:text-button-text',
        )}
      />
      {unit && <span className="text-text-tertiary text-xs">{unit}</span>}
    </div>
  );
}

export { NumberScrubber };
