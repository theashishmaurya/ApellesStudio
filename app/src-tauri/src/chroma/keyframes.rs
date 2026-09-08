//! Mask geometry keyframes — animate a shape sub-mask across source frames
//! (roadmap round 3, "mask keyframes"; D-034).
//!
//! What it is: a shape sub-mask (`radial` / `linear` / `brush`) is normally
//!   static — its geometry (`centerX`, `radiusX`, `startX`, brush `points`, …)
//!   is one fixed value for the whole clip. When the subject moves but SAM
//!   tracking can't / shouldn't follow it (a hand, a product, a light, a
//!   reflection, a patch of sky), the user drops keyframes: at frame 0 place the
//!   shape, at frame 90 move it, and the geometry interpolates per frame during
//!   scrub / playback / export.
//! Where it lives on the sub-mask: `parameters.chromaKeyframes` — an ordered
//!   array `[{ "frame": u64, "params": { …geometry subset… } }]`. Only geometry
//!   keys are keyframed; the grade adjustments and `mode` / `invert` / `opacity`
//!   stay on the sub-mask as today. Absent by default — a sub-mask with no
//!   `chromaKeyframes` behaves exactly as before (zero change for stills and
//!   un-keyframed masks).
//! The one hook: `mask_generation::generate_sub_mask_bitmap` calls
//!   [`interpolated_parameters`] at the top; if it returns `Some`, generation
//!   proceeds with the interpolated `parameters` for
//!   `chroma::state::current_video().frame` (the same frame `export.rs` /
//!   `playback.rs` / scrub already set for the D-019 tracked matte — so scrub,
//!   playback and export all animate for free).
//!
//! Interpolation rules:
//!   - scalars (centre, radius, range, feather, rotation): linear between the two
//!     bracketing keys. **`rotation` interpolates by the shortest arc**
//!     (350° → 10° passes through 0°, not 180°).
//!   - before the first key / after the last key: **clamp (hold)** that key.
//!   - exact-on-key: that key's params, unchanged.
//!   - a field present in only one of the two bracketing keys: held from that key.
//!   - **brush `points` / `lines`**: interpolated element-wise **only when the two
//!     bracketing keys have identical structure** (same number of lines, same
//!     number of points per line). Otherwise that field **snaps to the nearer
//!     keyframe** (t < 0.5 → low key, else high key). Any non-numeric / shape-
//!     mismatched field snaps the same way.
//!   - tracked AI sub-masks (`chromaTrackDir`, D-019) and keyframed shape
//!     sub-masks are mutually exclusive: if both are present, **tracked wins**
//!     and this module is a no-op for that sub-mask.
//!
//! **Two resolvers, deliberately (D-208).** [`interpolate`] above is the
//! *mask/relight* resolver and keeps every rule in this list, including the
//! "held from that key" one — those keys are written a whole field-set at a
//! time, so a frame bracket is the right bracket. [`interpolate_param`]
//! resolves **one named param at a time, over only the keys that define it**,
//! for the Edit tab's per-property clip-transform keyframes (D-208), where
//! different params really are keyed at different frames and the hold rule
//! would turn a linear ramp into a step (B-094). See that function's own doc.
//!
//! **Per-segment easing (D-232), on [`interpolate_param`] only.** A keyframe
//! entry may carry an optional `ease` map — `{"<param>": {x1,y1,x2,y2}}` —
//! naming, per param, the [`EaseCurve`] that shapes the segment running from
//! **this** key to that param's **next** key. An absent entry means linear,
//! which is what every keyframe written before D-232 has, so nothing about the
//! stored shape of an existing project changed and the resolved value for one
//! is bit-identical to before. The curve warps `t` and only `t`: the two
//! endpoint values are still the authored ones, and `x = 1` still lands
//! exactly on the next key. See [`interpolate_param`] for why the curve is
//! stored on the segment's start key rather than as an in/out handle pair per
//! key, and why [`interpolate`] deliberately ignores it.

use chroma_types::EaseCurve;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// One keyframe: a source-frame index, the params that hold at it, and (D-232)
/// the per-param easing of the segment that *starts* here.
#[derive(Debug, Clone)]
pub struct Keyframe {
    pub frame: u64,
    pub params: Map<String, Value>,
    /// Param name → the curve shaping this key's outgoing segment for that
    /// param. Empty for every key that does not ease (the overwhelmingly
    /// common case, and every pre-D-232 key). A `BTreeMap` rather than
    /// `serde_json::Map` because the values are a real typed struct here, not
    /// arbitrary JSON — the parse either produces an [`EaseCurve`] or drops
    /// the entry, so no consumer ever has to re-validate one.
    pub ease: BTreeMap<String, EaseCurve>,
}

/// Parse `parameters.chromaKeyframes` into a frame-sorted `Vec<Keyframe>`.
///
/// `None` when the key is absent, not an array, or has no usable entries — the
/// caller then treats the sub-mask as static. Entries missing a numeric `frame`
/// or an object `params` are skipped. Ties on `frame` keep input order (a later
/// duplicate is treated as "after" the earlier one, so an exact-frame lookup
/// lands on the first).
///
/// D-232 — an entry's optional `ease` object is parsed here too, via
/// [`parse_ease_map`]. It is *optional at every level*: no `ease` key, a
/// non-object one, or a malformed curve inside it all degrade to "this param
/// is not eased" (i.e. linear) rather than failing the entry, which is the
/// same posture the rest of this parser already takes toward a malformed
/// `params` value.
pub fn parse_keyframes(parameters: &Value) -> Option<Vec<Keyframe>> {
    let arr = parameters.get("chromaKeyframes")?.as_array()?;
    let mut out: Vec<Keyframe> = arr
        .iter()
        .filter_map(|entry| {
            let frame = entry.get("frame")?.as_f64()?;
            if !frame.is_finite() || frame < 0.0 {
                return None;
            }
            let params = entry.get("params")?.as_object()?.clone();
            Some(Keyframe {
                frame: frame.round() as u64,
                params,
                ease: parse_ease_map(entry.get("ease")),
            })
        })
        .collect();
    if out.is_empty() {
        return None;
    }
    out.sort_by_key(|k| k.frame);
    Some(out)
}

/// One keyframe entry's `ease` object → the typed per-param curve map (D-232).
///
/// Every level is best-effort: an absent/non-object `ease`, or an entry inside
/// it whose four control points are not all finite numbers, contributes
/// nothing and that param simply eases linearly. That matters because this
/// data can be written by MCP (`editor_set_clip_keyframes` stores the array
/// verbatim), so "malformed" is a reachable state and must degrade to the
/// unset behaviour rather than change how an unrelated param resolves.
///
/// `x1`/`x2` are **not** clamped here — [`EaseCurve::eval`] clamps them at the
/// point of use, deliberately (see its own doc), and clamping on the way in
/// would make the stored value differ from what the author wrote.
fn parse_ease_map(value: Option<&Value>) -> BTreeMap<String, EaseCurve> {
    let mut out = BTreeMap::new();
    let Some(Value::Object(obj)) = value else {
        return out;
    };
    for (name, v) in obj {
        let read = |k: &str| v.get(k).and_then(Value::as_f64).filter(|f| f.is_finite());
        if let (Some(x1), Some(y1), Some(x2), Some(y2)) =
            (read("x1"), read("y1"), read("x2"), read("y2"))
        {
            out.insert(name.clone(), EaseCurve { x1, y1, x2, y2 });
        }
    }
    out
}

/// The interpolated geometry params for `frame`, given frame-sorted `keyframes`
/// (as returned by [`parse_keyframes`], so guaranteed non-empty).
///
/// Returns the union of every field named in the two bracketing keys, each
/// interpolated / held per the module rules.
pub fn interpolate(keyframes: &[Keyframe], frame: u64) -> Map<String, Value> {
    debug_assert!(!keyframes.is_empty());
    let first = &keyframes[0];
    let last = &keyframes[keyframes.len() - 1];

    // clamp (hold) outside the keyed range, and the single-key case
    if frame <= first.frame {
        return first.params.clone();
    }
    if frame >= last.frame {
        return last.params.clone();
    }

    // find the bracket lo.frame <= frame < hi.frame
    let hi_idx = keyframes
        .iter()
        .position(|k| k.frame > frame)
        .unwrap_or(keyframes.len() - 1)
        .max(1);
    let lo = &keyframes[hi_idx - 1];
    let hi = &keyframes[hi_idx];

    if frame == lo.frame {
        return lo.params.clone();
    }

    let span = (hi.frame - lo.frame) as f64;
    let t = if span > 0.0 {
        ((frame - lo.frame) as f64 / span).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let mut out = Map::new();
    // every field named in either key
    let mut names: Vec<&String> = lo.params.keys().chain(hi.params.keys()).collect();
    names.sort();
    names.dedup();
    for name in names {
        match (lo.params.get(name), hi.params.get(name)) {
            (Some(a), Some(b)) => {
                out.insert(name.clone(), lerp_value(a, b, t, name));
            }
            (Some(a), None) => {
                out.insert(name.clone(), a.clone());
            }
            (None, Some(b)) => {
                out.insert(name.clone(), b.clone());
            }
            (None, None) => {}
        }
    }
    out
}

/// The interpolated value of ONE named param at `frame`, considering **only
/// the keyframes that actually define that param** — the per-property
/// counterpart to [`interpolate`], added by D-208 (B-094).
///
/// [`interpolate`] brackets by frame across *every* key and then falls back to
/// the module's "a field present in only one of the two bracketing keys is
/// held from that key" rule. That rule is right for mask geometry, where every
/// key is written by one gesture and carries the same field set — but it is
/// wrong the moment different params are keyed at different frames, which is
/// exactly what per-property keyframing (D-208) produces: a `scale` keyed at 0
/// and 100 with an unrelated `opacity` key at 50 would *hold* rather than ramp
/// on both sides of frame 50, turning a linear zoom into a step.
///
/// This function instead filters first, then brackets — the same shape
/// `packages/editor/src/timelineExport.ts`'s `keyframeExprAt` already used for
/// export (it filters keys by `hasOwnProperty(param)` before building its
/// piecewise-linear ffmpeg expression), so live preview and export now agree
/// by construction.
///
/// `None` when no key defines `name` at all — the caller then uses its own
/// static fallback for that param. Clamp/hold outside the param's own keyed
/// range, exactly like [`interpolate`]; the same [`lerp_value`] does the
/// actual blend, so `rotation`'s shortest-arc rule still applies.
///
/// [`interpolate`] is unchanged and still the mask/relight path's own
/// resolver — this is deliberately a second entry point rather than a change
/// of the shared one, because the union-and-hold rule is the *documented,
/// tested* contract for those callers (see the module header) and is not a
/// bug there.
///
/// # Easing (D-232)
///
/// The segment between two of `name`'s own keys is shaped by the
/// [`EaseCurve`] the **earlier** key names for `name` in its `ease` map, if
/// any. The curve warps the normalised progress `t` and nothing else —
/// `t = curve.eval(t)` right before [`lerp_value`] — so:
///
/// - both endpoints still resolve to exactly their authored values
///   ([`EaseCurve::eval`] pins `y(0) = 0` and `y(1) = 1` regardless of the
///   handles), i.e. easing can never move a keyframe;
/// - it composes with every other rule here untouched, including
///   `rotation`'s shortest arc (the arc is chosen from the two values, then
///   traversed at the eased rate) and the hold-outside-the-range clamp;
/// - a param with no `ease` entry runs the identical `x + (y - x) * t` it
///   always did, so every pre-D-232 keyframe resolves bit-identically.
///
/// **Why the curve is stored on the segment's start key, not as an in/out
/// handle pair on each key** (After Effects' own presentation). A cubic
/// segment is defined by exactly two free control points: the outgoing handle
/// of the earlier key and the incoming handle of the later one. Those are the
/// same two points as this one [`EaseCurve`]'s `(x1,y1)`/`(x2,y2)`, so the two
/// models have identical expressive power — but the handle-pair form spreads
/// one segment's shape across two entries, which means deleting a key has to
/// repair its neighbour, and a key's two halves can disagree about a segment
/// that no longer exists. One curve per segment, owned by the key the segment
/// starts at, has neither problem: delete the key and its segment's shape goes
/// with it. The editor UI still *presents* the two control points as the
/// familiar pair of draggable handles.
///
/// **[`interpolate`] deliberately ignores `ease` entirely.** Its callers are
/// mask/relight geometry, whose keys are written a whole field-set at a time
/// by one gesture and whose interpolation contract (union-and-hold, nearest-
/// key snap for structural mismatches) is separately documented and tested
/// (D-034). Easing there is a real feature someone may want one day; it is not
/// this one, and quietly changing how every existing mask animates in order to
/// ship a clip-transform curve editor is exactly the kind of blast radius this
/// module's two-resolver split exists to avoid.
pub fn interpolate_param(keyframes: &[Keyframe], frame: u64, name: &str) -> Option<Value> {
    let mut keyed = keyframes
        .iter()
        .filter(|k| k.params.contains_key(name))
        .peekable();
    let first = *keyed.peek()?;
    if frame <= first.frame {
        return first.params.get(name).cloned();
    }

    // Walk the param's own subsequence, keeping the last key at or before
    // `frame` and the first one after it. `keyframes` is frame-sorted
    // (`parse_keyframes`' postcondition), so the filtered view is too.
    let mut lo = first;
    for k in keyed {
        if k.frame > frame {
            let (Some(a), Some(b)) = (lo.params.get(name), k.params.get(name)) else {
                return None;
            };
            let span = (k.frame - lo.frame) as f64;
            let t = if span > 0.0 {
                ((frame - lo.frame) as f64 / span).clamp(0.0, 1.0)
            } else {
                0.0
            };
            // D-232 — the segment's own easing, taken from the key it starts
            // at. `eval` pins both endpoints, so this cannot move a keyframe.
            let t = match lo.ease.get(name) {
                Some(curve) => curve.eval(t),
                None => t,
            };
            return Some(lerp_value(a, b, t, name));
        }
        lo = k;
    }
    // past the param's last key -> hold it
    lo.params.get(name).cloned()
}

/// Interpolate one JSON value. `key` is the field name (only `"rotation"` gets
/// special shortest-arc treatment). Falls back to a nearest-key **snap** for any
/// value that isn't a finite number, an equal-length array, or a same-shape
/// object.
fn lerp_value(a: &Value, b: &Value, t: f64, key: &str) -> Value {
    let snap = || if t < 0.5 { a.clone() } else { b.clone() };

    match (a, b) {
        (Value::Number(_), Value::Number(_)) => {
            let (Some(x), Some(y)) = (a.as_f64(), b.as_f64()) else {
                return snap();
            };
            if !x.is_finite() || !y.is_finite() {
                return snap();
            }
            let v = if key == "rotation" {
                // shortest signed arc from x to y, in degrees
                let mut d = (y - x) % 360.0;
                if d > 180.0 {
                    d -= 360.0;
                } else if d < -180.0 {
                    d += 360.0;
                }
                x + d * t
            } else {
                x + (y - x) * t
            };
            Value::from(round6(v))
        }
        (Value::Array(xs), Value::Array(ys)) if xs.len() == ys.len() => Value::Array(
            xs.iter()
                .zip(ys.iter())
                // nested arrays/objects (brush points) carry no field name
                .map(|(x, y)| lerp_value(x, y, t, ""))
                .collect(),
        ),
        (Value::Object(xo), Value::Object(yo)) if same_keys(xo, yo) => {
            let mut o = Map::new();
            for (k, x) in xo {
                o.insert(k.clone(), lerp_value(x, &yo[k], t, k));
            }
            Value::Object(o)
        }
        _ => snap(),
    }
}

fn same_keys(a: &Map<String, Value>, b: &Map<String, Value>) -> bool {
    a.len() == b.len() && a.keys().all(|k| b.contains_key(k))
}

/// Round to 6 decimal places so the interpolated params stay clean JSON numbers
/// (deterministic — no float dust in `grade.json`).
fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

/// The hook called from `mask_generation::generate_sub_mask_bitmap`.
///
/// `Some(parameters)` — a keyframed shape sub-mask: the returned `Value` is the
/// sub-mask's `parameters` with the geometry keys replaced by their interpolated
/// values for the currently-decoded source frame, and `chromaKeyframes` stripped
/// (so a re-entrant call is a plain static generate — no recursion, and the
/// typed param structs never see the array).
///
/// `None` — leave the sub-mask exactly as it is (the common path, zero-cost):
///   - no `chromaKeyframes` (or empty / malformed);
///   - a `chromaTrackDir` is present — a tracked AI matte wins (D-019);
///   - no video is loaded (a still — keyframes are meaningless there, and this
///     keeps still rendering byte-identical).
pub fn interpolated_parameters(parameters: &Value) -> Option<Value> {
    // tracked AI matte wins — D-019
    if parameters
        .get("chromaTrackDir")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
    {
        return None;
    }

    let keyframes = parse_keyframes(parameters)?;
    let frame = crate::chroma::state::current_video()?.frame;
    let interpolated = interpolate(&keyframes, frame);

    let mut out = parameters.clone();
    let obj = out.as_object_mut()?;
    obj.remove("chromaKeyframes");
    for (k, v) in interpolated {
        obj.insert(k, v);
    }
    Some(out)
}

// --------------------------------------------------------------------------- //
// tests — the pure interpolation model (no video I/O, parallel-safe)
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kfs(v: Value) -> Vec<Keyframe> {
        parse_keyframes(&json!({ "chromaKeyframes": v })).unwrap()
    }

    fn radial(cx: f64, cy: f64, rx: f64, ry: f64, rot: f64) -> Value {
        json!({ "centerX": cx, "centerY": cy, "radiusX": rx, "radiusY": ry, "rotation": rot })
    }

    fn get(m: &Map<String, Value>, k: &str) -> f64 {
        m.get(k).and_then(|v| v.as_f64()).unwrap()
    }

    #[test]
    fn empty_or_missing_is_none() {
        assert!(parse_keyframes(&json!({})).is_none());
        assert!(parse_keyframes(&json!({ "chromaKeyframes": [] })).is_none());
        assert!(parse_keyframes(&json!({ "chromaKeyframes": "nope" })).is_none());
        // entries with no frame / no params object are skipped -> still None
        assert!(parse_keyframes(&json!({ "chromaKeyframes": [{ "params": {} }] })).is_none());
    }

    #[test]
    fn single_key_holds_everywhere() {
        let k = kfs(json!([{ "frame": 50, "params": radial(100.0, 100.0, 20.0, 20.0, 0.0) }]));
        for f in [0u64, 50, 999] {
            let m = interpolate(&k, f);
            assert_eq!(get(&m, "centerX"), 100.0, "frame {f}");
            assert_eq!(get(&m, "radiusX"), 20.0);
        }
    }

    #[test]
    fn clamps_before_first_and_after_last() {
        let k = kfs(json!([
            { "frame": 10, "params": radial(0.0, 0.0, 10.0, 10.0, 0.0) },
            { "frame": 20, "params": radial(100.0, 0.0, 10.0, 10.0, 0.0) },
        ]));
        assert_eq!(get(&interpolate(&k, 0), "centerX"), 0.0);
        assert_eq!(get(&interpolate(&k, 10), "centerX"), 0.0);
        assert_eq!(get(&interpolate(&k, 20), "centerX"), 100.0);
        assert_eq!(get(&interpolate(&k, 999), "centerX"), 100.0);
    }

    #[test]
    fn exact_on_key_equals_that_key() {
        let a = radial(10.0, 20.0, 5.0, 6.0, 30.0);
        let b = radial(200.0, 40.0, 50.0, 60.0, 90.0);
        let k = kfs(json!([
            { "frame": 0, "params": a },
            { "frame": 100, "params": b.clone() },
            { "frame": 200, "params": radial(1.0, 1.0, 1.0, 1.0, 0.0) },
        ]));
        assert_eq!(Value::Object(interpolate(&k, 100)), b);
    }

    #[test]
    fn linear_between_keys_each_field() {
        let k = kfs(json!([
            { "frame": 0,   "params": radial(0.0, 0.0, 10.0, 20.0, 0.0) },
            { "frame": 100, "params": radial(100.0, 50.0, 30.0, 40.0, 0.0) },
        ]));
        let m = interpolate(&k, 25); // t = 0.25
        assert_eq!(get(&m, "centerX"), 25.0);
        assert_eq!(get(&m, "centerY"), 12.5);
        assert_eq!(get(&m, "radiusX"), 15.0);
        assert_eq!(get(&m, "radiusY"), 25.0);
    }

    #[test]
    fn linear_shape_fields() {
        let k = kfs(json!([
            { "frame": 0,  "params": { "startX": 0.0, "startY": 0.0, "endX": 0.0,   "endY": 100.0, "range": 50.0 } },
            { "frame": 10, "params": { "startX": 20.0, "startY": 0.0, "endX": 40.0, "endY": 100.0, "range": 70.0 } },
        ]));
        let m = interpolate(&k, 5); // t = 0.5
        assert_eq!(get(&m, "startX"), 10.0);
        assert_eq!(get(&m, "endX"), 20.0);
        assert_eq!(get(&m, "range"), 60.0);
    }

    #[test]
    fn rotation_takes_the_shortest_arc() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "rotation": 350.0 } },
            { "frame": 100, "params": { "rotation": 10.0 } },
        ]));
        // 350 -> 10 is +20 the short way; at t=0.5 that is 360 -> normalised 0
        let v = get(&interpolate(&k, 50), "rotation");
        assert!((v - 360.0).abs() < 1e-6 || v.abs() < 1e-6, "got {v}");
        // and the long way is NOT taken (would be 180)
        assert!((v - 180.0).abs() > 1.0);
    }

    #[test]
    fn rotation_negative_arc() {
        let k = kfs(json!([
            { "frame": 0,  "params": { "rotation": 10.0 } },
            { "frame": 10, "params": { "rotation": 350.0 } },
        ]));
        // 10 -> 350 is -20 the short way; t=0.5 -> 0 / 360
        let v = get(&interpolate(&k, 5), "rotation");
        assert!(v.abs() < 1e-6 || (v - 360.0).abs() < 1e-6, "got {v}");
    }

    #[test]
    fn brush_points_interpolate_when_structure_matches() {
        let k = kfs(json!([
            { "frame": 0, "params": { "lines": [
                { "tool": "brush", "brushSize": 40.0, "points": [{ "x": 0.0, "y": 0.0 }, { "x": 10.0, "y": 0.0 }] }
            ] } },
            { "frame": 10, "params": { "lines": [
                { "tool": "brush", "brushSize": 40.0, "points": [{ "x": 100.0, "y": 0.0 }, { "x": 110.0, "y": 20.0 }] }
            ] } },
        ]));
        let m = interpolate(&k, 5); // t = 0.5
        let pts = m["lines"][0]["points"].as_array().unwrap();
        assert_eq!(pts[0]["x"].as_f64().unwrap(), 50.0);
        assert_eq!(pts[1]["x"].as_f64().unwrap(), 60.0);
        assert_eq!(pts[1]["y"].as_f64().unwrap(), 10.0);
    }

    #[test]
    fn brush_points_snap_when_counts_differ() {
        let lo = json!({ "lines": [
            { "tool": "brush", "brushSize": 40.0, "points": [{ "x": 0.0, "y": 0.0 }] }
        ] });
        let hi = json!({ "lines": [
            { "tool": "brush", "brushSize": 40.0, "points": [{ "x": 100.0, "y": 0.0 }, { "x": 200.0, "y": 0.0 }] }
        ] });
        let k = kfs(json!([
            { "frame": 0,  "params": lo.clone() },
            { "frame": 10, "params": hi.clone() },
        ]));
        // t = 0.3 -> nearer the low key
        assert_eq!(interpolate(&k, 3)["lines"], lo["lines"]);
        // t = 0.7 -> nearer the high key
        assert_eq!(interpolate(&k, 7)["lines"], hi["lines"]);
    }

    #[test]
    fn field_present_in_only_one_key_is_held() {
        let k = kfs(json!([
            { "frame": 0,  "params": { "centerX": 0.0, "feather": 50.0 } },
            { "frame": 10, "params": { "centerX": 100.0 } },
        ]));
        let m = interpolate(&k, 5);
        assert_eq!(get(&m, "centerX"), 50.0);
        assert_eq!(get(&m, "feather"), 50.0); // held from the low key
    }

    #[test]
    fn keyframes_are_sorted_by_frame() {
        let k = kfs(json!([
            { "frame": 100, "params": { "centerX": 100.0 } },
            { "frame": 0,   "params": { "centerX": 0.0 } },
            { "frame": 50,  "params": { "centerX": 25.0 } },
        ]));
        assert_eq!(get(&interpolate(&k, 0), "centerX"), 0.0);
        assert_eq!(get(&interpolate(&k, 50), "centerX"), 25.0);
        assert_eq!(get(&interpolate(&k, 75), "centerX"), 62.5); // between 50->100
    }

    // --- D-208 / B-094: the per-param resolver -------------------------- //

    fn param(keyframes: &[Keyframe], frame: u64, name: &str) -> Option<f64> {
        interpolate_param(keyframes, frame, name).and_then(|v| v.as_f64())
    }

    /// The whole point: a param's own keys bracket it, and a key that does
    /// not mention that param is invisible to it. `interpolate` would hold
    /// on both sides of frame 50 here; this ramps straight through.
    #[test]
    fn per_param_ignores_keys_that_do_not_define_that_param() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "scale": 1.0 } },
            { "frame": 50,  "params": { "opacity": 0.5 } },
            { "frame": 100, "params": { "scale": 2.0 } },
        ]));
        assert_eq!(param(&k, 25, "scale"), Some(1.25));
        assert_eq!(param(&k, 50, "scale"), Some(1.5));
        assert_eq!(param(&k, 75, "scale"), Some(1.75));
        // and the union-bracket resolver really does NOT do this — the
        // divergence this function exists to close, pinned so it can't be
        // "simplified" back into one shared resolver by accident.
        assert_eq!(get(&interpolate(&k, 25), "scale"), 1.0);
    }

    /// A param defined by exactly one key is a constant everywhere, no matter
    /// how many other keys surround it.
    #[test]
    fn per_param_single_key_holds_everywhere() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "scale": 1.0 } },
            { "frame": 50,  "params": { "opacity": 0.5 } },
            { "frame": 100, "params": { "scale": 2.0 } },
        ]));
        for f in [0u64, 25, 50, 75, 100, 999] {
            assert_eq!(param(&k, f, "opacity"), Some(0.5), "frame {f}");
        }
    }

    /// Clamp/hold outside the param's OWN keyed range (not the clip's).
    #[test]
    fn per_param_clamps_outside_its_own_range() {
        let k = kfs(json!([
            { "frame": 10, "params": { "scale": 1.0 } },
            { "frame": 20, "params": { "scale": 3.0 } },
        ]));
        assert_eq!(param(&k, 0, "scale"), Some(1.0));
        assert_eq!(param(&k, 10, "scale"), Some(1.0));
        assert_eq!(param(&k, 15, "scale"), Some(2.0));
        assert_eq!(param(&k, 20, "scale"), Some(3.0));
        assert_eq!(param(&k, 999, "scale"), Some(3.0));
    }

    /// A param no key mentions is `None` — the caller's own static field wins.
    #[test]
    fn per_param_is_none_when_no_key_defines_it() {
        let k = kfs(json!([{ "frame": 0, "params": { "scale": 1.0 } }]));
        assert!(interpolate_param(&k, 0, "rotation").is_none());
    }

    /// `rotation`'s shortest-arc rule still applies — the per-param resolver
    /// delegates the actual blend to the same `lerp_value`.
    #[test]
    fn per_param_keeps_the_rotation_shortest_arc() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "rotation": 350.0 } },
            { "frame": 100, "params": { "rotation": 10.0 } },
        ]));
        let v = param(&k, 50, "rotation").unwrap();
        assert!((v - 360.0).abs() < 1e-6 || v.abs() < 1e-6, "got {v}");
    }

    /// Backward compatibility: when every key carries every param (the
    /// pre-D-208 whole-clip keyframe shape), the two resolvers agree exactly.
    #[test]
    fn per_param_matches_the_union_resolver_when_every_key_is_complete() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "scale": 1.0, "opacity": 0.0, "rotation": 0.0 } },
            { "frame": 40,  "params": { "scale": 1.5, "opacity": 0.5, "rotation": 90.0 } },
            { "frame": 100, "params": { "scale": 2.0, "opacity": 1.0, "rotation": 45.0 } },
        ]));
        for f in [0u64, 7, 40, 63, 100, 500] {
            let union = interpolate(&k, f);
            for name in ["scale", "opacity", "rotation"] {
                assert_eq!(
                    param(&k, f, name),
                    Some(get(&union, name)),
                    "{name} at frame {f}"
                );
            }
        }
    }

    #[test]
    fn unkeyframed_params_pass_through_untouched() {
        // the hook's no-op guarantee: no chromaKeyframes -> None -> the render
        // path in generate_sub_mask_bitmap is literally unchanged.
        let p = radial(10.0, 10.0, 5.0, 5.0, 0.0);
        assert!(interpolated_parameters(&p).is_none());
    }

    #[test]
    fn tracked_submask_wins_over_keyframes() {
        let p = json!({
            "chromaTrackDir": "/tmp/.chroma/mattes/abc",
            "chromaKeyframes": [
                { "frame": 0,  "params": radial(0.0, 0.0, 10.0, 10.0, 0.0) },
                { "frame": 10, "params": radial(100.0, 0.0, 10.0, 10.0, 0.0) },
            ],
        });
        assert!(interpolated_parameters(&p).is_none());
    }

    // --- D-232: per-segment easing -------------------------------------- //

    /// `ease-in`, as four control points, in the JSON shape a keyframe stores.
    fn ease_in_json() -> Value {
        json!({ "x1": 0.42, "y1": 0.0, "x2": 1.0, "y2": 1.0 })
    }

    /// A two-key `opacity` ramp 0 -> 1 over frames 0..100, optionally eased.
    fn opacity_ramp(ease: Option<Value>) -> Vec<Keyframe> {
        match ease {
            Some(e) => kfs(json!([
                { "frame": 0,   "params": { "opacity": 0.0 }, "ease": { "opacity": e } },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
            None => kfs(json!([
                { "frame": 0,   "params": { "opacity": 0.0 } },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
        }
    }

    /// **The backward-compatibility case.** Every keyframe written before
    /// D-232 has no `ease` at all, and must resolve bit-identically to before.
    #[test]
    fn an_unaeased_segment_is_exactly_the_old_linear_ramp() {
        let k = opacity_ramp(None);
        for f in (0..=100).step_by(5) {
            let expected = round6(f as f64 / 100.0);
            assert_eq!(param(&k, f, "opacity"), Some(expected), "frame {f}");
        }
    }

    /// Easing warps the RATE and only the rate: both authored keyframes still
    /// resolve to exactly their authored values. This is the property that
    /// makes a curve safe to apply to a segment at all.
    #[test]
    fn easing_never_moves_a_keyframe() {
        for e in [
            ease_in_json(),
            json!({ "x1": 0.0, "y1": 1.0, "x2": 1.0, "y2": 0.0 }),
            // deliberate overshoot, which is legal in this model
            json!({ "x1": 0.3, "y1": 2.5, "x2": 0.7, "y2": -1.5 }),
        ] {
            let k = opacity_ramp(Some(e.clone()));
            assert_eq!(param(&k, 0, "opacity"), Some(0.0), "{e} at the first key");
            assert_eq!(param(&k, 100, "opacity"), Some(1.0), "{e} at the last key");
        }
    }

    /// The curve is really applied, and it is the RIGHT curve — checked
    /// against `EaseCurve::eval` itself (the same function the compositor
    /// calls), not against a hand-copied number.
    #[test]
    fn an_eased_segment_follows_its_own_curve() {
        let k = opacity_ramp(Some(ease_in_json()));
        for f in [10_u64, 25, 50, 75, 90] {
            let expected = round6(EaseCurve::EASE_IN.eval(f as f64 / 100.0));
            let got = param(&k, f, "opacity").expect("keyed");
            assert!(
                (got - expected).abs() < 1e-6,
                "frame {f}: got {got}, expected {expected}"
            );
        }
        // ...and an ease-in really is slower than linear at the start, so this
        // test would fail for a wrong-but-plausible curve too.
        assert!(param(&k, 25, "opacity").expect("keyed") < 0.25);
    }

    /// The curve belongs to the segment's START key. A two-segment animation
    /// with only the first eased must leave the second dead straight.
    #[test]
    fn the_ease_comes_from_the_segments_start_key() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "scale": 0.0 }, "ease": { "scale": ease_in_json() } },
            { "frame": 100, "params": { "scale": 1.0 } },
            { "frame": 200, "params": { "scale": 2.0 } },
        ]));
        assert!(param(&k, 50, "scale").expect("keyed") < 0.5);
        assert_eq!(param(&k, 150, "scale"), Some(1.5));
    }

    /// Two properties keyed at the same frame ease independently — the map is
    /// per param, exactly as `params` is.
    #[test]
    fn each_param_eases_independently_at_the_same_key() {
        let k = kfs(json!([
            {
                "frame": 0,
                "params": { "opacity": 0.0, "scale": 0.0 },
                "ease": { "opacity": ease_in_json() },
            },
            { "frame": 100, "params": { "opacity": 1.0, "scale": 1.0 } },
        ]));
        assert_eq!(param(&k, 50, "scale"), Some(0.5));
        assert!(param(&k, 50, "opacity").expect("keyed") < 0.5);
    }

    /// Easing composes with `rotation`'s shortest-arc rule rather than
    /// replacing it: the arc is chosen from the two values, then traversed at
    /// the eased rate. 350 -> 10 must still go the short way, through 0.
    #[test]
    fn easing_composes_with_rotations_shortest_arc() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "rotation": 350.0 }, "ease": { "rotation": ease_in_json() } },
            { "frame": 100, "params": { "rotation": 10.0 } },
        ]));
        let mid = param(&k, 50, "rotation").expect("keyed");
        // The short way is +20 degrees; eased, we are less than half along it,
        // and nowhere near the 180 the long way would pass through.
        assert!(mid > 350.0 && mid < 360.0, "got {mid}");
        assert!(mid < 360.0);
    }

    /// A stored `linear` curve and no curve at all are the same answer.
    #[test]
    fn a_stored_linear_curve_is_the_identity() {
        let linear = json!({ "x1": 1.0/3.0, "y1": 1.0/3.0, "x2": 2.0/3.0, "y2": 2.0/3.0 });
        let eased = opacity_ramp(Some(linear));
        let plain = opacity_ramp(None);
        for f in (0..=100).step_by(10) {
            assert_eq!(
                param(&eased, f, "opacity"),
                param(&plain, f, "opacity"),
                "frame {f}"
            );
        }
    }

    /// Overshoot survives to the resolved value — a curve whose `y` dips below
    /// zero really does pull the property BACK before it moves forward
    /// (anticipation), rather than being silently clamped.
    #[test]
    fn overshoot_reaches_the_resolved_value() {
        let k = kfs(json!([
            {
                "frame": 0,
                "params": { "position_x": 0.0 },
                "ease": { "position_x": { "x1": 0.4, "y1": -0.6, "x2": 0.6, "y2": 1.0 } },
            },
            { "frame": 100, "params": { "position_x": 1.0 } },
        ]));
        assert!(param(&k, 25, "position_x").expect("keyed") < 0.0);
    }

    /// Holding outside the keyed range is unchanged by easing.
    #[test]
    fn easing_does_not_change_the_hold_outside_the_range() {
        let k = opacity_ramp(Some(ease_in_json()));
        assert_eq!(param(&k, 0, "opacity"), Some(0.0));
        assert_eq!(param(&k, 500, "opacity"), Some(1.0));
    }

    /// **`interpolate` — the mask/relight resolver — deliberately ignores
    /// `ease`.** Pinned so a later "why are there two resolvers" cleanup
    /// cannot quietly change how every existing mask animates.
    #[test]
    fn the_mask_resolver_ignores_ease_entirely() {
        let k = kfs(json!([
            { "frame": 0,   "params": { "centerX": 0.0 }, "ease": { "centerX": ease_in_json() } },
            { "frame": 100, "params": { "centerX": 100.0 } },
        ]));
        assert_eq!(get(&interpolate(&k, 25), "centerX"), 25.0);
        // ...while the per-param resolver, on the very same keys, does ease.
        assert!(param(&k, 25, "centerX").expect("keyed") < 25.0);
    }

    /// Malformed / absent ease data degrades to "not eased" rather than
    /// failing the entry or poisoning an unrelated param — the same posture
    /// `parse_keyframes` already takes toward a malformed `params` value.
    /// This data is reachable: MCP stores the keyframe array verbatim.
    #[test]
    fn malformed_ease_degrades_to_linear() {
        for bad in [
            json!("ease-in"), // a NAME, not points — names are resolved UI-side
            json!({ "opacity": { "x1": 0.4 } }), // missing points
            json!({ "opacity": { "x1": "a", "y1": 0, "x2": 1, "y2": 1 } }), // non-numeric
            json!({ "opacity": null }),
            json!([]),
        ] {
            let k = kfs(json!([
                { "frame": 0,   "params": { "opacity": 0.0 }, "ease": bad },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ]));
            assert_eq!(
                param(&k, 50, "opacity"),
                Some(0.5),
                "bad ease {bad} should be linear"
            );
        }
    }

    /// A malformed curve for ONE param must not disturb another param's real
    /// one at the same key.
    #[test]
    fn one_malformed_curve_does_not_disturb_a_sibling() {
        let k = kfs(json!([
            {
                "frame": 0,
                "params": { "opacity": 0.0, "scale": 0.0 },
                "ease": { "opacity": { "x1": "nope" }, "scale": ease_in_json() },
            },
            { "frame": 100, "params": { "opacity": 1.0, "scale": 1.0 } },
        ]));
        assert_eq!(param(&k, 50, "opacity"), Some(0.5));
        assert!(param(&k, 50, "scale").expect("keyed") < 0.5);
    }

    /// Determinism (a project invariant): the same keys and frame give a
    /// bit-identical answer every call, easing included.
    #[test]
    fn eased_resolution_is_bit_deterministic() {
        let k = opacity_ramp(Some(ease_in_json()));
        for f in (0..=100).step_by(7) {
            let a = param(&k, f, "opacity");
            let b = param(&k, f, "opacity");
            assert_eq!(a, b, "frame {f}");
        }
    }
}
