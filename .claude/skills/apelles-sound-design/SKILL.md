---
name: apelles-sound-design
description: Add or change music and sound effects on an Apelles Edit timeline the way a sound editor would - an edited music bed with dropouts on story beats, sparse well-chosen effects, a levelled voice, a -14 LUFS master - sourcing only openly licensed audio (Openverse CC0 / CC BY via Apelles' MCP tools) with credits, picking sounds by measured character, and checking the mix with a measured report plus five moments to listen to. Use whenever a task involves music, a soundtrack, SFX / sound effects, whooshes, risers, ducking, the audio mix of an Apelles project, or timing cuts / Motion moves to the beat of the music. Not for voice clean-up or retake cutting (apelles-retake-review), and not for grading.
---

# Apelles sound design

What this is: the checked-in sound-design playbook for agents driving Apelles over MCP. It
encodes a measured reference (`docs/notes/reference-teardown-lewis-jackson-polymarket.md`), the
lessons from the 2026-10-26 Black October edit, and the good ideas from third-party SFX tools
(sounds chosen by measured character because the agent cannot hear; a measured QA report naming
moments for a human to check by ear). D-406.

What it does NOT do:

- It adds no app capability. Every action goes through Apelles' own MCP tools, so the result is
  editable clips on the timeline, never effects baked into a rendered file.
- It does not judge taste on its own. It proposes, measures and reports; a person listens and decides.
- It never uses audio whose licence it has not checked (see section 2).

## 0. Prerequisites

- The Apelles app is running with the project open, and the `chroma` MCP server is connected.
  If a tool was added since the session started, run `/mcp` to reconnect; never kill the server.
- Python 3 with `numpy`, and `ffmpeg` on PATH, for the two scripts in `scripts/` (the repo's
  `ai-env/.venv/bin/python` has numpy).

## 1. The house style (measured, not guessed)

From the teardown of a 105k-view explainer and our own Black October feedback:

1. **The voice is the lead.** Level it so every word lands at one level (that reference: loudness
   range ~2.6 LU on the voice alone).
2. **The music bed sits ~19 dB under the voice** while it speaks. In Apelles that is the bed's
   clip `volume` plus `set_track_duck(track, duck_from=<voice track>, duck_db=-14 .. -19,
   attack_ms ~50, release_ms ~700)`. Start conservative (quieter); owners ask for "less music"
   far more often than "more".
3. **Edit the music; don't just lay it under.** The strongest tool is the dropout:
   - **dry cold open:** no music for the hook (first 5-25 s); bring it in on the turn
     ("…but the strategy never was"), on a picture cut;
   - **drop for the punchline / big reveal:** cut the bed just before it, bring it back on the next line;
   - **1 s stop-time breath** right before naming the product or the key idea;
   - **calls to action are dry:** no bed under a CTA or sponsor read;
   - **section closers:** out after a verdict line, back in on the next question.
   Make dropouts with the music-edit tools (D-408), never by hand-razoring the bed:
   - **cut the voice first, then score it:** fillers, retakes and pause tightening
     (`editor_cut_words`, `apelles-retake-review` §5) ripple the voice, so every word
     index and frame a music edit was anchored to moves. Finish the word edit, then read
     the view and place the music;
   - read the VOICE track with `editor_get_word_transcript {track: <voice>}` and keep its
     `viewId`; anchor each beat to word indices so it lands on the words, not on a guess
     (`include_timeline: true` adds each word's timeline frames);
   - **propose the set for review:** `editor_propose_music_edits {track: <bed>, word_track:
     <voice>, view_id, edits: [...]}`, each edit `{kind, reason, <one anchor>}` with `kind`
     `dropout` | `breath` | `dry_open` | `dry_cta` | `section_out` and the anchor
     `first_word` + `last_word` (music out over those words: a punchline, a big number, a
     CTA), `before_word` (+ `length_frames`, default 1 s: a stop-time breath, music back ON
     that word) or `start_frame` + `end_frame`. Give every edit a `reason`. Nothing is cut;
     the person reviews them in the Edit tab's **Music edits** panel (accept / reject /
     nudge / play from just before) and applies them as one undo step;
   - `editor_list_music_edits` reads their review back; `editor_apply_music_edits {track,
     include_pending: true}` applies your proposals only when they ask you to;
   - `editor_music_edit` applies a single edit at once (same fields) when they ask for one.
   Defaults: fade out 6 / fade in 8 frames, `mode: "continuous"` (the bed comes back where
   it would have been, so its beats stay on the picture). A range with no music under it,
   or one that would remove the whole bed, is refused with the reason.
4. **Effects are sparse and purposeful.** One effect per real visual event (a chapter card, a
   number landing, a twist), not one per cut. The reference used almost none. Owners on Black
   October called a dense, loud effects pass "too loud" twice. Defaults that were accepted:
   effects tracks ducked 6 dB under the voice; whoosh 0.25, paper 0.12, marker/pen 0.08, pop
   0.35, impact 0.3-0.45 linear clip volume. Start there or lower.
5. **Hook:** a short riser that resolves on the first beat change (~3 s) works; keep it under
   the voice, not over it.
6. **Master at -14 LUFS / -1 dBTP** for YouTube with `editor_export(loudness_preset="youtube")`
   (D-401), never by hand.

## 2. Sourcing: open licences only, always credited

- Search with `editor_search_audio(query, kind="sfx"|"music", min_secs, max_secs, …)`; import with
  `editor_import_audio(openverse_id, track?, start_frame?)`. Both record the credit in the
  project's `assets/audio/CREDITS.json`; `editor_get_credits` returns paste-ready description text.
- Accept **CC0** and **CC BY** only (the tools' default). Never NC (no commercial use: a monetised
  channel or a paid client video breaks it) or ND. CC BY requires the credit line in the
  video description; say so in your report.
- Openverse can be slow (34 s for one search was measured); the client waits up to 90 s of
  silence (B-275). Do not hammer it with retries.
- **Content ID check before using music on a YouTube video** (2026-10-28: a Pixabay jazz track, "Blue Note Bounce" by AurecTheme, drew a Content ID claim on the owner's upload despite the Pixabay licence). Some Pixabay / royalty-free artists register tracks with Content ID through distributors. Before placing a non-CC0 music track for a YouTube upload: check the track page for a Content ID notice and prefer tracks that say they are not registered; prefer CC0 / CC BY beds from Openverse; and tell the person, if the track IS registered, that YouTube may claim it and how to clear it (dispute with the licence link, or the library's own claim-clearing / whitelist).
- Prefer, in order: the project's existing `assets/audio/`, then Openverse, then other open
  libraries the person supplies (Freesound, Pixabay, Sonniss GDC bundles; check each licence).
  Never download from a source whose licence you cannot state.

## 3. Choose sounds by measured character, not by title

Titles lie ("Highlight" was a harp sting; "Bubble Pop" measured -70 LUFS). Measure candidates
before placing them:

```
ai-env/.venv/bin/python .claude/skills/apelles-sound-design/scripts/sound_character.py <files…>
```

It prints duration, loudness (LUFS), true peak, attack, tail, brightness and a kind guess (click,
whoosh, impact, riser, bed). Use it to: trim a clip to its useful part (`source_start` /
`duration`), pick the variant whose attack matches the visual (fast attack for a cut, slow for a
reveal), set volume from the measured loudness rather than a guess, and reject near-silent or
clipping files.

## 4. Placing it in Apelles (and reading it back)

- Effects go on their own audio tracks, by role (transitions / accents / pen strokes), so levels
  and ducking are set per role. Two clips cannot overlap on one track; trim to the next event.
- Create a track and place the first clip before anything else can prune it as empty. Omitting
  `track` on `editor_add_clip` appends a new track of the right kind (B-273).
- **Read every change back** from `editor_get_timeline` (volumes, fades, ducking) before reporting
  it done. Count clips per track and compare with what you meant to place.
- Never edit `packages/` or a Motion manifest while a Motion render runs.

## 4b. Motion and cuts to music (D-413)

"Music sets pacing and mood; tell the agent which beats the big move should hit." When the music
drives the picture rather than sitting under it:

- **Pick the track first, then time to it.** The tempo decides the pacing (an airy 72 BPM and a
  punchy 128 BPM make the same shapes feel different), so choose and set the music before timing
  anything. Motion: `motion_set_soundtrack(path=...)` (one track for the whole document, `offset`
  = where in the song the video starts). Edit: `editor_detect_beats(track=<music track>)`.
- **Read the beats before choosing cues.** `motion_get_beats(scene_index)` / the `beats` of
  `editor_detect_beats`: tempo, bars, which beats are strong. If the tempo is half or double what
  you hear in the genre, pass `tempo_hint` / `tempo_hint_bpm` and re-read. Downbeats are a
  heuristic: on music without clear bar lines, check the first few by ear (or the waveform).
- **Big moves on downbeats.** The hero reveal on `downbeat 1`, the scale-up LANDING (`anchor:
  "end"`) on the `next strong beat`, a scene change on a bar line. `motion_time_to_music` takes
  the whole set as named moves in one call (one undo step); cuts on the Edit timeline go there with
  `editor_snap_cuts_to_beats` (rolls, so nothing else moves).
- **Accents on beats, not every beat.** Smaller moves (`every beat between reveal and scale`) on
  the beats between the big ones. Leave space: a move on every single beat reads as a metronome,
  not as edited. Two or three accents per bar at most; let some bars breathe.
- **Read back.** `motion_get_beats` + `motion_get_manifest` (or `editor_get_timeline`) after
  timing; preview a still at a downbeat (`motion_preview_frame`) to see the move landed.
- The soundtrack is a timing reference: `render` stays false when the scenes are cut together
  under one bed on the Edit timeline (where the mix, ducking and loudness of section 1 apply).

## 5. Check the mix: measured report + five moments to listen to

After placing audio (and after an export), run:

```
ai-env/.venv/bin/python .claude/skills/apelles-sound-design/scripts/sound_qa.py \
    --project "<project>.chroma" [--export <rendered.mp4>] [--voice-track N]
```

It reports per-role clip counts and levels, effects density per minute, music coverage and every
dropout, ducking settings, and (with `--export`) integrated loudness / true peak against -14 LUFS
plus moments where effects poke above the voice. It ends with **five timestamps to check by
ear** and why. Put that list in your reply. You cannot hear the mix; the person can, in five
quick listens.

## 6. Report

Say what you placed (per role, with counts and levels), what you sourced and its licences, the QA
numbers, the five listen moments, and any CC BY credits the description needs.
