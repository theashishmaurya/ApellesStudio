# ASR backends and the transcript harness (D-374, D-381)

**Status, 2026-10-13: Parakeet is the only ASR backend; Whisper is
decommissioned (D-381, §4.3).** The history below is kept as it happened.

**Why this exists.** `ai-media/transcribe.py` hard-coded one model
(`mlx-whisper large-v3`). The owner's call, 2026-10-09, after a measured
head-to-head on real footage: **move to Parakeet for speed, accept that no
model is 100%, and build a harness around it — one that any backend can be
dropped into.**

The design follows from that last clause. The harness is the product; the
backend is a swappable part. A backend that is 2 % worse but 17× faster is a
*better* input to a multi-pass harness than a slower, slightly better one,
because the harness can spend the saved time on passes and on telling you
where it is unsure.

---

## 1. The measurement this is based on

Run on the owner's own `A001_09122319_C038.MOV` (989.5 s), against the
committed Whisper reference `crates/apelles-speech/tests/fixtures/A001_09122319_C038.json`.

| | mlx-whisper large-v3 | parakeet-tdt-0.6b-v3 |
|---|---|---|
| params / weights | ~1.5 B, ~3 GB | **0.6 B** |
| transcribe 989.5 s | not timed this run | **56.3 s — 17.6× realtime** |
| words | 1316 | 1296 |
| segments | 121 | 75 |
| segment median / max | 5.4 s / **15.9 s** | 9.4 s / **98.2 s** |
| segments > 30 s | 0 | **3** |
| licence | MIT | CC-BY-4.0 (model), Apache-2.0 (`parakeet-mlx`) |

**Where Parakeet is worse, measured:** it drops domain and proper nouns
Whisper catches — `KV cache` 1→0, `chaiwala` 1→0, `stenographer` 2→1,
`Nvidia` 2→1 — and spells numbers out ("Twenty billion dollars" vs "$20
billion"). Neither model gets `Groq` (whisper *grok*/*grog*, parakeet
*grog*/*groc*) or `Gartner` (parakeet: *Gutter*).

**Where Parakeet is better:** it transcribed `"Cut from here"` at 223.8 s — a
spoken instruction to the editor — which Whisper dropped entirely.

**The two real engineering problems**, both of which the Parakeet backend must
solve rather than pass on to callers:

1. **Run-on segments.** One segment spanned **223.8 → 322.0 s**, swallowing
   five of Whisper's. `retake.rs` compares *utterances*; a 98 s utterance is
   not a usable comparison unit.
2. **Token timings are SUB-WORD.** `"December"` comes back as
   `' De' / 'cem' / 'ber'` — 2480 tokens for 1296 words. Word timings are
   derivable (a leading space marks a word start, the same convention
   `retake.rs:263` already normalises for mlx-whisper) but are not native.

---

## 2. The backend contract — already exists, do not invent a new one

`transcribe()`'s current return value IS the interface:

```
{ text, language, model, source,
  segments: [ { start, end, text, words: [ {word, start, end, probability?} ] } ],
  words:    [ {word, start, end, probability?} ]          # flattened, absent if none
  window?:  { start_secs, duration_secs }                 # D-349
}
```

A backend is anything that produces this for `(audio_path, language,
word_timestamps, start_secs, duration_secs)`. Timestamps are **absolute source
seconds** — a windowed run shifts its own output, which is what lets a window
be spliced into a whole-file pass (D-349, the B-216 recovery primitive).

**`ai-media/asr/`**: `base.py` (the Protocol + a shared validator),
`whisper_mlx.py` (the code of the day, moved unchanged — deleted by D-381),
`parakeet_mlx.py` (new; the only backend since D-381).
`transcribe.py` keeps its public functions and gains a `backend` argument.
Nothing above `transcribe.py` changes shape — `apelles-ai`'s sidecar,
`editor_get_transcript`, the Recut panel and `apelles-speech` all keep
consuming exactly what they consume today.

### The Parakeet backend's two obligations

- **Merge sub-word tokens into words** on the leading-space boundary; a word's
  `start` is its first token's, `end` its last token's.
- **Re-segment from token gaps, never from `result.sentences`.** Split on a
  silence gap between consecutive tokens, with a hard maximum segment length so
  a 98 s run-on cannot recur. Both thresholds are named constants with the
  measurement above cited. `result.sentences` is still useful as a *hint* but
  is not the segmentation.

---

## 3. The harness — the actual product (BUILT 2026-10-10, D-375)

`ai-media/harness/`. A **pipeline of checks**, each taking the contract and
returning the contract plus annotations. Backend-agnostic by construction, and
that is now a structural property rather than an intention: `run_checks` calls a
check with exactly a contract `dict` and a `CheckContext` — a frozen dataclass
holding one `BackendProfile`, three fields of plain data — and **no module in
`harness/` imports a backend or a model runtime**, which a test asserts by
reading the package's own source. A check could not reach a model if it wanted
to.

```
backend ─► [ multi-pass reconcile ] ─► [ VAD cross-check ] ─► [ … ] ─► result
              (needs a fast backend)     (the Rust detector, called not copied)
```

Seven modules: `contract.py` (the one place that knows the contract's JSON
shape, plus the annotation vocabulary), `align.py` (the aligner), `reconcile.py`
(check 1), `vad.py` (check 2), `pipeline.py` (the `Check` protocol and
`run_checks`), `profiles.py` (the backend descriptors the checks read),
`__init__.py`. No dependency outside the standard library. Boundaries and
module table: `ai-media/harness/README.md`.

### 3.0 The annotation vocabulary

Three places, so a consumer has one place to look whatever checks ran:

| | |
|---|---|
| `words[i]["agreement"]` | `{state, passes, of, alternatives?}` |
| `low_confidence` | `[{start, end, kind, detail}]`, time-ordered, merged per kind |
| `harness` | provenance — which checks ran, under which profile, their headline numbers |

Same-kind spans within **0.6 s** merge into one finding; different kinds never
merge. 0.6 s is not a new number — it is `chroma_detect_silences`'s own
`min_silence_ms` default, this app's existing answer to "how long a gap does a
person read as *they stopped talking*".

### 3.1 Multi-pass reconciliation — what the speed buys

At 17.6× realtime, three passes of a 989 s source cost ~170 s. The knob is the
**chunk offset**, because the measured failures — run-on segments and dropped
words — cluster at chunk seams. `mlx-whisper` has no chunk-size argument and
does not need one: its 30 s window grid starts at the start of the audio it is
handed, so a pass started 10 s earlier has every seam 10 s elsewhere, and D-349
already shifts a windowed pass's timestamps back to absolute source seconds
precisely so windowed passes are comparable. For `parakeet-mlx` it is
`chunk_duration`/`overlap_duration`. Either way the harness only ever sees
contracts.

Per word, after alignment:

- **agreed by all passes** → `unanimous`
- **disagreed** → `disagreed`; the majority reading is kept, the alternatives
  recorded with which passes held each. A tie goes to the reference pass
- **present in some passes only** → `partial`; kept and flagged

Everything not unanimous also becomes a `low_confidence` span of kind
`multi_pass_reconcile`. That is the honest answer to "we can't get 100 %": the
transcript says where it is unsure instead of pretending.

**Only the range every pass covered is reconciled**, intersected from each
pass's `window` (or its word extent). Without it a multi-pass run reports its
own seams as findings — measured: three passes 10 s apart contributed 15 words
before the reference's first segment, and adopting them put un-cross-checked
content into the reference's own segments. A word a wider pass found outside the
common range is now not adopted (`discarded` in provenance); the reference's own
words outside it are kept and marked `outside`.

**Producing the passes is not a check's job.** `MultiPassReconcile` is
constructed *with* the other passes — contracts, all of them — which is what
keeps the structural rule above true for the one check that would have been
tempting to break it.

A kept word's timings are the ones the pass it came from actually produced,
never an average, so the result stays a transcript some backend really could
have returned.

### 3.1.1 The aligner, which is the hard part

`align.py`: align N word streams with timestamps and differing tokenisation, and
say per column which pass held which word. A pure function returning indices —
nothing else — so every answer has a correct answer that can be written down.

**Progressive alignment to a growing column set** (standard multiple-sequence
alignment, which is the problem). Stream 0 becomes the initial columns; each
further stream is aligned against the columns as they stand, scored against each
column's consensus — the majority reading among the streams already in it, at the
*mean* of their midpoints, so by the third pass a column's position is better
known than any single pass's. A word the columns have no room for is spliced in
as a **new column**, which is how a word only one pass heard survives in the
right place in time.

The pairwise step is Needleman-Wunsch **in its gain form**: every word is either
matched or gapped, so the gap count is fixed by the lengths and the match count,
and maximising `Σ score − gap_penalty × gaps` is the same problem as maximising
`Σ (score − 2 × gap_penalty)` over matches alone. That drops the gap bookkeeping
and leaves the weighted-LCS recurrence, where a pair is matched only when it
strictly beats leaving both words unmatched.

Scoring blends both signals because either alone is wrong here — text alone
matches the fourth `"the"` in a sentence to the first; time alone cannot tell a
substitution from two different words, and the drift the check is *looking for*
is a timestamp that moved:

    score = 0.65 × similarity + 0.35 × proximity        (bar: 2 × 0.30 = 0.60)

`similarity` is 1.0 on a normalised-equal word (casefolded, punctuation
stripped, apostrophes kept) and `difflib.SequenceMatcher`'s ratio otherwise —
stdlib, no dependency, the same family of ratio `retake.rs` scores utterances
with. `proximity` falls linearly to 0 across 1.0 s of drift. The **5 s time
band** is a correctness device, not an optimisation: two words further apart than
that are two utterances of the same word, never one word read twice. It happens
to also confine the expensive similarity call, but the DP is exact and full, so
the band never prunes a better alignment.

One consequence worth stating because it is deliberate: text carries 0.65
against a bar of 0.60, so a pair under ≈0.39 similarity can never be called the
same word even at the same instant. `"Gartner"`/`"Gutter"` (0.57) aligns as a
disagreement; `"the"`/`"elephant"` is reported as a drop plus an insertion —
both of which the harness flags anyway, and the second is the more honest of the
two readings.

### 3.2 VAD cross-check — the check stays in Rust, and the constant moves to the descriptor

**The check already exists and is not reimplemented.** `VAD says speech,
transcript says nothing ⇒ a dark region` is
`crates/apelles-speech/src/dark.rs`, scored over 111 labelled windows across two
real camera originals for 90 % precision with no region missed in 1676 s. A
Python copy would be a second implementation of the same logic — which
`CLAUDE.md` forbids outright — and it would be the untested one. **D-375 records
the placement decision in full.** Two reasons in short:

- it is **not a contract-only check**. Its second input is *audio* — Silero
  probabilities and an RMS envelope at two different hop rates — which the
  contract does not carry and `ai-media/` has no ONNX session, model or decoder
  to produce. The harness's own rule, that a check sees only the contract, is
  *why* this one cannot live inside the harness as a self-contained check;
- what was Whisper-specific was never the algorithm. It was **one number**, and
  `dark.rs` already took it as a parameter (`DarkParams::max_word_secs`,
  overridable through `chroma_detect_dark_regions`'s own wire contract). The
  seam existed; what did not exist was anything that knew what to put in it per
  backend.

So the number moved to **`asr/base.py`'s `BackendDescriptor`** — the field that
file deliberately left out until a consumer existed, and now has one: Whisper
2.0 s (`mlx_whisper`'s own anomaly threshold), Parakeet `None`, meaning the
bound does not apply, because its duration head caps a token at 0.320 s and
D-376's merge refuses to span a wider gap, so no word it emits can stretch
across an untranscribed hole. `harness/vad.py` is the half that genuinely is
contract-layer:

| | |
|---|---|
| `dark_params_for(profile)` | the `DarkParams` override **this backend** needs — a profile may only move what is the backend's; every measured threshold (`min_dark_secs`, the RMS calibration, the Silero hysteresis) is left as the 111-window scoring set it |
| `fold_dark_report(...)` | the detector's own serialised `DarkReport`, folded into `low_confidence` as kind `vad_cross_check` |

**The guard is the point.** `fold_dark_report` refuses a report produced under
parameters that are not this backend's. Running a Parakeet transcript against
Whisper's 2.0 s bound does not fail — it returns a plausible-looking list of
dark regions that is wrong, which nobody would catch by reading it.

`apelles-speech`'s `dark_live` integration test gained three optional env vars
so the detector can be driven this way standalone: `APELLES_DARK_MAX_WORD_SECS`
(what `dark_params_for` emits), `APELLES_DARK_REPORT_JSON` (the report as data),
and `APELLES_DARK_RANGE_START` (which clock a windowed PCM dump is on). The
app's `chroma_detect_dark_regions` is the other, already-existing source of a
report.

### 3.3 What a check may not do

Reach for a model, or know which backend produced its input. Enforced by the
signature, not by convention — see §3's opening. A check that needs model
internals is a backend feature, not a check.

### 3.4 Verification

- **`test_harness_align.py`** — 12 scenarios over synthetic streams: identical
  passes, a one-word substitution, a pass dropping a run, three passes
  disagreeing three ways, drifting timestamps, a word only one pass heard, the
  time band separating two utterances of one word, untimed words, degenerate
  inputs, every-word-appears-exactly-once, determinism.
- **`test_harness_pipeline.py`** — 15 checks over hand-written contracts: the
  three agreement classes, the range intersection, the refusals, the profile
  parameter, the fold and its refusal, span merging, composition, provenance,
  the context being one frozen field, **the source-reading proof that nothing in
  `harness/` imports a backend**, the profile registry matching `asr/`'s
  descriptors field-for-field, a broken check failing at its own boundary, and
  determinism. No model, no venv — that is the property under test.
- **`test_harness_live.py`** — opt-in, against the real backend. First run
  against **Whisper**, which is how the agnosticism was proved rather than
  asserted (step 3 of §4 exists for this reason); since D-381 against Parakeet
  (§4.3). Measured 2026-10-10 on Whisper on the real C038 source, window
  200-260 s, offsets 0/10/20 s: three passes of **82 / 84 / 96 words** in
  15.5 / 14.0 / 17.9 s → **82 words, 79 unanimous, 2 disagreed, 1 partial, 15
  discarded, 3 low-confidence spans**, the harness itself taking 0.01 s.
  A real `DarkReport` from the Rust detector over the same window (33.2 s of VAD
  speech, 36.1 s of transcript coverage, floor 0.0954 from 4 calibration spans,
  **0 regions**) folds through the same pipeline.

**Not claimed:** the single-pass baseline was not re-run against that window, so
"the reconciled transcript left no dark region" is an observation about the
three-pass result, not a measured improvement over one pass. Nothing above
`transcribe.py` calls the harness yet — no sidecar endpoint, no GUI, no MCP
tool — so it has no human/AI surface pair yet; that is named in §5.

## 4. Migration, deliberately staged

1. ✅ **Seam only** (2026-10-09) — `ai-media/asr/`, Whisper moved behind it,
   zero behaviour change.
2. ✅ **Parakeet backend** (2026-10-09) — opt-in via `backend="parakeet"`.
   Whisper stays the default.
3. ✅ **Harness** (2026-10-10, D-375) — `ai-media/harness/`, built against the
   *existing Whisper backend* first, which is how its backend-agnosticism got
   proved rather than asserted. Detail: §3.
4. ✅ **Re-derive, then decide** (2026-10-10, **D-377**) — done, and the answer
   then was **do not switch**. Detail: §4.2 below and
   `docs/notes/retake-detection.md` §8. **Superseded by D-381** (step 5).
5. ✅ **Whisper decommissioned** (2026-10-13, **D-381**) — Parakeet is the
   default and only backend, the lock carries it, `verify.py` checks it. §4.3.

**Step 4 was the expensive one and it was not optional.** B-237, B-238, D-365
and D-366 were four sessions of tuning against Whisper's output shape, pinned
by five corpus tests asserting exact group counts and cut ranges. Changing the
ASR changes tokenisation, punctuation and boundaries, so those tests had to be
re-derived, not edited until green. **They were not touched and all five still
pass**; every Parakeet number is additional tests over new fixtures.

### 4.1 What steps 1 and 2 actually shipped (2026-10-09)

`ai-media/asr/` — `base.py` (the `AsrBackend` Protocol, `BackendDescriptor`,
`validate_body`, `check_language`, and B-174's offline model-path resolver,
which is now **shared** because `parakeet_mlx.utils.from_pretrained` has the
same missing-`local_files_only` bug `mlx_whisper.load_model` does),
`whisper_mlx.py` (moved, not rewritten), `parakeet_mlx.py`, `__init__.py` (the
registry), `README.md`. `transcribe.py` keeps `transcribe`,
`transcribe_subprocess`, `extract_audio` and `main`, and gains `backend=` /
`--backend`; it also keeps everything a backend must NOT own — the path check,
the ffmpeg window, the shift into absolute source seconds, the flattened
`words`, the `model`/`source`/`window` keys. Nothing above it changed:
`DEFAULT_MODEL` and `MLX_MODEL_REPOS` are re-exported under their old names
because `server.py` reads both.

**How "step 1 changed nothing" was established, and how it was not.** The
committed fixtures could not be re-derived (~15 min of GPU each, and
re-deriving them is step 4's job), so the proof is a **differential**: the
pre-D-374 `transcribe.py` and the post-D-374 one were each run against the same
*stubbed* `mlx_whisper`, over 6 scripted model outputs × 10 argument
combinations (plain WAV, plain MOV, explicit language, `"auto"`,
`word_timestamps=False`, a non-default model, four window shapes) — 60 cases,
comparing the full JSON result, the kwargs that reached the model, and the RNG
seeding. **50 of 60 are byte-identical**, including every window case and the
`None`-word-timing case `_shift` exists for.

The 10 that differ are all one synthetic input: a segment whose own
`start`/`end` is `None` or a bool. The old code passed it through as `null`;
the new `validate_body` raises `ValueError` naming the backend. `mlx_whisper`
does not emit that — segment times come from its seek arithmetic and are always
floats — and a `null` segment time would already have failed Rust-side
deserialisation, so this is a deliberate tightening at a boundary that was
silently permissive. Everything else the old code defended against (a non-dict
segment, `words: None`, `text: None`, a word with no `start`/`end` keys, an
unrounded probability) is still tolerated identically. **What remains unproven
is only the model itself, which did not change.**

**Parakeet, measured end-to-end through the new backend** on the same 989.5 s
C038 source (whole file, `chunk_duration=120`, `overlap_duration=15`):

| | Whisper fixture | raw `result.sentences` | this backend |
|---|---|---|---|
| segments | 121 | 75 | **87** |
| median / p90 / max | 5.36 / 9.20 / **15.92** s | 9.44 / — / **98.20** s | 5.12 / 12.32 / **14.96** s |
| segments > 30 s | 0 | 3 | **0** |
| words | 1316 | 2480 sub-word *tokens* | **1296 words** |

Both defects are fixed and asserted: no segment exceeds `SEGMENT_MAX_S`, and
`words[]` holds whole words (`' December'`, `' year,'`, `' Nvidia'`) each
carrying the leading space `retake.rs`'s `normalise` already expects — no
`'cem'`, `'ber'`, `'vid'` fragment survives. Also verified: **deterministic**
(two identical runs produced byte-identical output — greedy TDT, no sampling, no
seed needed), and **D-349 windowing works on it unchanged** (`start_secs=200`,
`duration_secs=120` → 10 segments, median 5.40 s, max 13.12 s, all inside the
window, nothing over the cap).

**A third defect was found doing this and is D-376** — `parakeet-mlx`
timestamps sentence-final punctuation at the end of the *following* silence, so
49 of 1184 within-word token gaps exceed 0.5 s (47 of them a bare `.` / `,` /
`?` / `'`; `' inference' + '.'` 12.16 s apart). It made ~4 % of words seconds
too long and produced a 19.92 s single-word segment on the windowed run,
defeating the cap. Fixed at the merge: such a token keeps its text and loses its
vote on the word's `end`.

**Not done, deliberately (resolved by D-381, §4.3):** `parakeet-mlx==0.5.3` is in
`ai-media/requirements.txt` but **not** in `ai-env/requirements.lock.txt` — the
relock is a full re-resolution of both sidecars and rewrites every transitive
pin, which is a bigger change than this one. `ai-env/verify.py` deliberately
does NOT check for `parakeet_mlx` either: that file gates whether
`apelles_ai::ai_env` **wipes and rebuilds** the shared venv (D-315), so adding
an opt-in backend to it would condemn every existing install. Both are tracked
in `docs/04-roadmap.md`. **Still true after step 4** — a default that did not
move needs no relock, and §4.2's own measurement was taken with
`parakeet-mlx` in a venv of its own rather than by touching the shared one.

### 4.2 What step 4 measured, and why the default did not move then (D-377, 2026-10-10 — superseded by D-381)

The full working is `docs/notes/retake-detection.md` §8; the decision and its
rejected options are **D-377**. The short version, because it is the one number
this whole note exists to produce:

Both backends, through the real seam, over **all twelve** of the owner's raw
camera originals — not just the two the thresholds were tuned on. Nine turned
out to be silent B-roll (−47 to −65 dBFS mean), which cannot have a cut proposed
against it, so the decision rests on three speech sources: C038, C040, and
**C019 (517 s), which the retake detector had never been pointed at**.

| over 2,192.6 s of speech | segments | retake groups | proposed for cut | **proposed but repeats nothing** |
|---|---|---|---|---|
| mlx-whisper large-v3 | 270 | 25 | 237.88 s | **5.42 s** — 1 utterance |
| parakeet-tdt-0.6b-v3 | 190 | 27 | 218.36 s | **56.92 s** — 5 utterances |

**Whisper stays the default on 56.92 s against 5.42 s** — 26 % of what Parakeet
offers for deletion repeats nothing, against Whisper's 2.3 %. The cause is the
thing this note has been measuring all along: **segment length**. A retake take
is a range of *whole* utterances, so when only an utterance's tail repeats the
whole utterance is cut, and Parakeet's mean segment is 11.4-11.8 s against
Whisper's 6.2-10.4 s. No setting of `similarity`, `min_words`,
`max_span_utterances` or `phrase_min_words` removes it (grid in §8.3) — they
govern *whether* a pair matches, not how much unrelated speech rides along.

Three things this pass established that bear on the rest of this note:

- **The seam is reproducible.** C038 through `transcribe(..., backend="parakeet")`
  gave **87 segments, median 5.12 s, max 14.96 s, 1296 words** — byte-for-byte
  §4.1's table, re-derived on a different day in a different venv.
- **The speed is ~10× end-to-end, not 17.6× relative to an untimed baseline.**
  Measured through the seam on the same machine, whole-file, ffmpeg extraction
  included: C038 **38.3 s** on Parakeet (25.8× realtime) against **369.6 s** on
  Whisper (2.7× realtime); C040 20.3 s against 237.8 s; C019 18.3 s against
  193.4 s. §1's "not timed this run" is now filled in.
- **Whisper hallucinates on silence and Parakeet does not.** On the nine silent
  sources Parakeet emits nothing; Whisper emits `"Thank you."` nine times across
  five of them, twice as a *verbatim* repeat 27.3 s apart — inside the retake
  detector's own window, at similarity 1.000. Only `min_words: 3` keeps it out.
  Pinned by `proposed_cuts.rs::the_silent_sources_are_not_a_test_of_the_cut`.
  It is the one place Parakeet is cleanly better for this pipeline.
- **`SEGMENT_MAX_S` / `SEGMENT_GAP_S` did not move** (§5 listed them as inputs to
  this sweep). The cap was never the binding constraint: Parakeet's longest
  segment on these sources is 14.96 s, under the cap, and the five bad cuts are
  11-15 s segments that are perfectly legal. Shortening them is a *retake*
  question, not a backend one — see D-377's "what this does NOT decide".

**Also found, and left as found:** the over-claimed cut is not fixed on either
backend — **B-246** — and D-366's guard never covered the case that produces it.
Whisper's one violation is on C019, the source this pass added.

### 4.3 Whisper decommissioned — Parakeet is the only backend (D-381, 2026-10-13)

The owner's call, after D-378/D-379's labelled eval: Whisper goes, Parakeet is the
default and only backend, Hindi does not matter. D-377's reason for keeping
Whisper (one proxy number from the retake rules) did not survive D-378's eval,
and D-379 found retake proposals made from Parakeet's word-timed transcripts
losing nothing. What changed in `ai-media/` and `ai-env/`:

- `asr/whisper_mlx.py` deleted; `asr/__init__.py`'s registry holds Parakeet
  alone and `DEFAULT_BACKEND = "parakeet"`. The seam, the validator, the
  descriptor and B-174's resolver stay — the seam is what the next backend
  needs. `BackendDescriptor.models` became `model_repos` (name → repo), so
  `server.py` reads the default backend's descriptor for `/health`'s repo and
  for `/transcribe`'s `model` default and validation instead of Whisper's map.
- D-349's `MLX_RANDOM_SEED` went with the Whisper module. Parakeet needs none:
  C040 transcribed twice through the CLI gave byte-identical JSON
  (sha256 `784505ea…`, 903 words, 58 segments).
- Languages: a named language outside Parakeet's 25 is refused with a sentence
  that no longer points at a Whisper backend; **Hindi/Hinglish is unsupported**.
- `harness/profiles.py`: the `WHISPER` profile and its constant are gone,
  `PROFILES = (PARAKEET,)`. `vad.py`'s cross-backend guard stays — the
  detector's own `DarkParams::default()` is still the Whisper-era 2.0 s as of
  this commit, so a report produced without `dark_params_for` is exactly the
  mismatch it refuses. A pre-D-381 Whisper transcript (`model: "large-v3"`) is
  refused by `profile_for` rather than given Parakeet's constants.
- The harness's live test now runs on Parakeet (C038, 200-260 s, offsets
  0/10/20 s): passes of **65 / 69 / 80 words** in 14.3 / 3.1 / 3.1 s → **65 words,
  all 65 unanimous**, 15 discarded outside the common range, 0 low-confidence
  spans. `start_secs` offsets work on Parakeet unchanged (§5's bullet on
  `chunk_duration`).
- `ai-media/requirements.txt` drops `mlx-whisper`; `ai-env/setup.sh --relock`
  re-resolved both sidecars (the lock moved — D-381 lists which pins); `verify.py`
  checks `parakeet_mlx` instead of `mlx_whisper`. What that does to an existing
  install is D-381's "install upgrade" and `docs/notes/ai-env-bootstrap.md`.
- `setup.sh --fetch-models` also fetches the Parakeet repo, for offline use.

#### 4.3.1 Does Parakeet recover what it drops? (the dark-region recovery path)

Without Whisper, D-349's recovery — re-transcribe in isolation a stretch the VAD
hears but the transcript lacks — runs on Parakeet only. Phase 6b's
`dark_live` run over the committed Parakeet transcripts of C019/C038/C040
(`docs/notes/whisper-dark-region-research.md` §8) found 21 stretches: 2 are
timestamp collapses (text present) and 19 are speech Parakeet's whole-file pass
left out, corroborated by Whisper's reading (6b counts 18 of them as dropped
speech; one, C038 836-852, is mostly speech neither model read). Each of the 19
was re-transcribed through the real path — `transcribe(path, start_secs,
duration_secs)` on the real source, windows exactly as the app's
`recoveryWindows` (`packages/editor/src/darkRegions.ts`) cuts them: the stretch,
grown to ≥ 4 s, split into ≤ 30 s pieces — and again with 5 s more context
either side. A word counts as recovered if its midpoint falls in a dark region
(±0.25 s). Nobody listened; Whisper's reading is the comparison, not ground
truth.

| source | stretch (s) | dark (s) | Parakeet whole-file words in it | windowed pass (app window) | ±5 s window | verdict |
|---|---|---|---|---|---|---|
| C019 | 62.64-78.00 | 11.97 | 0 | 30 w, 11.09 s — "Actually it's not. And the reason it's free and the reason it's not free is also the reason most people caching silently does nothing. The fingerprint has to match exactly." | 30 w | recovered |
| C019 | 91.52-95.92 | 4.24 | 1 | 14 w — "And the model we read is the whole thing like caching was never on." | 13 w ("rereads") | recovered |
| C019 | 97.36-99.60 | 2.24 | 1 | 7 w — "People in people in a enab people" | 8 w, same | **not recovered** (garbled; Whisper: "People enabling caching drop a current IP") |
| C019 | 275.04-284.32 | 9.15 | 1 | 28 w — "Uh there's a one-a-way options that cost a bit more to write first stuff that runs in burst with gaps. Past that window, the notes are gone and" | 28 w | partly (Whisper: "a one hour option") |
| C019 | 309.12-318.64 | 6.55 | 0 | 19 w — "Longer contacts, more agents steps, more back and forth in a single task because now they can afford it." | 18 w | recovered |
| C019 | 468.72-501.60 | 7.74 | 1 | 18 w — "…between the 400,000 bill and 701. If this made the whole" | 24 w | recovered |
| C038 | 45.44-59.44 | 4.30 | 1 | 11 w — "The whole business is building the chips for only one thing." | 12 w | recovered |
| C038 | 66.72-84.00 | 5.88 | 0 | 15 w — "Nvidia's biggest deal ever, and it wasn't even about the part that AI makes headlines" | 16 w (+"about.") | recovered |
| C038 | 177.08-204.60 | 5.89 | 0 | 15 w — "Running a model has quietly become more expensive than building it in the first place." | 15 w | recovered |
| C038 | 479.44-487.68 | 1.09 | 0 | 4 w — "It's like a stenographer." | 4 w | recovered |
| C038 | 501.92-505.04 | 3.12 | 0 | 7 w — "Word two. We read everything. Again. Plus" | 5 w | partly (Whisper: "word two reread everything again plus") |
| C038 | 509.44-528.84 | 7.61 | 0 | 14 w — "by word two hundred, that's two hundred full rereads, just to write one response." | 13 w | recovered |
| C038 | 836.44-852.44 | 4.73 | 0 | **0 words** | **0 words** | **not recovered** (Whisper read only "So quick recap,"; 3.7 s of it is silent in both ASRs) |
| C038 | 929.28-933.84 | 4.49 | 0 | 8 w — "That's real compute, real electricity, real hardware, real." | 7 w | recovered |
| C038 | 979.64-989.46 | 1.98 | 0 | 8 w — "Thanks for watching. See you in the next" | 8 w | recovered |
| C040 | 63.52-81.84 | 2.09 | 1 | 4 w — "Attention, in simple terms." | 5 w | recovered |
| C040 | 180.84-193.00 | 4.23 | 1 | 9 w — "The specific version of this use inside these models." | 10 w | recovered |
| C040 | 275.84-289.76 | 2.53 | 0 | 8 w — "There's an actual mechanism behind the checking in." | 8 w | recovered |
| C040 | 505.60-518.08 | 2.88 | 0 | 7 w — "if something's genuinely important, don't bury the" | 8 w | recovered |

**Result: of 19 stretches, 15 recovered (the windowed pass reads what Whisper
read, modulo a word), 2 partly (recovered with one mis-heard phrase), 2 not at
all** — C019 97.36-99.60 comes back as a garbled repetition ("People in people
in a enab people") at both offsets, and C038 836.44-852.44 comes back empty at
both. In time: **79.0 s of the 92.7 s of dark speech** gets word coverage from
the windowed pass (85 %), 226 words, in 42.8 s of compute for all 19 windows.
The second offset fixed neither failure; it changed a word here and there
elsewhere ("rereads" for "we read", "about." at a window edge).

So Parakeet's own drops are mostly recoverable by the same isolation trick that
recovered Whisper's (B-216) — the drops are context-dependent, not
acoustic. The two failures are short (2.2 s and 4.7 s of VAD speech, the latter
mostly unread by Whisper too). Scripts and the raw JSON stayed in the session
scratchpad; the table above is the record.

---

## 5. Open, named

- ~~**Default backend is still Whisper** until step 4's numbers exist.~~
  ~~Settled 2026-10-10 (D-377): Whisper stays the default.~~ **Settled
  2026-10-13 (D-381): Parakeet is the default and only backend; Whisper is
  decommissioned** (§4.3). D-377's deciding number did not survive D-378's
  labelled eval.
- ~~`parakeet-mlx` is not in `ai-env/requirements.lock.txt`, and `verify.py`
  does not check it.~~ **Done (D-381):** relocked, and `verify.py` checks
  `parakeet_mlx` instead of `mlx_whisper` — which is what upgrades an existing
  install (D-381; `docs/notes/ai-env-bootstrap.md`).
- **Dark-region recovery on Parakeet is measured, not perfect** (§4.3.1): 15 of
  19 dropped stretches recovered, 2 partly, 2 not at all. Nothing retries a
  failed window with a different context yet; a second offset did not help
  either failure.
- ~~`dark.rs`'s Whisper-specific constants are not yet moved to a
  descriptor.~~ **Done 2026-10-10 (D-375):** `BackendDescriptor` now carries
  `max_word_secs` (Whisper 2.0 s, Parakeet `None`), read by
  `harness.vad.dark_params_for`, which was the consumer whose absence kept the
  field out. **The app-side gap is closed (2026-10-13):** with Whisper
  decommissioned (D-381) Parakeet is the only backend, so
  `DarkParams::default().max_word_secs` is now `NO_WORD_LENGTH_BOUND_SECS`
  (1e6 — the same constant and the same finite-not-`inf` reasoning as
  `harness.profiles.NO_WORD_LENGTH_BOUND_SECS`) and
  `chroma_detect_dark_regions` needs no per-transcript backend tag. Measured:
  the detector still finds real Parakeet drops (21 stretches over C019 / C038 /
  C040), so it stays — `docs/notes/whisper-dark-region-research.md`
  "Parakeet, 2026-10-13".
- **The harness has no caller above `transcribe.py`.** `ai-media/harness/` is
  a library with tests; no sidecar endpoint, no GUI control, no MCP tool runs
  it, so it does not yet have the human+AI pair `CLAUDE.md` requires. The
  surface it will need is the one step 4's decision shapes (how many passes, at
  which offsets, and whether `low_confidence` renders in the Recut panel).
  **Step 4 has now shaped it** (D-377): the default stays Whisper at 2.7×
  realtime, so "three passes of a 989 s source for ~170 s" (§3.1) is a Parakeet
  budget, not a Whisper one — a multi-pass Whisper run of that file is ~18
  minutes. So the first real caller is a **Parakeet-backed** multi-pass pass
  whose *reconciled* output feeds the retake detector, which is a different
  question from "which backend's raw transcript is better" and is not answered
  by D-377.
- **`SEGMENT_GAP_S` / `SEGMENT_MAX_S` are measured, not settled — and step 4
  did not move them, because they were not the binding constraint** (D-377).
  Parakeet's longest segment across the three speech sources is 14.96 s, inside
  the cap; the five over-claimed cuts are 11-15 s segments that are perfectly
  legal. What §8 shows is that *mean* segment length, not the maximum, is what
  the retake detector is sensitive to — which makes "aim Parakeet at a shorter
  mean" a real, unexplored option and the only thing that would reopen the
  default. `SEGMENT_MAX_S` admits exactly one exception — a single word longer
  than the cap, kept whole rather than split mid-word — which is pinned by test
  so it stays the only one.
- **`chunk_duration` / `overlap_duration` are still module constants, not
  parameters.** §3.1 varies the chunk offset per pass, and for `mlx-whisper` it
  does so through `start_secs`, which needed nothing new. Parakeet's own knobs
  are still unthreaded, so a multi-pass run on the Parakeet backend currently
  varies its seams only via `start_secs` too. That works — its chunker also
  starts from the audio it is handed — but exposing the two parameters is the
  more direct knob and belongs with the first multi-pass caller, where the pass
  count and offsets get chosen on numbers. **Step 4 raised their value**: they
  are also the lever for a shorter *mean* segment, which is the one change that
  would reopen the default (previous bullet).
- **Parakeet reports no detected language.** `parakeet_mlx` 0.5.3 takes no
  language argument and `AlignedResult` carries no detected one, so the
  contract's `language` is whatever the caller asked for, or `"unknown"` for
  auto-detect. Nothing downstream reads it today.
- **No per-word `probability` from Parakeet.** `AlignedToken.confidence` is
  `1.0 - entropy/max_entropy`, not a probability; the field is optional and
  nothing in the repo reads it (the only `probability` consumers are Silero
  VAD's own speech probabilities), so putting a non-probability there would only
  mislead a future harness check that thresholded on it.
- **`transcribe.py`'s `backend` is not exposed above itself.** `server.py`'s
  `/transcribe`, and therefore `editor_get_transcript` and the Recut panel,
  still have no way to ask for Parakeet — which is intentional for an opt-in
  step 2 ("nothing above `transcribe.py` changes"), and is also why this feature
  does not yet owe the GUI+MCP pair `CLAUDE.md` requires. It will when the
  default moves, or sooner if a caller wants the choice. **D-377 decided the
  default does not move**, so this stays shut until a caller asks — and the
  likeliest such caller is the harness's own multi-pass run, which wants
  Parakeet for its speed regardless of which backend the single-pass default
  is.
- Number normalisation ("Twenty billion dollars" vs "$20 billion") is still
  unhandled, and **step 4 measured that it did not matter here** (D-377): not
  one of Parakeet's five over-claimed cuts, nor any difference in group count,
  turns on a spelled-out number. It stays open as a transcript-quality issue,
  not as a retake-detection one.
- Parakeet is 25 European languages and **Hindi/Hinglish is unsupported**
  (D-381, the owner's call — there is no longer a Whisper to send it to). The
  descriptor's language set refuses a caller that *names* an unsupported
  language; a source transcribed with no language named is not caught, because
  Parakeet reports no detected language.
