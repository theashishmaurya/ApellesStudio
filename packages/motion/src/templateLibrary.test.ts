/**
 * templateLibrary.test.ts — the built-in starters and the user library's
 * per-file robustness (D-407).
 */
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import { iconIssues, validateManifest } from '@apelles/motion-engine/src/engine/validate';
import { loadPhosphorIcons } from '@apelles/motion-engine/src/lib/phosphorIcons';
import { parseTemplate, type MotionTemplate } from '@apelles/motion-engine/src/templateDef';
import {
  BUILTIN_TEMPLATES,
  findTemplate,
  listTemplates,
  sanitizeLoadedTemplates,
  templateTags,
  upsertTemplate,
  versionForSave,
} from './templateLibrary';
import { planInstantiate } from './templates';

const HERE = dirname(fileURLToPath(import.meta.url));
/** loading ~1,500 icon modules takes seconds, and much longer cold on a busy
 *  machine (the whole package's suite runs in parallel). */
const ICON_LOAD_TIMEOUT_MS = 90_000;
let icons: ReadonlySet<string>;
beforeAll(async () => {
  icons = new Set((await loadPhosphorIcons()).keys());
}, ICON_LOAD_TIMEOUT_MS);

const userTemplate = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'my-card',
  name: 'My card',
  version: 2,
  kind: 'scene',
  authoredAt: { width: 1920, height: 1080, fps: 30 },
  slots: [{ id: 'title', type: 'text', label: 'Title', default: 'Hi' }],
  body: { dur: 2, layers: [{ use: 'text', text: { $slot: 'title' } }] },
  ...over,
});

const parsed = (raw: unknown): MotionTemplate => {
  const r = parseTemplate(raw);
  if (!('template' in r)) throw new Error(JSON.stringify(r.issues));
  return r.template;
};

describe('the built-in starters', () => {
  it('are the six founder-video templates, every JSON file in src/templates, each parsed', () => {
    const files = readdirSync(resolve(HERE, 'templates')).filter((f) => f.endsWith('.json'));
    expect(BUILTIN_TEMPLATES.map((t) => `${t.id}.json`).sort()).toEqual(files.sort());
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual([
      'logo-reveal',
      'feature-callout',
      'stat-counter',
      'testimonial',
      'pricing-card',
      'cta-end-card',
    ]);
  });

  it('use the Phase 1 primitives between them', () => {
    const uses = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.use === 'string') uses.add(o.use);
        Object.values(o).forEach(walk);
      }
    };
    BUILTIN_TEMPLATES.forEach((t) => walk(t.body));
    for (const u of ['image', 'icon', 'shape', 'counter', 'group', 'text']) expect(uses).toContain(u);
  });

  for (const canvas of [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
    { width: 1280, height: 720 },
  ]) {
    it(`each instantiates with its defaults at ${canvas.width}x${canvas.height} and validates, icons included`, () => {
      for (const t of BUILTIN_TEMPLATES) {
        const doc = manifestSchema.parse({ title: 't', ...canvas, scenes: [{ id: 'intro', dur: 1 }] });
        const plan = planInstantiate(doc, t, {}, {}, { iconNames: icons });
        expect(plan.ok, `${t.id}: ${plan.ok ? '' : plan.error}`).toBe(true);
        if (!plan.ok) continue;
        const v = validateManifest(plan.manifest);
        expect(v.issues, t.id).toEqual([]);
        expect(iconIssues(plan.manifest, icons), t.id).toEqual([]);
      }
    });
  }

  it('are theme-aware: no colour is written unless a colour slot sets one', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const doc = manifestSchema.parse({ title: 't', scenes: [{ id: 'intro', dur: 1 }] });
      const plan = planInstantiate(doc, t, {}, {});
      if (!plan.ok) throw new Error(plan.error);
      const text = JSON.stringify(plan.manifest.scenes[1]);
      expect(text, t.id).not.toMatch(/"(color|fill|stroke)":"#/);
      const accent = planInstantiate(doc, t, { accent: '#ff3366' }, {});
      expect(accent.ok && JSON.stringify(accent.manifest.scenes[1]), t.id).toContain('#ff3366');
    }
  });
});

describe('the user library', () => {
  it('keeps the good files and reports each bad one by name', () => {
    const r = sanitizeLoadedTemplates({
      entries: [
        { file: 'my-card.json', template: userTemplate() },
        { file: 'wrong-name.json', template: userTemplate({ id: 'other-card' }) },
        { file: 'stat-counter.json', template: userTemplate({ id: 'stat-counter' }) },
        { file: 'bad-shape.json', template: userTemplate({ id: 'bad-shape', kind: 'poster' }) },
        { file: 'bad-body.json', template: userTemplate({ id: 'bad-body', body: { dur: 2, layers: [{ use: 'text', text: { $slot: 'title' }, size: 'big' }] } }) },
      ],
      errors: [{ file: 'broken.json', error: 'not valid JSON: EOF' }],
    });
    expect(r.templates.map((t) => t.id)).toEqual(['my-card']);
    expect(r.errors.map((e) => e.file)).toEqual(['broken.json', 'wrong-name.json', 'stat-counter.json', 'bad-shape.json', 'bad-body.json']);
    expect(r.errors[1].error).toContain('other-card.json');
    expect(r.errors[2].error).toContain('built-in');
    expect(r.errors[3].error).toContain('kind');
    expect(r.errors[4].error).toContain('size');
  });

  it('lists built-ins then the library, filters by tag, finds by id', () => {
    const lib = [parsed(userTemplate({ tags: ['brand'] }))];
    const all = listTemplates(lib);
    expect(all.at(-1)).toMatchObject({ source: 'library', template: { id: 'my-card' } });
    expect(listTemplates(lib, 'brand').map((e) => e.template.id)).toEqual(['logo-reveal', 'cta-end-card', 'my-card']);
    expect(templateTags(lib)).toContain('pricing');
    expect(findTemplate('my-card', lib)?.source).toBe('library');
    expect(findTemplate('stat-counter', lib)?.source).toBe('builtin');
    expect(findTemplate('nope', lib)).toBeNull();
  });

  it('saving under an existing id makes the next version; a built-in id is refused', () => {
    const lib = [parsed(userTemplate())];
    const again = versionForSave(parsed(userTemplate({ version: 1, name: 'Renamed' })), lib);
    expect('template' in again && again.template.version).toBe(3);
    expect('template' in again && again.previousVersion).toBe(2);
    const fresh = versionForSave(parsed(userTemplate({ id: 'new-one', version: 1 })), lib);
    expect('template' in fresh && fresh.previousVersion).toBeNull();
    expect('error' in versionForSave(parsed(userTemplate({ id: 'logo-reveal' })), lib)).toBe(true);
    expect(upsertTemplate(lib, parsed(userTemplate({ version: 5 })))[0].version).toBe(5);
  });
});
