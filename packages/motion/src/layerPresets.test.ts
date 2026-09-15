/**
 * D-332 — the saved-layer-preset ("component") model.
 *
 * Everything here is pure: no React, no Tauri, no disk. The two properties
 * worth the most are (1) a preset never carries a layer `id` forward, because
 * two inserts sharing one id would break `resolveSelection`'s id-first match,
 * and (2) a library file that has been hand-edited or half-written degrades to
 * its valid subset rather than throwing away the whole thing.
 */
import { describe, it, expect } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import {
  PRESET_NAME_MAX,
  normalizePresetName,
  suggestedPresetName,
  presetFromLayer,
  upsertPreset,
  removePreset,
  sanitizeLoadedPresets,
  presetsForDisplay,
  type MotionLayerPreset,
} from './layerPresets';
import { addLayerFromPreset, addLayer } from './manifestEdit';

const AT = '2026-09-16T00:00:00.000Z';

/** a real, tuned-looking matrix fragment — the exact case the feature exists
 *  for (an attention heatmap someone spent time getting right). */
const TUNED_MATRIX = {
  use: 'matrix',
  preset: 'heatmap',
  at: 0.5,
  dur: 3,
  rows: 8,
  cols: 8,
  values: [
    [0.1, 0.9],
    [0.4, 0.2],
  ],
  transform: { keys: [{ at: 0, opacity: 0 }, { at: 0.6, opacity: 1 }] },
};

describe('normalizePresetName', () => {
  it('trims and collapses interior whitespace', () => {
    expect(normalizePresetName('  attention   heatmap  ')).toBe('attention heatmap');
  });

  it('rejects a name that is empty or only whitespace', () => {
    expect(normalizePresetName('')).toBeNull();
    expect(normalizePresetName('   \n\t ')).toBeNull();
  });

  it('bounds an overlong name at PRESET_NAME_MAX', () => {
    const out = normalizePresetName('x'.repeat(PRESET_NAME_MAX + 50));
    expect(out).not.toBeNull();
    expect(out).toHaveLength(PRESET_NAME_MAX);
  });
});

describe('suggestedPresetName', () => {
  it("uses a text layer's own text, the same identity the layer list shows", () => {
    expect(suggestedPresetName('text', { use: 'text', text: 'EVERY call re-sends' }))
      .toBe('Text — EVERY call re-sends');
  });

  it('falls back to the catalog display name when there is no text', () => {
    expect(suggestedPresetName('matrix', TUNED_MATRIX)).toBe('Matrix');
  });

  it('never returns an unusable name, even for a whitespace-only text', () => {
    expect(suggestedPresetName('text', { use: 'text', text: '   ' })).toBe('Text');
  });
});

describe('presetFromLayer', () => {
  it('captures the whole tuned fragment, animation included', () => {
    const p = presetFromLayer('attention heatmap', 'matrix', TUNED_MATRIX, AT)!;
    expect(p).not.toBeNull();
    expect(p.name).toBe('attention heatmap');
    expect(p.use).toBe('matrix');
    expect(p.createdAt).toBe(AT);
    // the point of the feature: the keyframes come along
    expect(p.layer.transform).toEqual(TUNED_MATRIX.transform);
    expect(p.layer.values).toEqual(TUNED_MATRIX.values);
    expect(p.layer.rows).toBe(8);
  });

  it('strips the layer id — a library id is not a manifest id', () => {
    const p = presetFromLayer('x', 'matrix', { ...TUNED_MATRIX, id: 'abc123' }, AT)!;
    expect('id' in p.layer).toBe(false);
    expect(p.id).not.toBe('abc123');
  });

  it('mints a distinct library id every call', () => {
    const a = presetFromLayer('x', 'matrix', TUNED_MATRIX, AT)!;
    const b = presetFromLayer('x', 'matrix', TUNED_MATRIX, AT)!;
    expect(a.id).not.toBe(b.id);
  });

  it('refuses an unusable name', () => {
    expect(presetFromLayer('   ', 'matrix', TUNED_MATRIX, AT)).toBeNull();
  });

  it('refuses a `use` the engine does not have', () => {
    expect(presetFromLayer('x', 'not-a-primitive', TUNED_MATRIX, AT)).toBeNull();
  });

  it('does not alias the source layer — editing the manifest cannot mutate the preset', () => {
    const live: Record<string, unknown> = { use: 'matrix', rows: 4 };
    const p = presetFromLayer('x', 'matrix', live, AT)!;
    live.rows = 99;
    expect(p.layer.rows).toBe(4);
  });
});

describe('upsertPreset / removePreset', () => {
  const a = presetFromLayer('a', 'matrix', TUNED_MATRIX, AT)!;
  const b = presetFromLayer('b', 'text', { use: 'text', text: 'hi' }, AT)!;

  it('appends an unseen preset and keeps order', () => {
    expect(upsertPreset([a], b).map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('replaces in place rather than moving a row under the cursor', () => {
    const edited = { ...a, name: 'a2' };
    expect(upsertPreset([a, b], edited).map((p) => p.name)).toEqual(['a2', 'b']);
  });

  it('removes by id', () => {
    expect(removePreset([a, b], a.id).map((p) => p.name)).toEqual(['b']);
  });

  it('returns the SAME array reference for a no-op remove', () => {
    const list = [a, b];
    expect(removePreset(list, 'nope')).toBe(list);
  });

});

describe('sanitizeLoadedPresets — a hand-editable file is never trusted', () => {
  const good = presetFromLayer('good', 'matrix', TUNED_MATRIX, AT)!;

  it('returns an empty list for anything that is not an array', () => {
    expect(sanitizeLoadedPresets(null)).toEqual([]);
    expect(sanitizeLoadedPresets({})).toEqual([]);
    expect(sanitizeLoadedPresets('[]')).toEqual([]);
  });

  it('keeps the valid rows and drops only the bad ones', () => {
    const out = sanitizeLoadedPresets([
      good,
      null,
      'nonsense',
      { id: 'x', name: 'no use', layer: {} },
      { id: 'y', use: 'matrix', name: '   ', layer: {} },
      { id: 'z', use: 'matrix', name: 'no layer' },
      { id: 'w', use: 'matrix', name: 'layer is an array', layer: [] },
    ]);
    expect(out.map((p) => p.name)).toEqual(['good']);
  });

  it('drops a `use` the engine no longer has — the check that earns its keep', () => {
    const stale = { ...good, id: 'stale', use: 'retired-primitive' };
    expect(sanitizeLoadedPresets([stale])).toEqual([]);
  });

  it('keeps only the first of a duplicated id, so delete stays unambiguous', () => {
    const dup = { ...good, name: 'second' };
    expect(sanitizeLoadedPresets([good, dup]).map((p) => p.name)).toEqual(['good']);
  });

  it('never lets a stored layer id survive the round trip', () => {
    const smuggled = { ...good, layer: { ...good.layer, id: 'smuggled' } };
    const out = sanitizeLoadedPresets([smuggled]);
    expect('id' in out[0].layer).toBe(false);
  });

  it('forces layer.use to agree with the row it is filed under', () => {
    const mismatched = { ...good, use: 'text', layer: { ...good.layer, use: 'matrix' } };
    const out = sanitizeLoadedPresets([mismatched]);
    expect(out[0].use).toBe('text');
    expect(out[0].layer.use).toBe('text');
  });
});

describe('presetsForDisplay', () => {
  it('lists newest first', () => {
    const old = { ...presetFromLayer('old', 'matrix', TUNED_MATRIX, '2026-01-01T00:00:00Z')! };
    const recent = { ...presetFromLayer('recent', 'matrix', TUNED_MATRIX, '2026-09-01T00:00:00Z')! };
    expect(presetsForDisplay([old, recent]).map((p) => p.name)).toEqual(['recent', 'old']);
  });

  it('is stable for equal timestamps rather than shuffling per render', () => {
    const a = presetFromLayer('a', 'matrix', TUNED_MATRIX, AT)!;
    const b = presetFromLayer('b', 'matrix', TUNED_MATRIX, AT)!;
    expect(presetsForDisplay([a, b]).map((p) => p.name)).toEqual(['a', 'b']);
    expect(presetsForDisplay([b, a]).map((p) => p.name)).toEqual(['b', 'a']);
  });

  it('does not mutate the list it was given', () => {
    const a = presetFromLayer('a', 'matrix', TUNED_MATRIX, '2026-01-01T00:00:00Z')!;
    const b = presetFromLayer('b', 'matrix', TUNED_MATRIX, '2026-09-01T00:00:00Z')!;
    const list = [a, b];
    presetsForDisplay(list);
    expect(list.map((p) => p.name)).toEqual(['a', 'b']);
  });
});

describe('addLayerFromPreset (manifestEdit) — the insert half', () => {
  const matrixPreset = presetFromLayer('attention heatmap', 'matrix', TUNED_MATRIX, AT)!;

  it('appends to scene.layers and selects the new layer', () => {
    const before = sample.scenes[0].layers?.length ?? 0;
    const { manifest, selection } = addLayerFromPreset(sample, 0, matrixPreset);
    expect(manifest.scenes[0].layers).toHaveLength(before + 1);
    expect(selection).toMatchObject({ sceneIndex: 0, target: { kind: 'layer', index: before } });
  });

  it('reproduces the tuned values, keyframes included', () => {
    const { manifest } = addLayerFromPreset(sample, 0, matrixPreset);
    const added = manifest.scenes[0].layers!.at(-1) as unknown as Record<string, unknown>;
    expect(added.rows).toBe(8);
    expect(added.values).toEqual(TUNED_MATRIX.values);
    expect(added.transform).toEqual(TUNED_MATRIX.transform);
  });

  it('gives every insert its own fresh id', () => {
    const one = addLayerFromPreset(sample, 0, matrixPreset).manifest;
    const two = addLayerFromPreset(one, 0, matrixPreset).manifest;
    const layers = two.scenes[0].layers! as unknown as Record<string, unknown>[];
    const ids = layers.slice(-2).map((l) => l.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every((i) => typeof i === 'string' && (i as string).length > 0)).toBe(true);
  });

  it('never shares mutable structure between two inserts', () => {
    const one = addLayerFromPreset(sample, 0, matrixPreset).manifest;
    const two = addLayerFromPreset(one, 0, matrixPreset).manifest;
    const layers = two.scenes[0].layers! as unknown as Record<string, unknown>[];
    const [a, b] = layers.slice(-2);
    expect(a.values).not.toBe(b.values);
    // and mutating one really does not reach the other
    (a.values as number[][])[0][0] = 99;
    expect((b.values as number[][])[0][0]).toBe(TUNED_MATRIX.values[0][0]);
  });

  it('routes a 3D primitive into scene3d.children, not scene.layers', () => {
    const p = presetFromLayer('stream', 'particleflow', { use: 'particleflow', preset: 'stream', from: [-6, 0, 0], to: [6, 0, 0] }, AT)!;
    const { manifest, selection } = addLayerFromPreset(sample, 0, p);
    expect(selection?.target.kind).toBe('scene3d-child');
    expect(manifest.scenes[0].scene3d!.children.at(-1)).toMatchObject({ use: 'particleflow' });
  });

  it('creates the scene3d container (with a real camera) when the scene has none', () => {
    const noThreeD = sample.scenes.findIndex((s) => !s.scene3d);
    expect(noThreeD).toBeGreaterThanOrEqual(0);
    const p = presetFromLayer('box', 'labelbox', { use: 'labelbox', position: [0, 0, 0], size: [2, 1.2, 0.4] }, AT)!;
    const { manifest } = addLayerFromPreset(sample, noThreeD, p);
    expect(manifest.scenes[noThreeD].scene3d!.camera.length).toBeGreaterThan(0);
  });

  it('produces a manifest the engine schema still accepts', () => {
    const { manifest } = addLayerFromPreset(sample, 0, matrixPreset);
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  it('is a no-op for an out-of-range scene or an unknown use', () => {
    expect(addLayerFromPreset(sample, 999, matrixPreset).manifest).toBe(sample);
    const bogus = { ...matrixPreset, use: 'retired' } as unknown as MotionLayerPreset;
    expect(addLayerFromPreset(sample, 0, bogus).manifest).toBe(sample);
  });

  it('never mutates the manifest it was given', () => {
    const snapshot = JSON.stringify(sample);
    addLayerFromPreset(sample, 0, matrixPreset);
    expect(JSON.stringify(sample)).toBe(snapshot);
  });

  /**
   * The round trip the whole feature is for: take a layer the catalog just
   * inserted, save it as a preset, insert THAT, and the two layers must be
   * identical apart from their ids. A drift here means a saved component does
   * not reproduce what the user saved.
   */
  it('round-trips a catalog layer back to an identical layer', () => {
    const inserted = addLayer(sample, 0, 'graph');
    const layers = inserted.manifest.scenes[0].layers! as unknown as Record<string, unknown>[];
    const original = layers.at(-1)!;

    const p = presetFromLayer('graph copy', 'graph', original, AT)!;
    const after = addLayerFromPreset(inserted.manifest, 0, p);
    const copy = (after.manifest.scenes[0].layers! as unknown as Record<string, unknown>[]).at(-1)!;

    const strip = (l: Record<string, unknown>) => {
      const { id, ...rest } = l;
      void id;
      return JSON.stringify(rest);
    };
    expect(strip(copy)).toBe(strip(original));
    expect(copy.id).not.toBe(original.id);
  });
});
