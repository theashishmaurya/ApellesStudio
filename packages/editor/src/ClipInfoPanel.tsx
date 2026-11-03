/**
 * @apelles/editor — the clip Inspector's Info tab (D-432 §4.10, v0.3.0 gap
 * closure, B-359 item 1; `docs/notes/ui-redesign.md` §6e).
 *
 * **What it is.** A read-only page of facts about the selected clip, the way
 * Final Cut's Info inspector and Resolve's File tab show them: the media's
 * name, file and folder, its resolution, frame rate, length and audio, and the
 * clip's own in / out (source) and start / end / duration (timeline), all as
 * timecode.
 *
 * **Where the facts come from.** Only data the app already holds: the clip
 * (`Clip`) and its media-pool item (`useMediaPoolStore`, the probe results the
 * browser tiles already show; matched by `media_id`, else by `source_path`). A
 * generated layer (title, caption, adjustment) has no media, so it shows its
 * kind and its timeline facts only.
 *
 * **What it does NOT do.** Edit anything, probe anything, or show a codec: the
 * pool's probe (`MediaVideoInfo`) records no codec, and inventing one from the
 * file extension would be a guess presented as a fact. It shows the container
 * format (the extension) under that name instead.
 */
import type { ReactNode } from 'react';
import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { fmtTimecode } from '@apelles/player';

import { endFrame, isStillSource, type Clip } from './timeline';

/** One label / value row. Selectable text: Info is where a path gets copied. */
function InfoRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div data-chroma-info-row={label} className="grid min-h-[22px] grid-cols-[92px_minmax(0,1fr)] items-baseline gap-x-1.5">
      <span className="truncate text-xs text-text-secondary">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs text-text-primary select-text" title={title ?? value}>
        {value}
      </span>
    </div>
  );
}

function InfoGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border-color px-3 pt-2 pb-2.5">
      <h3 className="pb-1 text-sm font-semibold text-text-primary">{title}</h3>
      {children}
    </section>
  );
}

/** The clip's kind in words, for a clip with no media to describe it. */
export function clipKindLabel(clip: Clip): string {
  if (clip.text) return 'Title';
  if (clip.caption) return 'Caption';
  if (clip.adjustment) return 'Adjustment clip';
  if (isStillSource(clip.source_path)) return 'Still image';
  return 'Media clip';
}

/** `.mov` → `MOV`; `''` when the path has no extension. */
export function containerFormat(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}

/** The folder part of a path (everything before the last separator). */
function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : '';
}

function audioLabel(item: MediaItem): string | null {
  const v = item.video;
  if (!v) return null;
  if (v.hasAudio === false || v.audioChannels === 0) return 'None';
  if (v.audioChannels === 1) return 'Mono';
  if (v.audioChannels === 2) return 'Stereo';
  if (typeof v.audioChannels === 'number') return `${v.audioChannels} channels`;
  return v.hasAudio ? 'Yes' : null;
}

function fpsLabel(fps: number): string {
  return `${Number.isInteger(fps) ? fps : fps.toFixed(3).replace(/0+$/, '')} fps`;
}

export function ClipInfoPanel({ clip, fps }: { clip: Clip; fps: number }) {
  const item = useMediaPoolStore((s) =>
    clip.source_path
      ? (s.items.find((m) => (clip.media_id ? m.id === clip.media_id : false)) ??
        s.items.find((m) => m.sourcePath === clip.source_path) ??
        null)
      : null,
  );
  const generated = !!(clip.text || clip.caption || clip.adjustment);
  const sourceFps = clip.source_fps ?? item?.video?.fps ?? fps;
  const end = endFrame(clip, fps);
  const resolution = item?.video
    ? item.video.width > 0
      ? `${item.video.width} × ${item.video.height}`
      : null
    : item?.image
      ? `${item.image.width} × ${item.image.height}`
      : null;

  return (
    <div data-chroma-panel="clip-info" className="flex flex-col">
      {!generated && (
        <InfoGroup title="Media">
          <InfoRow label="Name" value={item?.name ?? clip.source_path.split(/[\\/]/).pop() ?? clip.name} />
          {containerFormat(clip.source_path) && <InfoRow label="Format" value={containerFormat(clip.source_path)} />}
          {resolution && <InfoRow label="Resolution" value={resolution} />}
          {item?.video && item.video.fps > 0 && <InfoRow label="Frame rate" value={fpsLabel(item.video.fps)} />}
          {item?.video && item.video.frameCount > 0 && (
            <InfoRow label="Length" value={fmtTimecode(item.video.frameCount, item.video.fps || sourceFps)} />
          )}
          {item && audioLabel(item) && <InfoRow label="Audio" value={audioLabel(item) ?? ''} />}
          {folderOf(clip.source_path) && <InfoRow label="Folder" value={folderOf(clip.source_path)} />}
          <InfoRow label="Path" value={clip.source_path} />
          {item?.offline && <p className="pt-1 text-2xs text-destructive">The file is missing from this path.</p>}
          {!item && (
            <p className="pt-1 text-2xs leading-snug text-text-tertiary">
              Not in this project&apos;s media pool, so its probed facts are not known.
            </p>
          )}
        </InfoGroup>
      )}
      {generated && (
        <InfoGroup title="Clip">
          <InfoRow label="Kind" value={clipKindLabel(clip)} />
        </InfoGroup>
      )}
      {!generated && (
        <InfoGroup title="Source">
          <InfoRow label="In" value={fmtTimecode(clip.source_start, sourceFps)} />
          <InfoRow label="Out" value={fmtTimecode(clip.source_start + clip.duration, sourceFps)} />
        </InfoGroup>
      )}
      <InfoGroup title="Timeline">
        <InfoRow label="Start" value={fmtTimecode(clip.start_frame, fps)} />
        <InfoRow label="End" value={fmtTimecode(end, fps)} />
        <InfoRow label="Duration" value={fmtTimecode(end - clip.start_frame, fps)} />
      </InfoGroup>
    </div>
  );
}
