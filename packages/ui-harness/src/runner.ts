/**
 * runner.ts — play scenarios against the live app and judge them (D-434).
 *
 * What it is: the loop. For each scenario: build its fixture timeline, run
 *   its steps in order — real input through `debug_pointer` / `debug_key`,
 *   control ops, waits, captures, assertions, screenshots, measured playback —
 *   and record a verdict per check plus every perf number against its budget.
 *   A failed scenario gets a screenshot automatically; the fixture is torn
 *   down whatever happened.
 *
 * Verdicts: PASS (every check held), FAIL (a check did not — including a
 *   press that landed on the wrong element, a target that is not on screen,
 *   or a tool that cannot be reached from the GUI: all findings about the
 *   app), SKIP (a `require` precondition did not hold), ERROR (the harness
 *   itself could not proceed — a control op refused, the app unreachable).
 *   Perf is a separate verdict per measured step (`ok` / over budget), so
 *   "works but janks" is reported, not folded into PASS.
 *
 * What it does NOT do: decide what the app SHOULD do — scenarios say that —
 *   or touch anything outside the scratch project (`fixture.ts`).
 */

import { join } from 'node:path';

import { evaluate, resolveValue, rootsOf, type Assertion, type Scope, type Verdict } from './assertions.ts';
import { checkBudget, DEFAULT_PERF_BUDGET, PLAYBACK_PAINT_MIN_FPS, PLAYBACK_RAF_MIN_FPS, type PerfReport } from './budgets.ts';
import type { OpClient } from './client.ts';
import { buildFixture, teardownFixture, type BuiltFixture, type ScratchProject } from './fixture.ts';
import type { FrameOffset, FrameTarget, Scenario, Step, TargetRef } from './scenario.ts';
import { TIMELINE_TEST_IDS } from '@apelles/editor/src/timelineTestIds.ts';
import { framesToPx, pointAtFrame, timelineSnapshot, VIEW_QUERY, viewSnapshot, type ViewSnap } from './snapshot.ts';

export type Status = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

export interface PerfEntry {
  label: string;
  ok: boolean;
  misses: string[];
  numbers: Record<string, number | null>;
}

export interface ScenarioResult {
  id: string;
  title: string;
  area: string;
  reference: string;
  status: Status;
  checks: (Verdict & { step: number })[];
  perf: PerfEntry[];
  screenshots: string[];
  /** Why it was skipped / errored. */
  reason?: string;
  durationMs: number;
}

export interface RunOptions {
  /** `auto` | `native` | `synthetic` — passed to every input step. */
  mode: string;
  /** Where screenshots go. */
  shotsDir: string;
  /** Default `waitFor` budget. */
  waitForTimeoutMs?: number;
}

const DEFAULT_WAIT_FOR_MS = 2000;
const WAIT_FOR_POLL_MS = 100;
/** Input ops carry a whole gesture; mirror the MCP servers' budget. */
const INPUT_OP_TIMEOUT_MS = 90_000;

/** The timeline parts every scenario presses: lanes, the track-header column and
 *  the toolbar controls the dock used to cover. A part that is not on screen is
 *  skipped by the check, so scenarios on an empty timeline still pass it. */
const COVER_CHECK_PARTS = [
  `[data-testid="${TIMELINE_TEST_IDS.editArea}"]`,
  `[data-testid="${TIMELINE_TEST_IDS.trackHeader}"]`,
  `[data-testid="${TIMELINE_TEST_IDS.split}"]`,
  `[data-testid="${TIMELINE_TEST_IDS.addMarker}"]`,
  `[data-testid="${TIMELINE_TEST_IDS.zoomIn}"]`,
] as const;

/** How far (CSS px) a wheel may land from its aim: sub-pixel rounding only. */
const WHEEL_LANDING_TOLERANCE_PX = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class SkipScenario extends Error {}

/** Replace `@clip:<name>` / `@marker:<name>` tokens with the ids the fixture
 *  was given. An unknown name is left as-is, which then matches nothing and
 *  is reported as a missing target — never silently retargeted. */
export function substituteIds<T>(value: T, fixture: Pick<BuiltFixture, 'clipIds' | 'markerIds'>): T {
  const swap = (s: string) =>
    s.replace(/@(clip|marker):([A-Za-z0-9_-]+)/g, (whole, kind: string, name: string) =>
      (kind === 'clip' ? fixture.clipIds[name] : fixture.markerIds[name]) ?? whole,
    );
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return swap(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const isFrameTarget = (t: TargetRef): t is FrameTarget => typeof t === 'object' && 'frame' in t && 'track' in t;
const isFrameOffset = (t: TargetRef): t is FrameOffset => typeof t === 'object' && 'byFrames' in t;

/** A scenario target → `debug_pointer`'s wire target. Frame-addressed forms
 *  are resolved here from the live view readout; the rest pass through. */
export function resolveTargetRef(t: TargetRef, view: ViewSnap | null, scope: Scope): Record<string, unknown> {
  if (isFrameTarget(t) || isFrameOffset(t)) {
    if (!view) throw new Error('a frame-addressed target needs the timeline view readout, which is not available');
    if (isFrameTarget(t)) {
      const frame = Number(resolveValue(t.frame, scope));
      if (!Number.isFinite(frame)) throw new Error(`frame target ${JSON.stringify(t.frame)} did not resolve to a number`);
      if (t.track === 'ruler') {
        // The ruler spans the edit area's full width from its left edge, so
        // the frame's x relative to the ruler is the same arithmetic minus
        // the area's own left; the app resolves the ruler's live rect.
        const x = pointAtFrame(view, frame, 0).x - view.rect.x;
        // D-432 P3 — our own ruler (`TimelineRuler.tsx`), not the library's.
        return { selector: `[data-testid="${TIMELINE_TEST_IDS.ruler}"]`, at: { fx: 0, fy: t.fy ?? 0.5, dx: x } };
      }
      return pointAtFrame(view, frame, t.track, t.fy);
    }
    const frames = Number(resolveValue(t.byFrames, scope));
    if (!Number.isFinite(frames)) throw new Error(`byFrames ${JSON.stringify(t.byFrames)} did not resolve to a number`);
    return { byX: framesToPx(view, frames), byY: (t.byTracks ?? 0) * view.rowHeight };
  }
  return { ...t };
}

function needsView(step: Step): boolean {
  if (!('pointer' in step)) return false;
  const all = [step.pointer.target, step.pointer.to, ...(step.pointer.path ?? [])].filter((x): x is TargetRef => !!x);
  return all.some((t) => isFrameTarget(t) || isFrameOffset(t));
}

function perfNumbers(p: PerfReport): Record<string, number | null> {
  return {
    frames: p.frames.samples,
    frameP50Ms: p.frames.p50Ms ?? null,
    frameP95Ms: p.frames.p95Ms ?? null,
    frameMaxMs: p.frames.maxMs ?? null,
    dropped: p.frames.dropped ?? null,
    inputToFrameP95Ms: p.inputToFrame?.p95Ms ?? null,
    firstCommitMs: p.store.firstCommitAfterInputMs,
    settleMs: p.store.lastCommitAfterLastInputMs,
  };
}

export class ScenarioRunner {
  private readonly client: OpClient;
  private readonly project: ScratchProject;
  private readonly opts: RunOptions;

  constructor(client: OpClient, project: ScratchProject, opts: RunOptions) {
    this.client = client;
    this.project = project;
    this.opts = opts;
  }

  async run(scenario: Scenario): Promise<ScenarioResult> {
    const started = Date.now();
    const result: ScenarioResult = {
      id: scenario.id,
      title: scenario.title,
      area: scenario.area,
      reference: scenario.reference,
      status: 'PASS',
      checks: [],
      perf: [],
      screenshots: [],
      durationMs: 0,
    };
    let fixture: BuiltFixture | null = null;
    try {
      fixture = await buildFixture(this.client, this.project, scenario.id, scenario.fixture);
      await this.assertNothingCoversTheTimeline();
      await this.runSteps(scenario, fixture, result);
      if (result.checks.some((c) => !c.ok)) result.status = 'FAIL';
    } catch (e) {
      if (e instanceof SkipScenario) {
        result.status = 'SKIP';
        result.reason = e.message;
      } else {
        result.status = 'ERROR';
        result.reason = String((e as Error)?.message ?? e);
      }
    }
    if (result.status === 'FAIL' || result.status === 'ERROR') {
      await this.screenshot(`${scenario.id}-failure`, result).catch(() => undefined);
    }
    if (fixture) {
      try {
        await teardownFixture(this.client, fixture);
      } catch (e) {
        result.reason = `${result.reason ? `${result.reason}; ` : ''}teardown: ${String((e as Error).message)}`;
      }
    }
    result.durationMs = Date.now() - started;
    return result;
  }

  /** H1 — fail fast, with the cause named, when a fixed overlay (a dock, a
   *  toast, a banner) sits over a part the scenarios press. Without this each
   *  press reports "the press lands on …" three steps in and the real cause
   *  (one overlay) is rediscovered per scenario. A harness defect, not an app
   *  finding: the harness's own ops no longer open the Agent activity dock. */
  private async assertNothingCoversTheTimeline(): Promise<void> {
    const check = await this.client.op<{ ok?: boolean; overlays?: { part: string; hit: string | null; overlay: string | null }[] }>('debug_overlay_check', {
      parts: COVER_CHECK_PARTS,
    });
    if (check.ok !== false) return;
    const first = check.overlays?.[0];
    throw new Error(
      `a fixed overlay covers the timeline before the scenario starts: ${first?.overlay ?? 'unknown'} sits over ${first?.part ?? 'a timeline part'}` +
        ` (${check.overlays?.length ?? 0} sampled points). Close it (the Agent activity dock, a toast, a dialog) and rerun.`,
    );
  }

  private async screenshot(name: string, result: ScenarioResult): Promise<void> {
    const out = join(this.opts.shotsDir, `${name}.png`);
    await this.client.op('debug_screenshot', { out_path: out });
    result.screenshots.push(out);
  }

  /** Read the roots an assertion needs, fresh, into the scope. */
  private async refresh(scope: Scope, roots: string[], fixture: BuiltFixture): Promise<void> {
    const wanted = new Set(roots);
    if (wanted.has('timeline')) scope.timeline = timelineSnapshot(await this.client.op('editor_get_timeline'), fixture.clipNames);
    if (wanted.has('state')) scope.state = await this.client.op('editor_get_state');
    if (wanted.has('view')) {
      const v = viewSnapshot(await this.client.op('debug_dom_tree', { ...VIEW_QUERY }));
      if ('error' in v) throw new Error(v.error);
      scope.view = v;
    }
  }

  private async check(a: Assertion, scope: Scope, fixture: BuiltFixture): Promise<Verdict> {
    await this.refresh(scope, rootsOf(a), fixture);
    return evaluate(a, scope);
  }

  private async runSteps(scenario: Scenario, fixture: BuiltFixture, result: ScenarioResult): Promise<void> {
    const scope: Scope = {};
    for (const [index, raw] of scenario.steps.entries()) {
      const step = substituteIds(raw, fixture);
      const record = (v: Verdict) => result.checks.push({ ...v, step: index });

      if ('pointer' in step || 'key' in step) {
        const view = needsView(step) ? await this.readView() : null;
        let opName: string;
        let args: Record<string, unknown>;
        if ('pointer' in step) {
          const { target, to, path, ...rest } = step.pointer;
          opName = 'debug_pointer';
          args = {
            ...rest,
            target: resolveTargetRef(target, view, scope),
            ...(to ? { to: resolveTargetRef(to, view, scope) } : {}),
            ...(path ? { path: path.map((p) => resolveTargetRef(p, view, scope)) } : {}),
          };
        } else {
          opName = 'debug_key';
          args = { ...step.key };
        }
        args.mode = this.opts.mode;
        if (step.measure) args.measure = true;
        const label = step.label ?? `${opName} ${'pointer' in step ? step.pointer.action : (step.key.keys ?? [step.key.text]).join(' ')}`;
        let reply: Record<string, unknown>;
        try {
          reply = await this.client.op<Record<string, unknown>>(opName, args, INPUT_OP_TIMEOUT_MS);
        } catch (e) {
          // A target the app cannot find is a finding about the app (the part
          // is not on screen), not a harness failure.
          record({ ok: false, message: `${label}: ${String((e as Error).message)}` });
          return;
        }
        scope.last = reply;
        this.checkDelivery(step, reply, label, record);
        if (step.measure && reply.perf) {
          const budget = { ...DEFAULT_PERF_BUDGET, ...(typeof step.measure === 'object' ? step.measure : {}) };
          const verdict = checkBudget(reply.perf as PerfReport, budget);
          result.perf.push({ label, ok: verdict.ok, misses: verdict.misses, numbers: perfNumbers(reply.perf as PerfReport) });
        }
        continue;
      }
      if ('op' in step) {
        const args = typeof step.args === 'function' ? step.args(scope) : (step.args ?? {});
        const out = await this.client.op(step.op, args);
        if (step.as) scope[step.as] = out;
        continue;
      }
      if ('capture' in step) {
        if (step.capture === 'dom') {
          if (!step.selector) throw new Error(`capture 'dom' needs a selector (step ${index})`);
          const tree = await this.client.op<{ root: { rect: unknown; attrs?: unknown; styles?: { cursor?: string } } | null }>('debug_dom_tree', {
            selector: step.selector,
            maxDepth: 0,
            styles: ['cursor'],
            text: false,
          });
          scope[step.as] = tree.root ? { rect: tree.root.rect, attrs: tree.root.attrs ?? {}, cursor: tree.root.styles?.cursor ?? null } : null;
          continue;
        }
        await this.refresh(scope, [step.capture], fixture);
        scope[step.as] = scope[step.capture];
        continue;
      }
      if ('expect' in step) {
        for (const a of Array.isArray(step.expect) ? step.expect : [step.expect]) {
          const v = await this.check(a, scope, fixture);
          record(step.label ? { ok: v.ok, message: `${step.label} — ${v.message}` } : v);
        }
        continue;
      }
      if ('waitFor' in step) {
        const deadline = Date.now() + (step.timeoutMs ?? this.opts.waitForTimeoutMs ?? DEFAULT_WAIT_FOR_MS);
        let v = await this.check(step.waitFor, scope, fixture);
        while (!v.ok && Date.now() < deadline) {
          await sleep(WAIT_FOR_POLL_MS);
          v = await this.check(step.waitFor, scope, fixture);
        }
        record(step.label ? { ok: v.ok, message: `${step.label} — ${v.message}` } : v);
        continue;
      }
      if ('wait' in step) {
        await sleep(step.wait);
        continue;
      }
      if ('screenshot' in step) {
        await this.screenshot(`${scenario.id}-${step.screenshot}`, result);
        continue;
      }
      if ('require' in step) {
        const v = await this.check(step.require, scope, fixture);
        if (!v.ok) throw new SkipScenario(`${step.reason} (${v.message})`);
        continue;
      }
      if ('reachable' in step) {
        const tree = await this.client.op<{ root: unknown }>('debug_dom_tree', { selector: step.reachable.selector, maxDepth: 0, styles: [], text: false });
        record({
          ok: tree.root !== null && tree.root !== undefined,
          message: tree.root ? `reachable from the GUI: ${step.reachable.selector}` : `NOT reachable from the GUI — ${step.reachable.reason} (no ${step.reachable.selector})`,
        });
        continue;
      }
      if ('playback' in step) {
        await this.playback(step, scope, result, record);
        continue;
      }
    }
  }

  /** The gesture really reached the page and landed where it aimed. */
  private checkDelivery(step: Step, reply: Record<string, unknown>, label: string, record: (v: Verdict) => void): void {
    const observed = reply.observed as { counts?: Record<string, number>; lastWheel?: { x: number; y: number } | null } | undefined;
    const counts = observed?.counts ?? {};
    const native = reply.native as { windowKey?: boolean; madeKeyForMove?: boolean } | undefined;
    if ('pointer' in step) {
      const action = step.pointer.action;
      const want = action === 'wheel' ? 'wheel' : action === 'pinch' ? null : action === 'move' ? 'pointermove' : 'pointerdown';
      if (action === 'move' && !(counts.pointermove > 0) && native?.windowKey === false) {
        // H5 — WebKit drops a buttonless move while the window is not key. That
        // says nothing about the app, so skip rather than fail the hover check.
        throw new SkipScenario(
          `hover needs a key window: WebKit dropped the buttonless move (the window was not key${native.madeKeyForMove ? ', and making it key for the move did not help' : ''}); bring Apelles to the front and rerun`,
        );
      }
      if (want && action !== 'up' && !(counts[want] > 0)) {
        record({ ok: false, message: `${label}: the page received no ${want} — the input never arrived (mode ${String(reply.mode)})` });
      }
      const first = (reply.targets as { x: number; y: number; hitInside: boolean | null; element: string | null; hit: string | null }[] | undefined)?.[0];
      const landed = observed?.lastWheel;
      if (action === 'wheel' && first && landed && Math.hypot(landed.x - first.x, landed.y - first.y) > WHEEL_LANDING_TOLERANCE_PX) {
        // H8 — a wheel built without its window arrives offset by the window's
        // screen origin; scenarios used to pass only because the window sat at 0,0.
        record({
          ok: false,
          message: `${label}: the wheel landed at (${landed.x}, ${landed.y}) but aimed at (${first.x}, ${first.y}) — the native wheel's location is in the wrong coordinate space`,
        });
      }
      if ((step.expectHit ?? true) && first && first.hitInside === false) {
        record({ ok: false, message: `${label}: aimed at ${first.element} but the press lands on ${first.hit} (something is on top of it)` });
      }
    } else if ('key' in step && step.key.phase !== 'up' && !(counts.keydown > 0)) {
      record({ ok: false, message: `${label}: the page received no keydown — the input never arrived (mode ${String(reply.mode)})` });
    }
  }

  private async readView(): Promise<ViewSnap> {
    const v = viewSnapshot(await this.client.op('debug_dom_tree', { ...VIEW_QUERY }));
    if ('error' in v) throw new Error(v.error);
    return v;
  }

  private async playback(
    step: Extract<Step, { playback: unknown }>,
    scope: Scope,
    result: ScenarioResult,
    record: (v: Verdict) => void,
  ): Promise<void> {
    const p = step.playback;
    await this.client.op('debug_frame_timing', { reset: true });
    if (p.fromFrame !== undefined) await this.client.op('editor_set_playhead', { frame: p.fromFrame });
    await this.client.op('editor_set_playing', { playing: true });
    await sleep(p.seconds * 1000);
    await this.client.op('editor_set_playing', { playing: false });
    const timing = await this.client.op<{ paint?: { fps?: number; samples?: number }; raf?: { fps?: number; samples?: number } }>('debug_frame_timing', {
      windowMs: Math.round(p.seconds * 1000),
    });
    if (step.as) scope[step.as] = timing;
    const paintMin = p.paintMinFps ?? PLAYBACK_PAINT_MIN_FPS;
    const rafMin = p.rafMinFps ?? PLAYBACK_RAF_MIN_FPS;
    const paint = timing.paint?.fps ?? 0;
    const raf = timing.raf?.fps ?? 0;
    const misses: string[] = [];
    if (!(timing.raf?.samples ?? 0)) misses.push('the play loop never ticked (raf samples 0) — throttled window or playback did not start');
    if (paint < paintMin) misses.push(`paint ${paint} fps < ${paintMin}`);
    if (raf < rafMin) misses.push(`raf ${raf} fps < ${rafMin}`);
    result.perf.push({
      label: `playback ${p.seconds}s`,
      ok: misses.length === 0,
      misses,
      numbers: { paintFps: paint, rafFps: raf, paintSamples: timing.paint?.samples ?? 0, rafSamples: timing.raf?.samples ?? 0 },
    });
    record({ ok: (timing.raf?.samples ?? 0) > 0, message: `playback ran: ${timing.raf?.samples ?? 0} play-loop ticks, ${timing.paint?.samples ?? 0} paints in ${p.seconds}s` });
  }
}
