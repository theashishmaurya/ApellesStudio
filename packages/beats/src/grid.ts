/**
 * Snapping to a beat grid (D-413): pure arithmetic over sorted positions.
 *
 * Positions are whatever axis the caller works in — timeline frames on the
 * Edit tab, scene seconds on the Motion tab — so one implementation serves
 * both, and both tabs snap by the same rule: the NEAREST target within a
 * tolerance, ties to the earlier one, nothing farther than the tolerance.
 */

/** Index of the element of ascending `sorted` nearest to `x` (ties: the
 *  earlier), or -1 when `sorted` is empty. */
export function nearestIndex(sorted: readonly number[], x: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first element >= x; the nearest is it or the one before.
  if (lo > 0 && Math.abs(x - sorted[lo - 1]) <= Math.abs(sorted[lo] - x)) return lo - 1;
  return lo;
}

export interface Snap {
  /** The snapped position, or `x` unchanged. */
  value: number;
  /** Whether a target was within the tolerance. */
  snapped: boolean;
}

/** `x` moved onto the nearest of `sorted` when that is within `tolerance`. */
export function snapTo(x: number, sorted: readonly number[], tolerance: number): Snap {
  const i = nearestIndex(sorted, x);
  if (i < 0 || Math.abs(sorted[i] - x) > tolerance) return { value: x, snapped: false };
  return { value: sorted[i], snapped: true };
}

/** A span `[start, start + length)` moved so that whichever of its two edges
 *  is closer to a target lands on it (the other edge moves with it), when
 *  that target is within `tolerance`. How a dragged clip or keyframe group
 *  snaps: by its head or its tail, whichever is nearer a beat. */
export function snapSpan(start: number, length: number, sorted: readonly number[], tolerance: number): Snap {
  const head = snapTo(start, sorted, tolerance);
  const tail = snapTo(start + length, sorted, tolerance);
  if (head.snapped && (!tail.snapped || Math.abs(head.value - start) <= Math.abs(tail.value - (start + length)))) {
    return { value: head.value, snapped: true };
  }
  if (tail.snapped) return { value: tail.value - length, snapped: true };
  return { value: start, snapped: false };
}

/** The elements of ascending `sorted` within `[from, to]`. */
export function within(sorted: readonly number[], from: number, to: number): number[] {
  return sorted.filter((v) => v >= from && v <= to);
}
