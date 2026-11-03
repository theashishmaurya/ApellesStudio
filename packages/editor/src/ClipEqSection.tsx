/**
 * @apelles/editor — the Inspector Audio tab's EQ section (v0.3.0 panel
 * redesign, B-365, D-442; `docs/notes/panel-redesign.md` §3 + "Revision 2").
 *
 * **What it is.** The owner rejected the first redesign as "cluttered AF";
 * the approved revision makes the graph the control. Top to bottom: a preset
 * dropdown (`EQ_PRESETS`, the same table `editor_set_clip_eq preset` reads),
 * the response graph (`EqResponseGraph`: the numbered dots ARE the four
 * bands — drag for frequency and gain, scroll for Q, double-click for 0 dB),
 * and ONE row for the selected band: power · `N · Shape ▾` · frequency · gain
 * · Q, each a scrubbable number (no sliders, no footnote). Descriptions live
 * in tooltips. The collapsed header reads `Voice clarity · 3 of 4 bands on`.
 *
 * **What it does NOT do.** Own the EQ: every edit is the existing
 * `set_clip_eq` op (one band, partial) through `onBandChange`, a preset is
 * one `set_clip_eq { bands }` op, the reset is `clear`. A scrub of a band
 * field folds into one undo step (`InspectorNumber`), a dot drag commits once
 * on release (`EqResponseGraph`). The selected band is local, ephemeral UI
 * state: the panel remounts per clip, and which band the row shows is not
 * something a project or an agent needs back. Not keyframeable (D-224).
 */
import { useState } from 'react';
import { ArrowCounterClockwiseIcon, PowerIcon } from '@phosphor-icons/react';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@apelles/ui';

import { EditorSection } from './EditorSection';
import { EqResponseGraph } from './EqResponseGraph';
import { InspectorNumber } from './InspectorNumber';
import {
  formatHz,
  hzFromOctaves,
  octavesFromHz,
  parseHz,
  roundHz,
} from './displayUnits';
import {
  EQ_BAND_KIND_DESCRIPTIONS,
  EQ_BAND_KIND_LABELS,
  EQ_BAND_KINDS,
  EQ_MAX_FREQ_HZ,
  EQ_MAX_GAIN_DB,
  EQ_MAX_Q,
  EQ_MIN_FREQ_HZ,
  EQ_MIN_Q,
  EQ_PRESET_NAMES,
  eqBandsForDisplay,
  eqKindUsesGain,
  isEqBandActive,
  matchEqPreset,
  type EqBand,
} from './eq';

/** The dropdown's value for a strip that matches no preset. */
const CUSTOM_PRESET = 'Custom';

/** The frequency field scrubs in octaves (see `displayUnits.octavesFromHz`):
 *  a fiftieth of an octave per pixel, so the whole 20 Hz–20 kHz range is
 *  ~500 px of drag and Shift (×10) crosses it in ~50. */
const FREQ_OCTAVE_STEP = 0.02;
const GAIN_STEP_DB = 0.1;
const Q_STEP = 0.05;

/** The band the row starts on: the first one doing something, else band 1. */
function initialBand(bands: readonly EqBand[]): number {
  const i = bands.findIndex(isEqBandActive);
  return i >= 0 ? i : 0;
}

/** `Voice clarity · 3 of 4 bands on`, or `Off` for a clip with no EQ. */
export function eqSummary(stored: readonly EqBand[] | undefined | null): string {
  if (!stored || stored.length === 0) return 'Off';
  const on = stored.filter((b) => b.enabled).length;
  return `${matchEqPreset(stored) ?? CUSTOM_PRESET} · ${on} of ${stored.length} bands on`;
}

export function ClipEqSection({
  stored,
  disabled,
  onBandChange,
  onPreset,
  onClear,
}: {
  /** The audible clip's stored bands (`Clip.eq_bands`); absent = no EQ. */
  stored: readonly EqBand[] | undefined;
  /** The audio half's track is locked. */
  disabled: boolean;
  onBandChange: (band: number, patch: Partial<EqBand>) => void;
  /** Write a preset's four bands (one op). */
  onPreset: (name: string) => void;
  /** Remove the EQ entirely (the header's reset). */
  onClear: () => void;
}) {
  const bands = eqBandsForDisplay(stored);
  const [selected, setSelected] = useState(() => initialBand(bands));
  const index = Math.min(selected, bands.length - 1);
  const band = bands[index];
  const usesGain = eqKindUsesGain(band.kind);
  const preset = stored && stored.length > 0 ? (matchEqPreset(stored) ?? CUSTOM_PRESET) : EQ_PRESET_NAMES[0];

  return (
    <EditorSection
      id="eq"
      label="EQ"
      meta={eqSummary(stored)}
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5"
          disabled={disabled || !stored || stored.length === 0}
          onClick={onClear}
          title="Remove this clip's EQ (back to unfiltered)"
          aria-label="Reset EQ"
        >
          <ArrowCounterClockwiseIcon size={11} />
        </Button>
      }
    >
      <div className="flex flex-col gap-1.5 pt-0.5">
        <Select
          value={preset}
          onValueChange={(v) => {
            if (typeof v === 'string' && v !== CUSTOM_PRESET) onPreset(v);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            className="data-[size=default]:h-[22px] w-40 text-xs"
            title="Start from a preset (it writes all four bands)"
            aria-label="EQ preset"
            data-chroma-eq-preset={preset}
          >
            <SelectValue>{preset}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {EQ_PRESET_NAMES.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
            {preset === CUSTOM_PRESET && (
              <SelectItem value={CUSTOM_PRESET} disabled>
                {CUSTOM_PRESET}
              </SelectItem>
            )}
          </SelectContent>
        </Select>

        <EqResponseGraph
          bands={bands}
          disabled={disabled}
          onBandChange={onBandChange}
          selected={index}
          onSelect={setSelected}
        />

        {/* The selected band, one row: power · N · Shape ▾ · Hz · dB · Q. */}
        <div className="flex min-w-0 items-center gap-1" data-chroma-eq-band-row={index}>
          <Button
            variant="ghost"
            size="icon-xs"
            className={`size-[22px] shrink-0 ${band.enabled ? 'text-accent-text' : 'text-text-tertiary'}`}
            disabled={disabled}
            aria-pressed={band.enabled}
            aria-label={`Band ${index + 1} on`}
            title={band.enabled ? 'Turn this band off (keeps its settings)' : 'Turn this band on'}
            onClick={() => onBandChange(index, { enabled: !band.enabled })}
          >
            <PowerIcon size={13} weight={band.enabled ? 'bold' : 'regular'} />
          </Button>
          <Select
            value={band.kind}
            onValueChange={(v) => {
              const kind = EQ_BAND_KINDS.find((k) => k === v);
              if (kind) onBandChange(index, { kind });
            }}
            disabled={disabled}
          >
            <SelectTrigger
              // Wide enough for "1 · High-pass" (truncated at 92 px, seen live).
              className={`data-[size=default]:h-[22px] w-[112px] shrink-0 gap-1 px-2 text-xs ${band.enabled ? '' : 'line-through'}`}
              title={`${EQ_BAND_KIND_DESCRIPTIONS[band.kind]} Click to change the shape.`}
              aria-label={`Band ${index + 1} shape`}
            >
              <SelectValue>{`${index + 1} · ${EQ_BAND_KIND_LABELS[band.kind]}`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {EQ_BAND_KINDS.map((k) => (
                <SelectItem key={k} value={k} title={EQ_BAND_KIND_DESCRIPTIONS[k]}>
                  {EQ_BAND_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InspectorNumber
            aria-label={`Band ${index + 1} frequency`}
            title="Frequency: drag sideways or type (e.g. 3.5k)"
            className="min-w-0 flex-1"
            value={octavesFromHz(band.freq_hz)}
            step={FREQ_OCTAVE_STEP}
            min={octavesFromHz(EQ_MIN_FREQ_HZ)}
            max={octavesFromHz(EQ_MAX_FREQ_HZ)}
            format={(v) => formatHz(roundHz(hzFromOctaves(v)))}
            parse={(text) => {
              const hz = parseHz(text);
              return hz === null ? null : octavesFromHz(hz);
            }}
            disabled={disabled}
            onChange={(v) => onBandChange(index, { freq_hz: roundHz(hzFromOctaves(v)) })}
          />
          <InspectorNumber
            aria-label={`Band ${index + 1} gain`}
            title={usesGain ? 'Gain: drag sideways or type' : 'A pass filter has no gain'}
            className="min-w-0 flex-1"
            value={band.gain_db}
            step={GAIN_STEP_DB}
            min={-EQ_MAX_GAIN_DB}
            max={EQ_MAX_GAIN_DB}
            unit="dB"
            precision={1}
            format={usesGain ? undefined : () => ({ text: '—', unit: 'dB' })}
            disabled={disabled || !usesGain}
            onChange={(v) => onBandChange(index, { gain_db: v })}
          />
          <InspectorNumber
            aria-label={`Band ${index + 1} Q`}
            title="Width (Q): lower is wider. Drag sideways, or scroll on the dot."
            className="w-[58px] shrink-0"
            prefix="Q"
            value={band.q}
            step={Q_STEP}
            min={EQ_MIN_Q}
            max={EQ_MAX_Q}
            precision={2}
            disabled={disabled}
            onChange={(v) => onBandChange(index, { q: v })}
          />
        </div>
      </div>
    </EditorSection>
  );
}
