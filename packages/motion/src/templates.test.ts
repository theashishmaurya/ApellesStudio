/**
 * templates.test.ts — instantiating, refilling and capturing templates
 * (D-407): every slot type, constraint failures with exact paths, reflow to
 * another canvas, deterministic fresh ids, provenance, refill, and capture
 * from a scene.
 */
import { describe, expect, it } from 'vitest';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { validateManifest } from '@apelles/motion-engine/src/engine/validate';
import { parseTemplate, type MotionTemplate } from '@apelles/motion-engine/src/templateDef';
import {
  exposableFields,
  instantiateTemplate,
  parseFieldPath,
  planInstantiate,
  planRefill,
  slotIdFor,
  slugifyTemplateId,
  templateFromSource,
  uniqueId,
} from './templates';

const LOGO = `sha256:${'b'.repeat(64)}.svg`;
const ICONS = new Set(['rocket-launch', 'star', 'check-circle']);

/** One template that uses all seven slot types. */
function everyType(): MotionTemplate {
  const parsed = parseTemplate({
    schemaVersion: 1,
    id: 'kitchen-sink',
    name: 'Kitchen sink',
    version: 3,
    kind: 'scene',
    authoredAt: { width: 1920, height: 1080, fps: 30 },
    slots: [
      { id: 'title', type: 'text', label: 'Title', required: true, constraints: { maxLen: 20 } },
      { id: 'count', type: 'number', label: 'Count', default: 10, constraints: { min: 0, integer: true } },
      { id: 'accent', type: 'color', label: 'Accent' },
      { id: 'logo', type: 'image', label: 'Logo' },
      { id: 'icon', type: 'icon', label: 'Icon', default: 'star' },
      { id: 'tier', type: 'enum', label: 'Tier', default: 'pro', constraints: { options: ['free', 'pro'] } },
      { id: 'features', type: 'list', label: 'Features', default: ['Fast'], constraints: { maxItems: 3, maxLen: 12 } },
    ],
    body: {
      dur: 3,
      layers: [
        { use: 'text', id: 'title', text: { $slot: 'title' }, x: 960, y: 200, size: 80, color: { $slot: 'accent' } },
        { use: 'counter', to: { $slot: 'count' }, x: 960, y: 400, size: 120 },
        { $when: 'logo', use: 'image', id: 'logo', src: { $slot: 'logo' }, x: 100, y: 100, w: 200, h: 100 },
        { use: 'icon', name: { $slot: 'icon' }, x: 1700, y: 100, size: 96 },
        { use: 'text', text: '{tier} plan:\n{features}', x: 200, y: 700, size: 40 },
      ],
    },
  });
  if (!('template' in parsed)) throw new Error(JSON.stringify(parsed.issues));
  return parsed.template;
}

function groupTemplate(): MotionTemplate {
  const parsed = parseTemplate({
    schemaVersion: 1,
    id: 'badge',
    name: 'Badge',
    version: 1,
    kind: 'group',
    authoredAt: { width: 1920, height: 1080, fps: 30 },
    slots: [{ id: 'label', type: 'text', label: 'Label', default: 'New' }],
    body: [
      { use: 'shape', shape: 'roundrect', x: 100, y: 100, w: 300, h: 80 },
      { use: 'text', text: { $slot: 'label' }, x: 250, y: 115, align: 'center', size: 40 },
    ],
  });
  if (!('template' in parsed)) throw new Error(JSON.stringify(parsed.issues));
  return parsed.template;
}

const doc = (over: Partial<Manifest> = {}): Manifest =>
  manifestSchema.parse({ title: 't', scenes: [{ id: 'intro', dur: 2 }, { id: 'outro', dur: 2 }], ...over });

describe('instantiateTemplate', () => {
  it('fills every slot type and records provenance', () => {
    const r = instantiateTemplate(
      everyType(),
      { title: 'Launch', accent: '#ff3366', logo: LOGO, icon: 'rocket-launch', tier: 'free', features: ['Fast', 'Safe'] },
      { width: 1920, height: 1080 },
      { iconNames: ICONS },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const layers = r.scene?.layers as unknown as Record<string, unknown>[];
    expect(layers[0]).toMatchObject({ use: 'text', text: 'Launch', color: '#ff3366' });
    expect(layers[1]).toMatchObject({ use: 'counter', to: 10 });
    expect(layers[2]).toMatchObject({ use: 'image', src: LOGO });
    expect(layers[3]).toMatchObject({ use: 'icon', name: 'rocket-launch' });
    expect(layers[4]).toMatchObject({ text: 'free plan:\nFast\nSafe' });
    expect(r.provenance).toEqual({
      id: 'kitchen-sink',
      version: 3,
      values: { title: 'Launch', count: 10, accent: '#ff3366', logo: LOGO, icon: 'rocket-launch', tier: 'free', features: ['Fast', 'Safe'] },
    });
    expect(r.scene?.template).toEqual(r.provenance);
    expect(r.reflowed).toBeNull();
  });

  it('an unset optional slot drops its key (theme default) and its $when layer', () => {
    const r = instantiateTemplate(everyType(), { title: 'Hi' }, { width: 1920, height: 1080 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const layers = r.scene?.layers as unknown as Record<string, unknown>[];
    expect(layers).toHaveLength(4);
    expect('color' in layers[0]).toBe(false);
    expect(layers.some((l) => l.use === 'image')).toBe(false);
  });

  it('refuses bad values with exact paths and changes nothing', () => {
    const r = instantiateTemplate(
      everyType(),
      { title: 'x'.repeat(21), count: 2.5, accent: 'tomato', logo: '/tmp/logo.png', icon: 'rocket-lanch', tier: 'gold', features: ['ok', 'far too long here'], extra: 1 },
      { width: 1920, height: 1080 },
      { iconNames: ICONS },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => [i.path, i.code])).toEqual([
      ['values.extra', 'unrecognized_key'],
      ['values.title', 'too_big'],
      ['values.count', 'invalid_type'],
      ['values.accent', 'invalid_value'],
      ['values.logo', 'invalid_value'],
      ['values.icon', 'unknown_icon'],
      ['values.tier', 'invalid_value'],
      ['values.features[1]', 'too_big'],
    ]);
    expect(r.error).toContain('values.title');
  });

  it('a required slot with no value is missing_field', () => {
    const r = instantiateTemplate(everyType(), {}, { width: 1920, height: 1080 });
    expect(!r.ok && r.issues[0]).toMatchObject({ path: 'values.title', code: 'missing_field' });
  });

  it('reflows from authoredAt to the project canvas', () => {
    const r = instantiateTemplate(everyType(), { title: 'Hi', logo: LOGO }, { width: 1280, height: 720 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reflowed).toEqual({ sx: 2 / 3, sy: 2 / 3, su: 2 / 3 });
    const layers = r.scene?.layers as unknown as Record<string, unknown>[];
    expect(layers[0]).toMatchObject({ x: 640, y: 133, size: 53 });
    expect(layers[2]).toMatchObject({ x: 67, y: 67, w: 133, h: 67 });
    // portrait: x by width, y by height, type by the smaller ratio
    const tall = instantiateTemplate(everyType(), { title: 'Hi' }, { width: 1080, height: 1920 });
    const t0 = tall.ok ? (tall.scene?.layers as unknown as Record<string, unknown>[])[0] : null;
    expect(t0).toMatchObject({ x: 540, y: 356, size: 45 });
  });

  it('mints deterministic ids: body ids kept, missing ones <use>-n, the scene named after the template', () => {
    const a = instantiateTemplate(everyType(), { title: 'Hi' }, { width: 1920, height: 1080 }, { takenSceneIds: ['kitchen-sink'] });
    const b = instantiateTemplate(everyType(), { title: 'Hi' }, { width: 1920, height: 1080 }, { takenSceneIds: ['kitchen-sink'] });
    expect(a).toEqual(b);
    if (!a.ok) return;
    expect(a.scene?.id).toBe('kitchen-sink-2');
    expect(a.scene?.layers?.map((l) => l.id)).toEqual(['title', 'counter-1', 'icon-1', 'text-1']);
  });

  it('a group template becomes ONE group layer with provenance and a free id', () => {
    const r = instantiateTemplate(groupTemplate(), { label: 'Beta' }, { width: 1920, height: 1080 }, { takenLayerIds: ['badge'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const layer = r.layer as unknown as Record<string, unknown>;
    expect(layer).toMatchObject({ use: 'group', id: 'badge-2', template: { id: 'badge', version: 1, values: { label: 'Beta' } } });
    expect((layer.children as Record<string, unknown>[]).map((c) => c.id)).toEqual(['shape-1', 'text-1']);
  });

  it('a body that does not expand to a valid scene is refused with the scene path', () => {
    const t = everyType();
    const broken = { ...t, body: { ...(t.body as object), layers: [{ use: 'text', text: { $slot: 'title' }, size: 'big' }] } };
    const r = instantiateTemplate(broken as MotionTemplate, { title: 'Hi' }, { width: 1920, height: 1080 });
    expect(!r.ok && r.issues[0]).toMatchObject({ path: 'scene.layers[0].size', code: 'invalid_type' });
  });
});

describe('planInstantiate / planRefill', () => {
  it('lands a scene after the given index, and the document still validates', () => {
    const plan = planInstantiate(doc(), everyType(), { title: 'Hi' }, { afterSceneIndex: 0 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.sceneIndex).toBe(1);
    expect(plan.manifest.scenes.map((s) => s.id)).toEqual(['intro', 'kitchen-sink', 'outro']);
    expect(validateManifest(plan.manifest).ok).toBe(true);
  });

  it('refuses the wrong target for each kind and a missing scene', () => {
    expect(planInstantiate(doc(), everyType(), { title: 'Hi' }, { intoSceneIndex: 0 }).ok).toBe(false);
    expect(planInstantiate(doc(), groupTemplate(), {}, {}).ok).toBe(false);
    expect(planInstantiate(doc(), groupTemplate(), {}, { intoSceneIndex: 9 }).ok).toBe(false);
  });

  it('a group lands on top of the target scene', () => {
    const plan = planInstantiate(doc(), groupTemplate(), {}, { intoSceneIndex: 1 });
    expect(plan.ok && plan.manifest.scenes[1].layers?.map((l) => l.use)).toEqual(['group']);
  });

  it('refill merges values, keeps the scene id and place, and null clears an optional slot', () => {
    const first = planInstantiate(doc(), everyType(), { title: 'Hi', logo: LOGO }, {});
    if (!first.ok) throw new Error(first.error);
    const idx = first.sceneIndex;
    const refilled = planRefill(first.manifest, { sceneIndex: idx }, everyType(), { count: 99, logo: null });
    expect(refilled.ok).toBe(true);
    if (!refilled.ok) return;
    const scene = refilled.manifest.scenes[idx];
    expect(scene.id).toBe('kitchen-sink');
    expect(scene.template?.values).toEqual({ title: 'Hi', count: 99, icon: 'star', tier: 'pro', features: ['Fast'] });
    expect(scene.layers?.some((l) => l.use === 'image')).toBe(false);
    expect(scene.layers?.find((l) => l.use === 'counter')).toMatchObject({ to: 99 });
    expect(refilled.manifest.scenes.length).toBe(first.manifest.scenes.length);
  });

  it('refill of a group instance keeps its id, start and transform', () => {
    const first = planInstantiate(doc(), groupTemplate(), {}, { intoSceneIndex: 0 });
    if (!first.ok) throw new Error(first.error);
    const moved = structuredClone(first.manifest);
    Object.assign(moved.scenes[0].layers?.[0] as object, { at: 1.5, transform: { x: 40 } });
    const r = planRefill(moved, { sceneIndex: 0, layerId: 'badge' }, groupTemplate(), { label: 'Soon' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.scenes[0].layers?.[0]).toMatchObject({ id: 'badge', at: 1.5, transform: { x: 40 }, template: { values: { label: 'Soon' } } });
  });

  it('refill refuses a scene that has no provenance', () => {
    const r = planRefill(doc(), { sceneIndex: 0 }, everyType(), {});
    expect(!r.ok && r.error).toContain('not made from a template');
  });
});

describe('templateFromSource', () => {
  const source = (): Manifest =>
    manifestSchema.parse({
      title: 't',
      width: 1280,
      height: 720,
      scenes: [
        {
          id: 'hero',
          dur: 3,
          layers: [
            { use: 'text', id: 'headline', text: 'Ship it', size: 80, x: 100, y: 100 },
            { use: 'shape', id: 'bar', x: 100, y: 300, w: 400, h: 8 },
            { use: 'icon', id: 'ico', name: 'star', x: 600, y: 100 },
          ],
        },
      ],
    });

  it('captures a scene: paths become bindings, current values become defaults', () => {
    const r = templateFromSource(source(), { sceneIndex: 0 }, {
      name: 'Hero card',
      tags: ['brand'],
      slots: [
        { id: 'headline', type: 'text', path: 'layers[headline].text', label: 'Headline' },
        { id: 'accent', type: 'color', path: ['layers[1].fill', 'layers[0].color'] },
        { id: 'icon', type: 'icon', path: 'layers[2].name' },
      ],
    });
    expect('template' in r).toBe(true);
    if (!('template' in r)) return;
    const t = r.template;
    expect(t).toMatchObject({ id: 'hero-card', version: 1, kind: 'scene', authoredAt: { width: 1280, height: 720, fps: 30 }, tags: ['brand'] });
    expect(t.slots).toEqual([
      { id: 'headline', type: 'text', label: 'Headline', default: 'Ship it' },
      { id: 'accent', type: 'color', label: 'accent' },
      { id: 'icon', type: 'icon', label: 'icon', default: 'star' },
    ]);
    const body = t.body as { id?: string; layers: Record<string, unknown>[] };
    expect(body.id).toBeUndefined();
    expect(body.layers[0]).toMatchObject({ text: { $slot: 'headline' }, color: { $slot: 'accent' } });
    expect(body.layers[1].fill).toEqual({ $slot: 'accent' });
    // and it round-trips: instantiating with the defaults gives the original layers back
    const back = instantiateTemplate(t, {}, { width: 1280, height: 720 });
    expect(back.ok && back.scene?.layers).toEqual(source().scenes[0].layers);
  });

  it('captures selected layers as a group template', () => {
    const r = templateFromSource(source(), { sceneIndex: 0, layers: ['headline', 2] }, {
      name: 'Title with icon',
      slots: [{ id: 'title', type: 'text', path: '[headline].text' }],
    });
    expect('template' in r && r.template.kind).toBe('group');
    expect('template' in r && (r.template.body as unknown[]).length).toBe(2);
  });

  it('names a path that does not exist, and a default of the wrong type', () => {
    const r = templateFromSource(source(), { sceneIndex: 0 }, {
      name: 'x',
      slots: [
        { id: 'a', type: 'text', path: 'layers[nope].text' },
        { id: 'b', type: 'number', path: 'layers[0].text' },
      ],
    });
    expect('issues' in r && r.issues.map((i) => i.path)).toEqual(['slots[0].path', 'slots[1].default']);
  });
});

describe('helpers', () => {
  it('parses field paths', () => {
    expect(parseFieldPath('layers[2].text')).toEqual(['layers', 2, 'text']);
    expect(parseFieldPath('[headline].children[0].fill')).toEqual(['#headline', 'children', 0, 'fill']);
    expect(parseFieldPath('layers[')).toBeNull();
  });

  it('ids: unique, slugged, slot ids from labels', () => {
    expect(uniqueId('a', new Set(['a', 'a-2']))).toBe('a-3');
    expect(slugifyTemplateId('Stat counter (Blue)!')).toBe('stat-counter-blue');
    expect(slugifyTemplateId('???')).toBe('template');
    expect(slotIdFor('Fill opacity', new Set(['fillOpacity']))).toBe('fillOpacity_2');
    expect(slotIdFor('Width (line: dx)', new Set())).toBe('width');
  });

  it('lists exposable content and look fields, group children included, not layout', () => {
    const fields = exposableFields(
      manifestSchema.parse({
        title: 't',
        scenes: [{ id: 's', dur: 1, layers: [{ use: 'text', text: 'Hi' }, { use: 'group', children: [{ use: 'icon', name: 'star' }] }] }],
      }).scenes[0].layers ?? [],
    );
    const paths = fields.map((f) => `${f.path}:${f.type}`);
    expect(paths).toContain('layers[0].text:text');
    expect(paths).toContain('layers[0].color:color');
    expect(paths).toContain('layers[1].children[0].name:icon');
    expect(paths.some((p) => p.startsWith('layers[0].x'))).toBe(false);
  });
});
