# Speech-enhancement research trail (2026-09-17)

Not a decision, not yet built — a research trail to pick up from, per the owner's
"cool document it we will get to it later." No code was written or integrated;
everything below happened in gitignored `scratch/` against a real project's audio.

## The goal

The owner wants Chroma to be able to clean up recorded dialogue the way Adobe
Podcast's "Enhance Speech" does — locally, automated, fast enough to be
practical inside an edit session. Target speed: **0.5-0.7x realtime**,
measured against the REAL final-cut audio of a real project (not a synthetic
test clip), since that is the actual workload.

## What was tested

Real final-cut audio was rebuilt from `2026-09-12-c040-mgfx-recut`'s track 2
(68 clips, their real `source_start`/`duration` at the real source fps,
concatenated) — 233.57s, not a stand-in sample.

| candidate | speed (xRT) | notes |
|---|---|---|
| DeepFilterNet3 (`deep-filter -D`) | **0.066x** | Rust-native, MIT/Apache-2.0, tonally near-transparent |
| DFN3 + a guessed presence-lift EQ | 0.094x | built against the WRONG target — see below |
| MossFormer2_SE_48K | 0.109x | usable speed, weaker result |
| MossFormer2 SE→SR chained | 1.281x | **regression** — gutted 2-16kHz by 11-21dB, avoid |
| Resemble Enhance, denoise only (MPS) | 0.045x | near-inert on already-clean audio |
| **Resemble Enhance, full** (denoise MPS + enhance CPU) | **3.11x** | best-sounding of the local options, but ~45x DFN3's compute — misses the 0.5-0.7x target by 4-6x. Also corrects the owner's own memory: this is 3.11x on real content, not the 1.5-2x recalled from the earlier `videoAgent` attempt. |

Full setup detail, DNSMOS numbers, and file inventory are in the (gitignored)
research agent's own report; the audio files it produced live in
`scratch/speech-enhance-bakeoff/raw/` on this machine for anyone continuing
this — not committed, ephemeral like the rest of `scratch/`.

## The finding that overturned the first theory

The first pass never had Adobe's own output to measure against — it inferred
Adobe's "magic" from comparing the LOCAL candidates to each other. Resemble
Enhance's own delta vs. the untouched reference showed a large presence/air
lift (+3.6dB @ 2-4k, +6.0 @ 4-8k, +7.0 @ 12-16k, +28.6 @ 16-20k), so the first
prototype (`out_dfn3_plus_resemble_tilt_eq`) chased THAT curve on top of DFN3.

Once the owner actually ran the real reference audio through Adobe Podcast's
own web tool (manually, through its real UI — `podcast.adobe.com/enhance`,
FLAC rejected/converted to MP3 for upload) and the **real Adobe output** was
measured the same way, the presence-lift theory turned out to be wrong:

| band (Hz) | 60-120 | 120-250 | 250-500 | 500-1k | 1k-2k | 2k-4k | 4k-8k | 8k-12k | 12k-16k | 16k-20k |
|---|---|---|---|---|---|---|---|---|---|---|
| **Adobe (real)** | +1.6 | +1.9 | +0.3 | −1.2 | −0.1 | −0.2 | **−1.8** | **−1.0** | −0.5 | **−5.2** |
| Resemble Enhance | +1.9 | −0.4 | +0.6 | +0.1 | +1.1 | +3.6 | +6.0 | +5.3 | +7.0 | +28.6 |
| DeepFilterNet3 | −0.3 | −0.2 | −0.2 | −0.2 | −0.3 | −0.3 | −0.2 | −0.2 | −0.2 | −2.8 |

Adobe's real curve is **nearly flat with a gentle high-frequency roll-off** —
the opposite direction from Resemble's dramatic lift, and much closer in
character to plain DeepFilterNet3 than to Resemble. The two can sound
similarly "clean/produced" to the ear (the owner's own live A/B, on this
source, called Adobe's result the clean one and Resemble's the one with an
audible difference once compared directly) while getting there by different —
on the highs, nearly opposite — spectral means.

**Practical effect:** DeepFilterNet3 was already a much closer structural
match to real Adobe output than the first theory gave it credit for. A second
EQ prototype was built against Adobe's OWN measured curve instead of
Resemble's (`out_dfn3_plus_adobe_matched_eq` in the scratch folder) and tracks
Adobe's real fingerprint within ~1-2.5dB across every band, tighter than plain
DFN3's own spread. It clipped twice in the render (`Parsed_equalizer_*
clipping N times`) — needs a limiter and real tuning before it means anything
beyond "the direction is right."

## Where things stand

- **Owner-verified, live, by ear:** Adobe Podcast's real enhanced output on
  this footage is clean with no artifacts the owner could point to — "Adobe is
  very clean no issue we will get there."
- **Not yet decided:** whether/how this becomes a real Chroma feature (a new
  `editor_*` tool + GUI control, per this repo's human-AND-AI rule; where in
  the pipeline it runs — post-cut export step vs. per-clip; DFN3-as-dependency
  vs. DFN3-built-from-source, since D-NNN-worthy: DeepFilterNet's own
  documented prebuilt-binary install path is broken on this arm64 Mac,
  `codesign` rejects the only darwin-arm64 release asset — building from
  source via `cargo build --release --bin deep-filter --features
  bin,tract,wav-utils,transforms,default-model` from `libDF/` worked, ~4m17s).
- **Real open gaps, not solved by anything tested:** de-reverberation / echo
  removal (none of DeepFilterNet3, Resemble Enhance, or ClearerVoice's
  MossFormer2 variants do this); a 2026 / Apple-Silicon-accelerated
  speech-enhancement landscape that could not be surveyed (the research
  agent's web-search budget was exhausted before it could look); the
  Adobe-matched EQ prototype is a one-pass sketch, not a tuned chain (needs at
  minimum a gate before it and a limiter after it).
- **A real, reproducible `editor_add_clip` defect was hit doing the A/B setup
  for this** (importing a pure-audio MP3 and placing it directly on an audio
  track auto-created a second, fully-duplicate linked-audio clip on a NEW
  track — worked around by muting the duplicate track's gain rather than
  `editor_remove_clip`, given B-221's precedent of that op cascading across a
  link group unexpectedly). Not yet filed as its own `B-NNN` — flagging here so
  it isn't lost; whoever next touches `editor_add_clip`'s audio-linking logic
  should check whether it should skip creating a link at all when the source
  media item has no video stream.

## What's on the timeline right now

`2026-09-12-c040-mgfx-recut`'s real Adobe Podcast output
(`out_adobe_podcast_enhanced.mp3`) is placed on a new audio track (track 4)
spanning the full cut, and the original dialogue track (track 2) is muted
(gain 0). This started as a pure A/B comparison setup — but after listening
to both, **the owner decided to ship the Adobe-enhanced audio for this
specific video** (2026-09-17). Track 4 is therefore the real, final audio for
this deliverable, not a temporary comparison; track 2 stays muted rather than
removed, so the original is still there if this ever needs revisiting.

**This is a one-off editorial call for this one video, not a reversal of the
"local-first" research goal above.** The whole point of everything else in
this document is still finding a local, in-Chroma alternative — that work is
explicitly parked for later. Shipping Adobe's output here happened through a
human manually using Adobe's own web tool once, outside Chroma entirely; it
is not a cloud call Chroma's own pipeline made, so it does not touch this
project's "local-first, zero network calls in the grade path" invariant —
it's simply an externally-sourced media asset, the same as any other imported
audio would be. Worth recording so a future contributor doesn't wonder why
this one video's dialogue doesn't match its camera audio.
