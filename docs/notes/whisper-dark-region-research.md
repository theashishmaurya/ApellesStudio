# Whisper "dark regions": root cause, a second video, and a validated detector

Research trail for **B-216**'s transcription sub-finding — *"Whisper's whole-file
pass silently swallows multi-second regions of real, audible speech."* Dated
2026-09-18.

**What this note is.** The measured answer to three questions B-216 left open:
*why* does it happen, does it happen on footage other than `A001_09122356_C040.MOV`,
and does the detector B-216 proposed actually work. **What it is NOT:** the fix.
No product code was written or changed in this pass. Everything below was run in
`scratch/whisper-dark-region/` (gitignored) against the real raw camera sources.

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
