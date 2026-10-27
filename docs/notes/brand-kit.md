# Brand kit (D-416)

One brand definition every tab, template, custom component, the Clipper (D-411) and
agents read. Source of the ask: Ian Tang's tip 3 (`scratch/reference-reels/
ian-tang-claude-motion-tips.md`): "Brand file: colour, font, motion. Add your own
works or references before it starts." It is the explicit, person-authored sibling
of roadmap 0d's learned `taste.md`. Reference pass: `scratch/brand-kit-reference/
NOTES.md` (Canva Brand Kit, Adobe Express brand kits, Descript Brand Studio, Figma
libraries).

## The document

`packages/brand/src/kit.ts` (zod, strict: an unknown key is refused with its path).

| section | fields | used by |
|---|---|---|
| identity | `schemaVersion` (1), `id` (kebab ≤ 40), `name`, `version` (bumped per save), `description?` | all |
| `colors` | `primary`, `secondary`, `accent`, `background`, `text` (`#rrggbb`), `palette?` `[{name, hex}]` ≤ 16 | Motion theme, Edit caption/title colour roles, contrast check |
| `typography` | `display`, `body`, `mono?`: `{family, source: google|system|file, file?, licence?, weights?, editFallback?}`; `scale?` `{base, ratio, displayWeight, bodyWeight}` | Motion theme stacks + `fonts` + `fontFiles`; Edit font keys |
| `logos?` | `light`, `dark`, `mark` (image asset ids) | imported into the Motion store on apply (same ids) |
| `motion?` | `ease` (preset or bezier), `speed`, `stagger`, `entrance` | Motion: defaults for NEW layers and keys; explicit restyle |
| `captions?` | `preset` (an Edit caption preset id), `font` role, `color`/`boxColor` roles | Edit apply |
| `look?` | `lut` (a `.cube` asset id), `intensity`, `name?` | Colorist apply |
| `sound?` | `sonicLogo?`, `music?` `{mood?, bpm?, tracks?}` | agents (`apelles-sound-design`) |
| `references?` | `[{id, asset, note, kind: own-work|reference, name?}]` | agents (`brand_get_references`) |

A file a person supplies is never a path in the kit: it is imported into the brand asset
store and named `sha256:<hex>.<ext>`. A `file` font must carry its `licence` (Canva asks
the same). Contrast (`contrast.ts`, WCAG 2.2) is a warning, never a refusal: the pairs are
text/primary/accent/secondary on background and background on primary; body pairs need AA
(4.5), large-type pairs AA-large (3).

## Storage and copy semantics

| where | what | who |
|---|---|---|
| `<app data>/brand/kits/<id>.json` | the library, one file per kit, atomic writes, a bad file drops itself with a named error | `apelles_brand::library` over `apelles_motion::library` (the D-407 rule, extracted) |
| `<app data>/brand/assets/<hex>.<ext>` | the brand asset store | `apelles_brand::assets` |
| `<project>.chroma/brand/kit.json` + `brand/assets/` | the project's COPY of its active kit | `apelles_brand::project::install` |

Setting a project's kit copies the kit and every asset it names (each re-hashed: a library
file edited by hand is refused), writing `kit.json` last. The project never reads the library
again; a newer library version is shown ("Update to vN") and copying it is explicit. A Motion
render reads neither: the theme is embedded in the manifest (D-399) and the fonts/logos are in
the Motion asset folder under the same ids (D-404).

## Applying (one undo step per tab)

`@apelles/brand`'s `appliers.ts` holds one applier per tab, registered by the tab itself (the
package sits below the tabs and may not import them; the Motion document is component state):

- **Motion** (`packages/motion/src/brandApply.ts`): import font files and logos into the Motion
  store, then ONE commit embedding `themeDefFromBrandKit(kit)` (`brand-<id>`; `restyle_existing`
  also rewrites existing entrances and transform-key eases). Templates and custom components
  pick colours and fonts up through `theme`. Afterwards `motion_add_layer` and the Catalog give a
  new `image`/`icon`/`shape` the kit's entrance (under the caller's props) and
  `motion_add_layer_keyframe` gives a NEW key with no ease the kit's ease.
- **Edit** (`packages/editor/src/brandEdit.ts`): ONE `apply_brand_text` EditOp: the caption
  preset with the kit's font/colour roles on every unlocked subtitle track; the display font and
  text colour on every unlocked title. Edit fonts must be a single-face file both renderers read
  (D-212), so a kit font reaches Edit as a `.ttf`/`.otf` brand asset (`chroma_text_fonts` lists
  the project's kit fonts by asset id; `resolve_font_path` resolves them from the snapshot) or
  through `editFallback`.
- **Colorist** (`app/src/hooks/useColoristBrandApplier.ts`): ONE `setAdjustments` write putting
  the kit's LUT on the open shot at the kit's intensity (the LUT picker's own path).

## Interfaces

GUI: the Brand panel (`@apelles/brand/ui`, chrome-bar palette button, every tab; resizable
list/editor split). MCP (both servers, `brand_` prefix, answered by `useBrandControl`):
`brand_list_kits`, `brand_get_kit`, `brand_create_kit`, `brand_update_kit`,
`brand_delete_kit`, `brand_import_asset`, `brand_set_active_kit`, `brand_apply_kit`,
`brand_add_reference`, `brand_get_references`. Agents: `.claude/skills/apelles-brand/SKILL.md`
(load the kit and LOOK at its references before designing).

## Not built

- Stagger is stored and shown to agents but not applied mechanically (no template or insert
  path staggers entrances yet).
- New Edit titles do not default to the kit's font (only the explicit apply restyles).
- No font-file validation on import: a file Chrome's OpenType Sanitizer rejects (found with
  Kenney Pixel's shipped `kenpixel.ttf`, a bad `cmap`) falls back to the stack's next face with
  a console warning, in the player and the render alike.
- A kit's sound (sonic logo, music tracks) is data for agents; nothing places it automatically.
- Auto-generating a kit from a website or PDF (Canva, Kittl) and sharing kits between machines
  beyond copying the files.
