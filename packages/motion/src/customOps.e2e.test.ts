/**
 * D-409 — custom components end to end through the op layer the MCP tools
 * call: write (the REAL static check: TypeScript compiler API, allowlist, ban
 * list, strict type-check) → check (the proof plan) → certify → insert as data
 * (`motion_add_layer(use: "custom:<id>")`, and inside a group through
 * `motion_insert_layers`) → `motion_validate` → `motion_preview_frame`.
 *
 * The backend is an in-memory stand-in for `apelles_motion::components`
 * (storage, proof rendering, install) — the real one is exercised by its own
 * Rust tests and by `crates/apelles-motion/tests/component_render.rs`, which
 * renders what this test pins. The two example components it authors are the
 * shipped built-ins' sources (`crates/apelles-motion/tests/fixtures/components/`).
 *
 * Pinned to `crates/apelles-motion/tests/fixtures/` (regenerate after an
 * intended change with `APELLES_UPDATE_FIXTURES=1 npx vitest run
 * src/customOps.e2e.test.ts`): each example's proof plan
 * (`components/<id>/proof-plan.json`, what `certify_component` renders) and the
 * document built here (`custom-components.json`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { validateManifest } from '@apelles/motion-engine/src/engine/validate';
import { componentMetaSchema, type ComponentMeta, type ComponentSpec } from '@apelles/motion-engine/src/custom/componentDef';
import { checkComponentSource } from '@apelles/motion-engine/src/custom/sourceCheck.ts';
import { IDLE_RENDER_STATUS } from './renderLoop';
import { createMotionOps, type MotionOpsApi, type MotionPreviewRequest } from './motionOps';
import type { MotionComponentAccess } from './customComponentActions';
import { proxyManifest, type ListedComponent, type ProofPlan } from './customComponents';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../crates/apelles-motion/tests/fixtures');
const ENGINE = resolve(HERE, '../../motion-engine');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const example = (id: string) => ({
  source: readFileSync(resolve(FIXTURES, 'components', id, 'component.tsx'), 'utf8'),
  spec: JSON.parse(readFileSync(resolve(FIXTURES, 'components', id, 'spec.json'), 'utf8')) as ComponentSpec,
});

const pin = (name: string, doc: unknown) => {
  const path = resolve(FIXTURES, name);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.env.APELLES_UPDATE_FIXTURES) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, 'utf8'));
};

/** An in-memory `apelles_motion::components` with the real static check. */
function memoryBackend() {
  const versions: { meta: ComponentMeta; source: string; code: string }[] = [];
  const plans: ProofPlan[] = [];
  const installs: string[] = [];
  const entries = (): ListedComponent[] =>
    versions.map((v) => ({ id: v.meta.id, version: v.meta.version, source: 'library', dir: `/lib/${v.meta.id}/${v.meta.version}`, meta: v.meta }));
  const find = (id: string, version: number) => versions.find((v) => v.meta.id === id && v.meta.version === version);
  const access: MotionComponentAccess = {
    list: entries,
    loadErrors: () => [],
    reload: async () => undefined,
    read: async (id, version) => {
      const v = find(id, version);
      if (!v) throw new Error('missing');
      return { dir: `/lib/${id}/${version}`, meta: v.meta, source: v.source };
    },
    write: async (spec, source, dryRun) => {
      const report = checkComponentSource(source, ENGINE);
      const check = { ok: report.ok, issues: report.issues, warnings: report.warnings };
      if (!report.ok || dryRun || report.code === undefined) return { check };
      const mine = versions.filter((v) => v.meta.id === spec.id).sort((a, b) => b.meta.version - a.meta.version);
      const latest = mine[0];
      const replace = latest?.meta.status === 'draft';
      const version = latest ? (replace ? latest.meta.version : latest.meta.version + 1) : 1;
      const meta = componentMetaSchema.parse({
        ...spec,
        schemaVersion: 1,
        version,
        status: 'draft',
        sourceHash: sha256(source),
        codeHash: sha256(report.code),
        warnings: report.warnings,
      });
      if (replace) versions.splice(versions.indexOf(latest), 1);
      versions.push({ meta, source, code: report.code });
      return { check, draft: { id: spec.id, version, replaced: replace, dir: `/lib/${spec.id}/${version}`, meta } };
    },
    prove: async (id, version, plan) => {
      plans.push(plan);
      const v = find(id, version);
      if (!v) throw new Error('missing');
      const frames = plan.variants.flatMap((variant) => variant.frames.map((frame) => ({ variant: variant.name, frame, hashes: ['h', 'h', 'h'], same: true })));
      const proof = { ok: true, sourceHash: v.meta.sourceHash, codeHash: v.meta.codeHash, frames, passes: ['in order', 'backwards', 'scrambled'], contactSheet: 'contact.png', thumbnail: 'thumbnail.png' };
      if (v.meta.status === 'draft') v.meta = { ...v.meta, proof };
      return { proof, contactSheet: `/lib/${id}/${version}/contact.png`, thumbnail: `/lib/${id}/${version}/thumbnail.png`, recorded: v.meta.status === 'draft' };
    },
    certify: async (id, version) => {
      const v = find(id, version);
      if (!v) throw new Error('missing');
      v.meta = { ...v.meta, status: 'certified', certified: { sourceHash: v.meta.sourceHash, codeHash: v.meta.codeHash } };
      return v.meta;
    },
    remove: async (id, version) => {
      const before = versions.length;
      for (let i = versions.length - 1; i >= 0; i--) if (versions[i].meta.id === id && (version === null || versions[i].meta.version === version)) versions.splice(i, 1);
      return before - versions.length;
    },
    install: async (id, version) => {
      const v = find(id, version);
      if (!v) throw new Error('missing');
      installs.push(`${id}@${version}`);
      return { code: `sha256:${v.meta.codeHash}.js`, source: `sha256:${v.meta.sourceHash}.tsx`, codeHash: v.meta.codeHash, sourceHash: v.meta.sourceHash, meta: v.meta };
    },
  };
  return { access, plans, installs, versions };
}

function harness() {
  let manifest: Manifest = manifestSchema.parse({ title: 'Launch', fps: 30, scenes: [{ id: 'intro', dur: 3 }, { id: 'numbers', dur: 3 }] });
  const commits: string[] = [];
  const previews: MotionPreviewRequest[] = [];
  const backend = memoryBackend();
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
    components: () => backend.access,
  });
  const run = async (op: string, args: Record<string, unknown> = {}) => (await ops[op](args)) as Record<string, unknown>;
  return { run, commits, previews, backend, current: () => manifest };
}

const TYPECHECK = { timeout: 120_000 };

describe('D-409 — write → check → certify → use as data', TYPECHECK, () => {
  it('refuses banned code with line-precise issues and saves nothing', async () => {
    const h = harness();
    const { source, spec } = example('particle-logo-burst');
    const bad = source.replace('const frame = useCurrentFrame();', 'const frame = useCurrentFrame() + Math.random();');
    const r = await h.run('motion_write_component', { ...spec, source: bad });
    expect(r.error).toMatch(/did not pass the static check/);
    const issues = r.issues as { path: string; code: string; hint?: string }[];
    expect(issues).toEqual([expect.objectContaining({ code: 'banned_random', path: expect.stringMatching(/^source:\d+:\d+$/) })]);
    expect(issues[0].hint).toMatch(/random\(seed\)/);
    expect(h.backend.versions).toHaveLength(0);
  });

  it('refuses a colour prop with a hard-coded default (the theme rule) before checking any code', async () => {
    const h = harness();
    const { source, spec } = example('particle-logo-burst');
    const props = spec.props.map((p) => (p.id === 'color' ? { ...p, default: '#ff0000' } : p));
    const r = await h.run('motion_write_component', { ...spec, props, source });
    expect(r.issues).toEqual([expect.objectContaining({ path: 'props[4].default', code: 'colour_default' })]);
  });

  it('authors both examples, certifies them explicitly, inserts them as data, validates and previews', async () => {
    const h = harness();
    for (const id of ['particle-logo-burst', 'bar-line-chart']) {
      const { source, spec } = example(id);
      const w = await h.run('motion_write_component', { ...spec, source });
      expect(w.error).toBeUndefined();
      expect(w).toMatchObject({ id, version: 1, status: 'draft' });
      expect(w.warnings).toEqual([]);

      // Certification is explicit and needs a passing check first.
      expect((await h.run('motion_certify_component', { id })).error).toMatch(/has not been checked/);
      const c = await h.run('motion_check_component', { id });
      expect(c).toMatchObject({ ok: true, id, version: 1, recorded: true });
      expect(h.backend.access.list().find((e) => e.id === id)?.meta.status).toBe('draft');
      const cert = await h.run('motion_certify_component', { id });
      expect(cert).toMatchObject({ certified: true, use: `custom:${id}@1`, component: `${id}@1` });
      expect((await h.run('motion_certify_component', { id })).error).toMatch(/already certified/);
    }

    // The proof plans: three variants x four frames, each a document that loads.
    const [burstPlan, chartPlan] = h.backend.plans;
    for (const plan of [burstPlan, chartPlan]) {
      expect(plan.variants.map((v) => v.name)).toEqual(['defaults', 'min', 'max']);
      expect(plan.variants.every((v) => v.frames.length === 4)).toBe(true);
      expect(validateManifest(plan.manifest).issues).toEqual([]);
    }
    pin('components/particle-logo-burst/proof-plan.json', burstPlan);
    pin('components/bar-line-chart/proof-plan.json', chartPlan);

    // Editing a certified component makes a new draft; v1 stays as it was.
    const { source, spec } = example('bar-line-chart');
    const v2 = await h.run('motion_write_component', { ...spec, source: source.replace('damping: 15', 'damping: 18') });
    expect(v2).toMatchObject({ version: 2, status: 'draft', replaced: false });
    expect(h.backend.access.list().find((e) => e.id === 'bar-line-chart' && e.version === 1)?.meta.status).toBe('certified');

    // The catalog lists only certified versions, with a layer schema.
    const prims = await h.run('motion_list_primitives');
    const custom = prims.customComponents as { use: string; propsSchema: { properties: Record<string, unknown> } }[];
    expect(custom.map((c) => c.use)).toEqual(['custom:particle-logo-burst@1', 'custom:bar-line-chart@1']);
    expect(Object.keys(custom[0].propsSchema.properties)).toContain('props');
    const listed = await h.run('motion_list_components');
    const chartRow = (listed.components as { id: string; use: string; latestStatus: string }[]).find((c) => c.id === 'bar-line-chart');
    expect(chartRow).toMatchObject({ use: 'custom:bar-line-chart@1', latestStatus: 'draft' });

    // Props are checked against the declaration, path-precise.
    const badProps = await h.run('motion_add_layer', { scene_index: 0, use: 'custom:particle-logo-burst', props: { count: 9999 } });
    expect(badProps.issues).toEqual([expect.objectContaining({ path: 'props.count', code: 'too_big' })]);
    // A draft cannot be pinned.
    expect((await h.run('motion_add_layer', { scene_index: 0, use: 'custom:bar-line-chart@2' })).error).toMatch(/draft|no certified/);

    // Insert as data: one layer, then the chart inside a group with a keyframed prop.
    const add = await h.run('motion_add_layer', { scene_index: 0, use: 'custom:particle-logo-burst', props: { text: 'ACME', seed: 42 } });
    expect(add).toMatchObject({ addedUse: 'custom', component: 'particle-logo-burst@1' });
    const ins = await h.run('motion_insert_layers', {
      scene_index: 1,
      layers: [
        {
          use: 'group',
          id: 'chart-card',
          at: 0.2,
          children: [
            {
              use: 'custom',
              id: 'chart',
              component: 'bar-line-chart@1',
              x: 160,
              y: 90,
              props: { title: 'Revenue ($k)', values: [8, 14, 11, 22, 31], labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] },
              anim: { 'props.barColor': [{ at: 0, v: '#38bdf8' }, { at: 2, v: '#a78bfa' }] },
            },
          ],
        },
      ],
    });
    expect(ins.error).toBeUndefined();
    expect(h.backend.installs).toEqual(['particle-logo-burst@1', 'bar-line-chart@1']);
    const doc = h.current();
    expect(Object.keys(doc.components ?? {})).toEqual(['particle-logo-burst@1', 'bar-line-chart@1']);
    expect(doc.components?.['bar-line-chart@1'].code).toMatch(/^sha256:[0-9a-f]{64}\.js$/);

    // A track on a text prop is refused by the schema, path-precise.
    const badTrack = await h.run('motion_insert_layers', {
      scene_index: 1,
      layers: [{ use: 'custom', component: 'bar-line-chart@1', anim: { 'props.title': [{ at: 0, v: 1 }] } }],
    });
    expect(JSON.stringify(badTrack.issues)).toMatch(/props\.title/);

    const v = await h.run('motion_validate', { manifest: doc });
    expect(v).toMatchObject({ ok: true, loads: true });

    const p = await h.run('motion_preview_frame', { scene_index: 1, at_seconds: [0.5, 2.5] });
    expect(p.error).toBeUndefined();
    expect(h.previews[0].manifest.components).toEqual(doc.components);
    pin('custom-components.json', doc);

    // The live player's proxy for the chart layer: a one-layer, transparent
    // document the size of its box, its colour track shifted to the layer's own
    // time (the group starts at 0.2 s, the layer at 0), and box/transform left
    // to the player. `component_render.rs` renders it as the backend would.
    const group = doc.scenes[1].layers?.[0] as unknown as { children: Record<string, unknown>[] };
    const chartRaw = group.children[0];
    const proxy = proxyManifest(doc, doc.components!['bar-line-chart@1'], chartRaw, 30);
    expect(proxy).toMatchObject({ width: 1600, height: 900, transparent: true, fps: 30 });
    expect(validateManifest(proxy).issues).toEqual([]);
    pin('custom-proxy.json', proxy);

    // Deleting from the library leaves the document's copy alone.
    expect(await h.run('motion_delete_component', { id: 'bar-line-chart' })).toMatchObject({ removed: 2 });
    expect(validateManifest(h.current()).ok).toBe(true);
  });
});
