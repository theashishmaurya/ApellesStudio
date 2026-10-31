// Apelles — the picture area of one Sources-panel media tile (extracted from
// `SourcesPanel.tsx`).
//
// What it is: the 16:9 thumbnail well of a pool item. What it does: a cached
// poster frame when there is one; otherwise a placeholder that says what the
// item IS — a still gets the Image glyph (D-292), an audio-only source gets its
// own WAVEFORM (the same cached peaks and band drawing the timeline's audio
// clip uses, in the `clip-audio` colour tokens) with a small MusicNotes glyph,
// and anything else the film strip. While an audio tile's peaks are loading or
// unavailable it shows the MusicNotes glyph centred, never the film icon. A
// duration badge is drawn whenever the item has a probed length.
// What it does NOT do: decode audio itself — `getPeaks` is the one cached path
// (module cache + the Rust envelope cache), and it is asked once per tile.
import { useEffect, useRef, useState } from 'react';
import { FilmStripIcon, ImageIcon, MusicNotesIcon } from '@phosphor-icons/react';

import { isAudioOnlyItem, type MediaItem } from '@apelles/bridge';
import { Waveform, getPeaks } from '@apelles/editor';

/** Fallback drawing width before the well is measured (and under jsdom, which
 *  never measures), and the band's height. */
const FALLBACK_WAVE_WIDTH_PX = 160;
const WAVE_HEIGHT_PX = 56;

/** `m:ss` (or `h:mm:ss`) for a duration badge. */
export function formatTileDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function AudioWave({ item }: { item: MediaItem }) {
  const wellRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WAVE_WIDTH_PX);
  const [hasPeaks, setHasPeaks] = useState(false);
  const duration = item.video?.durationSecs ?? 0;

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
    if (item.offline || duration <= 0) return;
    void getPeaks(item.sourcePath, 0, duration, Math.max(1, Math.min(600, Math.round(width / 2)))).then(
      (p) => {
        if (!cancelled) setHasPeaks(p.length > 0);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [item.sourcePath, item.offline, duration, width]);

  return (
    <div
      ref={wellRef}
      data-chroma-audio-tile
      className="absolute inset-0 bg-clip-audio text-clip-audio-wave-ink"
    >
      {hasPeaks ? (
        <>
          <div className="absolute inset-x-0 bottom-0" style={{ height: WAVE_HEIGHT_PX }}>
            <Waveform
              sourcePath={item.sourcePath}
              startSecs={0}
              durationSecs={duration}
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

export function MediaTileThumb({ item }: { item: MediaItem }) {
  const duration = item.video?.durationSecs ?? 0;
  let picture;
  if (item.thumb) {
    picture = (
      <img src={item.thumb} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
    );
  } else if (item.image) {
    // D-292 — a still with no cached thumbnail yet says so honestly.
    picture = <ImageIcon className="size-4 text-text-secondary/50" />;
  } else if (isAudioOnlyItem(item)) {
    picture = <AudioWave item={item} />;
  } else {
    picture = <FilmStripIcon className="size-4 text-text-secondary/50" />;
  }
  return (
    <>
      {picture}
      {duration > 0 && (
        <span
          data-chroma-tile-duration
          className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] leading-tight text-white tabular-nums"
        >
          {formatTileDuration(duration)}
        </span>
      )}
    </>
  );
}
