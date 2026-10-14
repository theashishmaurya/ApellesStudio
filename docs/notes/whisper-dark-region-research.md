# Whisper "dark regions": root cause, a second video, and a validated detector

> **Historical motivation: Whisper, removed by D-381.** Sections 1-7 are the
> 2026-09-18 research that built the detector against Whisper transcripts and
> are kept as measured. The detector itself is backend-agnostic and survived the
> removal — see **"8. Parakeet, 2026-10-13"** at the end for why, with the
> measurement.

Research trail for **B-216**'s transcription sub-finding — *"Whisper's whole-file
pass silently swallows multi-second regions of real, audible speech."* Dated
2026-09-18.

**What this note is.** The measured answer to three questions B-216 left open:
*why* does it happen, does it happen on footage other than `A001_09122356_C040.MOV`,
and does the detector B-216 proposed actually work. **What it is NOT:** the fix.
No product code was written or changed in this pass. Everything below was run in
`scratch/whisper-dark-region/` (gitignored) against the real raw camera sources.

> **THE FIX LANDED THE SAME DAY — D-349.** Every recommendation in §6 is now
> product code: the detector is `crates/apelles-speech/src/dark.rs`, B-224 is
> fixed (`ai-media/transcribe.py` seeds MLX's RNG, and three identical runs now
> return byte-identical JSON), and §6.5's "consider it a transcript-quality
> signal" went further than suggested — `editor_detect_retakes` re-transcribes
> every located window in isolation and **splices the recovered words into the
> transcript it groups**, by default. Two things the shipped work adds that this
> note did not have, both from re-validating against these same two sources:
> a located region shorter than 250 ms is not reported (an uncovered stretch is
> bounded by transcript words, so its edge spans are slivers of the *neighbouring*
> utterance, not findings), and **the recovery pass pins the language to the
> whole-file pass's own detection** — auto-detect on a 12-second extract returned
> an entirely different script for 2 of 10 real windows, and both read correctly
> once pinned. D-349 has the full validation numbers.

**The headline, up front.** The mechanism is *not* any of the skip/threshold
paths it looks like from the outside, it is **not deterministic**, it happens on
both videos tested, and it is **biased towards exactly the material retake
detection exists to find** — on the calibration case the dropped region is the
flubbed take of the retake pair B-216 was opened over. The proposed detector
works; it needs one addition B-216 did not anticipate, and one it did not
specify, both measured below.

---

## 1. The pipeline as it actually is

Read, not assumed (`ai-media/transcribe.py`, `ai-media/requirements.txt`,
`ai-env/.venv`):

| | |
|---|---|
| backend | **`mlx-whisper==0.4.3`** (Apple MLX, local, in-process) |
| model | `mlx-community/whisper-large-v3-mlx` (`DEFAULT_MODEL = "large-v3"`) |
| word timings | `word_timestamps=True` (DTW alignment) |
| context | **`condition_on_previous_text=False`** — kept from the ported source as a loop guard |
| everything else | mlx-whisper's defaults: `temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0)`, `compression_ratio_threshold=2.4`, `logprob_threshold=-1.0`, `no_speech_threshold=0.6`, `hallucination_silence_threshold=None`, no `clip_timestamps`, **no VAD** |

Audio reaches it as 16 kHz mono via `extract_audio()`. There is no chunking
layer of our own — `mlx_whisper.transcribe()` owns the 30-second sliding window.

## 2. Root cause — measured, not guessed

`mlx_whisper` records per-window decode telemetry on every segment it
emits (`transcribe.py:263-278`: `seek`, `temperature`, `avg_logprob`,
`compression_ratio`, `no_speech_prob`). `scratch/.../raw_transcribe.py` keeps
those fields — `ai-media/transcribe.py` strips them — and
`scratch/.../mechanism.py` reconstructs the decode loop's `seek` walk from them
and classifies which branch advanced past each dark region.

**Result on c040, all five dark regions of that run:**

```
    162.66-  164.32   window 149.96-179.96  no_speech=0.061 avg_logprob=-0.328 temp=0.0
    173.32-  177.72   window 149.96-179.96  no_speech=0.061 avg_logprob=-0.328 temp=0.0
    365.70-  370.05   window 360.50-390.50  no_speech=0.111 avg_logprob=-0.460 temp=0.0
    518.18-  521.62   window 493.54-523.54  no_speech=0.043 avg_logprob=-0.249 temp=0.0
    614.76-  617.28   window 597.20-627.20  no_speech=0.171 avg_logprob=-0.353 temp=0.0

windows that emitted NOTHING (the no_speech skip): 0, 0.0s of audio
```

### What it is NOT

Each of these was a live hypothesis before the telemetry came back, and each is
ruled out by it:

- **Not the `no_speech` skip** (`transcribe.py:301-315`, the branch that
  discards a whole 30 s window). It fired **zero times** in the entire file.
  Every dark region sits inside a window that decoded and emitted text.
- **Not `no_speech_threshold`.** Every affected window scored 0.043-0.171
  against a 0.6 threshold — the model was confident speech was present.
- **Not `logprob_threshold` or a give-up.** Every one scored -0.249 to -0.460
  against a -1.0 threshold.
- **Not temperature fallback.** Every affected window decoded at **temperature
  0.0**, the first and highest-quality pass. (77 of 79 segments in the file did;
  only 2 ever reached 0.6.)
- **Not the missing upstream patch.** mlx-whisper 0.4.3 *is* missing
  openai/whisper **PR #1903** (merged 2024-12-01, "Bugfix: Illogical 'Avoid
  computing higher temperatures on no_speech'") — its `decode_with_fallback`
  (`transcribe.py:237-241`) still abandons the temperature ladder on
  `no_speech_prob` alone, without upstream's added `avg_logprob <
  logprob_threshold` conjunct. That is a real divergence and worth knowing, but
  it **cannot be this**: it only matters for windows that trip a threshold, and
  none of these did.
- **Not repetition/hallucination suppression.** `hallucination_silence_threshold`
  is `None`, so that whole block (`transcribe.py:431-490`) never executes.
- **Not `condition_on_previous_text=False`.** It changes what prompt the next
  window gets; it does not decide what the current window emits, and these
  windows all decoded cleanly at t=0.

### What it actually is

**The model reads the audio and declines to transcribe an utterance inside it,
while confidently transcribing the utterances either side.** The clearest case,
c040's 365.70-370.05:

```
 [529]  360.200- 360.500  ' response.'
 [530]  360.500- 360.720  ' once.'
                             <-- 365.70-370.05: 4.35s, Silero speech prob pinned at 1.000
 [531]  375.880- 376.440  ' The'
 [532]  376.440- 376.920  ' encoder'
 ...
 [538]  378.440- 379.120  ' and'

VAD speech spans here: 358.47-360.96 | 365.70-370.05 | 376.42-383.07
```

The window 360.50-390.50 decoded, emitted `"once. The encoder reads your whole
message once and"`, and advanced `seek` to 379.12 — the end of its own last
word. So the audio at 365.7-370.05 **was inside a decoded window**; it was
simply not turned into tokens. Nothing in whisper's machinery notices: the
window's `no_speech_prob`, `avg_logprob`, `compression_ratio` and temperature
all report a healthy decode.

The DTW word alignment then spreads the few tokens that *were* emitted across
the window's full span, which is where B-216's "one word stretched across each
gap" comes from — c038's ` down.` at 217.26-222.74 (**5.48 s for one word**),
c040's ` the` at 517.28-521.62 (4.34 s). The stretched word is a *symptom* of the
under-transcription, not its cause. It matters enormously for the detector
(§5).

### The part that makes this worse than "a missed sentence"

An isolated re-transcription of c040's 365.70-370.10 returns:

> `'The encoder reads your whole message once and published a build'`

That is **the flubbed take of the retake pair B-216 was opened over** — the
whole-file pass kept the good take (375.88-379.12) and silently dropped the
near-duplicate one 10 seconds earlier. c038 shows the same shape at
217.26-222.74: `'trick being used to bring and tricks being used to bring that
cost back down'`, against a whole-file transcript that has `back` then a 5.48 s
` down.`.

**So the failure is not uniformly distributed over the content — it lands
preferentially on immediately-repeated near-duplicate material, which is exactly
what a retake is.** Every downstream consumer that reasons about retakes is
therefore blind in a correlated, not random, way: the transcript is most likely
to be missing precisely the thing the retake detector is looking for.

## 3. It is NOT DETERMINISTIC — and that is a separate defect

B-216 confirmed 268.3-271.2 as a dark region five separate times. **It did not
reproduce here.** Chasing that turned up the reason.

`mlx_whisper/decoding.py:251-252`:

```python
def categorical(logits, temp):
    return mx.random.categorical(logits / temp)
```

Any window decoded at temperature > 0 samples from **MLX's global RNG, unseeded**.
`ai-media/transcribe.py` never calls `mx.random.seed()`. Confirmed by running the
identical command on the identical file three times through the real product
entry point:

```
run 1: 925 words, 5137 chars
run 2: 923 words, 5125 chars
run 3: 913 words, 5067 chars
run1 == run2 text: False    run1 == run3: False    run2 == run3: False
```

Dark regions found in each of four independent passes over the same file:

| region | run 1 | run 2 | run 3 | raw-diag run |
|---|---|---|---|---|
| **365.70-370.05** | yes | yes | yes | yes |
| **518.18-521.62** | yes | yes | yes | yes |
| **614.76-617.28** | yes | yes | yes | yes |
| 162.68-164.32 | yes | — | yes | yes |
| 173.32-177.72 | — | — | yes | yes |
| 269.19-270.44 | — | yes | — | — |

Two things follow, and they point opposite ways:

1. **The severe, loud dark regions are stable.** The three that reproduce in
   every pass are exactly the three high-RMS true positives. The flickering ones
   are the marginal/quiet ones.
2. **The transcript is not reproducible**, which violates this repo's own
   determinism invariant (`CLAUDE.md`: "no `rand()`, no un-seeded anything") and
   means a cached transcript, a re-run, and a caption export can legitimately
   disagree. Filed separately as **B-224**.

## 4. The second video — the failure is not specific to c040

`A001_09122319_C038.MOV` (989 s, "AI inference cost", same shoot day, never
previously transcribed or analysed) was put through the identical pipeline.

**It fails the same way.** 9 candidate dark regions at B-216's proposed
threshold; **7 of 9 contain real speech** confirmed by isolated re-transcription
against the RMS envelope. Examples, all absent from the whole-file transcript:

| region | dur | RMS peak | recovered in isolation |
|---|---|---|---|
| 217.26-222.74 | 5.48 s | 2879 | `trick being used to bring and tricks being used to bring that cost back down` |
| 464.99-467.58 | 2.59 s | 2120 | `These models don't write your answer all at once.` |
| 863.87-866.48 | 2.61 s | 2754 | `Printing cost is the one time thing that grabs` |
| 328.07-330.69 | 2.62 s | 2602 | `Influence is everything that it's` |

Rough rate across the two files: **~10 confirmed multi-second dropped regions in
1676 s of source**, i.e. one roughly every 3 minutes of raw footage, ~30 s of
real speech lost in total. Both files show the retake-shaped bias described
above.

## 5. The detector, built and measured

`crates/apelles-speech` **already ships everything this needs** — this is the
single most useful practical finding for the follow-up fix:

- `vad.rs` — Silero VAD **v6.2.1**, pinned, sha256-verified, already downloaded
  by the app, with the mandatory 64-sample context handled correctly.
- `silence.rs` — `speech_spans()` / `silence_spans()`, the hysteresis span
  builder, already unit-tested.

So the detector needs **no new dependency and no new model**: it is
`speech_spans()` (which already exists, and which `silence_spans()` is merely the
complement of) crossed with transcript word coverage. The research port
(`scratch/.../detect.py`) is pinned against `silence.rs`'s own `#[cfg(test)]`
expectations by `scratch/.../test_port.py` — 13/13 pass — so the numbers below
are about the real crate's behaviour, not a lookalike.

### 5a. B-216's literal wording has a hole: the stretched word

B-216 proposes *"a stretch of ≥1.2 s with **no transcript word in it** but with
real VAD energy."* Taken literally that misses **more than half** the real cases,
because the symptom hides itself: the DTW alignment stretches one word across the
gap, so the gap *does* have a transcript word in it.

| | c040 | c038 |
|---|---|---|
| candidates with the >2.0 s word rule **on** | 4 | 9 |
| candidates with it **off** | 2 | 4 |

The fix is one line and is not a fudge: **a word longer than 2.0 s contributes no
coverage.** 2.0 s is whisper's *own* anomaly bound for a too-long word
(`mlx_whisper/transcribe.py:329`, `if duration > 2.0`), not a number picked to
fit. Only 5 of 925 c040 words and 16 of 1320 c038 words exceed it.

### 5b. Threshold

`min_dark` sits on a plateau — candidate counts are identical from 1.0 s to
1.5 s on **both** files (c040: 4, 4, 4; c038: 9, 9, 9). **1.2 s as proposed is
right**, and is not a knife edge. Below 0.8 s it starts picking up breaths;
above 2.0 s it starts dropping confirmed regions (c040's 614.76-617.28 is
2.52 s, c038's 468.13-469.36 is 1.23 s).

### 5c. The measured score

Ground truth was **made**, not assumed: every uncovered stretch ≥1.2 s in both
files — **111 windows, the detector's candidates *and* everything it rejected** —
was cut out and re-transcribed in isolation, with its per-50 ms RMS recorded. A
window counts as real dropped speech when its RMS peak reaches 800 *and* the
isolated pass returns ≥3 words of Latin-script text. 800 is calibrated per file,
not chosen: it is the quietest speech the whole-file pass read **correctly** in
the same recording (p0 = 1062 for c040, 797 for c038).

```
variant                         TP  FP  FN   TN    prec    rec     F1
v1 (B-216 as written)            8   3   6   59   72.7%  57.1%  64.0%
v1 + RMS gate                    8   0   6   62  100.0%  57.1%  72.7%
v2 (summed speech)               9   3   5   59   75.0%  64.3%  69.2%
v2 + RMS gate  [RECOMMENDED]     9   1   5   61   90.0%  64.3%  75.0%
```

**The recall figure understates the detector badly, and this matters.** All five
"misses" contain **0.26-0.48 s** of VAD speech — they are single fragments that
whisper inflates into 3-4 words when handed 5 s of context in isolation, not
multi-second dropped regions. Scored against a **Silero-independent** criterion
(≥1.2 s of ≥800 RMS energy, bridging sub-300 ms dips — an energy measure that
shares nothing with the detector's own input, so the scoring is not circular),
**every variant scores 100 % recall**: no window containing ≥1.2 s of
speech-level energy is missed by any of them. The 33 further windows in the
"loud but unreadable" bucket all contain **≤0.7 s** of VAD speech — all are
single words or fragments, none is a dark region.

**So: recall on what the detector is actually for is not the problem. Precision
is, and the RMS gate is what fixes it** — it removes every sub-speech-level false
positive at zero cost to recall.

### 5d. The two refinements the numbers argue for

- **The RMS gate (biggest single win).** Every false positive in both files is a
  quiet artefact: c040 162.68-164.32 (peak 605, isolated pass returns nothing at
  all), c038 35.52-38.46 (peak 176), c038 326.18-327.52 (peak 113) — against true
  positives at 1407-2879. Requiring the stretch's RMS peak to reach the file's
  own speech floor takes v1 from 72.7 % to **100 %** precision. Calibrate it per
  file (p0 of the RMS peaks of well-transcribed VAD speech spans), never as a
  fixed constant — mic, gain and room differ per shoot.
- **Score the uncovered stretch, not the intersection (v2).** v1 needs 1.2 s of
  *one continuous* VAD span. c040 297.96-301.36 is 3.4 s covered only by a
  stretched ` itself` (3.40 s), containing 0.47 s of speech, a 1.96 s pause, then
  0.97 s — 1.44 s of unread speech that no single piece of reaches 1.2 s. An
  isolated pass recovers `turns every word turns it's`, a real retake. Summing the
  VAD speech inside each uncovered stretch instead catches it. **Report the
  individual VAD∩stretch intersections as the located sub-regions** — v2's own
  spans are coarse (it merges c040's 365.70-370.05 into a 15.16 s stretch), so
  gate with v2 and locate with v1.

## 6. Recommendation for the follow-up engineering fix

1. **Build the detector, in `crates/apelles-speech`, reusing `vad.rs` +
   `silence.rs::speech_spans`.** No new crate, no new model, no new dependency.
   Both MCP surfaces and the GUI, same pass (`CLAUDE.md`'s human-AND-AI rule).
2. **Implement it as: uncovered stretch (words >2.0 s excluded from coverage) →
   sum overlapping VAD speech → flag at ≥1.2 s → gate on a per-file-calibrated
   RMS floor → report the VAD∩stretch intersections.** That is v2+gate above:
   90 % precision, and no ≥1.2 s speech-energy region missed in 1676 s of real
   footage.
3. **Do not describe it as "no transcript word in it."** The >2.0 s
   non-covering-word rule is load-bearing — without it the detector misses more
   than half the real cases on both files.
4. **Fix the non-determinism first or alongside (B-224).** It is a two-line change
   (seed MLX's RNG in `ai-media/transcribe.py`) and it makes every result in this
   note, and every cached transcript, reproducible. Until it lands, "re-run and
   keep the intersection" is a genuine, cheap hardening — the severe regions
   reproduce in every pass and the marginal ones flicker (§3).
5. **Consider it a transcript-quality signal, not only an editing aid.** Because
   the drop is biased towards near-duplicate repeats, a dark region is *evidence
   of a probable retake*, not merely a hole. Feeding flagged regions back through
   an isolated re-transcription and splicing the result into the transcript would
   fix the input to the retake grouper, not just warn about it — and isolated
   re-transcription recovered the content cleanly in every confirmed case here,
   across both files and both this pass and B-216's own.
6. **Whatever else, keep B-216's own standing advice**: never cut, or decline to
   cut, on the whole-file transcript alone.

## 7. Reproducing this

`scratch/whisper-dark-region/` (gitignored, kept for the follow-up pass):

| file | what it does |
|---|---|
| `run_wholefile.sh` | whole-file transcription of both sources through the real `ai-media/transcribe.py` |
| `raw_transcribe.py` | same run, keeping the per-window decode telemetry |
| `mechanism.py` | classifies which decode branch advanced past each dark region |
| `vad_probs.py` | Silero v6.2.1 probabilities, the app's own verified model |
| `detect.py` / `detect2.py` | detector v1 / v2, ported from `silence.rs` |
| `test_port.py` | pins that port against `silence.rs`'s own unit tests (13/13) |
| `controls.py` | builds the false-negative control set |
| `batch_verify.py` | isolated re-transcription + RMS for every window |
| `reference_level.py` | per-file speech RMS calibration |
| `score.py` / `score2.py` / `final_score.py` | the scoring above |
| `probe.py` | one window, three ways: words, VAD, RMS |

---

## 8. Parakeet, 2026-10-13

Whisper is decommissioned (D-381, pending) and Parakeet is the only ASR backend.
Two questions: does the detector still find anything on Parakeet transcripts,
and what should `DarkParams::default().max_word_secs` (2.0 s, Whisper's anomaly
bound) become?

**Method.** `crates/apelles-speech/tests/dark_live.rs` (`--ignored`, Silero
v6.2.1, `APELLES_DARK_MAX_WORD_SECS=1000000` = no bound) over the committed
word-level Parakeet transcripts `eval/retake/transcripts/<source>.parakeet.words.json`
for C019 / C038 / C040, and over an empty word list for the nine silent B-roll
sources (their committed Parakeet transcripts are `[]`). PCM extracted with
`ffmpeg -f f32le -ac 1 -ar 16000` into a temp directory, never the repo.
Evidence is what exists without a listener: the VAD sum, the RMS peak against the
file's own calibrated floor, and **what the other ASR read there**
(`crates/apelles-speech/tests/fixtures/transcripts/<source>.whisper.json`).
Whisper is evidence that speech exists, not ground truth; nobody listened.

### 8a. The result: Parakeet drops speech too

| source | length | words | VAD speech / covered | floor (spans) | regions | stretches |
|---|---|---|---|---|---|---|
| C019 | 517.1 s | 977 | 426.3 / 373.4 s | 0.058 (37) | 9 | 7 |
| C038 | 989.5 s | 1296 | 534.8 / 506.8 s | 0.016 (82) | 13 | 10 |
| C040 | 686.3 s | 903 | 346.4 / 347.8 s | 0.151 (57) | 4 | 4 |
| **total** | **2192.9 s** | | | | **26** | **21** |
| 9 silent B-roll | 6.2-124.6 s each | 0 | <= 2.0 s | none (0 spans) | 2 (one source) | 1 |

`gated_out` was 0 everywhere. 21 stretches in 2,193 s is one per ~1.7 minutes of
footage, against the Whisper study's one confirmed per ~3 (10 in 1,676 s) — not
a like-for-like number (those were confirmed by isolated re-transcription, these
are corroborated by a second ASR), but it is not smaller.

**Different places, not the same ones.** All nine windows the Whisper study
confirmed Whisper had dropped (C040 162.66, 173.32, 365.70, 518.18, 614.76;
C038 217.26, 328.07, 464.99, 863.87) are read by Parakeet at 84-100 % coverage
(worst: 2.12 of 2.52 s). The regions below are Parakeet's own drops, which
Whisper reads. The two backends' failures are close to complementary on this
footage, which is an argument for the cross-check, not for either model.

### 8b. Every region, with the evidence

"Parakeet around it" = the words either side (the hole sits between them);
"Whisper read there" = the Whisper segment(s) overlapping the region. Peak RMS
is in 0-1 float units, against the floor in the table above.

| source | region (s) | stretch (s) | speech (s) | rms peak | Parakeet around it | Whisper read there |
|---|---|---|---|---|---|---|
| C019 | 62.72-63.77, 66.34-73.95, 74.69-78.00 | 62.64-78.00 | 11.97 | 0.607 | "...free." / "That's not" | "Sounds free. Actually, it's not. And the reason it's free ... silently does nothing. The fingerprint has to match exactly." |
| C019 | 91.68-95.92 | 91.52-95.92 | 4.24 | 0.599 | "different." / "This is the mistake." | "...and the model reads the whole thing like caching was never on." |
| C019 | 97.36-99.60 | 97.36-99.60 | 2.24 | 0.445 | "mistake." / "People enabling" | "People enabling caching drop a current IP" |
| C019 | 275.17-284.32 | 275.04-284.32 | 9.15 | 0.719 | "forever." / "And next" | "There's a one hour option that costs a bit more ... with gaps." |
| C019 | 311.59-318.14 | 309.12-318.64 | 6.56 | 0.463 | "spend it." / "So the per token" | "longer contexts, more agents, steps, more back and forth in a single task because now they can afford it" |
| C019 | 326.60-329.08 | 326.60-329.08 | 2.48 | 0.559 | seven words, all zero-width at 326.6 | "there's actually a name for this" — **text present, timestamps collapsed** |
| C019 | 493.86-501.60 | 468.72-501.60 | 7.74 | 0.542 | "7001." / "Why is my AI" | "...a stenographer ... finally click subscribe" |
| C038 | 53.79-54.17, 55.52-59.44 | 45.44-59.44 | 4.30 | 0.284 | "models." / "Running an already" | "The whole business is building the chips for only one thing" |
| C038 | 72.07-77.95 | 66.72-84.00 | 5.88 | 0.247 | "inference." / "A few months later" | "Nvidia's biggest deal ever and it wasn't even about the part that AI makes headlines about." |
| C038 | 185.31-191.20 | 177.08-204.60 | 5.88 | 0.405 | "shift." / "Today I" | "Running a model has quietly become more expensive than building it in the first place." |
| C038 | 334.18-335.64 | 330.84-335.64 | 1.46 | 0.233 | "inference is everything" zero-width at 330.8 | "Inference is everything after that." — **text present, timestamps collapsed** |
| C038 | 485.79-486.88 | 479.44-487.68 | 1.31 | 0.182 | "message." / "Who" | "It's like a stenographer who before writing every single next word rereads the entire" |
| C038 | 501.92-505.04 | 501.92-505.04 | 3.12 | 0.402 | "everything." / "Plus" | "Word one reread everything, word two reread everything again plus the word you already" |
| C038 | 513.67-521.28 | 509.44-528.84 | 7.61 | 0.271 | "one." / "That's an" | "...and by word 200 that's 200 full rereads just to write one response" |
| C038 | 839.49-840.13, 843.52-846.56, 850.95-852.00 | 836.44-852.44 | 4.72 | 0.307 | "first place." / "So quick recap." | only 848.3-851.4 "So quick recap,"; **839.5-846.6 (3.7 s of VAD speech) is silent in both** |
| C038 | 929.35-933.84 | 929.28-933.84 | 4.49 | 0.452 | "free." / "Running right" | "real compute real electricity real hardware running right" |
| C038 | 985.57-987.55 | 979.64-989.46 | 1.98 | 0.210 | "do." (979.6) | "Thanks for watching, see you in the next one." |
| C040 | 79.75-81.84 | 63.52-81.84 | 2.16 | 0.216 | "Okay." / "It's just the model" | "attention in simple term it's just the model deciding for every word it's about" |
| C040 | 188.77-193.00 | 180.84-193.00 | 4.23 | 0.267 | "it." / "It's called self-attention" | "The specific version of this used inside these models is called self-attention" |
| C040 | 280.99-283.52 | 275.84-289.76 | 2.52 | 0.214 | "constantly." / "Every word" | "There's an actual mechanism behind that checking in." |
| C040 | 514.56-517.44 | 505.60-518.08 | 2.88 | 0.312 | "input." / "So if something's" | "...don't bury it in the middle of a long task." |
| C029 (B-roll) | 9.76-10.91, 13.19-14.08 | 0.00-16.64 | 2.04 | 0.021 | no words at all | nothing (`[]`) |

Reading it, of the 21 stretches in the three speech sources: **18 are speech
Parakeet left out and Whisper read** (rms peaks well above each file's floor:
floors 0.016-0.15, peaks 0.18-0.72; the 836.44-852.44 stretch is counted here
for its Whisper-read tail). **2 are timestamp collapses** (C019 326.6, C038
330.8): the words are in the transcript at zero duration, so nothing was lost
from the *text* — but a zero-width word is not coverage here (the detector
requires `duration > 0`), and a cut or caption that trusts those times is wrong,
so reporting them is right. **One sub-region is unresolved**: C038
839.49-846.56, 3.7 s the VAD calls speech at rms peak 0.307 (well above the 0.016
floor) that neither ASR transcribed — it needs a listen; it may be a cough, a
laugh or a real drop both models missed. Two edge cases: C038 985.57-987.55 is a
sign-off Whisper may or may not have hallucinated (rms 0.21 against a 0.016
floor says there is real sound there), and C038 53.79-54.17 is a 0.38 s sliver
that only exists because it sits in a stretch whose other region clears the
threshold.

### 8c. The silent B-roll

Eight of the nine report **0 regions** (VAD speech 0.0-0.6 s, nowhere near the
1.2 s threshold). **C029 reports 2 regions** (9.76-10.91 and 13.19-14.08, 2.04 s
of VAD speech in 16.6 s): neither ASR heard anything there, the RMS peak is
0.021, and — because a silent source has no transcribed speech to calibrate a
floor from — the report is **ungated** (`rms_floor: None`, the documented
behaviour) so nothing could reject it. This is a faint non-speech sound the VAD
leans towards speech on, in a clip with no speech: a known precision limit of
the ungated path, not a Parakeet defect. It does not affect the retake path
(which runs the detector only over clips it groups) but a user running
`editor_detect_dark_regions` on this clip would see a false positive whose
`rmsFloor: null` is the caveat the tool already states.

### 8d. What changed in the code

`DarkParams::default().max_word_secs` 2.0 -> `NO_WORD_LENGTH_BOUND_SECS`
(1.0e6). The meaning is Parakeet's descriptor `max_word_secs=None` ("no word can
stretch across a hole") and the representation is the one
`ai-media/harness/profiles.py` already uses for that `None`: a very large
**finite** number, because the app's command guard requires finite positive
parameters and the value is echoed in the JSON result, where `inf` has no form.
The measurement agrees with the descriptor: with no bound, every Parakeet hole
above is still a finding — Parakeet's shape is a hole with *no* word in it (or
zero-width words), not a stretched word, so the stretched-word rule that was
"worth more than half the real cases" for Whisper has nothing to catch. The
tests that exercise the stretched-word rule pass 2.0 explicitly.

### 8e. Keep or remove — the owner's call

The measurement does not support removing the detector: it finds 18
corroborated multi-second drops in 36 minutes of real Parakeet output, it is the
only check that does, and it costs one VAD pass. What it does *not* yet say is
how many of those matter to the downstream user (a dropped retake is the costly
case; the retake path already re-reads these windows in isolation via
`recoverDarkRegions`). Nothing was removed.

### 8f. Reproducing

```text
ffmpeg -i ~/Downloads/<source>.MOV -vn -f f32le -ac 1 -ar 16000 /tmp/<source>.f32
ORT_DYLIB_PATH=app/src-tauri/resources/libonnxruntime.dylib \
APELLES_SILERO_MODEL="$HOME/Library/Application Support/studio.apelles.app/models/silero_vad_v6.2.1.onnx" \
APELLES_DARK_PCM=/tmp/<source>.f32 \
APELLES_DARK_TRANSCRIPT=eval/retake/transcripts/<source>.parakeet.words.json \
  cargo test -p apelles-speech --test dark_live -- --ignored --nocapture
```

(`dark_live` aborts with `libc++abi: mutex lock failed` while tearing down ONNX
Runtime after the report is printed and written; the numbers above are complete
by then. Pre-existing, unrelated to the detector.) A silent source needs a
transcript file of `{"words": []}`.
