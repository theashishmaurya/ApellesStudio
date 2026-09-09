// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the edit overlay (D-239).
 *
 * **Why this tier.** `editTypes.test.ts` proves the seven ops and the pure
 * pointer→row math, but the GESTURE is the feature: does a Sources drag
 * actually raise the strip, does releasing over a row apply THAT edit and no
 * other, does a row the timeline cannot currently satisfy refuse the drop
 * rather than silently no-op, and does a real refusal say why. None of that is
 * visible to a pure-math test, so this mounts the real component against the
 * real store and drives real HTML5 drag events.
 *
 * jsdom has no `DataTransfer`, so [`dragEvent`] builds the minimal one the spec
 * actually exposes at each phase — `types` only during `dragover` (which is the
 * real constraint the overlay is designed around, see its own doc), `getData`
 * on `drop`. React reads both straight off the native event, so the component
 * under test sees exactly what a browser would hand it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { actSync, captureConsole, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  // The store persists through `chroma_timeline_set` on a debounce; nothing in
  // this file asserts on persistence, so both calls just resolve.
  invoke: async () => undefined,
}));

const { EditOverlay } = await import('./EditOverlay');
const { useEditorTimelineStore } = await import('./timelineStore');
const { CHROMA_MEDIA_DRAG_MIME, DROP_EDIT_TYPES } = await import('./timeline');
const { useHistoryStore } = await import('@apelles/history');
type Timeline = import('./timeline').Timeline;
type DraggedMedia = import('./timeline').DraggedMedia;

const ROW_H = 40;
const LIST_TOP = 100;

/** Three 100-frame clips end to end on one video track, at 24 fps. */
function fixture(): Timeline {
  const clip = (id: string, start: number) => ({
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 100,
    source_len: 100,
    start_frame: start,
  });
  return {
    id: 't1',
    name: 'Timeline',
    rate: { num: 24, den: 1 },
    tracks: [{ kind: 'video' as const, clips: [clip('a', 0), clip('b', 100), clip('c', 200)] }],
  };
}

/** A 60-frame silent source, as the Sources panel would hand it over. */
const MEDIA: DraggedMedia = {
  id: 'm1',
  sourcePath: '/media/new.mov',
  name: 'new.mov',
  frameCount: 60,
  hasAudio: false,
  fps: 24,
};

function dragEvent(type: string, opts: { clientY?: number; payload?: string | null } = {}): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clientY', { value: opts.clientY ?? 0 });
  Object.defineProperty(e, 'clientX', { value: 400 });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types: [CHROMA_MEDIA_DRAG_MIME],
      dropEffect: 'none',
      // Per the HTML5 spec the payload is only readable in `drop`; a caller
      // that passes no `payload` models the `dragover` phase exactly.
      getData: (mime: string) => (mime === CHROMA_MEDIA_DRAG_MIME ? (opts.payload ?? '') : ''),
    },
  });
  return e;
}

/** The strip, once armed. Stubs its own rect: jsdom lays nothing out, so the
 *  seven equal bands have to be supplied for `editTargetIndexAt` to resolve. */
function list(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-edit-overlay-list]');
  if (!el) throw new Error('the edit overlay strip is not on screen');
  const node = el as HTMLElement;
  node.getBoundingClientRect = () =>
    ({ top: LIST_TOP, left: 0, right: 0, bottom: LIST_TOP + ROW_H * 7, width: 220, height: ROW_H * 7, x: 0, y: LIST_TOP, toJSON: () => ({}) }) as DOMRect;
  return node;
}

/** Centre of row `i` in the stubbed strip. */
const rowY = (i: number) => LIST_TOP + ROW_H * i + ROW_H / 2;

function layout(): Array<[string, number]> {
  const tl = useEditorTimelineStore.getState().timeline;
  return [...(tl?.tracks[0].clips ?? [])].sort((a, b) => a.start_frame - b.start_frame).map((c) => [c.id, c.start_frame]);
}

let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole> | null = null;

beforeEach(() => {
  console_ = captureConsole();
  useEditorTimelineStore.setState({ timeline: fixture(), playhead: 150, selection: [], selectedGap: null });
  useHistoryStore.getState().clear();
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  console_?.restore();
  console_ = null;
});

async function arm(): Promise<HTMLElement> {
  ui = mount(React.createElement(EditOverlay));
  await waitFrames(1);
  expect(ui.container.querySelector('[data-edit-overlay-list]')).toBeNull();
  actSync(() => {
    document.dispatchEvent(dragEvent('dragenter'));
  });
  return list(ui.container);
}

/** Drag over row `i` and release there.
 *
 *  Returns whether the `dragover` was ACCEPTED — i.e. whether the component
 *  called `preventDefault`, which is the only thing that makes a row a legal
 *  drop target in a real browser. Asserting this matters more than it looks: a
 *  synthetic `drop` dispatched by a test fires regardless, so a row that
 *  silently refuses every `dragover` would still "work" here while being
 *  completely undroppable in the app. That is a bug this file has already
 *  caught once (see test 14). */
async function dropOn(strip: HTMLElement, i: number): Promise<boolean> {
  let accepted = false;
  actSync(() => {
    const over = dragEvent('dragover', { clientY: rowY(i) });
    strip.dispatchEvent(over);
    accepted = over.defaultPrevented;
  });
  actSync(() => {
    strip.dispatchEvent(dragEvent('drop', { clientY: rowY(i), payload: JSON.stringify(MEDIA) }));
  });
  await waitFrames(1);
  return accepted;
}

describe('the edit overlay — real DOM (D-239)', () => {
  it('1. stays out of the way until a Sources drag actually starts', async () => {
    ui = mount(React.createElement(EditOverlay));
    await waitFrames(1);
    expect(ui.container.querySelector('[data-edit-overlay]')).toBeNull();
    // A drag carrying some OTHER payload must not raise it either.
    actSync(() => {
      const e = new Event('dragenter', { bubbles: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types: ['text/plain'] } });
      document.dispatchEvent(e);
    });
    expect(ui.container.querySelector('[data-edit-overlay]')).toBeNull();
  });

  it('2. raises all seven targets, in the reference’s own order', async () => {
    const strip = await arm();
    const rows = [...strip.querySelectorAll('[data-edit-target]')].map((n) => n.getAttribute('data-edit-target'));
    expect(rows).toEqual(DROP_EDIT_TYPES.map((t) => t.type));
  });

  it('3. highlights the row under the pointer, and only that one', async () => {
    const strip = await arm();
    actSync(() => {
      strip.dispatchEvent(dragEvent('dragover', { clientY: rowY(1) }));
    });
    const active = [...strip.querySelectorAll('[data-edit-target][data-active="true"]')].map((n) =>
      n.getAttribute('data-edit-target'),
    );
    expect(active).toEqual(['overwrite']);
  });

  it('4. dropping on Insert performs an INSERT at the playhead — split and ripple', async () => {
    const strip = await arm();
    await dropOn(strip, 0);
    expect(layout()).toEqual([
      ['a', 0],
      ['b', 100],
      ['m1-' + (layout()[2][0] as string).split('-')[1], 150], // the placed clip
      ['b·150', 210],
      ['c', 260],
    ]);
  });

  it('5. dropping on Overwrite writes over the playhead and moves nothing', async () => {
    const strip = await arm();
    await dropOn(strip, 1);
    const starts = layout().map(([, s]) => s);
    expect(starts).toEqual([0, 100, 150, 210]);
    // c is still where it was — an overwrite ripples nothing.
    expect(layout().some(([id, s]) => id === 'c' && s === 200)).toBe(false);
    expect(layout().find(([id]) => id === 'c·210')?.[1] ?? layout().find(([id]) => id === 'c')?.[1]).toBe(210);
  });

  it('6. dropping on Append at End ignores the playhead entirely', async () => {
    const strip = await arm();
    await dropOn(strip, 5);
    expect(layout().map(([, s]) => s)).toEqual([0, 100, 200, 300]);
  });

  it('7. leaves ONE undo entry, named for the edit type', async () => {
    const strip = await arm();
    await dropOn(strip, 0);
    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].label).toBe('Insert "new.mov"');
  });

  it('8. greys out a target-taking row with nothing under the playhead, and refuses the drop', async () => {
    useEditorTimelineStore.setState({ playhead: 900 }); // past every clip
    const strip = await arm();
    const replace = strip.querySelector('[data-edit-target="replace"]');
    expect(replace?.getAttribute('aria-disabled')).toBe('true');
    const before = layout();
    await dropOn(strip, 2);
    expect(layout()).toEqual(before);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('9. reports a real refusal in words instead of silently doing nothing', async () => {
    // A 60-frame source cannot Replace a 100-frame clip at its own length —
    // a refusal only knowable once the payload is readable, i.e. at drop.
    const strip = await arm();
    await dropOn(strip, 2);
    expect(layout()).toEqual([
      ['a', 0],
      ['b', 100],
      ['c', 200],
    ]);
    expect(ui!.container.textContent).toMatch(/too short/);
  });

  it('10. Fit to Fill takes that same slot by retiming instead', async () => {
    const strip = await arm();
    await dropOn(strip, 3);
    const placed = useEditorTimelineStore.getState().timeline?.tracks[0].clips.find((c) => c.name === 'new.mov');
    expect(placed?.start_frame).toBe(100);
    expect(placed?.duration).toBe(60); // untouched — the fit is the ramp
    expect(placed?.speed_points).toEqual([{ source_frame: 0, speed: 0.6 }]);
    expect(layout().map(([, s]) => s)).toEqual([0, 100, 200]);
  });

  it('11. Place on Top makes the new topmost video track and leaves V1 alone', async () => {
    const strip = await arm();
    await dropOn(strip, 4);
    const tl = useEditorTimelineStore.getState().timeline!;
    expect(tl.tracks).toHaveLength(2);
    expect(tl.tracks[0].clips.map((c) => c.start_frame)).toEqual([150]);
    expect(tl.tracks[1].clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('12. disarms when the drag ends without a drop, writing nothing', async () => {
    const strip = await arm();
    expect(strip).toBeTruthy();
    actSync(() => {
      document.dispatchEvent(new Event('dragend', { bubbles: true }));
    });
    expect(ui!.container.querySelector('[data-edit-overlay]')).toBeNull();
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('13. raises no console error or warning across a whole armed drop', async () => {
    const strip = await arm();
    await dropOn(strip, 1);
    expect(console_!.errors).toEqual([]);
    expect(console_!.warnings).toEqual([]);
  });

  it('14. ACCEPTS the dragover on every row a real timeline can satisfy', async () => {
    // The regression this exists for: the overlay's during-drag check cannot
    // see the source (the HTML5 payload is unreadable until `drop`), and an
    // earlier version fed the full `checkEditIn` a one-frame stand-in clip
    // instead of asking the narrower `checkEditTarget`. Every placeholder
    // length trips Replace's "too short" and Fit to Fill's speed-range refusal,
    // so both rows greyed themselves out permanently and no browser would ever
    // have delivered a drop to them — invisible to a test that dispatches
    // `drop` itself, which is why this asserts `preventDefault` instead.
    const strip = await arm(); // playhead 150, inside clip `b`
    for (let i = 0; i < DROP_EDIT_TYPES.length; i++) {
      const row = strip.querySelector(`[data-edit-target="${DROP_EDIT_TYPES[i].type}"]`);
      expect(row?.getAttribute('aria-disabled'), DROP_EDIT_TYPES[i].type).toBeNull();
      const over = dragEvent('dragover', { clientY: rowY(i) });
      actSync(() => {
        strip.dispatchEvent(over);
      });
      expect(over.defaultPrevented, DROP_EDIT_TYPES[i].type).toBe(true);
    }
  });

  it('15. REFUSES the dragover on a row the timeline cannot satisfy', async () => {
    useEditorTimelineStore.setState({ playhead: 900 }); // past every clip
    const strip = await arm();
    const replaceIdx = DROP_EDIT_TYPES.findIndex((t) => t.type === 'replace');
    const over = dragEvent('dragover', { clientY: rowY(replaceIdx) });
    actSync(() => {
      strip.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(false);
    // …while a type that needs no target is still perfectly droppable there.
    const appendIdx = DROP_EDIT_TYPES.findIndex((t) => t.type === 'append');
    const ok = dragEvent('dragover', { clientY: rowY(appendIdx) });
    actSync(() => {
      strip.dispatchEvent(ok);
    });
    expect(ok.defaultPrevented).toBe(true);
  });
});
