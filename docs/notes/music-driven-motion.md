# Music-driven motion (D-413)

Owner, from tip 2 of `scratch/reference-reels/ian-tang-claude-motion-tips.md`: *"Use your own
music. Music sets pacing and mood. It's the most important art direction you can make. Tell
Claude which beats the big move should hit."* The reel's prompt: *"Map the downbeats in this
track. Time the hero reveal to the first downbeat. Land the scale-up on the next strong beat.
Use smaller accents on intervening beats."* This note is how Apelles does that, for a person and
for an agent. Decision: D-413 (and D-414 for the FFT dependency).

## 1. Where the beats come from: `apelles-beat`

One Rust crate (L2), one Tauri command (`chroma_detect_beats`), one shared frontend cache
(`@apelles/bridge`'s `detectBeats`), used by both tabs.

| step | module | what |
|---|---|---|
| spectrum | `spectrum.rs` | mono 22.05 kHz, centred 2048-point Hann STFT, hop 256 (11.6 ms), 128 Slaney mels, dB with an 80 dB floor (librosa's defaults, sparse filterbank) |
| onset | `onset.rs` | spectral flux (mean positive dB rise over bands), full band and ≤160 Hz band, shifted 2 frames |
| tempo | `tempo.rs` | Hann-windowed (8.9 s) autocorrelations of the onset envelope, each normalised by its own energy, averaged, × a log-normal prior (120 BPM or the hint, one octave), parabolic refinement |
| beats | `track.rs` | Ellis 2007 dynamic programming (tightness 100), last strong maximum, back-links, near-silent ends trimmed, sub-frame refinement |
| bars, accents | `meter.rs` | bar phase = argmax over phases of z(low-band onset) + z(harmonic change into the beat); strength = onset / p95; strong = downbeat or ≥ 0.75 |
| file, cache | `source.rs` | decode via `apelles-media` (≤ 20 min), BLAKE3 of the bytes (memoised by path+mtime+size), answer cached in `media_cache` under `beats/` keyed by content + algorithm version + params |

### Why not librosa / madmom / essentia (D-413 "Options")

librosa is installed in the AI env and is the reference this port is measured against, but the
AI env is optional and not in the beta bundle, a Python call costs seconds of import, and on
known clicks its beats land ~19 ms late. madmom's and BeatNet's trained models are CC BY-NC-SA.
essentia is AGPL but a large C++ build with NC-licensed tracker models. aubio is GPL C with an
unmaintained binding.

### Accuracy, measured

Ground truth: synthetic metronomes (quiet tick on every beat, loud low thump on downbeats, one
pickup beat, 30 s), `crates/apelles-beat/tests/click_tracks.rs` and
`eval/beats/make_clicks.py` → `compare_librosa.py`.

| BPM | ours: tempo | ours: F@±25 ms | ours: median offset | librosa: tempo | librosa: F@±25 ms | librosa: median offset |
|---|---|---|---|---|---|---|
| 90 | 90.07 | 1.000 | −3.2 ms | 89.10 | 0.535 | +18.6 ms |
| 100 | 99.87 | 1.000 | −3.3 ms | 99.38 | 0.532 | +18.4 ms |
| 120 | 120.06 | 1.000 | −3.4 ms | 117.45 | 0.542 | +19.4 ms |
| 128 | 128.20 | 1.000 | −3.5 ms | 129.20 | 0.576 | +19.0 ms |
| 140 | 139.90 | 1.000 | −3.6 ms | 143.55 | 0.548 | +18.8 ms |

Downbeats on the metronomes: exact in 4/4 (five tempos) and 3/4 (150 BPM, meter given); the
70 BPM track needs its hint (`a_slow_track_needs_its_hint`). The onset shift was chosen by this
measurement: 0 frames put beats 26.0 ms early, librosa's 4 (at this hop) 20.4 ms late, 2 frames
2.8 ms early (pinned by `beats_land_on_the_clicks`).

Real music: the six Black October beds (`~/Movies/Chroma/Black October.chroma/assets/audio`,
read only). No ground truth exists for them, so this is agreement with librosa, at ±70 ms over
the span both trackers keep:

| track | length | ours BPM | librosa BPM | F@±70 ms (shared span) | note |
|---|---|---|---|---|---|
| music_open_suspension | 112 s | 140.04 | 136.0 | 0.996 | |
| music_open_attention | 235 s | 101.96 | 103.4 | 1.000 | librosa trims the last 70 s (quieter); we keep it |
| music_body_darkest | 803 s | 164.06 | 161.5 | 0.884 | |
| music_outro_piano | 83 s | 149.53 | 152.0 | 0.798 | |
| music_body_thriller | 580 s | 127.60 | 123.05 | 0.475 | librosa's own local tempo spans 105–130 BPM |
| music_outro_reveal | 59 s | 129.35 | 129.2 | 0.371 | same tempo; the two lock to different phases after 19 s |

Every matched beat sits a constant ~28 ms before librosa's: librosa's own lateness (above), not
drift. librosa's tempo is quantised by its 512-sample hop (161.5 = 60·43.07/16), which is why
the BPMs differ by 1–4 %. Analysis time, including the mp3 decode, dev profile, M-series Mac:
0.12 s (59 s) to 1.85 s (13.4 min). The first version took 9 s for 13 min (a dense mel
filterbank; 98 % multiplications by zero) and used one whole-track autocorrelation for tempo,
which said 109 BPM on the drifting track; both were fixed and measured again.

## 2. Edit tab

- **Which music.** `Track.beat_grid` on one track (the metronome toggle in an audio track's
  header, or `editor_detect_beats(show: true)` / `editor_set_beat_grid`). Beats are derived from
  each clip's file and mapped through its trim, position, native rate and speed ramp
  (`beatGrid.ts`, `clipTimelineFrameAtSource`), so music edits (D-408) keep the beats where they
  are heard.
- **Seeing them.** `TimelineBeats.tsx`: downbeats as lines through every track with bar numbers
  in the marker band, beats as ticks; thinned with zoom (beats hidden under 6 px apart, then every
  2nd/4th bar).
- **Snapping.** With the grid shown and the toolbar magnet on (default): a dragged clip's head or
  tail, an edge trim's moving edge, a ruler click and a playhead drag land on the nearest beat
  within the same 28 px reach as edge snapping (`INSERT_SNAP_PX`).
- **Cuts on beats.** "Snap cuts to beats" (toolbar, the selected clip's track) and
  `editor_snap_cuts_to_beats`: each cut (an edit point between touching clips) is rolled onto its
  nearest beat of a kind within a reach (default half a beat); each roll is dry-run through the
  real `roll` op first and a cut without enough media handle is left with its reason; applied as
  ONE `rolls` op. A roll never moves anything else, so the sequence keeps its length.

## 3. Motion tab

- **The soundtrack.** `manifest.soundtrack = {src, offset?, volume?, render?, meter?, tempoHint?}`,
  `src` an audio asset (content hash, D-404). One per document: Motion renders scenes back to back
  (`<Series>`), so composition second `t` hears music second `offset + t` in every scene. The
  player always plays it (`<Html5Audio>` in `<Video>`); a render includes it only with
  `render: true`. Pixels never change (`a_soundtrack_never_changes_pixels`).
- **Seeing beats.** The keyframe timeline draws downbeats as lines through the ruler and lanes and
  beats as ruler ticks; dragging a key snaps the grabbed key to a beat within 8 px (the magnet in
  its header), the rest of a multi-key drag moving by the same delta.
- **Time to music.** `musicTiming.ts`'s `timeToMusic`, behind the scene Inspector's form and
  `motion_time_to_music`. A move = `{name, cue, layer | layers, track?, keys?, anchor?}`:

  | field | values |
  |---|---|
  | `track` | `all` (transform + anim, default), `transform`, `anim`, `anim:<prop>` (e.g. `anim:props.count` on a custom component), `enter` (the layer's `at`), `camera` (no layer) |
  | `keys` | `all`, `first`, `last`, or indices in time order |
  | `anchor` | `start` (the move's first key goes on the beat) or `end` (its last key LANDS on it) |
  | `cue` | `beat N`, `downbeat N`, `strong beat N`, `bar N`, `bar N beat M`, `first/last <kind>`, `next <kind>`, `next <kind> after <move>`, `every <kind> between`, `every <kind> between <a> and <b>` |

  The reel's prompt, exactly:

  ```json
  [{"name": "reveal",  "cue": "downbeat 1",          "layer": "hero", "track": "enter"},
   {"name": "scale",   "cue": "next strong beat",    "layer": "hero", "track": "transform", "anchor": "end"},
   {"name": "accents", "cue": "every beat between",  "layers": ["dot1", "dot2"], "track": "enter"}]
  ```

  A move's keys shift together (it keeps its own timing). Refused, naming the move, when a cue has
  no such beat, a key would leave the scene or pass another key on its track, or two moves claim
  one key. One commit, one undo step. `snapKeysToBeats` / "Snap keys to beats" moves each key to
  its nearest beat within a tolerance instead.

## 4. Open

Live check in the running app; a tempo map (several tempos in one file); hand correction of the
bar phase; beats drawn on the music clip itself; group children addressable by moves (no op
addresses them yet, D-405); the sound-design reminder hook matching the beat tools.
