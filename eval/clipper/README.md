# `eval/clipper/` — the Automatic Clipper eval (D-411 §11)

**What it is.** How "not sloppy" is measured for the clipper. Two halves, built the
way `eval/retake/` is:

1. **Mechanical, must be perfect** (built, Phase 1): no proposal that passes the
   clean-cut gate ever starts or ends mid-sentence, cuts inside a word, misses every
   target length's band, or starts/ends inside a reviewed retake — and the analysis
   of an hour of talk fits the design's budget. The gate makes this structural; the
   eval proves it from the outside, on real Parakeet transcripts, over every
   deterministic candidate and thousands of fuzzed (mostly deliberately bad)
   proposals.
2. **Judgement, tracked** (NOT built yet): the owner labels the 5-10 best moments on
   three sources (a podcast, a course segment, a founder talk); blind client runs are
   scored on top-5 / top-10 hit rate, hook agreement and "needs the previous
   sentence" corrections. Until then the served judging rules (`JUDGING_RULES`,
   version 1) are unmeasured, and D-411's build notes say so.

**What it does NOT do.** Judge a moment. Score the look of a short (eyeball it).

## Run it

```sh
# the mechanical half: the table, refusals by reason, the hour budget
cargo test -p apelles-clipper --test clipper_eval -- --nocapture

# the view a client reads, from any transcribe.py output
cargo run -p apelles-clipper --example render_moment_view -- \
  eval/retake/transcripts/A001_09122356_C040.parakeet.words.json 30 60

# the transcript stage on a real long source, as the app runs it (5-minute
# windows, one ASR process each), plus a whole-file pass for comparison; then
# the same mechanical checks on its words
../ai-env/.venv/bin/python -I eval/clipper/measure_transcribe.py <file> --out <scratch dir> --whole
APELLES_CLIPPER_EVAL_EXTRA=<scratch dir>/windowed.words.json \
  cargo test -p apelles-clipper --test clipper_eval -- --nocapture
```

Inputs: the three committed Parakeet transcripts of `eval/retake/transcripts/`, with
every non-kept delivery of `eval/retake/labels/` standing in for "reviewed retakes".
An owner's long recording is measured from a scratch folder, never committed.

## Results (2026-10-28, D-411 Phase 1-2 build)

| source | words | sentences | topics | candidates | analyse | fuzzed | passed | refused | violations |
|---|---|---|---|---|---|---|---|---|---|
| C019 | 977 | 93 | 13 | 84 | 2.5 ms | 4084 | 811 | 3273 | **0** |
| C038 | 1296 | 102 | 13 | 84 | 2.0 ms | 4084 | 550 | 3534 | **0** |
| C040 | 903 | 79 | 10 | 60 | 1.5 ms | 4060 | 538 | 3522 | **0** |
| Black October VO (15:16, owner's) | 1867 | 139 | 19 | 207 | 4.2 ms | 4207 | 994 | 3213 | **0** |

An hour (the four sources back to back as clip windows of one timeline, 3616 s, 6020
words, 506 sentences): analysed in **13 ms** against the design's 1 s budget.

Transcript stage, Black October VO (916 s, Apple Silicon, Parakeet, cold processes):
first 5-minute window's words in **17.3 s** (budget: first provisional candidates
< 45 s cold); whole windowed pass **41.9 s** (21.9x realtime) against **72.4 s** for
one whole-file pass. The words either side of each window seam (300 / 600 / 900 s, ±4 s)
are identical in both passes; overall 1867 words windowed vs 1887 whole-file (1.1%
fewer) — the two readings differ inside windows the way any two Parakeet passes over
differently cut audio do (one seam-adjacent sentence even reads better windowed:
"alarming headlights" vs "LME headlights"); not measured further.
