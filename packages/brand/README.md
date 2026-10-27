# @apelles/brand

**Brand kits (D-416)**: the one brand definition every tab, template, custom
component and agent reads. A kit holds colours (primary, secondary, accent,
background, text + an extended palette, WCAG contrast checked), typography
(display/body/mono: a Google face, a system face, or a font FILE the person
supplies with its licence noted; a size/weight scale), logos (light/dark/mark),
a motion style (ease, speed, stagger, entrance), a caption style (an Edit caption
preset + font and colour roles), an optional grade look (a LUT for the
Colorist), sound (a sonic logo, music preferences) and references (images or
videos with a note on what to take from each).

## Boundary

Below the tabs (CLAUDE.md layering: `app → tabs → services → domain`): it never
imports `@apelles/editor`, `@apelles/motion` or the app. Each tab owns what a kit
MEANS for it and registers an applier here:

| tab | applier | one undo step |
|---|---|---|
| Edit | `@apelles/editor`'s `brandEdit.ts` (`applyBrandToEdit`) | the `apply_brand_text` EditOp |
| Motion | `@apelles/motion`'s `brandApply.ts` (theme from `brandTheme.ts`) | one manifest commit |
| Colorist | `app/src/hooks/useColoristBrandApplier.ts` | one `setAdjustments` write |

Storage is `apelles-brand` (Rust) behind the `chroma_brand_*` commands
(`app/src-tauri/src/chroma/brand.rs`): the user's library is one file per kit,
assets are content-addressed, and a project keeps its own COPY of its active kit.

## Files

| file | what it is |
|---|---|
| `src/kit.ts` | the zod schema (strict), migration, `versionForSave`, `starterKit`, asset-id shapes |
| `src/contrast.ts` | WCAG 2.2 luminance / contrast ratio and the kit's colour pairs |
| `src/library.ts` | per-file load sanitising, `mergeKitPatch` (the update rule) |
| `src/references.ts` | references resolved to absolute files for an agent; `addReference` |
| `src/appliers.ts` | the per-tab applier registry and `applyBrandKit` |
| `src/io.ts` | `chroma_brand_*` wrappers and `useBrandStore` |
| `src/brandOps.ts` | `createBrandOps`: the ten `brand_*` MCP ops |
| `src/useBrandControl.ts` | the `brand_` registry on the control bridge (mounted from `App.tsx`) |
| `src/ui/` (subpath `@apelles/brand/ui`) | the Brand panel, opened from the chrome bar; kept off the barrel so a tab can import the domain without `@apelles/ui` |

## Tests

`npm run test --workspace @apelles/brand`: the schema, contrast, library and
references (`kit.test.ts`) and every `brand_*` op end to end through the real
store and registry over an in-memory backend (`brandOps.e2e.test.ts`).
