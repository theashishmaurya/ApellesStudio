---
name: apelles-brand
description: Read the open Apelles project's brand kit and its references BEFORE designing anything for a person (a Motion scene, a template fill, a custom component, captions, titles, a grade look, a short), then design within it; and set up or change a brand kit through Apelles' brand_* MCP tools. Use whenever a task makes or restyles something visual or audible in an Apelles project, or mentions a brand, brand kit, brand colours, brand fonts, a logo, "on brand", a style guide, references or "my work". Not a design system for the app itself.
---

# Apelles brand kit

What this is: the checked-in procedure for D-416's brand kit, the one brand
definition every tab reads (colours, type, logos, motion style, caption style, a
grade look, sound, references). Ian Tang's tip 3 is the reason it exists: "Brand
file: colour, font, motion. Add your own works or references before it starts."
The kit is the person's explicit, authored taste; `taste.md` (roadmap 0d) is the
learned sibling.

What it does NOT do: invent a brand. If the project has no kit, ask the person for
one (or offer to draft one from their materials and show it to them) before
designing anything "on brand".

## 0. Prerequisites

- The Apelles app is running with the project open; the `chroma` MCP server is
  connected (run `/mcp` after a tool change; never kill the server process).

## 1. Load the kit and its references FIRST, every time

1. `brand_list_kits` - is there a `project` kit? Is the library newer
   (`newerInLibrary`)? If so, ask before `brand_set_active_kit`, which copies it.
2. `brand_get_references` - the kit's direction plus every reference with its
   `note`, `kind` (own-work | reference) and absolute `path`.
3. **Look at every reference.** Open each image path (and a few frames of each
   video) before you design. Follow each note literally: "use my work for materials
   and framing" means take materials and framing from it, not its type; "use the
   reference for type and hierarchy" means the reverse. Own work outranks someone
   else's reference when they disagree.
4. `brand_get_kit` - check `warnings`: a contrast pair that fails is a reason to
   put text on `background` with `text`, not on `primary`.

## 2. Design within it

- **Motion:** `brand_apply_kit(tabs=["motion"])` once, so the document's theme is
  the kit's (`brand-<id>`). Then leave colours and fonts UNSET on layers and
  template colour slots so they follow the theme; set a colour only when the design
  needs a specific brand role, and then use the kit's hex. New layers already take
  the kit's entrance and new keyframes its ease. Use `stagger` from the kit between
  elements that enter together. The logos are image asset ids in the Motion store
  (`brand_get_kit` → `logos`); use the light one on light grounds, the dark one on
  dark.
- **Edit:** `brand_apply_kit(tabs=["edit"])` styles subtitle tracks with the kit's
  caption preset and titles with its display face. Read its `notes`: a Google or
  system face reaches Edit only through `editFallback`.
- **Colorist:** `brand_apply_kit(tabs=["colorist"])` puts the kit's LUT on the open
  shot. Grade by the numbers as usual afterwards (the server's scope discipline).
- **Sound:** the kit's `sound.music.mood` and BPM range steer music choice
  (`apelles-sound-design`); the sonic logo goes on the end card.

## 3. Never

- Never restyle existing work without being asked: `restyle_existing` rewrites
  every Motion entrance and keyframe ease. One undo per tab reverts an apply.
- Never put a file path in a kit: import first (`brand_import_asset`,
  `brand_add_reference`) and use the `sha256:` id.
- Never add a font file without its licence in the person's words.

## 4. Changing the kit

`brand_create_kit` (only `id` and `name` are needed; the rest comes from a neutral
starter), `brand_update_kit` (a merge patch; `null` removes a section; each save is
a new version), `brand_add_reference(path, note, kind)`. A project keeps its own
copy: after changing the library kit, `brand_set_active_kit` copies the new version
in, then `brand_apply_kit` applies it.
