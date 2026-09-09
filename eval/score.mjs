#!/usr/bin/env node
// score.mjs — the CI-able regression gate for Apelles' grading agent.
//
//   node eval/score.mjs [resultsDir]   score grade.json / result.png files
//   node eval/score.mjs --baseline     (re)write eval/baseline.json — the floor
//   node eval/score.mjs --scopes       dump computeScopes for every fixture
//
// Runs with NO app and NO agent. For each task it needs a *result*, resolved in
// priority order:
//   1. <resultsDir>/<id>.result.png   — a real render (from eval/run.md's loop)
//   2. <resultsDir>/<id>.grade.json   — applied to the task's input fixture with
//                                       eval/lib/apply.mjs (approximate operator)
//   3. --baseline                     — identity: the unfixed setup grade (floor)
//
// Score in [0,1] = mean of per-check scores, each the normalised inverse of the
// residual gap: 1 when the metric is within tolerance, 0 when it is no better
// than the unfixed baseline, linear between. Hard-fail gates (clipping
// introduced, background moved on a mask task, over-grade) zero the task.
// See docs/notes/eval-harness.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './lib/png.mjs';
import { computeScopes, computeGap, gapMagnitude } from './lib/scopes.mjs';
import { applyGrade, knobEffort } from './lib/apply.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rd = (p) => decodePNG(fs.readFileSync(path.resolve(DIR, p)));
const num = (v) => Math.round(v * 1000) / 1000;

/* ------------------------------------------------------------- metrics --- */
// A metric fn gets { result, resultScopes, input, inputScopes, ref, refScopes,
// grade, check } and returns a number (lower = better, always >= 0).
function regionMean(img, [x, y, w, h]) {
  const { width, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * width + xx) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  n = n || 1;
  return [r / n, g / n, b / n];
}

const METRICS = {
  blackPoint: (c) => c.resultScopes.blackPoint,
  whitePoint: (c) => c.resultScopes.whitePoint,
  clipLowPct: (c) => c.resultScopes.clipLowPct,
  clipHighPct: (c) => c.resultScopes.clipHighPct,
  midsLuma: (c) => c.resultScopes.zones.mids.luma,
  saturation: (c) => c.resultScopes.saturation,
  castWarmCoolAbs: (c) => Math.abs(c.resultScopes.cast.warmCool),
  castGreenMagentaAbs: (c) => Math.abs(c.resultScopes.cast.greenMagenta),

  midsLumaDeltaToRef: (c) => Math.abs(c.resultScopes.zones.mids.luma - c.refScopes.zones.mids.luma),
  castWarmCoolDeltaToRef: (c) => Math.abs(c.resultScopes.cast.warmCool - c.refScopes.cast.warmCool),
  castGreenMagentaDeltaToRef: (c) => Math.abs(c.resultScopes.cast.greenMagenta - c.refScopes.cast.greenMagenta),
  blackPointDeltaToRef: (c) => Math.abs(c.resultScopes.blackPoint - c.refScopes.blackPoint),
  whitePointDeltaToRef: (c) => Math.abs(c.resultScopes.whitePoint - c.refScopes.whitePoint),
  saturationDeltaToRef: (c) => Math.abs(c.resultScopes.saturation - c.refScopes.saturation),
  gapMagnitudeToRef: (c) => gapMagnitude(c.resultScopes, c.refScopes),

  blackPointDeltaToInput: (c) => Math.abs(c.resultScopes.blackPoint - c.inputScopes.blackPoint),
  whitePointDeltaToInput: (c) => Math.abs(c.resultScopes.whitePoint - c.inputScopes.whitePoint),
  midsLumaDeltaToInput: (c) => Math.abs(c.resultScopes.zones.mids.luma - c.inputScopes.zones.mids.luma),
  castWarmCoolDeltaToInput: (c) => Math.abs(c.resultScopes.cast.warmCool - c.inputScopes.cast.warmCool),
  saturationDeltaToInput: (c) => Math.abs(c.resultScopes.saturation - c.inputScopes.saturation),

  // clipping introduced vs the input (a hard-fail gate metric)
  clipIntroduced: (c) =>
    Math.max(0, c.resultScopes.clipHighPct - c.inputScopes.clipHighPct) +
    Math.max(0, c.resultScopes.clipLowPct - c.inputScopes.clipLowPct),

  // grade.json knob effort (the over-grade gate metric)
  knobEffort: (c) => knobEffort(c.grade?.adjustments),

  // region checks (need check.region = [x,y,w,h] in frame px)
  regionWarmCoolAbs: (c) => {
    const [r, , b] = regionMean(c.result, c.check.region);
    return Math.abs(r - b);
  },
  regionMaxChannelDeltaToInput: (c) => {
    const a = regionMean(c.result, c.check.region);
    const bl = regionMean(c.input, c.check.region);
    return Math.max(Math.abs(a[0] - bl[0]), Math.abs(a[1] - bl[1]), Math.abs(a[2] - bl[2]));
  },
};

/* --------------------------------------------------------- check scoring --- */
// baselineValue = the same metric on the unfixed setup (identity grade). It is
// the 0-anchor: a result no better than doing nothing scores 0 on that check.
function scoreCheck(value, baselineValue, check) {
  const lim = check.max ?? check.min;
  const isMax = check.max != null;
  if (check.max != null) {
    if (baselineValue <= check.max) {
      // baseline already within tolerance (e.g. don't-over-grade) — penalise
      // moving away from it instead.
      const slack = check.slack ?? Math.max(1, check.max);
      return clamp01(1 - Math.max(0, value - check.max) / slack);
    }
    return clamp01((baselineValue - value) / (baselineValue - check.max));
  }
  // min check
  if (baselineValue >= check.min) {
    const slack = check.slack ?? Math.max(1, check.min * 0.1);
    return clamp01(1 - Math.max(0, check.min - value) / slack);
  }
  return clamp01((value - baselineValue) / (check.min - baselineValue));
}

/* -------------------------------------------------------- result loading --- */
function loadResult(task, resultsDir, baselineMode) {
  const input = rd(task.input.frame);
  if (baselineMode) return { result: input, source: 'baseline(identity)', grade: null };
  if (resultsDir) {
    const png = path.join(resultsDir, `${task.id}.result.png`);
    if (fs.existsSync(png)) return { result: decodePNG(fs.readFileSync(png)), source: 'result.png', grade: null };
    const gj = path.join(resultsDir, `${task.id}.grade.json`);
    if (fs.existsSync(gj)) {
      const grade = JSON.parse(fs.readFileSync(gj, 'utf8'));
      return {
        result: applyGrade(input, grade, { maskRects: task.maskRects }),
        source: 'grade.json', grade,
      };
    }
  }
  return null;
}

/* ---------------------------------------------------------------- runner --- */
function scoreTask(task, resultsDir, baselineMode) {
  const input = rd(task.input.frame);
  const inputScopes = computeScopes(input);
  const ref = task.goal.reference ? rd(task.goal.reference) : null;
  const refScopes = ref ? computeScopes(ref) : null;

  const loaded = loadResult(task, resultsDir, baselineMode);
  if (!loaded) return { id: task.id, missing: true };

  const { result, source, grade } = loaded;
  const resultScopes = computeScopes(result);

  // identity baseline for the 0-anchor of every check
  const baseCtxBase = { input, inputScopes, result: input, resultScopes: inputScopes, ref, refScopes, grade: null };

  const checks = [];
  for (const check of task.goal.checks) {
    const ctx = { input, inputScopes, result, resultScopes, ref, refScopes, grade, check };
    const fn = METRICS[check.metric];
    if (!fn) throw new Error(`${task.id}: unknown metric ${check.metric}`);
    const value = fn(ctx);
    const baselineValue = fn({ ...baseCtxBase, check });
    const s = scoreCheck(value, baselineValue, check);
    checks.push({
      id: check.id, metric: check.metric,
      value: num(value), baseline: num(baselineValue),
      limit: check.max ?? check.min, dir: check.max != null ? '<=' : '>=',
      pass: check.max != null ? value <= check.max : value >= check.min,
      score: num(s),
    });
  }

  let score = checks.length ? checks.reduce((a, c) => a + c.score, 0) / checks.length : 0;

  const gateFlags = [];
  for (const g of task.gates ?? []) {
    const fn = METRICS[g.metric];
    const ctx = { input, inputScopes, result, resultScopes, ref, refScopes, grade, check: g };
    const value = fn(ctx);
    if (g.max != null && value > g.max) { gateFlags.push(`${g.metric}=${num(value)}>${g.max}`); }
    if (g.min != null && value < g.min) { gateFlags.push(`${g.metric}=${num(value)}<${g.min}`); }
  }
  if (gateFlags.length) score = 0;

  const passThreshold = task.passThreshold ?? 0.6;
  return {
    id: task.id, source, score: num(score),
    passed: score >= passThreshold && !gateFlags.length,
    gates: gateFlags, checks,
  };
}

/* ------------------------------------------------------------------ main --- */
const args = process.argv.slice(2);
const taskSet = JSON.parse(fs.readFileSync(path.join(DIR, 'tasks.json'), 'utf8'));

if (args[0] === '--scopes') {
  for (const t of taskSet.tasks) {
    const s = computeScopes(rd(t.input.frame));
    console.log(t.id, JSON.stringify({
      black: s.blackPoint, white: s.whitePoint, clipHi: s.clipHighPct, clipLo: s.clipLowPct,
      mids: s.zones.mids.luma, warmCool: s.cast.warmCool, greenMag: s.cast.greenMagenta, sat: s.saturation,
    }));
  }
  process.exit(0);
}

const baselineMode = args[0] === '--baseline';
const resultsDir = baselineMode ? null : (args[0] ? path.resolve(args[0]) : null);

const rows = taskSet.tasks.map((t) => scoreTask(t, resultsDir, baselineMode));

// table
const w = (s, n) => String(s).padEnd(n);
console.log();
console.log(w('task', 22), w('src', 16), w('score', 8), w('pass', 6), 'checks (score)');
console.log('-'.repeat(96));
for (const r of rows) {
  if (r.missing) { console.log(w(r.id, 22), w('MISSING', 16), w('-', 8), w('-', 6)); continue; }
  const cs = r.checks.map((c) => `${c.id}:${c.score.toFixed(2)}${c.pass ? '' : '*'}`).join(' ');
  console.log(w(r.id, 22), w(r.source, 16), w(r.score.toFixed(3), 8), w(r.passed ? 'yes' : 'NO', 6),
    cs + (r.gates.length ? `  GATE:${r.gates.join(',')}` : ''));
}

const scored = rows.filter((r) => !r.missing);
if (!baselineMode && !scored.length) {
  console.log('\nNo result files found. Pass a directory of <task_id>.grade.json or');
  console.log('<task_id>.result.png files:  node eval/score.mjs eval/results');
}
const mean = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0;
const passCount = scored.filter((r) => r.passed).length;
console.log('-'.repeat(96));
console.log(`rollup: mean=${mean.toFixed(3)}  pass=${passCount}/${scored.length}  missing=${rows.length - scored.length}  (* = check over tolerance)`);

// baseline compare / write
const baselinePath = path.join(DIR, 'baseline.json');
if (baselineMode) {
  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    note: 'Floor = the unfixed setup grades scored by eval/lib/apply.mjs (approximate operator). Regenerate: node eval/score.mjs --baseline',
    rollup: { mean: num(mean), pass: passCount, of: scored.length },
    tasks: Object.fromEntries(scored.map((r) => [r.id, { score: r.score, passed: r.passed }])),
  };
  fs.writeFileSync(baselinePath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(process.cwd(), baselinePath)}`);
} else if (fs.existsSync(baselinePath)) {
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const regressions = [];
  const gains = [];
  for (const r of scored) {
    const b = base.tasks[r.id];
    if (!b) continue;
    if (r.score < b.score - 0.05) regressions.push(`${r.id} ${b.score.toFixed(3)}→${r.score.toFixed(3)}`);
    else if (r.score > b.score + 0.05) gains.push(`${r.id} ${b.score.toFixed(3)}→${r.score.toFixed(3)}`);
  }
  console.log(`\nvs baseline (${base.generatedAt}): mean ${base.rollup.mean.toFixed(3)}→${mean.toFixed(3)}`);
  if (gains.length) console.log(`  improved: ${gains.join(' | ')}`);
  if (regressions.length) { console.log(`  REGRESSED: ${regressions.join(' | ')}`); process.exitCode = 1; }
  if (!gains.length && !regressions.length) console.log('  no change > 0.05');
}
