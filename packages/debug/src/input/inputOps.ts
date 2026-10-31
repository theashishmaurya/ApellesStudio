/**
 * inputOps.ts — the `debug_pointer` and `debug_key` ops (D-434).
 *
 * What it is: real pointer and keyboard input for the UI harness. Each call
 *   resolves its targets against the live DOM (`geometry.ts`), turns the
 *   gesture into a timed event plan (`plan.ts`), plays it through the native
 *   dispatcher (trusted `NSEvent`s into the `WKWebView`, `dispatchNative.ts`)
 *   or the synthetic one (`dispatchSynthetic.ts`), and reports back:
 *     - `targets` — where each target resolved and what was REALLY under it;
 *     - `observed` — what the page received (counts, `isTrusted`, targets);
 *     - `perf` (with `measure`) — frame times, dropped frames, input→frame
 *       and input→store latency over the gesture;
 *     - `watch` (with `watch`) — per-frame rects of chosen elements and the
 *       cursor under the pointer, i.e. the live feedback DURING the gesture.
 *
 * What it does NOT do: assert anything. Pass/fail is the scenario runner's
 *   call (`packages/ui-harness`); this is the instrument.
 *
 * Why this exists next to D-219's "never synthesise a click" rule: D-219's
 *   setters exist to put the UI into a state, and a store action is the honest
 *   way to do that. This exists to test the INPUT HANDLING itself — the
 *   pointer handlers, hit zones, drag thresholds and keymap that a store
 *   action skips entirely, and where the owner's "the timeline is buggy"
 *   reports live. Debug-only, like every op in this package.
 */

import { useEditorTimelineStore } from '@apelles/editor';

import { dispatchNative, nativeInputAvailable, type NativeReport } from './dispatchNative';
import { dispatchSynthetic } from './dispatchSynthetic';
import { isTargetError, resolveTarget, type ResolvedTarget } from './geometry';
import { startObserver } from './observe';
import { startFrameSampler, type WatchOptions } from './perf';
import {
  buildKeyPlan,
  buildPointerPlan,
  isPlanError,
  parseButton,
  parseModifiers,
  POINTER_ACTIONS,
  type PointerAction,
} from './plan';
import type { LowEvent, RelativeSpec, TargetSpec } from './types';

export type InputMode = 'auto' | 'native' | 'synthetic';
export const INPUT_MODES: readonly InputMode[] = ['auto', 'native', 'synthetic'];

/** How long to keep observing after the last event — long enough for a
 *  pointer-up handler's commit, the store's re-render and a frame to land. */
export const DEFAULT_SETTLE_MS = 120;
export const MAX_SETTLE_MS = 5000;

/** Buttons a previous `down` left pressed, so a later `move`/`up` call
 *  continues the same gesture (DOM `buttons` stays truthful across calls). */
let heldButtons = 0;

type Reply = Record<string, unknown> | { error: string };

function parseMode(raw: unknown): InputMode | { error: string } {
  if (raw === undefined || raw === null) return 'auto';
  if (INPUT_MODES.includes(raw as InputMode)) return raw as InputMode;
  return { error: `unknown mode ${JSON.stringify(raw)} — expected ${INPUT_MODES.join(', ')}` };
}

function parseSettle(raw: unknown): number | { error: string } {
  if (raw === undefined || raw === null) return DEFAULT_SETTLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { error: "'settleMs' must be a non-negative number of milliseconds" };
  return Math.min(n, MAX_SETTLE_MS);
}

function parseWatch(raw: unknown): WatchOptions | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return { error: "'watch' must be {selectors?: string[], cursor?: bool, maxFrames?: int}" };
  const w = raw as { selectors?: unknown; cursor?: unknown; maxFrames?: unknown };
  if (w.selectors !== undefined && !Array.isArray(w.selectors)) return { error: "'watch.selectors' must be a list of CSS selectors" };
  return {
    selectors: Array.isArray(w.selectors) ? w.selectors.map(String) : [],
    cursor: w.cursor === true,
    maxFrames: w.maxFrames === undefined ? undefined : Number(w.maxFrames),
  };
}

function optNumber(raw: unknown, name: string): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : { error: `'${name}' must be a number` };
}

const isErr = (v: unknown): v is { error: string } =>
  typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True for the Rust side's "no native input on this platform" refusal — the
 *  one native failure `auto` mode answers by falling back. */
function isUnsupported(e: unknown): boolean {
  return /not supported on this platform/i.test(String((e as Error)?.message ?? e));
}

async function runPlan(
  plan: LowEvent[],
  o: { mode: InputMode; measure: boolean; watch: WatchOptions | null; settleMs: number },
): Promise<Record<string, unknown>> {
  const useNative = o.mode === 'native' || (o.mode === 'auto' && nativeInputAvailable());
  if (o.mode === 'native' && !nativeInputAvailable()) {
    return { error: 'native input needs the running Tauri app; this page is not inside one (use mode "synthetic")' };
  }
  const observer = startObserver();
  const sampler = o.measure || o.watch ? startFrameSampler({ watch: o.watch, pointer: observer.lastPointer }) : null;
  const unsubscribe = sampler ? useEditorTimelineStore.subscribe(() => sampler.noteStoreChange()) : null;
  const started = performance.now();
  let modeUsed: 'native' | 'synthetic' = useNative ? 'native' : 'synthetic';
  let fallbackReason: string | undefined;
  let native: NativeReport | undefined;
  try {
    if (useNative) {
      try {
        native = await dispatchNative(plan);
      } catch (e) {
        if (o.mode !== 'auto' || !isUnsupported(e)) throw e;
        modeUsed = 'synthetic';
        fallbackReason = String((e as Error)?.message ?? e);
        await dispatchSynthetic(plan);
      }
    } else {
      await dispatchSynthetic(plan);
    }
  } finally {
    await sleep(o.settleMs);
    unsubscribe?.();
  }
  const durationMs = Math.round(performance.now() - started);
  const observed = observer.stop();
  const sampled = sampler?.stop(observed.inputTimes, observed.releaseAt);
  for (const ev of plan) if (ev.kind === 'mouse') heldButtons = ev.buttons;
  // `inputTimes` is internal (it feeds the latency numbers) and not reported.
  const observedOut = {
    counts: observed.counts,
    trusted: observed.trusted,
    untrusted: observed.untrusted,
    events: observed.events,
    eventsTruncated: observed.eventsTruncated,
    lastPointer: observed.lastPointer,
    lastWheel: observed.lastWheel,
  };
  return {
    ok: true,
    mode: modeUsed,
    ...(fallbackReason ? { fallbackReason } : {}),
    events: plan.length,
    durationMs,
    heldButtons,
    observed: observedOut,
    ...(native ? { native } : {}),
    ...(sampled && o.measure ? { perf: sampled.perf } : {}),
    ...(sampled?.watch ? { watch: sampled.watch, watchTruncated: sampled.watchTruncated } : {}),
  };
}

function isRelative(spec: unknown): spec is RelativeSpec {
  return typeof spec === 'object' && spec !== null && 'byX' in spec;
}

/** A `{byX, byY}` target: an offset from the gesture's previous point, still
 *  checked against the viewport and still reporting what is under it. */
function relativeTarget(spec: RelativeSpec, previous: ResolvedTarget | null, label: string): ResolvedTarget | { error: string } {
  if (!previous) return { error: `a relative {byX, byY} target needs a point before it (${label} has none)` };
  const byX = Number(spec.byX);
  const byY = spec.byY === undefined ? 0 : Number(spec.byY);
  if (!Number.isFinite(byX) || !Number.isFinite(byY)) return { error: 'byX/byY must be finite numbers (CSS px)' };
  return resolveTarget({ x: Math.round((previous.x + byX) * 10) / 10, y: Math.round((previous.y + byY) * 10) / 10 });
}

function commonOptions(a: Record<string, unknown>) {
  const mode = parseMode(a.mode);
  if (isErr(mode)) return mode;
  const settleMs = parseSettle(a.settleMs);
  if (isErr(settleMs)) return settleMs;
  const watch = parseWatch(a.watch);
  if (isErr(watch)) return watch;
  return { mode, settleMs, watch, measure: a.measure === true };
}

export async function debugPointer(args: unknown): Promise<Reply> {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = a.action as PointerAction;
  if (!POINTER_ACTIONS.includes(action)) {
    return { error: `unknown action ${JSON.stringify(a.action)} — expected one of ${POINTER_ACTIONS.join(', ')}` };
  }
  const common = commonOptions(a);
  if (isErr(common)) return common;
  const modifiers = parseModifiers(a.modifiers);
  if (isPlanError(modifiers)) return modifiers;
  const button = parseButton(a.button);
  if (isPlanError(button)) return button;

  const specs: { label: string; spec: TargetSpec }[] = [{ label: 'target', spec: a.target as TargetSpec }];
  if (Array.isArray(a.path)) a.path.forEach((p, i) => specs.push({ label: `path[${i}]`, spec: p as TargetSpec }));
  if (a.to !== undefined && a.to !== null) specs.push({ label: 'to', spec: a.to as TargetSpec });
  const targets: (ResolvedTarget & { label: string })[] = [];
  for (const { label, spec } of specs) {
    const previous = targets[targets.length - 1];
    const resolved = isRelative(spec)
      ? relativeTarget(spec, previous ?? null, label)
      : resolveTarget(spec);
    if (isTargetError(resolved)) return { error: `${label}: ${resolved.error}` };
    targets.push({ label, ...resolved });
  }

  const nums: Record<string, number | undefined> = {};
  for (const name of ['steps', 'durationMs', 'holdMs', 'releaseDelayMs', 'deltaX', 'deltaY', 'scale']) {
    const n = optNumber(a[name], name);
    if (isErr(n)) return n;
    nums[name] = n;
  }
  const plan = buildPointerPlan({
    action,
    points: targets.map((t) => ({ x: t.x, y: t.y })),
    button,
    modifiers,
    pressModifiers: a.pressModifiers !== false,
    heldButtons,
    steps: nums.steps,
    durationMs: nums.durationMs,
    holdMs: nums.holdMs,
    releaseDelayMs: nums.releaseDelayMs,
    deltaX: nums.deltaX,
    deltaY: nums.deltaY,
    scale: nums.scale,
  });
  if (isPlanError(plan)) return plan;
  const result = await runPlan(plan, common);
  if (isErr(result)) return result;
  return { action, targets, ...result };
}

export async function debugKey(args: unknown): Promise<Reply> {
  const a = (args ?? {}) as Record<string, unknown>;
  const common = commonOptions(a);
  if (isErr(common)) return common;
  if (a.keys !== undefined && !Array.isArray(a.keys)) return { error: "'keys' must be a list of combos, e.g. [\"meta+KeyZ\"]" };
  const phase = a.phase === undefined ? 'press' : a.phase;
  if (phase !== 'press' && phase !== 'down' && phase !== 'up') {
    return { error: `unknown phase ${JSON.stringify(a.phase)} — expected press, down or up` };
  }
  const holdMs = optNumber(a.holdMs, 'holdMs');
  if (isErr(holdMs)) return holdMs;
  const gapMs = optNumber(a.gapMs, 'gapMs');
  if (isErr(gapMs)) return gapMs;
  const plan = buildKeyPlan({
    keys: Array.isArray(a.keys) ? a.keys.map(String) : undefined,
    text: a.text === undefined ? undefined : String(a.text),
    phase,
    holdMs,
    gapMs,
  });
  if (isPlanError(plan)) return plan;
  const result = await runPlan(plan, common);
  if (isErr(result)) return result;
  return { focused: document.activeElement ? document.activeElement.tagName.toLowerCase() : null, ...result };
}
