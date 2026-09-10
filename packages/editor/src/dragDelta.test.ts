/**
 * @apelles/editor — `dragDelta` (B-145 / D-302).
 *
 * A drag's landing frame has a correct answer, so it is unit-tested, per this
 * repo's own testing rule. What is pinned here is the arithmetic: the drag's
 * on-screen displacement comes from the two rect corners dnd-kit publishes and
 * nothing else, and the content-space one adds exactly the scroll that happened
 * DURING the drag — never the scroll the drag happened to start at, which is
 * the term `event.delta` gets wrong and which B-145 was.
 */
import { describe, expect, it } from 'vitest';

import { dragDelta } from './dragDelta';

const at = (left: number, top: number) => ({ left, top });
const scroll = (left: number, top: number) => ({ left, top });

describe('dragDelta (B-145)', () => {
  it('is the difference between the dragged rect’s two corners', () => {
    const d = dragDelta({ initial: at(482, 100), translated: at(632, 100) }, scroll(0, 0), scroll(0, 0));
    expect(d).toEqual({ screenX: 150, screenY: 0, contentX: 150, contentY: 0 });
  });

  it('a drag on a scrolled timeline that does not scroll further moves by exactly what the pointer moved', () => {
    // THE regression case. The timeline is scrolled 2000px in and a clip is
    // dragged 150px to the right. `event.delta.x` reads -1850 here (dnd-kit
    // keeps the scroll offset it captured at drag start but measures the live
    // one against a droppable outside the scroll container — see the module
    // doc); the honest answer is +150, and the clip must land 150px later, not
    // 1850px earlier at frame 0.
    const d = dragDelta({ initial: at(1095, 126), translated: at(1245, 126) }, scroll(2000, 0), scroll(2000, 0));
    expect(d?.screenX).toBe(150);
    expect(d?.contentX).toBe(150);
  });

  it('adds the scroll that happened DURING the drag, on both axes', () => {
    // The pointer barely moved but the content scrolled 300px right underneath
    // it: through the timeline's own content the drag has travelled 320px.
    const d = dragDelta({ initial: at(100, 50), translated: at(120, 70) }, scroll(2000, 40), scroll(2300, 92));
    expect(d).toEqual({ screenX: 20, screenY: 20, contentX: 320, contentY: 72 });
  });

  it('a scroll BACK during the drag subtracts', () => {
    const d = dragDelta({ initial: at(100, 0), translated: at(300, 0) }, scroll(500, 0), scroll(200, 0));
    expect(d?.contentX).toBe(-100);
  });

  it('a drag that has not moved is zero, not the scroll offset', () => {
    const d = dragDelta({ initial: at(482, 100), translated: at(482, 100) }, scroll(9999, 777), scroll(9999, 777));
    expect(d).toEqual({ screenX: 0, screenY: 0, contentX: 0, contentY: 0 });
  });

  it('is null when dnd-kit has no measurement — never a silent zero', () => {
    // Both corners come from the same nullable rect, so they are absent
    // together; either one missing means there is no honest displacement to
    // report and the caller must refuse the landing rather than commit a move
    // to wherever the clip already was.
    expect(dragDelta({ initial: null, translated: null }, scroll(0, 0), scroll(0, 0))).toBeNull();
    expect(dragDelta({ initial: at(0, 0), translated: null }, scroll(0, 0), scroll(0, 0))).toBeNull();
    expect(dragDelta({ initial: null, translated: at(0, 0) }, scroll(0, 0), scroll(0, 0))).toBeNull();
  });
});
