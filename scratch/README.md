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
