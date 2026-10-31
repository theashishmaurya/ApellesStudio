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
import { useRef, useState } from 'react';
import { InspectorRow, NumberScrubber, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@apelles/ui';

import { useEditorTimelineStore } from './timelineStore';
import { checkTimelineOutput, timelineFps, TIMELINE_OUTPUT_PRESETS, type OutputSpec } from './timeline';
import { FPS_PRESETS } from './ProjectSettingsForm';
import {
  CLIP_SCALING_LABELS,
  CLIP_SCALING_MODES,
  TIMELINE_DEFAULT_SCALING,
  type ClipScaling,
} from './clipScaling';

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
  `px-1.5 py-0.5 rounded-sm border text-2xs ${
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
  const setTimelineScaling = useEditorTimelineStore((s) => s.setTimelineScaling);
  const output = timeline?.output ?? null;
  // Presentation state, like `ProjectSettingsForm`'s modes: seeded from the
  // document, kept while the person works. Re-seeded when the open timeline
  // changes (the component is keyed by timeline id by its parent).
  const [mode, setMode] = useState<Mode>(() => inferMode(output));
  const [draftW, setDraftW] = useState(String(output?.width ?? FIRST_PRESET.width));
  const [draftH, setDraftH] = useState(String(output?.height ?? FIRST_PRESET.height));
  const [error, setError] = useState<string | null>(null);
  // A custom-size scrub applies once, on release (see `commitSize`); the refs
  // hold the latest draft for that release handler.
  const sizeScrubbing = useRef(false);
  const draftWRef = useRef(String(output?.width ?? FIRST_PRESET.width));
  const draftHRef = useRef(String(output?.height ?? FIRST_PRESET.height));

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

  const applyScaling = async (scaling: ClipScaling) => {
    setError(null);
    const res = await setTimelineScaling(timeline.id, scaling);
    if (!res.ok) setError(res.error ?? 'the scaling could not be set');
  };

  /** The custom size is committed when a typed value lands or a scrub ENDS —
   *  never per scrub tick: changing a timeline's output size is a document
   *  write, not a live preview. */
  const commitSize = (w: number, h: number) => {
    const checked = checkTimelineOutput(w, h);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    void apply(checked.output);
  };
  const sizeField = (axis: 'w' | 'h') => (
    <NumberScrubber
      aria-label={axis === 'w' ? 'Width' : 'Height'}
      prefix={axis === 'w' ? 'W' : 'H'}
      step={2}
      min={1}
      className="min-w-0 flex-1"
      value={Number(axis === 'w' ? draftW : draftH) || 0}
      onScrubStart={() => {
        sizeScrubbing.current = true;
      }}
      onScrubEnd={() => {
        sizeScrubbing.current = false;
        commitSize(Number(draftWRef.current), Number(draftHRef.current));
      }}
      onChange={(v) => {
        const nextW = axis === 'w' ? v : Number(draftW);
        const nextH = axis === 'h' ? v : Number(draftH);
        draftWRef.current = String(nextW);
        draftHRef.current = String(nextH);
        setDraftW(String(nextW));
        setDraftH(String(nextH));
        if (!sizeScrubbing.current) commitSize(nextW, nextH);
      }}
    />
  );

  return (
    <div className="flex flex-col gap-0.5 text-xs" data-chroma-panel="timeline-output">
      <InspectorRow label="Resolution" controlClassName="flex-wrap">
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
      </InspectorRow>
      {mode === 'preset' && (
        <InspectorRow label="Preset">
          <Select
            value={presetIndex(output) >= 0 ? `${output?.width}x${output?.height}` : undefined}
            onValueChange={(v) => {
              const preset = TIMELINE_OUTPUT_PRESETS.find((p) => `${p.width}x${p.height}` === v);
              if (preset) void apply({ width: preset.width, height: preset.height });
            }}
          >
            <SelectTrigger className="data-[size=default]:h-[22px] w-full text-xs" data-chroma-field="timeline-output-preset">
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
        </InspectorRow>
      )}
      {mode === 'custom' && (
        <InspectorRow label="Size">
          {sizeField('w')}
          <span className="text-text-tertiary shrink-0 text-xs">×</span>
          {sizeField('h')}
        </InspectorRow>
      )}
      <InspectorRow label="Frame rate">
        <Select
          value={String(presetFps ?? currentFps)}
          onValueChange={(v) => {
            void applyRate(Number(v));
          }}
        >
          <SelectTrigger className="data-[size=default]:h-[22px] w-full text-xs" data-chroma-field="timeline-fps">
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
      </InspectorRow>
      {/* D-425 / B-325 — Resolve's project-level "Input Scaling": how a clip is
          sized into this frame when it is PLACED. It never moves a clip that is
          already on the timeline; each clip's own mode is in its Inspector. */}
      <InspectorRow label="New clips" labelTitle="How new clips are sized into this frame">
        <Select
          value={timeline.default_scaling ?? TIMELINE_DEFAULT_SCALING}
          onValueChange={(v) => {
            const hit = CLIP_SCALING_MODES.find((m) => m === v);
            if (hit) void applyScaling(hit);
          }}
        >
          <SelectTrigger className="data-[size=default]:h-[22px] w-full text-xs" data-chroma-field="timeline-default-scaling">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLIP_SCALING_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {CLIP_SCALING_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorRow>
      {error && <p className="text-destructive text-2xs">{error}</p>}
      <p className="text-text-tertiary pt-1 text-2xs leading-snug">
        {output
          ? `This timeline renders at ${output.width}×${output.height}, whatever the project size is.`
          : 'This timeline follows the project size above.'}{' '}
        Changing the frame rate keeps every clip at the same time in seconds. New clips are sized
        into the frame by the mode above; clips already placed keep theirs.
      </p>
    </div>
  );
}
