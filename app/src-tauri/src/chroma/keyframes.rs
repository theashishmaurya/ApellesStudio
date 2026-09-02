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

use serde_json::{Map, Value};

/// One keyframe: a source-frame index and the geometry params that hold at it.
#[derive(Debug, Clone)]
pub struct Keyframe {
    pub frame: u64,
    pub params: Map<String, Value>,
}

/// Parse `parameters.chromaKeyframes` into a frame-sorted `Vec<Keyframe>`.
///
/// `None` when the key is absent, not an array, or has no usable entries — the
/// caller then treats the sub-mask as static. Entries missing a numeric `frame`
/// or an object `params` are skipped. Ties on `frame` keep input order (a later
/// duplicate is treated as "after" the earlier one, so an exact-frame lookup
/// lands on the first).
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
            })
        })
        .collect();
    if out.is_empty() {
        return None;
    }
    out.sort_by_key(|k| k.frame);
    Some(out)
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
}
