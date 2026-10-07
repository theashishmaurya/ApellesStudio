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
import { CAM2D_KEY_FIELDS, CAM3D_KEY_FIELDS, LAYER_TRANSFORM_KEY_FIELDS, SCENE_FIELDS } from './propCatalog';

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

/**
 * B-242 — `SCENE_FIELDS` omitted `id`, which is the scene's DISPLAY NAME
 * (layer-panel section header, scene selector, `motion_render`'s per-scene
 * output filename), not an internal handle. Two things fell out of that one
 * omission, in opposite directions: the Inspector rendered no row for the
 * field that names a scene, and `motion_set_scene_field key="id"` — which
 * wrote it correctly — reported `"id" is not one of the known scene fields`,
 * because that warning is computed from this list.
 */
describe('B-242 — `id` is a known scene field', () => {
  it('SCENE_FIELDS includes `id` as an editable string, so the Inspector renders a row for it', () => {
    const id = SCENE_FIELDS.find((f) => f.key === 'id');
    expect(id).toBeDefined();
    expect(id?.kind).toBe('string');
    // The label has to read as a NAME, not as an opaque identifier — that
    // misreading is the whole of this bug.
    expect(id?.label).toMatch(/name/i);
  });

  it('`id` is therefore no longer reported as an unknown scene field', () => {
    // The exact expression `motion_set_scene_field` builds its warning from.
    expect(SCENE_FIELDS.some((f) => f.key === 'id')).toBe(true);
  });

  it('every field the list already had is still there (no collateral changes)', () => {
    expect(SCENE_FIELDS.map((f) => f.key)).toEqual(['id', 'dur', 'bg', 'grain', 'vignette', 'transition']);
  });
});
