# Chroma — working rules

AI-native, local, open-source **color grading** tool. Grading only, not an editor.
Read `docs/` before doing anything. Start every session with `docs/00-vision.md`,
`docs/02-scope.md`, `docs/04-roadmap.md`, `docs/08-decisions.md`.

---

## The cardinal rule: nothing is decided silently

**Every architectural decision gets written down before or at the moment it is made** —
in `docs/08-decisions.md`, as a numbered `D-NNN` entry with:

- **Context** — what problem forced the decision
- **Options** — every real alternative that was considered, not just the chosen one
- **Choice** — what we picked
- **Rationale** — *why* this one, *why not* the others
- **Consequences** — what this makes easy, what it makes hard, what it rules out
- **Status** — `open` / `decided` / `revisit`

This applies to: choosing a library or crate, a data format, a protocol, a process
boundary, a threading model, a caching strategy, a file layout, a naming convention that
others will follow, anything in the render path, anything in the grade document, anything
in the MCP surface. If you're about to write code that assumes something a reasonable
person could do differently — that's a decision. Document it.

**No "I'll just do X"** in a commit without a D-entry. If it's too small for a D-entry,
it's a one-liner in the relevant doc. Silent assumptions are how this project dies.

## Document what things are and what they do

Every non-trivial module, service, or subsystem gets a header comment and an entry in the
right doc:

- **What it is** — one sentence
- **What it does** — its responsibility, its inputs, its outputs
- **What it does NOT do** — the boundary
- **Why it exists / why it's separate** — link the `D-NNN` that created it

`docs/` must always describe the system *as it actually is*, not as it was planned. If
code and docs disagree, that's a bug — fix the doc in the same commit.

## Per-session discipline

1. **Start:** read the docs listed above. Check `docs/BUGS.md` open items.
2. **During:** any decision → `D-NNN`. Any bug found → `B-NNN` in `BUGS.md` (even if you
   fix it immediately — record it). Any assumption you couldn't verify → note it.
3. **End:** update `docs/CHANGELOG.md` with what changed and why. Update the roadmap
   checkboxes. Commit.

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
