# apelles-brand

L2 crate (D-416): **brand kits on disk.** Stores and copies; never interprets a
kit's look.

| module | what it does |
|---|---|
| `library` | the user's kit library, `<app data>/brand/kits/<id>.json`, one file per kit: load with per-file errors (a bad file drops itself with a named error), atomic save, delete. The storage rule is `apelles_motion::library`, the per-file library D-407 wrote for templates. |
| `assets` | the brand asset store, `<app data>/brand/assets/<sha256>.<ext>`: logos, font files, LUTs, reference images/videos, audio, named by the SHA-256 of their bytes (the D-404 rule, the same id shape the Motion asset store uses, so a kit's font keeps its id in a Motion theme). `asset_ids_in` finds every id a kit names, schema-agnostically. |
| `project` | a project's own copy of its active kit, `<project>.chroma/brand/kit.json` + `brand/assets/`: `install` re-hashes and copies each asset (a library file edited by hand is refused), then writes `kit.json` atomically and last; `read`, `clear`. |

**Not here:** the kit schema, versions, the contrast check, theme generation and
the per-tab apply (all TypeScript: `packages/brand`, `@apelles/motion`,
`@apelles/editor`, the Colorist app). Nothing in a render reads this crate.

**Dependencies:** `apelles-types`, `apelles-motion` (the per-file library rule and
the streamed SHA-256), `serde`, `serde_json`. No new third-party crate.

Tests: `cargo test -p apelles-brand` (library round trip / replace / bad files /
unsafe ids; asset import, kinds, ids; project copy semantics, tamper and missing
asset refusals, clear).
