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

**Provenance of the Whisper-labelled inputs.** The Whisper transcripts and the
tasks over them were produced by the since-removed Whisper backend (D-381). They
are kept as inputs to the ASR-agnostic detector and so that D-365..D-379 stay
reproducible; nothing in the app produces one any more.

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

### Every repeat is labelled, at word precision (D-379)

**Every repeat is a delivery**, however short and wherever it falls: a whole
re-read sentence, a false start, a two-word stutter inside a sentence. Bounds
come from Parakeet's **word** timestamps (`transcripts/`), so a delivery can
start and end mid-segment.

This replaced D-378's *expressibility* rule, which labelled a repeat only where
some reading's segment boundaries could isolate it, because the detector it was
written for can only cut whole segments. That rule made the eval charge a
word-level proposer for cutting a stutter *correctly* — D-379's POC lost
"A few months later, a few months later" and a dozen like it as over-cuts. Now a
whole-segment detector that cannot express a stutter simply scores lower recall
on it, which is the honest account of what it cannot do, and B-246's shape stays
caught: cutting a segment whose head is unique still charges the head.

### Nested groups

A stutter can sit *inside* another group's delivery — C038's
`"and mechanics and mechanics"` inside the second outro. It is labelled as its
own group, **nested**: every one of its deliveries lies within one delivery of
another group. Rules, enforced by `every_label_file_is_well_formed`:

- a group may nest only inside its container's **keeper**, and only one level
  deep — the only place a stutter cut matters, and the one place
  `redundant_secs` stays exact;
- when the container delivery **survives**, the nested group judges its own
  seconds: cutting one copy is safe, cutting every copy loses the survivor's;
- when the container is **cut**, the stutter went with it — the nested group is
  moot, counted in neither group recall nor keeper agreement, and its seconds
  are the container's safe seconds.

### How a boundary was decided

**Since D-379**, every bound that Parakeet's word timestamps supply is taken from
them (a delivery runs from its first word's start to the next labelled range,
so it carries its trailing pause). Two Parakeet timing artifacts are worked
around, and noted on the delivery wherever they bite: a repeated phrase stamped
at zero length (C019 326.60, C038 330.84 — the gap that follows is where it was
said), and D-376's late sentence-final word end (C038's `"training."` runs
1.04 s; the other reading's boundary is used). The rules below still decide
everything the word times do not.

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
| `expect` | `"pass"` or `"fail"`, **pinned**. Every corpus task and two control cases are expected to FAIL today — since D-386 on recall only, never on a gate. A task that stops matching its `expect` fails the run — so a fix cannot land silently and a regression cannot hide. |

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
| `b246_tail_repeat` | B-246's exact shape: a single-utterance take whose tail repeats the next delivery while its head is unique. There is no correct whole-segment cut of it. | **fails, on recall only** since D-386 — the detector proposes nothing (over-cut 8.40 → 0.00 s); before, it cut the take whole |
| `whisper_thank_you_hallucination` | two verbatim `"Thank you."` phantoms 27.3 s apart on room tone, similarity 1.000. Must not be cut. | passes (`min_words: 3` is the only thing stopping it) |
| `verbatim_retake` | the same line delivered twice, verbatim. Must be cut. | passes — the case that stops a detector winning by proposing nothing |
| `glued_anchor_unique_head` | D-366's own shape: a glued anchor carrying a unique setup line. | **fails, on recall only** since D-386 — the setup line is still kept out, but the remaining takes differ by "behind"/"being" (C038's real mis-hearing) and the detector now proposes only takes the keeper holds word for word; over-cut 0.00 s |

## Files

| path | what |
|---|---|
| `tasks.json` | the task set (data) |
| `labels/<source>.json` | the hand-labelled ground truth, in source-audio seconds |
| `bad_examples/<id>.transcript.json` + `.labels.json` | the synthetic control set |
| `baseline.json` | the committed floor — today's scores, including B-246's pinned badness |
| `transcripts/<source>.parakeet.words.json` | the full `transcribe.py --backend parakeet` output for the three labelled sources, **with word timestamps** — the labels' word-precise bounds come from these, and they are the input an MCP client reads (D-379). Same run as the segment fixtures: re-transcribed 2026-10-13 and verified segment-for-segment identical |
| `gate_baseline.json` | the coverage gate's pinned measurement (D-380): oracle refusals, detector misses, the client runs gated — rewritten by the same `APELLES_RETAKE_EVAL_BASELINE=1` |
| `client_runs/prompt.md` | the fixed prompt D-379's POC gave every client, verbatim (`{INPUT}` / `{OUTPUT}` were file paths) |
| `client_runs/input/<task>.words.txt` | the exact anonymised file each client read (`C019` = `video_a`, `C038` = `video_b`, `C040` = `video_c`); below its two `#` lines, byte-identical to what `render_indexed` prints |
| `client_runs/2026-10-13-<model>-run<N>/<task>.json` | each client's answer, verbatim, in index form — Opus runs 1-2, Sonnet run 1 |

The segment-level transcripts the corpus tasks score are **not** copied here:
they point at the 24 fixtures D-377 committed under
`crates/apelles-speech/tests/fixtures/`, by repo-relative path, so there is
exactly one copy of each.

## The baseline is a pinned-defect floor, not a target

`baseline.json` records today's behaviour. Since **D-386 (B-246 fixed)** no
corpus task fires a gate: over-cut and protected-cut are 0.00 s on all eleven,
precision 1.000, and every task still fails — on recall. That is the floor, and
it is not the goal: the goal is `expect: "pass"` on every task
(`docs/04-roadmap.md`).

D-386, before → after, at `RetakeParams::default()`:

| task | over-cut | protected cut | precision | retake recall | group recall |
|---|---|---|---|---|---|
| C019 / parakeet | 24.40 → **0.00 s** | 22.96 → 0.00 s | 0.443 → 1.000 | 0.265 → 0.232 | 0.353 → 0.235 |
| C038 / parakeet | 12.64 → **0.00 s** | 12.64 → 0.00 s | 0.843 → 1.000 | 0.523 → 0.189 | 0.611 → 0.294 |
| C040 / parakeet | 3.20 → **0.00 s** | 1.84 → 0.00 s | 0.965 → 1.000 | 0.606 → 0.296 | 0.909 → 0.545 |
| C019 / parakeet → gated (what the app shows) | 0.00 → 0.00 s | 0.00 → 0.00 s | 1.000 → 1.000 | 0.161 → **0.232** | 0.235 → 0.235 |
| C038 / parakeet → gated | 0.00 → 0.00 s | 0.00 → 0.00 s | 1.000 → 1.000 | 0.189 → 0.189 | 0.294 → 0.294 |
| C040 / parakeet → gated | 0.00 → 0.00 s | 0.00 → 0.00 s | 1.000 → 1.000 | 0.232 → **0.296** | 0.455 → **0.545** |
| C019 / whisper (re-derived) | 12.40 → **0.00 s** | 7.86 → 0.00 s | 0.770 → 1.000 | 0.564 → 0.056 | 0.412 → 0.059 |
| C038 / whisper (pinned) | 10.36 → **0.00 s** | 2.10 → 0.00 s | 0.874 → 1.000 | 0.551 → 0.145 | 0.611 → 0.235 |
| C038 / whisper (re-derived) | 15.06 → **0.00 s** | 2.10 → 0.00 s | 0.826 → 1.000 | 0.551 → 0.171 | 0.647 → 0.294 |
| C040 / whisper (pinned) | 17.60 → **0.00 s** | 0.00 → 0.00 s | 0.820 → 1.000 | 0.551 → 0.193 | 0.636 → 0.364 |
| C040 / whisper (re-derived) | 24.16 → **0.00 s** | 0.00 → 0.00 s | 0.801 → 1.000 | 0.670 → 0.365 | 0.636 → 0.636 |

The table below is the state **before D-386**, kept because the three shapes it
names are what D-386 closed (2026-10-13, D-379; D-378's first numbers, on
segment-level labels, are in that decision):

| task | over-cut | of it protected | precision | retake recall | group recall | keeper |
|---|---|---|---|---|---|---|
| C019 / whisper (re-derived) | 12.40 s | 7.86 s | 0.770 | 0.564 | 0.412 | 1.000 |
| C019 / parakeet | 24.40 s | 22.96 s | 0.443 | 0.265 | 0.353 | 0.800 |
| C038 / whisper (pinned) | 10.36 s | 2.10 s | 0.874 | 0.551 | 0.611 | 0.857 |
| C038 / whisper (re-derived) | 15.06 s | 2.10 s | 0.826 | 0.551 | 0.647 | 0.857 |
| C038 / parakeet | 12.64 s | 12.64 s | 0.843 | 0.523 | 0.611 | 1.000 |
| C040 / whisper (pinned) | 17.60 s | 0.00 s | 0.820 | 0.551 | 0.636 | 0.857 |
| C040 / whisper (re-derived) | 24.16 s | 0.00 s | 0.801 | 0.670 | 0.636 | 0.714 |
| C040 / parakeet | 3.20 s | 1.84 s | 0.965 | 0.606 | 0.909 | 0.900 |

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

## Scoring proposals from outside the crate (D-379)

The detector is not the only thing worth scoring: since D-379 the retake
judgement is moving to the MCP client (an LLM reading the transcript), and the
eval has to referee that too. Set `APELLES_RETAKE_EVAL_PROPOSALS` to a directory
and `external_proposals` scores it instead of the detector — same labels, same
scorer, so the numbers compare directly:

```sh
APELLES_RETAKE_EVAL_PROPOSALS=/path/to/dir \
  cargo test -p apelles-speech --test retake_eval external_proposals -- --nocapture
```

One file per task, named by its id with `/` as `__` (`C040__parakeet.json`),
each group in either of two forms:

- **seconds** — `{"kept": [[s, e], ...], "cut": [[s, e], ...]}`, scored as
  given;
- **index form** (D-380, what an MCP client answers in) —
  `{"takes": [{"first": a, "last": b}, ...], "keep": k}` over the source's
  `transcripts/` word list, resolved through the app's real coverage gate
  (`apelles_speech::check_and_resolve`): accepted groups are scored as the
  padded cut ranges the app would apply, **refused groups are listed with their
  offending words and not scored** — exactly what the app would not apply.
  Extra fields (`line`, `note`) are ignored.

Nothing in this mode is pinned — a proposer outside the crate is not this
crate's behaviour; it is how one is measured. The committed client runs are
pinned separately, below.

To reproduce what a client reads:
`cargo run -p apelles-speech --example render_word_transcript -- eval/retake/transcripts/<source>.parakeet.words.json`.

**D-379's POC, on the word-precise labels.** Fresh agents with no context, each
given only one anonymised `transcripts/` file as numbered words and a fixed
prompt, proposing retake groups as word-index ranges + a keep; converted to
seconds exactly from the word times:

| proposer | content lost | protected lost | tasks passing (of 3) | retake recall C019 / C038 / C040 |
|---|---|---|---|---|
| today's detector (Parakeet) | 40.24 s | 37.44 s | 0 | 0.265 / 0.523 / 0.606 |
| Claude Opus, run 1 | 0.00 s | 0.00 s | 3 | 0.585 / 0.733 / 0.742 |
| Claude Opus, run 2 | 0.00 s | 0.00 s | 3 | 0.605 / 0.745 / 0.717 |
| Claude Sonnet | 0.00 s | 0.00 s | 3 | 0.567 / 0.720 / 0.725 |

## Measuring the coverage gate (D-380)

Since D-380 the app accepts a client's retake groups only through a
deterministic coverage gate (`crates/apelles-speech/src/proposal.rs`; the rule
is in `docs/notes/retake-detection.md` §11). The gate is judged by three
measurements, all in `the_coverage_gate_measures_as_pinned` and pinned in
`gate_baseline.json`:

| measurement | what must hold | today |
|---|---|---|
| **oracle** — the labels' own answer: every non-keeper delivery cut, the keeper kept, nested groups as their own groups, each delivery mapped to word indices by word midpoint | accepted (a refusal refuses a correct cut) | **17 of 46 refused**; gated over-cut 0.00 s |
| **the detector's groups** the eval charges as over-cut, mapped the same way and judged one at a time | refused (an acceptance is a miss) | **0 of 6 accepted**; gated over-cut 0.00 s |
| **the committed client runs**, scored as the app would apply them | no over-cut | **0.00 s in all nine**; retake recall 0.39-0.43 / 0.29-0.30 / 0.30-0.31 |

The refusal count is the gate's recall cost, and it is high: nearly every
refused correct group holds a word the ASR mis-heard in the flubbed take, which
the gate — reading text only — cannot tell from a word said once.

The thresholds are swept by `coverage_gate_sweep`:

```sh
APELLES_RETAKE_GATE_SWEEP=1 cargo test -p apelles-speech --test retake_eval coverage_gate_sweep -- --nocapture
```

The app's word view itself is pinned by `the_indexed_view_is_the_pocs_input`:
below its legend, byte-identical to `client_runs/input/` — and, since D-380
step 2, by `a_one_clip_track_view_is_the_pocs_input` for the timeline path
(`index_pieces` over one untrimmed clip). `the_served_rules_are_the_pocs_prompt`
pins the rules the app serves a client (`JUDGING_RULES`) to the judging block of
`client_runs/prompt.md`: the app hands every client the rules this eval
measured, verbatim.

## The detector behind the gate (D-382)

Three more tasks, `C019|C038|C040/parakeet-gated` (`"gated": true` in
`tasks.json`), score the detector **as the app now applies it**: each group's
takes mapped onto the source's word transcript by word midpoint
(`take_from_span`), all groups through the coverage gate together in the
detector's order, refused groups not scored — the app shows them to the person
but does not let them be ticked unless someone who listened unlocks one.

| task | over-cut | precision | retake recall | group recall | groups (applied / refused) |
|---|---|---|---|---|---|
| C019 / parakeet → gated | 24.40 → **0.00 s** | 0.443 → 1.000 | 0.265 → 0.161 | 0.353 → 0.235 | 4 / 3 |
| C038 / parakeet → gated | 12.64 → **0.00 s** | 0.843 → 1.000 | 0.523 → 0.189 | 0.611 → 0.294 | 5 / 5 |
| C040 / parakeet → gated | 3.20 → **0.00 s** | 0.965 → 1.000 | 0.606 → 0.232 | 0.909 → 0.455 | 5 / 5 |

All three still `expect: "fail"` — on recall, never on a gate. The refusals were
the detector's over-cutters and its groups whose keeper does not hold every
word (an ASR mis-hearing, an inflection), the same two kinds the gate refuses
for a client. **Since D-386 the detector forms neither kind**, so the gate
refuses none of its groups and the gated rows equal the ungated ones: recall
0.232 / 0.189 / 0.296 (from 0.161 / 0.189 / 0.232).

## Boundary

Internal dev tooling, like `eval/` — **not a feature users see**, so
`CLAUDE.md`'s human-AND-AI rule does not oblige a GUI surface or an MCP tool
here. See D-378 for that reasoning in full, and for why an MCP tool to *run* the
eval is worth a later pass rather than this one.
