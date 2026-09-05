/**
 * @chroma/motion — tests for the Catalog's fragment construction and insert
 * logic (D-151).
 *
 * The load-bearing assertion style here: a constructed fragment is validated
 * by parsing a whole manifest containing it through the ENGINE'S OWN
 * `manifestSchema`, never by hand-checking its shape. A hand-written shape
 * assertion would pass happily on a fragment the engine rejects, which is
 * precisely the failure this catalog exists to prevent — the owner should
 * never click Add and get a red parse error.
 *
 * **The honest limit of that check, stated rather than glossed:** `layer` is
 * `.passthrough()` in the schema (`schema.ts` L64), so zod validates `use`,
 * `at`, `dur` and `active` and waves every per-primitive prop straight
 * through. A `matrix` fragment missing its required `rows`/`cols` is
 * therefore *schema-valid and renders nothing*. The schema check alone would
 * not catch it — which is why
 * `supplies the props each primitive has no runtime default for` exists as a
 * separate, explicit test rather than being assumed covered. Both guards were
 * mutation-checked when written (drop `rows`/`cols` ⇒ the required-props test
 * fails; make `at` a string ⇒ both schema tests fail).
 */
import { describe, it, expect } from 'vitest';
import { manifestSchema, type Manifest } from '@chroma/motion-engine/src/engine/schema';
import { sample } from '@chroma/motion-engine/src/engine/sample';

import { catalogEntries, catalogEntry, defaultLayerFor, type PrimitiveUse } from './catalog';
import { addLayer, selectedLayer } from './manifestEdit';

/** the engine's own `use` enum, as the catalog claims to cover it */
const ALL_USES: PrimitiveUse[] = [
  'text',
  'emphasis',
  'matrix',
  'graph',
  'layers',
  'particleflow',
  'labelbox',
  'layerstack',
];

/** a minimal 2D-only manifest — no `scene3d`, so 3D inserts must create one */
const flat = (): Manifest =>
  manifestSchema.parse({
    title: 'flat',
    scenes: [
      { id: 'one', dur: 3, layers: [{ use: 'text', text: 'existing' }] },
      { id: 'two', dur: 2, layers: [{ use: 'text', text: 'second scene' }] },
    ],
  });

describe('catalog coverage', () => {
  it('has an entry for every primitive in the engine schema, and no extras', () => {
    expect(catalogEntries.map((e) => e.use).sort()).toEqual([...ALL_USES].sort());
  });

  it('gives every entry a real name and a non-placeholder description', () => {
    for (const e of catalogEntries) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(20);
      expect(catalogEntry(e.use)).toBe(e);
    }
  });

  it('marks exactly the three-js primitives as 3D', () => {
    const in3d = catalogEntries.filter((e) => e.in3d).map((e) => e.use);
    expect(in3d.sort()).toEqual(['labelbox', 'layerstack', 'particleflow']);
  });
});

describe('defaultLayerFor — schema validity', () => {
  it.each(ALL_USES)('produces a fragment the engine schema accepts: %s', (use) => {
    const entry = catalogEntry(use);
    const fragment = defaultLayerFor(use);
    const doc = entry.in3d
      ? {
          title: 't',
          scenes: [{ id: 's', dur: 2, scene3d: { camera: [{ at: 0, pos: [0, 0, 12] }], children: [fragment] } }],
        }
      : { title: 't', scenes: [{ id: 's', dur: 2, layers: [fragment] }] };

    const parsed = manifestSchema.safeParse(doc);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it.each(ALL_USES)('carries its own `use` back: %s', (use) => {
    expect(defaultLayerFor(use).use).toBe(use);
  });

  it('supplies the props each primitive has no runtime default for', () => {
    // Matrix.tsx L22-23, Graph.tsx L48-49, Layers.tsx L20 — required props
    // with no defaulted value; a fragment missing these renders nothing.
    expect(defaultLayerFor('matrix')).toMatchObject({ rows: expect.any(Number), cols: expect.any(Number) });
    expect(defaultLayerFor('graph').nodes).toHaveLength(3);
    expect(defaultLayerFor('graph').edges).toHaveLength(2);
    expect(defaultLayerFor('layers').items).toHaveLength(3);
    // Emphasis.tsx L10 — the default `scribble` preset requires a box
    expect(defaultLayerFor('emphasis')).toMatchObject({ preset: 'scribble', box: expect.any(Array) });
  });

  it('returns fresh objects, so two inserts never share mutable state', () => {
    const a = defaultLayerFor('particleflow');
    const b = defaultLayerFor('particleflow');
    expect(a).not.toBe(b);
    expect(a.from).not.toBe(b.from);
    (a.from as number[])[0] = 999;
    expect((b.from as number[])[0]).toBe(-6);
  });
});

describe('addLayer — insertion', () => {
  it('appends a 2D layer to the target scene and selects it', () => {
    const before = flat();
    const { manifest, selection } = addLayer(before, 0, 'text');

    expect(manifest.scenes[0].layers).toHaveLength(2);
    expect(selection).toEqual({ sceneIndex: 0, target: { kind: 'layer', index: 1 } });
    expect(selectedLayer(manifest, selection!)?.use).toBe('text');
  });

  it('does not mutate the manifest it was given', () => {
    const before = flat();
    const snapshot = JSON.stringify(before);
    addLayer(before, 0, 'graph');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('leaves every other scene untouched', () => {
    const before = flat();
    const { manifest } = addLayer(before, 0, 'matrix');
    expect(manifest.scenes[1]).toEqual(before.scenes[1]);
    expect(manifest.scenes).toHaveLength(before.scenes.length);
    expect(manifest.title).toBe(before.title);
  });

  it('targets the scene it was asked for, not always the first', () => {
    const { manifest, selection } = addLayer(flat(), 1, 'layers');
    expect(manifest.scenes[0].layers).toHaveLength(1);
    expect(manifest.scenes[1].layers).toHaveLength(2);
    expect(selection).toEqual({ sceneIndex: 1, target: { kind: 'layer', index: 1 } });
  });

  it('creates a valid scene3d container when a 3D primitive lands in a 2D scene', () => {
    const before = flat();
    expect(before.scenes[0].scene3d).toBeUndefined();

    const { manifest, selection } = addLayer(before, 0, 'particleflow');
    expect(manifest.scenes[0].scene3d?.children).toHaveLength(1);
    expect(manifest.scenes[0].scene3d?.camera.length).toBeGreaterThanOrEqual(1);
    expect(selection).toEqual({ sceneIndex: 0, target: { kind: 'scene3d-child', index: 0 } });
    // the 2D layers that were already there are not disturbed
    expect(manifest.scenes[0].layers).toHaveLength(1);
  });

  it('appends into an existing scene3d rather than replacing it', () => {
    const { manifest: once } = addLayer(flat(), 0, 'labelbox');
    const camera = once.scenes[0].scene3d!.camera;
    const { manifest: twice, selection } = addLayer(once, 0, 'layerstack');

    expect(twice.scenes[0].scene3d?.children).toHaveLength(2);
    expect(twice.scenes[0].scene3d?.camera).toEqual(camera);
    expect(selection).toEqual({ sceneIndex: 0, target: { kind: 'scene3d-child', index: 1 } });
  });

  it('is a no-op with a null selection for an out-of-range scene index', () => {
    const before = flat();
    const { manifest, selection } = addLayer(before, 99, 'text');
    expect(manifest).toBe(before);
    expect(selection).toBeNull();
  });

  it.each(ALL_USES)('leaves the whole manifest schema-valid after inserting %s', (use) => {
    const { manifest } = addLayer(flat(), 0, use);
    const parsed = manifestSchema.safeParse(manifest);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });
});

describe('addLayer — against the engine\'s own real sample manifest', () => {
  // The backward-compatibility bar D-099 set ("should also work on our
  // current videos as well"): a real multi-scene manifest with a 2D camera,
  // 2D layers, and a populated scene3d — not a synthetic fixture.
  it('inserts into the 3D scene without disturbing the 2D scenes', () => {
    const before = manifestSchema.parse(sample);
    const scene3dIndex = before.scenes.findIndex((s) => s.scene3d);
    expect(scene3dIndex).toBeGreaterThanOrEqual(0);
    const childrenBefore = before.scenes[scene3dIndex].scene3d!.children.length;

    const { manifest, selection } = addLayer(before, scene3dIndex, 'labelbox');

    expect(manifest.scenes[scene3dIndex].scene3d?.children).toHaveLength(childrenBefore + 1);
    expect(selection?.target).toEqual({ kind: 'scene3d-child', index: childrenBefore });
    for (let i = 0; i < before.scenes.length; i++) {
      if (i !== scene3dIndex) expect(manifest.scenes[i]).toEqual(before.scenes[i]);
    }
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('preserves the 2D camera keyframes on a scene it inserts a 2D layer into', () => {
    const before = manifestSchema.parse(sample);
    const withCamera = before.scenes.findIndex((s) => s.camera?.length);
    expect(withCamera).toBeGreaterThanOrEqual(0);

    const { manifest } = addLayer(before, withCamera, 'emphasis');
    expect(manifest.scenes[withCamera].camera).toEqual(before.scenes[withCamera].camera);
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('round-trips through JSON the way MotionTab actually applies it', () => {
    // MotionTab writes the result back via JSON.stringify → setText →
    // useMotionManifest's own JSON.parse + safeParse. Anything that does
    // not survive that round trip (undefined, a Map, a cyclic ref) would
    // break live but pass an in-memory assertion.
    const { manifest } = addLayer(manifestSchema.parse(sample), 0, 'graph');
    const reparsed = manifestSchema.safeParse(JSON.parse(JSON.stringify(manifest)));
    expect(reparsed.success).toBe(true);
    expect(reparsed.success && reparsed.data.scenes[0].layers).toHaveLength(3);
  });
});
