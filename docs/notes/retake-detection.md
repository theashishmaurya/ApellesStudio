# Retake detection — what signal actually separates a restart from a different sentence

Worked-out detail behind **D-318** (the detector), **D-320** (edit distance +
containment), **D-327** (spans, and the embedding model that was measured and
rejected), **D-364** (detection's unit is a continuous take, not a clip) and
**D-365** (the second, repeated-phrase signal). Fixes **B-198** and **B-237**.

Three traps are written down here, because each one costs a day to re-derive
and two of them have already been walked into once:

1. **§1-3 — "use a semantic embedding model" is the obvious, confident, wrong
   answer**, and the next person to look at retake detection will think of it
   within about thirty seconds. It was built, measured against upstream's own
   reference implementation, and thrown away. The numbers are here so that
   decision does not have to be re-made.
2. **§4 — even a perfect grouping algorithm catches nothing if the sweep
   calling it never shows it both takes at once.** Found by diffing a real
   human re-edit against the tool's output, not from a synthetic case.
3. **§5 — "the same line again" is only half the question.** The other half is
   the speaker repairing one *phrase* inside two otherwise-different sentences,
   which no whole-string measure can see. §5 is also the honest record of what
   that second signal costs: one measured false positive per 698 real
   utterance pairs, and the class it belongs to.

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
> and then reports only the groups touching the clip that was named. See
> **D-364** in `docs/08-decisions.md`.
>
> **The eighth case below — the 0.495 technical-term stumble — was not fixed by
> D-364 and was never this bug. It is fixed now, by D-365 (§5)**, which added
> the second, repeated-n-gram signal this section's closing paragraph pointed
> at. The text below is left exactly as written: it is the measurement that
> produced both fixes.

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
*n-gram*, not a repeated *span*). ~~Not solved here~~ — **solved by D-365**,
which is exactly the repeated-n-gram signal this sentence guessed at; the
measurement and its cost are in §5. Recorded so it isn't re-discovered as a
surprise.

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

## 5. The second signal: a repeated PHRASE, not a repeated line (D-365, 2026-09-24)

§1-3 are about one question — *is this the same line again?* §4 is about which
utterances that question gets asked about. This section is about a **different
question**, added beside the first rather than replacing it, and about the
measurement that decided its thresholds and disclosed its cost.

It closes the limitation §4 named and left open: its **eighth case**, the
technical-term stumble that sat inside a single clip, was seen by the detector
in full, and still scored 0.495.

### 5.1 The shape the line-level question cannot reach

A speaker does not only restart whole lines. Just as often they repair **one
phrase** inside two sentences that otherwise diverge completely. Real, from
`A001_09122319_C038.MOV`, measured with the real
`normalise`/`normalized_levenshtein`/`containment` code — not estimated:

| # | transcript pair (normalised, elided) | whole | containment | `similarity` |
|---|---|---|---|---|
| 94/95 | "…the third one called speculative speculating…" / "speculative decoding okay and the third one call is speculative decoding…" | 0.303 | 0.495 | **0.495** |
| 67/68 | "that's an enormous amount of repetitive work happening constant…" / "an enormous amount of work happening for every single response…" | — | — | **0.380** |
| 68/69 | "…for every single response for every single" / "risk for every single response for every single user…" | — | — | **0.380** |
| 56/57 | "but the real reason is this expensive is something else entirely…" / "reason it's this expensive the real reason of this being this expensive is" | — | — | **0.299** |
| 117/118 | "corner and subscribe if you want more of this the actual economy…" / "behind AI not just what it can do and subscribe if you want more of this the" | — | — | **0.397** |
| 118/119 | "…and subscribe if you want more of this the" / "actual economy and mechanic and mechanics behind AI not just what it can" | — | — | **0.306** |

Against the 0.82 bar these are **noise, not near misses**. 0.30 is where
genuinely unrelated sentences score (§1's own table has unrelated pairs at
0.13–0.32). No threshold movement reaches them; the material the two sides share
is a *phrase*, and nothing in §1-3 looks at phrases.

### 5.2 The signal, and why it is not the embedding idea wearing a hat

This is the **reparandum / repair** pattern from the disfluency literature
(Shriberg 1994 onward), whose established non-ML detection signal is the **"rough
copy" property**: a repair is a near-verbatim repeat of a phrase from the botched
attempt, even when the surrounding sentence differs. So the unit is a repeated
**word n-gram**.

`crates/apelles-speech/src/phrase.rs` implements one predicate. The longest run
of words occurring contiguously in both sides must be at least
`phrase_min_words` (default 3) long, **and** either carry ≥2 **content**
(non-stopword) words, **or** be *longer* than the bar — in which case its length
is the evidence and it needs no content words at all.

This does not reopen §3. That rejection rests on a model scoring *meaning* and
getting negation backwards; this predicate reports literal repetition and never
infers meaning at all. **But it is not a fix for negation either, and §5.5 says
so plainly** — that is the one claim it would be easy and wrong to make here.

### 5.3 Why those numbers, measured

Every pair of C038's 121 real utterances was swept — all 7,260 — and every
candidate run hand-classified against the transcript text.

**The shortest admissible run: 3 words, 2 content words.** At exactly three
words the content count is the whole separation, and on real data it is clean:

| shared 3-word run | content words | real retake? | admitted |
|---|---|---|---|
| "the real reason" | 2 | yes (#56/#57) | ✅ |
| "inference is everything" | 2 | yes (#41/#42, a false start) | ✅ |
| "so quick recap" | 2 | yes (#105/#106) | ✅ |
| "something else entirely" | 3 | yes (#56/#58) | ✅ |
| "actual economy and" | 2 | yes (#117/#119) | ✅ |
| **"if you want"** | **1** | **no — incidental** (#115/#117, #115/#118) | ❌ correctly rejected |

**The length tier exists for two real cases.** Some genuine repairs repeat a
purely functional phrase — there the marker *is* the function words:

| shared run | words | content | real retake? |
|---|---|---|---|
| "and the third one" | 4 | 0 | yes — #94/#95, the headline case |
| "not just what it can" | 5 | 0 | yes — #119/#120 |
| "not just what it can do" | 6 | 0 | yes — #118/#120 (the outro line, delivered four times) |
| "it s" / "that s" | 2 | 0 | no — rejected by the length floor |

Requiring content words at *every* length loses all three of the first rows,
including the case this whole section exists for.

**The time window: reuse `window_secs`, unchanged, and that is measured too.**
Of the 26 pairs the predicate admits across all 7,260, **20 are inside the 30 s
window and 6 are outside it**. The 6 outside:

| pair | gap | shared run |
|---|---|---|
| 46/112 | **565 s** | "time you send a message to" |
| 30/76 | 378 s | "to bring that cost" |
| 31/76 | 371 s | "to bring that cost" |
| 47/99 | 406 s | "kind of like a" |
| 47/95 | 362 s | "it s kind of" |
| 62/96 | 248 s | "writing every single" |

The nearest is **248 s out — eight times the window** — and the worst of them is
the video's own deliberate bookend ("Every time you send a message to ChatGPT"
at 350 s, "next time you send a message to ChatGPT" at 919 s). That is precisely
what `window_secs` was put there for (§1), so the phrase arm needs no bound of
its own. Pinned by `a_deliberate_callback_is_outside_the_window`.

### 5.4 The false-positive measurement, on two whole real transcripts

A signal whose entire risk is incidental repetition cannot be validated on
curated examples. Both fixtures are the verbatim whole-file output of
`ai-media/transcribe.py` (mlx-whisper large-v3) on the owner's own camera
originals, committed at `crates/apelles-speech/tests/fixtures/` and read by
`tests/real_transcripts.rs`. Both are single-speaker talking heads on one
technical subject each — the hardest possible negative material, because a
16-minute video *about* inference says "inference", "model", "training" and
"cost" constantly.

"Newly admitted" means: the phrase arm says yes **and** the existing
edit-distance arm says no. That is the only set the decision turns on.

| corpus | segments | duration | pairs in window | newly admitted | real retakes | false positives |
|---|---|---|---|---|---|---|
| `A001_09122319_C038.MOV` | 121 | 987 s | 483 | 15 | **15** | **0** |
| `A001_09122356_C040.MOV` | 66 | 684 s | 215 | 7 | **6** | **1** |
| **combined** | 187 | 1,671 s | **698** | **22** | **21** | **1** |

C038's 15, all real, all previously missed: #3/#4 ("grog doesn't build", a
clipped false start), #41/#42 and #41/#44 ("Inference is everything that
it's…"), #43/#45 ("the model actually being used" / "the model being actually
used"), #56/#57 and #56/#58, #67/#68, #68/#69, #94/#95, #105/#106 ("So quick
recap,"), #117/#118, #117/#119, #118/#119, #118/#120, #119/#120.

Four of these — #30/#31, #56/#57, #67/#68/#69, #105/#106, #117-#120 — are rows
of §4's own table of retakes the owner cut by hand and the tool did not flag.

#### The one false positive, in full

From C040, pair **#30/#32**:

```text
  #30  "Every word turns itself into a question."
  #32  "Every other word turns itself into a kind of answer key
        advertising what it's about."
```

Not a retake. Two deliberate, contrasting sentences — the query/key metaphor,
built out of parallel phrasing on purpose — sharing the verbatim run "word turns
itself into a" (5 words, 3 content). **Structurally this is indistinguishable
from a repair**: a long verbatim frame around a changed pivot. What differs is
the speaker's intent, which the text does not carry.

Combinations tried, and why each was abandoned:

| candidate tightening | rejects #30/#32? | cost |
|---|---|---|
| raise content bar to 3 at every length | no (run has 3 content words) | loses "the real reason", "so quick recap", "inference is everything" |
| drop the length tier (always need ≥2 content) | no | loses #94/#95, #118/#120, #119/#120 |
| length tier only when content == 0 | no | ditto — the run has content words |
| cap the content tier's run length at 4-5 | no | loses #68/#69 ("for every single response…", 7 words) |
| require `similarity` below a ceiling (the pair is a near-miss at 0.738-0.771) | yes | loses #41/#42 at 0.794 — a real false start in the same regime |
| require the run at a span boundary (start/end) | yes | loses #56/#57, where the run is mid-sentence on both sides |

Nothing separated them without losing genuine repairs, so it is **accepted,
pinned as a test, and disclosed** rather than tuned away by shrinking the signal
until it stopped being useful. The same class shows up in §3's own synthetic
probe set: "first we will look at what attention **does**" / "then we will look
at what attention **cannot** do" (`similarity` 0.738) is newly admitted too.

What makes it survivable: the detector only ever *proposes* (D-318); a
phrase-matched group reports its genuinely low `similarity`, so it sorts to the
top of anything a reviewer ranks by confidence; the rate is 1 in 698 real pairs
against 21 real retakes recovered; and `phrase_min_words: 0` restores the
pre-D-365 detector exactly, asserted on both corpora.

### 5.5 The correction this pass had to make to §3's reading

It is tempting — and it was nearly written down here — to claim a phrase signal
"solves" the negation problem that killed the embedding model. **It does not.**
A minimal pair differing in one word shares a long verbatim run by construction:

| probe | shared run | phrase arm | existing `similarity` |
|---|---|---|---|
| "…gives that part of your message **less** weight" / "…**more** weight" | "the model gives that part of your message" (8w) | says yes | **0.925** |
| "weighs every part of your message equally" / "does **not** weigh every part…" | "every part of your message equally" (6w) | says yes | **0.843** |
| "this is the **encoder** side of the model" / "…**decoder** side…" | "side of the model" (4w) | says yes | **0.946** |

The phrase arm adds **no new admission** on any of them — and the reason is the
part of §3 that is easy to misread. Those pairs score **above** the 0.82 bar on
plain edit distance, so **the lexical detector has always grouped them**, since
D-320. §3's "MUST NOT group" table was a statement about *ranking* — that the
embedding put negations above real retakes while edit distance put them below —
never a claim that the shipped detector rejects them. Only measuring showed
that. Pinned by `a_negation_minimal_pair_is_not_a_new_admission`.

### 5.6 What is still not caught

- **Parallel construction**, per §5.4 — the one accepted false-positive class,
  and it cuts both ways: a deliberate contrast can be proposed as a retake.
- **A repair with no verbatim repeat at all.** "The model down-weights it" →
  "The model gives it less attention" shares no phrase and scores low on edit
  distance. Neither arm sees it, and nothing text-only will.
- **Word-accurate take boundaries**, unchanged from §2's honest limit: a take is
  still a range of whole utterances, so a boundary falling mid-utterance is left
  out rather than over-claimed.

---

## 6. Reproducing any of this

Lexical scores and the before/after, no model required:

```sh
cargo test -p apelles-speech --lib retake -- --nocapture
```

§5's false-positive sweep over both whole real transcripts — also no model, no
audio and no network, since the fixtures are plain JSON:

```sh
cargo test -p apelles-speech --test real_transcripts -- --nocapture
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
