/**
 * D-416 — the brand-kit determinism fixture, built by the real applier.
 *
 * Takes the agent-built brand scene (`brand-scene.json`, D-405), applies a brand
 * kit to it through `applyBrandToMotion` (its display face a real font FILE,
 * `brand-font.ttf`: Kenney Pixel, CC0, re-saved by `make_brand_font.py` so
 * Chrome's font sanitizer accepts it; its logo the fixture logo;
 * `restyle_existing` on),
 * and pins the result to `crates/apelles-motion/tests/fixtures/brand-kit.json`,
 * which `preview_render.rs` renders for real, twice. The asset ids are computed
 * here exactly as the Rust importer computes them (SHA-256 of the bytes + the
 * extension), and the Rust test asserts the fixture names the ids its own
 * importer produces. Update with
 * `APELLES_UPDATE_FIXTURES=1 npx vitest run src/brandKit.e2e.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { starterKit, type BrandKit } from '@apelles/brand';
import { applyBrandToMotion } from './brandApply';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../crates/apelles-motion/tests/fixtures');
const PINNED = resolve(FIXTURES, 'brand-kit.json');

const idOf = (file: string) => {
  const hex = createHash('sha256').update(readFileSync(resolve(FIXTURES, file))).digest('hex');
  return `sha256:${hex}.${file.slice(file.lastIndexOf('.') + 1)}`;
};

describe('a brand kit applied to the brand scene (the render fixture)', () => {
  it('is one commit, valid, and pinned', async () => {
    const font = idOf('brand-font.ttf');
    const logo = idOf('logo.svg');
    const kit: BrandKit = {
      ...starterKit('pixel-co', 'Pixel Co'),
      colors: { primary: '#ffcc00', secondary: '#3a2e8f', accent: '#ff3d7f', background: '#14112b', text: '#f6f3ff' },
      typography: {
        display: { family: 'Kenney Pixel', source: 'file', file: font, licence: 'CC0 1.0 (Kenney)' },
        body: { family: 'Helvetica', source: 'system', editFallback: 'sans' },
      },
      logos: { light: logo },
      motion: { ease: 'inOut', speed: 1.5, stagger: 0.05, entrance: 'pop' },
    };
    let manifest = manifestSchema.parse(JSON.parse(readFileSync(resolve(FIXTURES, 'brand-scene.json'), 'utf8'))) as Manifest;
    const commits: string[] = [];
    const out = await applyBrandToMotion(
      {
        manifest: () => manifest,
        commit: (next, label) => {
          manifest = next;
          commits.push(label);
        },
        // The project's brand copy is named by content, so re-importing it into
        // the Motion store gives the same id (what the Rust importer does).
        importAsset: async (path) => ({ id: `sha256:${path.split('/').pop()}` }),
      },
      { kit, assetsDir: '/p.chroma/brand/assets', options: { restyleExisting: true } },
    );
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(commits).toEqual(['Apply brand kit "Pixel Co"']);
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.themeDef?.fontFiles).toEqual([{ family: 'Kenney Pixel', src: font, weight: '400' }]);

    const doc = `${JSON.stringify(manifest, null, 2)}\n`;
    if (process.env.APELLES_UPDATE_FIXTURES) writeFileSync(PINNED, doc);
    expect(doc).toBe(readFileSync(PINNED, 'utf8'));
  });
});
