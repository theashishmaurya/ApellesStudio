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
import { EDIT_PERF_PREFIX } from '@apelles/editor/src/editPerfNames.ts';

import { checkBudget, DEFAULT_PERF_BUDGET, PLAYBACK_PAINT_MIN_FPS, PLAYBACK_RAF_MIN_FPS, type PerfReport } from './budgets.ts';
import { activateApp } from './activation.ts';
import type { OpClient } from './client.ts';
import { buildFixture, teardownFixture, type BuiltFixture, type ScratchProject } from './fixture.ts';
import type { FrameOffset, FrameTarget, Scenario, Step, TargetRef } from './scenario.ts';
import { TIMELINE_TEST_IDS } from '@apelles/editor/src/timelineTestIds.ts';
import { IDLE_QUIET_MS, measuredArgs, summarizeEditMarks, type PerfEntry as MarkEntry } from './perfMethod.ts';
import { framesToPx, pointAtFrame, timelineSnapshot, VIEW_QUERY, viewSnapshot, type ViewSnap } from './snapshot.ts';
import { assertVisible, clampAtToVisible, OutsideVisibleArea, zoomToShowFrame, type At, type Rect } from './visibility.ts';

export type Status = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

/** H18 (B-371): a native `move` injected while Apelles' window was not key (the
 *  native report's `windowKey` is read before the move is sent). Hover state
 *  needs an active window, so the runner re-activates and replays such a move. */
export function moveLostKeyWindow(action: string, reply: Record<string, unknown>): boolean {
  const native = reply.native as { windowKey?: boolean } | undefined;
  return action === 'move' && native?.windowKey === false;
}

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
  /** Keep the per-frame rect `watch` on measured steps (live-feedback evidence).
   *  Default off: the watch forces a layout every frame and skews the numbers. */
  evidence?: boolean;
}

const DEFAULT_WAIT_FOR_MS = 2000;
const WAIT_FOR_POLL_MS = 100;
/** The idle wait is bounded app-side (5 s); leave room for the reply. */
const IDLE_OP_TIMEOUT_MS = 10_000;
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
        assertVisible({ x: view.rect.x + x, y: view.rect.y + view.rowsTop / 2 }, view, `frame ${frame} on the ruler`, frame);
        // D-432 P3 — our own ruler (`TimelineRuler.tsx`), not the library's.
        return { selector: `[data-testid="${TIMELINE_TEST_IDS.ruler}"]`, at: { fx: 0, fy: t.fy ?? 0.5, dx: x } };
      }
      const point = pointAtFrame(view, frame, t.track, t.fy);
      assertVisible(point, view, `frame ${frame} on track ${t.track}`, frame);
      return point;
    }
    const frames = Number(resolveValue(t.byFrames, scope));
    if (!Number.isFinite(frames)) throw new Error(`byFrames ${JSON.stringify(t.byFrames)} did not resolve to a number`);
    return { byX: framesToPx(view, frames), byY: (t.byTracks ?? 0) * view.rowHeight };
  }
  return { ...t };
}

function perfNumbers(p: PerfReport, marks: ReturnType<typeof summarizeEditMarks>): Record<string, number | null> {
  return {
    frames: p.frames.samples,
    moveFrames: p.phases?.move?.samples ?? null,
    moveP95Ms: p.phases?.move?.p95Ms ?? null,
    moveMaxMs: p.phases?.move?.maxMs ?? null,
    releaseMaxMs: p.phases?.release?.maxMs ?? null,
    previews: marks?.previews ?? null,
    previewP50Ms: marks?.previewP50Ms ?? null,
    previewP95Ms: marks?.previewP95Ms ?? null,
    commitRenderedMs: marks?.commitRenderedMs ?? null,
    commitEffectsMs: marks?.commitEffectsMs ?? null,
    commitFrameMs: marks?.commitFrameMs ?? null,
    commitPaintedMs: marks?.commitPaintedMs ?? null,
    paintMs: marks?.paintMs ?? null,
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
        let opName: string;
        let args: Record<string, unknown>;
        if ('pointer' in step) {
          const { target, to, path, ...rest } = step.pointer;
          opName = 'debug_pointer';
          // H11 - every target is checked against the VISIBLE edit area first.
          args = await this.resolvePointer(rest, target, to, path, scope);
        } else {
          opName = 'debug_key';
          args = { ...step.key };
        }
        args.mode = this.opts.mode;
        let watchDropped = false;
        if (step.measure) {
          args.measure = true;
          // F6 - no rect watch, a gesture long enough for a p95, a quiet page first.
          const m = measuredArgs(args, this.opts.evidence === true);
          args = m.args;
          watchDropped = m.watchDropped;
          await this.client.op('debug_perf_entries', { prefix: EDIT_PERF_PREFIX, clear: true, waitIdleMs: IDLE_QUIET_MS }, IDLE_OP_TIMEOUT_MS).catch(() => undefined);
        }
        const label = step.label ?? `${opName} ${'pointer' in step ? step.pointer.action : (step.key.keys ?? [step.key.text]).join(' ')}`;
        let reply: Record<string, unknown>;
        try {
          reply = await this.client.op<Record<string, unknown>>(opName, args, INPUT_OP_TIMEOUT_MS);
          if ('pointer' in step && moveLostKeyWindow(step.pointer.action, reply)) {
            // H18 (B-371) — the front moved to another app mid-run (the window
            // was not key when the move was injected). WebKit's testing SPI
            // still delivers the pointermove, but an inactive window applies no
            // `:hover`, so a hover-reveal check would fail on the desktop's
            // state, not the app's. Bring Apelles back and replay the move once.
            await activateApp(this.client);
            reply = await this.client.op<Record<string, unknown>>(opName, args, INPUT_OP_TIMEOUT_MS);
          }
        } catch (e) {
          // A target the app cannot find is a finding about the app (the part
          // is not on screen), not a harness failure.
          record({ ok: false, message: `${label}: ${String((e as Error).message)}` });
          return;
        }
        scope.last = watchDropped ? { ...reply, watchDropped: true } : reply;
        this.checkDelivery(step, reply, label, record);
        if (step.measure && reply.perf) {
          const budget = { ...DEFAULT_PERF_BUDGET, ...(typeof step.measure === 'object' ? step.measure : {}) };
          const verdict = checkBudget(reply.perf as PerfReport, budget);
          const marks = await this.readEditMarks();
          result.perf.push({ label, ok: verdict.ok, misses: verdict.misses, numbers: perfNumbers(reply.perf as PerfReport, marks) });
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
      if (action === 'html5Drag') {
        // B-360 — an HTML5 drag has no pointer events: it was delivered when the
        // drop target accepted it and the drop ran (`html5Drag.ts`).
        if (reply.dropped !== true) {
          record({
            ok: false,
            message: `${label}: the HTML5 drag did not drop: source ${String(reply.source)}, drop target ${String(reply.dropTarget)}, accepted ${String(reply.dropAccepted)}, data ${JSON.stringify(reply.dataTypes)}`,
          });
        }
        return;
      }
      const want = action === 'wheel' ? 'wheel' : action === 'pinch' ? null : action === 'move' ? 'pointermove' : 'pointerdown';
      if (action === 'move' && native?.windowKey === false) {
        // H5 — WebKit drops a buttonless move while the window is not key. That
        // says nothing about the app, so skip rather than fail the hover check.
        // H18 (B-371) — and when the testing SPI DID deliver the move (the page
        // counted a pointermove), an inactive window still applies no `:hover`,
        // so a delivered move in a non-key window is the same skip: the runner
        // has already re-activated the app and replayed it once by now.
        const dropped = !(counts.pointermove > 0);
        throw new SkipScenario(
          `hover needs a key window: ${dropped ? 'WebKit dropped the buttonless move' : 'the move arrived but an inactive window applies no :hover'} (the window was not key${native.madeKeyForMove ? ', and making it key for the move did not help' : ''}, even after re-activating Apelles); bring Apelles to the front and rerun`,
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

  /** The `apelles:edit:*` marks the last gesture wrote (null in a production web bundle). */
  private async readEditMarks(): Promise<ReturnType<typeof summarizeEditMarks>> {
    try {
      const r = await this.client.op<{ entries?: MarkEntry[] }>('debug_perf_entries', { prefix: EDIT_PERF_PREFIX, clear: true });
      return summarizeEditMarks(r.entries ?? []);
    } catch {
      return null;
    }
  }

  /** Resolve one frame-addressed target; a frame outside the visible edit area is
   *  brought into view by zooming out (H11), then resolved again. */
  private async resolveVisible(t: TargetRef, scope: Scope): Promise<Record<string, unknown>> {
    let view = isFrameTarget(t) || isFrameOffset(t) ? await this.readView() : null;
    try {
      return resolveTargetRef(t, view, scope);
    } catch (e) {
      if (!(e instanceof OutsideVisibleArea) || e.frame === null || !view) throw e;
      const zoom = zoomToShowFrame(view, e.frame);
      if (zoom === null) throw new Error(`${e.message}; frame ${e.frame} does not fit even at the lowest timeline zoom`);
      await this.client.op('editor_set_timeline_view', { zoom });
      view = await this.readView();
      return resolveTargetRef(t, view, scope);
    }
  }

  /** An element target on a clip is moved onto the part of it that is visible (H11):
   *  a clip whose centre is under the Inspector is pressed at its visible edge. */
  private async clampElement(t: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sel = typeof t.selector === 'string' ? t.selector : null;
    if (!sel || !sel.includes('data-chroma-clip-id')) return t;
    const tree = await this.client.op<{ root: { rect?: Rect } | null }>('debug_dom_tree', { selector: sel, maxDepth: 0, styles: [], text: false });
    const rect = tree.root?.rect;
    if (!rect) return t; // not on screen: the press reports that itself
    const view = await this.readView();
    const c = clampAtToVisible(rect, t.at as At | undefined, view);
    if ('error' in c) throw new Error(`${sel}: ${c.error}`);
    return c.clamped ? { ...t, at: c.at } : t;
  }

  private async resolvePointer(
    rest: Record<string, unknown>,
    target: TargetRef,
    to: TargetRef | undefined,
    path: TargetRef[] | undefined,
    scope: Scope,
  ): Promise<Record<string, unknown>> {
    const one = async (t: TargetRef) => this.clampElement(await this.resolveVisible(t, scope));
    // `byFrames` / `byX` offsets are relative to the previous point, resolved by the app.
    return {
      ...rest,
      target: await one(target),
      ...(to ? { to: await one(to) } : {}),
      ...(path ? { path: await Promise.all(path.map((p) => one(p))) } : {}),
    };
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
