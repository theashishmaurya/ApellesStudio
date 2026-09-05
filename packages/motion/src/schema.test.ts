/**
 * B-059 regression test (`docs/BUGS.md`) — `cam2dKey`'s `ease` field was a
 * real, supported `Camera.tsx` capability (`CameraKey.ease`) that the zod
 * schema silently stripped, because `cam2dKey` was a plain `z.object` and
 * zod strips unrecognized keys by default. D-159 fixed this by declaring
 * `ease` explicitly (`schema.ts`'s new `easeCurve` tuple) on `cam2dKey`,
 * `cam3dKey` (same gap, found while fixing this — `Scene3D.tsx`'s
 * `CameraRig` reads `CamKey.ease` the identical way), and the new
 * `transformKey` (D-159, Phase 4's per-layer keys).
 *
 * Lives in `@chroma/motion`'s test suite for the same reason
 * `interpolateKeys.test.ts` does — `@chroma/motion-engine` has no `test`
 * script (D-155's own finding, still true) — importing `manifestSchema`
 * across the package boundary the same way `manifestEdit.test.ts` already
 * imports `sample`/types from it.
 *
 * Each `it` below reproduces the exact repro from B-059's own bug report
 * ("verified live via a scratch script: the parsed key comes back
 * `{"at":0,"zoom":1}`, i.e. `'ease' in key === false`") and asserts the
 * OPPOSITE — this is a test that would have FAILED against the pre-D-159
 * schema (confirmed manually below, not just asserted).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { manifestSchema } from '@chroma/motion-engine/src/engine/schema';
import { sample } from '@chroma/motion-engine/src/engine/sample';

describe('B-059 — camera/layer keyframe `ease` survives schema validation', () => {
  it('retains an authored `ease` on a 2D camera key (the bug\'s own repro)', () => {
    const manifest = structuredClone(sample);
    manifest.scenes[0].camera = [{ at: 1.6, zoom: 1.5, ease: [0.4, 0, 0.2, 1] }];
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.scenes[0].camera?.[0].ease).toEqual([0.4, 0, 0.2, 1]);
  });

  it('retains an authored `ease` on a 3D camera key (same gap, found while fixing B-059)', () => {
    const manifest = structuredClone(sample);
    // scene index 2 in the sample is the `scene3d` scene.
    manifest.scenes[2].scene3d!.camera = [
      { at: 0, pos: [0, 0, 12], ease: [0.68, -0.55, 0.27, 1.55] },
    ];
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.scenes[2].scene3d?.camera[0].ease).toEqual([0.68, -0.55, 0.27, 1.55]);
  });

  it('retains an authored `ease` on a layer transform key (D-159, new field)', () => {
    const manifest = structuredClone(sample);
    (manifest.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0.5, x: 10, ease: [0.22, 1, 0.36, 1] }],
    };
    const parsed = manifestSchema.parse(manifest);
    const raw = parsed.scenes[0].layers![0] as unknown as {
      transform?: { keys?: { at: number; x?: number; ease?: readonly number[] }[] };
    };
    expect(raw.transform?.keys?.[0].ease).toEqual([0.22, 1, 0.36, 1]);
  });

  it('a camera key with no `ease` still parses fine, `ease` simply absent (not a regression)', () => {
    const manifest = structuredClone(sample);
    manifest.scenes[0].camera = [{ at: 0, zoom: 1 }];
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.scenes[0].camera?.[0].ease).toBeUndefined();
    expect(parsed.scenes[0].camera?.[0]).toEqual({ at: 0, zoom: 1 });
  });

  it('demonstrates the OLD (pre-D-159) failure mode directly, so the fix is provably meaningful', () => {
    // The exact `z.object` shape `cam2dKey` used to be — no `ease` field
    // declared, not `.passthrough()`. Zod strips unknown keys from a plain
    // `z.object` by default, which is the whole bug (B-059's own repro).
    const oldCam2dKey = z.object({
      at: z.number(),
      x: z.number().optional(),
      y: z.number().optional(),
      zoom: z.number().optional(),
    });
    const stripped = oldCam2dKey.parse({ at: 1.6, zoom: 1.5, ease: [0.4, 0, 0.2, 1] }) as Record<string, unknown>;
    expect('ease' in stripped).toBe(false); // the bug, reproduced against the OLD shape
    // ...and the CURRENT schema does not have this problem:
    const manifest = structuredClone(sample);
    manifest.scenes[0].camera = [{ at: 1.6, zoom: 1.5, ease: [0.4, 0, 0.2, 1] }];
    const fixed = manifestSchema.parse(manifest).scenes[0].camera?.[0] as Record<string, unknown>;
    expect('ease' in fixed).toBe(true);
  });
});
