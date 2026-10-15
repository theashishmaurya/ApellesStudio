# `apelles-speech`

**What was said, and where nobody said anything.** (D-318)

The analysis half of "clean up a talking-head recording": find the dead air, find
the retakes, and find the speech the transcription silently never read.

| module | question it answers | how |
|---|---|---|
| `vad` | is anyone talking, right now? | silero-vad v6.2.1 ONNX (D-319), 16 kHz mono, one probability per 512-sample hop |
| `silence` | where are the gaps worth cutting? | hysteresis over those probabilities → spans in seconds |
| `retake` | did they say this line already? | normalised edit distance + containment over **spans** of adjacent utterances (D-320, D-327), ORed with `phrase` |
| `phrase` | did they just repair the same PHRASE? | a repeated, content-bearing word n-gram — the "rough copy" property of a reparandum/repair (D-365) |
| `dark` | is there speech here that nobody transcribed? | VAD speech ∩ the gaps in transcript word coverage, gated on a per-file amplitude floor (D-349) |
| `proposal` | may this retake group, proposed by the MCP client, be applied? | renders the word-indexed view a client reads; a deterministic coverage gate (LCS + five forgiveness rules) refuses any group whose deleted takes hold a word the kept take lacks, and resolves the rest to padded source seconds (D-380) |

## The boundary

**In:** decoded PCM (`&[f32]`, mono, 16 kHz) and transcript utterances/words.
**Out:** candidate spans, groups and regions, in **seconds**.

That is the whole surface, and every exclusion below is deliberate:

- **It never cuts anything.** All three detectors are read-only. They return
  candidates; applying one is the timeline's job, through the split / remove /
  ripple ops that already existed. Apelles is not an auto-editor
  (`docs/00-vision.md`), and retake grouping has an honest false positive that
  is fine in a suggestion and unforgivable in a deletion.
- **It never reads a file.** No ffmpeg, no symphonia, no paths except the
  model's. `apelles-media::audio::decode_mono_at_rate` does the decoding and
  resampling; the frontend store owns the transcript cache.
- **It knows nothing about timelines.** No fps, no frames, no clips. Converting
  a span to a clip's source frames needs a timeline, so the op layer does it.

Taking `&[f32]` rather than a path is what makes the tests real: the hysteresis,
the grouping and every threshold are exercised against fixtures with
known-correct answers, with no model in the loop.

## Layer

L2, alongside `apelles-timeline`. Depends on `serde`, `thiserror`, `ort` +
`ndarray` (the workspace's existing ONNX stack) and `strsim`. It deliberately
does **not** depend on `apelles-media` — nothing here decodes, and it carries no
sentence-embedding model: that was built, measured and rejected (D-327, below).

## The model file

Not bundled. `MODEL_URL` / `MODEL_FILENAME` / `MODEL_SHA256` in `vad.rs` name
the exact artifact — silero-vad's own released ONNX at a pinned upstream tag —
and the app fetches and verifies it lazily on first use, by the same pattern
`ai_processing.rs` uses for the other seven ONNX models.

**The 64-sample context prefix is mandatory and getting it wrong is silent.**
v6 fed a bare 512-sample window returns probabilities pinned near 0.001, so the
entire clip reads as silence. See `vad.rs`'s module doc for the measured table,
and D-319 for why the version is pinned.

## Tests

```sh
cargo test -p apelles-speech
```

No model required for any of the default tests — `tests/real_model_output.rs` replays a probability
track captured from the real model over a real speech clip, `retake.rs` carries
the real six transcript segments from **B-198** as a regression test,
`tests/real_transcripts.rs` and `tests/proposed_cuts.rs` run the detector over
whole verbatim transcripts of the owner's own camera originals (plain JSON — no
model, no audio, no network), `tests/retake_eval.rs` scores those same runs
against hand-labelled ground truth in `eval/retake/` (**D-378** / **D-379** —
the measurement any change to `retake.rs`, or any external proposer, is judged
on — and, since **D-380**, the measurement that pins `proposal.rs`'s coverage
gate: oracle refusals, detector misses and the committed MCP-client runs, in
`eval/retake/gate_baseline.json`), and
`dark.rs`'s fixtures are shaped like real speech (five utterances separated by
real pauses, because a fixture that is one continuous span has no *other*
utterance to calibrate the amplitude floor against).

The two tests that *do* drive the model are `#[ignore]`d, because they need the
downloaded artifact and a located ONNX Runtime library (and see **B-187** for
the teardown abort that makes them unfit for an unattended run):

```sh
ORT_DYLIB_PATH=app/src-tauri/resources/libonnxruntime.dylib \
APELLES_SILERO_MODEL=/path/to/silero_vad_v6.2.1.onnx \
APELLES_SILERO_PCM=/path/to/clip.f32 \
  cargo test -p apelles-speech --test silero_live -- --ignored --nocapture
```

`ffmpeg -i clip.wav -f f32le -ac 1 -ar 16000 clip.f32` produces the PCM.

`tests/dark_live.rs` is the same idea for the dark-region detector, against a
real source **and its real transcript** — the thing fixtures cannot cover is
whether the findings are the utterances a human can hear and the transcript does
not contain. Its own module doc has the full command.

## Dark regions, and why they need a detector at all (D-349, B-216)

Historically (Whisper, removed by D-381): its whole-file pass did not merely mis-hear some utterances — it emits no
tokens for them, inside a 30-second window it is otherwise decoding confidently,
at temperature 0.0 with `no_speech_prob` 0.043-0.171 against a 0.6 threshold.
Nothing in its machinery notices, so there is no error and no confidence score to
filter on, and the DTW alignment then stretches the surviving words across the
hole so the transcript reads plausibly and is wrong. Measured rate: roughly one
dropped multi-second region per three minutes of raw footage, on two independent
camera originals — and the loss is **biased towards near-duplicate repeats**,
i.e. towards exactly what `retake` is looking for.

`dark` is therefore a third detector rather than a note on the other two:
`silence` reads no transcript and `retake` reads no audio, so neither can see
this. Two of its rules are load-bearing and neither is obvious —
a transcript word longer than 2.0 s contributes **no coverage** (without it the
detector misses more than half the real cases), and the amplitude floor is
calibrated **per file** from the quietest speech that file's own transcript read
correctly (which is what takes precision from 72.7 % to 90-100 %). Full trail,
with the 111-window scoring: `docs/notes/whisper-dark-region-research.md`.

**Parakeet, the only backend now (2026-10-13).** The detector is
backend-agnostic and outlived Whisper because Parakeet has the same kind of
failure — measured 21 real dark stretches in 2,192 s of C019 / C038 / C040, in
different places than Whisper (it reads all nine windows Whisper dropped).
What changed is the first rule above: Parakeet's duration head cannot stretch a
word across a hole, so `DarkParams::default().max_word_secs` is
`NO_WORD_LENGTH_BOUND_SECS` (1e6, "no word is too long" — finite because the
app's command guard and JSON echo need a finite number). A caller with a
stretching backend passes a real bound (Whisper's was 2.0 s). `dark_live`
defaults to the same; pass `APELLES_DARK_MAX_WORD_SECS=2.0` to score a Whisper
transcript the old way.

## Why a retake is a span, and why there is no embedding model (D-327)

Whisper segments on its own heuristics and has no idea a speaker restarted, so
**its boundaries do not line up with the restart boundaries**. On real footage a
line delivered three times produced six segments in which no pair was a
duplicate of any other (best 0.857; every pair carrying repeats two and three
scored 0.18-0.28) — so the detector found one group of two and missed ~22s of
duplicated speech. `retake` therefore compares **spans** of up to
`max_span_utterances` adjacent utterances, which scores the same material 0.905.
A group reports `takes` (inclusive ranges over its `members`) and `keep` indexes
`takes`, not `members`.

### Two signals, not one (D-365)

"The same line again" is only half the question. The other half is a speaker
repairing **one phrase** inside two otherwise-different sentences — measured on
real footage at **0.495** against the 0.82 bar, i.e. unreachable by any threshold
move. `phrase` answers that half, and `retake` accepts a candidate matched by
**either** arm. `similarity` keeps its exact previous meaning;
`phrase_min_words: 0` restores the pre-D-365 detector.

It is strictly *additive* — the similarity arm is tried at every span length
before the phrase arm at any, so wherever the old detector matched, it still
matches exactly that. (Without that ordering the looser arm pre-empted a longer
strict match and split one delivery in two, which — since `keep` is the last
take — offered half a real delivery up to be cut.)

**Its cost, measured on two whole real transcripts** (187 segments, 1,671 s, 698
utterance pairs; both committed as fixtures and run by
`tests/real_transcripts.rs`): 22 pairs newly admitted, **21 real retakes and 1
false positive** — a deliberate parallel construction, which text alone cannot
tell from a repair. Pinned as a test rather than hidden. And note what `phrase`
does *not* fix: a minimal pair differing in one word shares a long verbatim run,
so it says yes to "…less weight" / "…more weight" — it adds no *new* admission
there only because plain edit distance already scores that pair 0.925.

### A glued take may not carry material that repeats nothing (D-366)

Both signals above match a span on only *part* of itself — containment sweeps for
its best window, `phrase` needs one shared run anywhere — while a group discards
each non-kept take **whole**. So a take glued from several utterances could match
on one of them and propose all of them for deletion. Measured on the same two
fixtures, that was the default rather than an edge case: 16 of 17 glued anchors
were carrying unique content, and the detector proposed cutting **259.8 s of
speech that repeated nothing**, one video's own opening hook included.
`MIN_UTTERANCE_OVERLAP` now guards the **anchor** as well as the candidate —
referenced to the union of the deliveries that matched it, since Whisper spreads
a repeated line across its own boundaries — and an unjustified chain is rejected
rather than trimmed. Detection, the predicates and the `RetakeGroup`/`TakeSpan`
shape are all unchanged. **When changing this crate, measure the proposed cut and
not only the grouping**: they are two claims, and two consecutive passes verified
only the first.

### …and it was still not fully fixed (B-246, found by D-377; fixed by D-386)

D-366's guard applies to *glued* spans only — `MIN_UTTERANCE_OVERLAP`'s own doc
says single-utterance takes stay "judged by `similarity` alone" — and its
invariant test only ever ran on two hand-picked excerpt fixtures. Run over whole
transcripts of **twelve** raw sources, both ASR backends, it fails: **six
proposed cuts carry speech that repeats nothing in their own group**, every one a
single-utterance take admitted by containment on a matching tail. 5.42 s on
mlx-whisper, **56.92 s on parakeet** — whose longer segments are what made that
number decide D-374's backend default (**D-377**: Whisper stays). Third time this
detector has shown a green audit that measured material the tuning was fitted to,
which is why the new tier — `tests/proposed_cuts.rs`, 24 committed transcript
fixtures — audits whole transcripts of every source rather than another excerpt.
`docs/notes/retake-detection.md` §8 has the table, the threshold sweep that
removes none of it, and why `phrase_min_words: 0` is not the fix.

**Fixed by D-386.** A group now keeps a non-kept take only when its keeper holds
that take's every content word, judged by the coverage gate's own content rule
(`proposal::text_is_covered`), and is dropped when fewer than two takes remain.
That closes all three shapes D-378's eval charged (a take repeating nothing, a
fragment keeper, unique speech `word_overlap` forgave) — over-cut **0.00 s on
every `eval/retake/` task** and 0.00 s "repeats nothing" in `proposed_cuts.rs`
— at a recall cost: a take whose words the ASR mis-heard is no longer proposed.
What the app shows after the gate is unchanged or better (D-382's gated tasks:
recall 0.161 / 0.189 / 0.232 → 0.232 / 0.189 / 0.296), and the gate refuses
none of the detector's groups. §14 of the note has the options measured.

The obvious fix — an on-device sentence-embedding model — was built in full,
verified correct to four decimals against upstream's own reference
implementation, and **rejected on the numbers**: cosine ranks a sentence against
its own negation at 0.946 and an antonym pair at 0.981, above every genuine
retake in that footage (0.59-0.77). Edit distance ranks the same pairs
correctly. Do not re-add it without reading `docs/notes/retake-detection.md`,
which has the full table.

## Retake proposals from the MCP client, and the gate in front of them (D-380)

Since D-380 the retake *judgement* is not this crate's: the MCP client (an LLM)
reads the word-indexed transcript `render_indexed` prints and answers with
groups of word-index ranges plus a keep. `proposal::check_and_resolve` is the
app's half, and it runs no model: it refuses any group whose deleted takes hold
a content word the kept take does not (aligned by LCS, with a closed list of
forgiven tokens — stopwords, fillers, false starts, repeats, near-identical
spellings), refuses malformed and conflicting groups, allows a stutter cut
nested inside another group's kept take, and resolves the rest to padded
source-second `CutRange`s. **Necessary, not sufficient**: it proves nothing
said once is offered for deletion; it cannot judge take quality and cannot
hear. Measured: it accepts none of the old detector's six over-cutting groups
and refuses 17 of 46 correct ones — nearly all for a word the ASR mis-heard.
`examples/render_word_transcript.rs` prints the view for any `transcribe.py`
JSON. Detail: `docs/notes/retake-detection.md` §11.

**Step 2 (D-380), the app's side of the exchange.** `index_pieces` builds the
view of a whole timeline track (clip windows onto source transcripts, a word
kept by midpoint, runs never shared across clips — one untrimmed clip is exactly
`index_transcript`), `render_indexed_page` serves it in pages with global
indices, and `JUDGING_RULES` is the POC's prompt verbatim, which the app serves
with the first page. `check_and_resolve_waived` adds the client's confirm path:
a content refusal whose every offending word the client vouched for becomes
`GroupVerdict::Confirmed` (listing the waived words), never `Accepted`;
structural and cross-group refusals are not waivable. `would_cut` resolves a
refused group's deletions for a human who has listened and chooses to cut
anyway. `take_from_span` maps a take in seconds to word indices by midpoint
(the deterministic detector's groups, D-382).
