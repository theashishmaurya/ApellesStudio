// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for what happens when something is
 * DROPPED on the timeline: the library rail's generator drag (D-248 / B-117)
 * and the "create a new track above the top one" insertion boundary (B-115).
 *
 * **Why this file exists.** Both defects were reported live by the owner
 * against the running app and both are pure wiring, not arithmetic — the kind
 * a pure-op test cannot see:
 *
 *   - **B-117** — dragging a Title onto the timeline did nothing, because
 *     nothing in the app was a drag source for one and `onDrop` had never
 *     heard of a generator payload. The op it must produce (`add_clip` with a
 *     text clip) was already correct and already tested; what was missing was
 *     that a `drop` carrying `CHROMA_GENERATOR_DRAG_MIME` reaches it at all.
 *   - **B-115** — dragging above the topmost track resolved to no insertion
 *     boundary, so a native drop silently landed on the EXISTING top track
 *     instead of making a new one. The op sequence for a boundary drop
 *     (`add_track` + `move_track` + `add_clip`) was right; the y→boundary
 *     resolution was not.
 *
 * **Tier and its honest limits.** jsdom, with the edit area's own rect stubbed
 * (see `stubEditAreaRect`) — the same disclosure every `TimelinePane.*.dom`
 * suite in this package makes. It proves the handlers, the payload contract
 * and the ops that come out of them. It does NOT prove that a real
 * WKWebView delivers a `dragstart` from the rail (native HTML5 drag has real
 * platform behaviour jsdom has none of) or that the drop lands on the right
 * element by paint order — those are owner/live checks, so every gesture here
 * targets the handler's own element directly and the geometry it depends on is
 * asserted as a value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installResizeObserverStub,
  installPointerCaptureStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
}));

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { EditLibraryRail } from './EditLibraryRail';
import { useHistoryStore } from '@chroma/history';
import {
  CHROMA_GENERATOR_DRAG_MIME,
  CHROMA_MEDIA_DRAG_MIME,
  applyOp as applyOpPure,
  checkAddClip,
  clipFromDraggedGenerator,
  isTextClip,
  type DraggedMedia,
  type Timeline,
} from './timeline';

const FPS = 24;
/** `TimelinePane.tsx`'s own layout constants, restated here for the same
 *  reason `TimelinePane.markers.dom.test.tsx` restates `PX_PER_SEC`: the test
 *  has to be able to say where it is dropping, in the pane's own coordinates,
 *  without importing private module state. */
const ROW_HEIGHT = 52;
const RULER_AND_MARGIN_PX = 32 + 16; // RULER_HEIGHT_PX + MARKER_STRIP_HEIGHT

const AREA = { left: 0, top: 0, width: 1200, height: 600 };

function fixture(): Timeline {
  return {
    id: 'drop-fixture-tl',
    name: 'drop fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 96, source_len: 480, start_frame: 0 },
        ],
      },
      {
        kind: 'audio',
        clips: [
          { id: 'a', name: 'A', source_path: '/a.wav', source_start: 0, duration: 96, source_len: 480, start_frame: 0 },
        ],
      },
    ],
  };
}

const MEDIA: DraggedMedia = {
  id: 'm1',
  sourcePath: '/media/new.mov',
  name: 'new.mov',
  frameCount: 48,
  hasAudio: false,
  fps: FPS,
};

/** The pane's own edit area. jsdom lays nothing out, so the one rect every
 *  drop coordinate is measured against has to be supplied — everything else in
 *  this file is then real. `data-bench-id` is the pane's own stable hook, not
 *  a class string that moves when the styling does. */
function stubEditAreaRect(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-bench-id="timeline-edit-area"]');
  if (!el) throw new Error('the timeline edit area is not mounted');
  el.getBoundingClientRect = () =>
    ({
      ...AREA,
      x: AREA.left,
      y: AREA.top,
      right: AREA.left + AREA.width,
      bottom: AREA.top + AREA.height,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

/** `clientY` for a point `y` px into the TRACK ROWS (y=0 is the top of track
 *  0), matching `onDrop`'s own `clientY - rect.top - RULER_AND_MARGIN_PX`. */
const rowY = (y: number) => AREA.top + RULER_AND_MARGIN_PX + y;

/** `clientY` inside the ruler / marker strip — i.e. genuinely ABOVE every
 *  track row, which is the gesture B-115 is about. */
const aboveTracksY = () => AREA.top + 4;

function dragEvent(
  type: string,
  opts: { clientX?: number; clientY?: number; mime?: string; payload?: string | null } = {},
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const mime = opts.mime ?? CHROMA_MEDIA_DRAG_MIME;
  Object.defineProperty(e, 'clientX', { value: opts.clientX ?? 400 });
  Object.defineProperty(e, 'clientY', { value: opts.clientY ?? rowY(ROW_HEIGHT / 2) });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types: [mime],
      dropEffect: 'none',
      effectAllowed: 'none',
      // Per the HTML5 spec the payload is only readable in `drop`; passing no
      // `payload` models the `dragover` phase exactly.
      getData: (m: string) => (m === mime ? (opts.payload ?? '') : ''),
      setData: () => {},
    },
  });
  return e;
}

function layout(): Array<{ kind: string; clips: string[] }> {
  const tl = useEditorTimelineStore.getState().timeline;
  return (tl?.tracks ?? []).map((t) => ({ kind: t.kind, clips: t.clips.map((c) => c.id) }));
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountPane(): Promise<HTMLElement> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/drop-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  ui = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
  return stubEditAreaRect();
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(AREA.width, AREA.height);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  ui?.unmount();
  ui = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

describe('B-115 — dragging ABOVE the top track creates a new track there', () => {
  it('1. a media drop above the tracks inserts a NEW video track at index 0 and puts the clip on it', async () => {
    const area = await mountPane();
    expect(layout()).toEqual([
      { kind: 'video', clips: ['v'] },
      { kind: 'audio', clips: ['a'] },
    ]);

    actSync(() => {
      area.dispatchEvent(
        dragEvent('drop', { clientY: aboveTracksY(), payload: JSON.stringify(MEDIA) }),
      );
    });
    await waitFrames(2);

    // A brand-new topmost track — index 0 is the top of the compositing stack
    // (D-086) — holding the dropped clip, with the two original tracks pushed
    // down intact. Before B-115 this landed on the existing 'v' track.
    const after = layout();
    expect(after).toHaveLength(3);
    expect(after[0].kind).toBe('video');
    expect(after[0].clips).toHaveLength(1);
    expect(after[0].clips[0]).not.toBe('v');
    expect(after.slice(1)).toEqual([
      { kind: 'video', clips: ['v'] },
      { kind: 'audio', clips: ['a'] },
    ]);
  });

  it('2. the live drag preview points at that same boundary, so the drop is never a surprise', async () => {
    const area = await mountPane();

    actSync(() => {
      area.dispatchEvent(dragEvent('dragover', { clientY: aboveTracksY() }));
    });
    await waitFrames(2);

    // The pane draws a ghost row for a `new_track` insertion preview. Its
    // presence at all is the assertion: before B-115, `dragover` above the
    // tracks cleared the preview and showed nothing, while a drop there still
    // did something — the exact "a real drop could land on a track the user
    // was never shown a preview for" hazard `dropTargetTrack`'s own comment
    // names.
    expect(document.querySelector('[data-chroma-new-track-preview]')).not.toBeNull();
  });

  it('3. a drop in the MIDDLE of an existing track still lands on it, not on a new one', async () => {
    const area = await mountPane();

    actSync(() => {
      area.dispatchEvent(
        dragEvent('drop', { clientY: rowY(ROW_HEIGHT / 2), payload: JSON.stringify(MEDIA) }),
      );
    });
    await waitFrames(2);

    // Still two tracks — the mid-row band is not an insertion boundary, and
    // B-115 must not have widened it into one.
    const after = layout();
    expect(after).toHaveLength(2);
    expect(after[0].clips).toHaveLength(2);
  });
});

describe('B-117 / D-248 — a Title is a real drag source and a real drop', () => {
  it('4. the library rail exposes a draggable Title that carries the generator payload', async () => {
    actSync(() =>
      useEditorTimelineStore.setState({
        timeline: fixture(),
        openProjectKey: '/projects/drop-fixture.chroma',
        status: 'ready',
        playhead: 0,
        selection: [],
      }),
    );
    ui = mount(React.createElement(EditLibraryRail), { strictMode: true });
    await waitFrames(2);

    // The rail's Titles button opens the library popover.
    const trigger = document.querySelector<HTMLElement>('[aria-label="Titles"]');
    expect(trigger, 'the rail has a Titles entry').not.toBeNull();
    actSync(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await waitFrames(2);

    const entry = document.querySelector<HTMLElement>('[data-chroma-library-entry="title"]');
    expect(entry, 'the Titles library holds a Title entry').not.toBeNull();
    // The whole of B-117: it is actually draggable. It was not, anywhere.
    expect(entry!.getAttribute('draggable')).toBe('true');

    // …and its `dragstart` writes the payload `TimelinePane`'s drop reads.
    let written: Record<string, string> = {};
    const e = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', {
      value: {
        effectAllowed: 'none',
        setData: (mime: string, value: string) => {
          written[mime] = value;
        },
      },
    });
    actSync(() => entry!.dispatchEvent(e));
    expect(JSON.parse(written[CHROMA_GENERATOR_DRAG_MIME])).toEqual({ kind: 'title' });
  });

  it('5. dropping that payload on a video track adds a real TEXT clip there and selects it', async () => {
    const area = await mountPane();

    actSync(() => {
      area.dispatchEvent(
        dragEvent('drop', {
          clientY: rowY(ROW_HEIGHT / 2),
          mime: CHROMA_GENERATOR_DRAG_MIME,
          payload: JSON.stringify({ kind: 'title' }),
        }),
      );
    });
    await waitFrames(2);

    const track0 = useEditorTimelineStore.getState().timeline!.tracks[0];
    expect(track0.clips).toHaveLength(2);
    const title = track0.clips.find((c) => c.id !== 'v')!;
    expect(isTextClip(title), 'the dropped clip is a real text clip, not a media one').toBe(true);
    expect(title.text?.content).toBe('Title');
    // 3s default at 24fps — the same `DEFAULT_TITLE_SECONDS` the click-to-add
    // path and `editor_add_text_clip` use, because all three go through
    // `clipFromDraggedGenerator`.
    expect(title.duration).toBe(72);
    // Selected, so the Inspector's Title section opens on it ready to type in.
    expect(useEditorTimelineStore.getState().selection).toEqual([{ track: 0, id: title.id }]);
  });

  it('6. dropping a Title ABOVE the top track makes it a new VIDEO track — never an audio one', async () => {
    const area = await mountPane();

    actSync(() => {
      area.dispatchEvent(
        dragEvent('drop', {
          clientY: aboveTracksY(),
          mime: CHROMA_GENERATOR_DRAG_MIME,
          payload: JSON.stringify({ kind: 'title' }),
        }),
      );
    });
    await waitFrames(2);

    const after = useEditorTimelineStore.getState().timeline!.tracks;
    expect(after).toHaveLength(3);
    expect(after[0].kind).toBe('video');
    expect(isTextClip(after[0].clips[0])).toBe(true);
  });

  it('7. dropping a Title on an AUDIO track is refused, in words, instead of placing an invisible clip', async () => {
    const area = await mountPane();

    actSync(() => {
      area.dispatchEvent(
        dragEvent('drop', {
          // Row 1 is the audio track.
          clientY: rowY(ROW_HEIGHT + ROW_HEIGHT / 2),
          mime: CHROMA_GENERATOR_DRAG_MIME,
          payload: JSON.stringify({ kind: 'title' }),
        }),
      );
    });
    await waitFrames(2);

    expect(layout()).toEqual([
      { kind: 'video', clips: ['v'] },
      { kind: 'audio', clips: ['a'] },
    ]);
    const note = document.body.textContent ?? '';
    expect(note).toContain('drop it on a video track');
  });

  it('8. an adjustment clip drags and drops by the same path', async () => {
    const area = await mountPane();

    actSync(() => {
      area.dispatchEvent(
        dragEvent('drop', {
          clientY: rowY(ROW_HEIGHT / 2),
          mime: CHROMA_GENERATOR_DRAG_MIME,
          payload: JSON.stringify({ kind: 'adjustment' }),
        }),
      );
    });
    await waitFrames(2);

    const track0 = useEditorTimelineStore.getState().timeline!.tracks[0];
    const added = track0.clips.find((c) => c.id !== 'v')!;
    expect(added.adjustment, 'the dropped clip carries a real adjustment layer').toBeTruthy();
    expect(added.text, 'and is not a title').toBeUndefined();
  });

  it('9. a malformed generator payload is ignored rather than throwing or half-placing', async () => {
    const area = await mountPane();

    actSync(() => {
      area.dispatchEvent(
        dragEvent('drop', {
          clientY: rowY(ROW_HEIGHT / 2),
          mime: CHROMA_GENERATOR_DRAG_MIME,
          payload: '{not json',
        }),
      );
      area.dispatchEvent(
        dragEvent('drop', {
          clientY: rowY(ROW_HEIGHT / 2),
          mime: CHROMA_GENERATOR_DRAG_MIME,
          payload: JSON.stringify({ kind: 'nonsense' }),
        }),
      );
    });
    await waitFrames(2);

    expect(layout()).toEqual([
      { kind: 'video', clips: ['v'] },
      { kind: 'audio', clips: ['a'] },
    ]);
  });
});

/**
 * B-129 — "Add Title" put the title on whatever track was already there.
 *
 * Reported live by the owner with a screenshot, and confirmed against their
 * real project before this suite was written: a title sitting on video track 0
 * wedged between two shots, and a second one sitting on an AUDIO track, where
 * it composites into nothing at all.
 *
 * Two distinct defects, one per test below. The DROP path (tests 5-9 above)
 * was always right; these cover the two ways in that were not.
 */
describe('B-129 — adding a Title targets a NEW video track, never an occupied or audio one', () => {
  /** Open the rail's Titles popover and press its click-to-add button — the
   *  exact gesture the owner used. */
  async function addTitleAtPlayhead(playhead = 0): Promise<void> {
    actSync(() =>
      useEditorTimelineStore.setState({
        timeline: fixture(),
        openProjectKey: '/projects/drop-fixture.chroma',
        status: 'ready',
        playhead,
        selection: [],
        selectedGap: null,
      }),
    );
    ui = mount(React.createElement(EditLibraryRail), { strictMode: true });
    await waitFrames(2);
    const trigger = document.querySelector<HTMLElement>('[aria-label="Titles"]');
    actSync(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await waitFrames(2);
    const add = document.querySelector<HTMLElement>('[aria-label="Add title at the playhead"]');
    expect(add, 'the Titles library has a click-to-add button').not.toBeNull();
    actSync(() => add!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await waitFrames(2);
  }

  it('10. click-to-add makes a NEW video track above the picture instead of sharing track 0', async () => {
    await addTitleAtPlayhead(0);

    const tracks = useEditorTimelineStore.getState().timeline!.tracks;
    // A third track, at index 0 — the top of the compositing stack (D-086).
    expect(tracks).toHaveLength(3);
    expect(tracks[0].kind).toBe('video');
    expect(tracks[0].clips).toHaveLength(1);
    expect(isTextClip(tracks[0].clips[0])).toBe(true);
    // The existing edit is untouched and simply renumbered — nothing was
    // moved, overwritten or rippled to make room for an overlay.
    expect(layout().slice(1)).toEqual([
      { kind: 'video', clips: ['v'] },
      { kind: 'audio', clips: ['a'] },
    ]);
    // Selected on the track it really landed on, so the Inspector's Title
    // section opens on it.
    expect(useEditorTimelineStore.getState().selection).toEqual([
      { track: 0, id: tracks[0].clips[0].id },
    ]);
  });

  it('11. …even when the playhead sits over an existing clip, which used to be a silent refusal', async () => {
    // Frame 48 is the middle of the 96-frame clip `v` on track 0. The old
    // behaviour targeted track 0, found the space occupied, placed nothing and
    // showed an error; the whole point of a new track is that there is always
    // room on it.
    await addTitleAtPlayhead(48);

    const tracks = useEditorTimelineStore.getState().timeline!.tracks;
    expect(tracks).toHaveLength(3);
    expect(tracks[0].clips[0].start_frame).toBe(48);
    expect(document.querySelector('[data-chroma-rail-error]'), 'no refusal').toBeNull();
  });

  it('12. creating the track and placing the clip is ONE history entry, so one Undo covers both', async () => {
    actSync(() => useHistoryStore.getState().clear());
    await addTitleAtPlayhead(0);
    expect(useEditorTimelineStore.getState().timeline!.tracks).toHaveLength(3);

    // The store pushes one entry per applied op (D-051), so the entry count IS
    // the Undo count. Three chained ops (`add_track` + `move_track` +
    // `add_clip`, the shape the drop path uses) would take three Undos and
    // leave an empty track behind after the first — this op does the whole
    // thing at once.
    const stack = useHistoryStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    // …and the entry says a track was created, so the history list does not
    // read as a plain clip add whose Undo mysteriously removes a track.
    expect(stack[0].label).toBe('Add "Title" on a new video track');

    // What that single Undo restores, asserted on the op rather than through
    // the store's IPC round trip (`restoreSnapshot` re-reads the timeline from
    // Rust, which this suite does not stub — see the file header's tier note).
    const before = fixture();
    const title = clipFromDraggedGenerator({ kind: 'title' }, FPS);
    if ('error' in title) throw new Error(title.error);
    const after = applyOpPure(before, {
      kind: 'add_clip',
      track: 0,
      clip: title,
      startFrame: 0,
      onNewVideoTrack: true,
    });
    expect(after.tracks).toHaveLength(3);
    expect(before.tracks, 'the op is pure — the pre-state is the undo target').toHaveLength(2);
  });

  it('13. the reducer itself refuses a title on an audio track, whatever the caller', async () => {
    // The other half of B-129: the ONLY track-kind guard used to live in
    // `TimelinePane`'s `onDrop`, so any other caller — the MCP tool, a future
    // one — walked straight past it and landed a text clip on an audio track,
    // which is what the owner's real project contained. The gate is in
    // `applyOp` now, so this is asserted against the op directly rather than
    // through any one UI path.
    const before = fixture();
    const title = clipFromDraggedGenerator({ kind: 'title' }, FPS);
    if ('error' in title) throw new Error(title.error);

    // Track 1 is the audio track.
    expect(checkAddClip(before, 1, title).ok).toBe(false);
    expect(checkAddClip(before, 1, title).reason).toContain('video track');
    const after = applyOpPure(before, { kind: 'add_clip', track: 1, clip: title, startFrame: 0 });
    expect(after, 'a refused add is a no-op, not a half-applied one').toBe(before);

    // …and the same op on the VIDEO track is still allowed, so the gate is a
    // kind check and not a blanket refusal of titles.
    expect(checkAddClip(before, 0, title).ok).toBe(true);
    const ok = applyOpPure(before, { kind: 'add_clip', track: 0, clip: title, startFrame: 200 });
    expect(ok.tracks[0].clips).toHaveLength(2);
  });

  it('14. an adjustment clip is gated and re-homed by exactly the same rules', async () => {
    const before = fixture();
    const adj = clipFromDraggedGenerator({ kind: 'adjustment' }, FPS);
    if ('error' in adj) throw new Error(adj.error);

    expect(checkAddClip(before, 1, adj).ok).toBe(false);
    expect(applyOpPure(before, { kind: 'add_clip', track: 1, clip: adj, startFrame: 0 })).toBe(before);

    const onTop = applyOpPure(before, {
      kind: 'add_clip',
      track: 0,
      clip: adj,
      startFrame: 0,
      onNewVideoTrack: true,
    });
    expect(onTop.tracks).toHaveLength(3);
    expect(onTop.tracks[0].kind).toBe('video');
    expect(onTop.tracks[0].clips[0].adjustment).toBeTruthy();
  });
});
