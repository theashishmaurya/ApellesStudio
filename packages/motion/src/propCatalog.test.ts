/**
 * B-061 regression test (`docs/BUGS.md`) — the Motion Inspector's camera
 * keyframe list labelled its `at` field "At (frame)" while the manifest
 * actually stores SECONDS (`schema.ts`'s own header, `Video.tsx`'s
 * `Math.round(k.at * fps)` conversion on the way into the composition). A
 * value typed as an intended frame number (e.g. `48`) landed at 48 SECONDS
 * instead of 1.6s, silently past the end of most scenes.
 *
 * Two assertions per field group: the label now says "(s)", and the field
 * declares a sub-1 `step` so a keyboard/scrub nudge moves a fraction of a
 * second rather than a whole one (the paired precision fix the bug entry
 * asked for, the same class of defect D-136 fixed on `ClipInspectorPanel`'s
 * Position X/Y).
 */
import { describe, it, expect } from 'vitest';
import { CAM2D_KEY_FIELDS, CAM3D_KEY_FIELDS, LAYER_TRANSFORM_KEY_FIELDS } from './propCatalog';

describe('B-061 — camera keyframe `at` field is labelled in seconds, not frames', () => {
  it('CAM2D_KEY_FIELDS[0] ("at") is labelled "At (s)" with a sub-second step', () => {
    const at = CAM2D_KEY_FIELDS[0];
    expect(at.key).toBe('at');
    expect(at.label).toBe('At (s)');
    expect(at.label).not.toMatch(/frame/i);
    expect(at.step).toBeDefined();
    expect(at.step as number).toBeLessThan(1);
    expect(at.step as number).toBeGreaterThan(0);
  });

  it('CAM3D_KEY_FIELDS[0] ("at") is labelled "At (s)" with a sub-second step', () => {
    const at = CAM3D_KEY_FIELDS[0];
    expect(at.key).toBe('at');
    expect(at.label).toBe('At (s)');
    expect(at.label).not.toMatch(/frame/i);
    expect(at.step).toBeDefined();
    expect(at.step as number).toBeLessThan(1);
    expect(at.step as number).toBeGreaterThan(0);
  });

  it('every other field is untouched by the relabel (no collateral changes)', () => {
    expect(CAM2D_KEY_FIELDS.slice(1).map((f) => f.key)).toEqual(['x', 'y', 'zoom', 'ease']);
    expect(CAM3D_KEY_FIELDS.slice(1).map((f) => f.key)).toEqual(['pos', 'look', 'ease']);
  });

  it('the sibling layer-transform key `at` field already said "(s)" before this fix, unchanged', () => {
    // Not part of the B-061 repro (it never had the mislabel), asserted here
    // only so a future edit to the shared `timing` group doesn't silently
    // regress its label while "fixing" the camera fields above.
    const at = LAYER_TRANSFORM_KEY_FIELDS[0];
    expect(at.key).toBe('at');
    expect(at.label).toBe('At (s)');
  });
});
