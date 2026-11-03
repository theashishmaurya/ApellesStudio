//! The encoder end to end: buffers from its pool, a file ffprobe reads back
//! with the frame count, codec, rate and Rec.709 tags it was written with, and
//! frames the media-engine decoder reads back as the pictures that went in.

use super::*;

/// Fill an NV12 buffer with a flat Y'CbCr value (test-only: the production
/// path never writes pixels on the CPU).
fn fill_nv12(buffer: &PixelBuffer, y: u8, cb: u8, cr: u8) {
    use objc2_core_video as cv;
    let pb = buffer.as_cv();
    // SAFETY: lock / write within each plane's rows / unlock.
    unsafe {
        cv::CVPixelBufferLockBaseAddress(pb, cv::CVPixelBufferLockFlags(0));
        for plane in 0..2 {
            let base = cv::CVPixelBufferGetBaseAddressOfPlane(pb, plane) as *mut u8;
            let stride = cv::CVPixelBufferGetBytesPerRowOfPlane(pb, plane);
            let rows = cv::CVPixelBufferGetHeightOfPlane(pb, plane);
            let width = cv::CVPixelBufferGetWidthOfPlane(pb, plane);
            for r in 0..rows {
                let row = std::slice::from_raw_parts_mut(base.add(r * stride), stride);
                if plane == 0 {
                    row[..width].fill(y);
                } else {
                    for c in 0..width {
                        row[2 * c] = cb;
                        row[2 * c + 1] = cr;
                    }
                }
            }
        }
        cv::CVPixelBufferUnlockBaseAddress(pb, cv::CVPixelBufferLockFlags(0));
    }
}

fn ffprobe(path: &Path, entries: &str) -> String {
    let out = crate::ffmpeg_locate::ffprobe()
        .expect("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            entries,
        ])
        .args(["-of", "default=noprint_wrappers=1"])
        .arg(path)
        .output()
        .expect("ffprobe");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn an_h264_segment_has_every_frame_on_the_grid_tagged_rec709() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("seg.mp4");
    let mut enc = SegmentEncoder::create(
        &path,
        VideoCodec::H264 {
            quality: H264_QUALITY,
        },
        (640, 360),
        (30000, 1001),
    )
    .expect("encoder");
    for n in 0..45u8 {
        let b = enc.pixel_buffer().expect("buffer");
        fill_nv12(&b, 40 + n * 4, 128, 128);
        enc.encode(&b).expect("encode");
    }
    enc.finish().expect("finish");
    if let Ok(keep) = std::env::var("VT_ENCODE_KEEP") {
        std::fs::copy(&path, keep).expect("keep");
    }
    let probe = ffprobe(
        &path,
        "stream=codec_name,profile,nb_read_frames,r_frame_rate,color_space,color_primaries,color_transfer,color_range,has_b_frames",
    );
    for want in [
        "codec_name=h264",
        "profile=High",
        "nb_read_frames=45",
        "r_frame_rate=30000/1001",
        "color_space=bt709",
        "color_primaries=bt709",
        "color_transfer=bt709",
        "color_range=tv",
        "has_b_frames=0",
    ] {
        assert!(probe.contains(want), "{want} missing from:\n{probe}");
    }
    // Read back through the media engine: frame n is the flat grey written.
    let info = crate::video::probe(&path).expect("probe");
    let mut r = crate::vt_decode::Reader::open(&path, &info, 0).expect("open");
    for n in [0u8, 1, 20, 44] {
        while r.next_index() < u64::from(n) {
            r.next_frame().expect("skip");
        }
        let f = r.next_frame().expect("frame");
        let (luma, _, _) = crate::vt_decode::read_plane(&f.buffer, 0);
        let mean = luma.iter().map(|&v| f64::from(v)).sum::<f64>() / luma.len() as f64;
        let want = f64::from(40 + n * 4);
        assert!(
            (mean - want).abs() < 1.0,
            "frame {n}: luma {mean}, wrote {want}"
        );
    }
}

#[test]
fn a_prores_segment_is_422_hq_in_a_mov() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("seg.mov");
    let mut enc =
        SegmentEncoder::create(&path, VideoCodec::ProResHq, (320, 180), (25, 1)).expect("encoder");
    for _ in 0..10 {
        let b = enc.pixel_buffer().expect("buffer");
        enc.encode(&b).expect("encode");
    }
    enc.finish().expect("finish");
    let probe = ffprobe(
        &path,
        "stream=codec_name,codec_tag_string,pix_fmt,nb_read_frames,color_space",
    );
    for want in [
        "codec_name=prores",
        "codec_tag_string=apch",
        "pix_fmt=yuv422p10le",
        "nb_read_frames=10",
        "color_space=bt709",
    ] {
        assert!(probe.contains(want), "{want} missing from:\n{probe}");
    }
}

#[test]
fn a_dropped_encoder_leaves_no_finished_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("cancelled.mp4");
    let mut enc = SegmentEncoder::create(
        &path,
        VideoCodec::H264 {
            quality: H264_QUALITY,
        },
        (320, 180),
        (30, 1),
    )
    .expect("encoder");
    let b = enc.pixel_buffer().expect("buffer");
    enc.encode(&b).expect("encode");
    drop(enc);
    // A cancelled AVAssetWriter removes its partial file.
    assert!(!path.exists() || std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) == 0);
}
