/**
 * @apelles/editor — `MediaThumbnail`: the one kind-aware picture well for a
 * piece of media (Sources tile, project card, shot strip, marker index).
 *
 * What it is: a 16:9 (overridable) well that shows what a media item IS.
 * A cached poster `src` when there is one; otherwise by `kind` — a video gets
 * the film-strip glyph, a still the Image glyph, a Motion render the film-slate
 * glyph, a text/title item the TextT glyph, and an AUDIO item its own waveform
 * (the timeline's `Waveform` component, `variant="band"`, over the cached
 * `getPeaks` envelope, in the `clip-audio` colour tokens) with a small
 * MusicNotes glyph — and the glyph alone, centred, while peaks load or are
 * unavailable. `status="loading"` shows a spinner, `status="offline"` an
 * amber WifiSlash badge. A duration badge is drawn whenever a length is given.
 * `children` render as overlays inside the well (hover buttons, checkboxes).
 *
 * What it does NOT do: fetch posters, decode audio (it asks the shared
 * `getPeaks` cache once per tile) or know about the media pool — callers map
 * their item to these props (`mediaItemThumbnailProps` does it for a pool item).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CircleNotchIcon,
  FilmSlateIcon,
  FilmStripIcon,
  ImageIcon,
  MusicNotesIcon,
  TextTIcon,
  WifiSlashIcon,
  type Icon,
} from '@phosphor-icons/react';

import { isAudioOnlyItem, type MediaItem } from '@apelles/bridge';
import { cn } from '@apelles/ui';

import { Waveform, getPeaks } from './Waveform';

export type MediaThumbnailKind = 'video' | 'audio' | 'image' | 'motion' | 'text';

export interface MediaThumbnailProps {
  kind: MediaThumbnailKind;
  /** A poster frame / still URL or data URL. */
  src?: string | null;
  /** The audio file the waveform is drawn from (`kind: 'audio'`). */
  sourcePath?: string;
  durationSecs?: number | null;
  status?: 'ready' | 'loading' | 'offline';
  className?: string;
  /** Overlays inside the well. */
  children?: ReactNode;
}

/** The placeholder glyph per kind (audio's lives in `AudioWave`). */
const KIND_GLYPHS: Record<Exclude<MediaThumbnailKind, 'audio'>, Icon> = {
  video: FilmStripIcon,
  image: ImageIcon,
  motion: FilmSlateIcon,
  text: TextTIcon,
};

/** Fallback drawing width before the well is measured (and under jsdom, which
 *  never measures), and the band's height. */
const FALLBACK_WAVE_WIDTH_PX = 160;
const WAVE_HEIGHT_PX = 56;
const MAX_WAVE_BUCKETS = 600;

/** `m:ss` (or `h:mm:ss`) for a duration badge. */
export function formatDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function AudioWave({
  sourcePath,
  durationSecs,
  offline,
}: {
  sourcePath: string | undefined;
  durationSecs: number;
  offline: boolean;
}) {
  const wellRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WAVE_WIDTH_PX);
  const [hasPeaks, setHasPeaks] = useState(false);

  useEffect(() => {
    const el = wellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHasPeaks(false);
    if (!sourcePath || offline || durationSecs <= 0) return;
    const buckets = Math.max(1, Math.min(MAX_WAVE_BUCKETS, Math.round(width / 2)));
    void getPeaks(sourcePath, 0, durationSecs, buckets).then((p) => {
      if (!cancelled) setHasPeaks(p.length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, [sourcePath, offline, durationSecs, width]);

  return (
    <div
      ref={wellRef}
      data-chroma-audio-tile
      className="absolute inset-0 bg-clip-audio text-clip-audio-wave-ink"
    >
      {hasPeaks && sourcePath ? (
        <>
          <div className="absolute inset-x-0 bottom-0" style={{ height: WAVE_HEIGHT_PX }}>
            <Waveform
              sourcePath={sourcePath}
              startSecs={0}
              durationSecs={durationSecs}
              width={width}
              height={WAVE_HEIGHT_PX}
              variant="band"
            />
          </div>
          <MusicNotesIcon data-chroma-audio-glyph className="absolute top-1 left-1 size-3 opacity-80" />
        </>
      ) : (
        <MusicNotesIcon data-chroma-audio-glyph className="absolute inset-0 m-auto size-5 opacity-70" />
      )}
    </div>
  );
}

export function MediaThumbnail({
  kind,
  src,
  sourcePath,
  durationSecs,
  status = 'ready',
  className,
  children,
}: MediaThumbnailProps) {
  const duration = durationSecs ?? 0;
  let picture: ReactNode;
  if (src) {
    picture = (
      <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
    );
  } else if (status === 'loading') {
    picture = <CircleNotchIcon data-chroma-thumb-loading className="size-4 animate-spin text-text-secondary" />;
  } else if (kind === 'audio') {
    picture = <AudioWave sourcePath={sourcePath} durationSecs={duration} offline={status === 'offline'} />;
  } else {
    const Glyph = KIND_GLYPHS[kind];
    picture = <Glyph data-chroma-thumb-glyph={kind} className="size-4 text-text-secondary/50" />;
  }
  return (
    <div
      data-chroma-thumbnail={kind}
      className={cn(
        'relative aspect-video w-full overflow-hidden rounded bg-black/30 flex items-center justify-center',
        className,
      )}
    >
      {picture}
      {duration > 0 && (
        <span
          data-chroma-tile-duration
          className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] leading-tight text-white tabular-nums"
        >
          {formatDuration(duration)}
        </span>
      )}
      {status === 'offline' && (
        <div data-chroma-thumb-offline className="absolute top-1 right-1 text-amber-400" title="Media offline">
          <WifiSlashIcon className="size-3" />
        </div>
      )}
      {children}
    </div>
  );
}

/** Map a media-pool item to `MediaThumbnail` props: a still is `image`, an
 *  audio-only source `audio` (B-089), a Motion render `motion` (D-260), else
 *  `video`. */
export function mediaItemThumbnailProps(item: MediaItem): MediaThumbnailProps {
  const kind: MediaThumbnailKind = item.image
    ? 'image'
    : isAudioOnlyItem(item)
      ? 'audio'
      : item.motionSceneId
        ? 'motion'
        : 'video';
  return {
    kind,
    src: item.thumb,
    sourcePath: item.sourcePath,
    durationSecs: item.video?.durationSecs,
    status: item.offline ? 'offline' : 'ready',
  };
}
