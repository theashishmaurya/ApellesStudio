/**
 * @apelles/editor — "is any of this clip actually on screen?", the one
 * predicate every per-clip backend fetch has to pass first (D-334, B-204).
 *
 * **What it is.** A pure overlap test between a clip's own pixel box
 * (`0..width`, in px from the clip's own left edge) and the slice of it the
 * viewport currently shows (`[visibleStartPx, visibleEndPx)`, in the same
 * base). Both ends are clamped into the clip before comparing, so a clip
 * scrolled far off either side yields an empty intersection rather than a
 * negative-width one.
 *
 * **Why it exists as its own module.** The timeline library
 * (`@xzdarcy/react-timeline-editor`) virtualizes ROWS vertically but does not
 * virtualize ACTIONS horizontally at all: every clip on a track is mounted no
 * matter where the viewport is, so on a 150-clip recut every clip's React
 * subtree — and, before this, every clip's backend fetch — ran for a viewport
 * that can show about ten of them. `Filmstrip` already defended itself against
 * exactly this, inside `requestWindow` ("what stops a 40-clip timeline from
 * requesting 40 windows when two are visible", D-128); `Waveform` did not, and
 * that asymmetry is B-204. Rather than copy the three lines into the second
 * caller, the test they share lives here and both call it — the repo's
 * standing "if two places need it, extract it" rule, and the reason a third
 * per-clip fetch added later has an obvious thing to call.
 *
 * **What it does NOT do.** It does not decide WHICH source range to fetch —
 * that is a per-feature question and stays with each caller (`Filmstrip`
 * windows and quantizes its request; `Waveform` deliberately keeps asking for
 * the whole clip range, because the backend's envelope cache is keyed on that
 * range and a windowed request would fragment it). It also has nothing to say
 * about vertical visibility: rows really are virtualized, so a clip on an
 * off-screen track is not mounted in the first place.
 */

/** Whether any part of a clip `width` px wide is inside the visible slice
 *  `[visibleStartPx, visibleEndPx)`, both measured in px from the clip's own
 *  left edge. `false` for a clip with no width, and for one scrolled entirely
 *  off either side of the viewport. */
export function isClipVisible(width: number, visibleStartPx: number, visibleEndPx: number): boolean {
  if (!(width > 0)) return false;
  const left = Math.max(0, Math.min(width, visibleStartPx));
  const right = Math.max(0, Math.min(width, visibleEndPx));
  return right > left;
}
