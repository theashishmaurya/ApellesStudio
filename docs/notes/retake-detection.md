# Retake detection — what signal actually separates a restart from a different sentence

Worked-out detail behind **D-318** (the detector), **D-320** (edit distance +
containment), and **D-327** (spans, and the embedding model that was measured
and rejected). Fixes **B-198**.

This note exists for one reason: "use a semantic embedding model" is the
obvious, confident, wrong answer to this problem, and the next person to look at
retake detection will think of it within about thirty seconds. It was built,
measured against upstream's own reference implementation, and thrown away. The
numbers are here so that decision does not have to be re-derived.

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

## 4. Reproducing any of this

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
