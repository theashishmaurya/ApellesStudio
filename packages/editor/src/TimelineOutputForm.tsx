/**
 * @apelles/editor — the open timeline's own output size (D-411 Phase 0), the
 * "This timeline" section of the docked Project Settings panel.
 *
 * **What it is.** Resolve's per-timeline "Use Project Settings" checkbox, in
 * this panel's own pill style (`ProjectSettingsForm`'s Match / Preset /
 * Custom): **Project size** (no override — the timeline follows the project's
 * resolution), a delivery **preset** (9:16, 1:1, 4:5, 16:9, UHD — the same
 * list the timeline switcher's Size menu offers), or a **custom** even
 * width × height. A 9:16 short and the 16:9 long-form it was cut from can
 * therefore live in one project.
 *
 * **One write path.** Every change goes through the store's
 * `setTimelineOutput` — the `set_timeline_output` op for the open timeline,
 * so it is undoable and journalled — which is also what
 * `editor_set_timeline_output` and the switcher's menu call. A custom size is
 * applied on commit (blur / Enter), not per keystroke, and a size
 * `checkTimelineOutput` refuses (odd, too small, too large) is shown in words
 * next to the fields rather than silently corrected.
 *
 * **Frame rate (B-323).** The same section holds the timeline's own frame
 * rate, the human half of `editor_set_timeline_output(fps)`: one store action
 * (`setTimelineRate`), an undoable op that converts every clip, marker and
 * transition by time, so a 10 s clip stays 10 s at the new rate.
 *
 * **What it does NOT do.** It does not resize anything on the timeline: clip
 * transforms are fractions of the composition, so a layout made for 16:9 is
 * simply measured against the new frame (reframing to the subject is D-411
 * Phase 3).
 */
import { useState } from 'react';
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@apelles/ui';

import { useEditorTimelineStore } from './timelineStore';
import { checkTimelineOutput, timelineFps, TIMELINE_OUTPUT_PRESETS, type OutputSpec } from './timeline';
import { FPS_PRESETS } from './ProjectSettingsForm';

type Mode = 'project' | 'preset' | 'custom';

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  project: 'Project size',
  preset: 'Preset',
  custom: 'Custom',
};
const MODES: readonly Mode[] = ['project', 'preset', 'custom'];

function presetIndex(output: OutputSpec | null | undefined): number {
  if (!output) return -1;
  return TIMELINE_OUTPUT_PRESETS.findIndex((p) => p.width === output.width && p.height === output.height);
}

function inferMode(output: OutputSpec | null | undefined): Mode {
  if (!output) return 'project';
  return presetIndex(output) >= 0 ? 'preset' : 'custom';
}

const pillClass = (active: boolean): string =>
  `px-2 py-1 rounded-md border text-[11px] ${
    active
      ? 'border-accent text-text-primary bg-accent/10'
      : 'border-border-color text-text-secondary hover:text-text-primary'
  }`;

/** The default a switch into Preset/Custom starts from: the short format,
 *  which is why a timeline gets its own size at all. */
const FIRST_PRESET = TIMELINE_OUTPUT_PRESETS[0];

/** How close a timeline's rate must be to a preset to show as that preset. */
const FPS_MATCH_TOLERANCE = 0.01;

export function TimelineOutputForm() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const setTimelineOutput = useEditorTimelineStore((s) => s.setTimelineOutput);
  const setTimelineRate = useEditorTimelineStore((s) => s.setTimelineRate);
  const output = timeline?.output ?? null;
  // Presentation state, like `ProjectSettingsForm`'s modes: seeded from the
  // document, kept while the person works. Re-seeded when the open timeline
  // changes (the component is keyed by timeline id by its parent).
  const [mode, setMode] = useState<Mode>(() => inferMode(output));
  const [draftW, setDraftW] = useState(String(output?.width ?? FIRST_PRESET.width));
  const [draftH, setDraftH] = useState(String(output?.height ?? FIRST_PRESET.height));
  const [error, setError] = useState<string | null>(null);

  if (!timeline) return null;

  const apply = async (next: OutputSpec | null) => {
    setError(null);
    const res = await setTimelineOutput(timeline.id, next);
    if (!res.ok) setError(res.error ?? 'the size could not be set');
  };

  const currentFps = timelineFps(timeline);
  // A rate is a preset when it is within rounding of one (30000/1001 is 29.97).
  const presetFps = FPS_PRESETS.find((f) => Math.abs(f - currentFps) < FPS_MATCH_TOLERANCE);

  const applyRate = async (fps: number) => {
    setError(null);
    const res = await setTimelineRate(timeline.id, fps);
    if (!res.ok) setError(res.error ?? 'the frame rate could not be set');
  };

  const commitCustom = () => {
    const checked = checkTimelineOutput(Number(draftW), Number(draftH));
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    void apply(checked.output);
  };

  return (
    <div className="flex flex-col gap-1.5 text-xs" data-chroma-panel="timeline-output">
      <span className="text-text-secondary">Resolution</span>
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            className={pillClass(mode === m)}
            onClick={() => {
              setMode(m);
              if (m === 'project') void apply(null);
              else if (m === 'preset' && presetIndex(output) < 0) {
                void apply({ width: FIRST_PRESET.width, height: FIRST_PRESET.height });
              }
            }}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {mode === 'preset' && (
        <Select
          value={presetIndex(output) >= 0 ? `${output?.width}x${output?.height}` : undefined}
          onValueChange={(v) => {
            const preset = TIMELINE_OUTPUT_PRESETS.find((p) => `${p.width}x${p.height}` === v);
            if (preset) void apply({ width: preset.width, height: preset.height });
          }}
        >
          <SelectTrigger className="mt-1 h-7 w-full text-xs" data-chroma-field="timeline-output-preset">
            <SelectValue placeholder="Size" />
          </SelectTrigger>
          <SelectContent>
            {TIMELINE_OUTPUT_PRESETS.map((p) => (
              <SelectItem key={p.label} value={`${p.width}x${p.height}`}>
                {p.aspect} · {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {mode === 'custom' && (
        <div className="mt-1 flex w-full items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-text-secondary/70 text-[10px]">Width</span>
            <Input
              type="number"
              step={2}
              className="h-7 w-full text-xs"
              value={draftW}
              onChange={(e) => setDraftW(e.target.value)}
              onBlur={commitCustom}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCustom();
              }}
            />
          </label>
          <span className="text-text-secondary pb-1.5">×</span>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-text-secondary/70 text-[10px]">Height</span>
            <Input
              type="number"
              step={2}
              className="h-7 w-full text-xs"
              value={draftH}
              onChange={(e) => setDraftH(e.target.value)}
              onBlur={commitCustom}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCustom();
              }}
            />
          </label>
        </div>
      )}
      <span className="text-text-secondary mt-1">Frame rate</span>
      <Select
        value={String(presetFps ?? currentFps)}
        onValueChange={(v) => {
          void applyRate(Number(v));
        }}
      >
        <SelectTrigger className="h-7 w-full text-xs" data-chroma-field="timeline-fps">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presetFps === undefined && <SelectItem value={String(currentFps)}>{+currentFps.toFixed(3)} fps</SelectItem>}
          {FPS_PRESETS.map((f) => (
            <SelectItem key={f} value={String(f)}>
              {f} fps
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      <p className="text-text-secondary/60 text-[10px] leading-snug">
        {output
          ? `This timeline renders at ${output.width}×${output.height}, whatever the project size is.`
          : 'This timeline follows the project size above.'}{' '}
        Changing the frame rate keeps every clip at the same time in seconds.
      </p>
    </div>
  );
}
