/**
 * D-403 — existing manifests keep loading under the per-primitive schema.
 *
 * The layer schema used to be `.passthrough()`: it typed nothing past the
 * shared fields, so ANY prop value loaded. D-403 replaced it with a
 * discriminated union that type-checks every known prop. That is only safe if
 * every real manifest still loads, byte for byte, so this test runs the real
 * documents we have through the new schema:
 *
 *   - `fixtures/manifests/how-transformers-work.json` — a real seven-scene
 *     manifest from the engine's previous home (videoAgent's archived pilot),
 *     copied verbatim;
 *   - `fixtures/manifests/owner-layer-presets-2026-10-25.json` — the owner's
 *     real saved-component library (D-332), every layer in it, copied verbatim
 *     from the app data directory;
 *   - the engine's own `sample` manifest (what a new project starts on);
 *   - every Catalog default (`defaultLayerFor`), i.e. every layer the GUI can
 *     insert.
 *
 * "Keeps loading" is asserted as: parses, and the parse output equals the
 * input exactly (apart from the three `width`/`height`/`fps` defaults the
 * schema has always filled in) — so nothing is coerced or stripped either.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import { validateManifest } from '@apelles/motion-engine/src/engine/validate';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import { catalogEntries, defaultLayerFor } from './catalog';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(HERE, 'fixtures/manifests', name), 'utf8'));

const DEFAULTS = { width: 1920, height: 1080, fps: 30 };

function expectLoadsUnchanged(doc: Record<string, unknown>) {
  const parsed = manifestSchema.safeParse(doc);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
  expect(parsed.data).toEqual({ ...DEFAULTS, ...doc });
}

describe('existing manifests keep loading (D-403)', () => {
  it('the archived seven-scene pilot manifest loads unchanged and validates clean', () => {
    const doc = fixture('how-transformers-work.json') as Record<string, unknown>;
    expectLoadsUnchanged(doc);
    expect(validateManifest(doc).issues).toEqual([]);
  });

  it("every layer in the owner's saved-component library loads unchanged and validates clean", () => {
    const presets = fixture('owner-layer-presets-2026-10-25.json') as { layer: Record<string, unknown> }[];
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      const doc = { title: 'preset', scenes: [{ id: 's', dur: 5, layers: [p.layer] }] };
      expectLoadsUnchanged(doc);
      expect(validateManifest(doc).issues).toEqual([]);
    }
  });

  it("the engine's sample manifest loads unchanged and validates clean", () => {
    expectLoadsUnchanged(sample as unknown as Record<string, unknown>);
    expect(validateManifest(sample).issues).toEqual([]);
  });

  it('every Catalog default validates clean in its own container', () => {
    for (const e of catalogEntries) {
      const layer = defaultLayerFor(e.use);
      const scene = e.in3d
        ? { id: 's', dur: 4, scene3d: { camera: [{ at: 0, pos: [0, 0, 12] }], children: [layer] } }
        : { id: 's', dur: 4, layers: [layer] };
      const doc = { title: 'catalog', scenes: [scene] };
      expectLoadsUnchanged(doc);
      expect(validateManifest(doc).issues).toEqual([]);
    }
  });
});
