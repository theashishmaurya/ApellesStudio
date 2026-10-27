// The `brand_*` ops end to end at the op layer (D-416): the real ops, the real
// store and the real applier registry, wired exactly as the bridge wires them
// (`liveBrandOpsContext`), over an in-memory backend that keeps the library,
// the brand asset store and the project's snapshot the way `apelles-brand` does
// (one file per kit, content-addressed assets, a COPY in the project).
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  library: new Map<string, unknown>(),
  badFiles: [] as Array<{ file: string; error: string }>,
  assets: new Map<string, string>(),
  project: null as unknown,
  projectAssets: new Set<string>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const clone = <T,>(v: T): T => structuredClone(v);
    switch (cmd) {
      case 'chroma_brand_load_kits':
        return {
          kits: [...backend.library.entries()].sort().map(([id, kit]) => ({ file: `${id}.json`, kit: clone(kit) })),
          errors: clone(backend.badFiles),
        };
      case 'chroma_brand_save_kit': {
        const kit = args?.kit as { id: string };
        backend.library.set(kit.id, clone(kit));
        return `/data/brand/kits/${kit.id}.json`;
      }
      case 'chroma_brand_delete_kit':
        return backend.library.delete(String(args?.id));
      case 'chroma_brand_import_asset': {
        const path = String(args?.path);
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        if (path.includes('missing')) throw new Error(`${path}: no such file`);
        const hex = createHash('sha256').update(path).digest('hex');
        const id = `sha256:${hex}.${ext}`;
        backend.assets.set(id, path);
        const kind = ['mp4', 'mov'].includes(ext) ? 'video' : ext === 'ttf' ? 'font' : ext === 'cube' ? 'lut' : 'image';
        return { id, fileName: `${hex}.${ext}`, path: `/data/brand/assets/${hex}.${ext}`, bytes: 10, kind, copied: true, sourceName: path.split('/').pop() };
      }
      case 'chroma_brand_assets_dir':
        return '/data/brand/assets';
      case 'chroma_brand_project_get':
        return clone(backend.project);
      case 'chroma_brand_project_set': {
        const kit = (args?.kit ?? null) as Record<string, unknown> | null;
        backend.project = clone(kit);
        if (!kit) return null;
        const ids = JSON.stringify(kit).match(/sha256:[0-9a-f]{64}\.[a-z0-9]+/g) ?? [];
        for (const id of ids) {
          if (!backend.assets.has(id)) throw new Error(`brand asset ${id} is not in the brand library`);
          backend.projectAssets.add(id);
        }
        return { kitPath: '/p.chroma/brand/kit.json', assetsDir: '/p.chroma/brand/assets', assets: [...new Set(ids)].sort(), copied: ids.length };
      }
      case 'chroma_brand_project_assets_dir':
        return '/p.chroma/brand/assets';
      default:
        throw new Error(`no stub for ${cmd}`);
    }
  },
}));

import { createBrandOps } from './brandOps';
import { liveBrandOpsContext } from './useBrandControl';
import { useBrandStore } from './io';
import { __clearBrandAppliersForTest, registerBrandApplier, type BrandApplyRequest } from './appliers';
import type { BrandKit } from './kit';

type Result = Record<string, unknown> & { error?: string };

function setup() {
  const ops = createBrandOps(liveBrandOpsContext());
  return async (op: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const fn = ops[op];
    if (!fn) throw new Error(`no op ${op}`);
    return (await fn(args)) as Result;
  };
}

beforeEach(() => {
  backend.library.clear();
  backend.badFiles = [];
  backend.assets.clear();
  backend.project = null;
  backend.projectAssets.clear();
  useBrandStore.setState({ kits: [], loadErrors: [], loaded: false, error: null, project: null, openProjectPath: null });
  __clearBrandAppliersForTest();
});

describe('brand_* ops (D-416)', () => {
  it('create → list → get, with the starter filling what the agent leaves out and contrast reported', async () => {
    const run = setup();
    const made = await run('brand_create_kit', { kit: { id: 'acme', name: 'Acme', colors: { primary: '#ff5a1f' } } });
    expect(made.error).toBeUndefined();
    expect((made.kit as BrandKit).version).toBe(1);
    expect((made.kit as BrandKit).colors.primary).toBe('#ff5a1f');
    expect(Array.isArray(made.contrast)).toBe(true);

    expect((await run('brand_create_kit', { kit: { id: 'acme', name: 'Again' } })).error).toMatch(/already exists/);
    const dry = await run('brand_create_kit', { kit: { id: 'dry', name: 'Dry' }, dry_run: true });
    expect(dry.dryRun).toBe(true);
    expect(backend.library.has('dry')).toBe(false);

    backend.badFiles = [{ file: 'broken.json', error: 'not valid JSON' }];
    const list = await run('brand_list_kits');
    expect((list.kits as Array<{ id: string }>).map((k) => k.id)).toEqual(['acme']);
    expect(list.loadErrors).toEqual([{ file: 'broken.json', error: 'not valid JSON' }]);
    expect(list.project).toBeNull();

    const got = await run('brand_get_kit', { id: 'acme' });
    expect(got.source).toBe('library');
    expect((await run('brand_get_kit')).error).toMatch(/no active brand kit/);
    expect((await run('brand_get_kit', { id: 'nope' })).error).toMatch(/no brand kit "nope"/);
  });

  it('a refusal names the path of every problem', async () => {
    const run = setup();
    const r = await run('brand_create_kit', { kit: { id: 'acme', name: 'Acme', colors: { primary: 'orange' }, motion: { speed: 9 } } });
    expect(r.error).toMatch(/colors\.primary/);
    const paths = (r.issues as Array<{ path: string }>).map((i) => i.path);
    expect(paths).toContain('colors.primary');
    expect(paths.some((p) => p.startsWith('motion'))).toBe(true);
    expect(backend.library.size).toBe(0);
  });

  it('import an asset, update the kit (version bumps), and the project copy is reported out of date', async () => {
    const run = setup();
    await run('brand_create_kit', { kit: { id: 'acme', name: 'Acme' } });
    const imported = await run('brand_import_asset', { path: '/Users/me/logo-dark.svg' });
    const logo = (imported.asset as { id: string }).id;
    expect(logo).toMatch(/^sha256:[0-9a-f]{64}\.svg$/);

    const active = await run('brand_set_active_kit', { id: 'acme' });
    expect((active.active as { version: number }).version).toBe(1);

    const up = await run('brand_update_kit', { id: 'acme', patch: { logos: { dark: logo }, version: 40 } });
    expect((up.kit as BrandKit).version).toBe(2);
    expect((up.kit as BrandKit).logos?.dark).toBe(logo);
    expect(up.projectOutOfDate).toBe(true);
    expect((backend.project as BrandKit).version).toBe(1); // the copy is untouched until set again

    const list = await run('brand_list_kits');
    expect(list.project).toMatchObject({ id: 'acme', version: 1, libraryVersion: 2, newerInLibrary: true });

    await run('brand_set_active_kit', { id: 'acme' });
    expect((backend.project as BrandKit).version).toBe(2);
    expect(backend.projectAssets.has(logo)).toBe(true);
    expect((await run('brand_update_kit', { id: 'acme', patch: { colors: { text: 'white' } } })).error).toMatch(/colors\.text/);
  });

  it('delete leaves the project copy; clearing the project kit is explicit', async () => {
    const run = setup();
    await run('brand_create_kit', { kit: { id: 'acme', name: 'Acme' } });
    await run('brand_set_active_kit', { id: 'acme' });
    expect(await run('brand_delete_kit', { id: 'acme' })).toMatchObject({ deleted: 'acme' });
    expect((await run('brand_delete_kit', { id: 'acme' })).error).toMatch(/no brand kit/);
    expect((await run('brand_get_kit')).source).toBe('project');
    expect((await run('brand_set_active_kit', { id: null })).active).toBeNull();
    expect(backend.project).toBeNull();
  });

  it('references: added with a note, copied to the project when it uses the kit, read back as files', async () => {
    const run = setup();
    await run('brand_create_kit', { kit: { id: 'acme', name: 'Acme' } });
    expect((await run('brand_add_reference', { path: '/r/a.png', note: 'x' })).error).toMatch(/kit_id|brand kit first/);
    await run('brand_set_active_kit', { id: 'acme' });
    expect((await run('brand_add_reference', { path: '/r/a.png' })).error).toMatch(/note is required/);
    expect((await run('brand_add_reference', { path: '/r/font.ttf', note: 'n' })).error).toMatch(/image or a video/);

    const own = await run('brand_add_reference', { path: '/work/My Reel.mp4', note: 'use my work for materials and framing', kind: 'own-work' });
    expect(own.projectUpdated).toBe(true);
    await run('brand_add_reference', { path: '/refs/poster.png', note: 'use the reference for type and hierarchy' });

    const refs = await run('brand_get_references');
    const list = refs.references as Array<{ id: string; kind: string; media: string; path: string; note: string }>;
    expect(list.map((r) => [r.id, r.kind, r.media])).toEqual([
      ['my-reel', 'own-work', 'video'],
      ['poster', 'reference', 'image'],
    ]);
    expect(list[0].path).toMatch(/^\/p\.chroma\/brand\/assets\/[0-9a-f]{64}\.mp4$/);
    expect((refs.kit as { source: string }).source).toBe('project');
    expect(refs.direction).toHaveProperty('colors');
    const fromLibrary = await run('brand_get_references', { kit_id: 'acme' });
    expect((fromLibrary.references as Array<{ path: string }>)[0].path).toMatch(/^\/data\/brand\/assets\//);
  });

  it('apply: each tab once, one history entry each, a missing tab reported, and only the tabs asked for', async () => {
    const run = setup();
    expect((await run('brand_apply_kit')).error).toMatch(/no active brand kit/);
    await run('brand_create_kit', { kit: { id: 'acme', name: 'Acme' } });
    await run('brand_set_active_kit', { id: 'acme' });

    const calls: Array<[string, BrandApplyRequest]> = [];
    const history: string[] = [];
    for (const tab of ['edit', 'colorist'] as const) {
      registerBrandApplier(tab, async (req) => {
        calls.push([tab, req]);
        history.push(`${tab}: Apply brand kit "${req.kit.name}"`);
        return { ok: true, changed: true, summary: `${tab} done` };
      });
    }
    const all = await run('brand_apply_kit', { restyle_existing: true });
    expect(all.error).toBeUndefined();
    const results = all.results as Record<string, { ok: boolean; error?: string }>;
    expect(results.edit.ok).toBe(true);
    expect(results.colorist.ok).toBe(true);
    expect(results.motion).toEqual({ ok: false, error: 'the motion tab is not available in this build' });
    expect(history).toEqual(['edit: Apply brand kit "Acme"', 'colorist: Apply brand kit "Acme"']);
    expect(calls[0][1]).toMatchObject({ assetsDir: '/p.chroma/brand/assets', options: { restyleExisting: true, titles: true } });

    calls.length = 0;
    await run('brand_apply_kit', { tabs: ['colorist'], titles: false });
    expect(calls.map(([t]) => t)).toEqual(['colorist']);
    expect((await run('brand_apply_kit', { tabs: ['audio'] })).error).toMatch(/tabs must be/);
    expect((await run('brand_apply_kit', { tabs: ['motion'] })).error).toMatch(/nothing applied/);
  });
});
