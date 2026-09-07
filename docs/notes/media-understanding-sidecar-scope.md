# Scope: extract video/audio understanding into the `ai/` sidecar, expose via Chroma's own MCP only

Owner asked 2026-09-07, after a same-day prototype in the sibling `videoAgent`
repo validated the approach on real footage: pull that prototype's two
capabilities into Chroma properly — `ai/` sidecar, exposed only through
Chroma's own `mcp/server.py` — rather than leaving a second, separate
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
the same process. Same supervised-subprocess pattern `chroma_ai::sidecar`
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

**Retire it once Chroma's own version is live and tested**, don't run both
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
3. **Rust supervisor**: extend `chroma_ai::sidecar`'s pattern for the second
   process (or generalize it to supervise N sidecars if that's cleaner —
   judgment call for whoever picks this up, not decided here).
4. **Control-server ops + MCP tools**: `editor_get_transcript`,
   `editor_analyze_video` in `useEditorControl.ts`; matching tools in
   `mcp/server.py`.
5. **Retire the videoAgent standalone version** once (4) is live-tested
   end-to-end (open app, real MCP call, real result) — not before.

Not started. This is scope only, per the owner's explicit ask ("write the
scope"), so whoever picks this up next has the real risk (dependency
isolation) and the real chain (sidecar → Rust → store → op → MCP) already
laid out instead of re-deriving both from scratch.
