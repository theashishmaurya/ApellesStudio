/**
 * timelineView.ts — the Edit timeline's own VIEW state: its horizontal zoom,
 * its Clip Appearance, and the snapping and skimming toggles.
 *
 * What it is: a tiny zustand store. `pxPerSec` (how many CSS pixels one second
 * of timeline spans) used to be `useState` inside `TimelinePane`, which left
 * the zoom unreachable from anything but that component's buttons and wheel
 * handler — a human-only control, and a state the UI test harness could
 * neither reset between scenarios nor read (D-434 / H2). Now the pane,
 * `editor_set_timeline_view` and `editor_get_state.timelineView` all use this
 * one store (D-432's view-settings tool).
 *
 * D-432 P3 added, on the same tool and store rather than a second one:
 *   - **Clip Appearance** (spec §4.9, FCP's popover): `clipHeight`, the default
 *     height of every track that has no height of its own (`Track.height`, set
 *     by dragging its bottom edge); `bandRatio`, the share of a clip below its
 *     name strip given to the waveform band (0 = filmstrip only, 1 = waveform
 *     only, `clipAnatomy.ts`); `showNames` / `showBadges`, the name strip's
 *     label and badges.
 *   - **Snapping** (N, FCP's key): edit gestures, clip drags, drops and the
 *     playhead snap to edges / the playhead / markers (and beats, when the
 *     beat grid's own magnet is on too) only while this is on.
 *   - **Skimming** (S, FCP's key; off by default, the owner's answer in
 *     D-432): the viewer previews the frame under the pointer without moving
 *     the playhead (`previewPeek.ts`).
 *
 * B-359 item 6 — **the zoom and the scroll position are per timeline.** The
 * store keeps a `viewByTimeline` map keyed by `Timeline.id`, plus which
 * timeline the live `pxPerSec` belongs to (`viewTimelineId`). Switching
 * timelines (the switcher, `editor_set_active_timeline`, a project open)
 * files the outgoing timeline's zoom under its id and restores the incoming
 * one's, or the default for a timeline this session has not shown yet (a
 * harness run's timelines no longer leave the owner's timeline zoomed to
 * 20 %). The scroll offsets in the map are written by the pane on the way
 * out and read back on the way in (`TimelinePane`'s timeline-id effect); the
 * live scroll position itself stays in the pane's scroll store (D-437 S8).
 * The rest of the settings (Clip Appearance, snapping, skimming) are app
 * preferences, the same on every timeline, as in Final Cut.
 *
 * What it does NOT do: anchor a zoom (the pane's `zoomBy` captures the frame
 * under the cursor / playhead and restores it after layout — a view gesture,
 * so it stays in the pane; a zoom set through here keeps `scrollLeft` as it
 * is), persist anything across app runs, or sit on the undo stack. It is display-only UI state,
 * like the preview viewport (D-218): never in `project.json`, never undoable.
 * A track's own height is the exception that IS in the document
 * (`Track.height`, so it follows its track on a reorder); this store holds only
 * the default it falls back to.
 */

import { create } from 'zustand';

import { DEFAULT_PX_PER_SEC, MAX_PX_PER_SEC, MIN_PX_PER_SEC } from './ruler';
import { CLIP_BAND_RATIO } from './clipAnatomy';
import {
  clampTrackHeight,
  DEFAULT_TRACK_HEIGHT,
  isTrackHeightPreset,
  presetOfHeight,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
  TRACK_HEIGHT_PRESETS,
} from './trackHeight';
import type { TrimTool } from './trimMode';
import { useEditorTimelineStore } from './timelineStore';

/** `pxPerSec` clamped into the zoom range the ruler's tick ladder is sized for. */
export function clampPxPerSec(pxPerSec: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec));
}

/** The toolbar's readout: percent of the default zoom (90 px/s = 100 %). */
export function timelineZoomPct(pxPerSec: number): number {
  return Math.round((pxPerSec / DEFAULT_PX_PER_SEC) * 100);
}

/** The Clip Appearance popover's waveform/filmstrip stops (FCP's ratio
 *  buttons): filmstrip only, the spec's balanced default, waveform-led,
 *  waveform only. Any value in 0..1 is valid through the MCP tool. */
export const BAND_RATIO_STOPS = [0, CLIP_BAND_RATIO, 0.6, 1] as const;

/** A band ratio clamped into 0..1. */
export function clampBandRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return CLIP_BAND_RATIO;
  return Math.min(1, Math.max(0, ratio));
}

export interface TimelineViewSettings {
  pxPerSec: number;
  /** default track height, px (the Clip Appearance S/M/L/XL) */
  clipHeight: number;
  /** share of a clip's body (below the strip) given to the waveform band */
  bandRatio: number;
  showNames: boolean;
  showBadges: boolean;
  snapping: boolean;
  skimming: boolean;
}

/** What a fresh session (and the UI harness's per-scenario reset) starts from. */
export const DEFAULT_TIMELINE_VIEW: TimelineViewSettings = {
  pxPerSec: DEFAULT_PX_PER_SEC,
  clipHeight: DEFAULT_TRACK_HEIGHT,
  bandRatio: CLIP_BAND_RATIO,
  showNames: true,
  showBadges: true,
  snapping: true,
  skimming: false,
};

/** B-359 item 6 — what one timeline remembers of its view while another is
 *  shown: its zoom and where its lanes were scrolled to. */
export interface PerTimelineView {
  pxPerSec: number;
  scrollLeft: number;
  scrollTop: number;
}

/** A timeline this session has not shown yet starts here. */
export const DEFAULT_PER_TIMELINE_VIEW: PerTimelineView = {
  pxPerSec: DEFAULT_TIMELINE_VIEW.pxPerSec,
  scrollLeft: 0,
  scrollTop: 0,
};

/** The tool a fresh session / the harness's per-scenario reset starts on. */
export const DEFAULT_TRIM_TOOL: TrimTool = 'select';

interface TimelineViewState extends TimelineViewSettings {
  /** Always clamped, so no caller can leave the ruler outside its ladder. */
  setPxPerSec: (pxPerSec: number) => void;
  /** The timeline's active edit tool (the trim palette, D-261): the ONE store the
   *  toolbar buttons, the tool shortcuts and `editor_set_tool` all read and write.
   *  Not part of `TimelineViewSettings` (not in `editor_set_timeline_view`), but
   *  `resetView` puts it back too. */
  trimTool: TrimTool;
  setTrimTool: (tool: TrimTool) => void;
  /** Any subset of the settings; numbers are clamped on the way in. */
  setView: (patch: Partial<TimelineViewSettings>) => void;
  /** Back to `DEFAULT_TIMELINE_VIEW` (the test suites' per-test reset), and
   *  every timeline's remembered zoom and scroll forgotten. */
  resetView: () => void;
  /** B-359 item 6 — the timeline the live `pxPerSec` belongs to (`null`: none open). */
  viewTimelineId: string | null;
  /** B-359 item 6 — every other timeline's remembered view, by `Timeline.id`. */
  viewByTimeline: Readonly<Record<string, PerTimelineView>>;
  /** Show `id`'s view: file the current zoom under the outgoing timeline and
   *  load `id`'s (or the default). A no-op when `id` is already the one shown.
   *  `scroll` is the outgoing timeline's scroll offsets, when the caller has
   *  them (the pane does; a switch with the pane unmounted keeps the old ones). */
  showTimelineView: (id: string | null, scroll?: { left: number; top: number }) => void;
  /** Remember `id`'s scroll offsets (the pane, as it leaves a timeline). */
  rememberTimelineScroll: (id: string, scroll: { left: number; top: number }) => void;
}

/** `id`'s remembered view, or the default for a timeline not shown yet. */
export function perTimelineView(
  byTimeline: Readonly<Record<string, PerTimelineView>>,
  id: string | null,
): PerTimelineView {
  return (id !== null ? byTimeline[id] : undefined) ?? DEFAULT_PER_TIMELINE_VIEW;
}

/** `editor_get_state.timelineView` / `editor_set_timeline_view`'s report: the
 *  settings plus the derived readouts (`zoom` as a multiplier of the default,
 *  `pct` as the toolbar shows it, the clip height's preset name or `null` for
 *  a custom px value). */
export function timelineViewReport(v: TimelineViewSettings) {
  return {
    zoom: v.pxPerSec / DEFAULT_PX_PER_SEC,
    pct: timelineZoomPct(v.pxPerSec),
    pxPerSec: v.pxPerSec,
    clipHeight: v.clipHeight,
    clipHeightPreset: presetOfHeight(v.clipHeight),
    bandRatio: v.bandRatio,
    showNames: v.showNames,
    showBadges: v.showBadges,
    snapping: v.snapping,
    skimming: v.skimming,
  };
}

/** The wire arguments of `editor_set_timeline_view` (camelCase, as both MCP
 *  servers forward them). */
export interface TimelineViewArgs {
  zoom?: unknown;
  clipHeight?: unknown;
  bandRatio?: unknown;
  showNames?: unknown;
  showBadges?: unknown;
  snapping?: unknown;
  skimming?: unknown;
}

/** Validate `editor_set_timeline_view`'s arguments into a store patch, or say
 *  what is wrong. At least one field is required; `notes` lists anything that
 *  was clamped. Pure, so it is unit-tested without the store. */
export function timelineViewPatch(
  a: TimelineViewArgs | undefined,
): { patch: Partial<TimelineViewSettings>; notes: string[] } | { error: string } {
  const patch: Partial<TimelineViewSettings> = {};
  const notes: string[] = [];
  if (!a || Object.values(a).every((v) => v === undefined)) {
    return {
      error:
        'pass at least one of zoom, clip_height, band_ratio, show_names, show_badges, snapping, skimming',
    };
  }
  if (a.zoom !== undefined) {
    const zoom = a.zoom === 'default' || a.zoom === null ? 1 : Number(a.zoom);
    if (!Number.isFinite(zoom) || zoom <= 0) {
      return { error: 'zoom must be a positive multiplier (1 = the default 100 %) or "default"' };
    }
    const wanted = zoom * DEFAULT_PX_PER_SEC;
    patch.pxPerSec = clampPxPerSec(wanted);
    if (patch.pxPerSec !== wanted) {
      notes.push(
        `zoom ${zoom} is outside ${(MIN_PX_PER_SEC / DEFAULT_PX_PER_SEC).toFixed(2)}..${(MAX_PX_PER_SEC / DEFAULT_PX_PER_SEC).toFixed(1)} and was clamped`,
      );
    }
  }
  if (a.clipHeight !== undefined) {
    const raw = a.clipHeight;
    let px: number | null = null;
    if (raw === 'default' || raw === null) px = DEFAULT_TRACK_HEIGHT;
    else if (typeof raw === 'string' && isTrackHeightPreset(raw.toUpperCase())) {
      px = TRACK_HEIGHT_PRESETS[raw.toUpperCase() as keyof typeof TRACK_HEIGHT_PRESETS];
    } else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) px = raw;
    if (px === null) {
      return {
        error: `clip_height must be one of S / M / L / XL, a number of px (${TRACK_HEIGHT_MIN}-${TRACK_HEIGHT_MAX}), or "default"`,
      };
    }
    patch.clipHeight = clampTrackHeight(px);
    if (patch.clipHeight !== px) notes.push(`clip_height ${px} is outside ${TRACK_HEIGHT_MIN}..${TRACK_HEIGHT_MAX} px and was clamped`);
  }
  if (a.bandRatio !== undefined) {
    const ratio = a.bandRatio === 'default' || a.bandRatio === null ? CLIP_BAND_RATIO : Number(a.bandRatio);
    if (!Number.isFinite(ratio)) return { error: 'band_ratio must be a number from 0 (filmstrip only) to 1 (waveform only), or "default"' };
    patch.bandRatio = clampBandRatio(ratio);
    if (patch.bandRatio !== ratio) notes.push(`band_ratio ${ratio} is outside 0..1 and was clamped`);
  }
  for (const key of ['showNames', 'showBadges', 'snapping', 'skimming'] as const) {
    const v = a[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { error: `${snakeName(key)} must be true or false` };
    patch[key] = v;
  }
  return { patch, notes };
}

function snakeName(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export const useTimelineViewStore = create<TimelineViewState>((set) => ({
  ...DEFAULT_TIMELINE_VIEW,
  viewTimelineId: null,
  viewByTimeline: {},
  setPxPerSec: (pxPerSec) => set({ pxPerSec: clampPxPerSec(pxPerSec) }),
  trimTool: DEFAULT_TRIM_TOOL,
  setTrimTool: (trimTool) => set({ trimTool }),
  setView: (patch) =>
    set({
      ...patch,
      ...(patch.pxPerSec !== undefined ? { pxPerSec: clampPxPerSec(patch.pxPerSec) } : {}),
      ...(patch.clipHeight !== undefined ? { clipHeight: clampTrackHeight(patch.clipHeight) } : {}),
      ...(patch.bandRatio !== undefined ? { bandRatio: clampBandRatio(patch.bandRatio) } : {}),
    }),
  // Also forgets every timeline's remembered view (B-359 item 6): a reset view
  // is the default on every timeline, not only the one showing.
  resetView: () => set({ ...DEFAULT_TIMELINE_VIEW, trimTool: DEFAULT_TRIM_TOOL, viewByTimeline: {} }),
  showTimelineView: (id, scroll) =>
    set((s) => {
      if (id === s.viewTimelineId) return s;
      const byTimeline = { ...s.viewByTimeline };
      if (s.viewTimelineId !== null) {
        const old = perTimelineView(byTimeline, s.viewTimelineId);
        byTimeline[s.viewTimelineId] = {
          pxPerSec: s.pxPerSec,
          scrollLeft: scroll?.left ?? old.scrollLeft,
          scrollTop: scroll?.top ?? old.scrollTop,
        };
      }
      return { viewTimelineId: id, viewByTimeline: byTimeline, pxPerSec: perTimelineView(byTimeline, id).pxPerSec };
    }),
  rememberTimelineScroll: (id, scroll) =>
    set((s) => {
      const old = perTimelineView(s.viewByTimeline, id);
      if (old.scrollLeft === scroll.left && old.scrollTop === scroll.top) return s;
      return { viewByTimeline: { ...s.viewByTimeline, [id]: { ...old, scrollLeft: scroll.left, scrollTop: scroll.top } } };
    }),
}));

// B-359 item 6 — the live zoom follows the open timeline: whichever path
// switches it (the switcher, `editor_set_active_timeline`, a project open,
// creating a timeline), the view store files the old zoom and loads the new
// one here, with or without the pane mounted, so `editor_get_state.timelineView`
// always describes the timeline it sits beside. Idempotent, so a second
// subscription after a dev-mode module re-evaluation is harmless.
useTimelineViewStore.getState().showTimelineView(useEditorTimelineStore.getState().timeline?.id ?? null);
useEditorTimelineStore.subscribe((s, prev) => {
  if (s.timeline === prev.timeline) return;
  const id = s.timeline?.id ?? null;
  if (id !== useTimelineViewStore.getState().viewTimelineId) useTimelineViewStore.getState().showTimelineView(id);
});
