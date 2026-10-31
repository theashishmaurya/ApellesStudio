// @apelles/editor — D-235, roadmap item 27. Two things are under test here:
//
//   1. `trimMode.ts` — the pure mode resolution ("given this pointer position
//      and these modifiers, which of the six drags is this?") and the op it
//      builds. This is the piece the feature's whole claim rests on, so every
//      branch of the rule is asserted, including the unarmed ones that must
//      keep meaning what they meant before D-235.
//   2. The three new/extended `EditOp`s in `timeline.ts` — `roll`, `slide`, and
//      `trim_start`/`trim_end`'s new `ripple` flag — asserted as real
//      before/after timelines, the same way D-058 and D-195 assert theirs.
//
// The real-DOM pointer-drag tests that prove the gestures actually reach these
// ops through `TimelinePane` live in `TimelinePane.trim.dom.test.tsx`.
import { describe, expect, it } from 'vitest';
import { shortcutById } from '@apelles/keymap';
import { applyOp, endFrame, labelForOp, timelineFps, type Clip, type Timeline } from './timeline';
import {
  edgeIsEditPoint,
  outgoingClipAt,
  resolveTrimMode,
  trimModeLabel,
  trimOpFor,
  trimToolOwns,
  TRIM_TOOLS,
  type TrimGesture,
  type TrimTool,
} from './trimMode';

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 100,
    source_len: 100,
    start_frame: 0,
    ...overrides,
  };
}

function tl(clips: Clip[]): Timeline {
  return { id: 't1', name: 'Timeline', tracks: [{ kind: 'video', clips }] };
}

/** Three clips butted end to end, each with source room on BOTH sides so any
 *  of the four smart-trim modes has somewhere to go: a 100-frame window taken
 *  from the middle of a 300-frame source. */
function threeUp(): Timeline {
  return tl([
    clip('a', { start_frame: 0, source_start: 100, duration: 100, source_len: 300 }),
    clip('b', { start_frame: 100, source_start: 100, duration: 100, source_len: 300 }),
    clip('c', { start_frame: 200, source_start: 100, duration: 100, source_len: 300 }),
  ]);
}

function at(tlx: Timeline, id: string): Clip {
  const c = tlx.tracks[0].clips.find((x) => x.id === id);
  if (!c) throw new Error(`no clip ${id}`);
  return c;
}

/** D-261 added `tool` to the gesture. It defaults to `'select'` here so every
 *  pre-D-261 assertion below still reads as what it always asserted: the
 *  Selection tool's behaviour, which is the one the palette must not change. */
function gesture(overrides: Partial<TrimGesture> = {}): TrimGesture {
  return {
    zone: 'body',
    tool: 'select',
    altKey: false,
    shiftKey: false,
    atEditPoint: false,
    bodyYRatio: 0.5,
    ...overrides,
  };
}

// --------------------------------------------------------------------------- //
// 1. mode resolution
// --------------------------------------------------------------------------- //

describe('resolveTrimMode — unarmed gestures are exactly what they were before D-235', () => {
  it('a body drag with no modifier is still a move', () => {
    expect(resolveTrimMode(gesture({ zone: 'body' }))).toBe('move');
    // …at every height in the row: the slip/slide band only exists once armed.
    expect(resolveTrimMode(gesture({ zone: 'body', bodyYRatio: 0 }))).toBe('move');
    expect(resolveTrimMode(gesture({ zone: 'body', bodyYRatio: 1 }))).toBe('move');
  });

  it('an edge drag with no modifier is still a plain trim, edit point or not', () => {
    expect(resolveTrimMode(gesture({ zone: 'edge-start' }))).toBe('trim');
    expect(resolveTrimMode(gesture({ zone: 'edge-end' }))).toBe('trim');
    expect(resolveTrimMode(gesture({ zone: 'edge-end', atEditPoint: true }))).toBe('trim');
  });

  it('Shift alone never arms anything (it is the range-select modifier)', () => {
    expect(resolveTrimMode(gesture({ zone: 'edge-end', shiftKey: true, atEditPoint: true }))).toBe('trim');
    expect(resolveTrimMode(gesture({ zone: 'body', shiftKey: true, bodyYRatio: 0.1 }))).toBe('move');
  });
});

describe('resolveTrimMode — armed, the mode comes from the pointer position', () => {
  it('upper half of the body is a slip, lower half is a slide', () => {
    expect(resolveTrimMode(gesture({ zone: 'body', altKey: true, bodyYRatio: 0 }))).toBe('slip');
    expect(resolveTrimMode(gesture({ zone: 'body', altKey: true, bodyYRatio: 0.49 }))).toBe('slip');
    expect(resolveTrimMode(gesture({ zone: 'body', altKey: true, bodyYRatio: 0.5 }))).toBe('slide');
    expect(resolveTrimMode(gesture({ zone: 'body', altKey: true, bodyYRatio: 1 }))).toBe('slide');
  });

  it('an edge that is a real edit point rolls; a free edge ripples', () => {
    expect(resolveTrimMode(gesture({ zone: 'edge-end', altKey: true, atEditPoint: true }))).toBe('roll');
    expect(resolveTrimMode(gesture({ zone: 'edge-start', altKey: true, atEditPoint: true }))).toBe('roll');
    expect(resolveTrimMode(gesture({ zone: 'edge-end', altKey: true, atEditPoint: false }))).toBe('ripple');
    expect(resolveTrimMode(gesture({ zone: 'edge-start', altKey: true, atEditPoint: false }))).toBe('ripple');
  });

  it('Shift forces a ripple at an edit point, where roll would otherwise win', () => {
    expect(resolveTrimMode(gesture({ zone: 'edge-end', altKey: true, shiftKey: true, atEditPoint: true }))).toBe(
      'ripple',
    );
    expect(resolveTrimMode(gesture({ zone: 'edge-start', altKey: true, shiftKey: true, atEditPoint: true }))).toBe(
      'ripple',
    );
  });

  it('Shift on the body does not change the slip/slide band', () => {
    expect(resolveTrimMode(gesture({ zone: 'body', altKey: true, shiftKey: true, bodyYRatio: 0.2 }))).toBe('slip');
    expect(resolveTrimMode(gesture({ zone: 'body', altKey: true, shiftKey: true, bodyYRatio: 0.8 }))).toBe('slide');
  });
});

// --------------------------------------------------------------------------- //
// 1b. the trim-tool palette (D-261)
// --------------------------------------------------------------------------- //

describe('TRIM_TOOLS — the palette itself', () => {
  it('is Adobe’s five tools, Selection first, then the Blade (D-432 P2)', () => {
    expect(TRIM_TOOLS.map((t) => t.tool)).toEqual(['select', 'ripple', 'roll', 'slip', 'slide', 'blade']);
  });

  it('links each tool to its registry action, all distinct', () => {
    // D-273 — the LETTER is no longer stored here; the palette points at
    // `@apelles/keymap` action ids and the registry owns the binding, so the
    // toolbar tooltip and the key that actually fires cannot drift apart (and
    // a user rebind shows up in both).
    expect(TRIM_TOOLS.map((t) => t.shortcutId)).toEqual([
      'edit.tool_select',
      'edit.tool_ripple',
      'edit.tool_roll',
      'edit.tool_slip',
      'edit.tool_slide',
      'edit.tool_blade',
    ]);
    expect(new Set(TRIM_TOOLS.map((t) => t.shortcutId)).size).toBe(TRIM_TOOLS.length);
  });

  it('is bound to Adobe’s V/B/Y/U, T for Roll and C (Premiere’s Razor) by default', () => {
    // V/B/Y/U, quoted from Adobe's own help pages in
    // `scratch/premiere-tools-reference/premiere-tools-panel.json`. Asserted
    // against the registry now that it is the one place the letters live.
    // D-432 P3: Roll moved off Premiere's N to T (Final Cut's Trim tool and
    // Resolve's Trim Edit mode) when N became Final Cut's snapping toggle.
    expect(
      TRIM_TOOLS.map((t) => shortcutById(t.shortcutId)?.defaultCombo),
    ).toEqual([['KeyV'], ['KeyB'], ['KeyT'], ['KeyY'], ['KeyU'], ['KeyC']]);
    expect(shortcutById('edit.toggle_snapping')?.defaultCombo).toEqual(['KeyN']);
    expect(shortcutById('edit.toggle_skimming')?.defaultCombo).toEqual(['KeyS']);
  });

  it('gives every tool a label and a blurb, so nothing renders blank', () => {
    for (const t of TRIM_TOOLS) {
      expect(t.label.length, `${t.tool} has no label`).toBeGreaterThan(0);
      expect(t.blurb.length, `${t.tool} has no blurb`).toBeGreaterThan(0);
    }
  });

  it('owns the zones each reference actually edits in: edges for ripple/roll, the whole clip for slip/slide', () => {
    expect(trimToolOwns('ripple', 'edge-start')).toBe(true);
    expect(trimToolOwns('ripple', 'edge-end')).toBe(true);
    expect(trimToolOwns('ripple', 'body')).toBe(false);
    expect(trimToolOwns('roll', 'body')).toBe(false);
    expect(trimToolOwns('slip', 'body')).toBe(true);
    expect(trimToolOwns('slip', 'edge-end')).toBe(true);
    expect(trimToolOwns('slide', 'body')).toBe(true);
    // Select owns nothing — it is what every other tool falls back TO.
    expect(trimToolOwns('select', 'body')).toBe(false);
    expect(trimToolOwns('select', 'edge-start')).toBe(false);
    // The Blade cuts; it owns no trim zone, and a press never resolves to its tool.
    expect(trimToolOwns('blade', 'body')).toBe(false);
    expect(resolveTrimMode(gesture({ tool: 'blade', zone: 'body' }))).toBe('move');
  });

  it('does not collide with the pane’s other shortcuts', () => {
    // D-273 — `trimToolForKey` is gone (the dispatcher resolves the key), so
    // what is worth pinning is that the palette has not quietly taken a combo
    // another Edit-tab action already owns. `M` is this pane's marker key.
    const toolCombos = new Set(
      TRIM_TOOLS.map((t) => shortcutById(t.shortcutId)!.defaultCombo.join('+')),
    );
    expect(toolCombos.has(shortcutById('edit.add_marker')!.defaultCombo.join('+'))).toBe(false);
    expect(toolCombos.has(shortcutById('edit.play_pause')!.defaultCombo.join('+'))).toBe(false);
  });
});

describe('resolveTrimMode — an explicit tool decides alone (D-261)', () => {
  it('each tool names its own edit in the zones it owns', () => {
    expect(resolveTrimMode(gesture({ tool: 'ripple', zone: 'edge-end' }))).toBe('ripple');
    expect(resolveTrimMode(gesture({ tool: 'ripple', zone: 'edge-start' }))).toBe('ripple');
    expect(resolveTrimMode(gesture({ tool: 'roll', zone: 'edge-end' }))).toBe('roll');
    expect(resolveTrimMode(gesture({ tool: 'slip', zone: 'body' }))).toBe('slip');
    expect(resolveTrimMode(gesture({ tool: 'slide', zone: 'body' }))).toBe('slide');
    // Slip and Slide own the edge bands too — they are part of the clip, and
    // grabbing one with Slip chosen must not fall back to a destructive trim.
    expect(resolveTrimMode(gesture({ tool: 'slip', zone: 'edge-start' }))).toBe('slip');
    expect(resolveTrimMode(gesture({ tool: 'slide', zone: 'edge-end' }))).toBe('slide');
  });

  it('falls back to the plain gesture in a zone the tool does not own', () => {
    // The reason Ripple/Roll do not own the body: repositioning a clip must
    // keep working while a trim tool is selected.
    expect(resolveTrimMode(gesture({ tool: 'ripple', zone: 'body' }))).toBe('move');
    expect(resolveTrimMode(gesture({ tool: 'roll', zone: 'body' }))).toBe('move');
  });

  it('IGNORES every input the Alt heuristic reads — that is what makes it deterministic', () => {
    // The owner's actual ask: the same drag on the same pixel always commits
    // the same edit once a tool is chosen. So none of the four heuristic
    // inputs may change the answer.
    for (const altKey of [false, true]) {
      for (const shiftKey of [false, true]) {
        for (const bodyYRatio of [0, 0.25, 0.5, 0.75, 1]) {
          expect(resolveTrimMode(gesture({ tool: 'slip', zone: 'body', altKey, shiftKey, bodyYRatio }))).toBe('slip');
          expect(resolveTrimMode(gesture({ tool: 'slide', zone: 'body', altKey, shiftKey, bodyYRatio }))).toBe('slide');
        }
        for (const atEditPoint of [false, true]) {
          // Under Alt, an edit point resolves to Roll and Shift forces Ripple.
          // With a tool chosen, neither has any say.
          expect(resolveTrimMode(gesture({ tool: 'ripple', zone: 'edge-end', altKey, shiftKey, atEditPoint }))).toBe(
            'ripple',
          );
          expect(resolveTrimMode(gesture({ tool: 'roll', zone: 'edge-end', altKey, shiftKey, atEditPoint }))).toBe(
            'roll',
          );
        }
      }
    }
  });

  it('leaves the Selection tool as the exact pre-D-261 surface, armed or not', () => {
    // The regression that matters most: adding a palette must not re-map a
    // single gesture anyone already has in their fingers.
    expect(resolveTrimMode(gesture({ tool: 'select', zone: 'body' }))).toBe('move');
    expect(resolveTrimMode(gesture({ tool: 'select', zone: 'edge-end' }))).toBe('trim');
    expect(resolveTrimMode(gesture({ tool: 'select', zone: 'body', altKey: true, bodyYRatio: 0.2 }))).toBe('slip');
    expect(resolveTrimMode(gesture({ tool: 'select', zone: 'body', altKey: true, bodyYRatio: 0.8 }))).toBe('slide');
    expect(resolveTrimMode(gesture({ tool: 'select', zone: 'edge-end', altKey: true, atEditPoint: true }))).toBe('roll');
    expect(resolveTrimMode(gesture({ tool: 'select', zone: 'edge-end', altKey: true, atEditPoint: false }))).toBe(
      'ripple',
    );
  });
});

describe('edgeIsEditPoint / outgoingClipAt', () => {
  const t = threeUp();

  it('sees a butted neighbour on each side', () => {
    expect(edgeIsEditPoint(t, 0, 1, 'start')).toBe(true);
    expect(edgeIsEditPoint(t, 0, 1, 'end')).toBe(true);
  });

  it('does not see one at the head of the track or past the last clip', () => {
    expect(edgeIsEditPoint(t, 0, 0, 'start')).toBe(false);
    expect(edgeIsEditPoint(t, 0, 2, 'end')).toBe(false);
  });

  it('does not see one across a gap', () => {
    const gapped = tl([clip('a', { start_frame: 0 }), clip('b', { start_frame: 150 })]);
    expect(edgeIsEditPoint(gapped, 0, 0, 'end')).toBe(false);
    expect(edgeIsEditPoint(gapped, 0, 1, 'start')).toBe(false);
  });

  it('finds the outgoing clip by POSITION, not by array order', () => {
    // Same three clips, stored in a deliberately scrambled order (D-054:
    // storage order is not time order).
    const scrambled = tl([at(threeUp(), 'c'), at(threeUp(), 'a'), at(threeUp(), 'b')]);
    // clip index 0 is "c" at frame 200; the clip ending there is "b", index 2.
    expect(outgoingClipAt(scrambled, 0, 0)).toBe(2);
    expect(outgoingClipAt(scrambled, 0, 1)).toBe(null); // "a" starts the track
  });
});

describe('trimOpFor', () => {
  const t = threeUp();

  it('builds the plain trims for an unarmed edge drag', () => {
    expect(trimOpFor('trim', { tl: t, track: 0, clip: 1, edge: 'start', delta: 5 })).toEqual({
      kind: 'trim_start',
      track: 0,
      clip: 1,
      delta: 5,
    });
    expect(trimOpFor('trim', { tl: t, track: 0, clip: 1, edge: 'end', delta: -5 })).toEqual({
      kind: 'trim_end',
      track: 0,
      clip: 1,
      delta: -5,
    });
  });

  it('builds the SAME trims with ripple set, rather than a separate op kind', () => {
    expect(trimOpFor('ripple', { tl: t, track: 0, clip: 1, edge: 'end', delta: 7 })).toEqual({
      kind: 'trim_end',
      track: 0,
      clip: 1,
      delta: 7,
      ripple: true,
    });
  });

  it('redirects a roll grabbed at a clip START to the OUTGOING clip', () => {
    // Grabbing clip "b"'s left edge rolls the b/a edit point, which `roll`
    // addresses by its outgoing side — clip "a", index 0.
    expect(trimOpFor('roll', { tl: t, track: 0, clip: 1, edge: 'start', delta: 4 })).toEqual({
      kind: 'roll',
      track: 0,
      clip: 0,
      delta: 4,
    });
    // Grabbing the same clip's right edge already names the outgoing clip.
    expect(trimOpFor('roll', { tl: t, track: 0, clip: 1, edge: 'end', delta: 4 })).toEqual({
      kind: 'roll',
      track: 0,
      clip: 1,
      delta: 4,
    });
  });

  it('has no op for a move (the dnd-kit drop path builds that one)', () => {
    expect(trimOpFor('move', { tl: t, track: 0, clip: 1, edge: 'end', delta: 4 })).toBe(null);
  });

  it('labels only the four armed modes', () => {
    expect(trimModeLabel('ripple')).toBe('Ripple');
    expect(trimModeLabel('roll')).toBe('Roll');
    expect(trimModeLabel('slip')).toBe('Slip');
    expect(trimModeLabel('slide')).toBe('Slide');
    expect(trimModeLabel('move')).toBe(null);
    expect(trimModeLabel('trim')).toBe(null);
  });
});

describe('ripple trim', () => {
  it('shortening a tail pulls every later clip in by the same amount', () => {
    const before = threeUp();
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: -20, ripple: true });
    expect(at(after, 'a').duration).toBe(80);
    expect(at(after, 'a').start_frame).toBe(0);
    // …and no gap is left behind: b and c both moved up by 20.
    expect(at(after, 'b').start_frame).toBe(80);
    expect(at(after, 'c').start_frame).toBe(180);
  });

  it('extending a tail pushes every later clip down, THROUGH the neighbour a plain trim would refuse to cross', () => {
    const before = threeUp();
    const plain = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 30 });
    // The plain trim is blocked flat by b sitting at frame 100 — this is the
    // pre-D-235 behaviour, and it must be untouched.
    expect(plain).toBe(before);
    const rippled = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 30, ripple: true });
    expect(at(rippled, 'a').duration).toBe(130);
    expect(at(rippled, 'b').start_frame).toBe(130);
    expect(at(rippled, 'c').start_frame).toBe(230);
  });

  it('a head ripple holds start_frame still and pulls the rest in — the plain one opens a gap instead', () => {
    const before = threeUp();
    const plain = applyOp(before, { kind: 'trim_start', track: 0, clip: 1, delta: 20 });
    expect(at(plain, 'b').start_frame).toBe(120); // a real gap at [100,120)
    expect(at(plain, 'c').start_frame).toBe(200); // …and c does not move

    const rippled = applyOp(before, { kind: 'trim_start', track: 0, clip: 1, delta: 20, ripple: true });
    expect(at(rippled, 'b').start_frame).toBe(100); // no gap before b
    expect(at(rippled, 'b').duration).toBe(80);
    expect(at(rippled, 'b').source_start).toBe(120); // the head really was trimmed
    expect(at(rippled, 'c').start_frame).toBe(180); // …and c closed up behind it
  });

  it('keeps the total timeline length changing by exactly the trim (that is what makes it a ripple, not a roll)', () => {
    const before = threeUp();
    const fps = timelineFps(before);
    const lenBefore = endFrame(at(before, 'c'), fps);
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 1, delta: -25, ripple: true });
    expect(endFrame(at(after, 'c'), fps)).toBe(lenBefore - 25);
  });

  it('still clamps to the source media, and is a no-op when there is no room', () => {
    // A clip already showing its whole source cannot ripple-extend.
    const before = tl([clip('a', { start_frame: 0, source_start: 0, duration: 100, source_len: 100 })]);
    expect(applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 50, ripple: true })).toBe(before);
    // …but it can still ripple-shorten.
    const shorter = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: -50, ripple: true });
    expect(at(shorter, 'a').duration).toBe(50);
  });

  it('refuses on a locked track, like every other per-clip op', () => {
    const before = threeUp();
    before.tracks[0].locked = true;
    expect(applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: -10, ripple: true })).toBe(before);
  });

  it('ripples a sync-locked track alongside, and refuses when a clip straddles the ripple point (B-033)', () => {
    const synced: Timeline = {
      id: 't',
      name: 'T',
      tracks: [
        { kind: 'video', clips: [clip('a', { start_frame: 0 }), clip('b', { start_frame: 100 })] },
        { kind: 'audio', sync_locked: true, clips: [clip('m', { start_frame: 100 })] },
      ],
    };
    const after = applyOp(synced, { kind: 'trim_end', track: 0, clip: 0, delta: -20, ripple: true });
    expect(after.tracks[1].clips[0].start_frame).toBe(80);

    const straddling: Timeline = {
      id: 't',
      name: 'T',
      tracks: [
        { kind: 'video', clips: [clip('a', { start_frame: 0 }), clip('b', { start_frame: 100 })] },
        { kind: 'audio', sync_locked: true, clips: [clip('bed', { start_frame: 50, duration: 200, source_len: 200 })] },
      ],
    };
    expect(applyOp(straddling, { kind: 'trim_end', track: 0, clip: 0, delta: -20, ripple: true })).toBe(straddling);
  });

  it('ripple-trims an A/V linked pair in lockstep', () => {
    const linked: Timeline = {
      id: 't',
      name: 'T',
      tracks: [
        { kind: 'video', clips: [clip('v', { start_frame: 0, link_group: 'g' }), clip('v2', { start_frame: 100 })] },
        { kind: 'audio', clips: [clip('a', { start_frame: 0, link_group: 'g' })] },
      ],
    };
    const after = applyOp(linked, { kind: 'trim_end', track: 0, clip: 0, delta: -30, ripple: true });
    expect(after.tracks[0].clips[0].duration).toBe(70);
    expect(after.tracks[1].clips[0].duration).toBe(70);
  });
});

describe('roll', () => {
  it('moves both sides of the edit point and leaves the sequence length untouched', () => {
    const before = threeUp();
    const fps = timelineFps(before);
    const lenBefore = endFrame(at(before, 'c'), fps);
    const after = applyOp(before, { kind: 'roll', track: 0, clip: 0, delta: 25 });
    // a's out point moved later…
    expect(at(after, 'a').duration).toBe(125);
    expect(at(after, 'a').start_frame).toBe(0);
    // …b's in point moved with it by the same 25, and b's END did not move.
    expect(at(after, 'b').start_frame).toBe(125);
    expect(at(after, 'b').duration).toBe(75);
    expect(at(after, 'b').source_start).toBe(125);
    expect(endFrame(at(after, 'b'), fps)).toBe(200);
    // …c never moved, and the timeline is exactly as long as it was.
    expect(at(after, 'c').start_frame).toBe(200);
    expect(endFrame(at(after, 'c'), fps)).toBe(lenBefore);
  });

  it('rolls the other way too', () => {
    const after = applyOp(threeUp(), { kind: 'roll', track: 0, clip: 1, delta: -40 });
    expect(at(after, 'b').duration).toBe(60);
    expect(at(after, 'c').start_frame).toBe(160);
    expect(at(after, 'c').duration).toBe(140);
    expect(at(after, 'c').source_start).toBe(60);
  });

  it('is a no-op where there is no edit point — a gap, or the end of the track', () => {
    const gapped = tl([clip('a', { start_frame: 0 }), clip('b', { start_frame: 150 })]);
    expect(applyOp(gapped, { kind: 'roll', track: 0, clip: 0, delta: 10 })).toBe(gapped);
    const t = threeUp();
    expect(applyOp(t, { kind: 'roll', track: 0, clip: 2, delta: 10 })).toBe(t);
  });

  it('clamps to whichever side runs out of source first', () => {
    // "a" has only 10 frames of source left past its out point; "b" has 100
    // before its in point. The roll can only be +10.
    const before = tl([
      clip('a', { start_frame: 0, source_start: 0, duration: 100, source_len: 110 }),
      clip('b', { start_frame: 100, source_start: 100, duration: 100, source_len: 300 }),
    ]);
    const after = applyOp(before, { kind: 'roll', track: 0, clip: 0, delta: 50 });
    expect(at(after, 'a').duration).toBe(110);
    expect(at(after, 'b').start_frame).toBe(110);
    expect(at(after, 'b').duration).toBe(90);
  });

  it('is a no-op when neither side can move at all', () => {
    // Both clips show their whole source: a cannot extend, b cannot extend
    // backwards, so the only legal roll would shorten one to nothing.
    const before = tl([
      clip('a', { start_frame: 0, source_start: 0, duration: 100, source_len: 100 }),
      clip('b', { start_frame: 100, source_start: 0, duration: 100, source_len: 100 }),
    ]);
    // A roll is still possible here (shortening one and lengthening the other
    // is bounded by source, and neither has spare source) — so it must refuse.
    expect(applyOp(before, { kind: 'roll', track: 0, clip: 0, delta: 20 })).toBe(before);
    expect(applyOp(before, { kind: 'roll', track: 0, clip: 0, delta: -20 })).toBe(before);
  });

  it('refuses on a locked track', () => {
    const before = threeUp();
    before.tracks[0].locked = true;
    expect(applyOp(before, { kind: 'roll', track: 0, clip: 0, delta: 10 })).toBe(before);
  });

  it('rolls both halves of an A/V linked pair on each side', () => {
    const linked: Timeline = {
      id: 't',
      name: 'T',
      tracks: [
        {
          kind: 'video',
          clips: [
            clip('v1', { start_frame: 0, source_start: 100, source_len: 300, link_group: 'g1' }),
            clip('v2', { start_frame: 100, source_start: 100, source_len: 300, link_group: 'g2' }),
          ],
        },
        {
          kind: 'audio',
          clips: [
            clip('a1', { start_frame: 0, source_start: 100, source_len: 300, link_group: 'g1' }),
            clip('a2', { start_frame: 100, source_start: 100, source_len: 300, link_group: 'g2' }),
          ],
        },
      ],
    };
    const after = applyOp(linked, { kind: 'roll', track: 0, clip: 0, delta: 30 });
    for (const track of after.tracks) {
      expect(track.clips[0].duration).toBe(130);
      expect(track.clips[1].start_frame).toBe(130);
      expect(track.clips[1].duration).toBe(70);
    }
  });
});

describe('slide', () => {
  it('moves the clip and lets both neighbours absorb it, changing nothing else', () => {
    const before = threeUp();
    const fps = timelineFps(before);
    const lenBefore = endFrame(at(before, 'c'), fps);
    const after = applyOp(before, { kind: 'slide', track: 0, clip: 1, delta: 30 });
    // b moved, but is the same length and shows the same source as before.
    expect(at(after, 'b').start_frame).toBe(130);
    expect(at(after, 'b').duration).toBe(100);
    expect(at(after, 'b').source_start).toBe(at(before, 'b').source_start);
    // a grew into the space b left…
    expect(at(after, 'a').duration).toBe(130);
    // …and c gave up the space b took, from its head, keeping its own end.
    expect(at(after, 'c').start_frame).toBe(230);
    expect(at(after, 'c').duration).toBe(70);
    expect(at(after, 'c').source_start).toBe(130);
    expect(endFrame(at(after, 'c'), fps)).toBe(lenBefore);
  });

  it('slides the other way', () => {
    const after = applyOp(threeUp(), { kind: 'slide', track: 0, clip: 1, delta: -40 });
    expect(at(after, 'a').duration).toBe(60);
    expect(at(after, 'b').start_frame).toBe(60);
    expect(at(after, 'b').duration).toBe(100);
    expect(at(after, 'c').start_frame).toBe(160);
    expect(at(after, 'c').duration).toBe(140);
  });

  it('clamps to what the neighbours can actually absorb', () => {
    // "c" has only 20 frames of source before its in point, so b can only
    // slide 20 to the LEFT (which extends c's head backwards)… and "a" only
    // has 20 frames of head to give up.
    const before = tl([
      clip('a', { start_frame: 0, source_start: 0, duration: 100, source_len: 300 }),
      clip('b', { start_frame: 100, source_start: 0, duration: 100, source_len: 300 }),
      clip('c', { start_frame: 200, source_start: 20, duration: 100, source_len: 300 }),
    ]);
    const after = applyOp(before, { kind: 'slide', track: 0, clip: 1, delta: -50 });
    expect(at(after, 'b').start_frame).toBe(80);
    expect(at(after, 'c').start_frame).toBe(180);
    expect(at(after, 'c').source_start).toBe(0);
  });

  it('works at the head of a track, clamped by free space instead of a neighbour', () => {
    const before = tl([
      clip('b', { start_frame: 100, source_start: 100, duration: 100, source_len: 300 }),
      clip('c', { start_frame: 200, source_start: 100, duration: 100, source_len: 300 }),
    ]);
    // Nothing to the left, so b may slide back at most to frame 0.
    const after = applyOp(before, { kind: 'slide', track: 0, clip: 0, delta: -500 });
    expect(at(after, 'b').start_frame).toBe(0);
    expect(at(after, 'b').duration).toBe(100);
    expect(at(after, 'c').start_frame).toBe(100);
    expect(at(after, 'c').duration).toBe(200);
  });

  it('is a no-op for a lone clip with nothing to slide between', () => {
    const alone = tl([clip('a', { start_frame: 0 })]);
    expect(applyOp(alone, { kind: 'slide', track: 0, clip: 0, delta: 20 })).toBe(alone);
  });

  it('never changes the clip it slides — that is the whole difference from a move', () => {
    const before = threeUp();
    const after = applyOp(before, { kind: 'slide', track: 0, clip: 1, delta: 30 });
    const b0 = at(before, 'b');
    const b1 = at(after, 'b');
    expect(b1.duration).toBe(b0.duration);
    expect(b1.source_start).toBe(b0.source_start);
    expect(b1.source_len).toBe(b0.source_len);
  });

  it('refuses on a locked track', () => {
    const before = threeUp();
    before.tracks[0].locked = true;
    expect(applyOp(before, { kind: 'slide', track: 0, clip: 1, delta: 10 })).toBe(before);
  });
});

describe('labelForOp for the new ops', () => {
  const before = threeUp();

  it('tells a ripple apart from a plain trim in the undo stack', () => {
    expect(labelForOp({ kind: 'trim_end', track: 0, clip: 0, delta: 5 }, before)).toBe('Trim "a" (end)');
    expect(labelForOp({ kind: 'trim_end', track: 0, clip: 0, delta: 5, ripple: true }, before)).toBe('Ripple "a" (end)');
    expect(labelForOp({ kind: 'trim_start', track: 0, clip: 0, delta: 5, ripple: true }, before)).toBe(
      'Ripple "a" (start)',
    );
  });

  it('names a roll for its edit point and a slide for its clip', () => {
    expect(labelForOp({ kind: 'roll', track: 0, clip: 0, delta: 5 }, before)).toBe('Roll edit after "a"');
    expect(labelForOp({ kind: 'slide', track: 0, clip: 1, delta: 5 }, before)).toBe('Slide "b"');
  });
});
