# Chroma — working rules

AI-native, local, open-source **color grading** tool. Grading only, not an editor.
Read `docs/` before doing anything. Start every session with `docs/00-vision.md`,
`docs/02-scope.md`, `docs/04-roadmap.md`, `docs/08-decisions.md`.

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
- **We fork RapidRAW, we don't rewrite it.** Prefer extending `engine/` over
  reimplementing. When you must diverge from upstream, document the divergence in
  `docs/09-engine-notes.md` so we can still cherry-pick upstream fixes.

## `engine/` (the submodule)

- It's a git submodule → `CyberTimon/RapidRAW`. AGPL-3.0.
- Do not commit changes *inside* `engine/` casually — every divergence is tracked in
  `docs/09-engine-notes.md` (what we changed, why, upstream commit we branched from).
- Keep `upstream` as a remote inside `engine/` for pulling fixes.
- Decision D-003 (hard fork vs. collaborate with the maintainer) is still open — until
  it's decided, keep our changes minimal and cleanly separable.

## Code

- Rust: match the surrounding style in `engine/src-tauri`. `cargo fmt`, `cargo clippy`
  clean before commit.
- Frontend: match `engine/src` (React/TS).
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
