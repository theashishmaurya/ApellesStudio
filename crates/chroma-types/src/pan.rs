//! Per-clip stereo **pan law** (D-223).
//!
//! **What it is:** the pure math behind `chroma_timeline::Clip::pan` — turning
//!   one normalised position (`-1.0` hard left · `0.0` centre · `1.0` hard
//!   right) into the pair of per-channel amplitude multipliers a mixer applies
//!   to the left and right channels of that clip's own contribution.
//!
//! **What it does NOT do:** it does not touch samples, does not know what a
//!   clip is, and does not decide which channel of which buffer is "left" —
//!   it hands back two numbers and the two consumers decide what to multiply
//!   them into. `chroma_media::audio`'s `LevelEnvelope` multiplies them into
//!   the first two channels of a source's own interleaved buffer;
//!   `@chroma/editor`'s `timelineExportAudio.ts` mirrors this function
//!   (`panGains`) into a per-channel ffmpeg `volume` expression. Same
//!   one-model/two-consumers shape [`crate::fade`] already has, and it lives
//!   in L0 for exactly the same reason that module does: the mixer is L1 and
//!   cannot reach up to L2's `Clip` for shared arithmetic.
//!
//! ## The law: constant power, normalised to unity at centre
//!
//! [`pan_gains`] is the standard **constant-power** (sine/cosine) law —
//! `θ = (pan + 1)·π/4`, left `∝ cos θ`, right `∝ sin θ` — so that the total
//! POWER a clip contributes (`gl² + gr²`) is the same at every pan position.
//! That is what stops a source from sounding quieter as it is swept off centre,
//! which is the whole reason constant power is the standard choice over a plain
//! linear ("constant gain") crossfade between the channels.
//!
//! **The one deliberate deviation from the textbook formulation is the
//! normalisation, and it is forced rather than stylistic.** Written the usual
//! way (`gl = cos θ`, `gr = sin θ`) the law is unity at the two extremes and
//! `1/√2 ≈ 0.707` at the centre — the familiar "−3 dB centre" pan law. Chroma
//! cannot use that form: `pan` defaults to `0.0` on **every** clip, including
//! every clip in every project authored before this field existed, so a centre
//! gain of anything but exactly `1.0` would quietly attenuate every existing
//! mix by 3 dB the moment this code shipped. Scaling the whole law by `√2`
//! pins the centre at exactly unity and moves the 3 dB to the extremes
//! instead — the "0 dB centre" pan law real DAWs offer as an explicit option,
//! not an invention here.
//!
//! **What that costs, stated rather than hidden:** a hard-panned clip is
//! boosted by 3.01 dB in its destination channel (`√2`), so a source already
//! at full scale can exceed it when panned hard. Two mitigations exist and
//! neither is complete: `mix_sources`' `tanh` limiter (and the exporter's own
//! `asoftclip`) catches it whenever two or more sources are summing, but both
//! deliberately bypass the limiter for a lone source. The honest answer for a
//! hot single source is to lower that clip's own `volume` — which is why the
//! MCP tool text says so instead of leaving it to be discovered.
//!
//! `pan = 0.0` returns exactly `(1.0, 1.0)` — bit-exactly, not approximately
//! (see [`pan_gains`]'s own short-circuit and its test), which is what keeps
//! "the feature is not used" byte-identical to before it existed.

/// Left/right amplitude multipliers for a normalised `pan` position.
///
/// `-1.0` = hard left `(√2, 0)` · `0.0` = centre `(1, 1)` · `1.0` = hard right
/// `(0, √2)`. Out-of-range values are clamped to `[-1, 1]` (a pan past hard
/// left has no meaning, and the un-clamped cosine would start coming back UP
/// on the wrong side); a non-finite `pan` is read as centre, the same
/// "degrade to the identity rather than propagate NaN into audio" rule
/// [`crate::fade::fade_gain`] and `db_to_linear` already follow.
///
/// The invariant a test pins: `gl² + gr² == 2` for every `pan` — constant
/// power, at the 0 dB-centre normalisation this module's own doc explains.
/// Pure, deterministic, no allocation.
pub fn pan_gains(pan: f64) -> (f64, f64) {
    if !pan.is_finite() {
        return (1.0, 1.0);
    }
    // Exactly `(1.0, 1.0)` at centre without going through `cos`/`sin` at all:
    // `SQRT_2 * (PI/4).cos()` is 0.9999999999999999 in `f64`, not 1.0, and an
    // un-panned clip must be a bit-exact no-op — see the module doc.
    if pan == 0.0 {
        return (1.0, 1.0);
    }
    let p = pan.clamp(-1.0, 1.0);
    // The two extremes are pinned too, for the same "an exact request gets an
    // exact answer" reason. `sin(0.0)` really is `0.0`, but `cos(PI/2)` is
    // 6.1e-17 — so without this, hard LEFT would silence the right channel
    // exactly while hard RIGHT left ≈1e-16 of signal in the left one. An
    // inaudible asymmetry, but an asymmetry with no reason behind it, and
    // "hard pan silences the other channel" is a property worth being able to
    // assert as an equality rather than a tolerance.
    if p <= -1.0 {
        return (std::f64::consts::SQRT_2, 0.0);
    }
    if p >= 1.0 {
        return (0.0, std::f64::consts::SQRT_2);
    }
    let theta = (p + 1.0) * (std::f64::consts::FRAC_PI_4);
    (
        std::f64::consts::SQRT_2 * theta.cos(),
        std::f64::consts::SQRT_2 * theta.sin(),
    )
}

/// A clip's own linear volume multiplier, made safe to multiply into samples:
/// negatives (a phase flip nobody asked for) and non-finite values collapse to
/// the identity/floor rather than reaching the mixer.
///
/// **Not clamped at the top.** `Clip::volume` is a fader, and a fader that
/// cannot go above unity is not one — a quiet source legitimately needs
/// boosting, and the mixer's own limiter is where a too-hot sum is dealt with
/// (`mix_sources`). This mirrors `Track::gain`, which has no ceiling either.
/// The floor is real though: a negative multiplier would invert the waveform,
/// which is never what "quieter" means and would silently cancel a clip
/// against a duplicate of itself elsewhere in the mix.
pub fn clip_volume(volume: f64) -> f64 {
    if !volume.is_finite() {
        return 1.0;
    }
    volume.max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centre_is_bit_exactly_unity_on_both_channels() {
        // The invariant every pre-D-223 project depends on: an un-panned clip
        // is untouched, not "multiplied by something that rounds to 1".
        assert_eq!(pan_gains(0.0), (1.0, 1.0));
    }

    /// Exactly silent, not "silent to a tolerance", in BOTH directions — see
    /// the endpoint short-circuits in [`pan_gains`] for why this is asserted as
    /// an equality.
    #[test]
    fn hard_left_silences_the_right_channel_and_vice_versa() {
        assert_eq!(pan_gains(-1.0), (std::f64::consts::SQRT_2, 0.0));
        assert_eq!(pan_gains(1.0), (0.0, std::f64::consts::SQRT_2));
    }

    #[test]
    fn power_is_constant_across_the_whole_sweep() {
        // The defining property of this law, checked as arithmetic rather than
        // asserted in prose: `gl² + gr² == 2` everywhere (2, not 1, because of
        // the 0 dB-centre normalisation — see the module doc).
        for i in -100..=100 {
            let pan = i as f64 / 100.0;
            let (l, r) = pan_gains(pan);
            let power = l * l + r * r;
            assert!(
                (power - 2.0).abs() < 1e-9,
                "pan {pan}: power {power} (gains {l}, {r})"
            );
        }
    }

    #[test]
    fn the_sweep_is_monotonic_in_both_channels() {
        let mut prev = pan_gains(-1.0);
        for i in -99..=100 {
            let (l, r) = pan_gains(i as f64 / 100.0);
            assert!(l <= prev.0 + 1e-12, "left rose at pan {i}");
            assert!(r >= prev.1 - 1e-12, "right fell at pan {i}");
            prev = (l, r);
        }
    }

    #[test]
    fn out_of_range_and_nonsense_pans_degrade_instead_of_going_wrong() {
        assert_eq!(pan_gains(-4.0), pan_gains(-1.0));
        assert_eq!(pan_gains(4.0), pan_gains(1.0));
        assert_eq!(pan_gains(f64::NAN), (1.0, 1.0));
        assert_eq!(pan_gains(f64::INFINITY), (1.0, 1.0));
    }

    #[test]
    fn a_half_pan_is_between_centre_and_hard_left_on_both_channels() {
        let (l, r) = pan_gains(-0.5);
        assert!(l > 1.0 && l < std::f64::consts::SQRT_2, "left {l}");
        assert!(r > 0.0 && r < 1.0, "right {r}");
    }

    #[test]
    fn clip_volume_floors_at_silence_and_has_no_ceiling() {
        assert_eq!(clip_volume(1.0), 1.0);
        assert_eq!(clip_volume(0.0), 0.0);
        assert_eq!(clip_volume(-0.5), 0.0);
        assert_eq!(clip_volume(4.0), 4.0);
        assert_eq!(clip_volume(f64::NAN), 1.0);
    }
}
