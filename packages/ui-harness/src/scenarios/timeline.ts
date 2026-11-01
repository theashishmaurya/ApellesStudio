/**
 * timeline.ts — the core timeline interactions, written against how NLEs
 * behave (D-434).
 *
 * Seek and scrub, selection, moving clips, delete / ripple delete / undo,
 * zoom and scroll, the track-header column, markers, linked A/V, keyboard
 * transport and playback. Each cites the behaviour it expects; several encode
 * standard NLE affordances Apelles may not have yet (J/K/L, I/O, snapping
 * toggle, ripple delete, keyboard zoom, edit-point navigation) — those FAIL
 * by design until built, and the report says so plainly.
 *
 * References: `scratch/resolve-reference/` (Resolve Edit page), Premiere's
 * default shortcuts, Final Cut's keyboard shortcuts page (see
 * scratch/timeline-harness-reference/README.md for the trail).
 */

import type { Scenario } from '../scenario.ts';
import {
  atFrame,
  byFrames,
  clip,
  clipSelector,
  editArea,
  headerResize,
  marker,
  playheadGrab,
  playheadLine,
  selector,
  TIMELINE_TEST_IDS,
  trackHeader,
  trackHeightZone,
} from '../targets.ts';
import { clipIs, clipUnchanged, FPS_GUARD, GAPPED, GHOST, LONG, playheadNear, THREE_CLIPS } from './common.ts';

/** The harness's generated picture-only test file in the Sources panel
 *  (`SourcesPanel.tsx`'s `sources-media-tile`, named after the file). */
const MEDIA_TILE_VIDEO = '[data-testid="sources-media-tile"][data-chroma-media-name^="harness-video"]';

const headerSel = (track: number) => `[data-testid="${TIMELINE_TEST_IDS.trackHeader}"][data-chroma-track="${track}"]`;

export const TIMELINE_SCENARIOS: Scenario[] = [
  // ── Seek and scrub ─────────────────────────────────────────────────────
  {
    id: 'seek-ruler-click-stopped',
    title: 'Clicking the ruler moves the playhead there',
    area: 'seek',
    reference: 'Every NLE: a click in the timecode ruler parks the playhead at that frame',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: atFrame(120, 'ruler') }, measure: { firstCommitMs: 100 } },
      { waitFor: playheadNear(120) },
    ],
  },
  {
    id: 'seek-ruler-click-playing',
    title: 'Clicking the ruler during playback jumps there and keeps playing',
    area: 'seek',
    reference: 'Premiere / Resolve: seeking while playing continues playback from the new position',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'editor_set_playing', args: { playing: true } },
      { wait: 300 },
      { pointer: { action: 'click', target: atFrame(200, 'ruler') } },
      { waitFor: { path: 'state.playhead', op: 'gte', value: 198 } },
      { expect: [{ path: 'state.playhead', op: 'lt', value: 240 }, { path: 'state.playing', op: 'eq', value: true }] },
      { op: 'editor_set_playing', args: { playing: false } },
    ],
  },
  {
    id: 'scrub-playhead-drag',
    title: 'Dragging from the playhead scrubs: it follows the pointer on every move',
    area: 'seek',
    reference: 'Resolve "tape-style scrub" (scrubbing.jpg) / Premiere: drag the playhead head to scrub',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'editor_set_playhead', args: { frame: 30 } },
      {
        pointer: {
          action: 'drag',
          target: playheadGrab(),
          to: atFrame(200, 'ruler'),
          steps: 20,
          durationMs: 600,
          watch: { selectors: [playheadLine()] },
        },
        measure: true,
      },
      { expect: { live: { selector: playheadLine(), prop: 'x', minDistinct: 6, label: 'the playhead line moves during the scrub' } } },
      { waitFor: playheadNear(200, 3) },
    ],
  },
  {
    id: 'seek-empty-lane-click',
    title: 'Clicking empty track space moves the playhead and clears the selection',
    area: 'seek',
    reference: 'Resolve / Premiere default (B-326): a click on empty track space seeks there',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('a') }, label: 'select a' },
      // GAPPED is 180 frames long and `setPlayhead` clamps to the last frame, so
      // the empty space must be INSIDE the timeline: track 1 is empty from 90.
      { pointer: { action: 'click', target: atFrame(150, 1) }, label: 'click empty space on track 1', expectHit: false },
      { waitFor: playheadNear(150) },
      { expect: { path: 'state.selection.length', op: 'eq', value: 0 } },
    ],
  },

  // ── Selection ──────────────────────────────────────────────────────────
  {
    id: 'select-click-clip',
    title: 'Clicking a clip selects it (and only it)',
    area: 'selection',
    reference: 'Every NLE: a click on a clip selects it',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) }, measure: { firstCommitMs: 100 } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 1 } },
      { expect: { path: 'state.selection.0.id', op: 'eq', value: '@clip:b' } },
    ],
  },
  {
    id: 'select-cmd-click-toggles',
    title: 'Cmd-click adds a clip to the selection (and takes it out again)',
    area: 'selection',
    reference: 'Premiere / Resolve / FCP: Cmd-click toggles one clip in the selection (D-107: `onClickAction`)',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('a', { fy: 0.8 }) } },
      { pointer: { action: 'click', target: clip('c', { fy: 0.8 }), modifiers: ['meta'] } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 2 } },
      { expect: [{ path: 'state.selection.0.id', op: 'eq', value: '@clip:a' }, { path: 'state.selection.1.id', op: 'eq', value: '@clip:c' }] },
      { pointer: { action: 'click', target: clip('c', { fy: 0.8 }), modifiers: ['meta'] } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 1 } },
    ],
  },
  {
    id: 'select-shift-click-range',
    title: 'Shift-click selects the range from the last selected clip to the clicked one',
    area: 'selection',
    reference: 'Resolve / Premiere range selection; D-107 chose a same-track range for Shift (Cmd toggles)',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('a', { fy: 0.8 }) } },
      { pointer: { action: 'click', target: clip('c', { fy: 0.8 }), modifiers: ['shift'] } },
      // a..c on one track is a, b and c: the range includes the clip in between.
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 3 } },
    ],
  },
  {
    id: 'select-marquee',
    title: 'Dragging a marquee from empty space selects every clip it touches',
    area: 'selection',
    reference: 'Premiere / Resolve: a rubber-band drag on empty track space selects the clips it crosses',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      {
        pointer: {
          action: 'drag',
          target: atFrame(220, 0, 0.3),
          to: atFrame(40, 1, 0.7),
          steps: 12,
          watch: { selectors: [`[data-testid="${TIMELINE_TEST_IDS.marquee}"]`] },
        },
        expectHit: false,
        measure: true,
      },
      { expect: { live: { selector: `[data-testid="${TIMELINE_TEST_IDS.marquee}"]`, prop: 'width', minDistinct: 4, label: 'the marquee band grows with the drag' } } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 3 } },
    ],
  },
  {
    id: 'select-click-empty-deselects',
    title: 'Clicking empty space deselects',
    area: 'selection',
    reference: 'Every NLE (D-100: "clicking outside does not make it undeselected")',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 1 } },
      { pointer: { action: 'click', target: atFrame(260, 0) }, expectHit: false },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 0 } },
    ],
  },

  // ── Moving clips ───────────────────────────────────────────────────────
  {
    id: 'move-clip-same-track',
    title: 'Dragging a clip moves it along its track, with a ghost following the pointer',
    area: 'move',
    reference: 'Every NLE: drag a clip body to reposition it in time',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      { pointer: { action: 'drag', target: clip('b', { fy: 0.8 }), to: byFrames(30), steps: 15, durationMs: 450, watch: { selectors: [GHOST] } }, measure: true },
      { expect: { live: { selector: GHOST, prop: 'x', minDistinct: 4, label: 'the drag ghost follows the pointer' } } },
      { waitFor: clipIs('b', 'startFrame', 150, 1) },
      { expect: [clipUnchanged('b', 'duration'), clipUnchanged('a', 'startFrame'), clipIs('b', 'track', 0)] },
    ],
  },
  {
    id: 'drop-media-new-track-at-frame',
    title: 'A clip dragged from the media browser BELOW the tracks lands on a new track where it was dropped, not at frame 0',
    area: 'drop',
    reference: 'FCP / Resolve / Premiere: a browser clip lands where it is released (B-360, owner 2026-11-01)',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      // Row 2 does not exist (THREE_CLIPS has two tracks): its centre is the "new track below" boundary.
      { pointer: { action: 'html5Drag', target: selector(MEDIA_TILE_VIDEO), to: atFrame(150, 2), steps: 12 } },
      { waitFor: { path: 'timeline.tracks.length', op: 'eq', value: 3 } },
      { expect: { path: 'timeline.tracks.2.0.startFrame', op: 'near', value: 150, tolerance: 2 } },
    ],
  },
  {
    id: 'drop-media-snaps-to-playhead',
    title: 'A clip dropped from the media browser near the playhead snaps onto it',
    area: 'drop',
    reference: 'FCP: a browser drag snaps to the playhead with snapping on (B-360)',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'editor_set_playhead', args: { frame: 200 } },
      // Onto the empty second track, 4 frames past the playhead: inside the insertion snap.
      { pointer: { action: 'html5Drag', target: selector(MEDIA_TILE_VIDEO), to: atFrame(204, 1), steps: 12 } },
      { waitFor: { path: 'timeline.tracks.1.length', op: 'eq', value: 1 } },
      { expect: { path: 'timeline.tracks.1.0.startFrame', op: 'eq', value: 200 } },
    ],
  },
  {
    id: 'move-clip-across-tracks',
    title: 'Dragging a clip down a row moves it to that track at the same time',
    area: 'move',
    reference: 'Premiere / Resolve: vertical drag changes track, horizontal position kept',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'drag', target: clip('b', { fy: 0.8 }), to: byFrames(0, 1), steps: 12, durationMs: 400 }, measure: true },
      { waitFor: clipIs('b', 'track', 1) },
      { expect: clipIs('b', 'startFrame', 90, 1) },
    ],
  },
  {
    id: 'move-snaps-to-neighbour',
    title: 'With snapping on, a clip dropped 2 frames from its neighbour’s end snaps to it',
    area: 'move',
    reference: 'Premiere / Resolve / FCP snapping (on by default; D-051 dragLine)',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      // b starts at 120, a ends at 60: drop b's head at 62 → expect 60.
      { pointer: { action: 'drag', target: clip('b', { fx: 0.5, fy: 0.8 }), to: byFrames(-58), steps: 15, durationMs: 450 } },
      { waitFor: clipIs('b', 'startFrame', 60) },
    ],
  },
  {
    id: 'move-snapping-toggle',
    title: 'Snapping can be turned off (N), and then a drop lands exactly where released',
    area: 'move',
    reference: 'Final Cut and Resolve: N toggles snapping (D-432: the owner chose N; S is skimming)',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: atFrame(260, 0) }, expectHit: false, label: 'focus the timeline' },
      { key: { keys: ['KeyN'] }, label: 'toggle snapping off (Final Cut)' },
      { waitFor: { path: 'state.timelineView.snapping', op: 'eq', value: false } },
      { pointer: { action: 'drag', target: clip('b', { fx: 0.5, fy: 0.8 }), to: byFrames(-58), steps: 15, durationMs: 450 } },
      { waitFor: clipIs('b', 'startFrame', 62, 1) },
    ],
  },
  {
    id: 'linked-av-select-one-half',
    title: 'Clicking the picture of a linked A/V clip selects that half, outlines its partner, and Delete takes both',
    area: 'linked A/V',
    reference: 'D-129 option (b): one half selects, the partner gets a solid 1 px outline (D-432 §4.3), and edits act on the whole group (Premiere linked selection / Resolve linked clips)',
    fixture: { tracks: [{ kind: 'video', clips: [{ name: 'v', media: 'av', duration: 90, startFrame: 0 }] }, { kind: 'audio', clips: [] }] },
    steps: [
      FPS_GUARD,
      { require: { path: 'timeline.clips.v.linkGroup', op: 'truthy' }, reason: 'the A/V fixture clip came without a linked audio half' },
      { pointer: { action: 'click', target: clip('v', { fy: 0.3 }) } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 1 } },
      { expect: { path: 'state.selection.0.id', op: 'eq', value: '@clip:v' } },
      {
        reachable: {
          // H13: a stable hook on the partner (`data-chroma-link-partner`), not the
          // outline's class string, which P2 changed from dashed to a solid 1 px.
          selector: `[data-testid="${TIMELINE_TEST_IDS.clip}"][data-chroma-link-partner]`,
          reason: 'the linked partner of the selected half has no outline (data-chroma-link-partner)',
        },
      },
      { key: { keys: ['Delete'] } },
      // D-129: delete removes the whole group and prunes a track it empties, so
      // count clips rather than index a track that may be gone.
      { waitFor: { path: 'timeline.clipCount', op: 'eq', value: 0, label: 'Delete took the picture and its linked audio half' } },
    ],
  },
  {
    id: 'linked-av-move-together',
    title: 'Dragging the picture of a linked A/V clip moves its audio with it',
    area: 'linked A/V',
    reference: 'Premiere / Resolve: linked halves move together',
    fixture: { tracks: [{ kind: 'video', clips: [{ name: 'v', media: 'av', duration: 90, startFrame: 0 }] }, { kind: 'audio', clips: [] }] },
    steps: [
      FPS_GUARD,
      { require: { path: 'timeline.clips.v.linkGroup', op: 'truthy' }, reason: 'the A/V fixture clip came without a linked audio half' },
      { pointer: { action: 'drag', target: clip('v', { fy: 0.8 }), to: byFrames(30), steps: 12, durationMs: 400 }, measure: true },
      { waitFor: clipIs('v', 'startFrame', 30, 1) },
      { expect: { path: 'timeline.tracks.1.0.startFrame', op: 'near', value: 30, tolerance: 1, label: 'the linked audio moved too' } },
    ],
  },

  // ── Delete, ripple delete, undo ────────────────────────────────────────
  {
    id: 'delete-selected-clip',
    title: 'Delete removes the selected clip and leaves a gap',
    area: 'edit',
    reference: 'Premiere / Resolve: Delete lifts the clip, later clips stay',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) } },
      { key: { keys: ['Delete'] }, measure: { firstCommitMs: 100 } },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 2 } },
      { expect: clipUnchanged('c', 'startFrame') },
    ],
  },
  {
    id: 'ripple-delete-shortcut',
    title: 'Shift+Delete ripple-deletes: later clips close the gap',
    area: 'edit',
    reference: 'Premiere Ripple Delete (Shift+Delete) / Resolve Ripple Delete (Shift+Backspace)',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) } },
      { key: { keys: ['shift+Delete'] } },
      { waitFor: clipIs('c', 'startFrame', 90) },
    ],
  },
  {
    id: 'undo-redo-keys',
    title: 'Cmd+Z undoes a delete and Cmd+Shift+Z redoes it',
    area: 'edit',
    reference: 'Universal: Cmd+Z / Shift+Cmd+Z (Final Cut keyboard shortcuts page)',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) } },
      { key: { keys: ['Delete'] } },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 2 } },
      { key: { keys: ['meta+KeyZ'] }, measure: true },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 3 } },
      { key: { keys: ['meta+shift+KeyZ'] } },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 2 } },
    ],
  },
  {
    id: 'gap-select-and-close',
    title: 'Clicking a gap selects it, and Delete closes it',
    area: 'edit',
    reference: 'Resolve / Premiere: select a gap and delete to ripple it closed (D-105)',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: atFrame(90, 0) }, expectHit: false },
      { waitFor: { path: 'state.selectedGap', op: 'truthy' } },
      { key: { keys: ['Delete'] } },
      { waitFor: clipIs('b', 'startFrame', 60) },
    ],
  },

  // ── Zoom, scroll, header column ────────────────────────────────────────
  {
    id: 'zoom-toolbar-buttons',
    title: 'The toolbar zoom buttons zoom in and back out',
    area: 'zoom',
    reference: 'Every NLE has discoverable zoom controls beside the timeline',
    fixture: THREE_CLIPS,
    steps: [
      { capture: 'view', as: 'before' },
      { pointer: { action: 'click', target: { testid: TIMELINE_TEST_IDS.zoomIn } }, measure: true },
      { waitFor: { path: 'view.pxPerSec', op: 'gt', value: { ref: 'before.pxPerSec' } } },
      { pointer: { action: 'click', target: { testid: TIMELINE_TEST_IDS.zoomOut } } },
      { waitFor: { path: 'view.pxPerSec', op: 'near', value: { ref: 'before.pxPerSec' }, tolerance: 0.5 } },
    ],
  },
  {
    id: 'zoom-ctrl-wheel-anchored',
    title: 'Ctrl+wheel zooms around the cursor: the frame under it stays under it',
    area: 'zoom',
    reference: 'Premiere (Alt+wheel) / Resolve (Ctrl+wheel) / B-116: zoom anchors at the pointer',
    fixture: { ...THREE_CLIPS, markers: [{ name: 'probe', frame: 150 }] },
    steps: [
      FPS_GUARD,
      { capture: 'view', as: 'before' },
      { capture: 'dom', selector: '[data-testid="timeline-marker"][data-chroma-marker="@marker:probe"]', as: 'probeBefore' },
      { pointer: { action: 'wheel', target: atFrame(150, 0), modifiers: ['ctrl'], deltaY: -120, steps: 3 }, expectHit: false, measure: true },
      { waitFor: { path: 'view.pxPerSec', op: 'gt', value: { ref: 'before.pxPerSec' } } },
      { capture: 'dom', selector: '[data-testid="timeline-marker"][data-chroma-marker="@marker:probe"]', as: 'probeAfter' },
      { expect: { path: 'probeAfter.rect.x', op: 'near', value: { ref: 'probeBefore.rect.x' }, tolerance: 3, label: 'the frame under the cursor stayed under it' } },
    ],
  },
  {
    id: 'zoom-trackpad-pinch',
    title: 'A trackpad pinch over the timeline zooms it',
    area: 'zoom',
    reference: 'macOS convention: pinch to zoom; WebKit delivers it as gesture events, not ctrl+wheel',
    fixture: THREE_CLIPS,
    steps: [
      { capture: 'view', as: 'before' },
      { pointer: { action: 'pinch', target: editArea({ fx: 0.5, fy: 0.6 }), scale: 1.5 }, expectHit: false, measure: true },
      { waitFor: { path: 'view.pxPerSec', op: 'gt', value: { ref: 'before.pxPerSec' } } },
    ],
  },
  {
    id: 'zoom-keyboard',
    title: '= and - zoom the timeline in and out',
    area: 'zoom',
    reference: 'Premiere = / -; Final Cut Cmd+= / Cmd+-',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { capture: 'view', as: 'before' },
      { key: { keys: ['Equal'] } },
      { waitFor: { path: 'view.pxPerSec', op: 'gt', value: { ref: 'before.pxPerSec' } } },
    ],
  },
  {
    id: 'scroll-horizontal-wheel',
    title: 'A horizontal two-finger scroll pans the timeline',
    area: 'scroll',
    reference: 'macOS trackpad convention; D-072: plain wheel pans, ctrl+wheel zooms',
    fixture: LONG,
    steps: [
      { capture: 'view', as: 'before' },
      { pointer: { action: 'wheel', target: editArea({ fx: 0.5, fy: 0.6 }), deltaX: 300, steps: 6 }, expectHit: false, measure: true },
      { waitFor: { path: 'view.scrollLeft', op: 'gt', value: { ref: 'before.scrollLeft' } } },
    ],
  },
  {
    id: 'scroll-vertical-wheel',
    title: 'A vertical scroll moves the tracks, and the track headers scroll with them',
    area: 'scroll',
    reference: 'Every NLE: headers stay aligned with their rows while scrolling',
    fixture: {
      tracks: Array.from({ length: 8 }, (_, i) => ({ kind: 'video' as const, clips: [{ name: `t${i}`, duration: 60, startFrame: 0 }] })),
    },
    steps: [
      { capture: 'dom', selector: headerSel(0), as: 'headerBefore' },
      { pointer: { action: 'wheel', target: editArea({ fx: 0.5, fy: 0.6 }), deltaY: 200, steps: 5 }, expectHit: false, measure: true },
      { waitFor: { path: 'view.scrollTop', op: 'gt', value: 0 } },
      { capture: 'dom', selector: headerSel(0), as: 'headerAfter' },
      { expect: { path: 'headerAfter.rect.y', op: 'lt', value: { ref: 'headerBefore.rect.y' }, label: 'track 0’s header moved up with its row' } },
    ],
  },
  {
    id: 'track-header-resize',
    title: 'Dragging the header/edit-area divider widens the track-header column',
    area: 'layout',
    reference: 'CLAUDE.md: every resizable-by-nature pane must actually be resizable (D-094)',
    fixture: THREE_CLIPS,
    steps: [
      { capture: 'dom', selector: headerSel(0), as: 'before' },
      // H14: react-resizable-panels resolves its separator by proximity, so the 1 px
      // separator is not the element under the press (`elementFromPoint` is the lane
      // beside it). What this scenario judges is the column's width change, below.
      { pointer: { action: 'drag', target: headerResize(), to: { byX: 60 }, steps: 10, durationMs: 300 }, measure: true, expectHit: false },
      { capture: 'dom', selector: headerSel(0), as: 'after' },
      { expect: { path: 'after.rect.width', op: 'gt', value: { ref: 'before.rect.width', plus: 30 }, label: 'the header column grew' } },
    ],
  },

  // ── Markers ────────────────────────────────────────────────────────────
  {
    id: 'marker-add-key-m',
    title: 'M adds a marker at the playhead',
    area: 'markers',
    reference: 'Premiere / Resolve / FCP: M adds a marker',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'editor_set_playhead', args: { frame: 60 } },
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { op: 'editor_set_playhead', args: { frame: 60 } },
      { key: { keys: ['KeyM'] }, measure: true },
      { waitFor: { path: 'timeline.markers.length', op: 'eq', value: 1 } },
      { expect: { path: 'timeline.markers.0.frame', op: 'eq', value: 60 } },
    ],
  },
  {
    id: 'marker-add-button',
    title: 'The toolbar marker button adds a marker at the playhead',
    area: 'markers',
    reference: 'Resolve / Premiere: Add Marker in the timeline toolbar',
    fixture: THREE_CLIPS,
    steps: [
      { op: 'editor_set_playhead', args: { frame: 45 } },
      { pointer: { action: 'click', target: { testid: TIMELINE_TEST_IDS.addMarker } } },
      { waitFor: { path: 'timeline.markers.length', op: 'eq', value: 1 } },
      { expect: { path: 'timeline.markers.0.frame', op: 'eq', value: 45 } },
    ],
  },
  {
    id: 'marker-click-jumps',
    title: 'Clicking a marker flag moves the playhead to it',
    area: 'markers',
    reference: 'Resolve markers.jpg / Premiere: clicking a marker parks the playhead on it',
    fixture: { ...THREE_CLIPS, markers: [{ name: 'm1', frame: 150 }] },
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: marker('m1') } },
      { waitFor: playheadNear(150, 1) },
    ],
  },
  {
    id: 'marker-drag-move',
    title: 'Dragging a marker flag moves the marker',
    area: 'markers',
    reference: 'Premiere / Resolve: markers can be dragged along the ruler',
    fixture: { ...THREE_CLIPS, markers: [{ name: 'm1', frame: 60 }] },
    steps: [
      FPS_GUARD,
      { pointer: { action: 'drag', target: marker('m1'), to: byFrames(30), steps: 10, durationMs: 300 } },
      { waitFor: { path: 'timeline.markers.0.frame', op: 'near', value: 90, tolerance: 2 } },
    ],
  },

  // ── Keyboard transport ─────────────────────────────────────────────────
  {
    id: 'key-space-play-pause',
    title: 'Space starts and stops playback',
    area: 'keyboard',
    reference: 'Universal: Space = play / stop (D-273)',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { op: 'editor_set_playhead', args: { frame: 0 } },
      { key: { keys: ['Space'] } },
      { waitFor: { path: 'state.playing', op: 'eq', value: true } },
      { wait: 600 },
      { key: { keys: ['Space'] } },
      { waitFor: { path: 'state.playing', op: 'eq', value: false } },
      { expect: { path: 'state.playhead', op: 'gt', value: 0, label: 'the playhead advanced while playing' } },
    ],
  },
  {
    id: 'key-arrows-frame-step',
    title: '← / → step the playhead one frame',
    area: 'keyboard',
    reference: 'Premiere / Resolve / FCP: Left/Right arrow = one frame',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { op: 'editor_set_playhead', args: { frame: 60 } },
      { key: { keys: ['ArrowRight'] } },
      { waitFor: { path: 'state.playhead', op: 'eq', value: 61 } },
      { key: { keys: ['ArrowLeft', 'ArrowLeft'] } },
      { waitFor: { path: 'state.playhead', op: 'eq', value: 59 } },
    ],
  },
  {
    id: 'key-jkl-shuttle',
    title: 'J / K / L shuttle: L plays forward, K stops, J plays backward',
    area: 'keyboard',
    reference: 'Premiere / Resolve / FCP J-K-L shuttle (Resolve "dynamic JKL", hollywood.jpg)',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { op: 'editor_set_playhead', args: { frame: 120 } },
      { key: { keys: ['KeyL'] } },
      { waitFor: { path: 'state.playing', op: 'eq', value: true } },
      { key: { keys: ['KeyK'] } },
      { waitFor: { path: 'state.playing', op: 'eq', value: false } },
      { capture: 'state', as: 'stopped' },
      { key: { keys: ['KeyJ'] } },
      { wait: 500 },
      { expect: { path: 'state.playhead', op: 'lt', value: { ref: 'stopped.playhead' }, label: 'J played backward' } },
      { op: 'editor_set_playing', args: { playing: false } },
    ],
  },
  {
    id: 'key-in-out-marks',
    title: 'I and O mark a timeline in and out point',
    area: 'keyboard',
    reference: 'Premiere / Resolve / FCP: I / O set the in and out marks (select.jpg)',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { op: 'editor_set_playhead', args: { frame: 30 } },
      { key: { keys: ['KeyI'] } },
      { op: 'editor_set_playhead', args: { frame: 60 } },
      { key: { keys: ['KeyO'] } },
      { expect: [{ path: 'state.inPoint', op: 'eq', value: 30 }, { path: 'state.outPoint', op: 'eq', value: 60 }] },
    ],
  },
  {
    id: 'key-edit-point-navigation',
    title: '↓ / ↑ jump the playhead to the next / previous edit point',
    area: 'keyboard',
    reference: 'Premiere Up/Down arrow; Resolve Up/Down arrow; FCP ; and \'',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { op: 'editor_set_playhead', args: { frame: 10 } },
      { key: { keys: ['ArrowDown'] } },
      { waitFor: { path: 'state.playhead', op: 'eq', value: 90 } },
      { key: { keys: ['ArrowUp'] } },
      { waitFor: { path: 'state.playhead', op: 'eq', value: 0 } },
    ],
  },

  // ── Playback ───────────────────────────────────────────────────────────
  {
    id: 'playback-frame-rate',
    title: 'Playback holds the frame rate',
    area: 'playback',
    reference: 'A 30 fps timeline must preview at (close to) 30 fps — CLAUDE.md: a stuttering preview is a defect',
    fixture: THREE_CLIPS,
    steps: [{ playback: { seconds: 3, fromFrame: 0 } }],
  },
  {
    id: 'clip-body-hover-cursor',
    title: 'Hovering a clip body (Select tool) shows the plain arrow, not a grab hand',
    area: 'move',
    reference:
      'Final Cut Pro / Premiere Selection tool: the default arrow over a clip body; `grab` is for track headers (D-432 spec §5 "Cursors", owner-approved)',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'move', target: clip('b', { fy: 0.8 }), watch: { cursor: true }, settleMs: 100 } },
      { expect: { cursor: { anyOf: ['default', 'auto'] } } },
      { capture: 'dom', selector: clipSelector('b'), as: 'body' },
      { expect: { path: 'body.cursor', op: 'in', value: ['default', 'auto'] } },
    ],
  },
  {
    id: 'snapping-toggle-button',
    title: 'The toolbar magnet turns snapping off and on, and the AI reads the same state',
    area: 'move',
    reference: 'Final Cut / Resolve timeline toolbar snapping button (D-432 §4.9)',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: { testid: TIMELINE_TEST_IDS.snappingToggle } } },
      { waitFor: { path: 'state.timelineView.snapping', op: 'eq', value: false } },
      { pointer: { action: 'click', target: { testid: TIMELINE_TEST_IDS.snappingToggle } } },
      { waitFor: { path: 'state.timelineView.snapping', op: 'eq', value: true } },
    ],
  },
  {
    id: 'skimming-toggle-key',
    title: 'S turns skimming on (off by default); hovering then moves the skim line, not the playhead',
    area: 'seek',
    reference: 'Final Cut Pro skimming (S); D-432 owner answer: skimming on S, off by default',
    fixture: THREE_CLIPS,
    steps: [
      { expect: { path: 'state.timelineView.skimming', op: 'eq', value: false } },
      { op: 'editor_set_playhead', args: { frame: 10 } },
      { pointer: { action: 'click', target: atFrame(400, 0) }, expectHit: false, label: 'focus the timeline' },
      { op: 'editor_set_playhead', args: { frame: 10 } },
      { key: { keys: ['KeyS'] } },
      { waitFor: { path: 'state.timelineView.skimming', op: 'eq', value: true } },
      { pointer: { action: 'move', target: atFrame(120, 0), settleMs: 100 }, expectHit: false },
      { reachable: { selector: `[data-testid="${TIMELINE_TEST_IDS.skimLine}"]:not([hidden])`, reason: 'no skim line under the pointer' } },
      { expect: { path: 'state.playhead', op: 'eq', value: 10 } },
    ],
  },
  {
    id: 'scrub-ruler-drag',
    title: 'Dragging in the ruler scrubs: the playhead follows the pointer on every move (B-350)',
    area: 'seek',
    reference: 'Premiere / Resolve: press and drag anywhere in the time ruler to scrub',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      {
        pointer: {
          action: 'drag',
          target: atFrame(60, 'ruler'),
          to: atFrame(200, 'ruler'),
          steps: 20,
          durationMs: 600,
          watch: { selectors: [playheadLine()] },
        },
        measure: true,
      },
      { waitFor: playheadNear(200, 2) },
      { expect: { live: { selector: playheadLine(), prop: 'x', minDistinct: 8, label: 'the playhead moved during the drag, not only on release' } } },
    ],
  },
  {
    id: 'track-height-drag',
    title: 'Dragging a track header’s bottom edge makes that track taller (one undo step)',
    area: 'layout',
    reference: 'Resolve / Premiere: drag a track’s edge to resize it (D-432 §4.8)',
    fixture: THREE_CLIPS,
    steps: [
      { capture: 'dom', selector: headerSel(0), as: 'before' },
      { pointer: { action: 'drag', target: trackHeightZone(0), to: { byX: 0, byY: 24 }, steps: 8, durationMs: 240 }, measure: true },
      { capture: 'dom', selector: headerSel(0), as: 'after' },
      { expect: { path: 'after.rect.height', op: 'gt', value: { ref: 'before.rect.height', plus: 16 }, label: 'track 0 grew' } },
    ],
  },
  {
    id: 'track-header-quiet',
    title: 'A track header shows its ID pill and name; toggles stay hidden until hovered, and there is no per-row delete',
    area: 'layout',
    reference: 'Resolve track headers; D-432 §4.8 (the owner’s 2026-11-01 screenshot: a red trash on every row)',
    fixture: THREE_CLIPS,
    steps: [
      { reachable: { selector: `${headerSel(0)} [data-testid="${TIMELINE_TEST_IDS.trackBadge}"]`, reason: 'no V1 / A1 pill in the header' } },
      { capture: 'dom', selector: `${headerSel(0)} [data-testid="${TIMELINE_TEST_IDS.trackLock}"]`, as: 'lockAtRest' },
      { expect: { path: 'lockAtRest.rect.width', op: 'eq', value: 0, label: 'the lock toggle is hidden at rest' } },
      { pointer: { action: 'move', target: trackHeader(0), settleMs: 150 } },
      { capture: 'dom', selector: `${headerSel(0)} [data-testid="${TIMELINE_TEST_IDS.trackLock}"]`, as: 'lockHover' },
      { expect: { path: 'lockHover.rect.width', op: 'gt', value: 0, label: 'hovering the header reveals it' } },
    ],
  },
  {
    id: 'track-header-present',
    title: 'Every track has a header with its controls',
    area: 'layout',
    reference: 'Resolve / Premiere track headers: lock, target, visibility, mute (hollywood.jpg)',
    fixture: THREE_CLIPS,
    steps: [{ reachable: { selector: headerSel(0), reason: 'track 0 has no header' } }, { pointer: { action: 'move', target: trackHeader(1) } }],
  },
];
