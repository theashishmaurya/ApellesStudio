import { describe, expect, it } from 'vitest';
import {
  BRAND_KIT_SCHEMA_VERSION,
  kitAssetIds,
  parseBrandKit,
  referenceIdFor,
  starterKit,
  versionForSave,
  type BrandKit,
} from './kit';
import { checkKitContrast, contrastLevel, contrastRatio, contrastWarnings, relativeLuminance } from './contrast';
import { mergeKitPatch, sanitizeLoadedKits } from './library';
import { addReference, referencesForAgent } from './references';

const HEX = 'a'.repeat(64);
const id = (ext: string, c = 'a') => `sha256:${c.repeat(64)}.${ext}`;

const full = (): BrandKit => ({
  ...starterKit('acme', 'Acme'),
  typography: {
    display: { family: 'Acme Grotesk', source: 'file', file: id('ttf'), licence: 'Desktop + video licence, 2026', weights: ['700'] },
    body: { family: 'Inter', source: 'google', weights: ['400', '600'] },
  },
  logos: { light: id('svg', 'b'), dark: id('png', 'c') },
  look: { lut: id('cube', 'd'), intensity: 80 },
  sound: { sonicLogo: id('wav', 'e'), music: { mood: 'warm', bpm: [90, 110] } },
  references: [{ id: 'reel', asset: id('mp4', 'f'), note: 'use my work for materials and framing', kind: 'own-work' }],
});

describe('the kit schema (D-416)', () => {
  it('accepts a complete kit and the starter', () => {
    expect('kit' in parseBrandKit(full())).toBe(true);
    expect('kit' in parseBrandKit(starterKit('x', 'X'))).toBe(true);
  });

  it('refuses with paths: an unknown key, a bad colour, a file font without its licence or file', () => {
    const bad = { ...full(), colour: '#fff' } as unknown;
    const r1 = parseBrandKit(bad);
    expect('error' in r1 && r1.issues.some((i) => i.path === '(kit)' || i.message.includes('colour'))).toBe(true);

    const r2 = parseBrandKit({ ...full(), colors: { ...full().colors, primary: 'red' } });
    expect('error' in r2 && r2.issues[0].path).toBe('colors.primary');

    const k = full();
    const r3 = parseBrandKit({ ...k, typography: { ...k.typography, display: { family: 'X', source: 'file' } } });
    expect('error' in r3 && r3.issues.map((i) => i.path).sort()).toEqual(['typography.display.file', 'typography.display.licence']);

    const r4 = parseBrandKit({ ...k, typography: { ...k.typography, body: { family: 'Y', source: 'system', file: id('ttf') } } });
    expect('error' in r4 && r4.issues[0].path).toBe('typography.body.file');
  });

  it('asset ids are content hashes of the right kind, never paths', () => {
    const k = full();
    expect('error' in parseBrandKit({ ...k, logos: { light: '/Users/me/logo.png' } })).toBe(true);
    expect('error' in parseBrandKit({ ...k, logos: { light: id('ttf') } })).toBe(true);
    expect('error' in parseBrandKit({ ...k, look: { lut: id('png'), intensity: 50 } })).toBe(true);
  });

  it('migration refuses a newer schema and versions only ever go up', () => {
    const r = parseBrandKit({ ...full(), schemaVersion: BRAND_KIT_SCHEMA_VERSION + 1 });
    expect('error' in r && r.error).toMatch(/update Apelles/);
    expect(versionForSave(undefined)).toBe(1);
    expect(versionForSave(4)).toBe(5);
  });

  it('lists every asset a project copy must carry, sorted, without repeats', () => {
    const k = full();
    k.logos = { light: id('svg', 'b'), dark: id('svg', 'b') };
    expect(kitAssetIds(k)).toEqual([id('ttf'), id('svg', 'b'), id('cube', 'd'), id('wav', 'e'), id('mp4', 'f')].sort());
    expect(HEX.length).toBe(64);
  });

  it('a reference gets a deterministic, unique id and a resolved path', () => {
    expect(referenceIdFor('My Reel (final).MP4', [])).toBe('my-reel-final');
    expect(referenceIdFor('My Reel.mov', ['my-reel', 'my-reel-2'])).toBe('my-reel-3');
    const k = addReference(full(), { asset: id('png', '1'), note: 'type and hierarchy', kind: 'reference', name: 'poster.png' });
    expect(k.references?.map((r) => r.id)).toEqual(['reel', 'poster']);
    expect('kit' in parseBrandKit(k)).toBe(true);
    const refs = referencesForAgent(k, '/p/brand/assets/');
    expect(refs[0]).toMatchObject({ media: 'video', path: `/p/brand/assets/${'f'.repeat(64)}.mp4`, kind: 'own-work' });
    expect(refs[1]).toMatchObject({ media: 'image', note: 'type and hierarchy' });
  });
});

describe('the library rules', () => {
  it('a bad file drops itself with a named error; the rest load, sorted by name', () => {
    const out = sanitizeLoadedKits({
      kits: [
        { file: 'zeta.json', kit: { ...starterKit('zeta', 'Zeta') } },
        { file: 'alpha.json', kit: { ...starterKit('alpha', 'Alpha') } },
        { file: 'broken.json', kit: { id: 'broken', name: 'B' } },
      ],
      errors: [{ file: 'notjson.json', error: 'not valid JSON' }],
    });
    expect(out.kits.map((k) => k.id)).toEqual(['alpha', 'zeta']);
    expect(out.loadErrors.map((e) => e.file)).toEqual(['notjson.json', 'broken.json']);
    expect(out.loadErrors[1].error).toMatch(/schemaVersion|colors/);
  });

  it('a patch merges objects, replaces lists, removes on null and never touches id/version', () => {
    const k = full();
    const merged = mergeKitPatch(k, { id: 'other', version: 99, colors: { accent: '#ff0000' }, look: null, references: [] }) as BrandKit;
    expect(merged.id).toBe('acme');
    expect(merged.version).toBe(1);
    expect(merged.colors.accent).toBe('#ff0000');
    expect(merged.colors.primary).toBe(k.colors.primary);
    expect(merged.look).toBeUndefined();
    expect(merged.references).toEqual([]);
  });
});

describe('the contrast check (WCAG 2.2)', () => {
  it('matches the reference values', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    // #767676 on white is the classic smallest AA grey (4.54:1)
    expect(contrastRatio('#767676', '#ffffff')).toBe(4.54);
    expect(contrastLevel(4.54)).toBe('AA');
    expect(contrastLevel(3.2)).toBe('AA-large');
    expect(contrastLevel(7)).toBe('AAA');
  });

  it('checks every pair and words the failures', () => {
    const colors = { primary: '#2f6fed', secondary: '#1b2a4a', accent: '#f5a524', background: '#0f1115', text: '#f4f4f5' };
    const pairs = checkKitContrast(colors);
    expect(pairs.map((p) => p.pair)).toEqual([
      'text on background',
      'primary on background',
      'accent on background',
      'secondary on background',
      'background on primary',
    ]);
    expect(pairs[0].ok).toBe(true);
    expect(pairs[3].ok).toBe(false); // a dark navy on near-black
    expect(contrastWarnings(colors).some((w) => w.startsWith('secondary on background'))).toBe(true);
    expect(checkKitContrast(colors)).toEqual(pairs); // deterministic
  });
});
