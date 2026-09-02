# 04 — Roadmap

Reorganized 2026-09-02 (was pure chronological append — unreadable after 40+ decisions).
**Now / Next / Later / Shipped**, not phases. Full rationale for any `D-NNN` lives in
`docs/08-decisions.md` — this file tracks *state*, not the reasoning; don't duplicate
prose here that already exists there. Timelines are rough solo-dev-with-Claude
estimates, not commitments (see `docs/notes/product-direction.md` §5 for how those
numbers are actually calibrated).

---

## Now — what's live, by tab

- **Colorist** — the full pre-pivot grade pipeline: primary/curves/wheels/LUT, masks
  (shape + AI subject, composable, keyframeable), scopes, `match_to_reference`,
  depth-haze, subject tracking (SAM2+ViTMatte) + temporal depth track (VDA), export +
  `.cube` bake, `grade.json`, the agent activity feed + `request_human`, an eval
  harness. MCP surface: 38+ tools. **RapidRAW's DAM/welcome/library shell is gone**
  (D-043) — it's the grading editor only now.
- **Editor** — MVP: single-video-track timeline (`chroma-timeline` + `react-timeline-editor`),
  scrub/play preview (independent of the Colorist render path), reorder/trim/split/remove,
  persisted in the project. No multi-track, audio, transitions, or transcript cut yet.
- **Motion** — placeholder tab. The engine (`packages/motion-engine/`, 7 primitives +
  manifest compiler) is fully functional, just not wired to a tab UI. **Gap — see Next.**
- **Shell** — 3-tab layout, window chrome, the project launcher as the app's entry
  screen (opens on the launcher, tabs appear once a project is open), `@chroma/ui`
  (shadcn/Base UI, 18 components, themed).
- **Monorepo** — de-submoduled (`app/` = vendored RapidRAW), Cargo + npm workspace
  (`crates/`, `packages/`), 3 stub crates real-but-thin. Full layer table:
  `docs/notes/architecture-lock.md`.

Run it: `npm run tauri:dev` from the repo root.

---

## Next — the active queue, in order

Each of these was scoped in a real conversation (owner-requested or -directed); detail
lives in the `D-NNN` / `docs/notes/*.md` referenced. Sequenced because they share hot
files (`App.tsx`, `Shell.tsx`, `useUIStore.ts`) — one subagent at a time until the
crate/package extraction phase makes true parallelism (isolated worktrees) safe.

1. **`@chroma/player`** — one shared preview component all 3 tabs embed: canvas
   viewport + title strip (`‹ ›`, name, `…`) + transport (timecode, skip/step/play,
   snapshot, fullscreen, rate, zoom). Presentational only — each tab supplies its own
   frame source (Editor's `chroma_timeline_frame`, Colorist's wgpu surface, Motion's
   `@remotion/player`) via a `surface` slot. Editor adopts it first (its hand-rolled
   transport moves in), Colorist + Motion follow.
2. **Media pool + import + multiple timelines** — the actual "Sources" replacement.
   `MediaItem` model unified with D-037 `shots` (pool = all media; a Colorist "shot" =
   a pool item being graded; an Editor "clip" = a windowed reference on a track).
   Multi-select import (referenced in place, never copied), bins/folders, multiple
   named timelines per project, a global Sources/Library panel (thumbnails + import +
   search + drag-to-track) docked in the shell so every tab reaches it. MCP:
   `import_media`/`list_media`/`list_timelines`/`set_active_timeline`. Big — likely
   2–3 subagent passes (model+import / bins+multi-timeline / UI).
3. **Export → a top-right button + an Export window** — move Export out of the buried
   `ExportPanel` toggle into a proper dialog: codec, resolution (default = the D-038
   project spec), frame range, `.cube` bake toggle, output path, progress. Backed by
   the existing `chroma_export_video`/`chroma_bake_lut` (D-022). `@chroma/ui`'s
   `Select`/`Dialog` (D-042, already landed) cover the UI needs. Colorist-first, shell-level
   later (export the Edit tab's active timeline too).
4. **Motion tab MVP** — was missing a real queued entry until 2026-09-02; the engine's
   ready and waiting. `@remotion/player` embed of `packages/motion-engine/` + a
   manifest editor (JSON-in to start — visual editor is an open question, see
   `product-direction.md` §9). `chroma-motion` crate (manifest → render bridge) per
   `architecture-lock.md`.
5. **Global undo/redo** — shell-level Cmd/Ctrl-Z spanning all 3 tabs. A
   `@chroma/history` store (`{tab, label, undo(), redo(), ts}`); the Colorist's
   existing 50-deep `useEditorStore` history feeds into it (don't rebuild it); Editor
   timeline ops push before/after snapshots. Ties into the D-032 activity feed.
6. **Docs reconciliation** (owed under the `CLAUDE.md` hard rule) — `03-architecture.md`
   full rewrite for the 3-tab world (currently a stale banner over the pre-pivot doc);
   `00-vision.md`/`01-prd.md`/`02-scope.md` still say "grading only, not an editor";
   `BUGS.md`'s "Known engine constraints" list still names solved items (D-014/34/36).

### Then — the deeper migration (D-039 steps 2–7, `architecture-lock.md`)

Extract the leaf pure crates for real (`chroma-types`, `chroma-grade-model`,
`chroma-timeline` — currently stubs) → `chroma-gpu`/`chroma-media`/`chroma-project` →
`chroma-agent`/`chroma-ai` → `chroma-grade` wraps `app/`, `chroma-app` goes thin →
**`chroma-compositor`** (the real multi-track engine) + `@chroma/editor` greenfield.
This is where isolated-worktree parallel subagents start making sense — each crate is
self-contained by design (see the "worktrees" discussion, 2026-09-02: file-boundary
discipline is the actual lever, not the worktree flag itself).

---

## Later — researched, designed, deliberately not built yet

No urgency — each needs an earlier item to land first, or is a bigger bet.

- **Believable AI background replacement** — matte the tracked subject over a
  still/plate/generated BG + the integration stack (light wrap, grade match via
  `match_to_reference`, relight-to-BG via the depth-driven puck relight, defocus +
  grain match). Needs `chroma-compositor` + the relight work. v1 = static-camera only.
  `docs/notes/background-replace.md`.
- **Interactive relight (puck UI) + photoreal bake** — deterministic depth-driven
  light pucks ship early (real-time); RelightVid diffusion bake is the v3 upgrade for
  photoreal. `docs/notes/relight-research.md`.
- **Visual understanding for the Editor tab** — temporal (Qwen3-VL, local default) +
  spatial (SAM2/YOLO, already have, just under-exposed) → natural-language footage
  search, B-roll auto-tagging, shot classification, auto-reframe hints, highlight
  detection. Needs the media pool first. First concrete task: a real local throughput
  benchmark (current numbers are extrapolated, not measured). Molmo 2 stays
  excluded from shipping (licence). `docs/notes/video-search.md`.
- **Multi-subject batch tracking** (D-017) — independent per-subject tracking already
  works; batching N objects into one SAM propagation pass is a pure perf optimization,
  niche for a single-subject talking-head grade.
- **OTIO / Palmier session import** — land a cut into a `.chroma` project (D-037).
- ProRes export round-trip verified with Palmier's `swap_clip_media`.
- **Packaging** — signed macOS build, sidecar + its Python bundled, models
  auto-downloaded (not lazy-fetched at first use, for a shipped build).
- `docs/` cleaned for external readers, a real README, a 90-second demo.
- **The three open product decisions** — name (D-010), licence (D-002, leaning AGPL),
  v1 headline feature (D-007). All shift under the 3-tab framing; not re-decided since.
- Node graph, ACES/HDR (OpenColorIO); CoTracker planar tracking + bezier roto;
  film-emulation chain; Windows/Linux + batch/headless mode; OFX plugin export (the
  gyroflow model); a public MCP contract + web review viewer.

---

## Shipped — terse history (full rationale lives in `docs/08-decisions.md`)

Chronological, one line each. This replaces the old Phase-0-through-4 / Round-1-2-3
narrative sections — that detail wasn't wrong, it was just duplicated from the decision
log and made the file unscannable.

**Phase 0–3 (pre-pivot foundation, 2026-08-31 → 2026-09-01):** repo + fork decided
(D-003) · toolchain fixed (B-001) · `render_core` Tauri seam (D-014) · video I/O via
ffmpeg CLI (D-015) · SAM2 + ViTMatte matte pipeline (D-016) · SAM2 memory-propagation
tracking (D-018) · render-time tracked matte (D-019) · control server + MCP bridge
(D-020) · scopes + `inspect_color` (D-021) · export + `.cube` bake (D-022) · mask
composition ops, not +/− points (D-023) · depth-haze preset (D-024) · `grade.json` v1
(D-025).

**Round 2 (2026-09-01→02):** `match_to_reference` auto-apply (D-026) · per-mask blur
(D-027) · Rust-managed AI sidecar (D-028) · stripped `@clerk/react` (D-029) ·
persistent decode pipe (D-030) · real-time playback ≥30fps (D-031).

**Round 3 (2026-09-02):** agent activity feed + `request_human` (D-032) · multi-shot
session + shot strip (D-033) · mask keyframes (D-034) · agent eval harness (D-035) ·
temporal depth track, Video Depth Anything (D-036).

**The 3-tab pivot (2026-09-02, D-039):** Palmier closing triggered the decision — Edit
/ Motion / Colorist, Rust-native/small-binary constraint locked, architecture designed
(`architecture-lock.md`) · de-submoduled to a monorepo (D-040) · workspace skeleton +
3-tab shell · Editor tab MVP, `chroma-timeline` made real (D-041) · UI pass (window
chrome in the shell, `@chroma/ui` started) · project launcher promoted to the app's
entry screen · `@chroma/ui` rebuilt properly on shadcn/Base UI (D-042) · project
settings — typed output spec (D-038) · **RapidRAW's DAM/welcome/library/community
shell removed from the Colorist tab** (D-043, −7,836 LOC).

**Deferred, not abandoned:** multi-subject batch tracking (D-017, → Later).

---

## Risks & how we de-risk

| Risk | Mitigation |
|---|---|
| The multi-track compositor (the Editor's long pole) is harder than estimated | it's the first thing in "Then — the deeper migration"; scoped small first (2–3 layers + a dissolve) before generalizing |
| Solo-dev + session rate limits slow the pace | the docs discipline (this file + `08-decisions.md`) means no re-derivation cost across sessions; subagents checkpoint-commit rather than lose work on failure |
| Speed accrues cleanup debt | `CLAUDE.md`'s "Standards — no shortcuts" hard rule exists specifically for this; verify before reporting done, every time |
| AGPL blocks a direction wanted later | decide licence intent explicitly when D-002 is picked up; AGPL is fine for "open project," accept the SaaS limitation |
| The "open + local + agentic" window keeps narrowing (competitors emerging weekly) | the defensible wedge is colour-science depth + Rust-native perf, not the category label — see `product-direction.md` §7 |
