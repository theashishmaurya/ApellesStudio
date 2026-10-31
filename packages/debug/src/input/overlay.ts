/**
 * overlay.ts — is anything fixed on top of the parts a scenario will press? (D-434, H1)
 *
 * What it is: a pre-flight for the UI harness. `findOverlays` samples a grid of
 *   points inside each named element's box, asks the browser what is REALLY
 *   there (`elementFromPoint`), and reports every point whose hit is not the
 *   element or inside it AND sits under a `position: fixed` ancestor — a dock,
 *   a toast, a banner: chrome that floats over the page. The first live run
 *   lost 10 scenarios to the Agent activity dock covering the toolbar, and each
 *   showed up only as "aimed at X but the press lands on Y" three steps in.
 *
 * What it does NOT do: judge whether an overlay is legitimate (a scenario that
 *   opens a popover on purpose does not call this), dispatch input, or wait.
 *
 * Why not just rely on the per-press hit check: that reports the symptom once
 *   per press; this fails the whole scenario up front with the cause named.
 */

import { describeElement } from './geometry';

export interface OverlayHit {
  /** The CSS selector of the part that is covered. */
  part: string;
  x: number;
  y: number;
  /** What a press there would actually land on. */
  hit: string | null;
  /** The `position: fixed` ancestor of `hit` that floats over the part. */
  overlay: string | null;
}

/** Sample points per axis (3×3 = 9 per part): corners and middles catch a dock
 *  in any corner, cheap enough to run before every scenario. */
const GRID = 3;
/** Inset (fraction of the box) so points sit inside, not on, the edge. */
const INSET = 0.08;

function fixedAncestor(el: Element | null, doc: Document): Element | null {
  const view = doc.defaultView;
  for (let node = el; node && node !== doc.documentElement; node = node.parentElement) {
    if (view?.getComputedStyle(node).position === 'fixed') return node;
  }
  return null;
}

/** Every sampled point of `parts` that a fixed overlay covers. A selector that
 *  matches nothing, or an element with no box, is skipped (a tab that has no
 *  such part is not "covered"). */
export function findOverlays(parts: readonly string[], doc: Document = document): OverlayHit[] {
  const out: OverlayHit[] = [];
  if (typeof doc.elementFromPoint !== 'function') return out;
  for (const selector of parts) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    for (let i = 0; i < GRID; i += 1) {
      for (let j = 0; j < GRID; j += 1) {
        const x = Math.round(box.left + (INSET + ((1 - 2 * INSET) * i) / (GRID - 1)) * box.width);
        const y = Math.round(box.top + (INSET + ((1 - 2 * INSET) * j) / (GRID - 1)) * box.height);
        const hit = doc.elementFromPoint(x, y);
        if (!hit || hit === el || el.contains(hit)) continue;
        const overlay = fixedAncestor(hit, doc);
        if (!overlay || overlay.contains(el)) continue;
        out.push({ part: selector, x, y, hit: describeElement(hit), overlay: describeElement(overlay) });
      }
    }
  }
  return out;
}
