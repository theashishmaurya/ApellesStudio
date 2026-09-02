# scratch/

Throwaway working files — spike code, extracted frames, test renders. **Gitignored.**
Nothing here is load-bearing.

## Current contents

- `frame_c019_10s.png` — 4K Rec709 frame from `~/Downloads/A001_08302215_C019.MOV`
  (the raw take kept for color-grade testing). The talking-head shot from the Palmier
  trials. Extracted with:
  ```
  ffmpeg -y -ss 10 -i ~/Downloads/A001_08302215_C019.MOV -frames:v 1 frame_c019_10s.png
  ```

### Moving-camera test clips (for depth-track / D-036 — C019 is static-camera)

Downloaded 2026-09-02, kept in **`~/Downloads/`** (alongside the C019 take — not in
the repo). Not gitignored-here because they're not here; listed for reference.

- `~/Downloads/Tokyo-Walk_rgb.mp4` — 1280×720 15fps 13s. Video Depth Anything's own
  demo clip (walking POV through Tokyo, continuous camera motion, deep street
  perspective). From `github.com/DepthAnything/Video-Depth-Anything`
  `assets/example_videos/`. Default clip for `ai/test_depth_track.py`.
- `~/Downloads/davis_rollercoaster.mp4` — 960×540 24fps 2.9s. DAVIS clip, fast
  motion — quick temporal-consistency check. Same source.
- `~/Downloads/pexels_28808272.mp4` — **3840×2160 50fps 21.5s**, "cinematic walk in
  sunlit downtown street". The grading hero: 4K, daylight, dolly-forward camera,
  strong fg/bg depth separation. Pexels (free, no attribution, no API key —
  `curl -L https://www.pexels.com/download/video/28808272/`).
- `~/Downloads/pexels_30340086.mp4` — 1080×1920 24fps 15s, "misty night foggy city
  street" — literal atmospheric haze, showcases the depth-haze preset. Pexels id 30340086.
- `~/Downloads/pexels_35502610.mp4` — 2160×3840 30fps 16s, foggy night street. Pexels id 35502610.
