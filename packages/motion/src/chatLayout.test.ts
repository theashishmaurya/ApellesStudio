/**
 * Tests for the `deviceframe` / `claudechat` pure cores (D-258):
 * `motion-engine`'s `lib/device.ts` (the geometry the two primitives share)
 * and `lib/chatLayout.ts` (thread layout, message reveal scheduling, scroll,
 * and the conversation step schedule).
 *
 * Lives in `@apelles/motion`'s suite rather than the engine's for the same
 * reason `interpolateKeys.test.ts` does — the engine package has no `test`
 * script — using the same cross-package import.
 *
 * These are the parts with correct answers, per CLAUDE.md's Testing section:
 * the look of the chat is eyeballed against the owner's reference screenshot
 * (D-258 records that pass), but wrapping, stacking, reveal ordering, scroll
 * clamping and "which conversation is showing at frame N" are arithmetic, and
 * a bug in any of them silently mis-times every chat scene.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_METRICS,
  blockHeight,
  layoutThread,
  resolveActiveStep,
  revealFrames,
  scrollOffset,
  wrapLines,
  type ChatMessage,
} from '@apelles/motion-engine/src/lib/chatLayout';
import {
  DEVICE_SPECS,
  deviceBodyRect,
  deviceScreenRect,
  deviceSpec,
} from '@apelles/motion-engine/src/lib/device';

const FPS = 30;

describe('device geometry', () => {
  it('centres the body on the given point at the model’s own dimensions', () => {
    const r = deviceBodyRect({ model: 'iphone-15-pro', x: 960, y: 540, scale: 1 });
    expect(r.width).toBe(393);
    expect(r.height).toBe(852);
    expect(r.x + r.width / 2).toBe(960);
    expect(r.y + r.height / 2).toBe(540);
  });

  it('insets the screen from the body by exactly one bezel on every side', () => {
    const p = { model: 'iphone-15-pro' as const, x: 400, y: 300, scale: 1 };
    const body = deviceBodyRect(p);
    const screen = deviceScreenRect(p);
    const bezel = DEVICE_SPECS['iphone-15-pro'].bezel;
    expect(screen.x - body.x).toBe(bezel);
    expect(screen.y - body.y).toBe(bezel);
    expect(body.x + body.width - (screen.x + screen.width)).toBe(bezel);
    expect(body.y + body.height - (screen.y + screen.height)).toBe(bezel);
  });

  it('scales body and screen together, keeping the screen concentric', () => {
    const p = { model: 'iphone-15-pro' as const, x: 960, y: 540, scale: 2 };
    const body = deviceBodyRect(p);
    const screen = deviceScreenRect(p);
    expect(body.width).toBe(786);
    expect(screen.width).toBe(786 - 24 * 2);
    expect(screen.x + screen.width / 2).toBe(960);
    expect(screen.y + screen.height / 2).toBe(540);
  });

  it('falls back to the generic spec for an unknown model rather than throwing', () => {
    expect(deviceSpec('not-a-phone')).toBe(DEVICE_SPECS.generic);
    expect(() => deviceScreenRect({ model: 'not-a-phone', x: 0, y: 0 })).not.toThrow();
  });

  it('every model’s screen is strictly inside its body', () => {
    for (const model of Object.keys(DEVICE_SPECS)) {
      const body = deviceBodyRect({ model, x: 0, y: 0 });
      const screen = deviceScreenRect({ model, x: 0, y: 0 });
      expect(screen.width).toBeLessThan(body.width);
      expect(screen.height).toBeLessThan(body.height);
      expect(screen.radius).toBeLessThan(body.radius + 1);
    }
  });
});

describe('wrapLines', () => {
  it('fits a short string on one line', () => {
    expect(wrapLines('hello there', 400, 16)).toBe(1);
  });

  it('wraps onto more lines as the column narrows', () => {
    const text = 'I am planning to move to France for work and need help with visas';
    const wide = wrapLines(text, 600, 16);
    const narrow = wrapLines(text, 150, 16);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('wraps onto more lines as the type gets bigger', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(wrapLines(text, 300, 24)).toBeGreaterThan(wrapLines(text, 300, 12));
  });

  it('charges a single unbreakable run the rows it actually needs', () => {
    // 40 chars at 20px font x 0.5 avg glyph = 400px in a 100px column ⇒ 4 rows
    expect(wrapLines('x'.repeat(40), 100, 20)).toBe(4);
    // and half as wide a run needs half as many
    expect(wrapLines('x'.repeat(20), 100, 20)).toBe(2);
  });

  it('counts an explicit \\n as a hard break, matching the pre-wrap render', () => {
    expect(wrapLines('one\ntwo\nthree', 400, 16)).toBe(3);
    // hard breaks compose with soft wrapping rather than replacing it
    const long = 'word '.repeat(30).trim();
    expect(wrapLines(`${long}\n${long}`, 200, 16)).toBe(wrapLines(long, 200, 16) * 2);
  });

  it('never returns less than one line, even for empty text', () => {
    expect(wrapLines('', 300, 16)).toBe(1);
    expect(wrapLines('   ', 300, 16)).toBe(1);
  });

  it('is deterministic — the same inputs always give the same answer', () => {
    const args = ['a moderately long sentence that will certainly wrap somewhere', 220, 17] as const;
    expect(wrapLines(...args)).toBe(wrapLines(...args));
  });
});

describe('blockHeight', () => {
  const mt = DEFAULT_METRICS;

  it('gives the card kinds their fixed heights', () => {
    expect(blockHeight({ kind: 'tool', label: 'Searched Google Drive' }, mt)).toBe(mt.toolHeight);
    expect(blockHeight({ kind: 'task', title: 't' }, mt)).toBe(mt.taskHeight);
    expect(blockHeight({ kind: 'doc', title: 't' }, mt)).toBe(mt.docHeight);
  });

  it('adds bubble padding for a user message but not for assistant prose', () => {
    const text = 'short';
    const user = blockHeight({ from: 'user', text }, mt);
    const asst = blockHeight({ from: 'assistant', text }, mt);
    expect(user).toBe(mt.bubbleLineHeight + mt.bubblePadY * 2);
    expect(asst).toBe(mt.bodyLineHeight);
  });

  it('adds a sender row only when a sender is named', () => {
    const base: ChatMessage = { from: 'user', text: 'hi' };
    expect(blockHeight({ ...base, sender: 'Brooke' }, mt) - blockHeight(base, mt)).toBe(
      mt.senderHeight,
    );
  });

  it('grows with the number of wrapped lines', () => {
    const one = blockHeight({ from: 'assistant', text: 'hi' }, mt);
    const many = blockHeight({ from: 'assistant', text: 'word '.repeat(60) }, mt);
    expect(many).toBeGreaterThan(one * 5);
  });
});

describe('layoutThread', () => {
  const msgs: ChatMessage[] = [
    { from: 'user', text: 'hello', sender: 'Brooke' },
    { from: 'assistant', text: 'hi there' },
    { kind: 'tool', label: 'Searched Google Drive' },
  ];

  it('stacks blocks top to bottom with one gap between each', () => {
    const l = layoutThread(msgs);
    expect(l.blocks).toHaveLength(3);
    expect(l.blocks[0].top).toBe(0);
    for (let i = 1; i < l.blocks.length; i++) {
      expect(l.blocks[i].top).toBe(
        l.blocks[i - 1].top + l.blocks[i - 1].height + DEFAULT_METRICS.gap,
      );
    }
  });

  it('ends the total at the last block’s bottom — no trailing gap', () => {
    const l = layoutThread(msgs);
    const last = l.blocks[2];
    expect(l.total).toBe(last.top + last.height);
  });

  it('handles an empty thread', () => {
    expect(layoutThread([])).toEqual({ blocks: [], total: 0 });
  });
});

describe('revealFrames', () => {
  const three: ChatMessage[] = [
    { from: 'user', text: 'a' },
    { from: 'assistant', text: 'b' },
    { from: 'assistant', text: 'c' },
  ];

  it('staggers evenly from the start frame when no message pins a time', () => {
    expect(revealFrames(three, FPS, 20, 100)).toEqual([100, 120, 140]);
  });

  it('honours an explicit `at`, in seconds relative to the start frame', () => {
    const msgs: ChatMessage[] = [{ from: 'user', text: 'a' }, { from: 'assistant', text: 'b', at: 3 }];
    expect(revealFrames(msgs, FPS, 20, 0)).toEqual([0, 90]);
  });

  it('continues the stagger from a pinned message, not from the original clock', () => {
    const msgs: ChatMessage[] = [
      { from: 'user', text: 'a' },
      { from: 'assistant', text: 'b', at: 3 },
      { from: 'assistant', text: 'c' },
    ];
    expect(revealFrames(msgs, FPS, 20, 0)).toEqual([0, 90, 110]);
  });

  it('clamps a backwards `at` forward instead of reordering the thread', () => {
    const msgs: ChatMessage[] = [
      { from: 'user', text: 'a', at: 5 },
      { from: 'assistant', text: 'b', at: 1 },
    ];
    const r = revealFrames(msgs, FPS, 20, 0);
    expect(r[1]).toBeGreaterThanOrEqual(r[0]);
    expect(r).toEqual([150, 150]);
  });

  it('is non-decreasing for any input', () => {
    const msgs: ChatMessage[] = [
      { from: 'user', text: 'a' },
      { from: 'assistant', text: 'b', at: 0 },
      { from: 'assistant', text: 'c', at: 0.1 },
      { from: 'assistant', text: 'd' },
    ];
    const r = revealFrames(msgs, FPS, 25, 10);
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThanOrEqual(r[i - 1]);
  });
});

describe('scrollOffset', () => {
  const msgs: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
    from: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `message number ${i} with a little more text so it takes real height`,
  }));
  const layout = layoutThread(msgs);
  const reveals = revealFrames(msgs, FPS, 20, 0);

  it('does not scroll while the revealed content still fits', () => {
    expect(scrollOffset(layout, reveals, 0, 10_000)).toBe(0);
    expect(scrollOffset(layout, reveals, reveals[1], 10_000)).toBe(0);
  });

  it('scrolls so the newest revealed block’s bottom sits at the viewport bottom', () => {
    const viewport = 120;
    const frame = reveals[7] + 100; // well past the last reveal, fully settled
    const b = layout.blocks[7];
    expect(scrollOffset(layout, reveals, frame, viewport)).toBeCloseTo(
      b.top + b.height - viewport,
      5,
    );
  });

  it('never scrolls to a negative offset', () => {
    for (let f = 0; f < 400; f += 7) {
      expect(scrollOffset(layout, reveals, f, 500)).toBeGreaterThanOrEqual(0);
    }
  });

  it('eases between two resting offsets across the reveal window, monotonically', () => {
    const viewport = 120;
    const at = reveals[6];
    const a = scrollOffset(layout, reveals, at, viewport, 12);
    const mid = scrollOffset(layout, reveals, at + 6, viewport, 12);
    const b = scrollOffset(layout, reveals, at + 12, viewport, 12);
    expect(mid).toBeGreaterThan(a);
    expect(b).toBeGreaterThan(mid);
  });

  it('returns 0 before anything is revealed', () => {
    expect(scrollOffset(layout, revealFrames(msgs, FPS, 20, 50), 0, 100)).toBe(0);
  });
});

describe('resolveActiveStep — the conversation schedule', () => {
  const sched = [
    { at: 0, i: 0 },
    { at: 4, i: 1 },
    { at: 9, i: 2 },
  ];

  it('reads a plain number as a fixed index that never changes', () => {
    expect(resolveActiveStep(2, FPS, 0)).toEqual({ i: 2, since: 0 });
    expect(resolveActiveStep(2, FPS, 500)).toEqual({ i: 2, since: 0 });
  });

  it('returns the fallback when there is no schedule at all', () => {
    expect(resolveActiveStep(undefined, FPS, 100, 0)).toEqual({ i: 0, since: 0 });
    expect(resolveActiveStep(undefined, FPS, 100)).toEqual({ i: -1, since: 0 });
  });

  it('steps through the schedule and reports the frame each step began on', () => {
    expect(resolveActiveStep(sched, FPS, 0, 0)).toEqual({ i: 0, since: 0 });
    expect(resolveActiveStep(sched, FPS, 119, 0)).toEqual({ i: 0, since: 0 });
    expect(resolveActiveStep(sched, FPS, 120, 0)).toEqual({ i: 1, since: 120 });
    expect(resolveActiveStep(sched, FPS, 269, 0)).toEqual({ i: 1, since: 120 });
    expect(resolveActiveStep(sched, FPS, 270, 0)).toEqual({ i: 2, since: 270 });
  });

  it('sorts an out-of-order schedule rather than trusting array order', () => {
    const jumbled = [
      { at: 9, i: 2 },
      { at: 0, i: 0 },
      { at: 4, i: 1 },
    ];
    for (const f of [0, 60, 120, 200, 270, 400]) {
      expect(resolveActiveStep(jumbled, FPS, f, 0)).toEqual(resolveActiveStep(sched, FPS, f, 0));
    }
  });

  it('holds the fallback before the first step when that step is not at zero', () => {
    expect(resolveActiveStep([{ at: 2, i: 1 }], FPS, 0, 0)).toEqual({ i: 0, since: 0 });
    expect(resolveActiveStep([{ at: 2, i: 1 }], FPS, 60, 0)).toEqual({ i: 1, since: 60 });
  });

  it('restarts a conversation’s reveals from the frame it took over', () => {
    // the load-bearing behaviour: message reveals are computed off `since`,
    // so a switched-to conversation plays from its own zero rather than
    // appearing already fully built.
    const step = resolveActiveStep(sched, FPS, 200, 0);
    const msgs: ChatMessage[] = [
      { from: 'user', text: 'a' },
      { from: 'assistant', text: 'b' },
    ];
    expect(revealFrames(msgs, FPS, 20, step.since)).toEqual([120, 140]);
  });
});
