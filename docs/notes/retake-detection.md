# Retake detection — what signal actually separates a restart from a different sentence

Worked-out detail behind **D-318** (the detector), **D-320** (edit distance +
containment), and **D-327** (spans, and the embedding model that was measured
and rejected). Fixes **B-198**. **§4 is a different bug, found later** (B-237,
2026-09-24) — not in the algorithm this note is mostly about, but in how the
whole-track sweep feeds it, measured against a real human re-edit rather than
a synthetic case.

This note exists for one reason: "use a semantic embedding model" is the
obvious, confident, wrong answer to this problem, and the next person to look at
retake detection will think of it within about thirty seconds. It was built,
measured against upstream's own reference implementation, and thrown away. The
numbers are here so that decision does not have to be re-derived. **§4 is the
other trap**: even a perfect grouping algorithm catches nothing if the sweep
calling it never shows it both takes at once.

---

## 1. The bug, as it actually presented

The owner's footage `A001_09122356_C040.MOV`, transcript 142–180 s, via
`editor_get_transcript`. The speaker stumbles and restarts one line three times.
Whisper's segmentation — which has no idea a restart happened — cut it like this:

```
#0  142.38–148.06  "If the one part of your message gets less of that glancing bag than others, the model"
#1  148.06–149.94  "just under waves it."
#2  149.94–157.48  "it. If the one part of your message gets less of that glancing back than the others, the"
#3  157.48–169.12  "model just waves it. The model just under waves it. If one part of your message gets"
#4  169.12–179.92  "less of that glancing back than the others, the model just under waves it. If the one"
#5  179.92–194.72  "it. The specific version of this used inside these models is called self-attention and"
```

Every repeat straddles a boundary. Segment #3 alone holds the **tail** of one
delivery concatenated with the **head** of the next.

### Every pairwise lexical score, measured

`similarity()` (D-320: max of whole-string `normalized_levenshtein` and the
containment window sweep) over all fifteen pairs of the normalised segments:

```
sim(0,1) = 0.1310    sim(1,2) = 0.1279    sim(2,3) = 0.1951    sim(3,4) = 0.2771
sim(0,2) = 0.8571    sim(1,3) = 0.2317    sim(2,4) = 0.2530    sim(3,5) = 0.2588
sim(0,3) = 0.1786    sim(1,4) = 0.2289    sim(2,5) = 0.3176    sim(4,5) = 0.3176
sim(0,4) = 0.2143    sim(1,5) = 0.1529
sim(0,5) = 0.2941
```

One pair (0,2) clears the 0.82 threshold. **Every pair involving #3 or #4 — the
two segments carrying repeats two and three — scores 0.18–0.28.** That is noise,
not a near miss: no threshold loose enough to catch 0.28 would be usable.

The detector was not mis-scoring anything. The repeated material was never
inside any single string it compared. **This is a segmentation-alignment
problem, not a lexical-vs-semantic one** — which is the whole point of this note.

---

## 2. The fix that worked: compare spans, not utterances

Join up to `max_span_utterances` (default 3) adjacent utterances into one string
before comparing. Measured, disjoint span pairs, lexical `similarity()`:

| span pair | lexical | semantic (see §3) |
|---|---|---|
| `[#0..#1]` vs `[#2..#4]` | **0.9048** | 0.7601 |
| `[#0..#1]` vs `[#2..#3]` | 0.8953 | 0.6045 |
| `[#2]` vs `[#3..#4]` | 0.8977 | 0.6096 |
| `[#0..#1]` vs `[#3..#4]` | 0.8824 | 0.6218 |
| `[#0..#1]` vs `[#4]` | 0.8916 | 0.6672 |

The same material that scored 0.18–0.28 as utterances scores **0.88–0.90** as
spans, comfortably clear of the unchanged 0.82 threshold.

### Before / after on the real transcript

```
max_span_utterances = 1   (the pre-D-327 detector)
  1 group — members [0, 2], 2 takes
    take 0: utt 0      142.38s–148.06s
    take 1: utt 2      149.94s–157.48s   <-- suggested keep
  → stops at 157.48s; ~22s of duplicated speech never proposed

max_span_utterances = 3   (default, D-327)
  1 group — members [0, 2, 3, 4], 3 takes
    take 0: utt 0      142.38s–148.06s
    take 1: utt 2      149.94s–157.48s
    take 2: utt 3..4   157.48s–179.92s   <-- suggested keep
  → reaches 179.92s, three deliveries, #5 correctly excluded
```

`max_span_utterances` of 2, 3 and 4 all produce the identical result here; the
default is 3 for headroom on a delivery Whisper happened to cut into three.

### The honest limit

Delivery two begins *inside* #2 and delivery three *inside* #3. A take made of
whole utterances cannot claim the fragment #1 ("just under waves it.") for
delivery one without also claiming material that belongs to the next delivery.
The detector leaves #1 out — **under-cutting rather than over-cutting**, the
safe direction for something that only proposes (D-318). Pinned by
`a_take_boundary_falling_mid_utterance_is_left_out_not_over_claimed`.

Word-accurate boundaries would fix it properly and need per-word timings plumbed
from the transcript store through `chroma_detect_retakes` (which today
deliberately asks for `start`/`end`/`text` only). On the roadmap, not in D-327.

---

## 3. The rejected option: on-device sentence embeddings

### What was built

- **Model:** `sentence-transformers/all-MiniLM-L6-v2`, the repository's **own**
  ONNX export (`onnx/model.onnx`), not a re-host and not a conversion we ran —
  the same rule D-319 applied to Silero.
- **Pin:** commit `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`. A Hugging Face repo
  has no tags, so the pin is a full commit sha; `main` moving would change bytes
  under a hash that no longer matches, which reads as corruption rather than a
  version bump.
- **Licence:** Apache-2.0. **Size:** 90,405,214 bytes (model) + 466,247 bytes
  (`tokenizer.json`). **Maintenance:** 254M downloads/month, the reference small
  sentence-embedding model.
- **Runner:** the same `ort` 2.0.0-rc.10 path as D-319's Silero, plus
  `tokenizers` 0.23.1 — already in this workspace for CLIP, so no new dependency
  mechanism. Inputs `input_ids` / `attention_mask` / `token_type_ids`, output
  `last_hidden_state`; attention-masked mean pooling (upstream's
  `1_Pooling/config.json` sets `pooling_mode_mean_tokens: true`), then L2
  normalise.
- **Latency, measured on this machine:** 15 spans batched in 188 ms
  (**12.5 ms/span**); a single span **15.7 ms**. For a 10-minute talking head
  (~360 candidate spans) that is ~4.5 s — acceptable, not the reason it was
  rejected.
- **Determinism:** max `1 - cos` between two runs of the same input `9.6e-9`.

### The implementation was verified correct, so the numbers are the model's

Before trusting any conclusion, the Rust ONNX runner was checked against
upstream's own `sentence-transformers` snippet (`AutoModel` → masked mean pool →
`F.normalize`) run under `torch` on the **same pinned weights**. Cosine agreed
to four decimal places on every probe:

| pair | Rust (ONNX) | reference (PyTorch) |
|---|---|---|
| real restart span pair | 0.7722 | 0.7722 |
| "less weight" / "more weight" | 0.9813 | 0.9813 |
| "talk about colour" / "look at the waveform" | 0.1193 | 0.1193 |
| "cat sat on the mat" / "dog sat on the mat" | 0.7251 | 0.7251 |

So what follows is `all-MiniLM-L6-v2`'s actual behaviour, not a runner bug.

### The disqualifying measurement

**MUST group** (genuine restarts, including the live footage's own spans):

| pair | cosine |
|---|---|
| identical line, twice | 1.0000 |
| "so the whole point here is that attention is selective" / "so the whole point is that attention is selective" | 0.9637 |
| **live footage**, spans `[#0..#1]` vs `[#2..#4]` | 0.7722 |
| **live footage**, spans `[#0..#1]` vs `[#4]` | 0.6628 |
| "the model just under-weighs it" / "the model gives that part less weight" | 0.5913 |

**MUST NOT group** (different lines, same subject):

| pair | cosine |
|---|---|
| "…gives that part of the message **less** weight" / "…**more** weight" | **0.9813** |
| "the model weighs every part equally" / "the model does **not** weigh every part equally" | **0.9455** |
| "this is the **encoder** side of the model" / "…**decoder** side…" | 0.8322 |
| "first we will look at what attention **does**" / "then we will look at what attention **cannot** do" | 0.8011 |
| "attention is how a transformer decides what matters" / "attention is the mechanism that makes transformers work so well" | 0.7645 |
| "self-attention lets every token look at every other token" / "cross-attention lets the decoder look at the encoder's tokens" | 0.5785 |

```
positives: min=0.5913  max=1.0000
negatives: min=0.5785  max=0.9813
separable by a threshold?  False
negatives scoring ABOVE the weakest true retake:  5/6
```

The distributions overlap almost completely, and the overlap is **concentrated
in negation and antonymy** — the single distinction a cut proposal must never
get wrong. A detector that suggests deleting the clause carrying the "not"
inverts what the video says.

- As an **OR** arm (the D-320 "larger of two views" pattern) it admits the
  0.98 antonym pair.
- As an **AND** arm it can only reduce recall, and B-198 is a recall bug.

So there is no way to combine it that helps. The model is not in the tree.

### The happy accident

Edit distance ranks these pairs **correctly**:

| pair | lexical | semantic |
|---|---|---|
| negation pair (must NOT group) | 0.843 | 0.946 |
| real span-level retake (must group) | 0.88–0.90 | 0.59–0.77 |

Character-level distance notices that "does not weigh" is three inserted words;
the embedding notices that both sentences are about weighting message parts and
scores them nearly identical. For *this* task the shallower signal is the
better one. `a_negation_ranks_below_a_real_retake_on_edit_distance` pins the
ordering so it cannot quietly stop being true.

---

## 4. The sweep is scoped PER CLIP, and that is a second, separate bug from anything above (B-237, 2026-09-24)

> **FIXED 2026-09-24 by D-364.** Everything below is accurate history and is
> left as it was written — it is the measurement that produced the fix. What
> changed: detection's unit is no longer a clip but a **run** — consecutive
> analysable clips sharing a source file, moving forward through it, separated
> by at most `window_secs` of removed material. `detect_retakes` is called once
> per run over the merged utterance list (the union of the clips' own filtered,
> D-349-spliced views, deduped — so nothing the timeline no longer shows is read
> back in), and a found group's takes are mapped back onto the clips and frames
> they land in, which can be several. The single-clip call widens the same way
> and then reports only the groups touching the clip that was named. The eighth
> case below — the 0.495 technical-term stumble — is **not** fixed and was never
> this bug; it stands as recorded. See **D-364** in `docs/08-decisions.md`.

Everything in §1-3 is about `detect_retakes` itself: given a full list of
utterances, does it group the right ones. This section is about a layer above
it that nobody had measured against a real human edit before — **how the
utterances given to `detect_retakes` get chosen in the first place** — and it
turns out that layer throws away most of the retakes before the algorithm ever
sees them.

**How it was found.** The owner manually re-cut `2026-09-12-c038-mgfx` by hand,
independently of any tool, taking the timeline from a 94-clip/~8:41 automated
cut (silence + retake detection already run) down to a 77-clip/~7:19 cut. The
owner's own words: *"i think the algorithm is broken cant take retakes at all."*
Diffing the two cuts in **source-frame space** (not timeline frames — this
project's timeline had already been ripple-edited twice, so timeline offsets
between the two versions don't correspond to the same material) found **30
additional spans, 96.5 s total**, that the owner cut by hand and
`editor_detect_retakes` had not flagged. See `scratch/` for the working data;
the method was: dump both cuts' clip lists via `get_timeline`, convert
`sourceStart`/`duration` to seconds at the shared source fps, compute the set
difference, then look up each gap's real text in the RAW whole-file transcript
(`editor_get_transcript`, segment-level — **not** `editor_get_timeline_transcript`,
which double-counts a segment once per clip it overlaps and was mistaken for a
"Whisper repeats itself" bug for a good twenty minutes before the raw transcript
ruled that out).

**Root cause, confirmed by direct measurement, not inferred:** `editor_detect_retakes`'s
whole-track sweep calls `resolveRetakeArgs` (`packages/editor/src/useEditorControl.ts`)
**once per clip**, and that function scopes the transcript view to `clipSourceRangeSecs(c, fps)`
— **that one clip's own trimmed source range, and nothing else.** When a clip is
shorter than the utterance it's part of (routine after an earlier fine-grained
silence cut — this project has clips as short as 0.25 s and 0.58 s), the two
halves of a real restart end up in *different* clips' views, and no single call
to `detect_retakes` ever sees both halves at once. A chain needs ≥2 members to
be a group; a view containing only one half can never produce one, regardless of
how good the similarity scoring is.

**Measured, clip by clip**, checking how many *original* clips physically
overlap each real retake's full span:

| case (source time) | clips it spans | shortest clip involved | caught? |
|---|---|---|---|
| "…trick behind used…" → "down. And the trick being used…" (210-230s) | **3** | 0.25s, 0.58s | no |
| "the real reason is this expensive…" restart (426-439s) | **2** | — | no |
| "enormous amount of work…" (528-547s, 3 deliveries) | **5** | 0.71s | no |
| "quick recap," restart (848-868s) | **3** | — | no |
| outro "not just what it can do" (955-987s) | **4** | — | no |
| "grog doesn't build" false start (29-45s) | **3** | — | no |
| "it's expensive for sure…" (309-317s) — **the one retake the sweep DID catch** | **1** | — | **yes** |
| "speculative speculating…speculative decoding" (718-736s) | **1** | — | no (see below) |

Six of seven real multi-clip cases were invisible to the sweep for exactly the
scoping reason above — and the one case the sweep *did* catch is also the one
case whose two takes happen to sit inside a single, less-fragmented clip. That
is not a coincidence; it is the mechanism, confirmed by the fact that flipping
this one variable (single clip vs. several) flips the outcome every time it was
checked.

**The eighth case is a different, harder problem, not this one.** "and the third
one called speculative speculating and the third one's called speculating
speculative" against "speculative decoding okay and the third one call is
speculative decoding and it's kind of clever" sits inside ONE clip — the sweep
genuinely saw both — and scored **0.495** (whole=0.303, containment=0.495)
against the `similarity: 0.82` bar, computed directly with the real
`normalise`/`normalized_levenshtein`/`containment` logic, not estimated. A human
hears one continuous correction of the same term; the algorithm sees two
sentences that only share a few words and diverge everywhere else, because the
speaker didn't repeat the line — they fumbled a two-word technical term three
times *inside* two otherwise-different sentences. This is a real limitation of
"the same LINE again" as the detection model, not a scoping bug, and nothing in
§1-4's toolkit (spans, containment, the rejected embedding model) fixes it —
it would need a genuinely different signal (e.g. scanning for a repeated
*n-gram*, not a repeated *span*). Not solved here; recorded so it isn't
re-discovered as a surprise.

A ninth case, "A few months later, Google did something similar." (84-89s), was
in the owner's cut too but is **not a retake at all** — one clean, non-repeated
sentence with nothing else like it anywhere in the transcript. The owner simply
tightened the pacing by hand. Worth stating plainly: not every frame a human
cuts is something a retake/silence detector was ever supposed to catch, and this
investigation does not claim otherwise.

**~~Not fixed here~~ — fixed by D-364 (2026-09-24),** which is exactly the fix
this paragraph pointed at: merge a contiguous run of clips sharing one source
file back into one utterance view before calling `detect_retakes`, then map any
found group's cut back onto the real clip/frame structure. Implemented in
`packages/editor/src/recutRuns.ts` (pure) and `runTranscriptView` in
`darkRecovery.ts` (the stateful merge). The regression fixture is this section's
own first table row. See **B-237** in `docs/BUGS.md` and **D-364** in
`docs/08-decisions.md`.

---

## 5. Reproducing any of this

Lexical scores and the before/after, no model required:

```sh
cargo test -p apelles-speech --lib retake -- --nocapture
```

The embedding measurements are not reproducible from the tree by design — the
runner was deleted with the decision (CLAUDE.md: no dead code left "just in
case"). To re-derive them, fetch the two pinned artifacts and run upstream's own
reference snippet:

```sh
R=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
B=https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/$R
curl -sLO $B/config.json -O $B/model.safetensors -O $B/tokenizer.json
# AutoModel -> (hidden * mask).sum(1) / mask.sum(1) -> F.normalize -> dot
```

Expected sha256, if the ONNX export is wanted instead of the safetensors:

```
onnx/model.onnx    6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452
tokenizer.json     be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037
```
