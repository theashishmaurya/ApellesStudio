# `ai-media/harness/` — the transcript harness (D-374 step 3, D-375)

A **pipeline of checks** over the transcript contract. Each check takes one
transcript and returns the same transcript plus annotations.

```
backend ─► [ multi-pass reconcile ] ─► [ VAD cross-check ] ─► [ … ] ─► result
```

**What it is for.** D-374's premise, in the owner's words: *"we can not get
100% thats not possible we will build the Harness arround it also make sure
every harness it easily takes other ones."* No ASR is perfect, so the product
is the thing that says **where the transcript is unsure** instead of pretending.
A backend ~10× faster and 2 % worse is a better input to this than a slower,
marginally better one, because the saved time buys passes.

**What it does NOT do.** It does not transcribe, run a model, read audio, cut
anything, or touch the timeline. It has no dependencies outside the standard
library.

## The boundary

`pipeline.run_checks` calls a check with exactly two arguments:

1. a transcript contract — a plain `dict` of JSON-able data;
2. a `CheckContext` — a frozen dataclass holding one `BackendProfile`, itself
   three fields of plain data.

No model, no audio path, no callable, no backend module, and no way to obtain
one: **nothing in this package imports a backend or a model runtime**, and
`test_harness_pipeline.py` reads the source to prove it. That is D-374's *"a
check never sees a model"* as a property of the signature rather than a rule
someone has to remember. A check that needs model internals is a backend
feature, not a check.

## Modules

| | |
|---|---|
| `contract.py` | the only module that knows the contract's JSON shape — reading it, and the annotation vocabulary (`words[i].agreement`, `low_confidence`, `harness`) |
| `align.py` | **the hard part** — a pure N-stream word aligner (progressive MSA over a weighted-LCS DP, scoring text and time together, time-banded). No knowledge of confidence or checks |
| `reconcile.py` | **check 1** — multi-pass reconciliation |
| `vad.py` | **check 2** — the VAD cross-check's contract-layer halves |
| `pipeline.py` | the `Check` protocol, `CheckContext`, `run_checks` |
| `profiles.py` | `BackendProfile` — the whole of this package's knowledge that backends differ, three fields wide |

## Check 1 — multi-pass reconciliation

Run the same source N times varying the **chunk offset** (the measured knob:
the failures cluster at chunk seams), then per word:

- agreed by every pass → `unanimous`
- read differently → `disagreed`; the majority reading is kept and the
  alternatives recorded, with which passes held each
- present in only some passes → `partial`; kept and flagged

Everything not unanimous also becomes a `low_confidence` span. Only the range
every pass covered is reconciled; a word a wider pass found outside it is not
adopted.

**Producing the passes is not a check's job.** `MultiPassReconcile` is
constructed *with* the other passes — contracts, every one — so the check still
only ever sees contracts.

## Check 2 — the VAD cross-check lives in Rust, and that is deliberate

`VAD says speech, transcript says nothing ⇒ a dark region` is
`crates/apelles-speech/src/dark.rs`, scored over 111 labelled windows for 90 %
precision. It is **not** reimplemented here. Its second input is *audio* —
Silero probabilities and an RMS envelope — which the contract does not carry
and `ai-media/` has no model or decoder to produce; and what was
backend-specific about it (written for `mlx-whisper`) was never the algorithm but one number, which
`DarkParams::max_word_secs` already took as a parameter. Full reasoning: D-375.

So `vad.py` is the half that genuinely is contract-layer:

- `dark_params_for(profile)` — the `DarkParams` override **this backend** needs
- `fold_dark_report(...)` — the detector's own `DarkReport`, folded into
  `low_confidence`, refusing a report produced under another backend's constants

The report comes from wherever the detector already runs: the app's
`chroma_detect_dark_regions` command, or `apelles-speech`'s `dark_live`
integration test (`APELLES_DARK_REPORT_JSON` / `APELLES_DARK_MAX_WORD_SECS` /
`APELLES_DARK_RANGE_START`).

## Backend profiles

`asr/base.py`'s `BackendDescriptor` is the single source of truth for
`max_word_secs`. `BackendProfile.from_descriptor` converts one. **Since D-381
the registry holds one profile, Parakeet's** — the machinery stays for the next
backend, and a transcript from a model no profile names (including a pre-D-381
Whisper transcript, `model: "large-v3"`) is refused rather than given
Parakeet's constants. The registry mirrors the descriptors so the harness can resolve a profile from a transcript's own
`model` field **with no backend in the process** — a transcript read off disk,
or over the sidecar's HTTP boundary — and `test_harness_pipeline.py` pins the
mirror to the descriptors field-for-field, so drift is a failing test.

## Determinism

Pure and total throughout: same inputs, same output. No wall clock, no RNG, no
iteration over a set. Pinned by tests in both files.

## Tests

```
python3 ai-media/test_harness_align.py       # the aligner, 12 scenarios
python3 ai-media/test_harness_pipeline.py    # checks + pipeline, 15 checks
APELLES_HARNESS_SOURCE=<a real file> \
  ai-env/.venv/bin/python ai-media/test_harness_live.py   # real Parakeet, opt-in
```

The first two need no model and no venv — that is the point, not a convenience.
