//! D-452 — the pool over media-engine streams: what the stream does that the
//! `ffmpeg` pipe before it could not: a repeated frame (a hold, a slow ramp) is
//! served again without a seek, and a frame is the same picture whether it was
//! reached by a seek or by reading forward.

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

#[test]
fn a_held_frame_and_a_slow_ramp_are_served_without_a_seek() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = mp4(dir.path());
    let info = crate::video::probe(&path).expect("probe");
    let mut pipe = FramePipe::open(&path, &info, 40).expect("open");
    let held = pipe.frame(&path, &info, 40).expect("40");
    assert_eq!(held.buffer.dimensions(), (320, 240), "full size");
    // Hold last frame: the same frame, asked for again and again.
    for _ in 0..30 {
        assert!(pipe.can_serve(&path, 40), "a repeat is not a seek");
        let again = pipe.frame(&path, &info, 40).expect("again");
        assert_eq!(
            again.buffer.as_ptr(),
            held.buffer.as_ptr(),
            "the same decoded frame"
        );
    }
    // A half-speed ramp: 41, 41, 42, 42, … read forward, each one once.
    for n in [41u64, 41, 42, 42, 43, 43, 44] {
        assert!(
            pipe.can_serve(&path, n),
            "frame {n} is a forward read or a repeat"
        );
        assert_eq!(pipe.frame(&path, &info, n).expect("ramp").index, n);
    }
    // A step back past the last frame is a seek.
    assert!(!pipe.can_serve(&path, 42));
}

#[test]
fn a_frame_is_the_same_picture_from_a_seek_and_from_a_forward_read() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = mp4(dir.path());
    let info = crate::video::probe(&path).expect("probe");
    let mut walked = FramePipe::open(&path, &info, 0).expect("open");
    for n in 0..70 {
        let w = walked.frame(&path, &info, n).expect("walk");
        if n % 23 == 5 {
            let mut cold = FramePipe::open(&path, &info, n).expect("open");
            let c = cold.frame(&path, &info, n).expect("seek");
            assert!(
                crate::vt_decode::read_plane(&w.buffer, 0)
                    == crate::vt_decode::read_plane(&c.buffer, 0),
                "frame {n}: walked and seeked decodes differ"
            );
        }
    }
}
