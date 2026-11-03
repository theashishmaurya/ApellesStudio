/**
 * @apelles/editor — the Inspector's Dynamic zoom section (D-234; v0.3.0
 * panel redesign, B-366, D-443).
 *
 * **What it is.** Resolve's Dynamic Zoom in the approved revision-2 shape:
 * the collapsed header says what the clip does (`Off`, `Push in`, `Pull
 * out`, `Pan`); open, a small picture of the clip's frame with its Start
 * (green) and End (red) boxes, the Speed curve in plain words (`Slow start
 * and end`) with the swap (push in ↔ pull out) beside it, the "Edit boxes in
 * the viewer" toggle (the D-234 arm, which writes nothing), and — only when
 * it applies — a one-line warning whose detail is its tooltip. No
 * description paragraph (revision 2).
 *
 * **What it does NOT do.** Bake anything: the boxes are read off the clip's
 * own keyframes (`dynamicZoomFramings`), the drag in the viewer
 * (`DynamicZoomOverlay`) and `editor_set_dynamic_zoom` write them, and the
 * ease / swap handlers stay `EditorInspectorPanel`'s.
 */
import { ArrowsLeftRightIcon, SelectionIcon, WarningIcon } from '@phosphor-icons/react';
import { Button, InspectorRow, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@apelles/ui';

import { EditorSection } from './EditorSection';
import { EASE_PRESET_LABELS, easeLabel } from './displayUnits';
import { dynamicZoomFramings, dynamicZoomIsStatic, type DynamicZoomFraming } from './dynamicZoom';
import { EASE_PRESETS, type Clip, type EaseCurve } from './timeline';
import { clipBoxAnchor, clipBoxFraction, clipBoxOrigin } from './transformGeometry';
import type { ClipGeometry } from './useClipGeometry';

/** Resolve's green / red, the same classes `DynamicZoomOverlay` strokes with. */
const START_STROKE = 'border-green-400';
const END_STROKE = 'border-red-400';
const START_FILL = 'bg-green-400';
const END_FILL = 'bg-red-400';
/** How far the frame sits inside the preview well, as a fraction of it. */
const PREVIEW_INSET = 0.12;

/** `Off`, `Push in`, `Pull out` or `Pan` — what the baked zoom does. */
export function dynamicZoomSummary(start: DynamicZoomFraming, end: DynamicZoomFraming): string {
  if (dynamicZoomIsStatic(start, end)) return 'Off';
  if (end.scale > start.scale) return 'Push in';
  if (end.scale < start.scale) return 'Pull out';
  return 'Pan';
}

export function ClipDynamicZoomSection({
  clip,
  geometry,
  locked,
  armed,
  easePreset,
  wouldReplace,
  onArm,
  onEase,
  onSwap,
}: {
  clip: Clip;
  geometry: ClipGeometry | null;
  locked: boolean;
  /** The viewer is showing this clip's boxes (D-234 store state). */
  armed: boolean;
  /** The `EASE_PRESETS` name the next bake uses. */
  easePreset: string;
  wouldReplace: boolean;
  onArm: (armed: boolean) => void;
  onEase: (curve: EaseCurve) => void;
  onSwap: () => void;
}) {
  const { start, end } = dynamicZoomFramings(clip);
  const summary = dynamicZoomSummary(start, end);
  const meta = armed && summary !== 'Off' ? `${summary} · ${easeLabel(easePreset)}` : summary;

  const natural = geometry ? { width: geometry.naturalWidth, height: geometry.naturalHeight } : null;
  const boxOf = (f: DynamicZoomFraming) =>
    natural
      ? clipBoxFraction(natural, { x: f.position_x, y: f.position_y }, f.scale, clipBoxAnchor(clip), clipBoxOrigin(clip, natural))
      : null;
  const startBox = boxOf(start);
  const endBox = boxOf(end);
  const pct = (v: number) => `${v * 100}%`;

  return (
    <EditorSection id="dynamic-zoom" label="Dynamic zoom" meta={meta}>
      {geometry && startBox && endBox && (
        // The clip's frame drawn inset in a larger well, so a box that
        // reaches past the frame (a push-in's start, say) still shows, label
        // and all, instead of being clipped at the frame's edge.
        <div
          className="border-border-color bg-bg-primary/40 relative mb-1 w-full overflow-hidden rounded border"
          style={{ aspectRatio: `${geometry.compWidth} / ${geometry.compHeight}` }}
          data-chroma-dz-preview
          title="The green box is the framing at the clip's start, the red one at its end; the grey outline is the frame."
        >
          <div className="border-text-tertiary absolute border" style={{ inset: `${PREVIEW_INSET * 100}%` }}>
            {(
              [
                ['Start', startBox, START_STROKE, START_FILL, false],
                ['End', endBox, END_STROKE, END_FILL, true],
              ] as const
            ).map(([label, box, stroke, fill, dashed]) => (
              <div
                key={label}
                className={`absolute border ${stroke} ${dashed ? 'border-dashed' : ''}`}
                style={{ left: pct(box.left), top: pct(box.top), width: pct(box.width), height: pct(box.height) }}
                data-chroma-dz-box={label.toLowerCase()}
              >
                <span
                  className={`${fill} text-bg-primary absolute left-0 px-1 text-[9px] leading-tight font-semibold ${dashed ? 'bottom-0' : 'top-0'}`}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <InspectorRow
        label="Speed curve"
        slot={
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            disabled={locked || summary === 'Off'}
            onClick={onSwap}
            title="Swap start and end: push in ↔ pull out"
            aria-label="Swap start and end"
            data-dynamic-zoom-swap
          >
            <ArrowsLeftRightIcon size={12} />
          </Button>
        }
      >
        <Select
          value={easePreset}
          onValueChange={(v) => {
            const hit = EASE_PRESETS.find((p) => p.name === v);
            if (hit) onEase(hit.curve);
          }}
          disabled={locked || !armed}
        >
          <SelectTrigger
            className="data-[size=default]:h-[22px] w-full text-xs"
            aria-label="Speed curve"
            title={armed ? 'How the zoom accelerates' : 'Turn on Edit boxes in the viewer to change the curve'}
          >
            <SelectValue>{easeLabel(easePreset)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {EASE_PRESETS.map((p) => (
              <SelectItem key={p.name} value={p.name}>
                {EASE_PRESET_LABELS[p.name] ?? p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InspectorRow>
      <div className="pt-1">
        <Button
          type="button"
          size="sm"
          variant={armed ? 'default' : 'outline'}
          className="h-[22px] gap-1 px-2 text-xs"
          disabled={locked}
          aria-pressed={armed}
          onClick={() => onArm(!armed)}
          title="Show the start and end boxes in the viewer; drag them to set the zoom"
          data-dynamic-zoom-toggle
        >
          <SelectionIcon size={12} />
          Edit boxes in the viewer
        </Button>
      </div>
      {/* A dynamic zoom spans the whole clip, so it replaces any position /
          scale animation already there: said before the drag (B-067). */}
      {armed && wouldReplace && (
        <p
          className="text-destructive flex items-center gap-1 pt-1 text-2xs"
          title="This clip already has Position / Scale keyframes. Editing a box replaces that movement (one undo step); its other animated properties are left alone."
          data-dynamic-zoom-warning
        >
          <WarningIcon size={11} weight="fill" aria-hidden />
          Replaces this clip&apos;s existing movement
        </p>
      )}
    </EditorSection>
  );
}
