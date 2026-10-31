/**
 * cli.ts — `npm run harness --workspace @apelles/ui-harness -- [options]` (D-434).
 *
 * Runs the scenario suite against the LIVE app (debug build — the input and
 * inspection tools it drives are compiled out of a release build) and writes
 * `report.md`, `report.json` and `shots/` under
 * `<out>/runs/<timestamp>/`. Exit code 0 when every scenario passed, 1 when
 * any failed or errored, 2 when the run could not start.
 *
 * Setup it does, and undoes: switches to the Edit tab, turns WebKit's
 * occlusion throttling off (so a covered window still runs frames to
 * measure), creates and opens a scratch project with generated test media,
 * and on the way out restores the throttling, reopens the project the app had
 * open, and deletes the scratch project. See docs/notes/ui-harness.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ControlClient, DEFAULT_CONTROL_PORT } from './client.ts';
import { ensureMedia, openScratchProject, restore, runDirs } from './fixture.ts';
import { renderReport, summarize } from './report.ts';
import { ScenarioRunner, type ScenarioResult } from './runner.ts';
import { SCENARIOS } from './scenarios/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/scratch/ui-harness` — gitignored, per the repo's scratch convention. */
const DEFAULT_OUT = resolve(HERE, '../../../scratch/ui-harness');

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: String(process.env.CHROMA_CONTROL_PORT ?? DEFAULT_CONTROL_PORT) },
      filter: { type: 'string', multiple: true },
      out: { type: 'string', default: DEFAULT_OUT },
      mode: { type: 'string', default: 'auto' },
      ffmpeg: { type: 'string', default: 'ffmpeg' },
      'keep-project': { type: 'boolean', default: false },
      'keep-throttling': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
    },
  });
  const filters = values.filter ?? [];
  const selected = SCENARIOS.filter((s) => filters.length === 0 || filters.some((f) => s.id.includes(f) || s.area.includes(f)));
  if (values.list) {
    for (const s of selected) console.log(`${s.id.padEnd(44)} ${s.area.padEnd(14)} ${s.title}`);
    return 0;
  }
  if (selected.length === 0) {
    console.error(`no scenario matches ${filters.join(', ')} (--list shows them)`);
    return 2;
  }

  const port = Number(values.port);
  const client = new ControlClient(port);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dirs = runDirs(values.out, stamp);
  mkdirSync(dirs.shots, { recursive: true });
  const notes: string[] = [];

  try {
    await client.op('editor_get_state');
  } catch (e) {
    console.error(String((e as Error).message));
    return 2;
  }

  await client.op('debug_set_active_tab', { tab: 'edit' });
  let throttlingBefore: boolean | null = null;
  try {
    const r = await client.op<{ before: boolean }>('debug_set_occlusion_throttling', { enabled: false });
    throttlingBefore = r.before;
  } catch (e) {
    notes.push(`occlusion throttling could not be turned off (${String((e as Error).message)}) — frame numbers from a covered window will read 0`);
  }

  const media = await ensureMedia(dirs.media, values.ffmpeg);
  const project = await openScratchProject(client, media, stamp);
  console.log(`scratch project ${project.path}; ${selected.length} scenario(s)`);

  const results: ScenarioResult[] = [];
  const runner = new ScenarioRunner(client, project, { mode: values.mode, shotsDir: dirs.shots });
  try {
    for (const scenario of selected) {
      const r = await runner.run(scenario);
      results.push(r);
      const perfOver = r.perf.filter((p) => !p.ok).length;
      console.log(`${r.status.padEnd(5)} ${scenario.id}${perfOver ? `  (perf over budget in ${perfOver} step(s))` : ''}${r.reason ? `  — ${r.reason}` : ''}`);
    }
  } finally {
    notes.push(...(await restore(client, project, { keep: values['keep-project'] })));
    if (throttlingBefore !== null && !values['keep-throttling']) {
      await client.op('debug_set_occlusion_throttling', { enabled: throttlingBefore }).catch(() => undefined);
    }
  }

  const meta = { startedAt: stamp, mode: values.mode, port, project: project.path, notes };
  writeFileSync(join(dirs.run, 'report.md'), renderReport(results, meta, dirs.run));
  writeFileSync(join(dirs.run, 'report.json'), JSON.stringify({ meta, summary: summarize(results), results }, null, 2));
  const s = summarize(results);
  console.log(`\n${s.pass}/${s.total} pass, ${s.fail} fail, ${s.skip} skip, ${s.error} error; perf over budget in ${s.perfOver}/${s.perfMeasured} measured steps`);
  console.log(`report: ${join(dirs.run, 'report.md')}`);
  return s.fail + s.error > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
