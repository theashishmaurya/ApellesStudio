# Chroma — working rules

AI-native, local, open-source video tool — **3 tabs: Edit / Motion / Colorist**
(D-039, 2026-09-02; supersedes the old "grading only, not an editor" framing —
`docs/00`/`01`/`02` rewrite pending). Read `docs/` before doing anything. Start every
session with `docs/00-vision.md`, `docs/02-scope.md`, `docs/04-roadmap.md`,
`docs/08-decisions.md`, `docs/notes/architecture-lock.md`.

---

## Standards — no shortcuts (owner directive, 2026-09-02)

**Everything is done properly, the standard way, fully organized. No hacks, no
"just make it compile", no "fix it later" left in committed code.**

- **The D-039 layered architecture is the law.** Dependency direction is one-way:
  `app → tabs → services → domain → media/gpu → types`. No cross-layer reaching, no
  cycles. Code goes in the layer its dependencies allow. Shared logic → a package/crate,
  never copy-pasted; if two places need it, extract it. Every package/crate has a README
  stating what it is and its boundary.
- **Use the framework's canonical patterns.** shadcn/Base-UI via `components.json` + the
  standard structure (D-042) — not ad-hoc copied snippets. Tauri command conventions,
  Cargo workspace conventions, Remotion's conventions. Don't invent a new pattern when a
  standard one exists.
- **One token source.** All theming flows from RapidRAW's existing `--color-*` CSS vars.
  No second parallel theme, no `text-white` on `bg-accent` (use `text-button-text`), no
  magic colour literals, no magic numbers without a named constant.
- **Types are real.** No `any` in new TS unless genuinely unavoidable (comment why); no
  bare `@ts-ignore`. Rust: no `unwrap()`/`expect()` on anything that can fail at runtime —
  `Result` + `?`. `tsc` introduces **zero** new errors; `cargo fmt` + `cargo clippy`
  clean on new code.
- **No dead code** left "just in case" — except the explicitly-unrouted RapidRAW
  components kept for upstream cherry-picks (D-003), which are documented as such.
- **No `TODO` / `FIXME` in committed code** without a matching `docs/04-roadmap.md` line.
- **Every commit builds, is atomic, one concern, messaged with the why + the `D-NNN`.**
- If something is structurally wrong, fix the structure — don't monkey-patch around it.

---

## The cardinal rule: document the decisions that shape the project

**A significant decision gets a `D-NNN` entry in `docs/08-decisions.md` — context, the
real options, the choice, and *why*.** Keep it short.

"Significant" = it shapes the architecture, it's hard to reverse, or a future contributor
would look at the code and ask "why did they do it this way." Examples: fork vs. build,
process boundaries, the grade-document shape, the MCP contract, colour-management model,
the render-core / Tauri split.

**Not** every library pick, every code-read finding, every setup step. Those are a
one-liner in the relevant doc if they matter, or nothing if they don't. Don't
ceremony-document routine choices.

## Document what things are and what they do

Every non-trivial module or subsystem gets a short header comment: what it is, what it
does, what it does NOT do, and the `D-NNN` that created it if there is one.

`docs/` describes the system *as it actually is*. If code and docs disagree, fix the doc
in the same commit.

## Per-session discipline (light)

1. **Start:** skim `docs/00`, `02`, `04`, `08`.
2. **During:** a real architectural decision → `D-NNN`. A real defect → `B-NNN` in
   `BUGS.md` (a defect in *our* code or the engine — not "Rust was out of date" or "disk
   was full", those are setup/housekeeping).
3. **End:** one or two lines in `docs/CHANGELOG.md` for the session, roadmap checkboxes,
   commit. Not a paragraph per activity.

## Project invariants (these are decisions already made — see `docs/08-decisions.md`)

- **`grade.json` is the single source of truth.** The GUI mutates it, the MCP layer
  mutates it, the renderer reads it and only it. No hidden state in the app. (D see doc 06)
- **The render path is deterministic.** Same doc + same frame ⇒ identical pixels. No
  `rand()`, no wall-clock, no un-seeded anything, no order-dependent floating-point that
  isn't pinned. Non-determinism in a grade is a blocker bug.
- **Local-first.** Zero network calls in the grade path. Models run on-device. Any cloud
  call is an explicit opt-in fallback, never a default, and is documented as such.
- **v1 scope is deliberately tiny** (one footage type, macOS ARM, Rec709, adjustment
  stack not nodes). Do not add v2/v3 features "while I'm here." If it's not in
  `docs/02-scope.md` v1, it goes in a `D-NNN` as a proposal, not in the code.
- **We vendor RapidRAW at `app/`, we don't rewrite it.** Prefer extending it over
  reimplementing. When you must diverge from upstream, document the divergence in
  `docs/09-engine-notes.md` so we can still cherry-pick upstream fixes. (Over time the
  Chroma `crates/` absorb more and the fork shrinks — D-039.)

## Monorepo layout (D-039 / D-040)

`chroma/` is one repo — no submodule. The RapidRAW fork is **vendored at `app/`**
(D-040: de-submoduled 2026-09-02, working tree moved verbatim; pre-fold history is in
`engine-history.bundle`, gitignored). References to "`engine/`" in older docs mean `app/`.

```
chroma/
  Cargo.toml            ← virtual [workspace] — members: app/src-tauri, crates/*
  Cargo.lock            ← the workspace lock (was app/src-tauri/Cargo.lock)
  package.json          ← npm workspaces — app, packages/*
  app/                  ← the vendored RapidRAW fork (AGPL-3.0)
    src/                ← React/TS frontend  (was engine/src)
    src-tauri/          ← the Tauri Rust crate, still named `RapidRAW` (rename = later step)
  crates/               ← Chroma's own layered Rust crates (thin-shell/fat-core, D-039)
                          3 stubs so far: chroma-types, chroma-timeline, chroma-grade-model
  packages/             ← Chroma's frontend workspace — @chroma/{tokens,ui,bridge,editor,motion,shell}
    motion-engine/      ← the Remotion motion engine, moved in from videoAgent/engine/motion/
  ai/  mcp/  eval/  docs/  scratch/
```

Rules for the fork at `app/`:
- AGPL-3.0 (→ `CyberTimon/RapidRAW`). Upstream is **tracked manually now** — the hard fork
  is D-003 (no live submodule remote). Cherry-pick upstream fixes by hand when wanted.
- Do not scatter edits through `app/src-tauri` casually — new files/modules over
  in-place edits, and every divergence from upstream is logged in `docs/09-engine-notes.md`
  (what changed, why, the upstream commit we branched from).
- Over time Chroma's `crates/` absorb more and the fork shrinks to "grade shader + mask
  raster" (D-039).

## Running the app (post-D-039)

From the repo root: `npm run tauri:dev` (→ `npm run start --workspace app` → `tauri dev`
in `app/`, which runs `app/`'s vite via `beforeDevCommand`). Or `cd app && npm run tauri dev`.
`npm run tauri:build` for a release build. A `cargo clean` is **not** needed — the
workspace `target/` is fresh at the repo root.

## Code

- Rust: match the surrounding style in `app/src-tauri`. `cargo fmt`, `cargo clippy`
  clean before commit.
- Frontend: match `app/src` (React/TS).
- Every new crate/dependency: a `D-NNN` (what it's for, what else was considered, its
  license, its maintenance status).
- Prefer boring, well-maintained deps. This is a long project.

## Commits

- Small, focused, one concern each.
- Message says *what changed and why*, references the `D-NNN` / `B-NNN` / roadmap phase.
- End with:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  ```
- Branch off `main` for anything non-trivial. `main` stays buildable.

## Verification

- Don't claim something works until it renders / builds / passes. Show the output.
- A spike counts as done when its finding is written into the relevant doc, not when the
  throwaway code runs once.
- Render-path changes: verify determinism (render the same frame twice, diff).

## Testing

- The grade doc engine, the `.cube` bake, the scopes math, the mask-geometry conversions:
  unit-tested. These have correct answers.
- The look / the AI matte quality: eyeball + document, no unit test.
- Determinism: a test that renders a fixture grade and hashes the output.
