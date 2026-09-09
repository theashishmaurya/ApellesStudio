// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for the trim-tool palette (D-261), built
 * on the same harness and fixture as `TimelinePane.trim.dom.test.tsx` (D-235),
 * which this file is the direct sequel to.
 *
 * **What this file has to prove, and why it is shaped this way.** D-261's whole
 * claim is that picking an icon reaches the SAME edit that holding Alt over the
 * right part of a clip reaches — that the new, discoverable path and the old,
 * hidden one are one feature with two entrances, not two features that might
 * drift. A test that only asserted "the button highlights" would prove nothing
 * about that. So the central assertions here (tests 3 and 4) run the identical
 * drag twice against the identical fixture — once the D-235 way, once the
 * D-261 way — and compare the two resulting TIMELINES field for field. If the
 * palette ever resolved to a different op, or to the right op on the wrong
 * clip, or clamped differently, those two timelines stop matching.
 *
 * **Tier limits, inherited and unchanged.** jsdom, not real Chromium; and the
 * EDGE drags (ripple, roll) still cannot be driven from pointer events here
 * because they belong to `@xzdarcy/react-timeline-editor`'s interact.js resize,
 * which does not run under jsdom at all — see `TimelinePane.trim.dom.test.tsx`'s
 * own header for the full disclosure, which was established by probe, not
 * assumed. The palette's effect on those two is therefore asserted where it is
 * really decided: `resizeEndOp`, pure, in `trimMode.test.ts`. What this file
 * adds for them is the half jsdom CAN answer — that with a tool chosen, hovering
 * a real edge handle resolves to that tool's mode in the real component, with no
 * modifier held.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  nextFrame,
  stubBoundingRectsFromInlineStyle,
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
import { TRIM_TOOLS, type TrimTool } from './trimMode';
import type { Timeline } from './timeline';

const FPS = 24;
const ROW_HEIGHT_PX = 52;
const CLIP_FRAMES = 48;

/** The same three-clip fixture D-235's DOM test uses, for the same reason:
 *  every clip has real source room on both sides, so any of the four modes has
 *  somewhere to go. 'a' [0,48) 'b' [48,96) 'c' [96,144). */
function clipFixture(id: string, start: number) {
  return {
    id,
    name: id.toUpperCase(),
    source_path: `/${id}.mp4`,
    source_start: 100,
    duration: CLIP_FRAMES,
    source_len: 480,
    start_frame: start,
  };
}

function buildFixture(): Timeline {
  return {
    id: 'trim-tools-fixture-tl',
    name: 'trim tools fixture',
    rate: { num: FPS, den: 1 },
    tracks: [{ kind: 'video', clips: [clipFixture('a', 0), clipFixture('b', 48), clipFixture('c', 96)] }],
  };
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

function resetStore() {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/trim-tools-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
}

beforeEach(async () => {
  restore = [
    stubOffsetMetrics(1200, 600),
    installResizeObserverStub(),
    installPointerCaptureStub(),
    stubBoundingRectsFromInlineStyle(),
  ];
  console_ = captureConsole();
  resetStore();
  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  for (const r of restore) r();
  restore = [];
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

function bodies(): HTMLElement[] {
  return Array.from(mounted!.container.querySelectorAll('[data-chroma-clip-drag]'));
}

function timelineNow(): Timeline {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('fixture timeline is gone');
  return tl;
}

/** The palette's button for one tool, as a user would find it. */
function toolButton(tool: TrimTool): HTMLButtonElement {
  const el = mounted!.container.querySelector<HTMLButtonElement>(`[data-chroma-trim-tool="${tool}"]`);
  if (!el) throw new Error(`no ${tool} tool button in the toolbar`);
  return el;
}

/** Click a tool — a real click on the real button, not a state poke. */
async function pickTool(tool: TrimTool) {
  actSync(() => toolButton(tool).click());
  await nextFrame();
}

/** Type a bare letter at the pane, the way the shortcut really arrives. */
async function pressKey(key: string) {
  const pane = mounted!.container.querySelector<HTMLElement>('[tabindex="0"]');
  if (!pane) throw new Error('the timeline pane is not focusable');
  actSync(() => {
    pane.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await nextFrame();
}

/** A real pointer drag on a clip BODY — dnd-kit listens on the document, per
 *  the D-235 file's own probe. */
async function bodyDrag(el: HTMLElement, fromX: number, toX: number, y: number, opts: Record<string, boolean> = {}) {
  firePointerEvent(el, 'pointerdown', { x: fromX, y }, opts);
  await nextFrame();
  const step = (toX - fromX) / 4;
  for (let i = 1; i <= 4; i++) {
    firePointerEvent(document, 'pointermove', { x: fromX + step * i, y }, opts);
    await nextFrame();
  }
  firePointerEvent(document, 'pointerup', { x: toX, y }, opts);
  await nextFrame();
}

async function setAlt(down: boolean) {
  actSync(() => {
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: 'Alt', altKey: down, bubbles: true }));
  });
  await nextFrame();
}

function hintText(): string | null {
  return mounted!.container.querySelector('[data-chroma-trim-hint]')?.textContent ?? null;
}

/** The pointer-following mode badge D-250 added — the label half of it. */
function badgeLabel(): string | null {
  const badge = mounted!.container.querySelector<HTMLElement>('[data-chroma-trim-badge]');
  if (!badge || badge.hidden) return null;
  return badge.textContent ?? null;
}

// --------------------------------------------------------------------------- //
// 1. the palette itself
// --------------------------------------------------------------------------- //

describe('the trim palette (D-261)', () => {
  it('1. renders one button per tool, with Select active by default', () => {
    for (const { tool } of TRIM_TOOLS) {
      expect(toolButton(tool), `no button for the ${tool} tool`).toBeTruthy();
    }
    // Adobe's own rule: the Selection tool is the default, and it is a REAL
    // pressed state, not the absence of one.
    expect(toolButton('select').getAttribute('aria-pressed')).toBe('true');
    for (const { tool } of TRIM_TOOLS.filter((t) => t.tool !== 'select')) {
      expect(toolButton(tool).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('2. is exclusive — picking one tool releases the last', async () => {
    await pickTool('slip');
    expect(toolButton('slip').getAttribute('aria-pressed')).toBe('true');
    expect(toolButton('select').getAttribute('aria-pressed')).toBe('false');

    await pickTool('roll');
    expect(toolButton('roll').getAttribute('aria-pressed')).toBe('true');
    expect(toolButton('slip').getAttribute('aria-pressed')).toBe('false');

    await pickTool('select');
    expect(toolButton('select').getAttribute('aria-pressed')).toBe('true');
    expect(toolButton('roll').getAttribute('aria-pressed')).toBe('false');
  });
});

// --------------------------------------------------------------------------- //
// 2. THE POINT OF THE FEATURE: icon path == Alt path
// --------------------------------------------------------------------------- //

describe('the icon path commits exactly what the Alt path commits (D-261)', () => {
  /** Runs `drag` against a fresh fixture and returns the timeline it produced,
   *  so two entrances to the same edit can be compared as whole documents. */
  async function timelineAfter(drag: () => Promise<void>): Promise<Timeline> {
    resetStore();
    await waitFrames(2);
    await drag();
    return timelineNow();
  }

  it('3. Slip: clicking the icon and dragging equals Alt + dragging the upper half', async () => {
    // The D-235 gesture: Alt held, pointer in the clip's TOP band.
    const viaAlt = await timelineAfter(async () => {
      await pickTool('select');
      await setAlt(true);
      await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.25, { altKey: true });
      await setAlt(false);
    });

    // The D-261 gesture: no modifier at all, and deliberately at the MIDDLE of
    // the row — the height that under the Alt heuristic would have produced a
    // SLIDE. That is what makes this a real equivalence test rather than a
    // restatement: the only thing selecting the edit here is the icon.
    const viaIcon = await timelineAfter(async () => {
      await pickTool('slip');
      await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.5);
    });

    expect(viaIcon.tracks).toEqual(viaAlt.tracks);
    // …and it really was a slip, not two identical no-ops.
    const b = viaIcon.tracks[0].clips.find((c) => c.id === 'b')!;
    expect(b.source_start).toBeGreaterThan(100);
    expect(b.start_frame).toBe(48);
    expect(b.duration).toBe(CLIP_FRAMES);
  });

  it('4. Slide: clicking the icon and dragging equals Alt + dragging the lower half', async () => {
    const viaAlt = await timelineAfter(async () => {
      await pickTool('select');
      await setAlt(true);
      await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.75, { altKey: true });
      await setAlt(false);
    });

    // Again at mid-height, which the Alt heuristic reads as the SLIDE band —
    // so this pair is the mirror of test 3: same pixel, opposite edit, chosen
    // by the icon alone. Between them they prove the palette overrides the
    // vertical band in both directions rather than happening to agree with it.
    const viaIcon = await timelineAfter(async () => {
      await pickTool('slide');
      await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.5);
    });

    expect(viaIcon.tracks).toEqual(viaAlt.tracks);
    const b = viaIcon.tracks[0].clips.find((c) => c.id === 'b')!;
    expect(b.start_frame).toBeGreaterThan(48);
    expect(b.source_start).toBe(100);
    expect(b.duration).toBe(CLIP_FRAMES);
  });

  it('5. the SLIP tool at the slide height slips, and vice versa — the icon beats the band', async () => {
    // Stated on its own because it is the single behaviour the owner asked
    // for: the pointer's height stops mattering once a tool is chosen.
    await pickTool('slip');
    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.9); // deep in the slide band
    const slipped = timelineNow().tracks[0].clips.find((c) => c.id === 'b')!;
    expect(slipped.start_frame, 'a slip must not move the clip').toBe(48);
    expect(slipped.source_start).toBeGreaterThan(100);

    resetStore();
    await waitFrames(2);

    await pickTool('slide');
    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.1); // deep in the slip band
    const slid = timelineNow().tracks[0].clips.find((c) => c.id === 'b')!;
    expect(slid.start_frame, 'a slide must move the clip').toBeGreaterThan(48);
    expect(slid.source_start, 'a slide must not change the source window').toBe(100);
  });

  it('6. a keyboard shortcut selects the same tool the icon does, and edits the same way', async () => {
    // Adobe's own keys, so anyone arriving from Premiere finds them bound.
    await pressKey('y');
    expect(toolButton('slip').getAttribute('aria-pressed')).toBe('true');

    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.5);
    const b = timelineNow().tracks[0].clips.find((c) => c.id === 'b')!;
    expect(b.start_frame).toBe(48);
    expect(b.source_start).toBeGreaterThan(100);

    // …and V returns to Select, which Adobe explicitly tells users to do.
    await pressKey('v');
    expect(toolButton('select').getAttribute('aria-pressed')).toBe('true');
  });
});

// --------------------------------------------------------------------------- //
// 3. what the palette must NOT break
// --------------------------------------------------------------------------- //

describe('the palette leaves the default surface alone (D-261)', () => {
  it('7. with Select active, a plain body drag still slips and slides nothing', async () => {
    // The pre-D-235 guarantee, re-asserted now that a second thing can change
    // what a drag means. (As in the D-235 file, this does not assert where the
    // clip lands: dnd-kit resolves no drop target under jsdom, a gap that
    // predates both passes.)
    const before = timelineNow().tracks;
    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.25);
    expect(timelineNow().tracks).toEqual(before);
  });

  it('8. an edge-only tool leaves BODY drags as plain moves — Ripple never slips a clip', async () => {
    // Ripple and Roll own the two edges and nothing else, precisely so that
    // choosing one does not take away the ability to reposition a clip.
    const before = timelineNow().tracks;
    await pickTool('ripple');
    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.25);
    expect(timelineNow().tracks).toEqual(before);

    await pickTool('roll');
    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.75);
    expect(timelineNow().tracks).toEqual(before);
  });

  it('9. Alt still works, and still means what it meant, while Select is active', async () => {
    // The keep-vs-remove decision, asserted: D-235's heuristic is layered
    // under the palette, not replaced by it.
    await setAlt(true);
    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.25, { altKey: true });
    await setAlt(false);
    const b = timelineNow().tracks[0].clips.find((c) => c.id === 'b')!;
    expect(b.start_frame).toBe(48);
    expect(b.source_start).toBeGreaterThan(100);
  });

  it('10. …but a chosen tool wins over Alt, so two rules never fight over one drag', async () => {
    // Slide tool + Alt held in the SLIP band. Under the heuristic alone this
    // would slip; under the palette it must slide, because the explicit tool
    // is the one the user actually asked for.
    await pickTool('slide');
    await setAlt(true);
    await bodyDrag(bodies()[1], 200, 290, ROW_HEIGHT_PX * 0.2, { altKey: true });
    await setAlt(false);
    const b = timelineNow().tracks[0].clips.find((c) => c.id === 'b')!;
    expect(b.start_frame, 'the Slide tool must beat the Alt slip band').toBeGreaterThan(48);
    expect(b.source_start).toBe(100);
  });
});

// --------------------------------------------------------------------------- //
// 4. the hover affordance, now that it has a second trigger
// --------------------------------------------------------------------------- //

describe('the hover readout follows the tool, not just the key (D-261)', () => {
  it('11. names the tool’s edit with NO modifier held', async () => {
    await pickTool('slip');
    const action = bodies()[1].closest('.timeline-editor-action') as HTMLElement;
    // Mid-height, no Alt: under D-235 alone this hover said nothing at all.
    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.5 });
    await nextFrame();
    expect(badgeLabel()).toContain('Slip');
  });

  it('12. resolves the edge handles for an edge-only tool, with no modifier', async () => {
    // The half of ripple/roll jsdom can answer — see this file's header for
    // why the drag itself cannot be driven here.
    await pickTool('roll');
    const action = bodies()[1].closest('.timeline-editor-action') as HTMLElement;
    const right = action.querySelector('.timeline-editor-action-right-stretch') as HTMLElement;
    expect(right, 'the library did not render its own edge handles').not.toBeNull();
    firePointerEvent(right, 'pointermove', { x: 199, y: 26 });
    await nextFrame();
    expect(badgeLabel()).toContain('Roll');

    await pickTool('ripple');
    firePointerEvent(right, 'pointermove', { x: 199, y: 26 });
    await nextFrame();
    // Ripple, even though this edge IS an edit point — under Alt the same
    // pixel resolves to Roll, and the explicit tool must override that.
    expect(badgeLabel()).toContain('Ripple');
  });

  it('13. says nothing over a clip body an edge-only tool does not own', async () => {
    await pickTool('ripple');
    const action = bodies()[1].closest('.timeline-editor-action') as HTMLElement;
    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.5 });
    await nextFrame();
    // A drag here is still a plain move, so announcing a mode would be a lie —
    // and an unnamed mode would render an empty badge.
    expect(badgeLabel()).toBeNull();
  });

  it('14. the Alt-only toolbar readout is unchanged — it is the KEY’s hint, not the tool’s', async () => {
    // The palette shows the active tool as a filled button; repeating it in a
    // text readout would be the same information twice.
    await pickTool('slip');
    expect(hintText()).toBeNull();
    await setAlt(true);
    expect(hintText()).toBe('Trim: hover a clip');
    await setAlt(false);
    expect(hintText()).toBeNull();
  });
});
