---
name: apelles-explainer-edit
description: Build the visual edit of a YouTube explainer on an Apelles Edit timeline over a clean voiceover - a visual change every ~3 s in the first five minutes, on-brand Motion cards, real references and screenshots, lip-synced camera moments, cutaways used once, the owner's review loop through timeline markers, and a scene audit for text overflow, clipping and z-order. Use after the voiceover is clean (apelles-voiceover-cleanup) when asked to "edit the video", "add the visuals / motion / screenshots", make the first minutes engaging, or act on the owner's review markers. Not for audio (apelles-sound-design), shorts (apelles-auto-clip) or the final upload (apelles-youtube-package).
---

# Apelles explainer edit

What this is: the owner's standards for a long-form explainer, written down from the Five Levels of
Claude Code edit (v1–v3, 2026-10-28), where each of these came back as a review note. It
orchestrates Apelles' Edit and Motion MCP tools and the brand, sound and retake skills; it adds no
app capability.

What it does NOT do: export. The owner watches in the app first and says "export" explicitly, every
time.

## 0. Before anything

- **Brand:** load `apelles-brand` and design inside the kit. For Apelles' own channel the look is
  the **white Apelles website theme**:
  - marble `#f4efe6`, surface `#eae2d4`;
  - basalt `#1c1a17` / `#4a443c`;
  - terracotta `#a6432c`, ochre `#b4823a`;
  - Newsreader / Instrument Sans / IBM Plex Mono.

  Not a dark theme unless asked. Never "palmier": the product is **Apelles**.
- **References:** the video's `REFERENCES.md` maps each beat to captured screenshots and clips, with
  the key line highlighted and centred. Use the real thing, not a mock-up.
- **Timeline rate:** match the camera and Motion renders (usually 30 fps), via
  `editor_set_timeline_output(fps=…)`.
- **Fit to frame:** clips fit the frame by default (D-425); Motion renders are 2× their manifest.
  Check that a placed clip fills the frame.

## 1. Pacing of the picture

- **First five minutes:** a visual change roughly **every 3 s**: a new card, a screenshot, a
  push-in, a cut to camera. After that it can breathe.
- **Hook:** the strongest visual first, with the claim on screen inside the first 2 s.
- **Effects:** one SFX or motion accent per real event, not per cut (see `apelles-sound-design`).

## 2. Camera and face rules (owner notes, all from real reviews)

- **Lip-sync:** on-camera moments only where the camera take and the voiceover say the same words.
  Lip-sync them; never show the face over unrelated audio.
- **No looking-down shots.** Never repeat a cutaway: each one (looking at the lens, a gesture) is
  used once.
- **No photo or still of the owner anywhere** (end cards included) unless he asks for it in that video. On 2026-10-29: "please remove this photo of mine… why did you add it".
- **PIP (face in a corner):** only when it is lip-synced, looking at the camera, and covering no
  text. Otherwise remove it. Some PIPs were explicitly unwanted ("useless PIP here"), so when in
  doubt, leave it out.

## 3. Scene audit (every scene, at its start, middle and end frames)

- **Text:**
  - no text overflowing its box (book spines, cards);
  - no text clipped at the frame edge;
  - no title colliding with the level or section tracker.
- **Z-order:** a moving element never slides behind something it should be in front of.
- **Layout:** two-column and card layouts are aligned (tops and bottoms) and vertically centred,
  never cramped.
- **Camera and zoom moves:** nothing clips during the move.
- **No stray arrows** or connectors pointing at an empty half.

Use `motion_validate`, `motion_preview_frame` and `debug_screenshot` to look. Don't assume.

## 4. Ending

Close right after the call to action ("please subscribe"): the end card, then a short music resolve
of about 1–1.5 s. No extra "next video" line unless asked. Check the last word isn't clipped (that
happened twice).

## 5. The review loop

- The owner reviews in the app and leaves **timeline markers** as notes, sometimes with screenshots.
  Save any attached image to `scratch/bug-refs/`.
- Answer each note in place. Fix it, then add a green **"DONE: …"** marker. Keep a checklist file in
  the video's folder (`edit-review-notes.md`) with every note and its status.
- Bugs in Apelles found while editing go into `docs/BUGS.md` as they happen. Pick them up later
  unless they block the edit.
- **Never edit `packages/` or a Motion manifest while a Motion render runs.** Batch the changes and
  render once.

## 6. Hand-off

When the owner says the edit is right, follow `apelles-youtube-package`.
