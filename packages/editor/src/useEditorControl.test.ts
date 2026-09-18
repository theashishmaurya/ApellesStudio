// @apelles/editor — unit tests for `useEditorControl.ts`'s pure DTO
// serializers. `timelineDto` is exported (test-only) for exactly this: it is
// the one function `editor_get_timeline` (both MCP surfaces are pure
// proxies over it — `mcp/server.py`'s `get_timeline`, `crates/apelles-mcp/
// src/tools/edit.rs`'s `get_timeline`) hands its response through, so a bug
// in its field list is a bug every caller — human or agent — hits the same
// way.
import { describe, expect, it } from 'vitest';
import { timelineDto } from './useEditorControl';
import type { Clip, Timeline } from './timeline';

function clip(id: string, name: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name,
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

describe('timelineDto (B-203)', () => {
  it('reports a clip\'s box_width/box_height override under boxWidth/boxHeight', () => {
    const before = tl([clip('a', 'A', { box_width: 0.5, box_height: 0.35 })]);
    const c = timelineDto(before).tracks[0].clips[0];
    expect(c.boxWidth).toBe(0.5);
    expect(c.boxHeight).toBe(0.35);
  });

  it('reports null (not 0/1, not omitted) for a clip with no override, matching every other nullable field on this DTO', () => {
    const before = tl([clip('a', 'A')]);
    const c = timelineDto(before).tracks[0].clips[0] as Record<string, unknown>;
    expect(c).toHaveProperty('boxWidth');
    expect(c).toHaveProperty('boxHeight');
    expect(c.boxWidth).toBeNull();
    expect(c.boxHeight).toBeNull();
  });

  it('reports an explicitly-cleared override (Rust/TS null, e.g. after clear_box_width) as null, not 0/1', () => {
    const before = tl([clip('a', 'A', { box_width: null, box_height: null })]);
    const c = timelineDto(before).tracks[0].clips[0];
    expect(c.boxWidth).toBeNull();
    expect(c.boxHeight).toBeNull();
  });

  it('reports one axis overridden and the other left to derive from scale independently (D-193)', () => {
    const before = tl([clip('a', 'A', { box_width: 1, box_height: null })]);
    const c = timelineDto(before).tracks[0].clips[0];
    expect(c.boxWidth).toBe(1);
    expect(c.boxHeight).toBeNull();
  });
});
