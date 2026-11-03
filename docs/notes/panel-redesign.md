# Panel redesigns: Clipper, Music edits, Inspector Audio + EQ, Inspector Video sections, Export

**Status: mockups ready for owner approval (2026-11-03). No app code yet.** This is the
research → mockup step of the D-432 flow for the five panels the owner called unintuitive
on 2026-11-01: B-363 (Clipper), B-364 (Music edits), B-365 (Inspector Audio + EQ), B-366
(Inspector Video sections) and B-367 (Export). Roadmap 00r (v0.3.0) item (b): "panel research
+ mockups → owner approval → build". Each panel gets its own `D-NNN` when the owner approves
its mockup; the build follows that decision.

- **Mockup:** `scratch/panel-redesign-mockup.html`. One self-contained page, a tab per panel,
  a state switcher per tab, and the real interactions (approve / skip a short with A / X; pick a
  music-edit kind and watch the fade diagram and the timeline range; drag EQ points over a live
  biquad response; open and close Inspector sections; pick an export preset). Tokens are the
  real `@apelles/tokens` values (dark and light, `packages/tokens/src/themes.ts`, terracotta
  accent per D-432); type, spacing, rows and sections follow the approved
  `scratch/ui-redesign-mockup.html` and `ui-redesign.md` §3 / §4.10. Icons are Phosphor's web
  package from unpkg (`@phosphor-icons/web@2.1.1`, the same as the approved mockup); no
  hand-drawn icons. The EQ curve, fade diagram, waveforms and crop / zoom previews are data
  plots drawn from the values, not icons.
- **Screenshots:** `scratch/panel-redesign-reference/shots/<panel>-<state>.png` (17 dark
  states, 5 light), taken with headless Chromium (Playwright, installed in the session
  scratchpad and removed afterwards). The page takes `?state=<state>&theme=<dark|light>#<panel>`
  so any state can be re-shot.
- **References:** `scratch/panel-redesign-reference/<panel>/` (fetched 2026-11-03, sources
  below), plus the earlier sets this builds on: `scratch/clipper-reference/NOTES.md` (D-411),
  `scratch/music-edit-reference/notes.md` (D-408), `scratch/resolve-reference/` (D-232 era).
  `scratch/` is gitignored. These files were produced in the worktree
  `agent-abc21f0c7f9916b8f`; the reference folder was also written to the main checkout's
  `scratch/`.

**The same rules apply to all five** (from the bug entries, `ui-redesign.md` and CLAUDE.md):
plain words with units everywhere (px, %, °, s, Hz, dB, LUFS); no raw ids, enum names or
pipeline state on screen; every control labelled or with a tooltip; a collapsed section says
its state; previews before an action that is not obvious; panes that hold review content are
sized for it, not squeezed into the 280 px browser column; **the GUI changes, the data model
and the ops do not** (except where a row below says "model change"). Human + AI parity is
checked per panel.

## References used (all fetched 2026-11-03 unless noted)

| Panel | Source | What it showed | Saved as |
|---|---|---|---|
| Clipper | Opus Clip help, *Result Page Walkthrough* (`help.opus.pro/docs/article/get-clips-faq-1.md`) | Per-clip result page: title, like / dislike, 9:16 preview, transcript, actions (Edit clip, aspect, Schedule, Download HD, Export XML); sort by score or by order in the source; disliked clips hidden | `clipper/opus-get-clips-faq-1.md`, `clipper/opus-img-2.png` |
| Clipper | Opus Clip help, *Virality Score* | 0–99 score from Hook, Flow, Value, Trend; grid / list views; sorted by score by default | `clipper/opus-virality-score.md`, `opus-img-*.png` |
| Clipper | Opus Clip help, *Trim the clip or add new sections* and *About the result clips* | Trim and "add a section" from the original; how many clips per source length | `clipper/opus-944*.md` |
| Clipper | Descript help, *Create clips from your content* (`help.descript.com/repurpose/create-clips-from-your-content.md`) | Number of clips 1–20, length 10 s–5 min, layout, optional topic; each clip is its own composition in a "Clips from …" folder | `clipper/descript-create-clips.md` |
| Clipper | D-411 research (2026-10-27): Riverside Magic Clips, CapCut, Vizard, Premiere Auto Reframe, FCP Smart Conform | Review is hover-preview-edit-export; complaints are about the cut, not the pick | `scratch/clipper-reference/NOTES.md` |
| Music | Adobe help, *Remix tool considerations* (`helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/remix-tool-considerations-in-premiere.html`) | Remix analyses beats, works to a typed **target duration** (within 5 s, typically 1 s); Essential Sound panel holds the settings | `music/adobe-remix-considerations.{html,txt}` |
| Music | D-408 research (2026-10-27): Premiere Remix (marks its edits on the clip), Resolve Fairlight batch fades (length in frames, remembered), Descript edit-by-text | | `scratch/music-edit-reference/notes.md` |
| Audio + EQ | Blackmagic, Resolve Edit page feature "Create a Final Audio Mix" (scraped 2026-09-08) | Inspector Audio tab: Clip Volume, Clip Pan, Clip Pitch, Clip Equalizer; graph with ±24 dB and Hz axes; numbered points; a Band 1–4 strip where the band button is its on / off, with a shape menu under each | `audio-eq/resolve-soundtrack.jpg` |
| Audio + EQ | DaVinci Resolve Club, *Fairlight EQ: Clean Dialogue* (cites the Resolve 21.1 Reference Manual pp. 930–931, 3949–3952) | Clip EQ vs track EQ; Band 1 high-pass, Band 6 low-pass, middle bands shelf / bell / notch; lower Q = wider; dialogue areas (warmth 200–500 Hz, mud 250–750 Hz, presence 2–5 kHz, sibilance 5–8 kHz) | `audio-eq/resolveclub-fairlight-eq-dialogue.md` |
| Audio + EQ | Apple Final Cut Pro guide (search results) and Larry Jordan, *How to use EQ to improve your audio* | FCP Audio inspector: Equalization pop-up of presets (e.g. Voice Enhance) plus a Controls button for manual bands; Channel EQ: drag a dot up / down for gain, sideways for frequency, Q sets width | (pages 403 / summarised in this note) |
| Audio + EQ | Premiere Parametric Equalizer (third-party guides; Adobe help 403) | Presets dropdown on the effect (e.g. "Vocal Enhancer") | (summarised here) |
| Inspector Video | Resolve Edit page features *Dynamic Zoom* and *Dramatic Speed Ramps* | Start / end boxes in the viewer; a speed-change bar cut into runs with a % each | `inspector-video/resolve-dynamic-zoom.jpg`, `resolve-speed-ramps.jpg` |
| Inspector Video | DaVinci Resolve Club, *Inspector* (Resolve 21 manual p. 441) | Video tab sections: Composite, Transform (Zoom, Position, Rotation, Anchor, Pitch, Yaw, Flip), Smart Reframe, Cropping (Left / Right / Top / Bottom), Dynamic Zoom, Stabilization, Speed Change, Retime and Scaling | `inspector-video/resolveclub-inspector.md` |
| Inspector Video | Apple FCP guide, *Spatial Conform* and *Distort* pages | Video inspector via ⌘4, sections with a Type pop-up (Fit / Fill / None); Spatial Conform hidden when the clip already matches | (summarised here; `ui-redesign.md` §1.1 has the rest) |
| Export | Apple support 102366, *Share to social platforms from Apple video apps* | FCP: Share → Social Platforms; **Info** (name, description, …) and **Settings** (resolution, compression, captions); then the user uploads by hand in a browser | (summarised here) |
| Export | Blackmagic, Resolve Edit page feature "Deliver for Web, Broadcast or Cinema" | Quick Export: one-click popular presets; with account info it renders **and uploads** to YouTube, Vimeo or Dropbox; custom presets saved from Deliver appear in Quick Export | `export/resolve-deliver.jpg` (feature text in `scratch/resolve-reference/resolve-edit-features.json`) |
| Export | Adobe help, *Export video* (403; search snippets) and Adobe's Quick Export tutorial | Export mode posts directly to Facebook, TikTok, YouTube with platform-tuned settings; Quick Export button top right with common presets | (summarised here) |
| Export | CapCut help, *How do I export 2K / 4K videos* | Desktop export: Resolution, Frame rate (up to 60), Bitrate; 2K / 4K only when the project is that size | `export/capcut-help-export.txt` |
| Export | Opus Clip help, *Schedule clips*, *Customize my posts*, *Add social accounts*, *Connecting your Instagram account* | Connected accounts, per-post caption / hashtags, scheduling; Instagram needs a Business / Creator account | `export/opus-*.md`, `export/opus-img-*.png` |
| All | Cardboard export dialog, Palmier Pro (from D-432) | One bold title, segmented choices, cards, one primary button | `scratch/ui-redesign-reference/cardboard/first-image-4.png` |

Adobe helpx pages and FCP's Video-inspector page returned 403 / truncated content to the
fetcher; where a row says "summarised", the claim comes from search snippets or a secondary
source and is marked as such above.

---

## 1. Clipper (B-363)

### What's wrong today

The owner: "clipper UI is not intuitive at all" (`scratch/bug-refs/2026-11-01-clipper-not-intuitive.png`).
`packages/editor/src/clipper/ClipperPanel.tsx` puts the whole flow in the 280 px browser
column: a "Run" picker labelled with a timestamp; a metadata paragraph of pipeline state
("4 sentences · 1 topics · 2 clean windows · audio done, picture idle"); proposal rows with
sentence ids (`S0–S38 · 56.0 s`) and six unlabelled icons (`‹ › | ‹ ›`, crosshair, open);
"Build 0" as a disabled button whose label is a count; "Clean windows (evidence, not picks)"
with tags like `short (4w) · lands (end) · fast 1.3x`; no preview of a short.

### What the references do

Opus Clip gives each clip its own result row: a title, like / dislike, a 9:16 preview, the
transcript, and the actions beside it; disliked clips hide; sort by score or by source order.
Descript makes each clip a composition in a "Clips from …" folder and reviews it in place.
Every tool's top complaint is the cut (mid-sentence starts, lost punchlines), which is why
D-411 has a clean-cut gate.

### Proposed design (mockup tab "Clipper", 4 states)

- **The browser's Shorts tab becomes a list** of one card per short: a 9:16 poster with its
  length, the title, the opening line, and chips for the clean-cut check ("Clean cut",
  "1 warning", "Needs a fix") and the status ("Approved", "Skipped"). Above it, the set picker
  reads "Shorts from Voiceover v2 · 30 Oct" with a one-line state ("Ready · 30 s and 60 s ·
  Vertical 9:16"). Below it, a count ("2 approved · 1 skipped · 2 to review"), "Approve the
  rest", and the build button labelled with what it does: **"Make 2 shorts"**; disabled with
  "Approve at least one short (A) to make it."
- **Selecting a short fills the viewer area** with a review surface (Shorts tab active only;
  the Inspector stays): a 9:16 player with captions, the title (renamable), the length against
  the target, where it comes from ("from 3:12 to 3:54 in Voiceover v2"), the check as a
  sentence; two boxes **"Opens with"** (the hook line) and **"Why your agent picked it"**; a
  warning in words ("Covers two topics … try ending one sentence earlier", "Starts
  mid-thought … press Start › Earlier"); **"What's in it"**: the transcript with left-out
  sentences crossed out, the opening line tinted and trimmed pauses as chips; labelled trims
  **Start ‹ Earlier / Later ›** and **End ‹ Earlier / Later ›** ("moves by whole sentences");
  **Skip (X)** and **Approve (A)**, ↑ / ↓ between shorts.
- "Other moments the analysis found" (today's candidates) and "Details" (today's status
  paragraph) are collapsed disclosures.
- **New shorts** is a centred form in the same area: From, Length chips (15 / 30 / 60 / 90 s),
  How many, Frame as three shape buttons (Vertical 9:16, Square 1:1, Portrait 4:5), Captions,
  About (the focus, optional), "More options" (strongest line first, trim long pauses, leave
  out flubbed takes, only from … to …), **Find moments**.
- **Reading** shows a progress bar and four steps in words; **Waiting for your agent** keeps
  today's copy-the-request block, reworded ("suggest 5 shorts (30 or 60 s) from 'Shorts from
  Voiceover v2'").

**Why:** reviewing several 9:16 shorts needs width and a picture; the person decides from the
opening line, the reason and the cut, not from sentence ids. A / X keyboard review is the
"review board" D-411 planned for Phase 4.

### Capability map (nothing lost)

| Today | New place |
|---|---|
| Run picker (New run / each run, built count) | Set picker "Shorts from <source> · <date>" + **＋** (new) |
| Load-error line | Same, as a notice under the picker |
| Notice row (dismissable) | Same |
| Setup: Source, Lengths chips, Shorts count, Frame, Captions, Focus, Analyse | New shorts form: From, Length, How many, Frame (shape buttons), Captions, About, **Find moments** |
| Status paragraph (source, settings, sentences / topics / windows, audio / picture pass, transcribing x / y windows) | One-line state under the picker + Reading steps + "Details" disclosure |
| Proposal row: title, gate verdict, reason, hook line, gate notes | Card (title, hook, check chip, status) + review head (check as a sentence) + "Opens with" / "Why your agent picked it" + warning notice |
| `S0–S38 · 56.0 s` | Length in seconds against the target, and "from 3:12 to 3:54" |
| ‹ › start, ‹ › end (`extendStart` / `extendEnd`) | Start ‹ Earlier / Later ›, End ‹ Earlier / Later › |
| Crosshair (jump to source) | Crosshair in the player bar, "Show this moment in the source timeline" |
| Accept / reject toggles | Approve (A) / Skip (X), with "Undo approve / skip" |
| Open built short | "Open" on a made card (same `openShort`) |
| Build N | "Make N shorts" + "Approve the rest" |
| AskAgent block with Copy | "Waiting for your agent" state, same block |
| Candidates by topic with All / 30 s / 60 s filter and jump | "Other moments the analysis found" disclosure (filter kept inside it) |

### MCP parity

The data and ops are unchanged (`editor_auto_clip`, `editor_auto_clip_status`,
`editor_list_clip_proposals`, `editor_propose_clips`, `editor_set_clip_proposal`,
`editor_build_clips`). Gaps, both directions:

- **GUI catches up with MCP:** rename (`editor_set_clip_proposal title`), "More options"
  (`hook_first`, `tighten_dead_air`, `tighten_retakes`, `range_start_s` / `range_end_s` of
  `editor_auto_clip`) existed only for the agent; the design adds them.
- **Still MCP-only after this:** word-level trims (`word_start` / `word_end`), `clear_hook`,
  and `editor_build_clips`' `mode` / `export_dir` / `loudness_preset` (build-and-export).
  Open question 1.4.
- **"Suggest as a short"** on an "Other moment" would create a person-picked proposal
  (`picked_by: "person"` exists in `ClipProposal`) through the gate. There is no op for it
  today, and D-411 says the panel never picks; a person picking is not the app picking, but
  it needs the owner's call (1.2) and a matching MCP-visible state.
- Keyboard review (A / X / ↑ / ↓) needs no MCP: it is the same `setClipProposal` status write.

### Open questions

1. **Review surface placement:** fill the viewer area while the Shorts tab is active (mocked),
   or a separate full-window "Shorts" view (Opus Clip's result page)?
2. **"Suggest as a short"** from the candidates: allowed (person-picked, gated), or keep
   candidates as evidence only (D-411's line)?
3. **A score:** Opus Clip sorts by a 0–99 score. Apelles shows reasons, not a score (D-411).
   Keep it that way?
4. **"Make and export"** in the GUI (MCP's `editor_build_clips mode`)?

---

## 2. Music edits (B-364)

### What's wrong today

The owner: "this needs an intuitive redesign as well"
(`scratch/bug-refs/2026-11-01-music-edits-not-intuitive.png`). `MusicEditsPanel.tsx`: "Fades
`6` out `8` in" (frames, unlabelled, out before in); "Bed: Auto — the track with music there";
"Re-entry: Re-enter where it would be"; "In —" / "Out —" pills that are really buttons;
a "Dropout" dropdown without descriptions; "Cut now" vs "Add to list" vs "Breath before
playhead" unexplained; the empty state is a paragraph.

### What the references do

Premiere's Remix marks each edit on the clip and works to a typed target duration with its
settings in one panel (Essential Sound). Resolve's Fairlight batch fades are stated with
remembered defaults. Descript makes the transcript line the selection (already used by
D-408's right-click entry).

### Proposed design (mockup tab "Music edits", 3 states)

Top to bottom, in the order of use:

1. **Music track:** `A3 · Electronic Vibrations` (track id and its music's name; the picker
   keeps an "Automatic: the track with music under the range" entry, worded like that).
2. **What kind:** five rows, each with an icon and one line: *Dropout* ("the music fades out
   and comes back after a moment"), *Breath before a line* ("about 1 s of silence, so the next
   line lands"), *Quiet opening*, *Quiet call to action*, *End of a section*. (Renames: "Dry
   cold open" → "Quiet opening", "Dry call to action" → "Quiet call to action", "Section
   closer" → "End of a section", "Stop-time breath" → "Breath before a line"; the stored kind
   ids stay.)
3. **Where:** "Music stops at 1:12.40 [Playhead]" and "Music returns at 1:15.10 [Playhead]"
   (I / O keys). The range is drawn on the music lane while it is being made (amber box with
   "Dropout · 2.7 s").
4. **Fades in seconds, in time order:** "Fade out before 0.20 s" then "Fade back in after
   0.27 s", with a live diagram (level line, fade ramps, "silent 2.7 s").
5. **When the music comes back:** two described choices, *Carry on as if it never stopped*
   ("the song keeps its timing; the part under the gap is skipped") and *Pick up where it
   stopped* ("nothing is skipped; the rest of the song plays later").
6. **Preview** (plays from 2 s before), **Apply** ("cuts the music now, one undo"), **Save for
   later** (into the suggestions list). "The fade lengths and the choice above become the
   defaults for your next edit." A quiet "1-second breath before the playhead" shortcut.

**Suggestions from your agent** replace the review list: per row the kind, the quoted line,
why, `1:12.40 → 1:15.10 (2.7 s)`, a problem line in words when it cannot land, Preview / Change
(pencil) / Approve / Skip; "Approve all", "Dismiss" (nothing on the timeline changes), the
stale-voice warning, and **"Apply 2 approved · one undo"**. Suggested ranges are hatched on
the music lane. **Empty state:** one sentence of purpose and a primary "Music stops at the
playhead (I)", plus the breath button.

**Why:** the panel's job is "silence the music here"; each control now says which part of
that it sets, in seconds, and the result is visible on the timeline before Apply.

### Capability map

| Today | New place |
|---|---|
| Bed (Auto / Track N · clip name) | Music track picker (`A3 · <music name>`, Automatic entry kept) |
| Fades out / in (frames) | Fade out before / Fade back in after (seconds; frames still typeable, e.g. `6f`) + diagram |
| Re-entry (continuous / pause) | "When the music comes back" two choices |
| In / Out buttons (read playhead once) | Music stops at / returns at, timecode + Playhead button, I / O |
| Kind dropdown | Kind list with descriptions |
| Cut now | Apply |
| Add to list | Save for later |
| Breath before playhead | Quick: 1-second breath before the playhead |
| Review set: Track N · n edits, Accept all, Dismiss, stale banner | "Suggested by your agent": Approve all, Dismiss, warning |
| Row: origin icon, kind, status, accept / reject, text, reason, start / end frames, duration, jump, audition, problem | Row: agent / you icon, kind + status chip, line, why, range as timecodes + duration, Preview, Change, Approve / Skip, problem in words; jump = click the range on the timeline |
| Apply N accepted | Apply N approved · one undo |
| Right-click a transcript line / marker (`MusicEditMenu`) | Unchanged |

### MCP parity

Ops unchanged (`editor_music_edit`, `editor_propose_music_edits`, `editor_list_music_edits`,
`editor_apply_music_edits`, all in frames). Seconds are display only. Notes:

- **Per-row fades and mode** (the pencil) use the store's existing `patchRow`
  (`MusicEditRowPatch` already carries `fadeOutFrames` / `fadeInFrames` / `mode`); the GUI never
  exposed them. MCP sets them per edit at propose time.
- **Existing gap, unchanged:** the agent cannot approve, skip or patch a row after proposing
  (no tool); by design the person reviews. Stated so it is a known choice, not drift.
- The defaults (fades, mode, track) are panel state (`useMusicEditStore.defaults`); MCP passes
  them per call. No change.

### Open questions

1. The renamed kinds ("Quiet opening", "Quiet call to action", "End of a section", "Breath
   before a line"): OK, or keep the reference teardown's terms?
2. Keep "Save for later" (a person-made row in the review list), or drop it and keep only
   Apply?
3. Should Preview audition the edit before it is applied (needs a non-destructive preview of
   the `music_edits` op), or play the current timeline from 2 s before (today's audition)?

---

## 3. Inspector Audio tab + EQ (B-365)

### What's wrong today

The owner: "EQ and audio as well" (`scratch/bug-refs/2026-11-01-eq-audio-not-intuitive.png`).
In `ClipInspectorPanel.tsx` the band-type select shows the raw value (`low_shelf`, `peak`): the
labels exist (`EQ_BAND_KIND_LABELS`) but the trigger's `<SelectValue />` renders the value.
Freq / Gain / Q have no units; the graph (`EqResponseGraph`) has no axis labels; four bands ×
three full-width rows make a 12-field list; the per-band bypass is the "Band N" label itself
(not obvious); the Audio section shows Volume as a 0–1+ multiplier and Pan as −1…1.

### What the references do

Resolve's Inspector Audio tab: Clip Volume and Clip Pan as sliders with keyframe and reset;
Clip Equalizer as a graph with +24 / +12 / 0 / −12 / −24 and Hz labels (62, 250, 1K, 4K, 16K),
numbered points, and a Band 1–4 strip whose button is the on / off with a shape menu below.
FCP's Audio inspector starts from an Equalization preset menu with a Controls button for the
bands; Channel EQ is driven by dragging dots (up / down gain, sideways frequency; Q = width).
Premiere's Parametric Equalizer has a presets dropdown.

### Proposed design (mockup tab "Audio + EQ", 2 states)

- **Header:** clip kind icon, name, duration (`0:12.07`). **Tabs:** Video / Audio / Speed /
  Info (B-359 item 1).
- **Level** (collapsed summary "−3.0 dB · Center"): Volume slider with a detent at 0 dB and
  the value in **dB**; a "Level now" meter (−9 dB); Pan slider reading **L 100 … Center … R
  100**; keyframe diamond and reset per row; the track-gain and pan-law note in one sentence.
- **Fades** (summary "In 0.40 s · Out none"): the same fade as the Video tab, in seconds, with
  the "picture and sound fade together" note.
- **Ducking** (summary "Track A1 ducks A3 by 12 dB"): read-only, since ducking is per track,
  with a link to the track menu.
- **EQ** (summary "Voice clarity · 3 of 4 bands on"):
  - **Presets** as chips: Flat, Voice clarity, Warm voice, Cut rumble, Reduce mud, Tame
    harshness, Music under voice; "Custom" once edited. A preset just writes the four bands.
  - **Graph** with Hz labels (20 … 20k) and dB labels (+24 … −24, 0 emphasised); numbered
    points; **drag** = frequency (and gain for shelves / bells), **scroll on a point** = width,
    **double-click** = gain to 0; a tooltip shows "3.5 kHz · +3.0 dB" while dragging.
  - **Band strip** (Resolve's): four tiles, each with a power button (on / off, keeps
    settings), "Band N", the shape name and its frequency; clicking a tile selects it.
  - **Selected band only:** Shape (Low shelf, Bell, High shelf, High-pass, Low-pass) with a
    one-line description; Frequency with slider and **Hz / kHz**; Gain in **dB** (shown "—"
    and disabled for pass filters, with the reason); **Width (Q)** with "wide ↔ narrow".
  - The "applied before volume, fades and ducking" note stays.

**Why:** the graph is the instrument; 12 equal fields hid which band does what. Units and
shape names answer "what is this?" without a manual.

### Capability map

| Today | New place |
|---|---|
| Audio: Volume (multiplier, keyframeable) | Level › Volume in dB (display `20·log10(v)`, 0 → −∞), same keyframes |
| Audio: Pan (−1…1, keyframeable) | Level › Pan, L / Center / R, same keyframes |
| Track gain / pan-law note | One-line hint under Level |
| EQ reset (remove EQ) | Reset on the EQ header (hover) |
| `EqResponseGraph` (draggable) | Same graph with axes, drag / scroll / double-click |
| Band N toggle (enabled) | Power button on each band tile |
| Band kind select | Selected band › Shape (word + description) |
| Freq / Gain / Q rows ×4, each with reset | Selected band's Frequency / Gain / Width rows with reset |
| Gain disabled for pass filters | Same, with the reason shown |
| "Applied before…" / "Every band is flat…" notes | Kept |
| (none) | **New:** presets, level meter, Fades and Ducking summaries (read existing data) |

### MCP parity

`editor_set_clip_audio` (volume, pan) and `editor_set_clip_eq` (band, kind, freq_hz, gain_db,
q, enabled, clear) are unchanged; dB / Hz are display. Gaps:

- **Presets** are GUI shortcuts for band values. For parity, either `editor_set_clip_eq` gains
  a `preset` name (resolved to the same four bands by one shared table) or
  `editor_get_capabilities` publishes the preset table so an agent writes the bands itself.
  Recommended: the `preset` parameter, one table in `eq.ts` used by both.
- **Level meter** reads what `editor_get_audio_level` already measures.
- Ducking stays on `set_track_duck`; nothing new.

### Open questions

1. **Presets:** are these seven the right starting set, and should a preset also set the
   clip's role (voice / music) for later features?
2. **Band count:** keep four bands (today's model; Resolve's Edit-page clip EQ has six), or
   add two outer pass bands later (model change)?
3. Should Fades live on the Audio tab too (mocked as a mirror of the Video tab's fade), or only
   on Video?

---

## 4. Inspector Video sections (B-366)

### What's wrong today

The owner: "all the things inside this as well"
(`scratch/bug-refs/2026-11-01-inspector-video-sections.png`, the eight collapsed sections).
Collapsed headers say nothing; inside, values are stored units (Position as a fraction of the
frame, Scale 1.0, Opacity 0–1, Crop 0–1, fades and highlights in frames, speed runs as source
frame numbers); Position X / Y are two rows; no sliders (B-359 item 2); Dynamic zoom is an
On / Off button and an ease name (`ease-in-out`); Highlights rows are unlabelled numbers and a
native colour well; the header has no duration and two tabs (B-359 item 1).

### What the references do

FCP's Video inspector: sections (Compositing, Transform, Crop, Distort, …) with reset and
show / hide on hover, values with units, Spatial Conform as a Type pop-up shown only when the
clip's size differs. Resolve's Inspector: Composite, Transform, Cropping, Dynamic Zoom, Speed
Change, Retime and Scaling; Dynamic Zoom's green / red boxes; a speed-change bar cut into runs
labelled with their percentage.

### Proposed design (mockup tab "Inspector: Video sections", 5 states)

- **Header** with the duration; **tabs** Video / Audio / Speed / Info.
- **Every collapsed header carries a summary**: Transform "110% · 0° · 48 px up",
  Compositing "100% · square corners", Crop "Left 12% · Right 12%", Dynamic zoom "Off" /
  "Push in · slow start and end", Highlights "2 marker sweeps", Fade "In 0.40 s · Out none",
  Keyframes "6 on this clip".
- **Transform:** Position as one paired X / Y row in **px**; Scale (%), Rotation (°) with
  sliders and a detent at the default; Size W / H with "Auto" and the link toggle; **Fit in
  frame** select worded "Fit: whole picture, may show bars" / "Fill: covers the frame, crops
  the edges" / "Native: the source's pixel size", with one hint line.
- **Compositing:** Opacity (%) and Corner radius (px), both with sliders.
- **Crop:** four fields placed around a frame preview (Top above, Left / Right beside, Bottom
  below) in **%**, the kept area outlined.
- **Dynamic zoom:** one-line purpose; a preview of the Start (green) and End (red) boxes on
  the clip's frame; Speed curve (plain names); "Edit boxes in the viewer" (today's arm toggle);
  "Reverse direction" (today's swap); the "already moves, will be replaced" warning in words.
- **Highlights:** Add at playhead, Suggest from the narration, Boxes shown (arm); per sweep:
  start and length in **seconds**, a colour swatch row (the marker palette) instead of a
  native colour well, Strength (%), remove.
- **Fade:** in / out in **seconds** plus a curve with plain names (*Even*, *Slow start*, *Slow
  end*, *Slow start and end*; "Custom (set by your agent)" when an MCP curve matches none).
- **Keyframes:** previous / next keyframe, "Key everything here", "Delete here", "Clear all".
- **Speed tab:** quick choices (50 / 100 / 200%, Custom ramp), the Resolve-style speed bar,
  one row per run with its **source time range** in seconds, %, Reverse (shows "Reversed"),
  remove; "Speed change at playhead"; the resulting clip length in words.
- **Info tab** (not mocked in detail): source file, resolution, frame rate, codec, source
  in / out, timeline position; read-only, from data the app already has.

**Why:** units make every number readable without knowing the model; summaries make the
"all collapsed" default (owner, 2026-11-01) informative instead of empty.

### Capability map

| Today (section › row) | New place |
|---|---|
| Transform › Position X, Position Y (fractions) | Transform › Position X / Y paired, px |
| Transform › Scale, Rotation, Corner radius | Scale (%), Rotation (°) in Transform; Corner radius moves to Compositing |
| Transform › Scaling (Fit / Fill / Native) | Transform › Fit in frame (same modes, worded) |
| Transform › Size W / H + link | Same, "Auto" when unset |
| Per-row keyframe slot (‹ ◇ › ∿ ↺) | Unchanged (`InspectorRow` slot) |
| Compositing › Opacity (0–1) | Compositing › Opacity (%) |
| Crop › left / right / top / bottom (0–1) | Crop around a frame preview (%) |
| Dynamic zoom › Show boxes On / Off | "Edit boxes in the viewer" |
| Dynamic zoom › Ease | Speed curve (plain names) |
| Dynamic zoom › Swap start / end | "Reverse direction" + swap icon on the row |
| Dynamic zoom notes (how-to, replace warning) | Purpose line + preview + warning |
| Highlights › Add at playhead, Suggest from transcript, Edit boxes | Same three (renamed "Suggest from the narration", "Boxes shown") |
| Highlights › row: start, length (frames), colour, opacity, remove | Row: start / length (s), swatches, Strength (%), remove |
| Speed section (runs in source frames, %, Reverse, Remove, Add at playhead, curve plot) | Speed tab (runs in seconds, %, Reverse, remove, add at playhead, speed bar; curve plot kept below) |
| Fade › in / out (frames) + curve (ease names) | Fade › seconds + plain curve names |
| Fade note | Kept |
| Keyframes › Key all properties, count, delete here, clear | Same + previous / next |
| Text-clip hiding rules (crop, scale, rotation hidden for titles) | Unchanged |

### MCP parity

No new capability; `editor_set_clip_transform`, `editor_set_clip_keyframes`,
`editor_set_keyframe_ease`, `editor_set_dynamic_zoom`, `editor_set_clip_highlights` /
`editor_suggest_clip_highlights`, `set_clip_speed`, `set_clip_fade` keep their stored units
(the agent keeps writing fractions and frames). Two things to keep in step:

- **One conversion module** (fraction ↔ px against the composition size, 0–1 ↔ %, frames ↔
  seconds at the timeline fps) used by every Inspector row, so the GUI never shows a number the
  agent would read differently. `editor_get_capabilities` gains a line naming the GUI's display
  units so an agent describing a value to the person uses the same words.
- Speed quick choices (50 / 100 / 200%) are a single-run `set_clip_speed`; no new tool.
- Info tab reads `editor_list_media` / `editor_get_state` data; no new tool.

### Open questions

1. **Tabs:** Video / Audio / Speed / Info (mocked; Speed out of Video because it changes the
   length, sound included), or keep Speed as a Video section?
2. **Position in px from the frame's centre** (FCP, Resolve) or from the top-left (today's
   model origin, B-295)? The mock shows centre-relative (0, 0 = centred).
3. **Corner radius** in Compositing (mocked) or back in Transform?
4. Number fields accept frames typed with `f` (e.g. `12f`) wherever seconds show: OK?

---

## 5. Export (B-367)

### What's wrong today

The owner: "this needs a redesign as well … and no other export freeze and all, so think of
that" (`scratch/bug-refs/2026-11-01-export-dialog.png`). `EditorExportDialog.tsx`: Timeline,
an empty Output file that must be chosen first, raw Width / Height / FPS, Audio loudness
defaulting to "Off (as mixed)", and a long "Per-clip export options" list of `fit` dropdowns
and "Freeze" switches; Close / Add to queue.

### What the references do

FCP: a Share menu of **destinations** (Export File, Apple Devices, Social Platforms, …) each
with an Info tab (name, description) and a Settings tab (resolution, compression); upload is
manual. Resolve: **Quick Export** with one-click presets that can render and upload to YouTube,
Vimeo or Dropbox; custom presets from the Deliver page show up there. Premiere: an Export mode
with destinations (Media File, YouTube, TikTok, …) and presets, plus a top-right Quick Export.
CapCut: resolution, frame rate, bitrate in one sheet. Opus Clip: connected accounts, scheduling,
per-post caption.

### Proposed design (mockup tab "Export", 4 states)

- **A sheet with destinations on the left:** *File* (now), and under *Publish*, YouTube,
  Instagram, TikTok marked **"Later"** (roadmap 00d), with "Publishing is opt-in … your exports
  always stay on this Mac".
- **Head:** "Export" and the timeline picker ("Voiceover v2 · 7:44 · 16:9").
- **Preset cards** (size, frame rate and loudness together): YouTube 1080p, YouTube 4K,
  Shorts · Reels · TikTok (1080 × 1920), Square post, Master (as edited: timeline size,
  loudness as mixed), Podcast video (−16 LUFS). The default is the last-used preset per
  timeline shape (16:9 → YouTube 1080p, 9:16 → Shorts).
- **Save as** pre-filled: `<timeline name>.mp4 in ~/Movies/<project>` with Change….
- **Summary line:** "1920 × 1080 · 30 fps · H.264 MP4 · Loudness YouTube, −14 LUFS · 7:44 ·
  about 840 MB", plus a warning chip when the preset's shape differs from the timeline's.
- **Grade notes** (LUT cannot carry part of a grade) stay as a warning, in words.
- **More settings** (collapsed): Size, Frame rate, Loudness (Off / YouTube / Broadcast /
  Podcast / Custom), Loudest peak (dBTP), Format (H.264 MP4, locked: the only format the Edit
  export writes), and **Clip exceptions (rarely needed)**: per clip, "Keep its framing /
  Stretch to fill" and "Hold last frame", explained in one line, applying to this export only.
- **Export** (primary) queues the job and **closes the sheet**. Progress lives in the top bar
  ("Exporting 42%" with a thin bar); its popover lists jobs (progress and time left, the
  loudness result in words, Show in Finder, Try again on failure, a disabled "Post…" for
  later).
- **Publish (later)** is drawn so the sheet has room: account, Title, Description (chapters and
  credits from the project), Visibility (Private by default "check for copyright claims
  first"), Publish now / schedule, Thumbnail, Tags; "Export and publish" disabled.

**Why:** a creator picks a destination and a preset, not width / height / fps. Defaults make
the common case two clicks (Export → Export). The per-clip rows were the owner's "freeze and
all": they are kept but out of the way and renamed.

### Capability map

| Today | New place |
|---|---|
| Export button (top bar) + tooltip | Unchanged |
| Timeline picker | Head picker with length and shape |
| Output file + Choose… (required first) | Save as, pre-filled, Change… |
| Width / Height (from composition size) | Preset card; More settings › Size |
| FPS | Preset; More settings › Frame rate |
| Audio loudness (Off / YouTube / Broadcast / Podcast / Custom + LUFS + dBTP) | Preset; More settings › Loudness + Loudest peak |
| Per-clip fit (Fit / Stretch) | More settings › Clip exceptions › Keep its framing / Stretch to fill |
| Per-clip Freeze | More settings › Clip exceptions › Hold last frame |
| "Audio mixes in automatically" note | Dropped (true by default; nothing to set) |
| Validation error | Same, inline |
| Grade notes | Warning notice |
| Add to queue / Baking grades… | Export (busy label kept while grades bake) |
| Queue list: status, name, progress, loudness report, Clear finished | Top-bar popover with the same, plus Show in Finder / Try again |

### MCP parity

`editor_export` already takes every value (`width`, `height`, `fps`, `fit_overrides`,
`freeze_overrides`, `loudness_preset`, `loudness_lufs`, `true_peak_dbtp`, `timeline_id`,
`out_path`); `editor_export_status` covers the queue. To match the new GUI:

- **Presets:** add an optional `preset` to `editor_export` resolved by the same table as the
  cards (one module, both callers), so "export it for Shorts" is one argument.
- **Default output path:** make `out_path` optional with the same default the sheet shows.
- **Try again / Show in Finder:** there is no retry or cancel in the queue today
  (`exportQueueStore.ts`: "no cancel this pass"); adding retry or cancel in the GUI needs the
  same on MCP (`editor_export_status` / a cancel tool).
- **Publishing:** future `publish_*` tools (roadmap 00d), same flow as the sheet.

### Open questions

1. **A ProRes master:** the Edit export writes only H.264 MP4 (`decode_pipe.rs`, CRF 18); the
   Colorist export already has ProRes 422 HQ. Add a "Master (ProRes)" preset (backend work)?
2. **Clip exceptions:** keep them in the sheet (mocked), or move "Stretch" into the
   Inspector's Fit in frame (a 4th scaling mode, model change) and "Hold last frame" into a
   timeline freeze-frame action, removing them from export entirely?
3. **Preset list:** are the six right? Should the user save their own (Resolve, Premiere)?
4. **Cancel a running export:** add it (needs backend support)?

---

## Build order after approval

Each panel ships alone, with its `D-NNN`, docs and tests, in this order (smallest blast radius
first, and Inspector rows before the panels that reuse them):

1. **Shared:** one display-units module (px / % / ° / s / Hz / dB conversions) and the
   collapsed-section `meta` summaries in `EditorSection` (it already has the slot).
2. **Inspector Video sections** (B-366) and the four tabs + duration (B-359 item 1–2).
3. **Inspector Audio + EQ** (B-365), with the `editor_set_clip_eq preset` parameter.
4. **Export** (B-367), with `editor_export preset` and the optional `out_path`.
5. **Music edits** (B-364).
6. **Clipper** (B-363): the largest; the review surface in the viewer area.

Perf (CLAUDE.md priority): the EQ drag coalesces to one op per frame and one undo step on
release (the `NumberScrubber` pattern, `ui-redesign.md` §6d); the Clipper review surface
renders only the selected short's transcript; the music-range overlay is one absolutely
positioned element, not a lane re-render; no new subscriptions to the playhead (D-325).
