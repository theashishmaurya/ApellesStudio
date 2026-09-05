/**
 * `interpolateKeys` — the ONE shared keyframe interpolator (D-159, Phase 4 of
 * `docs/notes/motion-visual-builder-research.md`: "reuse the camera's own
 * key mechanics, don't invent a second interpolator... extract that into one
 * shared `interpolateKeys` in `motion-engine` and have both the camera and
 * layer keys use it").
 *
 * Extracted, field-for-field, from `primitives/Camera.tsx`'s own (pre-D-159)
 * inline logic — this is a REFACTOR of already-working, tested code, not a
 * rewrite: sort keys by `at`, clamp before-the-first-key/after-the-last-key,
 * ease between the two keys surrounding `frame` via `Easing.bezier`, then
 * linearly interpolate each named numeric field on that eased `t`. Verified
 * byte-for-byte unchanged against `Camera.tsx`'s pre-extraction renders (see
 * D-159's own decision entry) — this file must stay behaviourally identical
 * to that original logic for every existing camera manifest.
 *
 * Generic over which numeric fields it interpolates so it serves BOTH
 * consumers this phase has: `Camera.tsx` (`x`/`y`/`zoom`, `cam2dKey`) and
 * `Video.tsx`'s `renderLayers` (`x`/`y`/`scale`/`rot`/`opacity`,
 * `transformKey` — the new per-layer transform keyframes). A future third
 * keyed shape (a fourth camera field, say) is just another `fields` array
 * and `defaults` object — no new interpolation logic.
 */
import { interpolate, Easing } from "remotion";

export interface KeyframeBase {
  at: number;
  ease?: readonly [number, number, number, number];
}

const cb = (c: readonly [number, number, number, number]) =>
  Easing.bezier(c[0], c[1], c[2], c[3]);

/**
 * @param keys      the keyframe array, `at` already converted to FRAMES
 *                   (callers convert from the manifest's seconds via
 *                   `Math.round(at * fps)`, exactly as `Video.tsx` already
 *                   does for the camera — this function knows nothing about
 *                   fps or seconds).
 * @param frame     the current frame to resolve a value at.
 * @param fields    which numeric fields to resolve — e.g. `['x','y','zoom']`.
 * @param defaults  the value each field falls back to when a given key
 *                   doesn't specify it (`Camera.tsx`'s own `x: k.x ?? cx`
 *                   pattern, generalized).
 * @param fallbackEase  the easing curve used when a key doesn't specify its
 *                   own `ease` — `design.ease.inOut` for the camera.
 * @returns         one resolved value per field in `fields`, at `frame`.
 */
export function interpolateKeys<
  Fields extends string,
  K extends KeyframeBase & Partial<Record<Fields, number>>,
>(
  keys: readonly K[],
  frame: number,
  fields: readonly Fields[],
  defaults: Record<Fields, number>,
  fallbackEase: readonly [number, number, number, number],
): Record<Fields, number> {
  const resolve = (
    k: KeyframeBase & Partial<Record<Fields, number>>,
  ): Record<Fields, number> & KeyframeBase => {
    const out = {} as Record<Fields, number>;
    for (const f of fields) {
      const v = k[f];
      out[f] = typeof v === "number" ? v : defaults[f];
    }
    return { ...out, at: k.at, ease: k.ease ?? fallbackEase };
  };

  const sorted = [...keys].sort((a, b) => a.at - b.at).map(resolve);
  const first = sorted[0] ?? resolve({ at: 0 } as KeyframeBase & Partial<Record<Fields, number>>);

  let a = first;
  let b = first;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].at <= frame) {
      a = sorted[i];
      b = sorted[i + 1] ?? sorted[i];
    }
  }
  if (frame <= first.at) {
    a = first;
    b = first;
  }

  const t =
    a.at === b.at
      ? 1
      : interpolate(frame, [a.at, b.at], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: cb(b.ease as readonly [number, number, number, number]),
        });

  const out = {} as Record<Fields, number>;
  for (const f of fields) {
    out[f] = interpolate(t, [0, 1], [a[f], b[f]]);
  }
  return out;
}
