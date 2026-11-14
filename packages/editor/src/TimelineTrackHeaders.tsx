/**
 * @apelles/editor — the timeline's left header column: one row per track
 * (B-377 / D-461; extracted from `TimelinePane.tsx`, which held this list
 * inline since D-080 / D-098 / D-432 P3).
 *
 * What it is: the list, and the memo boundary around each row. It subscribes to
 * the store's tracks ITSELF — the pane does not hand them down — and every prop
 * a row receives is a primitive or one of two fixed-identity objects (the
 * labels array, re-derived only when a NAME changes; the pane's `actions`). So
 * an edit to a clip re-renders ZERO header rows, a rename re-renders exactly
 * the renamed one, and a render of the pane re-renders none of this at all
 * (this component is `memo`'d on a fixed-identity prop).
 *
 * That is the B-377 fix on this side: before it, the pane subscribed to the
 * whole timeline, so every track header in the column was rebuilt on every
 * edit. `TimelinePane.editRenders.dom.test.tsx` fails if it regresses.
 *
 * What it does NOT do: own any state (the inline rename draft is
 * `TrackHeader`'s own), run the height drag (the pane does — its guide line is
 * in the edit area), or decide what a toggle means (one `applyOp` each, in the
 * pane, the same ops the MCP tools run).
 */
import { memo, useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import { TrackHeader, trackDragId, type TrackDuckPatch } from './TrackHeader';
import { trackBadges, trackLabels } from './trackOps';
import { trackHeights } from './trackHeight';
import { useEditorTimelineStore } from './timelineStore';
import { useTimelineViewStore } from './timelineView';
import {
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_SYNC_LOCKED,
  DEFAULT_TRACK_GAIN,
  type Track,
} from './timeline';

/** What a header row asks the pane to do, by track index. Forwarded through
 *  `useStableActions`, so this object's identity never changes. */
export type TrackHeaderActions = {
  toggleTarget: (track: number) => void;
  toggleLock: (track: number) => void;
  toggleHidden: (track: number) => void;
  toggleMute: (track: number) => void;
  toggleSyncLocked: (track: number) => void;
  toggleBeats: (track: number) => void;
  changeDuck: (track: number, patch: TrackDuckPatch) => void;
  rename: (track: number, name: string | null) => void;
  setHeight: (track: number, height: number | null) => void;
  remove: (track: number) => void;
  heightDragStart: (e: ReactPointerEvent<HTMLElement>, track: number) => void;
};

/** No tracks: a module-level constant, so the selector below returns the same
 *  array every time rather than a fresh `[]` (which would re-render forever). */
const NO_TRACKS: readonly Track[] = [];

/** `trackLabels` / `trackBadges` joined into one string each: the row list
 *  subscribes to the track NAMES, not to the tracks, so a clip edit leaves both
 *  arrays identical. No label can contain it. */
const LABEL_SEP = '\u0000';

/** One header row, memoised on PRIMITIVES only — never on the `Track` object,
 *  whose identity changes the moment one of its clips is edited (and a clip
 *  edit must not re-render a track's header). */
const TrackHeaderRow = memo(function TrackHeaderRow({
  index,
  kind,
  height,
  ownHeight,
  badge,
  label,
  renamed,
  muted,
  locked,
  hidden,
  syncLocked,
  duckFrom,
  duckDb,
  duckAttackMs,
  duckReleaseMs,
  beatGrid,
  target,
  labels,
  actions,
}: {
  index: number;
  kind: Track['kind'];
  height: number;
  ownHeight: number | null;
  badge: string;
  label: string;
  renamed: boolean;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  syncLocked: boolean;
  duckFrom: number | null;
  duckDb: number;
  duckAttackMs: number;
  duckReleaseMs: number;
  beatGrid: boolean;
  target: boolean;
  labels: string[];
  actions: TrackHeaderActions;
}) {
  return (
    <TrackHeader
      index={index}
      kind={kind}
      height={height}
      ownHeight={ownHeight}
      badge={badge}
      label={label}
      renamed={renamed}
      muted={muted}
      locked={locked}
      hidden={hidden}
      syncLocked={syncLocked}
      // Defaulted by the list below, once, so the control never has to read an
      // absent field as falsy — `0 ms` attack/release is a real (instant,
      // clicky) setting, not "unset".
      duck={{ from: duckFrom, db: duckDb, attackMs: duckAttackMs, releaseMs: duckReleaseMs }}
      trackLabels={labels}
      onToggleLock={() => actions.toggleLock(index)}
      onToggleHidden={() => actions.toggleHidden(index)}
      onToggleMute={() => actions.toggleMute(index)}
      onToggleSyncLocked={() => actions.toggleSyncLocked(index)}
      onDuckChange={(patch) => actions.changeDuck(index, patch)}
      onRemove={() => actions.remove(index)}
      beatGrid={beatGrid}
      onToggleBeats={() => actions.toggleBeats(index)}
      target={target}
      onToggleTarget={() => actions.toggleTarget(index)}
      onRename={(name) => actions.rename(index, name)}
      onSetHeight={(h) => actions.setHeight(index, h)}
      onHeightDragStart={actions.heightDragStart}
    />
  );
});

export const TimelineTrackHeaders = memo(function TimelineTrackHeaders({
  actions,
}: {
  actions: TrackHeaderActions;
}) {
  const tracks = useEditorTimelineStore((s) => s.timeline?.tracks ?? NO_TRACKS);
  const trackCount = useEditorTimelineStore((s) => s.timeline?.tracks.length ?? 0);
  const viewClipHeight = useTimelineViewStore((s) => s.clipHeight);
  const labelsKey = useEditorTimelineStore((s) => (s.timeline ? trackLabels(s.timeline).join(LABEL_SEP) : ''));
  const badgesKey = useEditorTimelineStore((s) => (s.timeline ? trackBadges(s.timeline).join(LABEL_SEP) : ''));
  const labels = useMemo(() => (labelsKey === '' ? [] : labelsKey.split(LABEL_SEP)), [labelsKey]);
  const badges = useMemo(() => (badgesKey === '' ? [] : badgesKey.split(LABEL_SEP)), [badgesKey]);
  const heights = useMemo(() => trackHeights(tracks, viewClipHeight), [tracks, viewClipHeight]);
  /** B-377 — the sortable ids, derived from the track COUNT and nothing else.
   *  `SortableContext` memoises its context value on the `items` array it is
   *  handed, and every `useSortable` consumer (every header row's body) is a
   *  context consumer, which a `memo` boundary cannot shield: a fresh
   *  `tracks.map(...)` here re-ran every header's body on every edit even
   *  though no row's props had changed. Nothing about these ids depends on a
   *  clip. */
  const items = useMemo(() => Array.from({ length: trackCount }, (_, i) => trackDragId(i)), [trackCount]);

  return (
    /* D-098 — real `@dnd-kit/sortable` list, replacing D-094's native HTML5
       `draggable` track-reorder handle (see `TrackHeader.tsx`'s own doc for
       why). `items` is the track ids in order — `SortableContext` uses it to
       compute the live "other rows slide out of the way" animation during a
       drag. */
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {tracks.map((track, i) => (
        <TrackHeaderRow
          key={i}
          index={i}
          kind={track.kind}
          height={heights[i]}
          ownHeight={track.height ?? null}
          badge={badges[i]}
          label={labels[i]}
          renamed={!!track.name?.trim()}
          muted={track.kind === 'audio' && (track.gain ?? DEFAULT_TRACK_GAIN) <= 0}
          locked={!!track.locked}
          hidden={track.kind === 'video' && !!track.hidden}
          syncLocked={track.sync_locked ?? DEFAULT_SYNC_LOCKED}
          duckFrom={track.duck_from ?? null}
          duckDb={track.duck_db ?? 0}
          duckAttackMs={track.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS}
          duckReleaseMs={track.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS}
          beatGrid={track.beat_grid != null}
          target={!!track.target}
          labels={labels}
          actions={actions}
        />
      ))}
    </SortableContext>
  );
});
