/**
 * @apelles/editor — the Inspector's display units (v0.3.0 panel redesign,
 * B-365 / B-366, `docs/notes/panel-redesign.md` "Build order" step 1).
 *
 * **What it is.** The ONE conversion module between the values the model
 * stores and the units a person reads: fractions ↔ %, gain ↔ dB, frames ↔
 * seconds, pan −1…1 ↔ `L 40 / Center / R 40`, Hz ↔ `3.5 kHz`, a clip's
 * top-left `position_*` ↔ pixels from the frame's centre, plus the short
 * value summaries the collapsed Inspector sections show. Every Inspector row
 * converts through here, so the GUI never shows a number an agent would read
 * differently (`editor_get_capabilities` names the same units).
 *
 * **What it does NOT do.** Store anything, or change a stored unit: the model,
 * the ops and the MCP tools keep fractions, multipliers and frames
 * (`editor_set_clip_transform` still takes `scale: 1.1`). Conversion happens
 * at the edge, in the Inspector, and nowhere else. No React, no I/O.
 */
import type { FractionBox } from './transformGeometry';

// --------------------------------------------------------------------------- //
// generic mappings
// --------------------------------------------------------------------------- //

/** A stored ↔ display mapping, applied by `PropertyRow` at the field's edge. */
export interface UnitMapping {
  toDisplay: (stored: number) => number;
  fromDisplay: (shown: number) => number;
}

/** Display-only: rounds float dust from a ×100 (`0.07 * 100 = 7.000000000000001`). */
function tidy(v: number, decimals = 6): number {
  return Number(v.toFixed(decimals));
}

/** A 0–1 fraction shown as a percentage (Scale 1.1 → 110 %, Opacity, Crop). */
export const PERCENT: UnitMapping = {
  toDisplay: (v) => tidy(v * 100),
  fromDisplay: (pct) => tidy(pct / 100, 8),
};

// --------------------------------------------------------------------------- //
// level: gain multiplier ↔ dB
// --------------------------------------------------------------------------- //

/** The quietest level the Volume field shows; at or below it the clip is
 *  silent (stored `0`). −96 dB is Final Cut's own Volume floor. */
export const VOLUME_DB_FLOOR = -96;

/** A gain multiplier as dB (`20·log10 v`); silence reads the floor. */
export function dbFromGain(gain: number): number {
  if (!(gain > 0)) return VOLUME_DB_FLOOR;
  return Math.max(VOLUME_DB_FLOOR, tidy(20 * Math.log10(gain), 4));
}

/** dB back to a gain multiplier; the floor (or lower) is silence. */
export function gainFromDb(db: number): number {
  if (!Number.isFinite(db) || db <= VOLUME_DB_FLOOR) return 0;
  return tidy(10 ** (db / 20), 8);
}

export const DECIBELS: UnitMapping = { toDisplay: dbFromGain, fromDisplay: gainFromDb };

/** `−3.0 dB`, `+2.5 dB`, `0 dB`, or `Silent` at the floor. */
export function formatDb(db: number): string {
  if (db <= VOLUME_DB_FLOOR) return 'Silent';
  if (Math.abs(db) < 0.05) return '0 dB';
  return `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`;
}

// --------------------------------------------------------------------------- //
// pan: −1…1 ↔ L 100 … Center … R 100
// --------------------------------------------------------------------------- //

/** Stored pan −1…1 shown as −100…100 (the field's value domain). */
export const PAN_PERCENT: UnitMapping = PERCENT;

/** `Center`, `L 40`, `R 100` from the −100…100 display value. */
export function formatPan(shown: number): { text: string } {
  const n = Math.round(shown);
  if (n === 0) return { text: 'Center' };
  return { text: `${n < 0 ? 'L' : 'R'} ${Math.abs(n)}` };
}

/** Typed `c` / `center` / `L 40` / `R40` → −100…100; `null` for anything
 *  else (a plain number then goes through the arithmetic parser). */
export function parsePan(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === 'c' || t === 'center' || t === 'centre') return 0;
  const m = /^([lr])\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const n = Math.min(100, Number(m[2]));
  return m[1] === 'l' ? -n : n;
}

// --------------------------------------------------------------------------- //
// time: frames ↔ seconds
// --------------------------------------------------------------------------- //

/** Frames at `fps` as seconds (display). */
export function secondsFromFrames(frames: number, fps: number): number {
  return fps > 0 ? tidy(frames / fps) : 0;
}

/** Seconds back to whole frames at `fps` (the stored unit is integral). */
export function framesFromSeconds(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || !(fps > 0)) return 0;
  return Math.max(0, Math.round(seconds * fps));
}

/** Seconds ↔ frames at one rate, as a `UnitMapping`. */
export function secondsMapping(fps: number): UnitMapping {
  return { toDisplay: (f) => secondsFromFrames(f, fps), fromDisplay: (s) => framesFromSeconds(s, fps) };
}

/** `0.40 s`. */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

/** `In 0.40 s · Out none` — the Fade sections' collapsed summary. */
export function fadeSummary(inFrames: number, outFrames: number, fps: number): string {
  const side = (f: number) => (f > 0 ? formatSeconds(secondsFromFrames(f, fps)) : 'none');
  return `In ${side(inFrames)} · Out ${side(outFrames)}`;
}

// --------------------------------------------------------------------------- //
// frequency: Hz ↔ an octave domain (so a scrub is even across the spectrum)
// --------------------------------------------------------------------------- //

/** The frequency field's value is OCTAVES above 20 Hz: a pixel of scrub is
 *  then the same musical distance at 60 Hz as at 8 kHz, which a linear Hz
 *  scrub (10 Hz per px) is not. The field formats it back to Hz / kHz. */
export const FREQ_OCTAVE_BASE_HZ = 20;

export function octavesFromHz(hz: number): number {
  return Math.log2(Math.max(hz, 1) / FREQ_OCTAVE_BASE_HZ);
}

export function hzFromOctaves(octaves: number): number {
  return FREQ_OCTAVE_BASE_HZ * 2 ** octaves;
}

/** A stored frequency rounded the way the field shows it (3 significant
 *  figures), so a scrub writes `3500`, not `3498.71…`. */
export function roundHz(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return hz;
  return Number(hz.toPrecision(3));
}

/** `3.5` + `kHz`, `250` + `Hz`. */
export function formatHz(hz: number): { text: string; unit: string } {
  if (hz >= 1000) {
    const k = hz / 1000;
    return { text: String(Number(k.toFixed(k >= 10 ? 1 : 2))), unit: 'kHz' };
  }
  return { text: String(Math.round(hz)), unit: 'Hz' };
}

/** Typed `3.5k`, `3.5 kHz`, `250`, `250 Hz` → Hz; `null` when not a frequency. */
export function parseHz(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(k|khz|hz)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'k' || unit === 'khz' ? n * 1000 : n;
}

/** `3.5 kHz` as one string (the graph's drag tooltip, summaries). */
export function formatHzText(hz: number): string {
  const f = formatHz(hz);
  return `${f.text} ${f.unit}`;
}

// --------------------------------------------------------------------------- //
// position: top-left fraction ↔ pixels from the frame's centre
// --------------------------------------------------------------------------- //

/** The box's centre offset from the frame's centre, in composition pixels
 *  (owner default 2026-11-03: Position measured from the centre, FCP's and
 *  Resolve's reading — `0, 0` is a centred picture). `y` grows downward, as
 *  on screen, so `−48` is 48 px up. */
export function centredPositionPx(box: FractionBox, comp: { width: number; height: number }): { x: number; y: number } {
  return {
    x: tidy((box.left + box.width / 2 - 0.5) * comp.width, 3),
    y: tidy((box.top + box.height / 2 - 0.5) * comp.height, 3),
  };
}

/** Position X / Y as pixels from the frame's centre, as two `UnitMapping`s
 *  for the Inspector's paired row. `box` is the clip's painted box with its
 *  stored `position` (the box's offset from `position` — fit origin, or a
 *  title's centring — and its size are what the mapping needs). Moving the
 *  centre by Δ px moves `position` by Δ / frame size, so each axis is a
 *  plain offset-and-scale. */
export function centredPositionUnits(
  box: FractionBox,
  position: { x: number; y: number },
  comp: { width: number; height: number },
): readonly [UnitMapping, UnitMapping] {
  const centreX = box.left - position.x + box.width / 2 - 0.5;
  const centreY = box.top - position.y + box.height / 2 - 0.5;
  return [
    {
      toDisplay: (p) => tidy((p + centreX) * comp.width, 3),
      fromDisplay: (px) => tidy(px / comp.width - centreX, 8),
    },
    {
      toDisplay: (p) => tidy((p + centreY) * comp.height, 3),
      fromDisplay: (px) => tidy(px / comp.height - centreY, 8),
    },
  ];
}

/** `centred`, `48 px up`, `120 px left · 48 px up`. */
export function positionSummary(px: { x: number; y: number }): string {
  const x = Math.round(px.x);
  const y = Math.round(px.y);
  const parts: string[] = [];
  if (x !== 0) parts.push(`${Math.abs(x)} px ${x < 0 ? 'left' : 'right'}`);
  if (y !== 0) parts.push(`${Math.abs(y)} px ${y < 0 ? 'up' : 'down'}`);
  return parts.length === 0 ? 'centred' : parts.join(' · ');
}

/** `110%` (no space: a summary chip, as the mockup prints it). */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

// --------------------------------------------------------------------------- //
// ease curves: plain names
// --------------------------------------------------------------------------- //

/** The plain names for the four `EASE_PRESETS` (fades, dynamic zoom), keyed
 *  by the preset's stored name. The stored names stay CSS's (`ease-in`); a
 *  person reads what the motion does. */
export const EASE_PRESET_LABELS: Readonly<Record<string, string>> = {
  linear: 'Even',
  'ease-in': 'Slow start',
  'ease-out': 'Slow end',
  'ease-in-out': 'Slow start and end',
};

/** What an MCP-authored curve matching no preset is called. */
export const CUSTOM_EASE_LABEL = 'Custom (set by your agent)';

/** The plain name of a preset name, or the custom label for `null`. */
export function easeLabel(presetName: string | null): string {
  return presetName === null ? CUSTOM_EASE_LABEL : (EASE_PRESET_LABELS[presetName] ?? presetName);
}
