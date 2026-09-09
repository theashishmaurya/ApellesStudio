// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for D-263's DOCKED library panel: the
 * rail switches what the column shows, and every library in it is still a real
 * drag source onto the timeline.
 *
 * **Why this file exists.** D-248 put these libraries in per-rail-button
 * popovers, partly because "a native HTML5 drag out of a popover keeps the
 * popover open for the whole gesture." D-263 docked them at the owner's ask,
 * which retires that reasoning — but only if a drag out of the DOCKED panel
 * really does reach the timeline and really does place the same clip. That is
 * a wiring fact, not an arithmetic one, so it is proven by mounting the rail,
 * the docked panel and the real `TimelinePane` together and dragging between
 * them, exactly as `TimelinePane.drop.dom.test.tsx` proves the payload half.
 *
 * **Tier and its honest limits.** jsdom, with the timeline's edit area rect
 * stubbed (the same disclosure every `TimelinePane.*.dom` suite in this
 * package makes): it proves the handlers, the payload contract and the ops
 * that come out of them. It does not prove that a real WKWebView delivers the
 * `dragstart`, or which element wins by paint order — those stay owner/live
 * checks. What it CAN prove, and does, is that nothing about the docked panel
 * broke the drag contract that used to run out of a popover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installElementAnimationsStub,
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
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: async () => null,
}));

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { EditLibraryRail } from './EditLibraryRail';
import { EditLibraryPanel } from './EditLibraryPanel';
import { CHROMA_GENERATOR_DRAG_MIME, isTextClip, type Timeline } from './timeline';

const FPS = 24;
const ROW_HEIGHT = 52;
const RULER_AND_MARGIN_PX = 32 + 16;
const AREA = { left: 0, top: 0, width: 1200, height: 600 };

function fixture(): Timeline {
  return {
    id: 'library-fixture-tl',
    name: 'library fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'v',
            name: 'V',
            source_path: '/v.mp4',
            source_start: 0,
            duration: 96,
            source_len: 480,
            start_frame: 0,
          },
        ],
      },
    ],
  };
}

/** The three surfaces mounted the way the shell mounts them (D-263): rail,
 *  then the docked column, then the tab content with the timeline in it. The
 *  dock-open flag is shell state in the real app (`useShellStore`), which this
 *  package must not import — so it is a prop, exactly as `Root.tsx` wires it. */
let dockOpen = true;
function Harness(): React.ReactElement {
  return React.createElement(
    'div',
    null,
    React.createElement(EditLibraryRail, {
      dockOpen,
      onDockOpenChange: (open: boolean) => {
        dockOpen = open;
      },
    }),
    React.createElement(EditLibraryPanel),
    React.createElement(TimelinePane),
  );
}

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

const rowY = (y: number) => AREA.top + RULER_AND_MARGIN_PX + y;

/** Start a real `dragstart` on a library entry and return what it wrote to the
 *  drag payload — the exact string `TimelinePane`'s `drop` will read back. */
function dragPayloadOf(entry: HTMLElement): Record<string, string> {
  const written: Record<string, string> = {};
  const e = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      effectAllowed: 'none',
      setData: (mime: string, value: string) => {
        written[mime] = value;
      },
    },
  });
  actSync(() => entry.dispatchEvent(e));
  return written;
}

function dropEvent(payload: string, clientY: number): Event {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clientX', { value: 400 });
  Object.defineProperty(e, 'clientY', { value: clientY });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types: [CHROMA_GENERATOR_DRAG_MIME],
      dropEffect: 'none',
      effectAllowed: 'none',
      getData: (m: string) => (m === CHROMA_GENERATOR_DRAG_MIME ? payload : ''),
      setData: () => {},
    },
  });
  return e;
}

const rail = (mode: string) => document.querySelector<HTMLElement>(`[data-chroma-rail-button="${mode}"]`);
const panel = () => document.querySelector<HTMLElement>('[data-chroma-panel="edit-library"]');
const entry = (kind: string) => document.querySelector<HTMLElement>(`[data-chroma-library-entry="${kind}"]`);

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let restoreAnimations: () => void;
let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountAll(): Promise<HTMLElement> {
  dockOpen = true;
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/library-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
      libraryMode: 'sources',
    }),
  );
  ui = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(2);
  return stubEditAreaRect();
}

/** Click a rail button. The panel re-renders off the store, so this is the
 *  same path the human's own click takes — no state is poked directly. */
async function pick(mode: string): Promise<void> {
  const button = rail(mode);
  expect(button, `the rail has a ${mode} button`).not.toBeNull();
  actSync(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await waitFrames(2);
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(AREA.width, AREA.height);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  restoreAnimations = installElementAnimationsStub();
  console_ = captureConsole();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  ui?.unmount();
  ui = null;
  restoreAnimations();
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
      libraryMode: 'sources',
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

describe('D-263 — the rail switches the DOCKED panel, one library at a time', () => {
  it('1. shows nothing of its own in `sources` mode, then each library in turn', async () => {
    await mountAll();
    // `sources` is the shell's shared media pool: this package renders nothing.
    expect(panel(), 'no Edit-tab library while Sources is selected').toBeNull();

    await pick('titles');
    expect(panel()!.getAttribute('data-chroma-library-mode')).toBe('titles');
    expect(entry('title'), 'the Title entry').not.toBeNull();
    expect(entry('adjustment'), 'and only that one').toBeNull();

    await pick('effects');
    expect(panel()!.getAttribute('data-chroma-library-mode')).toBe('effects');
    expect(entry('adjustment')).not.toBeNull();
    // The previous library is GONE, not merely invisible — a plain React
    // conditional removes it in the same commit, which is precisely why this
    // is not the B-124 shape (a Base UI panel whose hide waits on a
    // `requestAnimationFrame` a non-frontmost window never delivers).
    expect(entry('title'), 'the Titles library is out of the DOM, not stacked under it').toBeNull();

    await pick('subtitles');
    expect(panel()!.getAttribute('data-chroma-library-mode')).toBe('subtitles');
    expect(
      document.querySelector('[data-testid="caption-library"]'),
      'the caption style library is docked here now, not in a popover',
    ).not.toBeNull();
    expect(entry('adjustment')).toBeNull();

    // Exactly one library panel exists at any moment.
    expect(document.querySelectorAll('[data-chroma-panel="edit-library"]')).toHaveLength(1);
  });

  it('2. collapsing (clicking the selected library again) asks the shell to close the column', async () => {
    await mountAll();
    await pick('titles');
    expect(dockOpen).toBe(true);

    await pick('titles');
    // The rail does not hide anything itself — the column is the shell's, so
    // all it can do is ask, which is exactly what it did.
    expect(dockOpen, 'the second click asked for the column to close').toBe(false);
  });
});

describe('D-263 — every docked library is still a real drag source onto the timeline', () => {
  it('3. a Title dragged out of the docked panel places a real TEXT clip', async () => {
    const area = await mountAll();
    await pick('titles');

    const written = dragPayloadOf(entry('title')!);
    expect(JSON.parse(written[CHROMA_GENERATOR_DRAG_MIME])).toEqual({ kind: 'title' });

    actSync(() => area.dispatchEvent(dropEvent(written[CHROMA_GENERATOR_DRAG_MIME], rowY(ROW_HEIGHT / 2))));
    await waitFrames(2);

    const track0 = useEditorTimelineStore.getState().timeline!.tracks[0];
    const added = track0.clips.find((c) => c.id !== 'v')!;
    expect(isTextClip(added), 'a real text clip, from a drag that never touched a popover').toBe(true);
  });

  it('4. an adjustment clip dragged out of the docked Effects library places one too', async () => {
    const area = await mountAll();
    await pick('effects');

    const written = dragPayloadOf(entry('adjustment')!);
    expect(JSON.parse(written[CHROMA_GENERATOR_DRAG_MIME])).toEqual({ kind: 'adjustment' });

    actSync(() => area.dispatchEvent(dropEvent(written[CHROMA_GENERATOR_DRAG_MIME], rowY(ROW_HEIGHT / 2))));
    await waitFrames(2);

    const track0 = useEditorTimelineStore.getState().timeline!.tracks[0];
    const added = track0.clips.find((c) => c.id !== 'v')!;
    expect(added.adjustment, 'a real adjustment layer').toBeTruthy();
    expect(added.text, 'and not a title').toBeUndefined();
  });

  it('5. the Subtitles library still applies a caption style from the docked panel', async () => {
    await mountAll();
    await pick('subtitles');

    // Captions are the one library with no drag: a preset creates a whole
    // subtitle TRACK, which has no meaningful drop target, so its gesture is
    // and always was a click (D-243). It has to keep working docked.
    const tile = document.querySelector<HTMLElement>('[data-testid="caption-preset-caption-highlight"]');
    expect(tile, 'a preset tile is docked in the panel').not.toBeNull();
    actSync(() => tile!.click());
    await waitFrames(2);

    const tl = useEditorTimelineStore.getState().timeline!;
    expect(tl.tracks.some((t) => t.kind === 'subtitle'), 'a subtitle track was created').toBe(true);
  });
});

describe('D-263 — click-to-add at the playhead, and its refusal', () => {
  it('6. adds the generator at the playhead and selects it', async () => {
    await mountAll();
    actSync(() => useEditorTimelineStore.setState({ playhead: 200 }));
    await pick('titles');

    const add = document.querySelector<HTMLElement>('[aria-label="Add title at the playhead"]');
    expect(add, 'the click-to-add half is still here').not.toBeNull();
    actSync(() => add!.click());
    await waitFrames(2);

    const state = useEditorTimelineStore.getState();
    // D-262/B-129 — on a brand-new video track at index 0, the top of the
    // compositing stack, so a title always has room and always composites over
    // the picture rather than into a gap between two shots.
    const added = state.timeline!.tracks[0].clips.find((c) => c.start_frame === 200);
    expect(added, 'placed at the playhead on a new top video track').toBeTruthy();
    expect(state.selection.map((s) => s.id)).toEqual([added!.id]);
  });

  /** D-262/B-129 (landed the same night, merged into this panel with the code
   *  it rewrote): an add makes its own new video track, so it never has to
   *  compete for room and the old occupied-playhead refusal is unreachable
   *  from here. `TimelinePane.drop.dom.test.tsx` 10-12 pin that behaviour
   *  itself; what this pins is that the EFFECTS library reaches it too, from
   *  the docked panel. (The op-level gap that refusal was guarding is still
   *  real for an explicit track+frame from MCP — B-131.) */
  it('7. an add from the Effects library makes its own track and leaves the edit untouched', async () => {
    await mountAll();
    actSync(() => useEditorTimelineStore.setState({ playhead: 300 }));
    await pick('effects');

    const add = document.querySelector<HTMLElement>('[aria-label="Add adjustment clip at the playhead"]');
    expect(add, 'the click-to-add half of the Effects library').not.toBeNull();
    actSync(() => add!.click());
    await waitFrames(2);

    const tracks = useEditorTimelineStore.getState().timeline!.tracks;
    expect(tracks, 'a new video track above the picture').toHaveLength(2);
    expect(tracks[0].clips[0].adjustment).toBeTruthy();
    expect(tracks[0].clips[0].start_frame).toBe(300);
    // The existing edit is renumbered, never moved or overwritten.
    expect(tracks[1].clips.map((c) => c.id)).toEqual(['v']);
    expect(tracks[1].clips[0].start_frame).toBe(0);
  });
});
