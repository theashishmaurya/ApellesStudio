# ASR backends and the transcript harness (D-374)

**Why this exists.** `ai-media/transcribe.py` hard-codes one model
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
`whisper_mlx.py` (today's code, moved unchanged), `parakeet_mlx.py` (new).
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

## 3. The harness — the actual product

A **pipeline of checks**, each taking the contract and returning the contract
plus annotations. Backend-agnostic by construction: a check only ever sees the
contract, never a model. This is the "every harness easily takes other ones"
requirement — both in the sense that any *backend* can be harnessed, and that
any *check* can be added without touching the others.

```
backend ─► [ multi-pass reconcile ] ─► [ VAD cross-check ] ─► [ … ] ─► result
              (needs a fast backend)     (reuses silero)
```

### 3.1 Multi-pass reconciliation — what the speed buys

At 17.6× realtime, three passes of a 989 s source cost ~170 s. Vary something
that moves the model's own boundaries without changing the audio: **chunk
offset** (`parakeet-mlx` takes `chunk_duration`/`overlap_duration`) is the
obvious knob, because the measured failures — run-on segments and dropped
words — cluster at chunk seams.

Reconcile by aligning the passes' word streams on time and text, then:
- **agreed by all passes** → high confidence
- **disagreed** → keep the majority reading, record the alternatives
- **present in some passes only** → keep it, flag it

The output is the same contract plus a per-word `agreement` and a
`low_confidence` span list. That is the honest answer to "we can't get 100 %":
the transcript says where it is unsure instead of pretending.

### 3.2 VAD cross-check — generalising `dark.rs`

`crates/apelles-speech/src/dark.rs` already does exactly this for Whisper:
VAD says *speech*, transcript says *nothing* → a dark region. It is written
against Whisper's failure mode and two of its constants are Whisper-specific
(the 2.0 s too-long-word bound is `mlx_whisper/transcribe.py`'s own anomaly
threshold; Parakeet's duration head caps token length at ~0.32 s, so that bound
is meaningless there). **The cross-check is general; the constants are not.**
They move into the backend descriptor, not the check.

### 3.3 What a check may not do

Reach for a model, or know which backend produced its input. A check that
needs model internals is a backend feature, not a check.

---

## 4. Migration, deliberately staged

1. ✅ **Seam only** (2026-10-09) — `ai-media/asr/`, Whisper moved behind it,
   zero behaviour change.
2. ✅ **Parakeet backend** (2026-10-09) — opt-in via `backend="parakeet"`.
   Whisper stays the default.
3. ⬜ **Harness** — built against the *existing Whisper backend* first, which is
   how its backend-agnosticism gets proved rather than asserted.
4. ⬜ **Re-derive, then switch** — only once the harness exists: re-run
   `apelles-speech`'s corpus against a Parakeet transcript, re-sweep the
   retake thresholds, and decide the default on the numbers.

**Step 4 is the expensive one and it is not optional.** B-237, B-238, D-365
and D-366 were four sessions of tuning against Whisper's output shape, pinned
by five corpus tests asserting exact group counts and cut ranges. Changing the
ASR changes tokenisation, punctuation and boundaries, so those tests must be
re-derived, not edited until green.

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

**Not done, deliberately:** `parakeet-mlx==0.5.3` is in
`ai-media/requirements.txt` but **not** in `ai-env/requirements.lock.txt` — the
relock is a full re-resolution of both sidecars and rewrites every transitive
pin, which is a bigger change than this one. `ai-env/verify.py` deliberately
does NOT check for `parakeet_mlx` either: that file gates whether
`apelles_ai::ai_env` **wipes and rebuilds** the shared venv (D-315), so adding
an opt-in backend to it would condemn every existing install. Both are tracked
in `docs/04-roadmap.md`.

---

## 5. Open, named

- **Default backend is still Whisper** until step 4's numbers exist.
- `dark.rs`'s Whisper-specific constants are not yet moved to a descriptor.
  `BackendDescriptor` deliberately carries only what the seam itself uses
  (models, languages) — a field no check reads yet would be dead code.
- **`SEGMENT_GAP_S` / `SEGMENT_MAX_S` are measured, not settled.** Both were
  picked from one source and are inputs to step 4's re-sweep, not conclusions
  of it. `SEGMENT_MAX_S` admits exactly one exception — a single word longer
  than the cap, kept whole rather than split mid-word — which is pinned by test
  so it stays the only one.
- **`chunk_duration` / `overlap_duration` are module constants, not
  parameters.** §3.1 wants the chunk offset varied per pass; the harness that
  would vary it is step 3, so threading them through now would be a parameter
  nothing passes.
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
  default moves, or sooner if a caller wants the choice.
- Number normalisation ("Twenty billion dollars" vs "$20 billion") is
  unhandled; it affects `retake.rs`'s string similarity and should be decided
  with step 4's sweep, not guessed at now.
- Parakeet is 25 European languages. `transcribe.py`'s docstring claims
  code-switched Hinglish auto-detects fine on `large-v3` — **Hindi is not in
  Parakeet's set**, so any Hinglish source must stay on Whisper. The backend
  descriptor carries the language set so a caller can be refused rather than
  silently mis-transcribed.
