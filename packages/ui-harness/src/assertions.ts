/**
 * assertions.ts — evaluating a scenario's expectations (D-434).
 *
 * What it is: the pure judge. An `Expect` names a value by path
 *   (`timeline.clips.a.end`, `state.playhead`, `view.pxPerSec`,
 *   `last.observed.counts.pointerdown`, or a captured snapshot such as
 *   `before.clips.a.startFrame`), an operator, and what it should be — itself
 *   possibly a reference with arithmetic (`{ref: 'before.clips.a.end', plus:
 *   15}`), so "the cut moved 15 frames later" is written as exactly that.
 *   `live` and `cursor` judge the per-frame `watch` samples of the last
 *   gesture: did the clip block move DURING the drag, did the cursor show the
 *   tool over the hit zone.
 *
 * What it does NOT do: fetch state. `evaluate` is handed a `Scope` (every root
 *   already read) and returns a verdict with a message that stands on its own
 *   in a report. Unit-tested in `assertions.test.ts`.
 */

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'near' | 'in' | 'truthy' | 'falsy' | 'changed' | 'unchanged';

/** A literal, or a path into the scope with optional arithmetic. */
export type Value = number | string | boolean | null | readonly (number | string)[] | { ref: string; plus?: number; times?: number };

export interface Expect {
  /** Path into the scope: `<root>.<key>.<key>…`; array indices are keys. */
  path: string;
  op?: Op;
  value?: Value;
  /** `near`: allowed absolute difference. Default {@link DEFAULT_TOLERANCE}. */
  tolerance?: number;
  /** `changed` / `unchanged`: the captured snapshot to compare the same path against. */
  from?: string;
  /** Overrides the generated message. */
  label?: string;
}

/** The live-feedback check: across the last gesture's watched frames, the
 *  matched element's `prop` took at least `minDistinct` distinct values — i.e.
 *  it visibly moved/resized while the hand moved, not only after release. */
export interface LiveExpect {
  live: { selector: string; prop: 'x' | 'width' | 'right' | 'y'; minDistinct: number; nth?: number; label?: string };
}

/** The cursor check: some watched frame showed one of these CSS cursors. */
export interface CursorExpect {
  cursor: { anyOf: readonly string[]; label?: string };
}

export type Assertion = Expect | LiveExpect | CursorExpect;

export interface Verdict {
  ok: boolean;
  message: string;
}

/** Default `near` tolerance: half a frame / half a pixel. */
export const DEFAULT_TOLERANCE = 0.5;

export type Scope = Record<string, unknown>;

/** `get(scope, 'a.b.0.c')` — `undefined` where the path runs out. */
export function getPath(scope: unknown, path: string): unknown {
  let cur: unknown = scope;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (key === 'length' && Array.isArray(cur)) {
      cur = cur.length;
      continue;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function resolveValue(value: Value | undefined, scope: Scope): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'ref' in value) {
    const base = getPath(scope, value.ref);
    if (typeof base !== 'number') return value.plus === undefined && value.times === undefined ? base : Number.NaN;
    return base * (value.times ?? 1) + (value.plus ?? 0);
  }
  return value;
}

const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

function evaluateExpect(e: Expect, scope: Scope): Verdict {
  const op = e.op ?? 'eq';
  const actual = getPath(scope, e.path);
  let expected: unknown;
  if (op === 'changed' || op === 'unchanged') {
    if (!e.from) return { ok: false, message: `${e.path}: '${op}' needs 'from' (a captured snapshot)` };
    const rest = e.path.split('.').slice(1).join('.');
    expected = getPath(scope, `${e.from}.${rest}`);
  } else {
    expected = resolveValue(e.value, scope);
  }
  const num = typeof actual === 'number' && typeof expected === 'number';
  let ok: boolean;
  switch (op) {
    case 'eq':
      ok = JSON.stringify(actual) === JSON.stringify(expected);
      break;
    case 'ne':
      ok = JSON.stringify(actual) !== JSON.stringify(expected);
      break;
    case 'gt':
      ok = num && (actual as number) > (expected as number);
      break;
    case 'gte':
      ok = num && (actual as number) >= (expected as number);
      break;
    case 'lt':
      ok = num && (actual as number) < (expected as number);
      break;
    case 'lte':
      ok = num && (actual as number) <= (expected as number);
      break;
    case 'near':
      ok = num && Math.abs((actual as number) - (expected as number)) <= (e.tolerance ?? DEFAULT_TOLERANCE);
      break;
    case 'in':
      ok = Array.isArray(expected) && expected.some((x) => JSON.stringify(x) === JSON.stringify(actual));
      break;
    case 'truthy':
      ok = Boolean(actual);
      break;
    case 'falsy':
      ok = !actual;
      break;
    case 'changed':
      ok = actual !== undefined && JSON.stringify(actual) !== JSON.stringify(expected);
      break;
    case 'unchanged':
      ok = actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected);
      break;
    default:
      return { ok: false, message: `unknown operator ${show(op)}` };
  }
  const want =
    op === 'truthy' || op === 'falsy'
      ? op
      : op === 'changed' || op === 'unchanged'
        ? `${op} from ${e.from} (${show(expected)})`
        : op === 'near'
          ? `≈ ${show(expected)} ±${e.tolerance ?? DEFAULT_TOLERANCE}`
          : `${op} ${show(expected)}`;
  const label = e.label ? `${e.label}: ` : '';
  return { ok, message: `${label}${e.path} = ${show(actual)} — expected ${want}` };
}

interface WatchFrame {
  t: number;
  rects: Record<string, { x: number; y: number; width: number; height: number }[]>;
  cursor?: string;
}

function evaluateLive(l: LiveExpect['live'], scope: Scope): Verdict {
  const frames = (getPath(scope, 'last.watch') as WatchFrame[] | undefined) ?? [];
  const label = l.label ? `${l.label}: ` : '';
  if (!frames.length) {
    return { ok: false, message: `${label}no watched frames for ${l.selector} — pass watch:{selectors:[…]} on the gesture (and check rAF is not throttled)` };
  }
  const values = new Set<number>();
  for (const f of frames) {
    const r = f.rects[l.selector]?.[l.nth ?? 0];
    if (!r) continue;
    const v = l.prop === 'right' ? r.x + r.width : r[l.prop];
    values.add(Math.round(v));
  }
  const ok = values.size >= l.minDistinct;
  return {
    ok,
    message: `${label}${l.selector} took ${values.size} distinct ${l.prop} values over ${frames.length} frames during the gesture — expected ≥ ${l.minDistinct} (live feedback while dragging)`,
  };
}

function evaluateCursor(c: CursorExpect['cursor'], scope: Scope): Verdict {
  const frames = (getPath(scope, 'last.watch') as WatchFrame[] | undefined) ?? [];
  const seen = [...new Set(frames.map((f) => f.cursor).filter((x): x is string => !!x))];
  const ok = seen.some((s) => c.anyOf.includes(s));
  const label = c.label ? `${c.label}: ` : '';
  return { ok, message: `${label}cursors seen during the gesture ${show(seen)} — expected one of ${show(c.anyOf)}` };
}

export function evaluate(a: Assertion, scope: Scope): Verdict {
  if ('live' in a) return evaluateLive(a.live, scope);
  if ('cursor' in a) return evaluateCursor(a.cursor, scope);
  return evaluateExpect(a, scope);
}

/** The scope roots an assertion reads, so the runner fetches only those. */
export function rootsOf(a: Assertion): string[] {
  if ('live' in a || 'cursor' in a) return ['last'];
  const roots = [a.path.split('.')[0]];
  const v = a.value;
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'ref' in v) roots.push(v.ref.split('.')[0]);
  if (a.from) roots.push(a.from);
  return roots;
}
