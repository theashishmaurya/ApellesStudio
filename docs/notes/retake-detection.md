# Retake detection — what signal actually separates a restart from a different sentence

Worked-out detail behind **D-318** (the detector), **D-320** (edit distance +
containment), **D-327** (spans, and the embedding model that was measured and
rejected), **D-364** (detection's unit is a continuous take, not a clip),
**D-365** (the second, repeated-phrase signal) and **D-366** (a glued anchor may
not propose unique content for deletion). Fixes **B-198**, **B-237** and
**B-238**.

Four traps are written down here, because each one costs a day to re-derive
and three of them have already been walked into once:

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
4. **§6 — a correct detection can still propose a wrong cut, and §4 and §5 both
   shipped believing otherwise.** "The group is found" and "the range it offers
   to delete is right" are two claims; only the first was ever measured. The
   detector was proposing 259.8 s of never-repeated speech for deletion across
   the two real transcripts — including one video's own opening hook — while
   every test passed. **When changing this module, measure the proposed cut, not
   just the grouping.**

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
>
> ⚠️ **CORRECTION, 2026-09-25 (B-238 / D-366) — this section's "decisive proof"
> case was right about the detection and WRONG about the resulting cut.** The
> 0.844 match below is real and D-364 did find it. What this section did not
> check, and what nobody checked until the owner asked whether the tool had cut
> anything it shouldn't, is **what the group then proposed to delete**. The
> detector had glued three adjacent utterances into one take to build a
> comparable string, and it offered all three for deletion — including "Today I
> actually want to show you why that's true, what's happening technically that
> makes", which repeats nothing and is not a retake of anything. Read §6 before
> trusting any cut range quoted in this section.

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

> ⚠️ **CORRECTION, 2026-09-25 (B-238 / D-366).** Everything this section measures
> about the *predicate* — the pair scores, the 7,260-pair sweep, the admitted
> lists, the one known false positive — still holds exactly, and the tests behind
> it pass unchanged. What this section reported as a result and did not check is
> the same blind spot as §4's: **the cut ranges the new groups proposed.** The
> phrase arm let the detector glue a three-utterance anchor and match on the last
> of the three, then offer all three for deletion — on this very transcript that
> put the video's own opening hook (the Nvidia / \$20-billion cold open, 2.04–21.02 s)
> inside a proposed cut. Measured across both fixtures, **259.8 seconds of the
> 441.4 s this detector proposed cutting was material that repeated nothing.**
> §6 has the defect, the fix and the new numbers; the counts in §5.4 are the
> predicate's and are unaffected, but the group counts quoted anywhere here are
> superseded by §6.

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

## 6. The glued anchor was proposing unique content for deletion (B-238, D-366, 2026-09-25)

§1–5 are all about **detection** — which utterances belong together. This section
is about the step after it that nobody had measured: **what the group then
proposes to delete.** Both were wrong in the same way, and the direction is the
bad one. A missed retake leaves a stumble in the video. This one silently
proposed deleting speech the speaker only said once.

### 6.1 How it presented

The owner asked, after two sessions of celebrated fixes, whether the tool had
actually cut anything it shouldn't. Diffing a resulting cut against the original
transcript found two cases, and the sweep below then found they were the rule
rather than the exception.

**Case 1 — §4's own "decisive proof" case.** Real `A001_09122319_C038`, #28–#31:

```text
  #28  190.52-190.80  "place."
  #29  204.28-210.26  "Today I actually want to show you why that's true, what's
                       happening technically that makes"
  #30  210.26-222.74  "it so expensive and the trick behind used to bring that
                       cost back down."
  #31  222.74-229.86  "down. And the trick being used to bring that cost back down."   ← keep
```

The detector glued #28+#29+#30 into one 30-word anchor, scored it 0.844 against
#31 — **correctly**, "the trick behind used to bring that cost back down" really
is the same line — and then proposed cutting **190.52–222.74 s**: all three. Only
#30 repeats anything. #29 is a 6-second setup line that shares 0.133 of its
vocabulary with the keeper.

**Case 2 — the same shape through D-365's phrase arm, and worse.** #0–#4:

```text
  #0    2.04-8.52   "In December of last year, Nvidia made the single biggest
                     deal in its entire history."
  #1   14.58-21.02  "$20 billion in cash to license technology from a company
                     called Grok."
  #2   28.82-32.74  "and here's the actually interesting part"
  #4   39.50-44.70  "and here's the actually interesting part grog doesn't build
                     chips for training ai models"                              ← keep
```

Proposed cut: **2.04–32.74 s** — the video's entire cold open. The phrase signal
found the verbatim repeat of "and here's the actually interesting part" and was
right to; the anchor it was attached to carried the hook along with it.

### 6.2 The cause: the overlap guard was on one side of the comparison only

D-327 already knew this failure mode and already had the fix for it — on the
other side. `MIN_UTTERANCE_OVERLAP` (0.5) stops a *candidate* span gluing in an
utterance that shares nothing with the anchor, because otherwise "Sorry, let me
start that again." + "The cat sat on the mat" matches "The cat sat on the mat" at
a perfect 1.00. D-327 deliberately exempted the **anchor** from it, reasoning:

> No overlap guard on the anchor: gluing adjacent utterances into one anchor is
> the entire point […] A junk anchor is self-limiting instead, because nothing
> later will match it and a chain of one take is discarded.

**That reasoning is wrong, and this is the whole bug.** A junk anchor is *not*
self-limiting, because `containment` scores a span by its best matching window
and ignores everything else in it — so a glued anchor matches on one of its
utterances while the rest ride along free, bounded only by the 3× length ratio.
The phrase arm is looser still: it matches on a single shared run anywhere in the
span. And because the group discards each non-kept take **whole**, everything
that rode along was inside the proposed deletion.

Note what is *not* wrong: the matched takes. Those already pass the guard against
the anchor, which is why in real data the over-claiming take is always take 0.

### 6.3 Is the redundant part always adjacent to the match? Measured: yes

The fix's shape depends on this, so it was checked rather than assumed. Over
every group in both real transcripts — 22 groups, 17 of them with a glued anchor:

- **17 of 17** had the redundant material at the anchor's **tail**, adjacent to
  the following take, with the unique content leading. Not one interior gap.
- That is structural, not luck: the chain searches *forward* from the anchor, so
  the delivery it finds is after it, and the anchor utterance nearest that
  boundary is the one that repeats.
- It is not a *guarantee*, so `anchor_is_justified` checks every member
  independently rather than assuming a leading-prefix shape.

The separation is wide. Per-anchor-member word overlap against the union of the
other takes:

| | range |
|---|---|
| genuinely redundant anchor members | **0.600 – 1.000** |
| unique content glued in | **0.000 – 0.500** |

One member, C038's `#66 "one response"` (0.96 s), landed exactly on 0.500 — two
distinct words, one of which incidentally recurs. An overlap *fraction* over two
words can only be 0, 0.5 or 1, so it carries no evidence; a member must also
clear `min_words` distinct words before its fraction is believed. Every
sub-bar utterance in both transcripts is a Whisper sentence-tail fragment
("about.", "place.", "change", "the middle."); the shortest genuinely repeated
one, "So quick recap,", has exactly three.

### 6.4 The fix: the same guard, on the anchor, referenced to the union

`anchor_is_justified` in `crates/apelles-speech/src/retake.rs`. Once a chain
exists, every utterance glued into its anchor must clear `MIN_UTTERANCE_OVERLAP`
against the **union of the other takes** — otherwise the chain is rejected.

Three design calls, each measured rather than asserted:

- **The union, not each take separately.** Whisper distributes a repeated line
  across its own boundaries. C040 #9 ("much to focus on each word you give.")
  scores **0.125** against delivery two and **0.875** against the union, because
  its repeat landed in delivery three. Per-take checking would reject genuine
  glue and break D-327.
- **Reject the chain, don't trim it.** Trimming in place would commit a chain
  starting where the anchor loop has not arrived yet, skipping `better`'s
  comparison of the anchor lengths available there. Rejecting lets the outer loop
  reach the justified utterance and explore it properly. Measured: every genuine
  group is still found, with its anchor now starting at the utterance that
  actually repeats.
- **One constant, not two.** It is the same question asked twice — *does this
  utterance's own vocabulary appear in the line this take claims to be a delivery
  of?* — on the same scale. A second, nearly-identical bar would be arbitrary.

**No output-shape change.** `RetakeGroup` / `TakeSpan` are untouched: takes still
tile `members` with no gaps, `keep` still indexes `takes`, and no consumer reads
`members` positionally. The MCP parity corpus records schema and dispatch against
a stub control server, not detector output, so it needed **no re-capture** — and
both MCP docstrings describe `max_span_utterances` as a ceiling ("may be joined",
"*can* cover several"), so nothing they claim became false.

### 6.5 What it changed, measured

Whole-fixture runs, default params, before and after:

| fixture | phrase | groups | utterances proposed for cut | seconds proposed for cut |
|---|---|---|---|---|
| C038 | on | 11 → **11** | 32 → **14** | 189.16 → **82.78** |
| C038 | off | 5 → **5** | 9 → **6** | 46.42 → **33.16** |
| C040 | on | 11 → **7** | 27 → **15** | 252.28 → **98.78** |
| C040 | off | 7 → **6** | 14 → **10** | 106.70 → **63.72** |

**Headline: across both real transcripts the tool proposed cutting 441.4 s and
now proposes 181.6 s. The 259.8 seconds it stopped proposing — 4m20s, ~16% of the
1,671 s of footage — was material that repeated nothing.** Every group is still
found on C038; every remaining proposed cut on both files was re-read by hand and
is genuinely redundant.

Two count changes deserve their own note, because a dropped group is normally a
recall loss and neither of these is:

- **C040's 11 → 7 with the phrase arm on is mostly groups *merging*, not
  disappearing.** With the junk prefixes gone the chains join up: old groups 0+1
  become one three-delivery group, and 2+3+4 likewise.
- **C040 lost one group outright, and it was a false positive.** The detector had
  glued #47–#49 and matched the verbatim run "in the middle of a long" against
  #51's practical advice ("don't bury it in the middle of a long task"),
  proposing 38 s of real explanation for deletion. §5.4's pairwise sweep never
  saw that pair — #48 ends at 479.60 s and #51 starts at 514.64 s, 35 s apart and
  outside `window_secs`. Gluing the 20-second "the middle." fragment onto the
  anchor's end is what carried the window far enough to reach it. **So the glued
  anchor was not only over-claiming cuts, it was manufacturing matches.**

§5.4's own numbers — the 7,260-pair sweep, the 22 admissions, the one known
false positive `(30, 32)` — are properties of the *predicates* and are unchanged;
those four tests pass untouched, which is the evidence that detection was never
what this fix altered.

### 6.6 What is still not caught

- Everything in §5.6 still stands.
- A take is still a range of **whole utterances** (§2's honest limit). Where the
  redundant material is only part of an utterance, the detector now leaves the
  whole utterance out rather than claiming it — under-cutting, the safe direction
  (D-318).
- `RecutPanel` labels a row "Take N of M" from the detector's take count while
  skipping takes that map to zero frames. Shorter takes make a sub-frame take
  slightly likelier, so that pre-existing mismatch is marginally more reachable.
  Not introduced here and not a correctness bug; noted so it is not rediscovered
  as one.

---

## 7. Reproducing any of this

Lexical scores and the before/after, no model required:

```sh
cargo test -p apelles-speech --lib retake -- --nocapture
```

§5's false-positive sweep over both whole real transcripts — also no model, no
audio and no network, since the fixtures are plain JSON:

```sh
cargo test -p apelles-speech --test real_transcripts -- --nocapture
```

§6's cut-range defect, both ways. The four tests named below assert the correct
proposed cut; to watch them fail the way the pre-D-366 detector did, make
`anchor_is_justified` return `true` as its first statement and re-run — the two
case tests then report exactly the over-claimed ranges quoted in §6.1, while the
three non-regression tests keep passing (which is what makes them non-regression
tests rather than tests of the fix):

```sh
cargo test -p apelles-speech --lib glued_anchor
cargo test -p apelles-speech --lib nothing_proposed_for_deletion_is_unique_content
cargo test -p apelles-speech --lib an_utterance_too_short_to_judge
cargo test -p apelles-speech --lib single_utterance_restart_clusters
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
