/**
 * geometry.ts — turn a `TargetSpec` into a real point on screen (D-434).
 *
 * What it is: the half of `debug_pointer` that keeps scenarios free of
 *   hard-coded pixels. A target names an element (selector, `data-testid`, or
 *   a `debug_dom_tree` `nodeId`) and a point inside its live
 *   `getBoundingClientRect()`; this resolves it, refuses a target that cannot
 *   be pressed (no match, no box, off-screen), and reports what is ACTUALLY
 *   under that point (`elementFromPoint`) — so a press that lands on an
 *   overlay instead of the clip it aimed at is visible in the result rather
 *   than discovered three assertions later.
 *
 * What it does NOT do: dispatch anything, or wait for an element to appear.
 *   Waiting is the scenario runner's job (`packages/ui-harness`); this answers
 *   for the DOM as it is right now.
 */

import { elementByNodeId } from '../domTree';
import type { DomRect } from '../domTree';
import type { ElementSpec, Point, PointSpec } from './types';

export interface ResolvedTarget extends Point {
  /** The matched element's box, or `null` for a raw `{x, y}` target. */
  rect: DomRect | null;
  /** How many elements the query matched (1 for a raw point / node id). */
  matched: number;
  /** The element the target named. */
  element: string | null;
  /** What `elementFromPoint` reports at (x, y) — the element a real press hits. */
  hit: string | null;
  /** Whether that hit element is the target or inside it. `null` for a raw point. */
  hitInside: boolean | null;
}

export interface TargetError {
  error: string;
}

export function isTargetError(v: ResolvedTarget | TargetError): v is TargetError {
  return (v as TargetError).error !== undefined;
}

const MAX_DESCRIPTION_CHARS = 160;
/** The attributes worth naming in a one-line element description — the ones a
 *  scenario would address it by. */
const DESCRIBE_ATTRS = ['data-testid', 'data-chroma-clip-id', 'data-chroma-track', 'data-chroma-marker', 'aria-label', 'role'];

/** A one-line, human-readable name for an element: `tag#id.cls[attr=…]`. */
export function describeElement(el: Element | null): string | null {
  if (!el) return null;
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  const classes = Array.from(el.classList).slice(0, 3);
  if (classes.length) out += `.${classes.join('.')}`;
  for (const name of DESCRIBE_ATTRS) {
    const value = el.getAttribute(name);
    if (value !== null) out += `[${name}="${value}"]`;
  }
  return out.length > MAX_DESCRIPTION_CHARS ? `${out.slice(0, MAX_DESCRIPTION_CHARS)}…` : out;
}

/** `[data-testid="…"]` with the value's quotes/backslashes escaped. */
export function testIdSelector(testid: string): string {
  return `[data-testid="${testid.replace(/["\\]/g, '\\$&')}"]`;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** `doc.elementFromPoint`, tolerating a document that does not implement it
 *  (jsdom) — the caller then reports `hit: null` rather than throwing. */
function hitTest(doc: Document, p: Point): Element | null {
  return typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(p.x, p.y) : null;
}

export function resolveTarget(spec: PointSpec | ElementSpec | null | undefined, doc: Document = document): ResolvedTarget | TargetError {
  if (!spec || typeof spec !== 'object') return { error: 'a target is required: {x, y} or {selector|testid|nodeId, nth?, at?}' };
  const view = doc.defaultView;
  const vw = view?.innerWidth ?? 0;
  const vh = view?.innerHeight ?? 0;

  if ('x' in spec && 'y' in spec) {
    if (!finite(spec.x) || !finite(spec.y)) return { error: 'target x/y must be finite numbers (CSS pixels)' };
    const p = { x: spec.x, y: spec.y };
    if (p.x < 0 || p.y < 0 || p.x >= vw || p.y >= vh) {
      return { error: `point (${p.x}, ${p.y}) is outside the ${vw}×${vh} viewport` };
    }
    return { ...p, rect: null, matched: 1, element: null, hit: describeElement(hitTest(doc, p)), hitInside: null };
  }

  const ways = [spec.selector, spec.testid, spec.nodeId].filter((v) => v !== undefined).length;
  if (ways !== 1) return { error: 'name the element with exactly one of selector, testid or nodeId' };

  let matches: Element[];
  let named: string;
  if (spec.nodeId !== undefined) {
    const el = elementByNodeId(String(spec.nodeId), doc);
    if (!el) return { error: `nodeId "${spec.nodeId}" names no element now — the DOM changed since the dump; dump again` };
    matches = [el];
    named = `nodeId ${spec.nodeId}`;
  } else {
    const selector = spec.testid !== undefined ? testIdSelector(String(spec.testid)) : String(spec.selector);
    try {
      matches = Array.from(doc.querySelectorAll(selector));
    } catch (e) {
      return { error: `invalid selector ${JSON.stringify(selector)}: ${String((e as Error)?.message ?? e)}` };
    }
    named = selector;
    if (matches.length === 0) return { error: `no element matches ${selector}` };
  }

  const nth = spec.nth === undefined ? 0 : Math.trunc(Number(spec.nth));
  const index = nth < 0 ? matches.length + nth : nth;
  if (!Number.isFinite(index) || index < 0 || index >= matches.length) {
    return { error: `nth ${spec.nth} is out of range — ${named} matched ${matches.length}` };
  }
  const el = matches[index];
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) {
    return { error: `${describeElement(el)} has no box (${box.width}×${box.height}) — it is hidden or not laid out` };
  }

  const at = spec.at ?? {};
  const fx = finite(at.fx) ? at.fx : 0.5;
  const fy = finite(at.fy) ? at.fy : 0.5;
  const p = {
    x: r1(box.left + fx * box.width + (finite(at.dx) ? at.dx : 0)),
    y: r1(box.top + fy * box.height + (finite(at.dy) ? at.dy : 0)),
  };
  if (p.x < 0 || p.y < 0 || p.x >= vw || p.y >= vh) {
    return {
      error: `${describeElement(el)} resolves to (${p.x}, ${p.y}), outside the ${vw}×${vh} viewport — scroll it into view first`,
    };
  }
  const hit = hitTest(doc, p);
  return {
    ...p,
    rect: { x: r1(box.x), y: r1(box.y), width: r1(box.width), height: r1(box.height) },
    matched: matches.length,
    element: describeElement(el),
    hit: describeElement(hit),
    hitInside: hit ? el === hit || el.contains(hit) : null,
  };
}
