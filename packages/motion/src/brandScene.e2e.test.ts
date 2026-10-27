/**
 * D-405 — the end-to-end proof that an agent can build a NEW motion graphic
 * purely as data: a "logo reveal + stat counter + icon row" scene, built
 * through the op layer (the exact functions the MCP tools call), validated,
 * and previewed.
 *
 * The chain, all real except the two Tauri calls:
 *   1. `motion_import_asset` — the logo's id is its SHA-256 + extension,
 *      computed here with node's crypto exactly as `apelles_motion::assets`
 *      computes it (the Rust test renders with the Rust importer and gets the
 *      same id, or the image would not resolve);
 *   2. `motion_set_scene` appends the scene, `motion_insert_layers` lands the
 *      whole graphic in one undo step (a masked group wiping the logo card in,
 *      a counter, three Phosphor icons with a drawn underline);
 *   3. `motion_validate` reports it clean, icon names included;
 *   4. `motion_preview_frame` hands the backend the document and frames.
 *
 * The document handed to the preview is pinned to
 * `crates/apelles-motion/tests/fixtures/brand-scene.json`, which
 * `crates/apelles-motion/tests/preview_render.rs` renders for real through
 * Remotion (twice, comparing hashes). Regenerate it after an intended change
 * with `APELLES_UPDATE_FIXTURES=1 npx vitest run src/brandScene.e2e.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { IDLE_RENDER_STATUS } from './renderLoop';
import { createMotionOps, type MotionOpsApi, type MotionPreviewRequest } from './motionOps';
import type { MotionAssetRecord } from './manifestIO';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../crates/apelles-motion/tests/fixtures');
const LOGO = resolve(FIXTURES, 'logo.svg');
const PINNED = resolve(FIXTURES, 'brand-scene.json');

function harness() {
  let manifest: Manifest = manifestSchema.parse({ title: 'Brand reel', fps: 30, scenes: [{ id: 'intro', dur: 1 }] });
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
      return { path: '/p.chroma/motion/previews/brand.png', width: 960, height: 540, columns: req.frames.length, rows: 1 };
    },
    // The Rust importer's contract: id = sha256 of the bytes + the extension.
    importAsset: async (path): Promise<MotionAssetRecord> => {
      const bytes = readFileSync(path);
      const hex = createHash('sha256').update(bytes).digest('hex');
      return { id: `sha256:${hex}.svg`, fileName: `${hex}.svg`, path: `/p.chroma/motion/assets/${hex}.svg`, bytes: bytes.length, copied: true, width: null, height: null };
    },
  });
  const run = async (op: string, args: Record<string, unknown> = {}) => (await ops[op](args)) as Record<string, unknown>;
  return { run, commits, previews, current: () => manifest };
}

/** The graphic, as an agent writes it: whole layers, every one named. */
function brandLayers(logoId: string) {
  const ease = [0.16, 1, 0.3, 1];
  return [
    {
      use: 'group',
      id: 'logo-reveal',
      at: 0.1,
      // A wipe: the mask's width animates from 0 to the full card.
      mask: { kind: 'roundrect', x: 560, y: 140, w: 0, h: 420, radius: 48 },
      anim: { 'mask.w': [{ at: 0, v: 0 }, { at: 0.8, v: 800, ease }] },
      children: [
        {
          use: 'shape',
          shape: 'roundrect',
          x: 560,
          y: 140,
          w: 800,
          h: 420,
          radius: 48,
          enter: 'none',
          gradient: { type: 'linear', angle: 25, stops: [{ at: 0, color: '#1d2433' }, { at: 1, color: '#3a2a5c' }] },
        },
        { use: 'image', src: logoId, x: 610, y: 190, w: 320, h: 320, fit: 'contain', enter: 'pop', at: 0.3 },
        { use: 'text', text: 'Acme Labs', x: 960, y: 310, size: 64, preset: 'fade-up', at: 0.5, color: '#ffffff' },
      ],
    },
    {
      use: 'counter',
      id: 'stat',
      at: 1.0,
      dur: 1.2,
      from: 0,
      to: 12500,
      suffix: '+',
      thousands: true,
      size: 150,
      x: 960,
      y: 640,
      align: 'center',
      color: '#f5c542',
      anim: { color: [{ at: 1.0, v: '#ffffff' }, { at: 2.2, v: '#f5c542' }] },
    },
    { use: 'text', id: 'stat-label', text: 'teams shipping faster', x: 960, y: 800, size: 40, align: 'center', preset: 'fade-up', at: 1.4 },
    { use: 'icon', id: 'icon-1', name: 'rocket-launch', weight: 'duotone', size: 96, x: 732, y: 880, color: '#ffffff', at: 1.8, enter: 'pop' },
    { use: 'icon', id: 'icon-2', name: 'lightning', weight: 'duotone', size: 96, x: 912, y: 880, color: '#ffffff', at: 2.0, enter: 'pop' },
    { use: 'icon', id: 'icon-3', name: 'shield-check', weight: 'duotone', size: 96, x: 1092, y: 880, color: '#ffffff', at: 2.2, enter: 'pop' },
    { use: 'shape', id: 'underline', shape: 'line', x: 700, y: 1000, w: 520, h: 0, stroke: '#f5c542', strokeWidth: 6, at: 2.4, enter: 'draw', enterDur: 0.6 },
  ];
}

// The first test to need icon names loads the whole Phosphor library (a second or two).
describe('D-405 — an agent builds "logo reveal + stat counter + icon row" as data', { timeout: 20_000 }, () => {
  it('imports, inserts in one step, validates clean and previews', async () => {
    const h = harness();

    const asset = await h.run('motion_import_asset', { path: LOGO });
    expect(asset.id).toMatch(/^sha256:[0-9a-f]{64}\.svg$/);

    const scene = await h.run('motion_set_scene', { scene_index: 1, scene: { id: 'brand', dur: 4, bg: '#0b0d12' } });
    expect(scene).toMatchObject({ appended: true, sceneId: 'brand' });

    const inserted = await h.run('motion_insert_layers', { scene_index: 1, layers: brandLayers(String(asset.id)) });
    expect(inserted.error).toBeUndefined();
    expect(inserted.count).toBe(7);
    expect(h.commits).toEqual(['Add scene', 'Insert 7 layers']);

    const checked = await h.run('motion_validate');
    expect(checked).toMatchObject({ ok: true, loads: true, issues: [] });

    const preview = await h.run('motion_preview_frame', { scene_index: 1, at_seconds: [0.4, 1.6, 3.5] });
    expect(preview.error).toBeUndefined();
    const req = h.previews[0];
    expect(req.frames).toEqual([30 + 12, 30 + 48, 30 + 105]);

    const doc = `${JSON.stringify(req.manifest, null, 2)}\n`;
    if (process.env.APELLES_UPDATE_FIXTURES) writeFileSync(PINNED, doc);
    expect(doc).toBe(readFileSync(PINNED, 'utf8'));
  });

  it('a typo anywhere in the graphic is refused with a usable issue, and nothing lands', async () => {
    const h = harness();
    await h.run('motion_set_scene', { scene_index: 1, scene: { id: 'brand', dur: 4 } });
    const layers = brandLayers(`sha256:${'0'.repeat(64)}.svg`);
    (layers[3] as Record<string, unknown>).name = 'rocket-lauch';
    ((layers[0] as { children: Record<string, unknown>[] }).children[0]).fil = '#000';
    const r = await h.run('motion_insert_layers', { scene_index: 1, layers });
    const issues = r.issues as { path: string; code: string; hint?: string }[];
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'layers[3].name', code: 'unknown_icon', hint: 'did you mean "rocket-launch"?' }),
        expect.objectContaining({ path: 'layers[0].children[0].fil', code: 'unrecognized_key', hint: 'did you mean "fill"?' }),
      ]),
    );
    expect(h.commits).toEqual(['Add scene']);
  });

  it('the per-primitive render fixture is a valid manifest (icon names included)', async () => {
    const text = readFileSync(resolve(FIXTURES, 'brand-primitives.json'), 'utf8').replace('LOGO_HASH', '0'.repeat(64));
    const h = harness();
    const r = await h.run('motion_validate', { manifest: JSON.parse(text) });
    expect(r).toMatchObject({ ok: true, loads: true, issues: [] });
  });
});
