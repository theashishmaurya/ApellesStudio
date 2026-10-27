/**
 * D-407 — the seven `motion_*_template` ops, through the op layer the MCP
 * tools call, plus the end-to-end proof: list the templates, instantiate
 * "stat counter" with custom values and an imported logo, validate, preview.
 *
 * Two documents are pinned to `crates/apelles-motion/tests/fixtures/` for
 * `crates/apelles-motion/tests/preview_render.rs` to render for real (twice,
 * comparing hashes): the stat counter built here (`template-stat-counter.json`)
 * and every built-in instantiated with its defaults (`builtin-templates.json`).
 * Regenerate after an intended change with
 * `APELLES_UPDATE_FIXTURES=1 npx vitest run src/templateOps.e2e.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { themeDefFromBuiltin } from '@apelles/motion-engine/src/themeDef';
import { THEMES } from '@apelles/motion-engine/src/design';
import type { MotionTemplate } from '@apelles/motion-engine/src/templateDef';
import { IDLE_RENDER_STATUS } from './renderLoop';
import { createMotionOps, type MotionOpsApi, type MotionPreviewRequest } from './motionOps';
import type { MotionAssetRecord } from './manifestIO';
import { BUILTIN_TEMPLATES } from './templateLibrary';
import { planInstantiate } from './templates';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../crates/apelles-motion/tests/fixtures');
const LOGO = resolve(FIXTURES, 'logo.svg');

/** The first op that needs icon names loads the whole Phosphor library. */
const ICON_TIMEOUT = { timeout: 90_000 };

function harness(start?: Manifest, library: MotionTemplate[] = []) {
  let manifest: Manifest = start ?? manifestSchema.parse({ title: 'Launch', fps: 30, scenes: [{ id: 'intro', dur: 1 }] });
  const lib = [...library];
  const commits: string[] = [];
  const previews: MotionPreviewRequest[] = [];
  const api = (): MotionOpsApi => ({
    loadState: 'ready',
    manifest,
    parseError: null,
    dirty: true,
    saveError: null,
    commit: (next, label) => {
      manifest = next;
      commits.push(label);
    },
    save: async () => ({ ok: true }),
    render: async () => ({ ok: true }),
    reloadFromDisk: async () => ({ ok: true, scenes: 0, hadSavedManifest: false }),
    renderStatus: IDLE_RENDER_STATUS,
  });
  const ops = createMotionOps({
    api,
    selections: () => [],
    setSelections: () => undefined,
    player: () => null,
    preview: async (req) => {
      previews.push(req);
      return { path: '/p.chroma/motion/previews/x.png', width: 960, height: 540, columns: req.frames.length, rows: 1 };
    },
    importAsset: async (path): Promise<MotionAssetRecord> => {
      const bytes = readFileSync(path);
      const hex = createHash('sha256').update(bytes).digest('hex');
      return { id: `sha256:${hex}.svg`, fileName: `${hex}.svg`, path: `/p.chroma/motion/assets/${hex}.svg`, bytes: bytes.length, copied: true, width: null, height: null };
    },
    templates: () => ({
      list: () => lib,
      loadErrors: () => [{ file: 'broken.json', error: 'not valid JSON' }],
      save: async (t) => {
        const i = lib.findIndex((x) => x.id === t.id);
        if (i < 0) lib.push(t);
        else lib[i] = t;
        return true;
      },
      remove: async (id) => {
        const i = lib.findIndex((x) => x.id === id);
        if (i < 0) return false;
        lib.splice(i, 1);
        return true;
      },
    }),
  });
  const run = async (op: string, args: Record<string, unknown> = {}) => (await ops[op](args)) as Record<string, unknown>;
  return { run, commits, previews, lib, current: () => manifest };
}

const pin = (name: string, doc: unknown) => {
  const path = resolve(FIXTURES, name);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.env.APELLES_UPDATE_FIXTURES) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, 'utf8'));
};

describe('D-407 — an agent fills a saved design to make a new on-brand scene', ICON_TIMEOUT, () => {
  it('lists, instantiates "stat counter" with custom values and an imported logo, validates clean and previews', async () => {
    const h = harness();

    const listed = await h.run('motion_list_templates');
    const templates = listed.templates as { id: string; source: string; valuesSchema: { properties: Record<string, unknown> } }[];
    const stat = templates.find((t) => t.id === 'stat-counter');
    expect(stat?.source).toBe('builtin');
    expect(Object.keys(stat?.valuesSchema.properties ?? {})).toEqual(['value', 'prefix', 'suffix', 'decimals', 'label', 'icon', 'logo', 'accent']);
    expect(listed.loadErrors).toEqual([{ file: 'broken.json', error: 'not valid JSON' }]);

    const asset = await h.run('motion_import_asset', { path: LOGO });
    const r = await h.run('motion_instantiate_template', {
      id: 'stat-counter',
      after_scene_index: 0,
      values: { value: 4.2, decimals: 1, prefix: '$', suffix: 'M', label: 'raised in our seed round', icon: 'chart-line-up', logo: asset.id, accent: '#22c55e' },
    });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ sceneIndex: 1, sceneId: 'stat-counter', template: { id: 'stat-counter', version: 1 } });
    expect(h.commits).toEqual(['Insert template: Stat counter']);
    const scene = h.current().scenes[1];
    expect(scene.template).toMatchObject({ id: 'stat-counter', values: { value: 4.2, logo: asset.id } });
    expect(scene.layers?.map((l) => l.id)).toEqual(['logo', 'icon', 'number', 'underline', 'label']);

    expect(await h.run('motion_validate')).toMatchObject({ ok: true, loads: true, issues: [] });

    const preview = await h.run('motion_preview_frame', { scene_index: 1, at_seconds: [0.5, 1.2, 3.5] });
    expect(preview.error).toBeUndefined();
    expect(h.previews[0].frames).toEqual([30 + 15, 30 + 36, 30 + 105]);
    pin('template-stat-counter.json', h.previews[0].manifest);
  });

  it('every built-in, instantiated with its defaults, is pinned for the real render', () => {
    let doc: Manifest = manifestSchema.parse({ title: 'Built-in templates', fps: 30, scenes: [{ id: 'lead-in', dur: 0.5 }] });
    for (const t of BUILTIN_TEMPLATES) {
      const plan = planInstantiate(doc, t, {}, {});
      if (!plan.ok) throw new Error(plan.error);
      doc = plan.manifest;
    }
    expect(doc.scenes.map((s) => s.id)).toEqual(['lead-in', ...BUILTIN_TEMPLATES.map((t) => t.id)]);
    pin('builtin-templates.json', doc);
  });

  it('bad values are refused with paths, and nothing lands', async () => {
    const h = harness();
    const r = await h.run('motion_instantiate_template', { id: 'stat-counter', values: { value: 'lots', icon: 'chart-line-upp', logo: '~/logo.png' } });
    expect((r.issues as { path: string; code: string }[]).map((i) => [i.path, i.code])).toEqual([
      ['values.value', 'invalid_type'],
      ['values.icon', 'unknown_icon'],
      ['values.logo', 'invalid_value'],
    ]);
    expect(h.commits).toEqual([]);
    expect((await h.run('motion_instantiate_template', { id: 'nope' })).error).toContain('available: logo-reveal');
  });
});

describe('the template ops', ICON_TIMEOUT, () => {
  const scene = () =>
    manifestSchema.parse({
      title: 't',
      themeDef: themeDefFromBuiltin(THEMES['apelles-studio'], 'brand-blue'),
      scenes: [
        {
          id: 'hero',
          dur: 3,
          layers: [
            { use: 'text', id: 'headline', text: 'Ship it', x: 100, y: 100 },
            { use: 'icon', id: 'ico', name: 'star', x: 600, y: 100 },
          ],
        },
      ],
    });

  it('save_template captures a scene; saving again is version 2; get returns it; refill needs upgrade across versions', async () => {
    const h = harness(scene());
    const slots = [{ id: 'headline', type: 'text', path: 'layers[headline].text', label: 'Headline' }];
    const dry = await h.run('motion_save_template', { scene_index: 0, name: 'Hero', tags: ['brand'], slots, dry_run: true });
    expect(dry).toMatchObject({ dryRun: true, id: 'hero', version: 1 });
    expect(h.lib).toEqual([]);

    const saved = await h.run('motion_save_template', { scene_index: 0, name: 'Hero', tags: ['brand'], slots });
    expect(saved).toMatchObject({ saved: true, id: 'hero', version: 1, previousVersion: null });
    expect(h.lib[0].themeDef?.name).toBe('brand-blue');

    const got = await h.run('motion_get_template', { id: 'hero' });
    expect(got).toMatchObject({ source: 'library', template: { id: 'hero', kind: 'scene' } });

    const made = await h.run('motion_instantiate_template', { id: 'hero', values: { headline: 'Go' } });
    expect(made).toMatchObject({ sceneIndex: 1, sceneId: 'hero-2' });

    const again = await h.run('motion_save_template', { scene_index: 0, name: 'Hero', slots });
    expect(again).toMatchObject({ version: 2, previousVersion: 1 });

    const stale = await h.run('motion_refill_template', { scene_index: 1, values: { headline: 'Now' } });
    expect(stale.error).toContain('upgrade=true');
    const upgraded = await h.run('motion_refill_template', { scene_index: 1, values: { headline: 'Now' }, upgrade: true });
    expect(upgraded).toMatchObject({ sceneId: 'hero-2', template: { version: 2, previousVersion: 1 }, values: { headline: 'Now' } });
    expect(h.current().scenes[1].layers?.[0]).toMatchObject({ text: 'Now' });
    expect(h.commits).toEqual(['Insert template: Hero', 'Refill template: Hero']);
  });

  it('save_template names a bad path; define_template refuses an unusable body and saves a good one', async () => {
    const h = harness(scene());
    const bad = await h.run('motion_save_template', { scene_index: 0, name: 'X', slots: [{ id: 'a', type: 'text', path: 'layers[9].text' }] });
    expect((bad.issues as { path: string }[])[0].path).toBe('slots[0].path');

    const template = {
      schemaVersion: 1,
      id: 'badge',
      name: 'Badge',
      version: 1,
      kind: 'group',
      authoredAt: { width: 1920, height: 1080, fps: 30 },
      slots: [{ id: 'label', type: 'text', label: 'Label', default: 'New' }, { id: 'icon', type: 'icon', label: 'Icon', default: 'sparkle' }],
      body: [
        { use: 'text', text: { $slot: 'label' }, x: 100, y: 100 },
        { use: 'icon', name: { $slot: 'icon' }, x: 40, y: 100 },
      ],
    };
    const typo = await h.run('motion_define_template', { template: { ...template, slots: [template.slots[0], { ...template.slots[1], default: 'sparkel' }] } });
    expect((typo.issues as { code: string }[])[0].code).toBe('unknown_icon');
    expect((await h.run('motion_define_template', { template: { ...template, id: 'logo-reveal' } })).error).toContain('built-in');

    expect(await h.run('motion_define_template', { template })).toMatchObject({ saved: true, id: 'badge', version: 1 });
    expect(await h.run('motion_define_template', { template })).toMatchObject({ saved: true, version: 2 });

    const group = await h.run('motion_instantiate_template', { id: 'badge', into_scene_index: 0, values: { label: 'Beta' } });
    expect(group).toMatchObject({ sceneIndex: 0, layerId: 'badge', selection: { target: { kind: 'layer', index: 2, id: 'badge' } } });
    const refill = await h.run('motion_refill_template', { scene_index: 0, layer_id: 'badge', values: { label: 'Soon' } });
    expect(refill.error).toBeUndefined();
    expect(JSON.stringify(h.current().scenes[0].layers?.[2])).toContain('Soon');
    expect((await h.run('motion_instantiate_template', { id: 'badge' })).error).toContain('into_scene_index');
  });

  it('dry_run commits nothing; apply_theme embeds the template look; delete refuses built-ins', async () => {
    const h = harness(scene());
    await h.run('motion_save_template', { scene_index: 0, name: 'Hero', slots: [] });
    const fresh = harness(undefined, h.lib);
    const dry = await fresh.run('motion_instantiate_template', { id: 'hero', dry_run: true });
    expect(dry).toMatchObject({ dryRun: true, ok: true });
    expect(fresh.commits).toEqual([]);
    await fresh.run('motion_instantiate_template', { id: 'hero', apply_theme: true });
    expect(fresh.current().themeDef?.name).toBe('brand-blue');
    expect((await fresh.run('motion_instantiate_template', { id: 'stat-counter', apply_theme: true })).error).toContain('no theme');

    expect((await h.run('motion_delete_template', { id: 'stat-counter' })).error).toContain('built-in');
    expect(await h.run('motion_delete_template', { id: 'hero' })).toMatchObject({ deleted: 'hero', remaining: 0 });
    expect((await h.run('motion_delete_template', { id: 'hero' })).error).toContain('no template');
  });

  it('list filters by tag and works with no library wired', async () => {
    const h = harness();
    const byTag = await h.run('motion_list_templates', { tag: 'pricing' });
    expect((byTag.templates as { id: string }[]).map((t) => t.id)).toEqual(['pricing-card']);
    const bare = createMotionOps({ api: () => ({ ...({} as MotionOpsApi), loadState: 'no-project', manifest: null }), selections: () => [], setSelections: () => undefined, player: () => null });
    const r = (await bare.motion_list_templates({})) as { templates: unknown[]; note?: string };
    expect(r.templates).toHaveLength(6);
    expect(r.note).toContain('built-ins only');
  });
});
