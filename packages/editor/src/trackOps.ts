/**
 * `@apelles/editor` — the compact track read and the `get_timeline` filters
 * (B-318), plus the sync-lock toggle's argument check (B-315).
 *
 * - `editor_list_tracks` — one small row per track (index, kind, label, gain,
 *   muted / hidden / locked / sync-locked, ducking, clip count, which source
 *   files it holds, first / end frame). What an agent reads FIRST, to find
 *   which track holds the voice-over and which the music, instead of pulling
 *   every clip of a 13-track edit (~675K characters, B-296).
 * - `editor_get_timeline` filters — `track`, `startFrame` / `endFrame`, and
 *   `fields` slice the full timeline DTO so a caller reads only what it needs.
 * - `editor_set_track_sync_locked` — the MCP half of the track header's
 *   sync-lock button; it applies the SAME `set_track_sync_locked` op the
 *   button does.
 *
 * **What it does NOT do.** It owns no timeline maths and no DTO shape: the
 * clip fields come from `timelineDto` (`useEditorControl.ts`), and the filters
 * only drop rows and keys from that output. The GUI's track header is the
 * human interface to the same facts (a feature has both, CLAUDE.md).
 */
import {
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_SYNC_LOCKED,
  endFrame,
  timelineDuration,
  timelineFps,
  type Timeline,
} from './timeline';

type OpArgs = Record<string, unknown> | undefined;

/** "Video 1" / "Audio 1" / "Subtitle 1" — numbered per kind. The track header
 *  and `editor_list_tracks` both name a track this way (tracks carry no stored
 *  name). D-229 added the subtitle lane, named the way the reference names it. */
export function trackLabels(tl: Timeline): string[] {
  let videoN = 0;
  let audioN = 0;
  let subN = 0;
  return tl.tracks.map((t) => {
    if (t.kind === 'audio') return `Audio ${++audioN}`;
    if (t.kind === 'subtitle') return `Subtitle ${++subN}`;
    return `Video ${++videoN}`;
  });
}

/** At most this many distinct source file names per track row; `sourceCount`
 *  always carries the true number. */
export const MAX_SOURCES_PER_TRACK = 12;

/** The last path segment, for either separator. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** `editor_list_tracks`. */
export function listTracks(tl: Timeline) {
  const fps = timelineFps(tl);
  const labels = trackLabels(tl);
  return {
    ok: true,
    timelineId: tl.id,
    durationFrames: timelineDuration(tl),
    trackCount: tl.tracks.length,
    tracks: tl.tracks.map((t, index) => {
      const gain = t.gain ?? 1;
      const sources = [...new Set(t.clips.map((c) => c.source_path).filter((p) => p !== '').map(baseName))];
      const ducked = t.duck_from !== undefined && t.duck_from !== null;
      return {
        index,
        kind: t.kind,
        name: labels[index],
        gain,
        muted: gain === 0,
        hidden: !!t.hidden,
        locked: !!t.locked,
        syncLocked: t.sync_locked ?? DEFAULT_SYNC_LOCKED,
        duckFrom: ducked ? t.duck_from : null,
        ...(ducked
          ? {
              duckDb: t.duck_db ?? 0,
              duckAttackMs: t.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS,
              duckReleaseMs: t.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS,
            }
          : {}),
        ...(t.beat_grid ? { beatGrid: t.beat_grid } : {}),
        clipCount: t.clips.length,
        sourceCount: sources.length,
        sources: sources.slice(0, MAX_SOURCES_PER_TRACK),
        firstFrame: t.clips.length ? Math.min(...t.clips.map((c) => c.start_frame)) : null,
        endFrame: t.clips.length ? Math.max(...t.clips.map((c) => endFrame(c, fps))) : null,
      };
    }),
  };
}

/** Every key of a clip row in `editor_get_timeline`. `index` and `id` are
 *  always returned. A test pins this list to the DTO's real keys. */
export const CLIP_FIELDS = [
  'index', 'id', 'name', 'sourcePath', 'startFrame', 'duration', 'sourceStart', 'sourceLen', 'sourceFps',
  'linkGroup', 'opacity', 'positionX', 'positionY', 'scale', 'boxWidth', 'boxHeight', 'scaling', 'rotation',
  'cropLeft', 'cropTop', 'cropRight', 'cropBottom', 'keyframes', 'fadeInFrames', 'fadeOutFrames',
  'fadeInCurve', 'fadeOutCurve', 'fadeInCurveName', 'fadeOutCurveName', 'volume', 'pan', 'eqBands',
  'eqActive', 'text', 'highlights',
] as const;

const ALWAYS_FIELDS: readonly string[] = ['index', 'id'];

interface DtoClip {
  index: number;
  [key: string]: unknown;
}
interface DtoTrack {
  index: number;
  clips: DtoClip[];
  [key: string]: unknown;
}
interface DtoMarker {
  frame: number;
  endFrame: number;
  [key: string]: unknown;
}
interface DtoTimeline {
  tracks: DtoTrack[];
  markers: DtoMarker[];
  [key: string]: unknown;
}

/** Whether `a` asks for anything other than the whole timeline. */
function hasFilter(a: OpArgs): boolean {
  return ['track', 'startFrame', 'endFrame', 'fields'].some((k) => a?.[k] !== undefined && a?.[k] !== null);
}

function trackSet(tl: Timeline, raw: unknown): Set<number> | { error: string } {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set<number>();
  for (const v of list) {
    if (typeof v !== 'number' || !Number.isInteger(v) || !tl.tracks[v]) {
      return { error: `track must be a track index (or a list of them), 0..${tl.tracks.length - 1}` };
    }
    out.add(v);
  }
  return out;
}

function frameArg(raw: unknown, name: string): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.round(raw)
    : { error: `${name} must be a finite number of timeline frames` };
}

/**
 * Slice the full `timelineDto` (B-318): `track` (an index or a list) keeps only
 * those tracks; `startFrame` / `endFrame` keep only clips (and markers) that
 * overlap that TIMELINE-frame window (`endFrame` exclusive); `fields` keeps
 * only the named clip fields (plus `index` and `id`). With no filter the DTO
 * comes back untouched; a filtered answer says what it was filtered by, and
 * each track keeps its full `clipCount`.
 */
export function sliceTimelineDto<T extends DtoTimeline>(dto: T, tl: Timeline, a: OpArgs): T | { error: string } {
  if (!hasFilter(a)) return dto;

  let keepTracks: Set<number> | null = null;
  if (a?.track !== undefined && a?.track !== null) {
    const set = trackSet(tl, a.track);
    if ('error' in set) return set;
    keepTracks = set;
  }
  const from = frameArg(a?.startFrame, 'startFrame');
  if (typeof from === 'object') return from;
  const to = frameArg(a?.endFrame, 'endFrame');
  if (typeof to === 'object') return to;
  if (from !== undefined && to !== undefined && to <= from) {
    return { error: 'endFrame must be greater than startFrame' };
  }

  let keepFields: Set<string> | null = null;
  if (a?.fields !== undefined && a?.fields !== null) {
    const raw = a.fields;
    if (!Array.isArray(raw) || raw.some((f) => typeof f !== 'string')) {
      return { error: `fields must be a list of clip field names: ${CLIP_FIELDS.join(', ')}` };
    }
    const names = raw as string[];
    const unknown = names.filter((f) => !(CLIP_FIELDS as readonly string[]).includes(f));
    if (unknown.length) {
      return { error: `unknown clip field(s) ${unknown.join(', ')}; valid: ${CLIP_FIELDS.join(', ')}` };
    }
    keepFields = new Set([...ALWAYS_FIELDS, ...names]);
  }

  const fps = timelineFps(tl);
  const windowed = from !== undefined || to !== undefined;
  const fields = keepFields;
  const tracks = dto.tracks
    .filter((t) => keepTracks === null || keepTracks.has(t.index))
    .map((t) => {
      const source = tl.tracks[t.index];
      const clips = t.clips
        .filter((c) => {
          if (!windowed) return true;
          const clip = source.clips[c.index];
          return (to === undefined || clip.start_frame < to) && (from === undefined || endFrame(clip, fps) > from);
        })
        .map((c) =>
          fields === null ? c : (Object.fromEntries(Object.entries(c).filter(([k]) => fields.has(k))) as DtoClip),
        );
      return { ...t, clipCount: t.clips.length, clips };
    });
  const markers = windowed
    ? dto.markers.filter((m) => (to === undefined || m.frame < to) && (from === undefined || m.endFrame >= from))
    : dto.markers;
  return {
    ...dto,
    tracks,
    markers,
    filtered: {
      track: keepTracks ? [...keepTracks] : null,
      startFrame: from ?? null,
      endFrame: to ?? null,
      fields: fields ? [...fields] : null,
    },
  };
}

/** `editor_set_track_sync_locked`'s argument check: the track and flag, or the error. */
export function syncLockArgs(tl: Timeline, a: OpArgs): { track: number; syncLocked: boolean } | { error: string } {
  const track = typeof a?.track === 'number' ? a.track : Number.NaN;
  if (!Number.isInteger(track) || !tl.tracks[track]) {
    return { error: `track must be a track index, 0..${tl.tracks.length - 1}` };
  }
  if (typeof a?.syncLocked !== 'boolean') {
    return { error: 'syncLocked must be true or false' };
  }
  return { track, syncLocked: a.syncLocked };
}
