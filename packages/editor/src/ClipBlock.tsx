/**
 * @apelles/editor — the inside of one clip on the Edit timeline (D-432 P2,
 * `docs/notes/ui-redesign.md` §4.3; the owner's FCP reference
 * `scratch/bug-refs/2026-10-31-fcp-clip-reference.png`).
 *
 * What it is: the clip's ANATOMY — a thin name strip across the top in the
 * kind's darker `-strip` colour, the filmstrip under it, and the clip's own
 * audio as a rectified waveform band in the same block (an audio clip is strip
 * plus waveform; titles, captions and adjustment clips are strip plus their flat
 * kind colour). Heights come from `clipAnatomy.ts`; the label, the badges and
 * the cut hairline drop out below their width thresholds. Nothing floats over
 * the picture: the keyframes badge that opens the curve lane (D-233) lives in
 * the strip, not over the filmstrip as the old corner button did.
 *
 * The picture and the waveform sit in one `[data-chroma-clip-media]` layer, so
 * a slip or a head trim can slide the clip's content inside its fixed frame
 * with one `transform` (`useEditGesture.ts`).
 *
 * What it does NOT do: selection, hover, drag or trim. Those belong to the
 * clip BODY around it (`TimelinePane`'s `ClipBody`: the selection outline, the
 * edge zones, the dnd-kit move) — this renders the same content for the
 * resting clip and for the drag ghost.
 */

import {
  ClosedCaptioningIcon,
  DiamondsFourIcon,
  GaugeIcon,
  MagicWandIcon,
  TextTIcon,
  WaveformIcon,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

import { adjustmentSummary } from './adjustment';
import { captionLines } from './caption';
import { clipAnatomy, clipChrome, type ClipKind } from './clipAnatomy';
import { Filmstrip } from './Filmstrip';
import type { Clip } from './timeline';
import { TIMELINE_TEST_IDS } from './timelineTestIds';
import { Waveform } from './Waveform';

/** The opaque media colours per kind (`--color-clip-*`, one token source). Static
 *  class strings so Tailwind's scanner sees every one of them. */
export const CLIP_KIND_CLASSES: Record<ClipKind, { body: string; strip: string; ink: string }> = {
  video: { body: 'bg-clip-video', strip: 'bg-clip-video-strip', ink: 'text-clip-video-wave-ink' },
  audio: { body: 'bg-clip-audio', strip: 'bg-clip-audio-strip', ink: 'text-clip-audio-wave-ink' },
  text: { body: 'bg-clip-text', strip: 'bg-clip-text-strip', ink: 'text-clip-label' },
  caption: { body: 'bg-clip-caption', strip: 'bg-clip-caption-strip', ink: 'text-clip-label' },
  adjustment: { body: 'bg-clip-adjustment', strip: 'bg-clip-adjustment-strip', ink: 'text-clip-label' },
};

/** A small kind glyph leads the strip for every kind but video, whose
 *  filmstrip already says what it is (spec §4.3). */
const KIND_ICONS: Partial<Record<ClipKind, PhosphorIcon>> = {
  audio: WaveformIcon,
  text: TextTIcon,
  caption: ClosedCaptioningIcon,
  adjustment: MagicWandIcon,
};

/** The strip glyph size, px. */
const STRIP_ICON_PX = 10;

function clipLabel(clip: Clip, kind: ClipKind): string {
  if (kind === 'text') return clip.text?.content || clip.name || 'Title';
  if (kind === 'caption') return (clip.caption && captionLines(clip.caption.text).join(' ')) || 'Caption';
  if (kind === 'adjustment') return clip.name || 'Adjustment Clip';
  return clip.name;
}

export interface ClipBlockProps {
  clip: Clip;
  kind: ClipKind;
  /** the track's height (the clip is 2 px shorter) */
  trackHeight: number;
  widthPx: number;
  /** the timeline's frame rate — a clip's source window is converted with its
   *  own `source_fps` when it has one */
  fps: number;
  /** the visible slice of this clip, px from its own left edge (D-128/D-334):
   *  the filmstrip and waveform fetch only that */
  visibleStartPx?: number;
  visibleEndPx?: number;
  /** the cut at this clip's left edge (`cutStyleAt`) */
  cut?: 'none' | 'cut' | 'through';
  /** D-233 — the clip animates something: the strip shows the keyframes badge */
  keyframed?: boolean;
  /** the curve lane is open on this clip */
  curveOpen?: boolean;
  /** toggle the curve lane; absent on the drag ghost */
  onToggleCurve?: () => void;
}

export function ClipBlock({
  clip,
  kind,
  trackHeight,
  widthPx,
  fps,
  visibleStartPx,
  visibleEndPx,
  cut = 'none',
  keyframed = false,
  curveOpen = false,
  onToggleCurve,
}: ClipBlockProps) {
  const a = clipAnatomy(trackHeight, kind);
  const chrome = clipChrome(widthPx);
  const colours = CLIP_KIND_CLASSES[kind];
  const KindIcon = KIND_ICONS[kind];
  const srcFps = clip.source_fps ?? fps;
  const startSecs = clip.source_start / srcFps;
  const durationSecs = clip.duration / srcFps;
  const label = clipLabel(clip, kind);
  const speedRamped = (clip.speed_points?.length ?? 0) > 0;
  const showBadges = chrome.badges && !a.labelsOnly;

  return (
    <>
      {(a.film > 0 || a.band > 0 || a.wave > 0) && (
        <div
          data-chroma-clip-media=""
          className="pointer-events-none absolute inset-x-0"
          style={{ top: a.strip, height: a.height - a.strip }}
        >
          {a.film > 0 && (
            <div data-testid={TIMELINE_TEST_IDS.clipFilm} className="absolute inset-x-0 top-0 overflow-hidden" style={{ height: a.film }}>
              <Filmstrip
                sourcePath={clip.source_path}
                startSecs={startSecs}
                durationSecs={durationSecs}
                width={widthPx}
                height={a.film}
                visibleStartPx={visibleStartPx}
                visibleEndPx={visibleEndPx}
              />
            </div>
          )}
          {(a.band > 0 || a.wave > 0) && (
            <div
              data-testid={TIMELINE_TEST_IDS.clipBand}
              className={
                'absolute inset-x-0 bottom-0 overflow-hidden ' +
                colours.ink +
                // a video's band sits on its own blue-grey; an audio clip's is its body
                (kind === 'video' ? ' bg-clip-video-wave' : '')
              }
              style={{ height: kind === 'video' ? a.band : a.wave }}
            >
              <Waveform
                sourcePath={clip.source_path}
                startSecs={startSecs}
                durationSecs={durationSecs}
                width={widthPx}
                height={kind === 'video' ? a.band : a.wave}
                visibleStartPx={visibleStartPx}
                visibleEndPx={visibleEndPx}
                variant="band"
              />
            </div>
          )}
        </div>
      )}
      {kind === 'adjustment' && clip.adjustment && !a.labelsOnly && chrome.badges && (
        <div
          className="pointer-events-none absolute inset-x-0 truncate px-1 text-2xs text-clip-label/70"
          style={{ top: a.strip + 2 }}
        >
          {adjustmentSummary(clip.adjustment)}
        </div>
      )}
      <div
        data-testid={TIMELINE_TEST_IDS.clipStrip}
        className={
          'absolute inset-x-0 top-0 flex items-center gap-1 overflow-hidden px-1 font-semibold text-clip-label ' +
          (a.labelSize === 'xs' ? 'text-xs ' : 'text-2xs ') +
          (a.labelsOnly ? '' : colours.strip)
        }
        style={{ height: a.strip }}
      >
        {KindIcon && chrome.label && <KindIcon size={STRIP_ICON_PX} className="shrink-0 opacity-90" aria-hidden />}
        {chrome.label && <span className="min-w-0 flex-1 truncate">{label}</span>}
        {showBadges && speedRamped && (
          <span className="flex shrink-0 items-center rounded-xs bg-black/30 px-0.5" title="Speed ramp">
            <GaugeIcon size={STRIP_ICON_PX} aria-hidden />
          </span>
        )}
        {showBadges && keyframed && (
          <button
            type="button"
            data-testid={TIMELINE_TEST_IDS.clipKeyframesBadge}
            className={
              'flex shrink-0 items-center rounded-xs px-0.5 ' +
              (curveOpen ? 'bg-selection text-bg-primary' : 'bg-black/30 hover:bg-black/50')
            }
            title={curveOpen ? 'Close the curve editor' : `Edit ${clip.name || 'this clip'}'s ease curves`}
            aria-label="Toggle the curve editor for this clip"
            aria-pressed={curveOpen}
            disabled={!onToggleCurve}
            // A distinct hit target inside the clip: the press must not start a
            // move (dnd-kit) or an edit gesture.
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCurve?.();
            }}
          >
            <DiamondsFourIcon size={STRIP_ICON_PX} aria-hidden />
          </button>
        )}
      </div>
      {cut !== 'none' && chrome.hairline && (
        <div
          aria-hidden
          data-chroma-cut={cut}
          className={
            'pointer-events-none absolute inset-y-0 left-0 w-0 border-l ' +
            (cut === 'through' ? 'border-dashed border-black/70' : 'border-solid border-black/55')
          }
        />
      )}
    </>
  );
}
