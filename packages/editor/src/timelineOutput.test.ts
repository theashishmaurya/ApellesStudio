/**
 * D-411 Phase 0 — a timeline's own output size and provenance, at the model
 * layer: the one size check (an exact mirror of `apelles_timeline::OutputSpec::
 * new`), the `set_timeline_output` / `set_timeline_name` ops (no-ops on bad or
 * unchanged values, so they never push an empty undo step), their undo labels,
 * the edit journal replaying them (B-274/D-402: a killed page loses nothing),
 * and the document shape a pre-D-411 timeline keeps (no new keys appear).
 */
import { describe, expect, it } from 'vitest';

import {
  applyOp,
  checkTimelineOutput,
  labelForOp,
  OUTPUT_MAX_EDGE,
  OUTPUT_MIN_EDGE,
  TIMELINE_OUTPUT_PRESETS,
  type Timeline,
} from './timeline';
import { replayJournal } from './editJournal';

function longForm(): Timeline {
  return { id: 'long', name: 'Long-form', rate: { num: 30, den: 1 }, tracks: [], markers: [] };
}

describe('checkTimelineOutput', () => {
  it('accepts every preset the size menus offer', () => {
    for (const p of TIMELINE_OUTPUT_PRESETS) {
      expect(checkTimelineOutput(p.width, p.height)).toEqual({ ok: true, output: { width: p.width, height: p.height } });
    }
  });

  it('refuses odd, fractional, tiny and huge edges by name, as the Rust check does', () => {
    const odd = checkTimelineOutput(1081, 1920);
    expect(odd.ok).toBe(false);
    if (!odd.ok) expect(odd.error).toBe('output width must be even (4:2:0 video cannot encode an odd width), got 1081');
    const oddH = checkTimelineOutput(1080, 1919);
    if (!oddH.ok) expect(oddH.error).toContain('output height must be even');
    expect(checkTimelineOutput(1080.5, 1920).ok).toBe(false);
    expect(checkTimelineOutput(OUTPUT_MIN_EDGE - 2, 1920).ok).toBe(false);
    expect(checkTimelineOutput(1920, OUTPUT_MAX_EDGE + 2).ok).toBe(false);
    expect(checkTimelineOutput('1080', '1920')).toEqual({ ok: true, output: { width: 1080, height: 1920 } });
    expect(checkTimelineOutput(undefined, 1920).ok).toBe(false);
  });
});

describe('set_timeline_output', () => {
  it('sets, changes and clears the override, and is a no-op otherwise', () => {
    const tl = longForm();
    const set = applyOp(tl, { kind: 'set_timeline_output', output: { width: 1080, height: 1920 } });
    expect(set.output).toEqual({ width: 1080, height: 1920 });
    expect(tl.output).toBeUndefined(); // pure: the input is untouched

    expect(applyOp(set, { kind: 'set_timeline_output', output: { width: 1080, height: 1920 } })).toBe(set);
    expect(applyOp(set, { kind: 'set_timeline_output', output: { width: 1081, height: 1920 } })).toBe(set);

    const cleared = applyOp(set, { kind: 'set_timeline_output', output: null });
    // Cleared by deleting the key — the one spelling Rust writes for `None`.
    expect('output' in cleared).toBe(false);
    expect(applyOp(cleared, { kind: 'set_timeline_output', output: null })).toBe(cleared);
  });

  it('labels the undo step with what changed', () => {
    const tl = longForm();
    expect(labelForOp({ kind: 'set_timeline_output', output: { width: 1080, height: 1350 } }, tl)).toBe(
      'Set timeline size to 1080×1350',
    );
    expect(labelForOp({ kind: 'set_timeline_output', output: null }, tl)).toBe('Use project size for timeline');
  });
});

describe('set_timeline_name', () => {
  it('trims, and refuses an empty or unchanged name as a no-op', () => {
    const tl = longForm();
    const renamed = applyOp(tl, { kind: 'set_timeline_name', name: '  Short 1 ' });
    expect(renamed.name).toBe('Short 1');
    expect(applyOp(renamed, { kind: 'set_timeline_name', name: 'Short 1' })).toBe(renamed);
    expect(applyOp(renamed, { kind: 'set_timeline_name', name: '   ' })).toBe(renamed);
    expect(labelForOp({ kind: 'set_timeline_name', name: ' Short 1 ' }, tl)).toBe('Rename timeline to "Short 1"');
  });
});

describe('the edit journal replays the new ops', () => {
  it('restores a resize and a rename a killed page had not saved yet', () => {
    const base = longForm();
    const out = replayJournal(base, {
      savedSeq: 3,
      entries: [
        { seq: 4, timelineId: 'long', kind: 'op', op: { kind: 'set_timeline_output', output: { width: 1080, height: 1920 } } },
        { seq: 5, timelineId: 'long', kind: 'op', op: { kind: 'set_timeline_name', name: 'Vertical cut' } },
        // An entry for a different timeline is not this timeline's to replay.
        { seq: 6, timelineId: 'other', kind: 'op', op: { kind: 'set_timeline_name', name: 'nope' } },
      ],
    });
    expect(out.applied).toBe(2);
    expect(out.timeline.output).toEqual({ width: 1080, height: 1920 });
    expect(out.timeline.name).toBe('Vertical cut');
  });
});

describe('provenance', () => {
  it('rides through any op untouched, and a pre-D-411 timeline gains no keys', () => {
    const built: Timeline = {
      ...longForm(),
      origin: {
        kind: 'clip_short',
        run_id: 'run-1',
        proposal_id: 'p-1',
        source: { media_id: 'm-1' },
        segments: [{ source_path: '/a.mov', start_s: 1, end_s: 9, role: 'body' }],
      },
    };
    const renamed = applyOp(built, { kind: 'set_timeline_name', name: 'Short' });
    expect(renamed.origin).toEqual(built.origin);

    const old = longForm();
    const touched = applyOp(old, { kind: 'set_timeline_name', name: 'Renamed' });
    expect(Object.keys(touched).sort()).toEqual(Object.keys(old).sort());
  });
});
