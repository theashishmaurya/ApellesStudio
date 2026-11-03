/**
 * @apelles/editor — the clip Inspector's Audio tab (v0.3.0 panel redesign,
 * B-365, D-442; `docs/notes/panel-redesign.md` §3 + "Revision 2").
 *
 * **What it is.** Four rows of the audible clip's sound, every collapsed one
 * saying its value:
 * - **Level** (`−3.0 dB · Center`): Volume in dB on an inline slider with a
 *   detent at 0 dB, a live "Level now" meter, Pan as `L 40 / Center / R 40`.
 *   Both keyframeable rows (D-223), stored as the same multiplier and −1…1.
 * - **Fades** (`In 0.40 s · Out none`): a summary only. One fade drives
 *   picture and sound, and it is edited on the Video tab (owner default,
 *   2026-11-03); the row opens it there.
 * - **Ducking** (`Ducks under A1 · 12 dB`): a summary only. Ducking is a
 *   relationship between tracks (`set_track_duck`), set in the track header.
 * - **EQ**: `ClipEqSection`.
 *
 * **What it does NOT do.** Hold state or write anything of its own: the
 * rows route through `EditorInspectorPanel`'s handlers, exactly as before.
 * The level meter reads `chroma_audio_level` (what `editor_get_audio_level`
 * reports) only while the Level section is open AND playback runs, so a
 * closed section or a paused timeline polls nothing. It is the whole mix's
 * output over the last second, not this clip's level, and its tooltip says
 * so. Explanatory sentences are tooltips, not footnotes (revision 2).
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowCounterClockwiseIcon, CaretRightIcon } from '@phosphor-icons/react';
import { Button, InspectorRow } from '@apelles/ui';

import { ClipEqSection } from './ClipEqSection';
import { EditorSection } from './EditorSection';
import { PropertyRow, type PropertyState } from './PropertyRow';
import {
  DECIBELS,
  PAN_PERCENT,
  VOLUME_DB_FLOOR,
  dbFromGain,
  fadeSummary,
  formatDb,
  formatPan,
  parsePan,
} from './displayUnits';
import type { EqBand } from './eq';
import type { Clip, ClipAudioParam, ClipKeyframeParam } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { trackBadges } from './trackOps';

/** The Volume slider's span in dB (the field takes −96…+24). Final Cut's
 *  Volume slider runs to +12 dB; −60 dB is effectively silent in a mix. */
const VOLUME_SLIDER_DB = { min: -60, max: 12 } as const;
const VOLUME_MAX_DB = 24;
/** How often the meter reads the output while playing. The measurement is a
 *  ~1 s window (`chroma_audio_level`), so faster would only repeat itself. */
const METER_POLL_MS = 250;
/** The meter's scale, dBFS: −60 at the left end, 0 at the right. */
const METER_FLOOR_DB = -60;

/** Live output level, polled only while mounted (the Level section is open)
 *  and playing. `null` when not playing. */
function useOutputLevelDb(): number | null {
  const playing = useEditorTimelineStore((s) => s.playing);
  const [peakDb, setPeakDb] = useState<number | null>(null);
  useEffect(() => {
    if (!playing) {
      setPeakDb(null);
      return;
    }
    let alive = true;
    const read = () => {
      invoke<[number, number]>('chroma_audio_level')
        .then((v) => {
          if (!alive || !Array.isArray(v)) return;
          const peak = Number(v[1]);
          setPeakDb(peak > 0 ? 20 * Math.log10(peak) : METER_FLOOR_DB);
        })
        .catch(() => {
          if (alive) setPeakDb(null);
        });
    };
    read();
    const id = setInterval(read, METER_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [playing]);
  return peakDb;
}

function LevelMeter() {
  const peakDb = useOutputLevelDb();
  const fill = peakDb === null ? 0 : Math.max(0, Math.min(1, (peakDb - METER_FLOOR_DB) / -METER_FLOOR_DB));
  return (
    <InspectorRow label="Level now" labelTitle="The whole mix as it plays, peak over the last second">
      <div
        className="bg-border-color relative h-[3px] min-w-0 flex-1 overflow-hidden rounded-full"
        role="meter"
        aria-label="Output level"
        aria-valuemin={METER_FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={peakDb === null ? METER_FLOOR_DB : Math.round(peakDb)}
        data-chroma-level-meter
      >
        <div className="bg-clip-audio-wave-ink absolute inset-y-0 left-0" style={{ width: `${fill * 100}%` }} />
      </div>
      <span className="text-text-tertiary w-14 shrink-0 text-right font-mono text-2xs tabular-nums">
        {peakDb === null ? '—' : formatDb(Math.max(VOLUME_DB_FLOOR, peakDb))}
      </span>
    </InspectorRow>
  );
}

/** A summary-only row in the section-header style (no body to open). */
function SummaryRow({
  label,
  meta,
  title,
  onClick,
}: {
  label: string;
  meta: string;
  title: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="text-text-primary truncate text-sm font-semibold">{label}</span>
      <span className="text-text-secondary ml-auto truncate pl-2 font-mono text-xs">{meta}</span>
      {onClick && <CaretRightIcon size={10} className="text-text-tertiary shrink-0" />}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className="border-border-color hover:text-text-primary flex h-7 w-full items-center gap-1.5 border-b pr-2 pl-[26px] text-left"
      title={title}
      onClick={onClick}
      data-chroma-summary-row={label}
    >
      {inner}
    </button>
  ) : (
    <div
      className="border-border-color flex h-7 items-center gap-1.5 border-b pr-2 pl-[26px]"
      title={title}
      data-chroma-summary-row={label}
    >
      {inner}
    </div>
  );
}

/** `Ducks under A1 · 12 dB`, `A3 ducks under this · 12 dB`, or `Off`. */
export function duckingSummary(
  badges: readonly string[],
  audioTrack: number,
  duck: { self: { from: number | null; db: number }; under: Array<{ track: number; db: number }> },
): string {
  if (duck.self.from !== null && badges[duck.self.from]) {
    return `Ducks under ${badges[duck.self.from]} · ${Math.abs(duck.self.db)} dB`;
  }
  if (duck.under.length > 0) {
    const names = duck.under.map((u) => badges[u.track]).filter(Boolean).join(', ');
    return `${names} duck${duck.under.length > 1 ? '' : 's'} under ${badges[audioTrack] ?? 'this'}`;
  }
  return 'Off';
}

export function ClipAudioTab({
  audioClip,
  fadeClip,
  audioTrack,
  locked,
  fps,
  paramStates,
  onParamChange,
  onKeyframeToggle,
  onKeyframeNav,
  onResetParam,
  onOpenCurve,
  openCurveParam,
  onEqBandChange,
  onEqPreset,
  onEqClear,
  onEditFades,
}: {
  /** The audible clip (a linked pair's audio half, else the clip itself). */
  audioClip: Clip;
  /** The clip whose fade the Video tab edits (the summary reads it). */
  fadeClip: Clip;
  /** The audible clip's track index (for the ducking summary). */
  audioTrack: number;
  locked: boolean;
  fps: number;
  paramStates: Record<ClipKeyframeParam, PropertyState>;
  onParamChange: (param: ClipKeyframeParam, value: number) => void;
  onKeyframeToggle: (params: ClipKeyframeParam | readonly ClipKeyframeParam[]) => void;
  onKeyframeNav: (param: ClipKeyframeParam, dir: -1 | 1) => void;
  onResetParam: (params: ClipKeyframeParam | readonly ClipKeyframeParam[]) => void;
  onOpenCurve: (param: ClipKeyframeParam) => void;
  openCurveParam: ClipKeyframeParam | null;
  onEqBandChange: (band: number, patch: Partial<EqBand>) => void;
  onEqPreset: (name: string) => void;
  onEqClear: () => void;
  /** Open the Video tab's Fade section. */
  onEditFades: () => void;
}) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const badges = timeline ? trackBadges(timeline) : [];
  const track = timeline?.tracks[audioTrack];
  const ducking = duckingSummary(badges, audioTrack, {
    self: { from: track?.duck_from ?? null, db: track?.duck_db ?? 0 },
    under: (timeline?.tracks ?? []).flatMap((t, i) =>
      i !== audioTrack && t.duck_from === audioTrack ? [{ track: i, db: t.duck_db ?? 0 }] : [],
    ),
  });

  const volume = paramStates.volume.value;
  const pan = paramStates.pan.value;
  const row = (param: ClipAudioParam) => ({
    param,
    state: paramStates[param],
    disabled: locked,
    onChange: (v: number) => onParamChange(param, v),
    onKeyframeToggle,
    onKeyframeNav,
    onReset: onResetParam,
    onOpenCurve,
    curveOpen: openCurveParam === param,
  });

  return (
    <>
      <EditorSection
        id="audio"
        label="Level"
        meta={`${formatDb(dbFromGain(volume))} · ${formatPan(pan * 100).text}`}
        actions={
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            disabled={locked}
            onClick={() => onResetParam(['volume', 'pan'])}
            title="Reset volume and pan"
            aria-label="Reset level"
          >
            <ArrowCounterClockwiseIcon size={11} />
          </Button>
        }
      >
        <PropertyRow
          {...row('volume')}
          label="Volume"
          units={DECIBELS}
          step={0.1}
          min={VOLUME_DB_FLOOR}
          max={VOLUME_MAX_DB}
          unit="dB"
          precision={1}
          slider={VOLUME_SLIDER_DB}
          detent={0}
        />
        <LevelMeter />
        <PropertyRow
          {...row('pan')}
          label="Pan"
          units={PAN_PERCENT}
          step={1}
          min={-100}
          max={100}
          slider={{ min: -100, max: 100 }}
          detent={0}
          format={formatPan}
          parse={parsePan}
        />
      </EditorSection>
      <SummaryRow
        label="Fades"
        meta={fadeSummary(fadeClip.fade_in_frames ?? 0, fadeClip.fade_out_frames ?? 0, fps)}
        title="One fade drives the picture and the sound. Edit it on the Video tab."
        onClick={onEditFades}
      />
      <SummaryRow
        label="Ducking"
        meta={ducking}
        title="Ducking lowers a track while another one plays. It is set per track, in the track header's menu."
      />
      <ClipEqSection
        stored={audioClip.eq_bands}
        disabled={locked}
        onBandChange={onEqBandChange}
        onPreset={onEqPreset}
        onClear={onEqClear}
      />
    </>
  );
}
