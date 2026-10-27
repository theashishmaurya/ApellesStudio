// D-416 — a brand kit in the Motion tab: the generated theme (deterministic,
// valid, embedded by copy), the motion style as defaults for NEW work only, the
// explicit restyle, and the applier's single commit.
import { describe, expect, it, vi } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { themeDefSchema, resolveManifestTheme } from '@apelles/motion-engine/src/themeDef';
import { starterKit, type BrandKit, type MotionStyle } from '@apelles/brand';
import {
  brandEase,
  brandLayerDefaults,
  hasEntrance,
  mixHex,
  restyleManifest,
  themeDefFromBrandKit,
} from './brandTheme';
import { applyBrandToMotion } from './brandApply';
import { createMotionOps, type MotionOpsApi } from './motionOps';
import { IDLE_RENDER_STATUS } from './renderLoop';
import { addLayer } from './manifestEdit';

const id = (ext: string, c: string) => `sha256:${c.repeat(64)}.${ext}`;

const kit = (): BrandKit => ({
  ...starterKit('acme', 'Acme'),
  version: 3,
  colors: { primary: '#ff5a1f', secondary: '#1b2a4a', accent: '#00b3a4', background: '#101014', text: '#fafafa' },
  typography: {
    display: { family: 'Acme Grotesk', source: 'file', file: id('woff2', 'a'), licence: 'Licensed for video, 2026', weights: ['800'] },
    body: { family: 'Inter', source: 'google', weights: ['600', '400'] },
    mono: { family: 'Menlo', source: 'system' },
  },
  logos: { light: id('svg', 'b') },
  motion: { ease: 'anticipate', speed: 2, stagger: 0.1, entrance: 'pop' },
});

const STYLE: MotionStyle = { ease: 'out', speed: 0.5, stagger: 0, entrance: 'rise' };

describe('themeDefFromBrandKit', () => {
  it('is a valid ThemeDef, deterministic, and maps every role', () => {
    const a = themeDefFromBrandKit(kit());
    const b = themeDefFromBrandKit(kit());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(themeDefSchema.safeParse(a).success).toBe(true);
    expect(a).toMatchObject({
      name: 'brand-acme',
      description: 'Brand kit "Acme" v3',
      bg: '#101014',
      text: '#fafafa',
      stroke: '#fafafa',
      accent: '#ff5a1f',
      accentSignal: '#00b3a4',
      bgDeep: mixHex('#101014', '#fafafa', 0.06),
      fontDisplay: "'Acme Grotesk', system-ui, sans-serif",
      fontUi: "'Inter', system-ui, sans-serif",
      fontMono: "'Menlo', ui-monospace, Menlo, monospace",
      fonts: [{ family: 'Inter', weights: ['400', '600'] }],
      fontFiles: [{ family: 'Acme Grotesk', src: id('woff2', 'a'), weight: '800' }],
    });
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('a kit with only system fonts carries no fonts/fontFiles keys', () => {
    const def = themeDefFromBrandKit(starterKit('plain', 'Plain'));
    expect('fonts' in def).toBe(false);
    expect('fontFiles' in def).toBe(false);
  });

  it('embedded in a manifest, it loads and resolves (the render never needs the kit)', () => {
    const def = themeDefFromBrandKit(kit());
    const m = { ...structuredClone(sample), theme: def.name, themeDef: def } as Manifest;
    const parsed = manifestSchema.safeParse(m);
    expect(parsed.success).toBe(true);
    const theme = resolveManifestTheme(m);
    expect(theme.fontFiles?.[0].src).toBe(id('woff2', 'a'));
    expect(theme.accent).toBe('#ff5a1f');
  });
});

describe('the motion style', () => {
  it('only the shared-entrance primitives take entrance defaults', () => {
    expect(['image', 'icon', 'shape'].every(hasEntrance)).toBe(true);
    expect(hasEntrance('counter')).toBe(false);
    expect(hasEntrance('text')).toBe(false);
    expect(hasEntrance('group')).toBe(false);
    expect(brandLayerDefaults('icon', STYLE)).toEqual({ enter: 'rise', enterDur: 0.8 });
    expect(brandLayerDefaults('text', STYLE)).toEqual({});
    expect(brandLayerDefaults('icon', undefined)).toEqual({});
    expect(brandEase(STYLE)).toEqual([0.22, 1, 0.36, 1]);
  });

  it('restyle touches entrances and keyframe eases, and nothing when asked to restyle a document without them', () => {
    const base = addLayer(structuredClone(sample), 0, 'icon', { name: 'rocket', enter: 'fade' }).manifest;
    const layers = base.scenes[0].layers ?? [];
    (layers[0] as { transform?: unknown }).transform = { keys: [{ at: 0, x: 0 }, { at: 1, x: 10, ease: [0, 0, 1, 1] }] };
    const { manifest, report } = restyleManifest(base, kit().motion as MotionStyle);
    const icon = (manifest.scenes[0].layers ?? []).find((l) => l.use === 'icon') as { enter?: string; enterDur?: number };
    expect(icon).toMatchObject({ enter: 'pop', enterDur: 0.2 });
    const keys = (manifest.scenes[0].layers?.[0] as { transform: { keys: Array<{ ease?: unknown }> } }).transform.keys;
    expect(keys.every((k) => JSON.stringify(k.ease) === JSON.stringify([0.68, -0.55, 0.27, 1.55]))).toBe(true);
    expect(report).toEqual({ entrances: 1, keys: 2 });
    expect(base.scenes[0].layers?.find((l) => l.use === 'icon')).toMatchObject({ enter: 'fade' }); // input untouched
  });
});

function harness(brand?: MotionStyle) {
  const state = { manifest: structuredClone(sample) as Manifest };
  const commits: string[] = [];
  const api: MotionOpsApi = {
    loadState: 'ready',
    get manifest() {
      return state.manifest;
    },
    parseError: null,
    dirty: false,
    saveError: null,
    commit: (next, label) => {
      state.manifest = next;
      commits.push(label);
    },
    save: vi.fn() as unknown as MotionOpsApi['save'],
    render: vi.fn() as unknown as MotionOpsApi['render'],
    reloadFromDisk: vi.fn() as unknown as MotionOpsApi['reloadFromDisk'],
    renderStatus: IDLE_RENDER_STATUS,
  };
  const ops = createMotionOps({
    api: () => api,
    selections: () => [],
    setSelections: () => undefined,
    player: () => null,
    brandMotion: () => brand,
  });
  return { ops, state, commits };
}

describe('brand defaults in the Motion ops', () => {
  it('motion_add_layer takes the entrance as a default under the caller props', async () => {
    const h = harness(STYLE);
    await h.ops.motion_add_layer({ scene_index: 0, use: 'shape' });
    const shape = (h.state.manifest.scenes[0].layers ?? []).at(-1) as { enter?: string; enterDur?: number };
    expect(shape).toMatchObject({ enter: 'rise', enterDur: 0.8 });
    await h.ops.motion_add_layer({ scene_index: 0, use: 'shape', props: { enter: 'fade' } });
    expect((h.state.manifest.scenes[0].layers ?? []).at(-1)).toMatchObject({ enter: 'fade', enterDur: 0.8 });
    const none = harness(undefined);
    await none.ops.motion_add_layer({ scene_index: 0, use: 'shape' });
    expect((none.state.manifest.scenes[0].layers ?? []).at(-1)).not.toHaveProperty('enterDur');
  });

  it('a NEW keyframe with no ease takes the brand ease; an explicit ease and an existing key keep theirs', async () => {
    const h = harness(STYLE);
    const target = { scene_index: 0, target: { kind: 'layer', index: 0 } };
    const r = (await h.ops.motion_add_layer_keyframe({ ...target, at: 0.5, x: 0, y: 0 })) as Record<string, unknown>;
    expect(r.ease).toEqual([0.22, 1, 0.36, 1]);
    expect(r.easeFrom).toBe('brand kit');
    const r2 = (await h.ops.motion_add_layer_keyframe({ ...target, at: 1, x: 5, y: 5, ease: [0.1, 0.2, 0.3, 0.4] })) as Record<string, unknown>;
    expect(r2.ease).toEqual([0.1, 0.2, 0.3, 0.4]);
    const r3 = (await h.ops.motion_add_layer_keyframe({ ...target, at: 1, x: 9, y: 9 })) as Record<string, unknown>;
    expect(r3.ease).toBeNull();
  });
});

describe('applyBrandToMotion', () => {
  it('imports fonts and logos, embeds the theme in ONE commit, and is a no-op the second time', async () => {
    const h = harness();
    const imported: string[] = [];
    const deps = {
      manifest: () => h.state.manifest,
      commit: (next: Manifest, label: string) => {
        h.state.manifest = next;
        h.commits.push(label);
      },
      importAsset: async (path: string) => {
        imported.push(path);
        return { id: `sha256:${path.split('/').pop()}` };
      },
    };
    const req = { kit: kit(), assetsDir: '/p.chroma/brand/assets', options: {} };
    const out = await applyBrandToMotion(deps, req);
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(h.commits).toEqual(['Apply brand kit "Acme"']);
    expect(imported).toEqual([`/p.chroma/brand/assets/${'a'.repeat(64)}.woff2`, `/p.chroma/brand/assets/${'b'.repeat(64)}.svg`]);
    expect(h.state.manifest.theme).toBe('brand-acme');
    expect(h.state.manifest.themeDef).toEqual(themeDefFromBrandKit(kit()));

    const again = await applyBrandToMotion(deps, req);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(h.commits).toHaveLength(1);

    // An entrance-capable layer for the explicit restyle to change.
    h.state.manifest = addLayer(h.state.manifest, 0, 'icon', { name: 'rocket', enter: 'fade' }).manifest;
    const restyled = await applyBrandToMotion(deps, { ...req, options: { restyleExisting: true } });
    expect(restyled.ok).toBe(true);
    expect(h.commits).toHaveLength(2);
  });

  it('refuses a file that no longer matches its id, and no document', async () => {
    const h = harness();
    const deps = {
      manifest: () => h.state.manifest,
      commit: vi.fn(),
      importAsset: async () => ({ id: 'sha256:different.png' }),
    };
    const out = await applyBrandToMotion(deps, { kit: kit(), assetsDir: '/x', options: {} });
    expect(out.ok).toBe(false);
    expect(deps.commit).not.toHaveBeenCalled();
    const empty = await applyBrandToMotion({ ...deps, manifest: () => null }, { kit: kit(), assetsDir: '/x', options: {} });
    expect(empty).toEqual({ ok: false, error: 'no Motion document is loaded' });
  });
});
