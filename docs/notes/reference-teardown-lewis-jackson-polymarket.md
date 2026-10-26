# Reference teardown — "I Reverse Engineered 3 Polymarket Bots That Made $4.3M"

Lewis Jackson Investing (243k subscribers), uploaded 2026-10-20, 15:49, 105k views / 2.4k likes
after 6 days. Studied 2026-10-26 at the owner's request ("analyse the sound design and pattern and
visuals … create a script to create such videos"; "what I'm interested in is the sound design itself
and cuts in sound design"). Purpose: a measured reference for the founder/brand-video studio templates the
owner wants Apelles to produce (owner, 2026-10-26) and for the music-editing features proposed at the end.

**Method (reproducible).** `yt-dlp` 720p; ffmpeg scene detection (`select=gt(scene,0.30)`) for hard
cuts; Demucs 4.1 `htdemucs --two-stems=vocals` to split the voice from music+effects; ffmpeg
`ebur128` for loudness; librosa (50 ms RMS) for music presence, dropouts and transients; the
ai-media Parakeet sidecar for the transcript. Scratch material (stems, contact sheets, transcript)
lives in the session scratchpad and is not committed. **Limits:** a two-stem split cannot separate
music from sound effects; the "music presence" map treats both as one stem.

## 1. Sound design — the main finding

| Measure | Value |
|---|---|
| Full mix | **-14.0 LUFS** integrated, -0.9 dBTP, LRA 2.9 LU (YouTube's level) |
| Voice stem | -14.2 LUFS, **LRA 2.6 LU** (heavily levelled/compressed; every word lands at one level) |
| Music + effects stem | -25.9 LUFS, **LRA 18.8 LU** (extremely dynamic: it comes and goes) |
| Music under speech | median **~19 dB below the voice** (deeper than the -14 dB duck used on Black October) |
| Music on screen time | 73% of the runtime, in **22 separate stretches**, with **32 dropouts of 1 s or more** |
| Speech | 197 words/min, only 6 pauses over 0.6 s (jump-cut tight) |

**The music is edited, not laid under.** It stops and restarts on story beats. The rules, each
observed at the listed timestamps:

1. **Dry cold open.** 0:00–0:24 has no music at all: voice and graphics carry the hook. The music
   enters on the turn ("…publicly available to be seen. ‖ But the strategy never was"), on a cut.
2. **Drop for the punchline.** Music out at 0:42.9 just before "Oh, reverse engineering. That'll
   work." and back in 2.3 s later on the next line. Silence is the rimshot.
3. **Drop to reset for a thesis line.** Out at 1:12.4 on "So here's the mission."
4. **Silence under the big reveal.** 5:21.6–5:33.9: "It was entirely skill. The chances of flipping
   a coin … 113 times" plays dry, so the number lands; the music returns on the next question
   ("So, does it still work?"), on a cut.
5. **One-second stop-time breaths at turns.** 1:27.4, 2:43.3 (right before naming the product, "Bot
   X-Ray"), 5:38.1, 8:42.7: a ~1 s stop, then the same bed resumes.
6. **Calls to action are dry.** 6:00–6:48 ("get the strategies free"), 10:38–11:13, 11:26–11:44,
   12:51–13:03: every CTA/product section has no music, so it reads as personal and direct.
7. **Section closers.** Out after "…dead and done" (8:02.5, "two kings down"), back in on the next
   question.
8. About half of all music in/out points coincide with a picture cut; the rest sit on sentence
   boundaries inside a shot.
9. **Discrete sound effects are sparse.** Transients in the music+effects stem are not synced to
   on-screen motion (52% land on motion vs 50% for random moments) and are mostly long and low,
   i.e. musical events. If there are whooshes/pops, they are few and quiet. The closing bed runs at
   ~123 BPM.

**Lesson for Apelles' house style:** silence and music dropouts do more work than effects. Black
October (2026-10-26) used continuous beds plus ~300 effects; this reference uses an edited bed,
~19 dB under a levelled voice, and almost no effects.

## 2. Picture

- **A/B grammar.** Talking head in a home office (two outfits, so two shoot days) alternating with
  full-screen graphics on an **off-white grid-paper background, black ink and a single blue accent**.
  The presenter often sits in a small picture-in-picture corner over data graphics.
- **Graphic vocabulary:** big number counters (41 → 111 "green days in a row"); line charts drawing
  on; a UI toggle ("0.5-second delay" on/off) to show the rule change; playing cards #1/#2/#3 with
  crowns; trade tables with a highlight box; a dot plot accumulating (1,270 trades); doodle
  characters (money-bag bots with crowns); sketchy line icons (price tag, bank, formula); pill
  buttons for "the 3 questions"; blurred-text teaser cards; ≠ comparison cards; a single-word kinetic
  title card ("Reverse engineering"); screenshots with a text highlight (YouTube, GitHub); sketch
  wireframes of the tool; product UI screenshots; CTA cards with QR codes. **Handwritten blue
  annotations** ("not one losing day", "over $4 million", "options pricing") are the signature.
- **Credibility:** tiny grey source captions on every data graphic.
- **Pacing:** 125 hard cuts (one every 7.5 s on average), but one every 3.3 s in the first minute,
  and graphics animate inside shots, so something changes every 1–3 s throughout.

## 3. Structure (from the chapters and transcript)

| Time | Beat |
|---|---|
| 0:00 | **Hook:** a concrete stat plus a twist ("profitable 111 days in a row … then a single setting killed it"), the stakes ($4M), the gap (trades public, strategy secret, paywalled), the method (AI reverse engineering, a live trend), the promise ("strategies for free"). |
| 1:12 | **Mission statement** (one sentence). |
| 1:21 | Context in 20 s (how Polymarket works). |
| 1:43 | The cast (the 3 kings). |
| 2:13 | The tool he built (Bot X-Ray): proof of work. |
| 3:14 | **A 3-question framework** reused for every case: what does it do / skill or luck / does it still work. |
| 3:32, 6:40, 8:23 | Case #1, #2, #3, each run through the framework, each closing on a verdict line. |
| 6:01 | Mid-roll CTA: a free lead magnet (dry). |
| 9:07–12:00 | Deepening: odds, options pricing, the converter he built. |
| 12:32 | Payoff: the bot that still works. |
| 13:37, 14:44 | CTA, then the community/competition offer. |
| 15:18 | Ending on an engagement question ("what should I reverse engineer next?"). |

## 4. Script template (fill-in) — long form, this reference's shape

```
[HOOK 0:00-0:25 | dry, no music | one graphic per sentence | cut or motion every 1-3 s]
  <Specific number> + <surprising twist>.            e.g. "This bot won 111 days in a row. Then one setting killed it."
  <Who/what> + <stakes>.                             "It's one of three bots that made $4M."
  <The gap: what's public vs what's hidden>.
  <MUSIC IN on the turn>  "But <the hidden thing> never was."
[METHOD + PROMISE 0:25-1:10 | bed ~19 dB under voice]
  <The trend/method that unlocks it>  <MUSIC OUT -> punchline -> MUSIC IN>
  <What the viewer gets, free>.
[MISSION 1:10 | MUSIC OUT for one line]  "So here's the mission: <one sentence>."
[CONTEXT <=20 s] [CAST] [YOUR TOOL / PROOF OF WORK]
[FRAMEWORK: 3 questions, shown as 3 pills]
[CASES x3: each runs the framework; each closes on a verdict line, then MUSIC OUT]
  Big reveal stat: play it DRY; music back in on the next question.
[MID CTA ~40% in | dry] [DEEPENING] [PAYOFF] [CTA | dry] [ENGAGEMENT QUESTION]
```

**Founder product video (60–120 s), the same rules compressed:**

```
0-5 s    dry hook: the customer's painful number ("Your team loses 9 hours a week to X").
5-15 s   MUSIC IN on the turn: "<Product> fixes that." Logo + one-line promise.
15-60 s  3 features as the "3 questions" pattern: one pill/card each, one proof each (UI clip
         with a highlight, a counter, a before/after); a 1 s music stop-time before the best one.
60-80 s  proof: a customer quote or metric, played DRY.
80-90 s  CTA, dry: offer + URL/QR end card. Optional bed swell under the logo out.
Mix: voice levelled (LRA ~3 LU), bed ~19 dB under, effects sparing, master -14 LUFS / -1 dBTP.
```

## 5. What Apelles can already do, and the gaps this exposes

**Can do now:** VO clean-up and retake cuts; screenshots with highlight sweeps (D-396/D-397);
Motion text/graph/plot/matrix scenes in a light theme (D-399); music beds with track ducking;
licensed music/SFX search and import (D-400); a -14 LUFS master (D-401).

**Gaps:**
1. **Music editing by story beat**: dropouts, stop-time breaths and re-entries placed at transcript
   words (e.g. `editor_music_dropout(track, at_word | frames, length, fade_ms)` or a "music edit
   from markers" pass), with the same op in the GUI. Today each dropout is manual razor and fade work.
2. **Voice levelling** to a narrow loudness range (a compressor/leveller on the VO track) before the
   master normalisation.
3. Motion primitives this style needs: number **counter**, **image/icon/shape**, **handwritten
   annotation** (a hand-drawn underline/arrow plus a handwriting-font label), **picture-in-picture**
   presenter, a toggle/UI widget. See `motion-authoring-mcp.md` for the plan that makes these data,
   not code.
4. **Scene templates** for the beats above (hook stat, 3-pill framework, verdict card, dry CTA end
   card), so an agent fills slots instead of rebuilding each scene.
