// Mask geometry keyframes — the frontend mirror of the Rust interpolator in
// `engine/src-tauri/src/chroma/keyframes.rs` (D-034).
//
// The engine reads `subMask.parameters.chromaKeyframes` at render time and
// interpolates the shape geometry for the current source frame. This module
// lets the canvas overlay and the keyframe track show the SAME interpolated
// shape ("what you see is what renders"), and lets the MCP ops / the keyframe
// button snapshot + edit keys. Keep the two implementations in lockstep.
//
// Rules (identical to the Rust side):
//   - scalars: linear between the two bracketing keys.
//   - `rotation`: shortest signed arc (350 -> 10 passes through 0, not 180).
//   - before the first / after the last key: clamp (hold) that key.
//   - exact-on-key: that key's params.
//   - a field in only one bracketing key: held from that key.
//   - arrays / objects (brush `lines` / `points`): interpolated element-wise
//     only when the two keys have identical structure; otherwise the field
//     SNAPS to the nearer key (t < 0.5 -> low, else high). Same for any
//     non-numeric / shape-mismatched field.

export interface MaskKeyframe {
  frame: number;
  params: Record<string, any>;
}

/** Geometry keys that get keyframed, per shape sub-mask type. Grade adjustments
 *  and mode / invert / opacity are NOT keyframed (they stay on the sub-mask). */
export const GEOMETRY_KEYS: Record<string, string[]> = {
  radial: ['centerX', 'centerY', 'radiusX', 'radiusY', 'rotation', 'feather'],
  linear: ['startX', 'startY', 'endX', 'endY', 'range'],
  brush: ['lines'],
  flow: ['lines'],
  // Interactive relight (D-046). A `RelightLight` isn't a sub-mask — this key
  // is used directly by `RelightPanel`/`RelightPuckLayer` (the light object
  // itself is the "parameters" every function above operates on), not looked
  // up via `isKeyframeableMaskType`/`snapshotGeometry`'s sub-mask-type path.
  relight: ['x', 'y', 'radius', 'distance'],
};

/** The geometry keyframes are only meaningful for these sub-mask types. */
export function isKeyframeableMaskType(type: string | undefined): boolean {
  return !!type && type in GEOMETRY_KEYS;
}

/** Pull just the keyframable geometry out of a sub-mask's live parameters. */
export function snapshotGeometry(type: string, parameters: Record<string, any> | undefined): Record<string, any> {
  const keys = GEOMETRY_KEYS[type] ?? [];
  const out: Record<string, any> = {};
  for (const k of keys) {
    if (parameters && parameters[k] !== undefined) out[k] = clone(parameters[k]);
  }
  return out;
}

function clone<T>(v: T): T {
  return v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

/** Parse + frame-sort. Returns [] when absent / empty / malformed. */
export function parseKeyframes(parameters: Record<string, any> | undefined): MaskKeyframe[] {
  const raw = parameters?.chromaKeyframes;
  if (!Array.isArray(raw)) return [];
  const out: MaskKeyframe[] = [];
  for (const e of raw) {
    const f = Number(e?.frame);
    if (!Number.isFinite(f) || f < 0) continue;
    if (!e?.params || typeof e.params !== 'object') continue;
    out.push({ frame: Math.round(f), params: e.params });
  }
  out.sort((a, b) => a.frame - b.frame);
  return out;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function lerpValue(a: any, b: any, t: number, key: string): any {
  const snap = () => (t < 0.5 ? clone(a) : clone(b));
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return snap();
    if (key === 'rotation') {
      let d = (b - a) % 360;
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      return round6(a + d * t);
    }
    return round6(a + (b - a) * t);
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.map((x, i) => lerpValue(x, b[i], t, ''));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length === bk.length && ak.every((k) => k in b)) {
      const o: Record<string, any> = {};
      for (const k of ak) o[k] = lerpValue(a[k], b[k], t, k);
      return o;
    }
  }
  return snap();
}

/** Interpolate the geometry params for `frame`. `keyframes` must be frame-sorted
 *  (parseKeyframes does this). Returns {} for an empty list. */
export function interpolate(keyframes: MaskKeyframe[], frame: number): Record<string, any> {
  if (keyframes.length === 0) return {};
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (frame <= first.frame) return clone(first.params);
  if (frame >= last.frame) return clone(last.params);

  let hi = keyframes.findIndex((k) => k.frame > frame);
  if (hi < 1) hi = keyframes.length - 1;
  const lo = keyframes[hi - 1];
  const hiK = keyframes[hi];
  if (frame === lo.frame) return clone(lo.params);

  const span = hiK.frame - lo.frame;
  const t = span > 0 ? Math.min(1, Math.max(0, (frame - lo.frame) / span)) : 0;

  const out: Record<string, any> = {};
  const names = new Set([...Object.keys(lo.params), ...Object.keys(hiK.params)]);
  for (const name of names) {
    const a = lo.params[name];
    const b = hiK.params[name];
    if (a !== undefined && b !== undefined) out[name] = lerpValue(a, b, t, name);
    else out[name] = clone(a !== undefined ? a : b);
  }
  return out;
}

/** The parameters the engine will actually render for this sub-mask at `frame`:
 *  the live parameters with keyframed geometry overlaid (and `chromaKeyframes`
 *  left in place — callers that pass this to the renderer don't care, and the UI
 *  wants it). Returns the input unchanged when there are no keyframes, or when a
 *  `chromaTrackDir` is present (a tracked matte wins — D-019). */
export function effectiveParameters(
  parameters: Record<string, any> | undefined,
  frame: number,
): Record<string, any> {
  if (!parameters) return {};
  if (typeof parameters.chromaTrackDir === 'string' && parameters.chromaTrackDir) return parameters;
  const kfs = parseKeyframes(parameters);
  if (kfs.length === 0) return parameters;
  return { ...parameters, ...interpolate(kfs, frame) };
}

/** Upsert a keyframe at `frame` into a params object, returning a NEW params
 *  object. An existing key at that exact frame is replaced. Used by the keyframe
 *  button, the canvas-drag writer, and the MCP `add_mask_keyframe` op. */
export function upsertKeyframe(
  parameters: Record<string, any>,
  frame: number,
  geometry: Record<string, any>,
): Record<string, any> {
  const f = Math.max(0, Math.round(frame));
  const kfs = parseKeyframes(parameters).filter((k) => k.frame !== f);
  kfs.push({ frame: f, params: clone(geometry) });
  kfs.sort((a, b) => a.frame - b.frame);
  return { ...parameters, chromaKeyframes: kfs };
}

/** Remove the keyframe at `frame`. Drops `chromaKeyframes` entirely when none
 *  remain (so the sub-mask goes back to fully static). */
export function removeKeyframe(parameters: Record<string, any>, frame: number): Record<string, any> {
  const f = Math.round(frame);
  const kfs = parseKeyframes(parameters).filter((k) => k.frame !== f);
  const next = { ...parameters };
  if (kfs.length === 0) delete next.chromaKeyframes;
  else next.chromaKeyframes = kfs;
  return next;
}

/** Remove every keyframe (back to fully static). */
export function clearKeyframes(parameters: Record<string, any>): Record<string, any> {
  const next = { ...parameters };
  delete next.chromaKeyframes;
  return next;
}
