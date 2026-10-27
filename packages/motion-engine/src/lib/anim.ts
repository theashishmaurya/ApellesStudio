/**
 * `anim` property tracks, applied (D-405).
 *
 * What it is: the render-time half of `schema.ts`'s `animSchema`. Given a
 * layer and the current frame, returns the layer with every animated prop
 * replaced by its value at that frame. Numeric props interpolate linearly on
 * the eased progress; colour props through Remotion's `interpolateColors`. The
 * timing (which two keys, how far between, which ease) is `keySegment`, the
 * same function the camera and transform keys use, so every keyframe in the
 * engine moves on one rule.
 *
 * What it does NOT do: validate (the schema refused bad tracks before this
 * runs), or animate anything but the layer's own props.
 */
import { interpolate, interpolateColors } from "remotion";
import { motion } from "../design";
import { keySegment } from "./interpolateKeys";

interface AnimKey {
  at: number;
  v: number | string;
  ease?: readonly [number, number, number, number];
}

/** The value of one track at `frame` (keys' `at` in seconds). */
export function trackValue(keys: readonly AnimKey[], frame: number, fps: number): number | string | undefined {
  if (keys.length === 0) return undefined;
  const frameKeys = keys.map((k) => ({ ...k, at: Math.round(k.at * fps) }));
  const { a, b, t } = keySegment(frameKeys, frame, motion.ease.inOut);
  if (typeof a.v === "number" && typeof b.v === "number") return interpolate(t, [0, 1], [a.v, b.v]);
  if (typeof a.v === "string" && typeof b.v === "string") {
    return interpolateColors(Math.max(0, Math.min(1, t)), [0, 1], [a.v, b.v]);
  }
  return a.v;
}

/** `layer` with its `anim` tracks applied at `frame`; the same object when it
 *  has none (so a layer that never animates renders exactly as before). */
export function applyAnim<T extends Record<string, unknown>>(layer: T, frame: number, fps: number): T {
  const anim = layer.anim as Record<string, AnimKey[]> | undefined;
  if (!anim || Object.keys(anim).length === 0) return layer;
  const out: Record<string, unknown> = { ...layer };
  for (const [path, keys] of Object.entries(anim)) {
    const value = trackValue(keys, frame, fps);
    if (value === undefined) continue;
    const [head, sub] = path.split(".");
    if (sub === undefined) {
      out[head] = value;
    } else {
      const parent = out[head];
      if (parent && typeof parent === "object" && !Array.isArray(parent)) {
        out[head] = { ...(parent as Record<string, unknown>), [sub]: value };
      }
    }
  }
  return out as T;
}
