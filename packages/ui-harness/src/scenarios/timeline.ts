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
  playheadHandle,
  TIMELINE_LIBRARY_SELECTORS,
  TIMELINE_TEST_IDS,
  trackHeader,
} from '../targets.ts';
import { clipIs, clipUnchanged, FPS_GUARD, GAPPED, GHOST, LONG, playheadNear, THREE_CLIPS } from './common.ts';

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
    title: 'Dragging the playhead scrubs: it follows the pointer on every move',
    area: 'seek',
    reference: 'Resolve "tape-style scrub" (scrubbing.jpg) / Premiere: drag the playhead head to scrub',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { op: 'editor_set_playhead', args: { frame: 30 } },
      {
        pointer: {
          action: 'drag',
          target: playheadHandle(),
          to: atFrame(200, 'ruler'),
          steps: 20,
          durationMs: 600,
          watch: { selectors: [TIMELINE_LIBRARY_SELECTORS.playhead] },
        },
        measure: true,
      },
      { expect: { live: { selector: TIMELINE_LIBRARY_SELECTORS.playhead, prop: 'x', minDistinct: 6, label: 'the playhead line moves during the scrub' } } },
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
      { pointer: { action: 'click', target: atFrame(200, 1) }, label: 'click empty space on track 1', expectHit: false },
      { waitFor: playheadNear(200) },
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
    id: 'select-shift-multi',
    title: 'Shift-click adds a clip to the selection',
    area: 'selection',
    reference: 'Premiere / Resolve: Shift(-click) extends the selection',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('a', { fy: 0.8 }) } },
      { pointer: { action: 'click', target: clip('c', { fy: 0.8 }), modifiers: ['shift'] } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 2 } },
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
    title: 'Snapping can be turned off (S / N), and then a drop lands exactly where released',
    area: 'move',
    reference: 'Premiere: S toggles snapping; Final Cut and Resolve: N',
    fixture: GAPPED,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: atFrame(260, 0) }, expectHit: false, label: 'focus the timeline' },
      { key: { keys: ['KeyS'] }, label: 'toggle snapping off (Premiere)' },
      { pointer: { action: 'drag', target: clip('b', { fx: 0.5, fy: 0.8 }), to: byFrames(-58), steps: 15, durationMs: 450 } },
      { waitFor: clipIs('b', 'startFrame', 62, 1) },
    ],
  },
  {
    id: 'linked-av-select-together',
    title: 'Clicking the picture of a linked A/V clip selects its audio too',
    area: 'linked A/V',
    reference: 'Premiere linked selection / Resolve linked clips: both halves select together',
    fixture: { tracks: [{ kind: 'video', clips: [{ name: 'v', media: 'av', duration: 90, startFrame: 0 }] }, { kind: 'audio', clips: [] }] },
    steps: [
      FPS_GUARD,
      { require: { path: 'timeline.clips.v.linkGroup', op: 'truthy' }, reason: 'the A/V fixture clip came without a linked audio half' },
      { pointer: { action: 'click', target: clip('v', { fy: 0.3 }) } },
      { waitFor: { path: 'state.selection.length', op: 'eq', value: 2 } },
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
      { pointer: { action: 'drag', target: headerResize(), to: { byX: 60 }, steps: 10, durationMs: 300 }, measure: true },
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
    title: 'Hovering a clip body shows a grab cursor',
    area: 'move',
    reference: 'Resolve / Premiere: the pointer over a movable clip signals it can be dragged',
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'move', target: clip('b', { fy: 0.8 }), watch: { cursor: true }, settleMs: 100 } },
      { expect: { cursor: { anyOf: ['grab', 'move', 'pointer'] } } },
      { capture: 'dom', selector: clipSelector('b'), as: 'body' },
      { expect: { path: 'body.cursor', op: 'in', value: ['grab', 'move'] } },
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
