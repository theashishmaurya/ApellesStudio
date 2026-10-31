/**
 * report.ts — a run, written down (D-434).
 *
 * What it is: the markdown report a human (or the next agent) reads after a
 *   run — a summary table, then per scenario its verdict, every check with its
 *   own message, every measured step's numbers against budget, and links to
 *   its screenshots. Pure: `renderReport` turns results into a string, and is
 *   unit-tested; the CLI writes it beside `report.json`.
 *
 * What it does NOT do: judge. Verdicts come from the runner.
 */

import { relative } from 'node:path';

import { DROPPED_RATIO_BUDGET, FIRST_COMMIT_BUDGET_MS, FRAME_BUDGET_MS, FRAME_MAX_BUDGET_MS, FRAME_P95_BUDGET_MS, INPUT_TO_FRAME_P95_BUDGET_MS, PLAYBACK_PAINT_MIN_FPS, PLAYBACK_RAF_MIN_FPS } from './budgets.ts';
import type { ScenarioResult, Status } from './runner.ts';

export interface RunMeta {
  startedAt: string;
  mode: string;
  port: number;
  project: string;
  notes: string[];
}

const ICON: Record<Status, string> = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', ERROR: 'ERROR' };
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const r1 = (n: number) => Math.round(n * 10) / 10;

export function summarize(results: readonly ScenarioResult[]) {
  const by = (s: Status) => results.filter((r) => r.status === s).length;
  const perfSteps = results.flatMap((r) => r.perf);
  return {
    total: results.length,
    pass: by('PASS'),
    fail: by('FAIL'),
    skip: by('SKIP'),
    error: by('ERROR'),
    perfMeasured: perfSteps.length,
    perfOver: perfSteps.filter((p) => !p.ok).length,
  };
}

export function renderReport(results: readonly ScenarioResult[], meta: RunMeta, baseDir: string): string {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push(`# Timeline UI harness — ${meta.startedAt}`, '');
  lines.push(
    `**${s.pass}/${s.total} pass** · ${s.fail} fail · ${s.skip} skip · ${s.error} error · perf: ${s.perfMeasured - s.perfOver}/${s.perfMeasured} measured steps within budget`,
    '',
  );
  lines.push(`Input mode \`${meta.mode}\` · control port ${meta.port} · scratch project \`${meta.project}\``, '');
  lines.push(
    `Budgets (D-434, \`packages/ui-harness/src/budgets.ts\`): frame ${r1(FRAME_BUDGET_MS)} ms; p95 ≤ ${r1(FRAME_P95_BUDGET_MS)} ms; worst ≤ ${FRAME_MAX_BUDGET_MS} ms (the move phase of a gesture; the release frame is held to the same ${FRAME_MAX_BUDGET_MS} ms on its own); dropped ≤ ${DROPPED_RATIO_BUDGET * 100}%; input→frame p95 ≤ ${INPUT_TO_FRAME_P95_BUDGET_MS} ms; input→store ≤ ${FIRST_COMMIT_BUDGET_MS} ms where checked; playback paint ≥ ${PLAYBACK_PAINT_MIN_FPS} fps, play loop ≥ ${PLAYBACK_RAF_MIN_FPS} fps.`,
    '',
  );
  if (meta.notes.length) {
    lines.push('Notes:', ...meta.notes.map((n) => `- ${n}`), '');
  }

  lines.push('| | scenario | area | checks | perf |', '|---|---|---|---|---|');
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.ok).length;
    const perfOver = r.perf.filter((p) => !p.ok).length;
    lines.push(
      `| ${ICON[r.status]} | [${cell(r.title)}](#${r.id}) | ${cell(r.area)} | ${r.checks.length - failed}/${r.checks.length} | ${r.perf.length ? `${r.perf.length - perfOver}/${r.perf.length}` : '—'} |`,
    );
  }
  lines.push('');

  for (const r of results) {
    lines.push(`## <a id="${r.id}"></a>${ICON[r.status]} — ${r.title}`, '');
    lines.push(`\`${r.id}\` · ${r.area} · ${(r.durationMs / 1000).toFixed(1)} s`, '');
    lines.push(`Expected (reference): ${r.reference}`, '');
    if (r.reason) lines.push(`**${r.status === 'SKIP' ? 'Skipped' : 'Stopped'}:** ${r.reason}`, '');
    if (r.checks.length) {
      for (const c of r.checks) lines.push(`- ${c.ok ? '✓' : '✗'} step ${c.step}: ${c.message}`);
      lines.push('');
    }
    if (r.perf.length) {
      lines.push('| measured step | verdict | numbers |', '|---|---|---|');
      for (const p of r.perf) {
        const nums = Object.entries(p.numbers)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ');
        lines.push(`| ${cell(p.label)} | ${p.ok ? 'within budget' : `OVER: ${cell(p.misses.join('; '))}`} | ${cell(nums)} |`);
      }
      lines.push('');
    }
    for (const shot of r.screenshots) lines.push(`![${r.id}](${relative(baseDir, shot)})`, '');
  }
  return lines.join('\n');
}
