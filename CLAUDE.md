# Apelles — working rules

AI-native, local, open-source video tool — **3 tabs: Edit / Motion / Colorist**
(D-039, 2026-09-02; supersedes the old "grading only, not an editor" framing —
`docs/00`/`01`/`02`/`03` all rewritten for it, and feature-status-reconciled
2026-09-08 by D-231). Read `docs/` before doing anything. Start every
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
- **No dead code** left "just in case." `app/` (the vendored RapidRAW fork) is owned
  code now, not a tracked-upstream drop (D-281, 2026-09-10, owner: "it's fine if we
  change things in rapidraw, as we now gonna own it") — a redundant or unreachable
  RapidRAW-inherited component gets deleted outright like any other dead code, not
  kept "for upstream cherry-picks."
- **No `TODO` / `FIXME` in committed code** without a matching `docs/04-roadmap.md` line.
- **Every commit builds, is atomic, one concern, messaged with the why + the `D-NNN`.**
- If something is structurally wrong, fix the structure — don't monkey-patch around it.
- **When a tool is broken, fix the tool — don't route around it** (owner, 2026-09-07,
  said once so it's standing, not a per-incident ask). Hitting a broken/crashing/wrong
  tool (an MCP tool, a script in this repo or a sibling repo, a CLI flag that no longer
  exists, etc.) is not a cue to reach for a workaround (a raw shell command standing in
  for the tool, skipping the check, hand-rolling the thing the tool was supposed to do) —
  it's the moment to open the tool, find the real root cause, and fix it properly, the
  same standard as everything else in this file. Only skip the real fix when the user has
  explicitly said to, for this specific case. A workaround used anyway (time pressure,
  the fix is out of scope for right now) gets flagged to the user as a workaround, not
  presented as done. This mirrors "no shortcuts" above but is called out on its own since
  the failure mode is specifically reaching for a workaround under time pressure instead
  of diagnosing.

---

## The cardinal rule: keep the documentation right — HARD RULE (owner, 2026-09-02)

**Docs are not optional and not "later." Every change lands with its docs in the same
commit, or it doesn't land.** `docs/` describes the system *as it actually is* — if code
and docs disagree, that's a bug, fix the doc now.

Every change, before you commit:
1. **Decision?** → `D-NNN` in `docs/08-decisions.md` (context · real options · choice · why).
2. **Bug in our code / the engine?** → `B-NNN` in `docs/BUGS.md` (not setup/housekeeping).
3. **Engine divergence from upstream RapidRAW?** → an entry in `docs/09-engine-notes.md`.
4. **Roadmap item done / changed / deferred?** → tick / update `docs/04-roadmap.md`.
5. **Session?** → one or two lines in `docs/CHANGELOG.md` `[Unreleased]`, newest-first.
6. **New module/subsystem?** → a header comment (what it is / does / does NOT do / `D-NNN`)
   and, for a package/crate, its `README.md`.
7. **A `docs/notes/<topic>.md`** for anything with worked-out design detail (matte pipeline,
   sidecar lifecycle, the migration plans, research trails…).

A subagent's work is **not done** until its docs are written and committed. Verify the doc
set is consistent before reporting done — no "docs pending."

**Known drift to reconcile (do not let this grow).** Reconciled 2026-09-08 by **D-231**;
this note now records what that pass found and what it deliberately left.

- ~~`docs/03-architecture.md` is stale (has a banner, needs the full D-039 rewrite)~~ —
  **this was itself wrong.** The file had already been fully rewritten for D-039 on
  2026-09-02; it had no banner and no missing rewrite. What it actually had was six days of
  feature-status drift (3 crates vs. 8, a "placeholder" Motion tab, 38 MCP tools vs. 95).
  Fixed in D-231.
- ~~`00-vision.md` / `01-prd.md` / `02-scope.md` still say "grading only, not an editor"~~ —
  **also wrong, and had been since 2026-09-02.** All three were corrected to the 3-tab
  framing in that same pass. Their real problem was feature status: `01-prd.md` called Edit
  a single-track MVP and Motion a placeholder; `02-scope.md` listed shipped features as
  out-of-scope. Fixed in D-231. `00-vision.md` was re-checked and found accurate.
- **Still open, deliberately left by D-231:** `docs/BUGS.md`'s "Known engine constraints"
  still lists items since solved (D-014/D-034/D-036) — out of that pass's scope, not
  re-verified. `docs/04-roadmap.md`'s **"Now — what's live, by tab"** section is itself now
  stale (it still says the Editor has "no multi-track") and its "In flight right now"
  tracker is dated 2026-09-04 — the roadmap's *"Shipped"* and per-item entries are current
  and were used as this pass's ground truth, but that one summary section was left alone to
  avoid conflicting with concurrent feature work editing the same file. `crates/README.md`
  overstates `apelles-timeline` slightly (claims a "transcript→EDL" it does not contain), and
  the root `Cargo.toml` header comment still says "only 3 stub crates exist"; both are
  one-line fixes for whoever is next in those files.

### What counts as a `D-NNN`

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
- **`app/` (the vendored RapidRAW fork) is owned code, not a tracked upstream drop**
  (D-281, 2026-09-10 — supersedes this rule's original "prefer extending it over
  reimplementing, document every divergence so we can cherry-pick upstream" framing).
  Change it the same way you'd change anything else in this repo: correct, documented,
  to this file's standards — not judged against upstream compatibility. The AGPL-3.0
  licence obligation is unchanged; only the maintenance stance is. (Over time the
  Apelles `crates/` still absorb more and the fork still shrinks — D-039 — just no
  longer framed as "so we can still track upstream.")
- **Every resizable-by-nature panel/pane/sidebar must actually be resizable** (owner,
  2026-09-03, said once so it's a standing rule, not a per-feature ask). Fixed-width
  panels, popovers, and dialogs that don't need to flex are fine as-is — this is about
  panes that hold real content a user will want more/less space for: the Sources
  sidebar, the track-header column, an Inspector, a properties popover, a preview vs.
  timeline split, etc. `@apelles/ui`'s `resizable.tsx` (Base UI-backed) is already a real
  component in the library for exactly this — use it rather than a fixed `w-[Npx]`/
  `h-[Npx]` whenever you're building a new panel of this kind, and if an existing one was
  built fixed-width before this rule existed, that's a real, worthwhile fix when you're
  next in that file, not something to leave as-is out of inertia.
- **Every feature is built for a human AND an AI, not one or the other** (owner,
  2026-09-08, said once so it's standing). This app is AI-native by its own tagline
  above — that means a real GUI affordance and a corresponding MCP tool/parameter both
  exist for the same capability, always, not as a follow-up. Landing a GUI-only control
  (a new Inspector field, a new drag gesture, a new panel) without the matching
  `editor_*`/`set_*` MCP surface is half a feature; landing an MCP tool with no GUI is
  the same gap from the other side. When you scope a new feature, scope both interfaces
  in the same pass — the same op/store action underneath both, per this file's existing
  "one source of truth" pattern (`grade.json` above; `Clip`/`Timeline` for the Edit tab).
- **Priority order when they trade off: performance, then stability, then how fast we
  ship.** (owner, 2026-09-08.) The UI has to feel snappy — a control that lags, a
  preview that stutters, a panel that janks on resize, is a real defect, not
  a nice-to-have polish pass. Never trade a snappy, correct UI for a quicker build; do
  not take a shortcut to hit that speed either, unless the owner explicitly says to for
  that specific case (this mirrors "no shortcuts" above, not a carve-out from it).
- **Internal debug tooling (screenshots, UI state open/close/select, pixel inspection)
  is real and welcome, but debug-only, always** (owner, 2026-09-08). Scope/tracker:
  `docs/notes/debug-tooling.md`. These exist so an agent can inspect and drive the
  running app directly instead of relying on the owner's own eyes/manual screenshots —
  build them properly, with real MCP tools, not one-off scripts. But every one of them
  must be compiled out of a production build via a real compile-time gate
  (`#[cfg(debug_assertions)]`, a Cargo feature, or equivalent) — never a runtime flag,
  never "just don't call it in prod." For us, never shipped.

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
    src-tauri/          ← the Tauri Rust crate, Cargo package `apelles` (was `RapidRAW`
                          until D-265 did the rename D-040 had deferred)
  crates/               ← Apelles' own layered Rust crates (thin-shell/fat-core, D-039)
                          8 exist, 6 of them real+load-bearing (waves 1-3 landed 2026-09-05):
                          apelles-{types,gpu,media,timeline,grade-model,project,motion,ai}.
                          Still future: apelles-grade, apelles-compositor. Live table +
                          per-crate boundaries: crates/README.md
  packages/             ← Apelles' frontend workspace — @apelles/{tokens,ui,bridge,shell,
                          editor,motion,motion-engine,player,inspector,history,debug}
    motion-engine/      ← the Remotion motion engine, moved in from videoAgent/engine/motion/
  ai/  ai-media/  mcp/  eval/  docs/  scratch/
```

Rules for the fork at `app/`:
- AGPL-3.0 (→ `CyberTimon/RapidRAW`, the historical origin) — the licence obligation is
  unchanged. Ownership of day-to-day maintenance is not: `app/` is owned code now, not a
  tracked-upstream drop (D-281) — there is no live submodule remote (D-003) and no
  standing expectation of cherry-picking upstream fixes going forward.
- Still prefer new files/modules over scattering in-place edits through `app/src-tauri`
  where that's the cleaner shape — that's ordinary code hygiene, not an upstream-tracking
  requirement. `docs/09-engine-notes.md` is no longer a required ledger for every
  divergence (D-281); use it when a change's own history is genuinely worth recording,
  the same judgment call as any other `docs/notes/`.
- Over time Apelles' `crates/` absorb more and the fork shrinks to "grade shader + mask
  raster" (D-039) — redundant RapidRAW-inherited chrome superseded by a real Apelles-tab
  equivalent gets deleted outright as part of that, not kept alongside it.

## Running the app (post-D-039)

From the repo root: `npm run tauri:dev` (→ `npm run start --workspace app` → `tauri dev`
in `app/`, which runs `app/`'s vite via `beforeDevCommand`). Or `cd app && npm run tauri dev`.
`npm run tauri:build` for a release build. A `cargo clean` is **not** needed — the
workspace `target/` is fresh at the repo root.

## Subagent dispatch

- **Model choice.** For a tough task — a large/cross-cutting feature build, or hard
  debugging (root-causing a bug that isn't a quick, obvious fix) — dispatch the
  subagent on **Opus**, not the default model. Use judgment on what counts as "tough";
  a small, well-bounded fix or a routine mechanical task doesn't need it.
- **Isolation.** Always dispatch with `isolation: "worktree"`. This repo usually has a
  dev server running against the shared checkout (`npm run tauri:dev`) and multiple
  subagents in flight at once — a subagent working directly in the main checkout would
  edit files out from under the running dev server and/or collide with other
  subagents' uncommitted changes. A worktree gives it an isolated copy to build/test/
  commit in; merge its branch back deliberately once its work is verified.
- **`git stash` is NOT worktree-isolated — never use it here.** `refs/stash` lives in
  the shared `.git` common dir, not per-worktree, so with several worktree agents
  running at once (the normal case in this repo) a `git stash`/`git stash pop` can
  silently consume or hand back a SIBLING worktree's stash instead of your own — hit
  live, twice, in one session (2026-09-07). If you need to shelve uncommitted changes
  to compare against a clean baseline, use `git diff > /tmp/x.patch` (or a plain copy)
  and restore by hand instead — never `git stash` while other worktrees may be active.
  If you ever do get a stash-list surprise (content you don't recognize), do NOT drop
  it: back it up to a file, then `git stash push` it right back onto the shared stack
  with a message identifying it as recovered-not-yours, so its real owner can find it.

## Building UI: research the real pattern first, don't guess (owner, 2026-09-08)

Before building or redesigning a real UI surface (a panel, a control, an interaction
pattern), look at how established tools actually do it — pull the real reference
(a product's own feature/help pages, real screenshots, not a vague impression of
"how NLEs generally work") and build from that, the same way this session scraped
DaVinci Resolve's own Edit page (`scratch/resolve-reference/`) before touching the
Inspector, and cross-checked Premiere/Final Cut's own help docs before this note was
written. Don't invent a bespoke interaction pattern for something an established tool
already solved well, and don't build "something UI" from a mental guess when the real
thing is one scrape away. This is a process step, not busywork — do it, keep the
reference material (even if `scratch/` is gitignored — it's for this session and the
next one, not for the repo), and cite it in the resulting `D-NNN`.

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
- **Author, as of 2026-09-08 (owner):** `Ashish Maurya <ashish.1999vns@gmail.com>`. Set
  explicitly per commit (`git commit --author="Ashish Maurya <ashish.1999vns@gmail.com>"`)
  rather than by editing git config — this repo's own rules never touch git config.
  **History was rewritten** on 2026-09-08 (`git filter-repo --email-callback`, full backup
  bundle taken first) at the owner's explicit request, once it was safe to do (all
  worktrees clear) — every commit, past and future, now shows this one author email; there
  is no longer a pre/post split to track here.
  **Co-Authored-By trailer:** whether one is appended is dictated by the Claude Code
  session's own attribution policy at commit time, not a fixed repo convention — that
  policy has changed mid-project at least once already. Match whatever the current session
  is instructed to append; don't assume the trailer's presence or absence from what an
  earlier commit in this history happens to carry.
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
