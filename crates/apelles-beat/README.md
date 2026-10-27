# `apelles-beat`

**Where the beats are in a piece of music.** (D-413)

Tempo, the beat grid, which beats start a bar (downbeats) and how hard each beat hits, for an
audio file — computed on-device, deterministic, and cached by the file's content. The Edit tab
draws the grid on the timeline and snaps cuts to it; the Motion tab times keyframes to it. Both
reach it through one Tauri command, `chroma_detect_beats` (`app/src-tauri/src/chroma/beats.rs`).

| module | does |
|---|---|
| `spectrum` | centred STFT (2048 / hop 256 at 22.05 kHz) → 128 Slaney mel bands → dB |
| `onset` | spectral flux, full band and low band (≤ 160 Hz) |
| `tempo` | windowed, normalised autocorrelation tempogram under a log-normal tempo prior |
| `track` | Ellis' dynamic-programming beat tracker, sub-frame refinement |
| `meter` | bar phase (low-band onsets + harmonic change) and per-beat accent strength |
| `source` | decode a file (via `apelles-media`), hash its bytes, cache the answer in `media_cache` |

## The boundary

**In:** mono PCM at 22.05 kHz (`analyze`), or a file path (`source::analyze_file`).
**Out:** `BeatAnalysis` — tempo, meter and beats in **seconds from the start of the file**.

- **It never edits anything.** Placing a beat on a timeline frame or in a Motion scene is the
  frontend op layer's job (`@apelles/editor`'s `beatGrid.ts`, `@apelles/motion`'s
  `musicTiming.ts`).
- **No model files, no network, no Python.** Pure DSP; librosa is only the reference it is
  measured against (`eval/beats/`).
- **No tempo map, no time-signature detection.** One tempo per file (the tracker follows drift);
  the meter is a parameter.

## Layer

L2. Depends on `apelles-media` (L1: decoding and the `media_cache` store), `realfft` (D-414,
already in the tree through `rubato`), `blake3`, `serde`, `thiserror`, `log`.

## Accuracy

On synthetic metronomes with known beats (five tempos, 283 beats): F-measure 1.000 at ±25 ms,
beats ~3 ms early on average, tempo within 0.2 %, downbeats exact in 4/4 and 3/4. Real-music
agreement with librosa and the full tables: `docs/notes/music-driven-motion.md`.

## Tests

```sh
cargo test -p apelles-beat                    # unit + synthetic click tracks + file/cache
cargo run -p apelles-beat --example beat_eval -- FILE...   # JSON lines for eval/beats/
```
