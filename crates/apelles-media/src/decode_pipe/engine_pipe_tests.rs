//! D-452 — the pool over media-engine streams: the same lanes, slots and
//! prefetch as the ffmpeg pipes, plus what the new stream does that the pipe
//! could not: a repeated frame (a hold, a slow ramp) is served again without a
//! seek.

use super::*;

fn mp4(dir: &Path) -> PathBuf {
    let out = dir.join("engine.mp4");
    let status = crate::ffmpeg_locate::ffmpeg()
        .expect("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg("testsrc2=size=320x240:rate=30:duration=4")
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30"])
        .arg(&out)
        .status()
        .expect("ffmpeg");
    assert!(status.success());
    out
}

fn video(d: Decoded) -> VideoFrame {
    match d {
        Decoded::Video(v) => v,
        Decoded::Rgb(_) => panic!("an mp4 decoded through ffmpeg"),
    }
}

#[test]
fn a_held_frame_and_a_slow_ramp_are_served_without_a_seek() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = mp4(dir.path());
    let info = crate::video::probe(&path).expect("probe");
    let mut pipe = FramePipe::open_scaled(&path, &info, 40, Some((160, 120))).expect("open");
    let held = video(
        pipe.frame_scaled(&path, &info, 40, Some((160, 120)))
            .expect("40"),
    );
    assert_eq!(
        held.buffer.dimensions(),
        (320, 240),
        "full size, scale ignored"
    );
    // Hold last frame: the same frame, asked for again and again.
    for _ in 0..30 {
        assert!(pipe.can_serve(&path, 40, None), "a repeat is not a seek");
        let again = video(pipe.frame_scaled(&path, &info, 40, None).expect("again"));
        assert_eq!(
            again.buffer.as_ptr(),
            held.buffer.as_ptr(),
            "the same decoded frame"
        );
    }
    // A half-speed ramp: 41, 41, 42, 42, … read forward, each one once.
    for n in [41u64, 41, 42, 42, 43, 43, 44] {
        assert!(
            pipe.can_serve(&path, n, None),
            "frame {n} is a forward read or a repeat"
        );
        assert_eq!(
            video(pipe.frame_scaled(&path, &info, n, None).expect("ramp")).index,
            n
        );
    }
    // A step back past the last frame is a seek.
    assert!(!pipe.can_serve(&path, 42, None));
}

#[test]
fn a_frame_is_the_same_picture_from_a_seek_and_from_a_forward_read() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = mp4(dir.path());
    let info = crate::video::probe(&path).expect("probe");
    let mut walked = FramePipe::open_scaled(&path, &info, 0, None).expect("open");
    for n in 0..70 {
        let w = video(walked.frame_scaled(&path, &info, n, None).expect("walk"));
        if n % 23 == 5 {
            let mut cold = FramePipe::open_scaled(&path, &info, n, None).expect("open");
            let c = video(cold.frame_scaled(&path, &info, n, None).expect("seek"));
            assert!(
                crate::vt_decode::read_plane(&w.buffer, 0)
                    == crate::vt_decode::read_plane(&c.buffer, 0),
                "frame {n}: walked and seeked decodes differ"
            );
        }
    }
}
