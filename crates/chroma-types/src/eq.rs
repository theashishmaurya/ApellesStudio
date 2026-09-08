//! Per-clip **parametric EQ** — the band value type and the biquad math behind
//! it (D-224).
//!
//! **What it is:** [`EqBand`] (the stored shape of one band of
//! `chroma_timeline::Clip::eq_bands`) plus the pure DSP that turns a band into
//! the five normalised biquad coefficients that actually filter audio, and
//! into the dB magnitude response a test or a curve readout reads off them.
//!
//! **What it does NOT do:** it does not move a buffer of samples on its own
//! (that is [`Biquad`], which the caller drives one sample at a time), does not
//! know what a clip is, and does not choose the sample rate — coefficients are
//! a function of the rate the samples are actually at, so every entry point
//! takes it. Same one-model/two-consumers shape [`crate::fade`] and
//! [`crate::pan`] already have, and it lives in L0 for exactly their reason:
//! the mixer that consumes it is L1 `chroma-media` and cannot reach up to L2's
//! `Clip`.
//!
//! ## The coefficients are the Audio EQ Cookbook's, unmodified
//!
//! Robert Bristow-Johnson's *Audio EQ Cookbook* is the standard reference
//! essentially every parametric EQ is built from, and [`EqBand::coefficients`]
//! implements its five relevant forms verbatim — peaking EQ, low shelf, high
//! shelf, 2-pole low-pass and 2-pole high-pass — with `A = 10^(gain_db/40)`,
//! `w0 = 2π·f0/fs` and `α = sin(w0)/(2Q)`, then normalised by `a0`. Nothing
//! here is an approximation or a Chroma invention. The one design choice this
//! module actually makes is to parameterise **every** kind by Q (the cookbook
//! offers Q, bandwidth or shelf slope S, and states Q is valid for the shelves
//! too), so one field set — frequency / gain / Q — covers all five kinds and
//! the Inspector never has to swap a control out per band kind.
//!
//! ## Why the EXPORT sends these numbers to ffmpeg rather than naming a filter
//!
//! Measured, not assumed (D-224). ffmpeg's own `equalizer`, `highpass` and
//! `lowpass` filters reproduce the cookbook's peaking/HP/LP forms **exactly**
//! at `width_type=q`: a measured impulse response through them matches this
//! module's analytic response to < 0.0001 dB. Its `bass`/`treble` shelves do
//! **not**. Identified from their own impulse response,
//! `bass=f=120:t=q:w=0.707:g=6` realises a biquad whose implied Q is 0.993,
//! not 0.707, and whose response overshoots to +6.29 dB at 40 Hz where the
//! cookbook's is monotone — 0.25–0.37 dB away from the same band here. Rather
//! than reverse-engineer, and then have to track, one ffmpeg build's shelf
//! parameterisation, `@chroma/editor`'s `timelineExportAudio.ts` compiles each
//! band to ffmpeg's **generic `biquad` filter** with the coefficients from this
//! exact math (mirrored there as `eqBandCoeffs`), which measures back to
//! < 0.0001 dB of the analytic response for every kind. The export then
//! depends on this module, not on ffmpeg's parameter conventions.
//!
//! ## Sample rate, and the one place the two engines can differ
//!
//! A biquad's response depends on the rate it was designed at (the bilinear
//! transform warps frequency towards Nyquist), so the live mixer designs at
//! the **output device's** rate and the exporter pins its own with an
//! `aresample` to [`EQ_DESIGN_SAMPLE_RATE`]. On a device already at 48 kHz —
//! the macOS default and the overwhelmingly common case — the two are
//! identical. At 44.1 kHz they differ by the warping alone, which is a
//! measured **≤ 0.036 dB** across 50 Hz–15 kHz for a real four-band set. This
//! is the standard, inherent property of any biquad EQ, not a divergence
//! between our two implementations, and it is stated here rather than left to
//! be found.

use serde::{Deserialize, Serialize};

/// Lowest centre/corner frequency a band may be stored at — the bottom of the
/// audible band, and of Resolve's own EQ graph axis.
pub const EQ_MIN_FREQ_HZ: f64 = 20.0;
/// Highest centre/corner frequency a band may be stored at. Clamped again, at
/// design time, to just under the real Nyquist frequency — a 20 kHz band on a
/// 32 kHz stream is not representable at all (see [`EqBand::coefficients`]).
pub const EQ_MAX_FREQ_HZ: f64 = 20_000.0;
/// Broadest allowed band (lowest Q). Below this a bell is wider than the whole
/// spectrum and has stopped being a band.
pub const EQ_MIN_Q: f64 = 0.1;
/// Sharpest allowed band. A biquad above this is a ringing resonator rather
/// than an equaliser — its impulse response is long enough to be audible as a
/// tone of its own.
pub const EQ_MAX_Q: f64 = 20.0;
/// Largest boost/cut, in dB. Resolve's own Clip Equalizer graph is labelled
/// ±24 dB (`scratch/resolve-reference/soundtrack.jpg`) and this matches it.
pub const EQ_MAX_GAIN_DB: f64 = 24.0;

/// The rate the **exporter** designs its coefficients at, pinned with an
/// `aresample` in front of the band chain because ffmpeg's `biquad` filter
/// takes literal coefficients and so has to be handed ones computed for a
/// known rate. 48 kHz: at or above every consumer source rate, so pinning it
/// is never a downsample. See the module doc for what it costs when the live
/// device runs at 44.1 kHz instead.
pub const EQ_DESIGN_SAMPLE_RATE: u32 = 48_000;

/// A real, usable positive number — NaN and infinity rejected, not merely
/// `> 0.0`'s negation.
///
/// Written as a helper rather than inline because the two are NOT the same
/// test: `!(x > 0.0)` also catches NaN (every comparison against NaN is
/// false), which is exactly what a sample rate or a corner frequency reaching
/// a filter's coefficients needs — but it reads as a double negative and
/// clippy rightly flags a negated comparison on a partially-ordered type. This
/// says the same thing positively, once.
fn is_usable(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

/// What one band DOES to the spectrum — the five shapes a real clip EQ offers.
///
/// Resolve's own Clip Equalizer (the reference this was built from —
/// `scratch/resolve-reference/soundtrack.jpg`, feature 9) presents exactly this
/// as a per-band shape dropdown: its four bands read low-shelf, bell, bell,
/// high-shelf in the screenshot, and each is switchable. Chroma offers all five
/// shapes on **every** band rather than restricting which band may be which:
/// the restriction buys nothing (coefficients are per-band regardless) and
/// would make "high-pass this clip" fail on band 2 for no reason a user could
/// see.
///
/// A notch is deliberately NOT a separate variant: a notch is a [`Self::Peak`]
/// with a deep negative gain at a high Q, which is what Resolve's own notch
/// icon draws and what the cookbook's peaking form already produces. The
/// cookbook's true `notch` form has no gain control at all, so it would need
/// its own row set for a shape a −24 dB bell already covers audibly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EqBandKind {
    /// Boost/cut everything BELOW `freq_hz`, flat above it.
    LowShelf,
    /// A bell centred on `freq_hz` — the default, and what most people mean by
    /// "parametric". Also how a notch is expressed here (deep cut, high Q).
    #[default]
    Peak,
    /// Boost/cut everything ABOVE `freq_hz`, flat below it.
    HighShelf,
    /// 2-pole roll-off below `freq_hz` — rumble and handling-noise removal,
    /// the single most common move on a dialogue clip. Ignores `gain_db`.
    HighPass,
    /// 2-pole roll-off above `freq_hz` — hiss and air removal. Ignores
    /// `gain_db`.
    LowPass,
}

impl EqBandKind {
    /// Does this shape use `gain_db` at all? `false` for the two pass filters,
    /// whose slope is fixed and whose sharpness is set by Q, not by a gain.
    ///
    /// Load-bearing rather than cosmetic, in two places: it is what lets a
    /// gain-using band sitting at exactly 0 dB short-circuit to "no filter at
    /// all" ([`EqBand::coefficients`]), and what tells the Inspector to
    /// disable a Gain row that would otherwise look editable and do nothing.
    pub fn uses_gain(self) -> bool {
        matches!(self, Self::LowShelf | Self::Peak | Self::HighShelf)
    }

    /// The stored `serde` spelling, for a label or an error message that needs
    /// to name a kind without re-deriving the mapping.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LowShelf => "low_shelf",
            Self::Peak => "peak",
            Self::HighShelf => "high_shelf",
            Self::HighPass => "high_pass",
            Self::LowPass => "low_pass",
        }
    }
}

fn default_freq_hz() -> f64 {
    1_000.0
}

/// Butterworth Q — maximally flat, the standard rest value for a shelf or a
/// pass filter and a sane middle for a bell.
fn default_q() -> f64 {
    std::f64::consts::FRAC_1_SQRT_2
}

fn default_enabled() -> bool {
    true
}

/// One band of a clip's parametric EQ (D-224).
///
/// **Every field has a named `serde` default**, so a band written by an older
/// or newer build — or by hand — loads as a well-formed band rather than as a
/// degenerate filter. `freq_hz` and `q` in particular must NOT take their
/// type's zero: `f64::default()` is `0.0`, and a band at 0 Hz with Q 0 is not a
/// filter at all — exactly the migration hazard `Clip::volume`'s own
/// `default_volume` records (D-223). `enabled` defaults to **true** for the
/// same class of reason from the other side: a band that is stored is a band
/// its author meant to act, and defaulting it to `false` would make a
/// hand-written or future-format band silently do nothing.
///
/// "This clip has no EQ" is expressed by the band **list being empty**, not by
/// a set of disabled bands — see `chroma_timeline::Clip::eq_bands`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EqBand {
    #[serde(default)]
    pub kind: EqBandKind,
    /// Centre frequency (bell) or corner frequency (shelf/pass), in Hz.
    #[serde(default = "default_freq_hz")]
    pub freq_hz: f64,
    /// Boost (positive) or cut (negative), in dB. Ignored by the two pass
    /// kinds — see [`EqBandKind::uses_gain`].
    #[serde(default)]
    pub gain_db: f64,
    /// Bandwidth, as the cookbook's Q. Higher is narrower.
    #[serde(default = "default_q")]
    pub q: f64,
    /// Per-band bypass — Resolve's own per-band enable. `false` makes the band
    /// contribute nothing without losing what it was set to, which is the whole
    /// point of having it rather than telling a user to zero the gain (and the
    /// only way at all to bypass a pass filter, which has no gain to zero).
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl Default for EqBand {
    /// Manual, not derived, for `chroma_timeline::Clip`'s own stated reason
    /// (D-082): a derived `Default` would give `freq_hz`/`q` the type's `0.0`,
    /// which is a degenerate filter rather than "a band at rest", and
    /// `enabled` the type's `false`, which contradicts that field's own doc.
    fn default() -> Self {
        Self {
            kind: EqBandKind::Peak,
            freq_hz: default_freq_hz(),
            gain_db: 0.0,
            q: default_q(),
            enabled: true,
        }
    }
}

impl EqBand {
    /// This band with every field forced into its documented range — what a
    /// writer stores, so the model is well-formed at rest rather than merely
    /// survivable at the point of use. Applied again inside
    /// [`Self::coefficients`], since a hand-edited `project.json` never went
    /// through a writer.
    ///
    /// A non-finite value falls back to the field's own default rather than
    /// propagating NaN into a filter's state, where a single NaN sample would
    /// poison every sample after it — the same "degrade to the identity" rule
    /// [`crate::fade::fade_gain`] and [`crate::pan::pan_gains`] follow, with
    /// more at stake, because an IIR filter's damage is permanent rather than
    /// per-sample.
    pub fn sanitised(self) -> Self {
        let finite = |v: f64, fallback: f64| if v.is_finite() { v } else { fallback };
        Self {
            kind: self.kind,
            freq_hz: finite(self.freq_hz, default_freq_hz()).clamp(EQ_MIN_FREQ_HZ, EQ_MAX_FREQ_HZ),
            gain_db: finite(self.gain_db, 0.0).clamp(-EQ_MAX_GAIN_DB, EQ_MAX_GAIN_DB),
            q: finite(self.q, default_q()).clamp(EQ_MIN_Q, EQ_MAX_Q),
            enabled: self.enabled,
        }
    }

    /// Does this band actually change the signal? `false` for a disabled band,
    /// and for a gain-using band sitting at exactly 0 dB — the state every band
    /// of a freshly-materialised strip is in.
    ///
    /// This is what keeps the feature free when it is not used: a clip whose
    /// bands are all inactive gets **no** filter in the mixer and **no** node
    /// in the export's filtergraph, so it runs the exact arithmetic and
    /// compiles to the exact argv it did before D-224 — the same
    /// byte-identical-when-unused contract `pan_gains(0.0)` and `fade_gain`'s
    /// own short-circuit already give.
    pub fn is_active(self) -> bool {
        self.enabled && !(self.kind.uses_gain() && self.gain_db == 0.0)
    }

    /// This band's normalised biquad coefficients at `sample_rate`, or `None`
    /// when the band does nothing ([`Self::is_active`]) or cannot be realised
    /// at that rate.
    ///
    /// **Cannot be realised** means the corner is at or above Nyquist: the
    /// bilinear transform maps every frequency into `[0, fs/2)`, so `w0 >= π`
    /// is not a filter but a degenerate denominator. The frequency is pulled
    /// just below Nyquist rather than refused, so a 20 kHz air shelf on a
    /// 32 kHz source becomes the highest shelf that source can represent
    /// instead of silently vanishing.
    ///
    /// The five forms are the Audio EQ Cookbook's, verbatim — see the module
    /// doc. Pure, deterministic, no allocation.
    pub fn coefficients(self, sample_rate: f64) -> Option<BiquadCoeffs> {
        if !self.is_active() || !is_usable(sample_rate) {
            return None;
        }
        let band = self.sanitised();
        // Never let a corner sit at or above Nyquist — see the doc above.
        // 0.995 rather than 1.0 so the highest representable band still has a
        // sliver of spectrum above it to shelve or roll off against.
        const NYQUIST_MARGIN: f64 = 0.995;
        let f0 = band.freq_hz.min(sample_rate * 0.5 * NYQUIST_MARGIN);
        if !is_usable(f0) {
            return None;
        }

        let a = 10f64.powf(band.gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * f0 / sample_rate;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / (2.0 * band.q);

        let (b0, b1, b2, a0, a1, a2) = match band.kind {
            EqBandKind::Peak => (
                1.0 + alpha * a,
                -2.0 * cos_w0,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos_w0,
                1.0 - alpha / a,
            ),
            EqBandKind::LowShelf => {
                let shelf = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 + shelf),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 - shelf),
                    (a + 1.0) + (a - 1.0) * cos_w0 + shelf,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                    (a + 1.0) + (a - 1.0) * cos_w0 - shelf,
                )
            }
            EqBandKind::HighShelf => {
                let shelf = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 + shelf),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 - shelf),
                    (a + 1.0) - (a - 1.0) * cos_w0 + shelf,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                    (a + 1.0) - (a - 1.0) * cos_w0 - shelf,
                )
            }
            EqBandKind::HighPass => (
                (1.0 + cos_w0) / 2.0,
                -(1.0 + cos_w0),
                (1.0 + cos_w0) / 2.0,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
            EqBandKind::LowPass => (
                (1.0 - cos_w0) / 2.0,
                1.0 - cos_w0,
                (1.0 - cos_w0) / 2.0,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
        };

        if a0 == 0.0 || !a0.is_finite() {
            return None;
        }
        let coeffs = BiquadCoeffs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        };
        // A sanitised band should never produce these, but a `project.json`
        // this process did not write is not a promise — and a non-finite
        // coefficient reaching a filter's state silences the clip permanently
        // rather than transiently.
        if coeffs.is_finite() {
            Some(coeffs)
        } else {
            None
        }
    }
}

/// One biquad's coefficients, already normalised by `a0` (so `a0 == 1` and is
/// not stored). The difference equation they mean is
/// `y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2] − a1·y[n−1] − a2·y[n−2]`.
///
/// The same five numbers ffmpeg's own generic `biquad` filter takes, which is
/// exactly how the exporter uses them — see the module doc.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BiquadCoeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl BiquadCoeffs {
    fn is_finite(&self) -> bool {
        self.b0.is_finite()
            && self.b1.is_finite()
            && self.b2.is_finite()
            && self.a1.is_finite()
            && self.a2.is_finite()
    }

    /// This filter's magnitude response at `freq_hz`, in dB —
    /// `20·log10|H(e^jω)|`, evaluated straight from the coefficients.
    ///
    /// The one function a response curve, a test, and a future Inspector graph
    /// all need, so the transfer function is written once. A frequency at or
    /// above Nyquist has no meaning for a discrete filter and returns `0.0`
    /// (flat) rather than a wrapped alias.
    pub fn response_db(&self, freq_hz: f64, sample_rate: f64) -> f64 {
        if !is_usable(freq_hz) || !is_usable(sample_rate) || freq_hz >= sample_rate * 0.5 {
            return 0.0;
        }
        let w = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
        // e^(−jωn) = cos(ωn) − j·sin(ωn)
        let (s1, c1) = (-w).sin_cos();
        let (s2, c2) = (-2.0 * w).sin_cos();
        let num = (self.b0 + self.b1 * c1 + self.b2 * c2).hypot(self.b1 * s1 + self.b2 * s2);
        let den = (1.0 + self.a1 * c1 + self.a2 * c2).hypot(self.a1 * s1 + self.a2 * s2);
        if den == 0.0 || num == 0.0 {
            return 0.0;
        }
        20.0 * (num / den).log10()
    }
}

/// The whole band set's combined magnitude response at `freq_hz`, in dB.
///
/// A cascade multiplies magnitudes, which is addition in dB — so this is a
/// **sum**, and an inactive band contributes exactly `0.0` rather than having
/// to be filtered out first.
pub fn eq_response_db(bands: &[EqBand], freq_hz: f64, sample_rate: f64) -> f64 {
    bands
        .iter()
        .filter_map(|b| b.coefficients(sample_rate))
        .map(|c| c.response_db(freq_hz, sample_rate))
        .sum()
}

/// One biquad section **with its own state** — the thing that actually filters
/// samples, one instance per band per channel.
///
/// **Transposed direct form II**, the standard choice for a floating-point
/// biquad: two state variables instead of four, and better numerical behaviour
/// at low corner frequencies, where a clip EQ's most common band (a high-pass
/// under 100 Hz) lives. ffmpeg's `biquad` filter defaults to direct form I;
/// both realise the identical transfer function and differ only in rounding,
/// which in `f64` is ~1e-15 — orders below the 0.05 dB the cross-engine
/// response test asserts to.
///
/// State is per channel and persists across chunk boundaries, which is the
/// whole reason this is a struct rather than a function: restarting a filter
/// every 1024-sample chunk would put a transient at every chunk edge, i.e. an
/// audible ~47 Hz buzz.
#[derive(Debug, Clone, PartialEq)]
pub struct Biquad {
    coeffs: BiquadCoeffs,
    z1: f64,
    z2: f64,
}

impl Biquad {
    pub fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            coeffs,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// One sample in, one sample out. `f64` throughout even though the mixer's
    /// buffers are `f32`: an IIR filter feeds its own rounding error back into
    /// itself, so the accumulator is the one place the extra precision is
    /// genuinely worth having.
    pub fn process(&mut self, x: f64) -> f64 {
        let c = &self.coeffs;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }

    /// Clear the state, leaving the coefficients alone.
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The cross-engine bridge (D-224).** These are the exact frequencies and
    /// dB values `packages/editor/src/timelineExport.ffmpeg.test.ts` asserts
    /// against a REAL exported file, measured through the real ffmpeg
    /// filtergraph the exporter builds for [`reference_band_set`]. Asserting
    /// the same table here — measured through the live mixer's own cascade, on
    /// a real sine — is what pins the two engines to the same numbers rather
    /// than to each other's current behaviour.
    ///
    /// Change one and the other test fails. That is the point.
    const REFERENCE_RESPONSE_DB: &[(f64, f64)] = &[
        (50.0, -10.5923),
        (120.0, -1.1989),
        (300.0, -0.2824),
        (1_000.0, -6.2239),
        (3_000.0, 0.2774),
        (8_000.0, 3.8671),
        (15_000.0, 5.3278),
    ];

    /// The band set both engines' response tests run: one high-pass, one bell
    /// cut, one shelf boost and one DISABLED band, with deliberately awkward
    /// numbers (nothing at a default, nothing round) so an accidental identity
    /// or a swapped argument cannot pass.
    ///
    /// Mirrored exactly in `timelineExport.ffmpeg.test.ts`'s own
    /// `REFERENCE_EQ_BANDS`.
    fn reference_band_set() -> Vec<EqBand> {
        vec![
            EqBand {
                kind: EqBandKind::HighPass,
                freq_hz: 90.0,
                gain_db: 0.0,
                q: 0.71,
                enabled: true,
            },
            EqBand {
                kind: EqBandKind::Peak,
                freq_hz: 950.0,
                gain_db: -6.5,
                q: 1.8,
                enabled: true,
            },
            EqBand {
                kind: EqBandKind::HighShelf,
                freq_hz: 6_200.0,
                gain_db: 5.5,
                q: 0.62,
                enabled: true,
            },
            // Disabled, and deliberately loud: if either engine ever stops
            // honouring `enabled`, this band's +18 dB at 400 Hz breaks the
            // reference table by a mile rather than by a hair.
            EqBand {
                kind: EqBandKind::LowShelf,
                freq_hz: 400.0,
                gain_db: 18.0,
                q: 0.9,
                enabled: false,
            },
        ]
    }

    /// The measured magnitude response of a real cascade on a real sine, in dB
    /// — the same quantity the exporter's ffmpeg test measures off a real
    /// file, computed here on this module's own filter so the two engines can
    /// be compared as numbers rather than as prose.
    ///
    /// Two seconds of signal, RMS taken over the second half so the filter's
    /// start-up transient is past.
    fn measured_response_db(bands: &[EqBand], freq_hz: f64, sample_rate: f64) -> f64 {
        let mut filters: Vec<Biquad> = bands
            .iter()
            .filter_map(|b| b.coefficients(sample_rate))
            .map(Biquad::new)
            .collect();
        let n = (sample_rate * 2.0) as usize;
        let settle = n / 2;
        let (mut in_sq, mut out_sq) = (0.0f64, 0.0f64);
        for i in 0..n {
            let x = (2.0 * std::f64::consts::PI * freq_hz * i as f64 / sample_rate).sin();
            let mut y = x;
            for f in filters.iter_mut() {
                y = f.process(y);
            }
            if i >= settle {
                in_sq += x * x;
                out_sq += y * y;
            }
        }
        10.0 * (out_sq / in_sq).log10()
    }

    #[test]
    fn a_band_at_rest_produces_no_filter_at_all() {
        // The byte-identical-when-unused contract: every band of a
        // freshly-materialised strip is a gain-using kind at exactly 0 dB.
        assert!(!EqBand::default().is_active());
        assert_eq!(EqBand::default().coefficients(48_000.0), None);
        for kind in [
            EqBandKind::LowShelf,
            EqBandKind::Peak,
            EqBandKind::HighShelf,
        ] {
            let b = EqBand {
                kind,
                gain_db: 0.0,
                ..EqBand::default()
            };
            assert_eq!(b.coefficients(48_000.0), None, "{kind:?} at 0 dB");
        }
    }

    #[test]
    fn a_pass_filter_is_active_at_zero_gain_because_it_has_no_gain() {
        // The reason `uses_gain` exists: a high-pass "at 0 dB" is still a
        // high-pass, so the 0 dB short-circuit above must not swallow it.
        let b = EqBand {
            kind: EqBandKind::HighPass,
            freq_hz: 80.0,
            gain_db: 0.0,
            ..EqBand::default()
        };
        assert!(b.is_active());
        assert!(b.coefficients(48_000.0).is_some());
    }

    #[test]
    fn a_disabled_band_contributes_nothing_without_losing_its_settings() {
        let b = EqBand {
            kind: EqBandKind::Peak,
            freq_hz: 1_000.0,
            gain_db: 9.0,
            q: 2.0,
            enabled: false,
        };
        assert!(!b.is_active());
        assert_eq!(b.coefficients(48_000.0), None);
        // …and the values are still there to be re-enabled.
        assert_eq!(b.gain_db, 9.0);
        assert!(
            EqBand { enabled: true, ..b }
                .coefficients(48_000.0)
                .is_some()
        );
    }

    /// The cookbook's own defining property for a bell, and the number every
    /// parametric EQ is judged by: at the centre frequency the response IS the
    /// gain, exactly, for every Q.
    #[test]
    fn a_peak_hits_exactly_its_gain_at_its_centre_frequency() {
        for &gain in &[-24.0, -9.0, -3.0, 3.0, 6.0, 12.0, 24.0] {
            for &q in &[0.5, 0.707, 1.0, 4.0, 10.0] {
                let c = EqBand {
                    kind: EqBandKind::Peak,
                    freq_hz: 1_000.0,
                    gain_db: gain,
                    q,
                    enabled: true,
                }
                .coefficients(48_000.0)
                .expect("active");
                let at_centre = c.response_db(1_000.0, 48_000.0);
                assert!(
                    (at_centre - gain).abs() < 1e-9,
                    "gain {gain} q {q}: centre response {at_centre}"
                );
            }
        }
    }

    /// A bell is unity far from its centre — what makes it a BAND rather than a
    /// gain stage, and what makes the dB sum in [`eq_response_db`] meaningful.
    #[test]
    fn a_peak_is_flat_far_from_its_centre() {
        let c = EqBand {
            kind: EqBandKind::Peak,
            freq_hz: 1_000.0,
            gain_db: 12.0,
            q: 4.0,
            enabled: true,
        }
        .coefficients(48_000.0)
        .expect("active");
        assert!(c.response_db(20.0, 48_000.0).abs() < 0.02);
        assert!(c.response_db(18_000.0, 48_000.0).abs() < 0.02);
    }

    /// The cookbook's other pinned property: a shelf's corner frequency is its
    /// **half-gain** point, and its far side reaches the full gain.
    #[test]
    fn a_shelf_is_half_gain_at_its_corner_and_full_gain_beyond_it() {
        let low = EqBand {
            kind: EqBandKind::LowShelf,
            freq_hz: 200.0,
            gain_db: 8.0,
            q: std::f64::consts::FRAC_1_SQRT_2,
            enabled: true,
        }
        .coefficients(48_000.0)
        .expect("active");
        assert!((low.response_db(200.0, 48_000.0) - 4.0).abs() < 1e-9);
        assert!((low.response_db(20.0, 48_000.0) - 8.0).abs() < 0.05);
        assert!(low.response_db(8_000.0, 48_000.0).abs() < 0.05);

        let high = EqBand {
            kind: EqBandKind::HighShelf,
            freq_hz: 4_000.0,
            gain_db: -6.0,
            q: std::f64::consts::FRAC_1_SQRT_2,
            enabled: true,
        }
        .coefficients(48_000.0)
        .expect("active");
        assert!((high.response_db(4_000.0, 48_000.0) + 3.0).abs() < 1e-9);
        assert!((high.response_db(20_000.0, 48_000.0) + 6.0).abs() < 0.2);
        assert!(high.response_db(100.0, 48_000.0).abs() < 0.05);
    }

    /// A Butterworth (Q = 1/√2) pass filter is −3.01 dB at its corner and rolls
    /// off ~12 dB/octave — the textbook 2-pole answer, checked as arithmetic.
    #[test]
    fn a_butterworth_pass_filter_is_minus_three_db_at_its_corner_and_rolls_off_two_poles() {
        for (kind, corner, octave_away) in [
            (EqBandKind::HighPass, 200.0, 100.0),
            (EqBandKind::LowPass, 4_000.0, 8_000.0),
        ] {
            let c = EqBand {
                kind,
                freq_hz: corner,
                gain_db: 0.0,
                q: std::f64::consts::FRAC_1_SQRT_2,
                enabled: true,
            }
            .coefficients(48_000.0)
            .expect("active");
            let at_corner = c.response_db(corner, 48_000.0);
            assert!(
                (at_corner + 3.0103).abs() < 0.01,
                "{kind:?} at corner: {at_corner}"
            );
            // One octave into the stop band the 2-pole slope has taken a
            // further ~12 dB. A band rather than a point, because the ideal
            // asymptote is only reached well past the corner.
            let further = c.response_db(octave_away, 48_000.0) - at_corner;
            assert!(
                (-14.0..-9.0).contains(&further),
                "{kind:?} one octave on: {further} dB"
            );
        }
    }

    /// The bridge between the analytic response and the filter that actually
    /// runs: a real sine, pushed through a real [`Biquad`] cascade, measures
    /// the response the coefficients predict. Without this, every other test
    /// here proves only the algebra, not the code that filters audio.
    #[test]
    fn the_real_cascade_measures_the_response_its_coefficients_predict() {
        let bands = reference_band_set();
        for &(freq, _) in REFERENCE_RESPONSE_DB {
            let predicted = eq_response_db(&bands, freq, 48_000.0);
            let measured = measured_response_db(&bands, freq, 48_000.0);
            assert!(
                (predicted - measured).abs() < 0.01,
                "{freq} Hz: analytic {predicted:.4} dB vs measured {measured:.4} dB"
            );
        }
    }

    #[test]
    fn the_reference_band_set_measures_the_table_the_export_test_also_asserts() {
        for &(freq, expected) in REFERENCE_RESPONSE_DB {
            let measured = measured_response_db(&reference_band_set(), freq, 48_000.0);
            assert!(
                (measured - expected).abs() < 0.01,
                "{freq} Hz: mixer measured {measured:.4} dB, the shared table says {expected:.4} dB"
            );
        }
    }

    /// The rate divergence the module doc quantifies, asserted rather than
    /// claimed: the same bands designed at 44.1 kHz instead of 48 kHz differ by
    /// the bilinear warping alone.
    #[test]
    fn designing_at_forty_four_one_instead_of_forty_eight_moves_the_curve_by_hundredths_of_a_db() {
        let bands = reference_band_set();
        let mut worst: f64 = 0.0;
        for &(freq, _) in REFERENCE_RESPONSE_DB {
            let at48 = eq_response_db(&bands, freq, 48_000.0);
            let at441 = eq_response_db(&bands, freq, 44_100.0);
            worst = worst.max((at48 - at441).abs());
        }
        assert!(worst < 0.05, "worst rate divergence {worst:.4} dB");
    }

    #[test]
    fn nonsense_values_degrade_to_a_well_formed_band_instead_of_going_wrong() {
        let b = EqBand {
            kind: EqBandKind::Peak,
            freq_hz: f64::NAN,
            gain_db: 900.0,
            q: -4.0,
            enabled: true,
        }
        .sanitised();
        assert_eq!(b.freq_hz, default_freq_hz());
        assert_eq!(b.gain_db, EQ_MAX_GAIN_DB);
        assert_eq!(b.q, EQ_MIN_Q);
        // …and it produces a real, finite filter rather than a NaN one, which
        // would poison every sample after the first.
        let c = b.coefficients(48_000.0).expect("still a filter");
        assert!(c.is_finite());
    }

    #[test]
    fn a_corner_above_nyquist_is_pulled_below_it_rather_than_vanishing() {
        // 20 kHz on a 32 kHz stream: not representable as authored, but a real
        // filter at the top of what that stream HAS is what the author meant.
        let c = EqBand {
            kind: EqBandKind::LowPass,
            freq_hz: 20_000.0,
            gain_db: 0.0,
            q: std::f64::consts::FRAC_1_SQRT_2,
            enabled: true,
        }
        .coefficients(32_000.0)
        .expect("realisable");
        assert!(c.is_finite());
        // Still a low-pass: flat well below, and it has not wrapped round into
        // a boost.
        assert!(c.response_db(1_000.0, 32_000.0).abs() < 0.5);
        assert!(c.response_db(15_000.0, 32_000.0) < 0.5);
    }

    #[test]
    fn an_impossible_sample_rate_produces_no_filter_rather_than_a_panic() {
        let b = EqBand {
            kind: EqBandKind::Peak,
            gain_db: 6.0,
            ..EqBand::default()
        };
        assert_eq!(b.coefficients(0.0), None);
        assert_eq!(b.coefficients(-48_000.0), None);
    }

    #[test]
    fn a_missing_key_deserialises_to_the_field_default_not_the_types_zero() {
        // The migration property: a band written by a build that did not have
        // one of these keys must load as a WORKING band. `f64::default()` is
        // 0.0 — a 0 Hz corner at Q 0 is degenerate, exactly the hazard
        // `Clip::volume`'s named default records.
        let b: EqBand = serde_json::from_str("{}").expect("all keys default");
        assert_eq!(b, EqBand::default());
        assert_eq!(b.kind, EqBandKind::Peak);
        assert_eq!(b.freq_hz, 1_000.0);
        assert_eq!(b.q, std::f64::consts::FRAC_1_SQRT_2);
        assert!(b.enabled, "a stored band acts unless explicitly disabled");
    }

    #[test]
    fn the_stored_json_shape_is_snake_case_and_round_trips() {
        let b = EqBand {
            kind: EqBandKind::HighShelf,
            freq_hz: 6_000.0,
            gain_db: -3.5,
            q: 1.2,
            enabled: true,
        };
        let json = serde_json::to_string(&b).expect("serialises");
        assert!(json.contains(r#""kind":"high_shelf""#), "{json}");
        assert_eq!(
            serde_json::from_str::<EqBand>(&json).expect("round trip"),
            b
        );
    }

    #[test]
    fn a_cascade_is_the_db_sum_of_its_bands() {
        // Why `eq_response_db` sums rather than multiplies: a cascade
        // multiplies magnitudes, which is addition in dB.
        let a = EqBand {
            kind: EqBandKind::Peak,
            freq_hz: 1_000.0,
            gain_db: 6.0,
            q: 1.0,
            enabled: true,
        };
        let b = EqBand { gain_db: -2.0, ..a };
        let both = eq_response_db(&[a, b], 1_000.0, 48_000.0);
        assert!((both - 4.0).abs() < 1e-9, "{both}");
    }

    #[test]
    fn a_biquad_with_the_identity_coefficients_passes_samples_through_unchanged() {
        let mut f = Biquad::new(BiquadCoeffs {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        });
        for x in [0.0, 0.5, -0.25, 1.0, -1.0] {
            assert_eq!(f.process(x), x);
        }
    }

    #[test]
    fn a_biquads_state_carries_across_calls_and_reset_clears_it() {
        let c = EqBand {
            kind: EqBandKind::LowPass,
            freq_hz: 1_000.0,
            gain_db: 0.0,
            q: std::f64::consts::FRAC_1_SQRT_2,
            enabled: true,
        }
        .coefficients(48_000.0)
        .expect("active");
        let mut f = Biquad::new(c);
        let first = f.process(1.0);
        let second = f.process(0.0);
        // A low-pass rings on after the impulse — that ring IS the state, and
        // it is exactly what rebuilding the filter per chunk would destroy.
        assert!(second != 0.0, "no state carried: {second}");
        f.reset();
        assert_eq!(f.process(1.0), first, "reset did not clear the state");
    }
}
