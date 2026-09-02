// @chroma/editor — unit tests for `labelForOp` (D-051), the pure helper that
// turns an `EditOp` into the label on the `@chroma/history` entry
// `useEditorTimelineStore.applyOp` pushes for it. Pure, no store/DOM.
import { describe, expect, it } from 'vitest';
import { labelForOp, type Clip, type Timeline } from './timeline';

function clip(id: string, name: string): Clip {
  return { id, name, source_path: `/media/${id}.mov`, source_start: 0, duration: 100, source_len: 100 };
}

function tl(clips: Clip[]): Timeline {
  return { id: 't1', name: 'Timeline', tracks: [{ kind: 'video', clips }] };
}

describe('labelForOp', () => {
  const before = tl([clip('a', 'Intro'), clip('b', 'B-roll 1')]);

  it('names the clip for reorder', () => {
    expect(labelForOp({ kind: 'reorder', track: 0, from: 0, to: 1 }, before)).toBe('Reorder "Intro"');
  });

  it('names the clip and side for trim_start / trim_end', () => {
    expect(labelForOp({ kind: 'trim_start', track: 0, clip: 1, delta: 5 }, before)).toBe('Trim "B-roll 1" (start)');
    expect(labelForOp({ kind: 'trim_end', track: 0, clip: 1, delta: -5 }, before)).toBe('Trim "B-roll 1" (end)');
  });

  it('names the clip for split and remove', () => {
    expect(labelForOp({ kind: 'split', track: 0, clip: 0, atFrame: 50 }, before)).toBe('Split "Intro"');
    expect(labelForOp({ kind: 'remove', track: 0, clip: 0 }, before)).toBe('Remove "Intro"');
  });

  it('names the dropped media for add_clip', () => {
    const op = { kind: 'add_clip' as const, track: 0, clip: clip('c', 'New shot') };
    expect(labelForOp(op, before)).toBe('Add "New shot"');
  });

  it('falls back to a generic "clip" when the referenced clip is out of range', () => {
    expect(labelForOp({ kind: 'remove', track: 0, clip: 99 }, before)).toBe('Remove clip');
  });
});
