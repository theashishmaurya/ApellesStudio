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

1. **Seam only** — `ai-media/asr/`, Whisper moved behind it, zero behaviour
   change. The committed fixtures must come back byte-identical.
2. **Parakeet backend** — opt-in via `backend="parakeet"`. Whisper stays the
   default.
3. **Harness** — built against the *existing Whisper backend* first, which is
   how its backend-agnosticism gets proved rather than asserted.
4. **Re-derive, then switch** — only once the harness exists: re-run
   `apelles-speech`'s corpus against a Parakeet transcript, re-sweep the
   retake thresholds, and decide the default on the numbers.

**Step 4 is the expensive one and it is not optional.** B-237, B-238, D-365
and D-366 were four sessions of tuning against Whisper's output shape, pinned
by five corpus tests asserting exact group counts and cut ranges. Changing the
ASR changes tokenisation, punctuation and boundaries, so those tests must be
re-derived, not edited until green.

---

## 5. Open, named

- **Default backend is still Whisper** until step 4's numbers exist.
- `dark.rs`'s Whisper-specific constants are not yet moved to a descriptor.
- Number normalisation ("Twenty billion dollars" vs "$20 billion") is
  unhandled; it affects `retake.rs`'s string similarity and should be decided
  with step 4's sweep, not guessed at now.
- Parakeet is 25 European languages. `transcribe.py`'s docstring claims
  code-switched Hinglish auto-detects fine on `large-v3` — **Hindi is not in
  Parakeet's set**, so any Hinglish source must stay on Whisper. The backend
  descriptor carries the language set so a caller can be refused rather than
  silently mis-transcribed.
