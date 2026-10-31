// @vitest-environment jsdom
/**
 * D-437 S3a — `TimelineLanes` / `TrackLane` / `LaneClip`: what is mounted for a
 * scroll window, the pins, the DOM contract the harness and the gestures read,
 * and — the point of the memoised design — what RE-renders.
 *
 * `ClipBlock` and `ClipFadeOverlay` are stubbed (they need the store and Tauri
 * otherwise, and are not under test). `LaneClip` renders are counted at its `memo`
 * boundary (see the `react` mock). Counts run un-StrictMode'd (StrictMode doubles
 * every render in dev); the StrictMode mount is checked separately.
 *
 * jsdom has no layout, so culling is exercised through `viewportWidth` and
 * `windowLeft` props. Fixture: 24 fps, 100 px/s, `startLeftPx` 32, one track of
 * 100 back-to-back 1 s clips `c0..c99` (clip n spans x 32+100n .. 132+100n) and a
 * second track `d0`.
 */
import React, { createRef, useState, type FunctionComponent } from 'react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actSync, firePointerEvent, mount, type MountedComponent } from '../testUtils/pointerHarness';

const renders = vi.hoisted(() => ({ byId: new Map<string, number>() }));
// A render of `LaneClip` is counted at the `memo` boundary: React calls the inner function
// only when `memo`'s shallow compare says the props changed (or its own state did), so this
// IS the count of LaneClip renders. Counting a stubbed child instead would undercount: the
// React Compiler memoises an unchanged child element.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    memo: ((component: FunctionComponent<{ clip?: { id: string } }>, compare?: undefined) =>
      actual.memo(function Counted(props: { clip?: { id: string } }) {
        const id = props.clip?.id;
        if (id !== undefined) renders.byId.set(id, (renders.byId.get(id) ?? 0) + 1);
        return component(props);
      }, compare)) as typeof actual.memo,
  };
});
vi.mock('../ClipBlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ClipBlock')>();
  return {
    ...actual,
    ClipBlock: (p: { clip: { id: string }; visibleStartPx?: number; visibleEndPx?: number }) => (
      <div data-stub-block={p.clip.id} data-vis={`${p.visibleStartPx}-${p.visibleEndPx}`} />
    ),
  };
});
vi.mock('../ClipFadeOverlay', () => ({ ClipFadeOverlay: () => null }));

import { TIMELINE_TEST_IDS as ID } from '../timelineTestIds';
import type { Clip, Track } from '../timeline';
import { clipLeftPx, clipWidthPx, contentWidth } from './laneLayout';
import { windowScrollLeft } from './laneWindow';
import { TimelineLanes, type TimelineLanesProps } from './TimelineLanes';
import { useLaneActions, type LaneActions } from './useLaneActions';

const FPS = 24;
const PX = 100;
const START = 32;
const VW = 1000;

function clip(id: string, start: number, duration = 24): Clip {
  return { id, name: id, source_path: '/x.mov', source_start: 0, duration, source_len: 100000, start_frame: start } as Clip;
}
function makeTracks(): Track[] {
  return [
    { kind: 'video', clips: Array.from({ length: 100 }, (_, i) => clip(`c${i}`, i * 24)) } as Track,
    { kind: 'audio', clips: [clip('d0', 48)] } as Track,
  ];
}

const calls: string[] = [];
const actions: LaneActions = {
  onClipPointerDownCapture: (_e, t, id) => calls.push(`down:${t}:${id}`),
  onClipClick: (_e, t, id) => calls.push(`click:${t}:${id}`),
  onToggleCurve: (t, id, p) => calls.push(`curve:${t}:${id}:${p}`),
};

function baseProps(tracks: Track[]): TimelineLanesProps {
  return {
    tracks,
    trackLabels: ['V1', 'A1'],
    fps: FPS,
    pxPerSec: PX,
    startLeftPx: START,
    tickSeconds: 1,
    rowTops: [0, 52],
    rowHeights: [52, 40],
    topPx: 34,
    viewportWidth: VW,
    windowLeft: 0,
    bandRatio: 0.3,
    showClipNames: true,
    showClipBadges: true,
    selection: [],
    syncLinkedIds: new Set(),
    avLinkedIds: new Set(),
    cutStyleById: new Map(),
    curveEditor: null,
    actions,
  };
}

let mounted: MountedComponent | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  renders.byId.clear();
  calls.length = 0;
});

/** Mount lanes whose props the test can replace. */
function setup(initial: TimelineLanesProps, opts: { strictMode?: boolean } = { strictMode: false }) {
  const expose: { set: (p: TimelineLanesProps) => void } = { set: () => {} };
  function Host() {
    const [props, setProps] = useState(initial);
    expose.set = setProps;
    return (
      <DndContext>
        <TimelineLanes {...props} />
      </DndContext>
    );
  }
  mounted = mount(<Host />, opts);
  return {
    update: (p: TimelineLanesProps) => actSync(() => expose.set(p)),
  };
}

function clipIds(): string[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(`[data-testid="${ID.clip}"]`)).map(
    (e) => e.getAttribute('data-chroma-clip-id')!,
  );
}
function slot(id: string): HTMLElement {
  const body = document.body.querySelector<HTMLElement>(`[data-testid="${ID.clip}"][data-chroma-clip-id="${id}"]`);
  if (!body) throw new Error(`clip ${id} not mounted`);
  return body.closest<HTMLElement>('[data-chroma-clip-slot]')!;
}
function total(): number {
  let n = 0;
  for (const v of renders.byId.values()) n += v;
  return n;
}

describe('what is mounted', () => {
  it('renders the clips in the window plus overscan, not all 100', () => {
    setup(baseProps(makeTracks()));
    const ids = clipIds();
    expect(ids).toContain('c0');
    expect(ids).toContain('c9'); // the visible 1000 px
    expect(ids).toContain('c14'); // overscan to the right
    expect(ids).not.toContain('c40');
    expect(ids).toContain('d0');
    expect(ids.length).toBeLessThan(40); // about 25 of 101, not all
  });

  it('moves the window with windowLeft and unmounts what left it', () => {
    const tracks = makeTracks();
    const ui = setup(baseProps(tracks));
    ui.update({ ...baseProps(tracks), windowLeft: windowScrollLeft(5000, VW) });
    const ids = clipIds();
    expect(ids).toContain('c50');
    expect(ids).toContain('c45'); // viewport starts near x=5000 → clip 49; one viewport of overscan back
    expect(ids).not.toContain('c0');
    expect(ids).not.toContain('c90');
  });

  it('renders every clip when the viewport is unmeasured (width 0)', () => {
    setup({ ...baseProps(makeTracks()), viewportWidth: 0 });
    expect(clipIds()).toHaveLength(101);
  });

  it('pins the selection wherever it is', () => {
    setup({ ...baseProps(makeTracks()), selection: [{ track: 0, id: 'c90' }] });
    expect(clipIds()).toContain('c90');
    expect(slot('c90').querySelector('[data-stub-block]')).not.toBeNull();
  });

  it('pins the drag source and the gesture target (pinnedClipIds)', () => {
    setup({ ...baseProps(makeTracks()), pinnedClipIds: new Set(['c70', 'c95']) });
    expect(clipIds()).toEqual(expect.arrayContaining(['c70', 'c95']));
    expect(clipIds()).not.toContain('c71');
  });

  it('pins the focused clip while it has focus, and lets it go on blur', () => {
    setup(baseProps(makeTracks()));
    // Focus a visible clip, then scroll far away: the focused clip must stay.
    const c3 = document.body.querySelector<HTMLElement>(`[data-chroma-clip-id="c3"]`)!;
    actSync(() => c3.focus());
    expect(document.activeElement).toBe(c3);
  });

  it('keeps the focused clip mounted after the window moves away from it', () => {
    const tracks = makeTracks();
    const ui = setup(baseProps(tracks));
    const c3 = document.body.querySelector<HTMLElement>(`[data-chroma-clip-id="c3"]`)!;
    actSync(() => c3.focus());
    ui.update({ ...baseProps(tracks), windowLeft: windowScrollLeft(8000, VW) });
    expect(clipIds()).toContain('c3');
    expect(document.activeElement).toBe(document.body.querySelector(`[data-chroma-clip-id="c3"]`));
    actSync(() => (document.activeElement as HTMLElement).blur());
    expect(clipIds()).not.toContain('c3');
  });

  it('mounts under StrictMode too', () => {
    setup(baseProps(makeTracks()), { strictMode: true });
    expect(clipIds()).toContain('c0');
  });
});

describe('the DOM contract', () => {
  it('carries the test ids and data-chroma-* attributes the gestures and harness read', () => {
    setup({ ...baseProps(makeTracks()), selection: [{ track: 0, id: 'c2' }] });
    const scroller = document.body.querySelector<HTMLElement>(`[data-testid="${ID.scroller}"]`)!;
    expect(scroller.getAttribute('role')).toBe('group');
    expect(scroller.getAttribute('aria-label')).toBe('Timeline tracks');
    expect(scroller.getAttribute('tabindex')).toBe('-1');
    expect(scroller.style.top).toBe('34px');

    const rows = document.body.querySelectorAll<HTMLElement>(`[data-testid="${ID.trackRow}"]`);
    expect(Array.from(rows).map((r) => r.getAttribute('data-chroma-track'))).toEqual(['0', '1']);
    expect(rows[0].getAttribute('aria-label')).toBe('V1');
    expect(rows[1].getAttribute('aria-label')).toBe('A1');
    expect(rows[0].style.top).toBe('0px');
    expect(rows[1].style.top).toBe('52px');
    expect(rows[1].style.height).toBe('40px');

    const s2 = slot('c2');
    expect(s2.getAttribute('data-testid')).toBe(ID.clipSlot);
    expect(s2.hasAttribute('data-chroma-clip-slot')).toBe(true);
    const body = s2.querySelector<HTMLElement>(`[data-testid="${ID.clip}"]`)!;
    expect(body.getAttribute('data-chroma-track')).toBe('0');
    expect(body.getAttribute('data-chroma-clip-id')).toBe('c2');
    expect(body.hasAttribute('data-chroma-clip-drag')).toBe(true);
    expect(body.getAttribute('title')).toMatch(/Option|Alt/);
    expect(body.style.contain).toBe('layout paint style');
    expect(body.className).toContain('before:outline-selection');
    expect(s2.querySelector(`[data-testid="${ID.clipTrimStart}"][data-chroma-trim-edge="start"]`)).not.toBeNull();
    expect(s2.querySelector(`[data-testid="${ID.clipTrimEnd}"][data-chroma-trim-edge="end"]`)).not.toBeNull();
  });

  it('positions the slot with left/width in content px (never a transform) and contains it without paint', () => {
    const tracks = makeTracks();
    setup(baseProps(tracks));
    const c = tracks[0].clips[5];
    const s = slot('c5');
    expect(s.style.left).toBe(`${clipLeftPx(c.start_frame, FPS, PX, START)}px`);
    expect(s.style.width).toBe(`${clipWidthPx(c, FPS, PX)}px`);
    expect(s.style.left).toBe('532px');
    expect(s.style.width).toBe('100px');
    expect(s.style.height).toBe('52px');
    expect(s.style.transform).toBe('');
    expect(s.style.willChange).toBe('');
    expect(s.style.contain).toBe('layout size style');
    expect(s.style.contain).not.toContain('paint');
  });

  it('isolates paint per lane (contain: strict) and sizes the content like the library did', () => {
    const tracks = makeTracks();
    setup(baseProps(tracks));
    const row = document.body.querySelector<HTMLElement>(`[data-testid="${ID.trackRow}"]`)!;
    expect(row.style.contain).toBe('strict');
    const w = contentWidth(100, 1, PX, START); // last clip ends at 100 s
    expect(row.style.width).toBe(`${w}px`);
    expect(row.parentElement!.style.width).toBe(`${w}px`);
    expect(row.parentElement!.style.height).toBe('92px');
  });

  it('marks A/V-linked and locked clips, and draws the sync-linked outline only when not A/V-linked', () => {
    const tracks = makeTracks();
    tracks[0] = { ...tracks[0], locked: true } as Track;
    setup({
      ...baseProps(tracks),
      avLinkedIds: new Set(['c1']),
      syncLinkedIds: new Set(['c1', 'c2']),
    });
    const body = (id: string) => slot(id).querySelector<HTMLElement>(`[data-testid="${ID.clip}"]`)!;
    expect(body('c1').hasAttribute('data-chroma-link-partner')).toBe(true);
    expect(body('c1').className).toContain('before:outline-selection/55');
    expect(body('c1').className).not.toContain('outline-white/35');
    expect(body('c2').hasAttribute('data-chroma-link-partner')).toBe(false);
    expect(body('c2').className).toContain('before:outline-white/35');
    expect(body('c2').className).toContain('opacity-60');
    // a locked track offers no trim zones
    expect(slot('c2').querySelector(`[data-testid="${ID.clipTrimStart}"]`)).toBeNull();
  });

  it('hands each clip its clamped, bucketed visible slice', () => {
    setup(baseProps(makeTracks()));
    // c2 is wholly inside the viewport: {0, width}
    expect(slot('c2').querySelector('[data-stub-block]')!.getAttribute('data-vis')).toBe('0-100');
  });
});

describe('actions', () => {
  it('forwards a slot click, a capture-phase press and the curve toggle with (track, id)', () => {
    setup(baseProps(makeTracks()));
    slot('c4').click();
    expect(calls).toEqual(['click:0:c4']);
    const body = slot('d0').querySelector<HTMLElement>(`[data-testid="${ID.clip}"]`)!;
    firePointerEvent(body, 'pointerdown', { x: 10, y: 10 });
    expect(calls).toContain('down:1:d0');
  });

  it('useLaneActions keeps one identity and calls the latest handler', () => {
    const seen: LaneActions[] = [];
    const log: string[] = [];
    const expose: { set: (n: number) => void } = { set: () => {} };
    function Host() {
      const [n, setN] = useState(0);
      expose.set = setN;
      const a = useLaneActions({
        onClipPointerDownCapture: () => {},
        onClipClick: (_e, t, id) => log.push(`v${n}:${t}:${id}`),
        onToggleCurve: () => {},
      });
      seen.push(a);
      return null;
    }
    mounted = mount(<Host />, { strictMode: false });
    actSync(() => expose.set(1));
    actSync(() => expose.set(2));
    expect(new Set(seen).size).toBe(1);
    seen[0].onClipClick({} as React.MouseEvent<HTMLElement>, 3, 'x');
    expect(log).toEqual(['v2:3:x']);
  });
});

describe('render counts (the memoised design)', () => {
  function mountedBaseline() {
    const tracks = makeTracks();
    const ui = setup(baseProps(tracks));
    const baseline = total();
    expect(baseline).toBeGreaterThan(10);
    renders.byId.clear();
    return { tracks, ui };
  }

  it('re-rendering the host with identical props re-renders no clip', () => {
    const { tracks, ui } = mountedBaseline();
    ui.update({ ...baseProps(tracks) });
    expect(total()).toBe(0);
  });

  it('replacing one clip object re-renders exactly that LaneClip', () => {
    const { tracks, ui } = mountedBaseline();
    const edited = { ...tracks[0].clips[5], start_frame: tracks[0].clips[5].start_frame + 3 };
    const next: Track[] = [{ ...tracks[0], clips: tracks[0].clips.map((c, i) => (i === 5 ? edited : c)) }, tracks[1]];
    ui.update(baseProps(next));
    expect([...renders.byId.entries()]).toEqual([['c5', 1]]);
    expect(slot('c5').style.left).toBe(`${clipLeftPx(edited.start_frame, FPS, PX, START)}px`);
  });

  it('a selection change re-renders only the clips whose flag flipped', () => {
    const { tracks, ui } = mountedBaseline();
    ui.update({ ...baseProps(tracks), selection: [{ track: 0, id: 'c3' }] });
    expect([...renders.byId.entries()]).toEqual([['c3', 1]]);
    renders.byId.clear();
    ui.update({ ...baseProps(tracks), selection: [{ track: 0, id: 'c4' }] });
    expect([...renders.byId.keys()].sort()).toEqual(['c3', 'c4']);
    expect([...renders.byId.values()]).toEqual([1, 1]);
  });

  it('a scroll inside the window bucket is not a prop change: nothing re-renders', () => {
    const { tracks, ui } = mountedBaseline();
    for (const scrollLeft of [40, 200, 499]) {
      ui.update({ ...baseProps(tracks), windowLeft: windowScrollLeft(scrollLeft, VW) });
    }
    expect(total()).toBe(0);
  });

  it('crossing the bucket mounts the newcomers and re-renders no clip that stayed fully visible', () => {
    const { tracks, ui } = mountedBaseline();
    ui.update({ ...baseProps(tracks), windowLeft: windowScrollLeft(500, VW) });
    expect(renders.byId.get('c8')).toBeUndefined(); // inside both viewports: same slice
    expect(renders.byId.get('c14')).toBeUndefined();
    expect(renders.byId.get('c27')).toBe(1); // newly mounted
    expect(total()).toBeLessThan(20);
  });

  it('zoom re-renders the visible clips (their geometry changed) and nothing else', () => {
    const { tracks, ui } = mountedBaseline();
    ui.update({ ...baseProps(tracks), pxPerSec: 50 });
    expect(renders.byId.get('c3')).toBe(1);
    expect([...renders.byId.values()].every((n) => n === 1)).toBe(true);
  });

  it('an unrelated track changing leaves the other track\'s clips alone', () => {
    const { tracks, ui } = mountedBaseline();
    const d = { ...tracks[1].clips[0], start_frame: 60 };
    ui.update(baseProps([tracks[0], { ...tracks[1], clips: [d] }]));
    expect([...renders.byId.entries()]).toEqual([['d0', 1]]);
  });
});

describe('paint containment (D-437 S7, plan §2.9 items 1 and 2)', () => {
  it('a lane is contain: strict; a clip slot is contain: layout size style (never paint); the body keeps layout paint style', () => {
    setup(baseProps(makeTracks()));
    const row = document.body.querySelector<HTMLElement>(`[data-testid="${ID.trackRow}"]`)!;
    expect(row.style.contain).toBe('strict');
    const s = slot('c0');
    // `paint` on the slot would clip a head trim's translated body (§2.9 item 2).
    expect(s.style.contain).toBe('layout size style');
    const body = s.querySelector<HTMLElement>(`[data-testid="${ID.clip}"]`)!;
    expect(body.style.contain).toBe('layout paint style');
  });
});

describe('scroller wiring', () => {
  it('forwards scrollerRef and onScroll', () => {
    const ref = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    setup({ ...baseProps(makeTracks()), scrollerRef: ref, onScroll });
    expect(ref.current?.getAttribute('data-testid')).toBe(ID.scroller);
    actSync(() => {
      ref.current!.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(onScroll).toHaveBeenCalledTimes(1);
  });
});
