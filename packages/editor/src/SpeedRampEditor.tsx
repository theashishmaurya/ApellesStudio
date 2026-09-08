/**
 * @chroma/editor — the Speed (Retime) section of the clip Inspector (D-235).
 *
 * **What it is.** The human half of the speed ramp, opposite the
 * `editor_set_clip_speed` MCP tool. Both write the same `set_clip_speed` op
 * over the same `Clip.speed_points`, per CLAUDE.md's "every feature is built
 * for a human AND an AI" rule.
 *
 * **What it does, and where the shape comes from.** Built against the real
 * reference — DaVinci Resolve's own "Dramatic Speed Ramps" feature image
 * (`scratch/resolve-reference/create.jpg`, `edit-create` in that set's JSON),
 * read directly rather than guessed at. That image shows two paired things:
 *
 *  1. a **Speed Change bar** over the clip, cut into runs by draggable speed
 *     points, each run labelled with its own constant percentage (the image's
 *     own `100%` / `37%` / `234%`); and
 *  2. a **Retime Curve** underneath, plotting source position against output
 *     time, which is the same data drawn as a graph.
 *
 * This section is (1) as an editable list — one row per segment, showing the
 * source-frame run it covers and its speed as a percentage — plus (2) as a
 * read-only SVG plot of the actual remap. A speed point is added at the
 * playhead (Resolve's own gesture) and removed from its row.
 *
 * **What it does NOT do.** It is not the draggable on-clip bar itself: this
 * pass puts the whole model behind a real, complete Inspector control rather
 * than a partial timeline-overlay gesture. Dragging a speed point directly on
 * the clip is a named follow-up in `docs/04-roadmap.md`, and it needs no model
 * change when it lands — the same op, the same points.
 *
 * Pure presentation, like every other Inspector section: it reads a `Clip` and
 * calls back with the next point list; `EditorInspectorPanel` owns the write.
 */

import { Button, Input } from '@chroma/ui';
import { InspectorSection } from '@chroma/inspector';

import {
  clampSpeed,
  MAX_SPEED,
  MIN_SPEED,
  normalizeSpeedPoints,
  outputAtSourceFrame,
  rampOutputSourceFrames,
  resolveSpeedSegments,
  type SpeedPoint,
} from './speedRamp';
import type { Clip } from './timeline';

/** Percent shown per segment. Rounded for display only — the stored speed
 *  keeps its full precision, so a 1/3-speed segment reads "33%" without ever
 *  being rewritten to `0.33`. */
function pct(speed: number): number {
  return Math.round(speed * 100);
}

/** The retime curve: output time (x) against source position (y), normalised
 *  into a unit box. Exactly the plot Resolve's own Retime Curve draws, built
 *  from the same `outputAtSourceFrame` the exporter's `setpts` expression is —
 *  so what the editor sees IS what gets rendered, not a decorative redraw of
 *  it. A steeper line is faster.
 */
function RetimeCurve({ clip }: { clip: Clip }) {
  const segments = resolveSpeedSegments(clip);
  const outTotal = rampOutputSourceFrames(segments);
  const srcTotal = Math.max(1, clip.duration);
  if (outTotal <= 0) return null;

  const W = 100;
  const H = 44;
  const points = [
    ...segments.map((s) => s.startSourceFrame),
    segments[segments.length - 1].endSourceFrame,
  ].map((sourceFrame) => {
    const x = (outputAtSourceFrame(segments, sourceFrame) / outTotal) * W;
    // SVG's y grows downward; the source axis should read upward, so it is
    // flipped here rather than in the model.
    const y = H - ((sourceFrame - clip.source_start) / srcTotal) * H;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="border-border bg-surface h-11 w-full rounded border"
      preserveAspectRatio="none"
      role="img"
      aria-label="Retime curve: source position against output time"
    >
      {/* The 1x reference — the diagonal an un-ramped clip would draw. */}
      <line x1={0} y1={H} x2={W} y2={0} className="stroke-text-secondary/25" strokeWidth={0.5} strokeDasharray="2 2" />
      <polyline
        points={points.join(' ')}
        fill="none"
        className="stroke-accent"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      {points.map((p) => {
        const [x, y] = p.split(',');
        return <circle key={p} cx={x} cy={y} r={1.6} className="fill-accent" vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

export function SpeedRampEditor({
  clip,
  trackLocked,
  playheadSourceFrame,
  onSpeedChange,
}: {
  clip: Clip;
  trackLocked: boolean;
  /** The SOURCE frame under the playhead, or `null` when the playhead is not
   *  over this clip at all. Resolved by `EditorInspectorPanel` through
   *  `clipSourceFrameAt` — the same function the preview decodes with, so
   *  "add a speed point here" adds it at the frame actually on screen. `null`
   *  disables the add button rather than guessing a position. */
  playheadSourceFrame: number | null;
  /** Replace the clip's whole point list — the op is a whole-array write, for
   *  `set_clip_keyframes`' reasons (see that op's doc). */
  onSpeedChange: (points: SpeedPoint[]) => void;
}) {
  const points = normalizeSpeedPoints(clip.speed_points);
  const segments = resolveSpeedSegments(clip);
  const outFrames = rampOutputSourceFrames(segments);
  const clipEnd = clip.source_start + clip.duration;

  /** Is the playhead somewhere a new point could actually go? A point at (or
   *  before) the clip's in-point would just restate the head segment's speed,
   *  and one at the very end would cover no frames. */
  const canAddHere =
    playheadSourceFrame !== null &&
    playheadSourceFrame > clip.source_start &&
    playheadSourceFrame < clipEnd &&
    !points.some((p) => p.source_frame === playheadSourceFrame);

  /** Set one segment's speed. A segment whose start already has a point moves
   *  that point's speed; the HEAD segment of an un-pointed clip gets a new
   *  point at the in-point, which is how a plain "make this clip 2x" is
   *  expressed in the same model as a ramp. */
  const setSegmentSpeed = (startSourceFrame: number, speed: number) => {
    const next = points.filter((p) => p.source_frame !== startSourceFrame);
    next.push({ source_frame: startSourceFrame, speed: clampSpeed(speed) });
    const normalised = normalizeSpeedPoints(next);
    // Taking the ONLY run back to 100% clears the ramp outright rather than
    // storing an identity point at the in-point. `normalizeSpeedPoints`
    // deliberately keeps redundant points (a split you have not chosen a speed
    // for yet is real — see its own doc), so this "there is nothing left to
    // say" tidy has to live here, where the clip's in-point is known. A 1x
    // point in the MIDDLE of a clip is untouched: that one is a real split.
    const isBareIdentity =
      normalised.length === 1 &&
      normalised[0].source_frame === clip.source_start &&
      normalised[0].speed === 1;
    onSpeedChange(isBareIdentity ? [] : normalised);
  };

  const removePoint = (sourceFrame: number) => {
    onSpeedChange(normalizeSpeedPoints(points.filter((p) => p.source_frame !== sourceFrame)));
  };

  return (
    <InspectorSection label="Speed">
      <div className="flex flex-col gap-1.5">
        {segments.map((seg) => {
          // Only a segment that a real point starts can be removed — the head
          // of the clip is where the ramp begins, not a point you can delete.
          const removable = seg.startSourceFrame !== clip.source_start;
          return (
            <div className="flex items-center gap-2" key={seg.startSourceFrame}>
              <span className="text-text-secondary/70 w-24 shrink-0 font-mono text-[10px]">
                {seg.startSourceFrame}–{seg.endSourceFrame}
              </span>
              <Input
                type="number"
                step={5}
                min={Math.round(MIN_SPEED * 100)}
                max={Math.round(MAX_SPEED * 100)}
                disabled={trackLocked}
                className="h-7 w-20 text-xs"
                aria-label={`Speed of the run starting at source frame ${seg.startSourceFrame}, percent`}
                value={pct(seg.speed)}
                onChange={(e) => setSegmentSpeed(seg.startSourceFrame, Number(e.target.value) / 100)}
              />
              <span className="text-text-secondary/70 text-[11px]">%</span>
              <span className="grow" />
              {removable && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={trackLocked}
                  aria-label={`Remove the speed point at source frame ${seg.startSourceFrame}`}
                  onClick={() => removePoint(seg.startSourceFrame)}
                >
                  Remove
                </Button>
              )}
            </div>
          );
        })}

        <Button
          variant="secondary"
          size="sm"
          className="h-7 text-[11px]"
          disabled={trackLocked || !canAddHere}
          onClick={() => {
            if (playheadSourceFrame === null) return;
            // The new point inherits the speed already in force there, so
            // adding one changes nothing until its speed is edited — Resolve's
            // own behaviour, and the only one that does not silently retime the
            // clip the moment you split it.
            const here = segments.find(
              (s) => playheadSourceFrame >= s.startSourceFrame && playheadSourceFrame < s.endSourceFrame,
            );
            setSegmentSpeed(playheadSourceFrame, here?.speed ?? 1);
          }}
        >
          Add speed point at playhead
        </Button>

        {segments.length > 1 && <RetimeCurve clip={clip} />}

        <p className="text-text-secondary/60 pt-1 text-[10px] leading-snug">
          {points.length === 0
            ? 'Plays at its recorded speed. Set a percentage, or split the clip into runs with a speed point.'
            : `${Math.round(outFrames)} of ${clip.duration} frames long after retiming. Retimes the picture and its sound together.`}
        </p>
      </div>
    </InspectorSection>
  );
}
