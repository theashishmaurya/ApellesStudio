# c038 — the split-screen build (D-368)

The c038 video (`2026-09-12-c038-mgfx`, the owner's own 7:19 / 10542-frame
re-edit) given the same two-panel treatment D-348 built for c040: speaker in a
9:16 left column, motion graphic in the right panel. 21 explainer compositions
instead of 9.

Companion to `c040-split-screen-layout.md`, which holds the geometry this
reuses. **Read the "what does NOT transfer" section below before reusing those
numbers on a third video.**

Where each graphic sits on the Edit timeline, and the collisions that plan
has to resolve. Timeline is **10542 frames / 439.15 s @ 24.005204681686973**.

Geometry per D-348 is fixed and not restated here — see `BRIEF.md`.
Every graphic is placed with the right-panel `box_*` values; every camera
in/out ramp is **12 frames**, ease `(0.42, 0, 0.58, 1)`, on whichever
footage clip contains it.

---

## First: BRIEF.md's beat frames are STALE. These are the real ones.

`BRIEF.md`'s "Beats with NO scene" table was built from the **first**,
buggy beat map — the one whose midpoint survival test silently dropped 16
real lines. Every frame in it is **30-75 frames late**. Placing a graphic
1-3 seconds after the line it illustrates is a visible edit error, not a
rounding difference, so the table below re-derives all 21 from the
regenerated `beats.tsv` and supersedes it.

| scene | BRIEF said | actually | the line it lands on |
|---|---|---|---|
| `c038-hook` | 55 | **0** | "In December of last year, Nvidia made the single biggest deal…" |
| `c038-groq` | 318 | **283** | "…grog doesn't build chips for training ai models" |
| `c038-tpusplit` | 1011 | **971** | "One built to train models and one built to run them." |
| `c038-crossover` | 1363 | **1290** | "In 2026, for the first time in AI history, companies spent more…" |
| `c038-share` | 1513 | 1513 | "55 cents of every dollar going into AI cloud spending…" |
| `c038-thesis` | 2051 | **1997** | "Running a model has quietly become more expensive than building it" |
| `c038-training` | 2839 | **2792** | "Training is when a lab takes a model and teaches it…" |
| `c038-everymessage` | 3319 | **3172** | "Inference is everything after that." — see the correction below |
| `c038-chaiwala` | ~3400 | **3381** | "It's kind of like a chaiwala, setting up a stall…" |
| `c038-oncevsforever` | 4104 | 4104 | "The training happens once and inference it happens every single time" |
| `c038-scales` | 4274 | 4274 | "…it scales with how many people are actually using the thing" |
| `c038-wordbyword` | 4768 | **4692** | "They write it one word at a time and to write each new word correctly…" |
| `c038-rereads` | 5241 | 5241 | "Word one reread everything, word two reread everything again…" |
| `c038-everyuser` | 5759 | **5666** | "an enormous amount of work happening for every single response…" |
| `c038-kvcache` | ~5891 | **5834** | "there's a fix it's called KV cache…" |
| `c038-batching` | 6674 | **6642** | "The first one called batching and it's just like a restaurant kitchen." |
| `c038-quantization` | 7366 | **7343** | "The second trick you have actually probably heard of…" |
| `c038-specdecode` | 7864 | **7849** | "speculative decoding okay and the third one call is…" |
| `c038-tricks` | 8686 | 8686 | "Batching, quantization, speculative decoding," |
| `c038-recap` | 9201 | 9201 | "…is that quite recurring cost of the model actually running." |
| `c038-payoff` | ~9765 | **9694** | "So next time you send a message to chatgpd or clod and get an instant answer" |

Only 5 of 21 were already right.

---

## The schedule

`len` is the scene's own `dur` at 24.0052 fps. `?` = scene not built yet.

| # | scene | in | dur (s) | len (f) | out |
|---|---|---|---|---|---|
| 1 | `c038-hook` | 0 | 6 | 144 | 144 |
| 2 | `c038-groq` | 283 | 13 | 312 | 595 |
| 3 | `c038-tpusplit` | 971 | 8 | 192 | 1163 |
| 4 | `c038-crossover` | 1290 | 6.2 | 149 | 1439 |
| 5 | `c038-share` | 1513 | 8 | 192 | 1705 |
| 6 | `c038-thesis` | 1997 | 6 | 144 | 2141 |
| 7 | `c038-training` | 2792 | ? | ? | ? |
| 8 | `c038-everymessage` | 3172 | 8.5 | 204 | 3376 |
| 9 | `c038-chaiwala` | 3381 | 9 | 216 | 3597 |
| 10 | `c038-oncevsforever` | 4104 | 8 | 192 | 4296 |
| 11 | `c038-scales` | 4274 | ? | ? | ? |
| 12 | `c038-wordbyword` | 4692 | ? | ? | ? |
| 13 | `c038-rereads` | 5241 | 9 | 216 | 5457 |
| 14 | `c038-everyuser` | 5666 | ? | ? | ? |
| 15 | `c038-kvcache` | 5834 | 8 | 192 | 6026 |
| 16 | `c038-batching` | 6642 | ? | ? | ? |
| 17 | `c038-quantization` | 7343 | ? | ? | ? |
| 18 | `c038-specdecode` | 7849 | ? | ? | ? |
| 19 | `c038-tricks` | 8686 | 10 | 240 | 8926 |
| 20 | `c038-recap` | 9201 | 9 | 216 | 9417 |
| 21 | `c038-payoff` | 9694 | 8 | 192 | 9886 |

### Correction: a beat starts at its FIRST line, not at its best-known line

I first put `c038-everymessage` at **3277** — the line BRIEF.md quotes for it
("Every time you send a message…") — and passed the builder a 4.33 s cap
derived from that. Both were wrong, and the builder was right to push back.
3277 is the *third sentence inside* the beat; the beat opens at **3172**
("Inference is everything after that." → "It's the model being actually
used." → "Every time you send a message…"). Anchoring to the quoted line
rather than the beat's opening loses 105 frames and made a perfectly
well-scoped 8.5 s composition look like it had to be crushed into 4.3 s.

The scene has been restored to its full 8.5 s (204 f, out 3376, clearing
`chaiwala` at 3381 by 5 frames). **The general rule, which the rest of this
table already follows: read the beat's first line out of `beats.tsv`, never
the descriptive line from the assignment table.**

## Two hard duration caps, and one overlap

- **#14 `c038-everyuser` ≤ 168 f / 7.00 s** — the beat opens at 5666 and
  #15 `kvcache` begins at 5834. (Re-derived from the beat's OPENING line
  after the `everymessage` mistake above; the first figure I had, 4.70 s,
  was anchored to 5721 and was too tight by the same 2.3 s error.)
- **#10 `c038-oncevsforever` overruns #11 `scales` by 22 f** (out 4296 vs in
  4274). `oncevsforever` is an EXISTING, already-verified scene, so resolve
  this at composite time by starting `scales` at 4296 rather than by
  re-cutting a finished scene — 22 frames is under a second and the line it
  lands on runs well past it.

## Camera ramping: segments, not per-graphic bounces

A 12-frame out-ramp plus a 12-frame in-ramp needs 24 frames of clear air
between two graphics, and a camera that bounces out and straight back in
reads as a glitch rather than a transition. So **adjacent graphics run as one
continuous panel segment**: the camera ramps into the column once before the
first graphic, holds across the whole run, and ramps out once after the last.
The graphic clips butt against each other in the right panel.

This is what the c040 edit does wherever two beats land back to back, and it
matches how an NLE treats a sustained split-screen — the split is a *state*,
not a per-graphic transition.

| segment | graphics | camera in | camera out |
|---|---|---|---|
| A | #1 | 0 | 144 |
| B | #2 | 283 | 595 |
| C | #3 | 971 | 1163 |
| D | #4 + #5 | 1290 | 1705 |
| E | #6 | 1997 | 2141 |
| F | #7 + #8 + #9 | 2792 | 3597 |
| G | #10 + #11 | 4104 | (scales out) |
| H | #12 + #13 | 4692 | 5457 |
| I | #14 + #15 | 5666 | 6026 |
| J | #16 + #17 + #18 | 6642 | (specdecode out) |
| K | #19 | 8686 | 8926 |
| L | #20 | 9201 | 9417 |
| M | #21 | 9694 | 9886 |

**13 camera ramps instead of 21.** Segment D's two graphics are 74 frames
apart and segment H's are 333 — the panel simply holds empty between them,
or the earlier graphic's own tail extends. Decide that per segment against a
live render, not on paper.

---

# FINAL schedule (2026-10-02) — all 21 scenes built, durations fixed

Supersedes every table above. `len` from each scene's real `dur` at 24.0052 fps.

| # | graphic | in | len | out | gap to next |
|---|---|---|---|---|---|
| 1 | `c038-hook` | 0 | 144 | 144 | 139 |
| 2 | `c038-groq` | 283 | 312 | 595 | 376 |
| 3 | `c038-tpusplit` | 971 | 192 | 1163 | 127 |
| 4 | `c038-crossover` | 1290 | 149 | 1439 | 74 |
| 5 | `c038-share` | 1513 | 192 | 1705 | 292 |
| 6 | `c038-thesis` | 1997 | 144 | 2141 | 651 |
| 7 | `c038-training` | 2792 | 240 | 3032 | 140 |
| 8 | `c038-everymessage` | 3172 | 204 | 3376 | **5** |
| 9 | `c038-chaiwala` | 3381 | 216 | 3597 | 507 |
| 10 | `c038-oncevsforever` | 4104 | 192 | 4296 | **0** |
| 11 | `c038-scales` | **4296** | 240 | 4536 | 156 |
| 12 | `c038-wordbyword` | 4692 | 288 | 4980 | 261 |
| 13 | `c038-rereads` | 5241 | 216 | 5457 | 209 |
| 14 | `c038-everyuser` | 5666 | 168 | 5834 | **0** |
| 15 | `c038-kvcache` | 5834 | 192 | 6026 | 616 |
| 16 | `c038-batching` | 6642 | 696 | 7338 | **5** |
| 17 | `c038-quantization` | 7343 | 504 | 7847 | **2** |
| 18 | `c038-specdecode` | 7849 | 816 | 8665 | **21** |
| 19 | `c038-tricks` | 8686 | 240 | 8926 | 275 |
| 20 | `c038-recap` | 9201 | 216 | 9417 | 277 |
| 21 | `c038-payoff` | 9694 | 192 | 9886 | — |

`#11 c038-scales` is placed at **4296**, not its beat frame 4274: `#10
c038-oncevsforever` is an already-verified scene running to 4296, and 22
frames is under a second against a line that runs well past it. Re-cutting a
finished scene to recover 22 frames is the worse trade.

Act 4's three long scenes were durated to their own beats closely enough that
they tile within 2-5 frames with no adjustment at all.

## The 14 camera segments

A graphic pair closer than ~48 frames (2 s) shares one camera hold: 12 out +
12 in is 24 frames, and bouncing the camera out and back inside a couple of
seconds reads as a glitch, not a transition.

| seg | graphics | camera in | camera out | held |
|---|---|---|---|---|
| A | 1 | 0 | 144 | 6.0 s |
| B | 2 | 283 | 595 | 13.0 s |
| C | 3 | 971 | 1163 | 8.0 s |
| D | 4 + 5 | 1290 | 1705 | 17.3 s |
| E | 6 | 1997 | 2141 | 6.0 s |
| F | 7 | 2792 | 3032 | 10.0 s |
| G | 8 + 9 | 3172 | 3597 | 17.7 s |
| H | 10 + 11 | 4104 | 4536 | 18.0 s |
| I | 12 | 4692 | 4980 | 12.0 s |
| J | 13 | 5241 | 5457 | 9.0 s |
| K | 14 + 15 | 5666 | 6026 | 15.0 s |
| L | 16 + 17 + 18 + 19 | 6642 | 8926 | **95.1 s** |
| M | 20 | 9201 | 9417 | 9.0 s |
| N | 21 | 9694 | 9886 | 8.0 s |

**Segment L is 95 seconds of unbroken split-screen** — the whole "three
tricks" act plus the summary card. That is not an accident of the merge rule:
those four beats are one continuous stretch of narration with gaps of 5, 2 and
21 frames, so there is physically no room to ramp out and back between them.
If 95 s in the column feels too long when watched, the fix is a content cut
(drop `c038-quantization`, which act4.md already nominates as the one to lose),
not a camera move.

## Known side effect of placement

Each graphic clip carries a LINKED SILENT AUDIO half (the 4 existing PIPs each
have one on track 3). Placing 21 graphics therefore adds 21 silent audio clips.
Harmless to the mix, but it is why the audio track count jumps.

---

## The camera crop is RE-MEASURED for c038 — do not inherit c040's 0.535

`c040-split-screen-layout.md` records `crop_left 0.3877422 / crop_right
0.3177422`, which centres the kept region on **x = 0.535**. That number is not
a constant: the note states it is *that speaker's measured head centre*, and
c038 is a different shoot.

Measured on `A001_09122319_C038.MOV` (3840×2160) by pulling frames at 60 s,
200 s and 380 s and reading the head centre off each:

| frame | head centre |
|---|---|
| 60 s | ≈ 0.523 |
| 200 s | ≈ 0.495 |
| 380 s | ≈ 0.519 |

Mean **≈ 0.512**, spread 0.495–0.523. Inheriting 0.535 would have placed the
speaker 88 source px off, which is **~9 % of the 1144 px column** — visibly
off-centre without looking obviously broken.

**Use for c038, keeping the kept-width fraction (0.2945156) identical so the
column geometry and `scale` are unchanged:**

| field | c038 value | (c040 was) |
|---|---|---|
| `crop_left` | **0.3647422** | 0.3877422 |
| `crop_right` | **0.3407422** | 0.3177422 |

Everything else in D-348 is unchanged: `crop_top` 0.07, `crop_bottom` 0,
`scale` 0.29791667, `position_x` 0.01666667, `position_y` 0.02962963,
`corner_radius` 14.

The speaker drifts about ±0.014 around that mean across the video (±3 % of the
column). A single static crop cannot follow that, and tracking it would mean
keyframing the crop on all 77 footage clips — not worth it; the drift is small
enough to read as natural framing.

---

## What does NOT transfer from c040 — read before reusing D-348 on a third video

Two of D-348's numbers are **per-video measurements**, not constants. Both were
inherited silently at the start of this build and both had to be corrected:

1. **The crop centre.** See the section above. c040 is 0.535, c038 is 0.512.
   It is the speaker's head centre and must be re-measured per shoot. The
   kept-width fraction (0.2945156) and everything else IS constant.
2. **The beat frames.** Obvious in hindsight, but the first version of this
   build inherited a stale beat map and placed 16 of 21 graphics 1-3 seconds
   late. Always re-derive from the current `beats.tsv`, and anchor each
   graphic to the **first line of its beat**, not to the line the assignment
   table happens to quote — see the `c038-everymessage` correction above,
   which cost that composition half its length before it was caught.

What DOES transfer unchanged: the panel geometry (margins, gutter, panel
height, both panels' `box_*`/`position_*`), `corner_radius` 14,
`crop_top` 0.07, `scale` 0.29791667, the 12-frame ramp and its
`(0.42, 0, 0.58, 1)` ease, and the rule that the graphic uses `box_*` while
the camera uses `scale`+`crop_*` (because `editor_set_clip_keyframes` cannot
animate `box_*`).

## How the camera ramp is actually built

Worth recording because the mechanics are not guessable from the tool docs:

- A keyframe **overrides the static transform field per property** (D-208), so
  every animated property needs a key. Setting `scale` via
  `editor_set_clip_transform` on a keyframed clip is a real write that renders
  nothing.
- Keyframe `frame` numbers are **clip-source-absolute**, not timeline frames:
  `source = clip.source_start + (timeline_frame - clip.start_frame)`.
- Easing does **not** need `editor_set_keyframe_ease` per property per segment
  (which would have been ~200 calls here). `editor_set_clip_keyframes` accepts
  an `ease` object **inline on each keyframe**, keyed by param name, applying
  to the segment starting at that key. Verified persisted to `project.json`.
- A segment whose hold spans several footage clips needs those middle clips set
  to the column geometry **statically** — they carry no keyframes at all. Here
  that was 25 clips, 16 of them inside segment L alone.
- Two edge cases hit in practice: a segment starting at timeline frame 0 has no
  room for an in-ramp (the video simply opens in split-screen), and an out-ramp
  can overrun the end of the clip it lands on — pull it earlier so it finishes
  exactly on the cut rather than splitting it across two clips.

Final shape: **24 footage clips keyframed, 25 held static, 21 graphics placed.**
