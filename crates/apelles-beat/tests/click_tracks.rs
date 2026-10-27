//! Beat analysis against synthetic click tracks whose tempo, beats and
//! downbeats are known exactly (D-413).
//!
//! Each track is a metronome: a quiet, bright tick on every beat and a loud,
//! low "thump + tick" on every downbeat, over a little deterministic noise
//! (so the spectrogram is never digital silence between clicks). The first
//! click is a pickup beat, so the bar phase is not simply "beat 0".

use apelles_beat::source::analyze_file;
use apelles_beat::spectrum::SAMPLE_RATE;
use apelles_beat::{BeatAnalysis, BeatParams, analyze};

/// Tolerance for "the beat is on the click", seconds — MIREX's ±70 ms is the
/// field's convention; we hold ourselves to 25 ms, under a 30 fps frame.
const TOL: f64 = 0.025;

struct Truth {
    beats: Vec<f64>,
    downbeats: Vec<f64>,
}

/// A deterministic noise source (an LCG), so the tracks are bit-identical.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
    }
}

fn click_track(
    rate: u32,
    bpm: f64,
    meter: usize,
    first_beat: f64,
    pickup: usize,
    secs: f64,
) -> (Vec<f32>, Truth) {
    let n = (secs * rate as f64) as usize;
    let mut rng = Lcg(42);
    let mut x: Vec<f32> = (0..n).map(|_| rng.next() * 0.002).collect();
    let period = 60.0 / bpm;
    let mut truth = Truth {
        beats: Vec::new(),
        downbeats: Vec::new(),
    };
    let mut k = 0usize;
    loop {
        let t = first_beat + k as f64 * period;
        if t > secs - 0.5 {
            break;
        }
        let down = k >= pickup && (k - pickup).is_multiple_of(meter);
        truth.beats.push(t);
        if down {
            truth.downbeats.push(t);
        }
        let start = (t * rate as f64).round() as usize;
        let len = (0.08 * rate as f64) as usize;
        for i in 0..len {
            let Some(s) = x.get_mut(start + i) else { break };
            let tt = i as f32 / rate as f32;
            let tick = (2.0 * std::f32::consts::PI * 2200.0 * tt).sin() * (-tt * 120.0).exp();
            let thump = (2.0 * std::f32::consts::PI * 70.0 * tt).sin() * (-tt * 30.0).exp();
            *s += if down {
                0.8 * thump + 0.5 * tick
            } else {
                0.3 * tick
            };
        }
        k += 1;
    }
    (x, truth)
}

fn f_measure(found: &[f64], truth: &[f64]) -> f64 {
    let mut used = vec![false; truth.len()];
    let mut hits = 0usize;
    for f in found {
        if let Some(j) = (0..truth.len()).find(|&j| !used[j] && (truth[j] - f).abs() <= TOL) {
            used[j] = true;
            hits += 1;
        }
    }
    if found.is_empty() || truth.is_empty() {
        return 0.0;
    }
    let p = hits as f64 / found.len() as f64;
    let r = hits as f64 / truth.len() as f64;
    if p + r == 0.0 {
        0.0
    } else {
        2.0 * p * r / (p + r)
    }
}

fn check(a: &BeatAnalysis, truth: &Truth, bpm: f64) {
    assert!(
        (a.tempo_bpm - bpm).abs() / bpm < 0.01,
        "tempo {} for {bpm}",
        a.tempo_bpm
    );
    let found: Vec<f64> = a.beats.iter().map(|b| b.time).collect();
    let f = f_measure(&found, &truth.beats);
    assert!(f >= 0.98, "beat F-measure {f:.3} at {bpm} BPM: {found:?}");
    let downs: Vec<f64> = a
        .beats
        .iter()
        .filter(|b| b.downbeat)
        .map(|b| b.time)
        .collect();
    let fd = f_measure(&downs, &truth.downbeats);
    assert!(
        fd >= 0.98,
        "downbeat F-measure {fd:.3} at {bpm} BPM: {downs:?} vs {:?}",
        truth.downbeats
    );
    // Bars count from the first downbeat; beats in a bar run 1..=meter.
    let first_down = a.beats.iter().position(|b| b.downbeat).expect("a downbeat");
    assert_eq!(a.beats[first_down].bar, 1);
    assert!(a.beats[..first_down].iter().all(|b| b.bar == 0));
    for b in &a.beats {
        assert!((1..=a.meter).contains(&b.beat));
        assert_eq!(b.downbeat, b.beat == 1 && b.bar > 0);
        if b.downbeat {
            assert!(b.strong);
        }
    }
}

#[test]
fn four_four_at_common_tempos() {
    for bpm in [90.0, 100.0, 120.0, 128.0, 140.0] {
        let (x, truth) = click_track(SAMPLE_RATE, bpm, 4, 0.37, 1, 30.0);
        let a = analyze(&x, &BeatParams::default()).expect("analysis");
        check(&a, &truth, bpm);
    }
}

#[test]
fn three_four_with_the_meter_given() {
    let (x, truth) = click_track(SAMPLE_RATE, 150.0, 3, 0.21, 2, 30.0);
    let a = analyze(
        &x,
        &BeatParams {
            meter: 3,
            tempo_hint_bpm: None,
        },
    )
    .expect("analysis");
    check(&a, &truth, 150.0);
}

#[test]
fn a_slow_track_needs_its_hint() {
    // 70 BPM sits a near-octave below the default prior; the hint puts the
    // estimate where the music is.
    let (x, truth) = click_track(SAMPLE_RATE, 70.0, 4, 0.5, 0, 40.0);
    let a = analyze(
        &x,
        &BeatParams {
            meter: 4,
            tempo_hint_bpm: Some(70.0),
        },
    )
    .expect("analysis");
    check(&a, &truth, 70.0);
}

#[test]
fn the_same_samples_give_the_same_answer() {
    let (x, _) = click_track(SAMPLE_RATE, 128.0, 4, 0.1, 0, 20.0);
    let a = analyze(&x, &BeatParams::default()).expect("first");
    let b = analyze(&x, &BeatParams::default()).expect("second");
    assert_eq!(a, b);
}

/// A minimal 16-bit PCM mono WAV, written by hand so the file path exercises
/// the real decoder and resampler.
fn write_wav(path: &std::path::Path, rate: u32, x: &[f32]) {
    let data_len = (x.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + x.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in x {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, out).expect("write wav");
}

#[test]
fn a_file_is_decoded_resampled_and_cached_by_content() {
    let dir = tempfile::tempdir().expect("tempdir");
    apelles_media::media_cache::init_for_tests(dir.path().join("cache"));

    let (x, truth) = click_track(44_100, 120.0, 4, 0.37, 1, 20.0);
    let a_path = dir.path().join("bed.wav");
    write_wav(&a_path, 44_100, &x);

    let first = analyze_file(&a_path, &BeatParams::default(), false).expect("first");
    assert!(!first.cached);
    assert!(!first.beats.truncated);
    check(&first.beats.analysis, &truth, 120.0);

    let again = analyze_file(&a_path, &BeatParams::default(), false).expect("again");
    assert!(again.cached);
    assert_eq!(again.beats, first.beats);

    // The same bytes under another name: a hit, because the key is content.
    let b_path = dir.path().join("copy-of-bed.wav");
    std::fs::copy(&a_path, &b_path).expect("copy");
    let copy = analyze_file(&b_path, &BeatParams::default(), false).expect("copy");
    assert!(copy.cached);
    assert_eq!(copy.beats.content_hash, first.beats.content_hash);

    // Other params are another question.
    let waltz = analyze_file(
        &a_path,
        &BeatParams {
            meter: 3,
            tempo_hint_bpm: None,
        },
        false,
    )
    .expect("meter 3");
    assert!(!waltz.cached);

    // `force` recomputes and agrees.
    let forced = analyze_file(&a_path, &BeatParams::default(), true).expect("forced");
    assert!(!forced.cached);
    assert_eq!(forced.beats, first.beats);
}

#[test]
fn a_file_without_audio_is_a_readable_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = dir.path().join("not-audio.wav");
    std::fs::write(&p, b"definitely not a wav").expect("write");
    let err = analyze_file(&p, &BeatParams::default(), false).expect_err("must refuse");
    assert!(err.to_string().contains("decoding"), "{err}");
}

/// Pins the onset alignment (`onset.rs`): over five tempos, beats land within
/// a few milliseconds of the clicks, not a frame late or early.
#[test]
fn beats_land_on_the_clicks() {
    let mut errs = Vec::new();
    for bpm in [90.0, 100.0, 120.0, 128.0, 140.0] {
        let (x, truth) = click_track(SAMPLE_RATE, bpm, 4, 0.37, 1, 30.0);
        let a = analyze(&x, &BeatParams::default()).expect("analysis");
        for b in &a.beats {
            let nearest = truth
                .beats
                .iter()
                .map(|t| b.time - t)
                .min_by(|p, q| p.abs().total_cmp(&q.abs()))
                .expect("truth beats");
            errs.push(nearest);
        }
    }
    let mean = errs.iter().sum::<f64>() / errs.len() as f64;
    let worst = errs.iter().fold(0.0f64, |m, e| m.max(e.abs()));
    assert!(mean.abs() < 0.005, "mean offset {:.1} ms", mean * 1000.0);
    assert!(worst < 0.008, "worst offset {:.1} ms", worst * 1000.0);
}
