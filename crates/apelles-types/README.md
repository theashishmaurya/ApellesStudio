# apelles-types

**Layer 0 (foundation).** Shared value types for the whole Apelles workspace:
`Resolution`, `Rational`, `ChromaError`, the `fade` curve model, the `pan` law,
the `eq` band model + biquad math, and the `adjustment` colour operator (all
real, in use). `Frame`, `ColorSpace`, `TimeRange`, and typed IDs stay
undesigned — no real duplicate of any of them turned up in the `app/src-tauri`
audit, see below.

- **Deps:** `serde`, `thiserror`. Nothing heavy — no `wgpu`, no `ffmpeg`, no fs.
- **Depended on by:** every other `chroma-*` crate. It is the root of the
  one-directional dependency graph (D-039). `apelles-motion` (D-046) already
  consumes `ChromaError`; `app/src-tauri` (D-053) now consumes `Resolution`;
  `apelles-timeline` and `apelles-media` (D-147) both consume `fade`.
- **`src/fade.rs` (D-147)** is the one piece of real *math* here, as opposed to
  plain value types: `FadeCurve { x1, y1, x2, y2 }` — the CSS / After Effects
  `cubic-bezier` model — plus `fade_gain()`, a Newton–Raphson-with-bisection
  inverse solve (WebKit's `UnitBezier`). Pure `f64`, deterministic, no I/O,
  unit-agnostic. It is **here rather than beside the `Clip` fields it
  evaluates** because its two consumers straddle layers: `apelles-timeline`
  (L2) uses it for the compositor's `opacity`, `apelles-media` (L1) for the
  audio mixer's gain, and L1 cannot depend on L2. `apelles-timeline` re-exports
  `FadeCurve`/`fade_gain`, so callers working in the timeline model need not
  know it came from here.
- **`src/pan.rs` (D-223)** is the second piece of real math, here for exactly
  `fade.rs`'s reason: `pan_gains()` turns `Clip::pan` (L2) into the two
  per-channel multipliers the audio mixer (L1) applies, and L1 cannot depend on
  L2. Constant power, normalised to **unity at the centre** rather than at the
  extremes — `pan` defaults to `0.0` on every clip ever authored, so a centre
  gain of anything but exactly `1.0` would have attenuated every existing mix
  by 3 dB; the module doc has the full argument and what that costs (a 3.01 dB
  boost at a hard pan). `clip_volume()` beside it is the matching guard for
  `Clip::volume` (floored at silence, no ceiling — it is a fader).
  `@apelles/editor`'s `panGains` mirrors this function for the ffmpeg exporter;
  both are pinned to the same constant-power invariant by their own tests.
- **`src/eq.rs` (D-224)** is the third, and the largest: `EqBand`
  (`Clip::eq_bands`' own element type) plus the Audio EQ Cookbook's five biquad
  forms — peaking, low/high shelf, 2-pole low/high-pass — their magnitude
  response, and a stateful transposed-direct-form-II `Biquad`. Here for
  `fade.rs`'s reason (the mixer that runs the filters is L1), with one
  difference that makes it more load-bearing than the other two: the ffmpeg
  **exporter consumes the coefficients this produces directly**, via ffmpeg's
  generic `biquad` filter, rather than naming one of ffmpeg's own EQ filters —
  because its `bass`/`treble` shelves measurably do not implement the
  cookbook's Q parameterisation (0.25–0.37 dB off, identified from their own
  impulse response). So this module is the single definition of what a band
  means in BOTH engines. `@apelles/editor`'s `eq.ts` mirrors it; the two are
  pinned to one shared response table that each measures through its own
  engine.

- **`src/adjustment.rs` (D-230)** is the fourth, and the only one that is not
  audio: `AdjustmentLayer` (an adjustment clip's five-parameter primary
  correction — `Clip::adjustment`'s own element type) plus the two-stage colour
  operator it resolves to. Here for `eq.rs`'s reason in its strongest form —
  **both pixel consumers consume the OPERATOR rather than re-deriving the
  correction**: `chroma::edit`'s CPU compositor applies it per pixel, and
  `@apelles/editor`'s ffmpeg compiler emits it as `lutrgb` + `colorchannelmixer`.
  That is what makes an adjustment clip's live preview and its export the same
  maths by construction instead of by two implementations agreeing. The split
  into two stages is not aesthetic, it is what ffmpeg can execute: the gain
  stage needs `lutrgb`'s uncapped expressions (a single folded matrix breaches
  `colorchannelmixer`'s ±2 coefficient cap at ordinary settings), and the
  saturation matrix provably never reaches that cap, so there is no clamp here
  at all. `apply_rgb8` deliberately mirrors ffmpeg's own 8-bit behaviour —
  `lutrgb` truncates, `colorchannelmixer` rounds, and there is a real
  quantisation between them — because being *more* accurate than the exporter
  would mean disagreeing with it. Measured agreement: ≤ 1/255. See D-230 and
  `docs/notes/adjustment-clips.md`.

## Status

D-039 migration **step 2 (D-053)** — real, in-use types, not a placeholder
skeleton anymore, but still deliberately small:

- **`Resolution { width, height }`** — real, migrated into `app/src-tauri/src/
  chroma/{video,commands,session,project}.rs` (`video::VideoInfo`, its
  `VideoInfoDto`/`ShotDto`/`MediaVideoInfo` DTOs) via `#[serde(flatten)]`.
  Field names (`width`/`height`) deliberately match every call site's
  pre-existing JSON keys exactly, so this was a zero-wire-change migration —
  verified by a round-trip test in `src/lib.rs` and a real `cargo test
  chroma::` pass (107/107, unchanged from the pre-migration baseline).
  Gained a `Display` impl (`"1920x1080"`) along the way.
- **`Rational { num, den }`** — real, used by `export.rs`'s ffmpeg `-r`/
  `-framerate` arg string (`Display` → `"{num}/{den}"`, replacing a bare
  `format!` call). No `simplify()`/GCD-reduction was added — no ad-hoc
  duplicate of that logic was found anywhere in the audit, so it would have
  been speculative, not extracted.
- **`ChromaError`** — still just the D-046 placeholder shape (`Invalid`/
  `NotFound`/`Unsupported`), unchanged this step. `app/src-tauri`'s Tauri
  commands deliberately do **not** adopt it — they return `Result<T, String>`
  (Tauri's own IPC error convention) or `anyhow::Result`, which is the
  *correct* convention for that layer, not a duplicate to migrate away. The
  one dedicated error enum found in `app/src-tauri/src/chroma/*`
  (`control.rs`'s single-variant `BridgeErr::Timeout`) is a distinct concept
  (an HTTP-bridge timeout), not a `ChromaError` case.
- **`ColorSpace`, `TimeRange`, typed IDs** — not added. `app/src-tauri`
  stores colour space as a free `String` deliberately (D-038: "store +
  surface only," real colour management is D-004); no `TimeRange`-shaped
  struct exists outside `apelles-timeline` (out of scope for this step, see
  D-053's note on `apelles-timeline`'s `TimelineError` as a *possible*
  follow-up, not migrated).
- **Deliberately NOT migrated**, despite having `width`/`height`-ish fields:
  `project.rs::ProjectSettings` (D-038's output spec) and `export.rs::
  ExportOpts` — both use *independently*-optional width/height for a
  partial-override/patch model (`merge_patch`, `resolve_export_resolution`),
  which is a genuinely different concept from `Resolution`'s atomicity, not
  a superficial-vs-real distinction. Full reasoning in **D-053**
  (`docs/08-decisions.md`).
