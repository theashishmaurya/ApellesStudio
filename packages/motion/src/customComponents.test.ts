/**
 * D-409 — the pure half of custom components: the library sanitiser, `use`
 * parsing, embedding, the proof plan and the live player's proxy manifest.
 */
import { describe, expect, it } from 'vitest';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import { validateManifest } from '@apelles/motion-engine/src/engine/validate';
import type { ComponentMeta, ComponentRef } from '@apelles/motion-engine/src/custom/componentDef';
import {
  addCustomLayer,
  freshLayerId,
  missingComponents,
  parseCustomUse,
  proofPlan,
  proofVariantProps,
  proxyManifest,
  sanitizeComponentLibrary,
} from './customComponents';

const HEX = 'b'.repeat(64);
const ref: ComponentRef = {
  id: 'chart',
  name: 'Chart',
  props: [
    { id: 'values', type: 'list', label: 'Values', default: [1, 2], constraints: { itemType: 'number', min: 0, max: 50, minItems: 2, maxItems: 5 } },
    { id: 'title', type: 'text', label: 'Title', default: 'T', constraints: { maxLen: 10 } },
    { id: 'speed', type: 'number', label: 'Speed', default: 1, constraints: { min: 0.5, max: 3 } },
    { id: 'mode', type: 'enum', label: 'Mode', default: 'a', constraints: { options: ['a', 'b', 'c'] } },
    { id: 'ink', type: 'color', label: 'Ink' },
  ],
  size: { w: 960, h: 540 },
  duration: 2,
  version: 3,
  sourceHash: HEX,
  codeHash: HEX,
  code: `sha256:${HEX}.js`,
  source: `sha256:${HEX}.tsx`,
};
const meta: ComponentMeta = { ...ref, schemaVersion: 1, status: 'certified' } as ComponentMeta;

describe('the library', () => {
  it('drops a bad entry with a named error and keeps the rest, sorted', () => {
    const out = sanitizeComponentLibrary({
      entries: [
        { id: 'chart', version: 3, source: 'library', dir: '/l/chart/3', meta },
        { id: 'broken', version: 1, source: 'library', dir: '/l/broken/1', meta: { id: 'broken' } },
        { id: 'chart', version: 1, source: 'library', dir: '/l/chart/1', meta: { ...meta, version: 1 } },
      ],
      errors: [{ path: '/l/x', error: 'not a component id' }],
    });
    expect(out.entries.map((e) => `${e.id}@${e.version}`)).toEqual(['chart@1', 'chart@3']);
    expect(out.errors.map((e) => e.path)).toEqual(['/l/x', '/l/broken/1']);
  });
  it('parses custom uses', () => {
    expect(parseCustomUse('custom:chart')).toEqual({ id: 'chart' });
    expect(parseCustomUse('custom:chart@3')).toEqual({ id: 'chart', version: 3 });
    expect(parseCustomUse('text')).toBeNull();
    expect(parseCustomUse('custom:Bad')).toBeNull();
  });
});

describe('embedding and placing', () => {
  const doc = manifestSchema.parse({ title: 'd', scenes: [{ id: 's', dur: 2, layers: [{ use: 'text', id: 'chart', text: 'x' }] }] });
  it('adds a centred layer with a fresh deterministic id and embeds the definition', () => {
    const added = addCustomLayer(doc, 0, ref, { title: 'Hi' });
    expect(added?.id).toBe('chart-2');
    expect(added?.manifest.components?.['chart@3']).toEqual(ref);
    expect(added?.manifest.scenes[0].layers?.[1]).toMatchObject({ use: 'custom', component: 'chart@3', x: 480, y: 270, w: 960, h: 540, props: { title: 'Hi' } });
    expect(validateManifest(added?.manifest).issues).toEqual([]);
    expect(freshLayerId(doc, 'other')).toBe('other');
  });
  it('finds the pins a fragment needs that the document lacks', () => {
    const frag = [{ use: 'group', children: [{ use: 'custom', component: 'chart@3' }, { use: 'custom', component: 'burst@1' }] }];
    expect(missingComponents(doc, frag)).toEqual(['burst@1', 'chart@3']);
    expect(missingComponents({ components: { 'chart@3': ref } }, frag)).toEqual(['burst@1']);
  });
});

describe('the proof plan', () => {
  it('renders defaults and both edges of every constraint, four frames each, as a valid document', () => {
    const plan = proofPlan(ref);
    expect(plan.variants).toEqual([
      { name: 'defaults', frames: [0, 20, 39, 59] },
      { name: 'min', frames: [60, 80, 99, 119] },
      { name: 'max', frames: [120, 140, 159, 179] },
    ]);
    expect(plan.scale).toBe(0.5);
    expect(plan.manifest).toMatchObject({ width: 960, height: 540, fps: 30, grain: false, vignette: false });
    expect(validateManifest(plan.manifest).issues).toEqual([]);
    expect(proofVariantProps(ref, 'min')).toEqual({ values: [0, 0], title: 'A', speed: 0.5, mode: 'a' });
    expect(proofVariantProps(ref, 'max')).toEqual({ values: [50, 49, 48, 47, 46], title: 'WWWWWWWWWW', speed: 3, mode: 'c', ink: '#22d3ee' });
  });
});

describe('the proxy manifest', () => {
  it('is the layer alone, transparent, at its own time, without box tracks', () => {
    const raw = {
      use: 'custom',
      component: 'chart@3',
      at: 0.5,
      x: 100,
      y: 50,
      w: 480,
      h: 270,
      props: { title: 'Q' },
      anim: { 'props.ink': [{ at: 0.5, v: '#000000' }, { at: 1.5, v: '#ffffff' }], x: [{ at: 0, v: 0 }] },
    };
    const m = proxyManifest({ fps: 30, theme: 'apelles-studio' }, ref, raw, 45);
    expect(m).toMatchObject({ width: 480, height: 270, fps: 30, transparent: true, grain: false, vignette: false, theme: 'apelles-studio' });
    const layer = m.scenes[0].layers?.[0] as unknown as Record<string, unknown>;
    expect(layer).toMatchObject({ x: 0, y: 0, props: { title: 'Q' }, anim: { 'props.ink': [{ at: 0 }, { at: 1 }] } });
    expect(layer).not.toHaveProperty('at');
    expect((layer.anim as Record<string, unknown>).x).toBeUndefined();
    expect(m.scenes[0].dur).toBe(1.5);
    expect(validateManifest(m).issues).toEqual([]);
  });
});
