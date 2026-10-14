# Retake detection — what signal actually separates a restart from a different sentence

Worked-out detail behind **D-318** (the detector), **D-320** (edit distance +
containment), **D-327** (spans, and the embedding model that was measured and
rejected), **D-364** (detection's unit is a continuous take, not a clip),
**D-365** (the second, repeated-phrase signal), **D-366** (a glued anchor may
not propose unique content for deletion) and **D-377** (the cut audit widened to
every raw source and both ASR backends; Whisper stays the default). Fixes
**B-198**, **B-237** and **B-238**; records **B-246** as open.

Five traps are written down here, because each one costs a day to re-derive
and four of them have already been walked into once:

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
5. **§8 — §6's fix was verified on two hand-picked excerpts, so it looked
   finished and was not.** Run over whole transcripts it still proposes speech
   that repeats nothing (**B-246**, 5.42 s on Whisper, 56.92 s on Parakeet), and
   D-365's phrase arm is the entire source of it. Also: a corpus of two
   transcripts of two sources is not a corpus — widening it to twelve raw
   sources found the first Whisper violation on the first source nobody had
   looked at. **A green audit over material the tuning was fitted to measures
   almost nothing.**
6. **§11 — a safety gate's thresholds cannot be tuned on its own refusal
   count.** Every fuzzy setting that accepts more correct cuts also makes
   distinct real words of this corpus "the same word" (`ever`/`never` at 0.8),
   and none of the gate's own three numbers can see that. The measurement that
   set `FUZZY_MATCH` was the corpus vocabulary, not the eval.

§9-§11 cover the labelled eval (**D-378**, **D-379**) and the move of retake
judgement to the MCP client behind a deterministic coverage gate (**D-380**).

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

§8's whole cut audit — the per-source table, the six B-246 cases with their
overlaps, and the silent-source check — the same way, and it prints the table
§8.2 quotes:

```sh
cargo test -p apelles-speech --test proposed_cuts -- --nocapture
```

§8.3's threshold grid is not a committed test: it is the same `audit()` run
under one-parameter-off-default `RetakeParams`, and keeping a sweep that
concludes "change nothing" as permanent test surface would be dead code. To
re-derive it, loop `proposed_cuts.rs`'s `audit` over the variants in the §8.3
table.

The twelve raw sources are the owner's own camera originals and are not in the
repo; the transcripts derived from them are, under
`crates/apelles-speech/tests/fixtures/transcripts/`. A fixture is the
`[start, end, text]` reduction of `transcribe.py`'s own output — every segment,
its `start`/`end` rounded to 0.01 s, nothing dropped — so re-deriving one is the
sidecar's ordinary CLI plus that projection:

```sh
ai-env/.venv/bin/python ai-media/transcribe.py --audio <source>.MOV \
  --language en [--backend parakeet] --output /tmp/full.json
python3 -c 'import json,sys; b=json.load(open("/tmp/full.json")); \
  json.dump([[round(s["start"],2),round(s["end"],2),s["text"]] for s in b["segments"]], \
  sys.stdout, indent=1)'
```

Both backends need the audio: `ai-env/.venv` carries `mlx-whisper`, and
`parakeet-mlx` is in `ai-media/requirements.txt` but deliberately **not** in
`ai-env/requirements.lock.txt` (see `asr-backends-and-harness.md` §4.1), so a
Parakeet run needs it installed into that venv or a venv of its own.

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

---

## 8. The cut audit, widened to every raw source and both ASR backends (D-377, B-246, 2026-10-10)

This section is **D-374 step 4** — "re-run `apelles-speech`'s corpus against a
Parakeet transcript, re-sweep the retake thresholds, and decide the default on
the numbers." It is also §6's own trap walked into a third time, which is why it
is written down rather than summarised.

### 8.1 What the corpus was, and why two transcripts was not enough

Every number in §4-§6 comes from **two** transcripts of **two** sources, both
`mlx-whisper large-v3`. That is a 1,671 s corpus of single-subject explainers,
and four sessions of tuning were fitted to it. So all twelve of the owner's raw
camera originals (43 minutes) were transcribed with **both** backends — cheap
now that one of them runs at 25.8× realtime.

Nine turned out to be **silent B-roll** — room tone at −47 to −65 dBFS mean,
camera rolling, nobody talking. A source with no speech cannot have a cut
proposed against it, so those nine pass any cut audit **vacuously**, and a
vacuous pass is exactly how B-238 kept surviving. They are listed once and
excluded from every number below. The corpus that decides anything is three
sources:

| source | duration | mean dBFS | segments (whisper / parakeet) | in the corpus before? |
|---|---|---|---|---|
| `A001_08302215_C019` | 517 s | −18.4 | 83 / 45 | **no — new here** |
| `A001_09122319_C038` | 989 s | −25.1 | 121 / 87 | yes (§4, §5) |
| `A001_09122356_C040` | 686 s | −25.5 | 66 / 58 | yes (§1, §6) |

**C019 is the whole value of the widening**: 517 s of real speech, the loudest
of the twelve, a prompt-caching explainer, never once seen by this detector —
and the only source where *Whisper* over-claims a cut.

**The nine silent ones do say one thing, and it is about Whisper.** Parakeet
emits nothing on them. Whisper emits `"Thank you."` (and one `"All right."`) —
**nine phantom utterances across five of the nine sources**, the familiar
Whisper-on-silence artifact. Two are a *verbatim* repeat inside `window_secs`:
C030's `"Thank you."` at 0.00-2.70 s and 30.00-30.76 s, 27.3 s apart, similarity
**1.000**. The only thing stopping the detector proposing a cut of a phantom is
`min_words: 3` — `"thank you"` is two distinct words. **That is a measured reason
never to lower `min_words`**, and it is pinned by
`proposed_cuts.rs::the_silent_sources_are_not_a_test_of_the_cut`.

### 8.2 The measurement, and the number the decision turned on

Not "does it find the retakes" — §4-§6 established that is the easy half and the
one that keeps getting measured instead of the hard one. **§6's own method,
applied to every proposed cut**: `word_overlap` of the material being cut
against the take the group recommends keeping, with `MIN_UTTERANCE_OVERLAP` as
the bar. Two readings, because they need different fixes:

| | vs the keeper | vs the union of the other takes | what it is |
|---|---|---|---|
| **straddled** | < 0.5 | ≥ 0.5 | repeats *another discarded take*, not the keeper — the ASR boundary fell mid-repetition. Accepting the group still loses it |
| **repeats nothing** | < 0.5 | < 0.5 | **B-238 itself. Unfixed.** |

| source | backend | groups | cut utterances | proposed | absent from keeper | **repeats nothing** |
|---|---|---|---|---|---|---|
| C019 | whisper | 7 | 9 | 56.32 s | 18.14 s | **5.42 s** (1) |
| C019 | parakeet | 7 | 9 | 44.24 s | 27.20 s | **27.20 s** (2) |
| C038 | whisper | 11 | 14 | 82.78 s | 27.44 s | 0.00 s |
| C038 | parakeet | 10 | 14 | 82.28 s | 25.88 s | **25.88 s** (2) |
| C040 | whisper | 7 | 15 | 98.78 s | 43.82 s | 0.00 s |
| C040 | parakeet | 10 | 16 | 91.84 s | 3.84 s | **3.84 s** (1) |
| **whisper total** | | **25** | **38** | **237.88 s** | **89.40 s** | **5.42 s** |
| **parakeet total** | | **27** | **39** | **218.36 s** | **56.92 s** | **56.92 s** |

**The deciding number is 56.92 s against 5.42 s.** Parakeet finds *more* groups,
proposes *less* in total, straddles *less*, and is 10× faster — and 26 % of
everything it offers for deletion repeats nothing at all, against Whisper's
2.3 %. Over-cutting is the direction D-318 rules out.

**The cause is segment length, not transcription quality.** A take is a range of
**whole utterances** (§2's honest limit). When only an utterance's *tail*
repeats, the whole utterance is cut, and Parakeet's mean segment is 11.4-11.8 s
against Whisper's 6.2-10.4 s. Its five cases are 14.96, 12.24, 11.36, 14.52 and
3.84 s; Whisper's one is 5.42 s. The worst:

```text
  C019 parakeet #14  162.84-177.80  (14.96 s, overlap 0.156)
    "changes. That's you pointing at this stack and saying everything above the
     line keeps it warm. Get that order right and the number stop being
     abstract. Let's actually go to the maths. Writing the notes into the"
  keeper #18  195.56-203.80
    "Writing the notes, writing those notes into the cache the first time costs
     you about 25% more than a normal red"
```

Six words at the end repeat. Fifteen seconds get proposed for deletion.

### 8.3 The threshold sweep: nothing moves, and that is the finding

All three speech sources, both backends, one parameter off default at a time.
`UNIQUE` is the §8.2 verdict column.

| | whisper: groups / cut s / **UNIQUE** | parakeet: groups / cut s / **UNIQUE** |
|---|---|---|
| **default** (0.82 / 3 / 3 / 3) | 25 / 237.88 / **1 — 5.42 s** | 27 / 218.36 / **5 — 56.92 s** |
| `similarity` 0.85 | 25 / 237.88 / 1 — 5.42 | 27 / 218.36 / 5 — 56.92 |
| `similarity` 0.88 | 25 / 237.88 / 1 — 5.42 | 27 / 218.36 / 5 — 56.92 |
| `similarity` 0.90 | 27 / 244.68 / **2 — 20.94** ← worse | 27 / 218.36 / 5 — 56.92 |
| `similarity` 0.95 | 26 / 249.02 / 2 — 20.94 | 27 / 218.36 / 5 — 56.92 |
| `min_words` 4 | 24 / 234.82 / 1 — 5.42 | 26 / 214.48 / 5 — 56.92 |
| `min_words` 5 | 24 / 234.82 / 1 — 5.42 | 26 / 213.96 / 5 — 56.92 |
| `min_words` 6 | 23 / 226.90 / 1 — 5.42 | 25 / 212.36 / 5 — 56.92 |
| `min_words` 8 | 19 / 205.90 / 1 — 5.42 | 23 / 190.84 / 4 — 53.08 |
| `max_span_utterances` 1 | 29 / 233.14 / 2 — 20.94 | 27 / 209.40 / 5 — 56.92 |
| `max_span_utterances` 2 | 25 / 237.88 / 1 — 5.42 | 27 / 217.20 / 5 — 56.92 |
| `phrase_min_words` 4 | 22 / 208.90 / 2 — 11.48 | 26 / 207.00 / 3 — 38.12 |
| `phrase_min_words` 5 | 20 / 196.14 / 2 — 10.90 | 24 / 184.68 / 2 — 26.76 |
| `phrase_min_words` 6 | 17 / 174.34 / 1 — 5.48 | 24 / 155.28 / 1 — 12.24 |
| **`phrase_min_words` 0** | 13 / 106.22 / **0 — 0.00** | 16 / 96.36 / **0 — 0.00** |

Three things fall out, and none of them is a threshold change:

- **`similarity`, `min_words` and `max_span_utterances` cannot reach it.** They
  govern *whether* a pair matches; none governs how much unrelated speech rides
  along once it does. Raising `similarity` to 0.90 makes Whisper **worse** —
  it breaks a three-take group into two, and a take that was straddled becomes
  one that repeats nothing. `min_words` 8 costs six of Whisper's 25 groups to
  remove nothing.
- **`phrase_min_words: 0` zeroes it on both backends** — so **D-365's phrase arm
  is the entire source of the over-claimed cut**. That arm was validated by
  sweeping 7,260 *pairs* (§5.3-§5.4) and never by looking at a resulting cut: it
  admits pairs whose redundancy is a sub-utterance phrase, which the
  whole-utterance take model then cannot express. §6's trap, one level up. It is
  not turned off: it costs 12 of Whisper's 25 groups, including every case §5
  exists for.
- **`min_words` must not go down**, per §8.1's phantom `"Thank you."`.

**So no default moves, and the defect is recorded as B-246 rather than tuned
away.** The real fix is to apply `MIN_UTTERANCE_OVERLAP` to single-utterance
takes as well (D-366 exempted them, and all six violations are single-utterance
takes) — which moves the group counts the five corpus tests pin, so it is its
own pass with its own recall measurement.

### 8.4 The one thing that could not be verified

Re-transcribing C038/C040 with `mlx-whisper large-v3` today does **not**
reproduce the committed fixtures: **126 segments against 121, and 83 against
66.** Unexplained. The fixtures predate D-349's MLX seeding (B-224), so they may
be from an unseeded run, and nothing records the `language` they were captured
with; these runs used `language="en"`. They were **not** replaced — §5's four
tests are hand-classified against those exact files.

Both re-derived transcripts are committed beside them and audited separately.
They propose **more** (19 and 22 cut utterances against 14 and 15; 87.80 s and
123.00 s) and still **0.00 s that repeats nothing**. So Whisper's zero holds
across two different segmentations of the same two sources, which is what makes
§8.2 a measurement rather than a property of one fixture vintage.

---

---

## 9. A labelled eval, and what it says about §8 (D-378, 2026-10-13)

§4, §6 and §8 each ended with a green number that measured something adjacent to
the cut. §8's is the best of them and is still a proxy — `word_overlap` per
proposed utterance, no ground truth — so it cannot measure recall, which is
exactly what B-246's fix is blocked on. **`eval/retake/` is the ground truth**,
and `crates/apelles-speech/tests/retake_eval.rs` scores the real detector
against it. The spec (label schema, labelling rules, every metric) is
`eval/retake/README.md`; this section is the finding.

### 9.1 What was labelled

Three real sources, labelled in **source-audio seconds** from the text of two
(C019) or three (C038, C040) independent ASR readings, never from detector
output — 6, 13 and 9 retake groups; 40.1 s, 114.1 s and 133.8 s of redundant
speech; 3, 3 and 3 protected ranges naming the material past defects proposed
deleting. Nobody listened to the audio; bounds resting on one reading or on a
word-position estimate are flagged `approximate_*`. Eight tasks (each backend's
transcript of each source, plus the re-derived Whisper pair §8.4 committed) and
four synthetic controls.

### 9.2 The first run

| task | over-cut | of it protected | retake recall | group recall |
|---|---|---|---|---|
| C019 / whisper (re-derived) | 23.32 s | 6.18 s | 0.778 | 0.833 |
| C019 / parakeet | 26.64 s | 21.16 s | 0.421 | 0.833 |
| C038 / whisper (pinned) | 13.16 s | 0.00 s | 0.606 | 0.846 |
| C038 / whisper (re-derived) | 17.86 s | 0.00 s | 0.609 | 0.846 |
| C038 / parakeet | 16.00 s | 10.54 s | 0.568 | 0.846 |
| C040 / whisper (pinned) | 23.92 s | 0.00 s | 0.552 | 0.778 |
| C040 / whisper (re-derived) | 29.10 s | 0.00 s | 0.695 | 0.778 |
| C040 / parakeet | 3.84 s | 3.84 s | 0.653 | 1.000 |

**Every corpus task fails the over-cut gate.** Every charged range was checked
by hand against the detector's own groups, and every one is real speech lost —
three shapes:

1. **The take repeats nothing in its group** — §8.2's six, all present.
2. **The kept take is a fragment.** §8.2's "straddled" row, worst case: the
   group keeps a take holding part of the line and cuts every complete delivery
   of the rest. C040's recap keeps *"by matching each word's query against every
   other word's key"* and cuts both *"So, quick recap. Attention is the model
   deciding how much to focus on each part of what you said"*. Recency picks
   `keep`, and the most recent take is not always a whole one.
3. **`word_overlap` waves unique speech through.** An utterance half made of
   shared function words, or carrying a shared tail, clears 0.5 while its head is
   said once: C019 Whisper #37 loses *"about an 80% cut from one structural
   change"* that way. §8's audit cannot see this; it is the measurement's own
   blind spot, not a new detector behaviour.

Two scorer rules came out of checking those ranges, both measured (README): the
survivor is chosen by smallest cut **fraction**, because ranges carry their
pauses; and a **0.75 s boundary tolerance**, the largest timing disagreement
between two readings of one boundary on this corpus, reported as its own column.

### 9.3 What it does to §8's decision

On content lost, one transcript per source: **Whisper 60.40 s, Parakeet
46.48 s.** On *protected* content: **6.18 s vs 35.54 s.** §8.2's 10.5× came
from counting shape 1 only, which is where Parakeet's long segments hurt most;
shapes 2 and 3 fall harder on Whisper. Neither backend is clean and neither
number alone is the decision — so D-377 is marked `revisit`, and the default
stays Whisper until B-246's fix pass re-decides it on this eval. That pass must
read its result here, not in `proposed_cuts.rs`: `MIN_UTTERANCE_OVERLAP` on
single-utterance takes would clear shape 1 and leave 2 and 3.

---

## 10. The judgement moves to the MCP client: the POC, and the eval fixed to judge it (D-379, 2026-10-13)

§9's eval failed every task on both backends, and the failures were judgement
calls string matching cannot make: is this the same line, which take is
complete, where exactly does the repeat end. So the owner asked for the
judgement to come from a model, and chose the **MCP client** — the LLM the user
already connects — over an on-device decision model (Laya / Jev: 512-token
context, fixed-answer outputs with no cut points, ~0.36 untrained, Jev
cloud-only).

### 10.1 The POC

Nine fresh agents, no context: Claude Opus ×2 and Sonnet ×1 for each source,
each handed **one anonymised Parakeet transcript as numbered words with their
times** and one fixed prompt ("find every retake; keep the complete take; a
deleted take may contain only words whose content survives in the kept one;
boundaries may fall mid-segment; when unsure, leave it out"), answering with
word-index ranges + a keep. Code converted indices to seconds exactly from the
word times. Parakeet's word timestamps came from re-running `transcribe.py
--backend parakeet` on the three sources: 37 s for C038's 989 s, and the output
was segment-for-segment identical to the committed fixtures.

### 10.2 What the first scoring got wrong, and the fix

On §9's labels the clients lost 29-34 s — and every charged range was a
correct stutter cut: *"A few months later, a few months later"*, *"on the final
bin, on the final bill"*, *"they bundle it with a, they bundle it with"*. §9's
labels left any repeat a whole segment could not isolate as unique content,
because the detector could only cut whole segments. D-379 relabels every repeat
at word precision, adds nested groups for a stutter inside a kept delivery, and
adds an external-proposals mode to the scorer (README).

### 10.3 The result

| on the word-precise labels | content lost | protected lost | tasks passing | retake recall C019 / C038 / C040 |
|---|---|---|---|---|
| detector (Parakeet) | 40.24 s | 37.44 s | 0 / 3 | 0.265 / 0.523 / 0.606 |
| Opus run 1 | **0.00 s** | 0.00 s | 3 / 3 | 0.585 / 0.733 / 0.742 |
| Opus run 2 | **0.00 s** | 0.00 s | 3 / 3 | 0.605 / 0.745 / 0.717 |
| Sonnet | **0.00 s** | 0.00 s | 3 / 3 | 0.567 / 0.720 / 0.725 |

Not one second of unique speech proposed for deletion across nine runs, the
kept take matching the label every time, and the runs agreeing with each other
closely. Recall is ~0.57-0.75: the clients skip what they are unsure of, as the
prompt tells them to — the right failure direction for D-318. The limits are in
D-379: three videos, one speaker, nobody listened.

---

## 11. The coverage gate (D-380, 2026-10-13)

§10's POC moved the *judgement* out of the app. What stays in the app is
mechanical and deterministic: `crates/apelles-speech/src/proposal.rs`, measured
by `tests/retake_eval.rs` against `eval/retake/` (`gate_baseline.json` pins
every number below).

### 11.1 What the app does

1. **Render** — `index_transcript` + `render_indexed` print the word view a
   client reads: a two-line legend, then `--- segment N  S-E` and
   `index<TAB>S-E<TAB>word` lines. Below the legend it is byte-identical to the
   files the nine POC clients read (`client_runs/input/`), golden-tested, so
   the POC's numbers are numbers about the app's real input. Words go to a
   segment by **start time** (the first segment, scanning in order, whose end
   they start before): that is the segment's own word list except Parakeet's
   zero-length phrases stamped on a segment end (C019 326.60 s, C038 330.84 s),
   which go with the speech after them — the POC's rule, reproduced exactly.
2. **Convert** — an accepted group's deleted takes become `CutRange`s: one per
   run (segment × clip) the take crosses, each edge pushed out by at most
   `EDGE_PAD_MAX_SECS` = 0.32 s (one maximum-length TDT token, D-376) and never
   past the midpoint of the gap to the neighbouring word or across a run
   boundary. Measured cost of the padding: the oracle, resolved and scored,
   loses **0.00 s**. Its price is the other way: a take spanning two segments
   leaves the inter-segment pause uncut (silence is `silence.rs`'s job).
3. **Refuse** — the gate, below.

### 11.2 The gate

Structural refusals first (bad indices, `first > last`, < 2 takes, bad `keep`,
overlapping takes), then cross-group conflicts in the order given: a deleted
take may not overlap an earlier-accepted group's kept take, nor a kept take an
earlier group's deletion — **unless** one group lies wholly inside the other's
kept take. That is the nested stutter (C038's outro keeps `"... and mechanics
and mechanics ..."`; a second group cuts one copy). It is allowed in either
order, and only if the outer group's deleted takes still pass the content rule
against its keeper *less* the nested cut (`StarvesContainer` otherwise).

Then **the content rule**, per deleted take against the kept take: align the
`retake::normalise` token sequences by LCS (a match is equality, or both
≥ 4 chars and `normalized_levenshtein ≥ FUZZY_MATCH`), and account for every
unaligned token:

| | forgiven when | counts toward the run limit |
|---|---|---|
| F1 | a stopword (`phrase.rs`'s list, shared, not copied) | no |
| F2 | a filler: um, uh, er, erm, ah, hmm, mm | no |
| F3 | a proper prefix of the next deleted token or of a kept token (`"the str"` / `"the structure"`) | no |
| F4 | equal to a deleted token the alignment used (a stutter or a looped phrase) | no |
| F5 | matches some kept token, out of order | **yes** |

Any content token forgiven by none of them refuses the take
(`ContentAbsentFromKeptTake`), and `MAX_UNALIGNED_CONTENT_RUN` consecutive
run-counting tokens refuse it even when each is forgiven alone
(`UnalignedContentRun`). A refusal carries the offending word indices.

F4 differs from the brief that specified this module ("equal to the *previous*
token"), by measurement: that version refused three correct oracle groups —
C038's `"inference is everything that's … inference is everything"`, C040's
`"every word turns into every word turns into itself"` and `"while constantly
while constantly the encoder builds …"` — as out-of-order content, and since the
LCS may align either copy of a repeat, "previous" was order-dependent besides.

**Why not `word_overlap`:** it forgives a *fraction* of unique words by
construction (B-246 shape 3, §9.2). This gate forgives none outside the table.
**What it cannot do:** hear. A word the ASR mis-heard in the flubbed take is,
to the gate, a word said once — which is §11.4's whole recall cost. And
stopwords (`not`, `no`, spoken numbers among them) are forgiven unconditionally.

### 11.3 The sweep

Oracle = the labels' own answer (every non-keeper delivery cut, mapped to words
by midpoint; 46 groups, nested ones included; C038's first `"So quick recap,"`
is in a Whisper reading only and is left out). Detector = `detect_retakes`'s
Parakeet groups mapped the same way, each judged alone; 6 of them are charged
over-cut by the eval. POC = the nine committed client runs, gated.

| fuzzy | run 2: oracle / POC refused | run 3, 4, ∞: oracle / POC refused | detector over-cutters accepted | uncharged detector groups refused |
|---|---|---|---|---|
| 0.60 | 10 / 26 | 10 / 24 | 0 | 5 |
| 0.65 | 11 / 32 | 11 / 30 | 0 | 5 |
| 0.70 | 12 / 35 | 12 / 33 | 0 | 5 |
| 0.75 | 12 / 35 | 12 / 33 | 0 | 5 |
| 0.80 | 14 / 41 | 14 / 39 | 0 | 6 |
| 0.85 | 17 / 48 | 17 / 48 | 0 | 7 |
| **0.90** | 17 / 48 | **17 / 48** | **0** | 7 |
| exact | 17 / 48 | 17 / 48 | 0 | 7 |

Gated over-cut is 0.00 s for the oracle, the detector and every POC run in
every cell. So these three numbers alone say "lower the fuzzy bar" — and that
is exactly the trap: the over-cut a loose bar causes is a *different word*
accepted as the same, which neither the oracle (no different words) nor the
detector's over-cutters (whole unique phrases) contains. Measured on the
corpus's own vocabulary instead — the 617 distinct ≥ 4-char tokens of the three
transcripts — distinct-word pairs matching at each bar: **767 at 0.6, 227 at
0.7, 103 at 0.8** (`ever`/`never`, `changing`/`unchanging`,
`difference`/`inference`, `anything`/`nothing`), **30 at 0.85**
(`content`/`context`, `billions`/`millions`, `deciding`/`decoding`), **0 at
0.9**; the most similar distinct pair is `generated`/`generates`, 0.889.

**Chosen: `FUZZY_MATCH` = 0.9** — the loosest bar at which no two different
words of this corpus match; the arm then forgives only near-identical spellings
of long words. **`MAX_UNALIGNED_CONTENT_RUN` = 3** — the strictest value that
costs nothing at any fuzzy setting (2 refuses two more POC groups at ≤ 0.8); at
0.9 it decides no verdict on this corpus, so it stands for the shape its unit
test builds, not for a measured case. Reproduce:
`APELLES_RETAKE_GATE_SWEEP=1 cargo test -p apelles-speech --test retake_eval coverage_gate_sweep -- --nocapture`.

### 11.4 The three pinned numbers

1. **Oracle: 17 of 46 correct groups refused.** Every one is a cut-take word
   the keeper does not literally hold — a mis-heard or mis-said word in the
   flubbed delivery (`type`/`time`, `bin`/`bill`, `masses`/`message`,
   `query`/`square`, `published`/`builds`), an inflection (`chips`/`chip`,
   `agents`/`agent`, `processes`/`process`, `speculating`/`speculative`,
   `mechanism`/`mechanics`), or words said only in the abandoned attempt that
   the labels count as part of the retake (`never`, `repetitive … Constantly`,
   `Attention. In simple terms,`).
2. **Detector: 0 of its 6 over-cutting groups accepted**, and 7 uncharged ones
   refused as well; its gated over-cut is **0.00 s** (ungated: 40.24 s).
3. **The nine POC runs, gated: 0.00 s lost in every run.** Refused per run: 5 /
   7 / 4 groups on C019 / C038 / C040. Retake recall:

| run | C019 | C038 | C040 | ungated (D-379) |
|---|---|---|---|---|
| Opus run 1 | 0.407 | 0.291 | 0.309 | 0.585 / 0.733 / 0.742 |
| Opus run 2 | 0.427 | 0.303 | 0.309 | 0.605 / 0.745 / 0.717 |
| Sonnet run 1 | 0.388 | 0.298 | 0.303 | 0.567 / 0.720 / 0.725 |

Every task now misses its recall check (0 / 3 pass), on recall alone — no gate
fires.

### 11.5 What it means for the next step

The gate is safe on every measurement here and **expensive**: it refuses about
a third of correct groups and roughly halves the clients' recall, almost
entirely for words it cannot hear. Two things follow for the app + MCP pair
(D-380 step 2), neither done here:

- a refused group should reach the human as an **unverified** proposal with its
  offending words, rather than vanish — the human can hear, the gate cannot;
- the client can be told *why* (the refusal names words), so it can narrow a
  take to exclude a trailing abandoned word and resubmit. Whether an inflection
  rule (`chip`/`chips`, roughly four of the seventeen) is worth its risk is a separate,
  measurable question for the same eval.

---

## 12. The app + MCP pair: the client's loop, the app's tools (D-380 step 2, 2026-10-14)

§11 built the core; this section is what an MCP client and a person actually
use. **"The AI" here is always the MCP client** (Claude, or any other). The
app runs no model and makes no judgement anywhere in this feature: it renders
words, runs the deterministic gate, re-runs the ASR it already runs, and stores
and shows what the client decided.

### 12.1 The tools (both `mcp/server.py` and `crates/apelles-mcp`)

| tool | what the app does |
|---|---|
| `editor_get_word_transcript {track, offset?, max_words?, start?}` | builds the track's word view and serves a page: `text`, `viewId`, `totalWords`, `nextOffset`; on offset 0 also `instructions` |
| `editor_propose_retakes {track, view_id, groups}` | refuses a stale `view_id`; runs each group through the gate (the client's `confirm` words as waivers); stores the reviewed set for the Recut panel; answers each group's status, reason, offending words and frame `segments` |
| `editor_retranscribe_words {track, view_id, first, last, apply?, force?}` | re-reads that stretch of audio in isolation (the D-349 recovery's windowed pass); a preview by default, `apply: true` splices it into the transcript |

Nothing is cut by any of them. Cutting is `editor_ripple_delete_ranges` (the
client, when the user asks — every `segments` entry of every non-kept take is
already in its form) or the Recut panel's Cut (the person). Tauri side:
`app/src-tauri/src/chroma/retake_proposals.rs` (`chroma_retake_word_view`,
`chroma_check_retake_proposals`); op layer: `packages/editor/src/
retakeProposalOps.ts`, `retakeProposals.ts`, `retakeWordView.ts`.

### 12.2 The view of a track

A track is a list of clip windows onto source transcripts. `retakeWordView.ts`
decides only the timeline facts — which clips (`sweepTargets`, the same set the
sweep and `editor_detect_retakes` cover), in play order, onto which window of
which file — and sends each source's spliced transcript once plus one window
per clip. **The word rules are the crate's** (`index_pieces`): a word belongs
to the clip holding its midpoint (the splice's rule, so a word straddling a
cut is in exactly one of two abutting clips); runs are offset per clip, so the
gate never pads one clip's cut toward another's word; and one window over a
whole source is exactly `index_transcript`, so a one-clip, untrimmed track's
view is byte-identical to the POC input (`a_one_clip_track_view_is_the_pocs_input`).
A TypeScript copy of those rules would let the client read one view and the
gate judge another.

**Paging.** Claude Code caps a tool result at ~25k tokens; a word line is ~6-8.
2500 words a page (max 4000), indices global, the legend only on page one.

**`viewId`** = the first 16 hex of blake3 over the whole rendered view plus
each window's path and range. Every page of one view shares it; any change to
what an index means (an edit, a newly landed transcript, an applied re-read)
changes it. `editor_propose_retakes` and `editor_retranscribe_words` refuse a
stale one outright — mapping old indices onto new words is exactly the silent
over-cut D-318 forbids. The view is only served whole: while any source on the
track is still being transcribed the tool answers `transcribing`, because the
indices would shift when it lands.

### 12.3 The served instructions — a tool field, not MCP prompts

The rules are `JUDGING_RULES`, the POC prompt's judging block **verbatim**
(pinned to `eval/retake/client_runs/prompt.md` by
`the_served_rules_are_the_pocs_prompt`), wrapped by `retakeInstructions` in
how to answer in Apelles and how to resolve a refusal. They ride on the first
page as `instructions`. MCP prompts were considered and not used: a prompt is
something a *user* invokes (Claude Code surfaces them as slash commands), it is
never handed to the model unasked, and neither server exposes prompts today —
so a client that just calls the tool would judge without the rules that
produced D-379's 0.00 s. A field on the page the client must read anyway cannot
be skipped. A Claude skill wrapping the loop is a later phase.

### 12.4 The refusal loop — the client's, not the app's

The gate refuses about a third of correct groups (§11.4), nearly all for a
word it cannot hear. The owner's call (2026-10-13): the client resolves each
refusal itself, iterating until it is resolved or dropped:

1. **Narrow** — offending words that are unique speech the take swallowed go
   outside the take; resubmit.
2. **Re-transcribe** — an offending word that looks misheard (`type`/`time`,
   `bin`/`bill`): `editor_retranscribe_words` over the stretch. The window is
   the words ± 2 s with each edge moved off any word it would cut in half (the
   splice replaces by midpoint), one source file, at most 60 s. The answer puts
   `current` (the view's words, with indices) beside `reread`; `identical`
   says whether the re-read heard anything different. Nothing changes until
   `apply: true`.
3. **Confirm** — resubmit the group with `confirm: {index: reason}` for every
   offending word. The gate re-judges it with those words waived
   (`check_and_resolve_waived`): only the content rule's two refusals are
   waivable, a waiver never downgrades a group the gate verified, and a group
   that passes only with waivers is `Confirmed`, listing the waived words —
   stored as **`ai_confirmed`**, distinct from gate-`verified`.
4. **Drop** — when still unsure (rule 4). An unresolved group stays `refused`
   and is still shown to the person.

**Does an applied re-read update the transcript? Yes — one source of truth.**
An applied re-read joins the file's splice list after the dark-region
recoveries, in the order applied, and `spliceTranscript` now applies windows in
order, a later window replacing whatever earlier words it holds by midpoint
(for D-349's disjoint windows this is the old one-shot splice exactly). So the
Transcript panel, `editor_get_timeline_transcript`, `editor_detect_retakes` and
the word view all read the corrected words — even with dark-region recovery off
(`clipTranscriptView`'s raw view includes them). The alternative, a re-read
only the proposal saw, would have the gate judging words no other surface
shows: two transcripts of one file. The price is designed in: applying changes
the `viewId`, and the answer returns the new id, the window's words with their
new indices and `indexShift` (how far every later index moved), so the client
re-derives instead of re-reading everything. A re-read is a preview first
because an ASR re-read can also be *worse*; the client decides, not the app.
Re-reads use the sidecar's default backend (the one the whole-file transcript
came from), pin its language, are cached by window like recoveries, and
`clear(path)` drops them.

### 12.5 The person's side — the Recut panel

Researched first (`scratch/retake-review-reference/README.md`): Descript's
filler-word review is a sidebar list, one row per hit with its timestamp and a
per-item choice; its Underlord edits show removed text struck through for review
before "Remove ignored text"; Premiere's text-based editing highlights each
pause/filler for individual review, with a "Delete All" its own users call
risky, and deletes by Extract (ripple). Neither says *why* a take was chosen or
flags an unsafe one.

So the client's groups join the panel's **one** review list (store slice
`retakeProposals`, written by `editor_propose_retakes` — the panel's own rows
were component state nothing outside could feed): one row per take, unticked,
the keeper marked, a status badge — **verified**, **AI-confirmed** (the AI's
per-word reasons shown, the vouched words marked in the take's text), or
**refused** (reason and offending words shown, checkbox disabled). A content
refusal can be unlocked by a person who has listened ("I listened — let me tick
it"): the gate cannot hear, a person can; the cut is then the gate's own
`would_cut` resolution. "Tick all suggested" takes detector rows and *verified*
client rows only — never an AI-confirmed or refused take in bulk. One Cut, one
`ripple_delete_ranges`, one undo, and the applied proposals are cleared (their
indices described the old timeline). When the timeline moves after the client
read it (`viewBasisKey`, the view's inputs, recomputed on every change) a banner
says "the timeline changed since the AI read it — ask it to re-read" and the
rows lock.

### 12.6 The deterministic detector behind the same gate (D-382)

`editor_detect_retakes` and the panel's Retakes button still run `retake.rs`
unchanged, and then each detection's groups go to
`chroma_gate_detected_retakes` (`detectorGate.ts`): each take (its source
seconds) is mapped onto the same track view by word midpoint
(`take_from_span`, restricted to that source's words), a take holding no word
is dropped, a group left with fewer than two takes or without its keeper is
`unmapped`, and the rest are judged together, in the detector's order, with no
waivers. An unmapped group — or any group when the gate cannot run — is
reported **refused** ("not checked"), not verified: D-318's direction. Each
group then carries `status` in the client vocabulary, and the panel treats a
refused detector row exactly like a refused client row (reason, marked words,
locked until a listener unlocks it, never bulk-ticked).

Measured (`eval/retake/` `C0xx/parakeet-gated`, README table): over-cut 24.40 /
12.64 / 3.20 s → 0.00 s, precision 1.000, recall roughly halved (0.161 /
0.189 / 0.232), 13 of 27 groups refused. B-246 is mitigated, not fixed — the
grouping that forms the over-cutting groups is unchanged.

### 12.7 Not done here: the live smoke (for the coordinator)

The building worktree cannot drive the running app. On the main checkout, with
C040 (`A001_09122356_C040`) on track 0 as one untrimmed clip and a Parakeet
transcript (D-381 merged, or Parakeet as the sidecar default — otherwise the
view is Whisper's and the POC indices below do not line up):

1. `editor_get_word_transcript {track: 0, start: true}` — repeat until `state`
   is not `transcribing`. Check `instructions` is present, `totalWords` = 903,
   and `text` below the legend equals `cargo run -p apelles-speech --example
   render_word_transcript -- eval/retake/transcripts/A001_09122356_C040.parakeet.words.json`
   (if the transcript is a fresh run, small differences mean the run differs,
   not the view).
2. `editor_propose_retakes {track: 0, view_id, groups: <the 11 groups of
   eval/retake/client_runs/2026-10-13-opus-run1/C040__parakeet.json>}` — expect
   7 verified and 4 refused (§11.4), each refusal with `offending` words. The
   Recut panel shows them, refused rows disabled.
3. Take one refused group: `editor_retranscribe_words {track: 0, view_id,
   first, last}` over its offending words; compare `current` and `reread`. If
   they differ, repeat with `apply: true`; check the `viewId` changed and that
   step 2 with the old id now answers `stale view_id`.
4. Resubmit every group under the new `view_id`, with `confirm` reasons for
   one refusal's offending words — expect it `ai_confirmed`; the panel shows
   the reasons and marks the words.
5. In the panel: Tick all suggested (only verified deletions tick), tick the
   AI-confirmed take by hand, Cut — one undo entry; undo restores.
6. Re-propose, then trim the clip slightly — the stale banner appears and the
   rows lock.
