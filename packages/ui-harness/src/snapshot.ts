/**
 * snapshot.ts — the app's state, shaped for assertions (D-434).
 *
 * What it is: the three reads a scenario asserts against, normalised:
 *   - `timelineSnapshot` — `editor_get_timeline`'s DTO keyed by the fixture's
 *     own clip NAMES (`clips.a.startFrame`) as well as by id, with each clip's
 *     timeline `end` precomputed, so an assertion reads like the expectation
 *     it encodes ("clip a ends 15 frames later") rather than like index
 *     bookkeeping that breaks the moment a split renumbers a track;
 *   - `viewSnapshot` — the edit area's zoom/scroll/layout readout
 *     (`TIMELINE_VIEW_ATTRS`) and its rect, read through `debug_dom_tree`;
 *   - the raw `editor_get_state`, used as-is.
 *
 * What it does NOT do: fetch. The runner fetches; these are pure functions of
 *   what came back, unit-tested in `snapshot.test.ts`.
 */

import { TIMELINE_TEST_IDS, TIMELINE_VIEW_ATTRS } from '@apelles/editor/src/timelineTestIds.ts';

export interface ClipSnap {
  id: string;
  name: string | null;
  track: number;
  index: number;
  startFrame: number;
  /** Timeline frames (the fixture's media shares the timeline's rate). */
  duration: number;
  /** `startFrame + duration`. */
  end: number;
  sourceStart: number;
  linkGroup: string | null;
}

export interface TimelineSnap {
  id: string | null;
  durationFrames: number;
  /** By fixture name, and by id for clips the fixture did not name (a split's new half). */
  clips: Record<string, ClipSnap>;
  /** Each track's clips in timeline order. */
  tracks: ClipSnap[][];
  clipCount: number;
  markers: { id: string; name: string | null; frame: number }[];
}

interface ClipDto {
  id: string;
  name?: string;
  index: number;
  startFrame: number;
  duration: number;
  sourceStart?: number;
  linkGroup?: string | null;
}

interface TimelineDto {
  id?: string;
  durationFrames?: number;
  tracks?: { index: number; clips?: ClipDto[] }[];
  markers?: { id: string; name?: string | null; frame: number }[];
}

/** `names` maps a clip id to the fixture's name for it. */
export function timelineSnapshot(dto: unknown, names: Readonly<Record<string, string>> = {}): TimelineSnap {
  const tl = (dto ?? {}) as TimelineDto;
  const clips: Record<string, ClipSnap> = {};
  const tracks: ClipSnap[][] = [];
  let clipCount = 0;
  for (const [t, track] of (tl.tracks ?? []).entries()) {
    const row: ClipSnap[] = [];
    for (const c of track.clips ?? []) {
      const snap: ClipSnap = {
        id: c.id,
        name: names[c.id] ?? null,
        track: t,
        index: c.index,
        startFrame: c.startFrame,
        duration: c.duration,
        end: c.startFrame + c.duration,
        sourceStart: c.sourceStart ?? 0,
        linkGroup: c.linkGroup ?? null,
      };
      row.push(snap);
      clips[c.id] = snap;
      if (snap.name) clips[snap.name] = snap;
      clipCount += 1;
    }
    row.sort((a, b) => a.startFrame - b.startFrame);
    tracks.push(row);
  }
  return {
    id: tl.id ?? null,
    durationFrames: tl.durationFrames ?? 0,
    clips,
    tracks,
    clipCount,
    markers: (tl.markers ?? []).map((m) => ({ id: m.id, name: m.name ?? null, frame: m.frame })),
  };
}

export interface ViewSnap {
  pxPerSec: number;
  scrollLeft: number;
  scrollTop: number;
  fps: number;
  startLeft: number;
  rowHeight: number;
  rowsTop: number;
  /** D-432 P3 — each row's top below `rowsTop` (one past the last), when the
   *  app reports it: tracks have their own heights. */
  rowTops?: number[];
  /** The edit area's viewport rect, CSS px. */
  rect: { x: number; y: number; width: number; height: number };
}

/** The `debug_dom_tree` arguments that read the view readout. */
export const VIEW_QUERY = {
  selector: `[data-testid="${TIMELINE_TEST_IDS.editArea}"]`,
  maxDepth: 0,
  styles: [],
  text: false,
} as const;

/** `debug_dom_tree`'s reply for {@link VIEW_QUERY} → the view, or an error naming what is missing. */
export function viewSnapshot(domTree: unknown): ViewSnap | { error: string } {
  const root = (domTree as { root?: { attrs?: Record<string, string>; rect?: ViewSnap['rect'] } | null } | null)?.root;
  if (!root) return { error: 'the timeline edit area is not on screen (is the Edit tab showing with a timeline open?)' };
  const attrs = root.attrs ?? {};
  const num = (attr: string) => Number(attrs[attr]);
  const view: ViewSnap = {
    pxPerSec: num(TIMELINE_VIEW_ATTRS.pxPerSec),
    scrollLeft: num(TIMELINE_VIEW_ATTRS.scrollLeft),
    scrollTop: num(TIMELINE_VIEW_ATTRS.scrollTop),
    fps: num(TIMELINE_VIEW_ATTRS.fps),
    startLeft: num(TIMELINE_VIEW_ATTRS.startLeft),
    rowHeight: num(TIMELINE_VIEW_ATTRS.rowHeight),
    rowsTop: num(TIMELINE_VIEW_ATTRS.rowsTop),
    rect: root.rect ?? { x: 0, y: 0, width: 0, height: 0 },
  };
  const missing = Object.entries(view).filter(([k, v]) => k !== 'rect' && !Number.isFinite(v));
  if (missing.length) return { error: `the edit area lacks its view readout (${missing.map(([k]) => k).join(', ')}) — an older app build?` };
  const tops = attrs[TIMELINE_VIEW_ATTRS.rowTops];
  if (tops) view.rowTops = tops.split(',').map(Number);
  return view;
}

/** The viewport point at TIMELINE frame `frame` on track `track` — the
 *  arithmetic `TimelinePane` positions every overlay with. `fy` is how far
 *  down the row (0 top … 1 bottom), default the middle. */
export function pointAtFrame(view: ViewSnap, frame: number, track: number, fy = 0.5): { x: number; y: number } {
  const x = view.rect.x + view.startLeft + (frame / view.fps) * view.pxPerSec - view.scrollLeft;
  const tops = view.rowTops;
  const rowY =
    tops && track + 1 < tops.length
      ? tops[track] + fy * (tops[track + 1] - tops[track])
      : (track + fy) * view.rowHeight;
  const y = view.rect.y + view.rowsTop + rowY - view.scrollTop;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** CSS px that `frames` timeline frames span at the current zoom. */
export function framesToPx(view: ViewSnap, frames: number): number {
  return Math.round((frames / view.fps) * view.pxPerSec * 10) / 10;
}
