# Scope: extract video/audio understanding into the `ai/` sidecar, expose via Apelles' own MCP only

Owner asked 2026-09-07, after a same-day prototype in the sibling `videoAgent`
repo validated the approach on real footage: pull that prototype's two
capabilities into Apelles properly — `ai/` sidecar, exposed only through
Apelles' own `mcp/server.py` — rather than leaving a second, separate
standalone MCP server (`videoagent`, in the videoAgent repo) as the permanent
home. This extends `docs/notes/video-search.md`'s own roadmap ("an `ai/`
sidecar addition, Qwen3-VL, sized per device... an MCP tool") with a concrete,
already-validated design instead of an unstarted proposal.

## What's being extracted (already built + tested, just in the wrong repo)

**Video understanding** — "what changed on screen, and when," with RELIABLE
timestamps. Design (validated live against 4 real content types — screen
recording, talking-head, ad, movie trailer — see
`~/.claude-personal/projects/-Users-ashishmaurya-my-projects-chroma/memory/reference_video_understanding_mcp_server.md`
for the full validation notes, migrated into this repo's own memory scope):
1. ffmpeg's own scene-change filter finds candidate moments deterministically
   and frame-accurately — classical CV, never a model guess for "when."
2. Qwen3-VL-4B (not 2B — 2B produced garbage on real footage) describes a
   before/after frame PAIR at each candidate (a single static frame can't
   show a click/spinner/cut, only the delta can) — this is the "what."
3. `time_s` always comes from ffmpeg, never the model.
4. `scene_threshold`/`min_gap_s`/`max_candidates` are real, exposed knobs —
   content-density dependent (a fast-cut trailer needs different tuning than
   a slow screen recording), not one universal default.
5. Known limit, not yet mitigated: sustained action/motion within one shot
   can produce semantically-repetitive descriptions (the model correctly
   describing genuinely-similar frames similarly) — not fixable by sampling
   params alone per 2026 LLM-repetition research.
6. Real cost: ~4x realtime, ~9GB peak memory footprint per call (4B model,
   already cached) — a deliberate, owner-approved trade-off, correctness
   over speed for a one-shot analysis call.

**Audio understanding** — word-level transcript (mlx-whisper, large-v3,
already proven elsewhere in this ecosystem via videoAgent's own
`/whisper-mlx`). Nothing novel to validate here beyond wiring it in — the
capability itself is mature.

**The two are complementary, not interchangeable** — video-understanding
finds nothing in a continuous uncut talking-head shot (no visual delta to
key off); transcript finds nothing in silent/music-only footage. Both need
to exist; an agent (or `search_footage`, per `video-search.md`'s own later
roadmap step) picks based on what's being asked.

## Architecture — the real risk this scope must not gloss over

`ai/server.py` (FastAPI, single process, single `ai/.venv`) is **PyTorch +
MPS** (`torch`, `ultralytics`, `transformers<5`) — confirmed by reading the
file and `ai/requirements.txt` directly. The video-understanding prototype is
**MLX** (`mlx-vlm`, Apple's own framework, a different ecosystem entirely).

**Do not add mlx-vlm/mlx-whisper into `ai/.venv` directly.** This was tested
the hard way this same day, in a smaller version of the same problem:
installing `mlx-vlm` into a shared venv that already had `mlx-audiocraft`
(both MLX, supposedly compatible) still broke it — `mlx-vlm`'s dependency
resolution silently upgraded `transformers`/`tokenizers`/`numpy`/`mlx-metal`
out from under the other package, and removing `mlx-metal` (assumed
mlx-vlm-specific) broke `mlx.core` itself (`dlopen` failure) until reverted.
Mixing MLX packages with EACH OTHER already isn't safe by default; mixing
MLX with a large existing PyTorch/`transformers<5`-pinned venv is a strictly
bigger version of the same risk, not a smaller one.

**Recommended: a second, sibling sidecar process**, not a second venv inside
the same process. Same supervised-subprocess pattern `apelles_ai::sidecar`
(Rust, D-101/D-142) already implements for `ai/server.py` — content-hash
health check, spawn/backoff/respawn, status snapshot — applied a second time
to a new `ai-media/` (name TBD) directory: its own FastAPI app, its own
`.venv`, its own port, its own entry in the Settings panel's sidecar status
card. Architecturally this is "one more instance of a pattern that already
works," not a new pattern — the isolation cost (a second Python process) is
worth not repeating today's breakage inside the app users actually run.

**Before committing to two sidecars**: it's worth one real check — whether
`ai/server.py`'s existing venv could instead be rebuilt on `mlx-vlm`'s own
resolved dependency versions (upgrading `transformers`/`numpy` etc.
project-wide) rather than assuming PyTorch-MPS and MLX must stay separated
forever. Not attempted in this scope — flagged as the one alternative worth
a real spike before defaulting to "just spin up a second sidecar."

## The chain to MCP (follow the existing pattern exactly, D-183's own rule)

The established path for a sidecar capability to reach an MCP tool, already
working for `depth_track`/`track_subject`/etc. (confirmed by reading
`mcp/server.py`'s existing tools):

```
ai/<sidecar>/server.py (FastAPI endpoint)
  → a new Rust Tauri command (app/src-tauri/src/chroma/<new>.rs,
     mirrors chroma/depth.rs's own shape — HTTP call to the sidecar,
     `#[tauri::command]` wrapper)
  → a frontend store action (packages/editor, most likely — the Edit tab is
     where media-understanding results get ACTED on: cut to a moment,
     search transcript text)
  → a control-server op, `editor_get_transcript` / `editor_analyze_video`
     (useEditorControl.ts — opt-IN to the `editor_` prefix, per
     docs/notes/mcp-architecture.md's "every tab owns its own ops" rule,
     D-183)
  → one new @mcp.tool() in mcp/server.py, thin, matching the existing
     `get_timeline`/`depth_track` shape exactly.
```

No new architectural pattern needed anywhere in this chain — every layer
already has a precedent to copy.

## What happens to the videoAgent-side prototype

**Retire it once Apelles' own version is live and tested**, don't run both
permanently — maintaining the same capability in two places is exactly the
confusion the owner flagged this same session (the whole reason this scope
doc exists rather than just leaving the videoAgent version as-is). Until
then, the videoAgent scripts (`src/review/video_understand.py`,
`mcp/server.py`'s `get_transcript`/`analyze_video`) stay as the **validated
reference implementation** — the design, the tuning, the 4-content-type test
results transfer directly; the code is a rewrite (FastAPI endpoint +
Rust + TS + MCP tool, not a bare CLI script), not a port.

## Concrete phases

1. **Spike**: confirm the two-sidecar decision (or the alternative,
   single-venv-rebuild spike above) with a real install attempt, not just
   reasoning about it.
2. **`ai-media/server.py`** (or whatever it ends up named): two endpoints,
   `POST /transcribe` and `POST /understand_video`, each a thin wrapper
   around the already-validated logic from `video_understand.py` /
   mlx-whisper — port the logic, don't redesign it.
3. **Rust supervisor**: extend `apelles_ai::sidecar`'s pattern for the second
   process (or generalize it to supervise N sidecars if that's cleaner —
   judgment call for whoever picks this up, not decided here).
4. **Control-server ops + MCP tools**: `editor_get_transcript`,
   `editor_analyze_video` in `useEditorControl.ts`; matching tools in
   `mcp/server.py`.
5. **Retire the videoAgent standalone version** once (4) is live-tested
   end-to-end (open app, real MCP call, real result) — not before.

## What actually shipped (2026-09-07) — phases 1-4 done, phase 5 open

Everything above this line is the ORIGINAL scope, left as written so the plan
and the outcome can be compared. This section is the outcome. Decisions:
**D-189** (the capability + the spike) and **D-190** (the N-sidecar supervisor).

**Phase 1 — spike: done, and it settled the question outright.** The scope
asked for a real install attempt rather than reasoning, and both halves were
actually run:
- The recommended path **works**: a fresh `ai-media/.venv` took `mlx-vlm` +
  `mlx-whisper` + `fastapi` + `uvicorn` together with no conflict (`mlx 0.32.2`
  / `mlx-vlm 0.6.17` / `mlx-whisper 0.4.3` / `transformers 5.16.1` /
  `tokenizers 0.23.2` / `numpy 2.4.6`), imports clean, Metal matmul runs on
  `Device(gpu, 0)`.
- The stated alternative (rebuild `ai/.venv` on mlx-vlm's versions) is
  **mechanically impossible**, not merely risky: `pip install --dry-run` of
  `ai/requirements.txt` ∪ `{mlx-vlm, mlx-whisper}` in a clean venv exits
  `ResolutionImpossible` — every `mlx-vlm >= 0.6` requires
  `transformers >= 5.5`, `ai/` pins `< 5`. Recorded in D-189 with the caveat
  that the pin itself is not the blocker (ViTMatte's classes do still exist in
  transformers 5.16.1); the real cost would be dragging `torch 2.13 → 2.14`
  and `transformers 4 → 5` under a live SAM 2 / ViTMatte / VDA / MoGe-2 stack,
  bought for nothing but avoiding one more supervised process.

**Phases 2-4 — done.** `ai-media/` (`server.py` + `video_understand.py` +
`transcribe.py` + `README.md`), `apelles_ai::media_understanding`,
`app/src-tauri/src/chroma/media_understanding.rs`, `@apelles/editor`'s
`mediaUnderstandingStore.ts`, the ops in `useEditorControl.ts`, the tools in
`mcp/server.py`, and a second Settings status card.

**Phase 5 — NOT done, deliberately.** The videoAgent prototype
(`src/review/video_understand.py`, `mcp/server.py`) is untouched and still the
reference implementation. The scope's own condition for retiring it is "once
(4) is live-tested end-to-end (open app, real MCP call, real result)" — see
"What was live-tested" below for exactly which layers were and were not. Do
not delete anything in that repo until an owner has driven `editor_analyze_video`
from a running Apelles app at least once.

### Deviations from the plan, and why

1. **Four MCP tools, not two.** The scope sketched `editor_get_transcript` and
   `editor_analyze_video`. Both had to become start-then-poll pairs (plus
   `*_status`) because `chroma::control`'s `BRIDGE_TIMEOUT` is **20 seconds**
   (`app/src-tauri/src/chroma/control.rs`) while a transcript takes tens of
   seconds and an analysis runs at roughly 4x realtime. A blocking tool would
   504 every time and the result could never reach an agent. This is not a new
   pattern — `/track` and `/depth_track` in `ai/server.py`, and their
   `depth_track`/`depth_track_status` MCP pair, already work exactly this way
   for exactly this reason. The sidecar endpoints are correspondingly
   `POST /transcribe` + `GET /transcribe/{job_id}` (and the same for
   `/understand_video`), rather than the two bare POSTs the scope named.
2. **The supervisor was generalized, not duplicated** (D-190). The scope left
   this as an explicit judgment call ("or generalize it to supervise N sidecars
   if that's cleaner"). Generalizing won: copying ~450 lines containing the
   D-101 staleness policy, the backoff ladder and the shutdown races would
   guarantee drift. `ai/`'s behaviour, call sites and tests are unchanged.
3. **No model weights are resident in the sidecar process.** Every model call
   is a subprocess. Not in the scope at all; added because `ai/server.py`
   needed a whole TTL idle-unloader (D-084) after its lazy singletons never
   released weights, and a second sidecar holding ~6 GB of MLX weights idle
   would have re-created that problem rather than avoided it. It also keeps the
   VLM invocation byte-identical to the validated prototype's, whose tuning is
   expressed as `mlx_vlm.generate` CLI flags.
4. **`transcribe.py` dropped the prototype's `lightning-whisper-mlx` backend.**
   It cannot produce word-level timings (segments only), which is the entire
   reason Apelles wants a transcript — keeping it would be an unusable second
   model dependency. Its `--quant`/`--batch-size` knobs went with it.
5. **The two analysis ops are the one documented exception** to
   `mcp-architecture.md`'s "a mutating op goes through the same store action a
   GUI click does." They mutate nothing, so there is no undo history to
   preserve; that doc already carves out read-only ops.
6. **Results are cached by source path** in the frontend store. Not in the
   scope; added because an agent asks about the same file across separate tool
   calls with no memory of the previous one, and each miss costs the full model
   run again. In-memory only — a `media_cache` disk namespace is the obvious
   next step and is deliberately out of this pass.

### What was live-tested vs. only type-checked

**Live, against real footage, with the sidecar actually running on :8766:**
- `POST /transcribe` + poll on an 18 s talking-head clip → correct English
  transcript, 3 segments, **55 word-level timings**, 11.9 s.
- `POST /understand_video` + poll on that same clip (`max_candidates=6`) →
  1 candidate, the 0.5 s seed. Scene-detect correctly found no cut in a
  continuous shot — the documented behaviour, not a failure.
- `POST /understand_video` on a 20 s cut-heavy product reel
  (`max_candidates=5`, `min_gap_s=1.5`) → **37.9 s**, 5 candidates → 5
  descriptions, 1:1 zip, correct ffmpeg-derived timestamps,
  `truncated: true` correctly reported. It also reproduced the known
  semantic-repetition limit on the last two near-identical frames.
- `mcp/server.py` imported in a clean venv: **66 tools, no name collisions**,
  all 4 new tools registering with full descriptions and the expected params.

**Not live-tested — built, type-checked and unit-tested only:** the middle of
the chain (MCP tool → control server → Tauri event → op → Tauri command),
because that requires a running Apelles desktop app, which this pass could not
launch. Covered instead by: `cargo check -p apelles` building, `cargo
fmt`/`clippy` clean on all new Rust, 22 `apelles-ai` unit tests (5 new: registry
isolation, spec disjointness, dev-layout dir resolution for BOTH sidecars),
`tsc -p packages/editor` clean, and **13 new unit tests** for the store's job
protocol (polling terminates on `unknown`, cache hits/misses, `force`, a failed
background job recorded as an error rather than an unhandled rejection).

**The one thing an owner should do before trusting this end-to-end**: open the
app, confirm both Settings sidecar cards read healthy, then call
`editor_get_transcript` and `editor_analyze_video` over MCP against a real
clip. That is also phase 5's precondition.
