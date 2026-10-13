# `eval/retake/` — the retake / edit-decision eval dataset

**What it is.** The *data* half of the retake eval (**D-378**): a task set, a
hand-labelled ground truth for three real sources, a synthetic control set, and
a committed baseline. All of it is plain, backend-agnostic JSON.

**What it does NOT do.** It contains no scorer and no detector. The scorer is
Rust and lives in `crates/apelles-speech/tests/retake_eval.rs`, because the
thing being scored — `detect_retakes` — is Rust and must be called *for real*
rather than approximated. That is the one lesson `eval/`'s own big caveat
teaches (`lib/apply.mjs` is an approximate operator, so its absolute scores mean
nothing); this harness has no equivalent caveat and must not acquire one.

```sh
cargo test -p apelles-speech --test retake_eval -- --nocapture       # the table, rollup, baseline diff
APELLES_RETAKE_EVAL_BASELINE=1 cargo test -p apelles-speech --test retake_eval   # rewrite baseline.json
```

No model, no audio, no venv, no network: every input here is JSON.

## Why this exists

The retake detector has been declared fixed three times and each round produced
a green number that **measured the wrong thing** (B-198 → B-237 → B-238 → B-246;
`docs/notes/retake-detection.md` §4, §6, §8). Round 1 swept the pairwise
*predicates* and never scored the resulting **cut**. Round 2 (D-366) added the
right invariant and only ever ran it on two hand-picked excerpts. Round 3 (D-377)
finally audited whole transcripts and found 62.3 s of speech that would be
silently deleted.

So the design constraint on this dataset is not "does it score well" but **it
must be impossible to satisfy by measuring nothing.** Concretely:

- the scorer runs a **null detector** (proposes nothing) and a **greedy
  detector** (proposes everything) against every corpus task and asserts both
  **fail** — a pass is therefore evidence of behaviour, not of silence;
- the labels are asserted non-vacuous: at most 10 % of a labelled source's span
  may be `neutral`, and each source must carry a floor of groups and of
  redundant seconds;
- the nine silent B-roll sources in the fixture corpus are **not tasks here.**
  A source with no speech passes any cut audit vacuously, and "12/12 clean"
  would have been a headline that measured nothing.

## The label schema

One file per source, `labels/<source>.json`. **Every time is source-audio
seconds.** That is the load-bearing decision: a label is a fact about the
recording, not about one ASR's segmentation, so the *same* labels score
Whisper's transcript, Parakeet's, and tomorrow's backend. Measured, the backends
agree ~90 % on the words (90.3 / 90.2 / 89.6 % word-sequence agreement on
C019 / C038 / C040) and differ markedly on segmentation (45 vs 83, 87 vs 126,
58 vs 83 segments) — so index-anchored labels would silently only ever have
worked for one backend, and would let the eval mistake a segmentation difference
for a quality difference.

```jsonc
{
  "source": "A001_08302215_C019",
  "duration_secs": 517.1,
  "labelled_span": [0.0, 517.1],      // the eval only judges cuts inside this
  "readings": [ "...", "..." ],        // the transcripts the labelling read
  "retakes": [
    {
      "id": "c019-writing-the-notes",
      "line": "the line, as a human would write it",
      "keeper": 1,                     // index into deliveries
      "keeper_confidence": "high",     // "low" ⇒ excluded from keeper_agreement
      "deliveries": [                  // >= 2; in spoken order; non-overlapping
        { "start": 175.8, "end": 191.56, "approximate_start": true },
        { "start": 195.56, "end": 205.94 }
      ]
    }
  ],
  "protected": [                       // named ranges that must NEVER be cut
    { "id": "c019-lets-go-to-the-maths", "start": 162.84, "end": 175.8, "note": "..." }
  ],
  "neutral": [                         // neither credited nor penalised
    { "start": 191.56, "end": 193.72, "reason": "aside", "note": "\"Okay, I should do this.\"" }
  ]
}
```

Three kinds of labelled time, and **everything else inside `labelled_span` is
unique content** — speech that exists nowhere else in the source, so proposing
it for deletion is over-cutting. That closure is what makes the gate total: a
label file does not have to enumerate the 90 % of a video that is said once.

| kind | means | effect on the score |
|---|---|---|
| a `retakes[].deliveries[]` range | this span is one delivery of a line delivered more than once | cutting it is **safe** (credited as recall) as long as one delivery of that group survives |
| `protected[]` | unique content worth naming, because some past or present defect proposed cutting it | cutting it fails `protected_secs_cut`, a **gate** — a named regression, so the failure message says *which* thing was lost |
| `neutral[]` | cutting is neither right nor wrong | excluded from both the gate and the recall denominator |
| anything else in `labelled_span` | unique content | cutting it fails `over_cut_secs`, the **gate that matters** |

`protected` is a strict subset of unique content and is therefore redundant with
`over_cut_secs` by construction — asserted by
`every_protected_range_is_unique_content`. It is kept anyway for the same reason
`proposed_cuts.rs` itemises B-246's six cases rather than counting them: "the
video's own cold open was proposed for deletion" is a better failure than
"14.1 s over-cut".

### `neutral`, and why it is capped

`neutral` is the escape hatch for material where "should this be cut?" has no
defensible answer from the text, and it is the one field that could quietly
hollow this dataset out. Allowed reasons, all of them narrow:

| reason | what it covers |
|---|---|
| `abandoned_restart` | an attempt of ≥ ~2 s that the speaker abandoned and then re-expressed in **different words** — a human cuts it, but its content is not *re-delivered*, so neither verdict is right |
| `aside` | production chatter addressed to nobody in the video ("Okay, I should do this.", "Cut from here.") |
| `unresolvable_boundary` | a span where no reading gives a usable boundary at all |

`the_labels_are_not_vacuous` caps total `neutral` time at 10 % of
`labelled_span` per source and asserts per-source floors on group count and
redundant seconds. If a future labelling pass wants more neutral time than that,
it has to move the cap deliberately and say why.

### Expressibility — the rule that decides what counts as a delivery

A take is a range of **whole utterances** (`retake-detection.md` §2's honest
limit). So a repeat whose redundant material sits *inside* a segment in every
reading cannot be cut without taking unique speech with it, and D-318's safe
direction is to leave it alone. Therefore:

> **A delivery is labelled only where its boundaries coincide with segment
> boundaries in at least one of the readings.**

A repeat that fails this test is left as **unique content**, which means
proposing to cut it is scored as over-cutting. That is deliberate and it is
exactly B-246: Whisper's one violation is a 5.42 s segment whose tail ("there's
actually a name for this") repeats and whose head ("monthly invoice still goes
up") is said once. There is no cut of that segment that is correct, so the
correct behaviour is not to propose one.

### How a boundary was decided

Labelled from the transcript **text** of two or three independent readings of
the same audio — the pinned Whisper fixture, a Whisper transcript re-derived in
D-377, and Parakeet — never from `detect_locations`/`detect_retakes` output. The
rules, applied in order:

1. a delivery's range is the **union** of the readings' segments carrying that
   delivery's words;
2. then **clipped** at each end so it never overlaps the tightest span any
   reading gives the neighbouring *different* content — so a range may contain
   silence (cutting silence loses nothing) but never speech belonging to
   something else;
3. where the readings disagree, the bound that **protects unique content** wins;
4. a bound that no reading supplies directly (a boundary falling mid-segment in
   all of them) is estimated from word position within the segment and marked
   `approximate_start` / `approximate_end`.

**What could not be done: nobody listened to the audio.** Claude cannot hear,
so "where unclear, the audio itself" was substituted with a second and third
*independent ASR reading of the same audio*, which is why `readings` is a
required field. Every judgment that rests on only one reading is called out in
that delivery's `note`.

## The task set — `tasks.json`

Same vocabulary as `eval/tasks.json` (D-035): `id` / `description` /
`goal.checks[].metric` with `max` or `min` / `gates[]`, plus two fields this
harness adds.

| field | why |
|---|---|
| `params` | `RetakeParams` overrides; absent means `RetakeParams::default()` |
| `expect` | `"pass"` or `"fail"`, **pinned**. B-246 is a known-open defect, so all eight corpus tasks and one control case are expected to FAIL today. A task that stops matching its `expect` fails the run — so a fix cannot land silently and a regression cannot hide. |

A `gates[]` entry that fires zeroes the task **regardless of score**. That
primitive is the whole structural defence against a vacuous pass, which is why
the one metric that matters is a gate and not a weighted check.

## The metrics

Let `C` = every second the detector proposes for deletion (the union of the
non-kept takes' member spans). For each labelled group `g`, the **survivor** is
the delivery of `g` the cut leaves most intact — the smallest cut *fraction*
`|C ∩ d| / |d|` (ties: the earliest). Then:

| metric | definition | role |
|---|---|---|
| **`over_cut_secs`** | `\|C ∩ survivor(g)\|` summed over groups, plus `\|C ∩ unique\|`, less the boundary tolerance below | **GATE, max 0.0** |
| **`protected_secs_cut`** | the part of `over_cut_secs` inside `protected` | **GATE, max 0.0** |
| `cut_precision` | `safe / (safe + over_cut)`, where `safe` = `\|C ∩ (deliveries \ survivor)\|` | scored |
| `retake_recall` | `safe / Σ_g (\|deliveries(g)\| − \|keeper(g)\|)` | scored |
| `group_recall` | groups with ≥ 0.5 s of a non-keeper delivery inside `C`, over all groups | scored |
| `keeper_agreement` | of the matched groups whose label is `keeper_confidence: "high"`, the fraction where the detector's recommended keep overlaps the labelled keeper most | scored |
| `boundary_slack_secs` | the lost seconds the boundary tolerance forgave | reported only |
| `neutral_cut_secs` | `\|C ∩ neutral\|` | reported only |
| `proposed_secs` | `\|C ∩ labelled_span\|` | reported only |

**`over_cut_secs` is D-318's one-directional rule, stated as an outcome.** The
tool only ever proposes, so a proposal a human accepts must never silently
delete speech absent from the result. It is keeper-agnostic on purpose: any one
surviving delivery preserves the content, so a detector is not penalised for
keeping a different take than the label prefers — that is what
`keeper_agreement` is for, scored, because keeping an earlier take is a quality
question and not a correctness one.

Charging the survivor's own clipped seconds is what makes the formula total:
if a group's every delivery is cut, the survivor is simply the least-cut one, so
the content is charged as lost exactly once rather than once per delivery.

**Why a fraction and not uncut seconds.** A delivery's range may include the
pause around it (rule 2), so "most uncut seconds" lets a padded delivery survive
on its silence. Measured on the first run: C038's `"it's expensive for sure, but
it's a one-time bill only"` x2, where Whisper's #39 holds all of delivery 0's
words *and* the head of delivery 1, was charged 5.64 s by uncut seconds — the
words actually lost are `"it's expensive for"`, ~1.2 s, which is what the
fraction rule charges (1.22 s).

### The boundary tolerance — `BOUNDARY_TOLERANCE_SECS = 0.75`

A label's edge is only as precise as the readings that drew it, and rule 3
deliberately puts it on the side that protects unique content — so every cut
made from the *other* reading's segmentation is charged a sliver that measures
ASR timing disagreement, not detector behaviour. Measured while labelling, the
largest such disagreement any over-cut rested on is **0.74 s** (C040, the end of
"doesn't get half ignored": re-derived Whisper 44.38 s, Parakeet 45.12 s); the
others were 0.24-0.58 s.

So a lost **run** (touching pieces merged first, so a cut crossing an edge is
one loss) that is **no longer than 0.75 s and touches a labelled edge** — a
delivery's or a `neutral` range's start or end — is reported as
`boundary_slack_secs` instead of `over_cut_secs`. Anything longer, or anywhere
else, is charged in full: C038's 1.06 s `"corner"`, welded by Whisper onto the
head of the outro and cut with it, is a real lost word and is charged. The
forgiven seconds are a column of their own and printed per range, so a detector
that learns to live inside the tolerance is visible rather than hidden.

**Why recall is in seconds and in groups.** Seconds-recall is dominated by one
long group; group-recall is blind to how much of a group was found. Both move
for different reasons, and a detector cannot win either by proposing nothing.

### What this eval deliberately does not measure

- **Silence.** `silence.rs` owns dead air. Silence is not separated from
  speech here: a delivery's range may include the pause around it, and those
  seconds count with the delivery — which is why the survivor is chosen by
  fraction, above.
- **Transcription accuracy.** The labels are about the recording, so a backend
  that mis-hears a word still scores the same cut. That is the point of
  anchoring to source time — the eval must not be able to mistake a
  segmentation difference for a quality difference.
- **Whether a human would have cut it.** Not every frame a human trims is
  something a retake detector was asked to catch (`retake-detection.md` §4's
  ninth case). The question here is narrower and checkable: *does the content
  being removed exist anywhere in what survives?*

## The control set — `bad_examples/`

Synthetic, hand-authored transcripts whose correct answer is true by
construction, each with its own label file. Note the divergence from `eval/`'s
`bad_examples/`, which holds deliberately-*wrong results* (grades): there is no
agent here, so what can be authored is a deliberately-*diagnostic input*.

They are scored by the same scorer, through the same tasks, and each one's
verdict is pinned by `expect`. **A control set that all passes is a bug in the
eval**, which is why one of them is `expect: "fail"` against today's code.

| case | the known answer | today |
|---|---|---|
| `b246_tail_repeat` | B-246's exact shape: a single-utterance take whose tail repeats the next delivery while its head is unique. There is no correct cut of it. | **fails** — the detector cuts it whole |
| `whisper_thank_you_hallucination` | two verbatim `"Thank you."` phantoms 27.3 s apart on room tone, similarity 1.000. Must not be cut. | passes (`min_words: 3` is the only thing stopping it) |
| `verbatim_retake` | the same line delivered twice, verbatim. Must be cut. | passes — the case that stops a detector winning by proposing nothing |
| `glued_anchor_unique_head` | D-366's own shape: a glued anchor carrying a unique setup line. | passes — this one is genuinely fixed |

## Files

| path | what |
|---|---|
| `tasks.json` | the task set (data) |
| `labels/<source>.json` | the hand-labelled ground truth, in source-audio seconds |
| `bad_examples/<id>.transcript.json` + `.labels.json` | the synthetic control set |
| `baseline.json` | the committed floor — today's scores, including B-246's pinned badness |

Transcripts are **not** copied here: the corpus tasks point at the 24 fixtures
D-377 committed under `crates/apelles-speech/tests/fixtures/`, by repo-relative
path, so there is exactly one copy of each.

## The baseline is a pinned-defect floor, not a target

`baseline.json` records today's behaviour, and today's behaviour includes
**B-246 unfixed**. **All eight corpus tasks fail their `over_cut_secs` gate, on
both backends.** That is recorded as the floor so a *regression* is visible, and
it is explicitly not the goal: the goal is `expect: "pass"` on every task, which
needs B-246's fix and its own measurement of the recall cost
(`docs/04-roadmap.md`).

The first run, at `RetakeParams::default()` (2026-10-13, D-378):

| task | over-cut | of it protected | precision | retake recall | group recall | keeper |
|---|---|---|---|---|---|---|
| C019 / whisper (re-derived) | 23.32 s | 6.18 s | 0.572 | 0.778 | 0.833 | 1.000 |
| C019 / parakeet | 26.64 s | 21.16 s | 0.388 | 0.421 | 0.833 | 0.750 |
| C038 / whisper (pinned) | 13.16 s | 0.00 s | 0.840 | 0.606 | 0.846 | 0.875 |
| C038 / whisper (re-derived) | 17.86 s | 0.00 s | 0.795 | 0.609 | 0.846 | 0.750 |
| C038 / parakeet | 16.00 s | 10.54 s | 0.802 | 0.568 | 0.846 | 1.000 |
| C040 / whisper (pinned) | 23.92 s | 0.00 s | 0.755 | 0.552 | 0.778 | 1.000 |
| C040 / whisper (re-derived) | 29.10 s | 0.00 s | 0.762 | 0.695 | 0.778 | 0.667 |
| C040 / parakeet | 3.84 s | 3.84 s | 0.958 | 0.653 | 1.000 | 1.000 |

Every charged range was checked against the detector's own groups and is a real
loss of words — none is a labelling artifact. They are three shapes, and only
the first is what `proposed_cuts.rs` counts as B-246:

1. **A take that repeats nothing in its group** — B-246's six, all present.
2. **A kept take that is a fragment.** The group keeps a take holding only part
   of the line and cuts every complete delivery of the rest: C040's recap keeps
   `"by matching each word's query against every other word's key"` and cuts
   both `"So, quick recap. Attention is the model deciding how much to focus on
   each part of what you said"`; C038's outro keeps the fourth `"not just what
   it can do"` and cuts both `"and subscribe if you want more of this"`. This is
   B-246's "straddled" class, which D-377 measured and left out of its count.
3. **Unique speech that `word_overlap` waves through**, because shared function
   words or a shared tail lift a mixed utterance over 0.5: C019 Whisper #37
   (`"about an 80% cut from one structural change"` rides on `"one more thing to
   know the notes"`), C019 Parakeet's `"This is the mistake."`, C038's
   `"corner"` and `"it so expensive"`.

## Boundary

Internal dev tooling, like `eval/` — **not a feature users see**, so
`CLAUDE.md`'s human-AND-AI rule does not oblige a GUI surface or an MCP tool
here. See D-378 for that reasoning in full, and for why an MCP tool to *run* the
eval is worth a later pass rather than this one.
