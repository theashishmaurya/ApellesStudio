# Cloud & embedded-agent architecture (research, not built)

Owner brainstorm, 2026-09-02. Not a decision, not scheduled — a documented plan so this
doesn't get re-derived when it's actually time to build it. Nothing here contradicts
`CLAUDE.md`'s local-first invariant: everything below is explicit opt-in infrastructure a
user or the project chooses to stand up, never a default network call in the grade path.

Three separate ideas came up in one conversation — kept separate here because each has a
different design and a different trust boundary.

## 1. Running the *existing* sidecar remotely (your own GPU, self-hosted)

Today `ai/`'s sidecar is a local Python process Rust manages over HTTP, hardcoded to
`localhost:8765` (D-028). The clean move isn't a new architecture — it's making "where the
sidecar lives" a config value instead of an assumption:

- Sidecar base URL + an optional bearer token move into settings (token in the OS Keychain,
  never plaintext).
- Same wire protocol, same endpoints (`/track`, `/segment`, …) — zero protocol change.
- Add TLS + the auth token since it's now a real network hop, and a connect/health-check
  with a clear "unreachable" state instead of silent failure.

This alone gets you "sidecar in the cloud": rent a GPU box (RunPod, Lambda, your own),
run the exact same Python service there, point the setting at its URL. Different trust
boundary than sending data to a third party — it's still infrastructure *you* own.

## 2. Swapping in a third-party vision model (Gemini, or anything else)

Needs a real abstraction — Gemini doesn't speak the sidecar's protocol and can't do
everything SAM2/YOLO do locally (pixel masks vs. boxes).

- A `chroma-ai` crate (already reserved in `architecture-lock.md`'s layer table) defines
  **capability traits, not vendor calls**: `trait VisionProvider { fn segment(...); fn
  caption(...); }`, `trait VideoUnderstanding { fn ground(query) -> [(start,end,confidence)];
  }`.
- `LocalSidecarProvider` and `CloudProvider` (Gemini, etc.) both implement the relevant
  traits. Which one serves a given capability is picked **per capability** in settings, not
  globally — pixel masks only exist locally; long-form video search might only exist cloud.
- Opt-in is **per-call**, not a one-time settings toggle — matches the Explicit-Permission
  pattern already used elsewhere: ask before footage leaves the machine, every time it's a
  new context.
- Cloud calls are background jobs (reuse the existing pattern from SAM2 tracking / depth
  precompute — queued, cancelable, progress-reported), results cached to disk
  (`<clip>/.chroma/...`) so a re-query doesn't re-spend money or bandwidth.
- API keys in the Keychain, never in `project.json` / plaintext settings.
- A simple provider-priority list per capability gives a fallback chain almost for free:
  try local, fall back to cloud only if the user opted that capability in.

This is the same shape already scoped for the visual-understanding feature in
`docs/notes/video-search.md` (Qwen3-VL local default, Gemini 3/2.5 Pro cloud opt-in) — don't
build this as a separate initiative, it's the same work.

## 3. An agent that lives *inside* the app, as chat — not just MCP from outside

The bigger reframe: today the only "agent" driving Chroma is external — Claude Code (or
any MCP client) calling the 38+ MCP tools from a terminal. The idea: a chat panel *inside*
Chroma itself, talking directly to a model (Gemini, Claude, GPT — user's choice), that can
also act on the app.

The hard part is already done: `D-020`'s control server + MCP bridge, `D-032`'s agent
activity feed + `request_human`, and the MCP tool schemas *are* the "what can an agent do
to this app" contract. What's missing is a second front door to the same contract, not a
new one.

- **Don't build a second action API.** The in-app agent's tool-calling loop calls the exact
  same Rust command handlers the MCP server calls today. Never a duplicate implementation
  of the business logic (the standing "no shortcuts" rule).
- **A small agent-runtime in Rust**, not a framework: user message + recent context (active
  shot, timeline, activity feed) → call the chosen LLM with the tool schemas → get text or
  tool call(s) → execute via the same dispatch MCP uses → feed results back → repeat →
  stream to the UI. A few hundred lines, not a subsystem — every major provider (OpenAI,
  Gemini, Claude) has converged on roughly the same function-calling schema, so translating
  the existing MCP tool JSON schemas per vendor is mechanical.
- **A `ChatProvider` trait** (separate from the vision-provider trait in §2) —
  `GeminiProvider`, `ClaudeProvider`, etc. — so the chat brain isn't locked to one vendor
  either. User brings their own API key (Keychain), calls go straight from the app to the
  vendor — no Chroma-run backend/proxy, keeping this out of "hosting a service" territory
  and in keeping with local-first even for a cloud-model chat.
- **UI: a chat panel docked in the shell**, not inside one tab — actions can span
  Colorist/Editor/Motion. Every tool call it makes shows up in the *same* D-032 activity
  feed a Claude-Code-via-MCP session's actions show up in today — one transparency
  mechanism, not two.
- MCP doesn't go away — it stays for automation / power users / sessions like this one. The
  chat panel is a second, friendlier consumer of the same contract.

## 4. Monetizing a hosted-agent tier — the real cost architecture

If (3) becomes a paid, cloud-hosted tier (not BYOK) rather than a local/BYOK feature, two
problems bundled together, solved separately:

**Flat "$20/mo unlimited" is the wrong shape.** Vision-model tokens are expensive per frame,
and an agentic loop (read state → act → re-read state → iterate) multiplies calls — a
video-editing agent's worst-case session cost is meaningfully higher than a coding agent's.
Cursor and early Replit Ghostwriter both had to walk back "unlimited" once real usage data
came in, with real backlash. **Launch metered, not unlimited**: $20/mo buys a credit
allowance (a $ of underlying spend, converted to a credit number with margin baked in),
overage is Stripe metered billing or a graceful downgrade to a cheaper model, never a hard
cutoff.

**"Session management" here really means: build and operate a real backend.** A desktop app
can't hold your provider API keys client-side (reverse-engineer the binary, extract the key,
free API access on your dime). Needed: an auth+metering gateway that holds *your* provider
keys (never the client's), authenticates the subscription, deducts credits from a
server-side ledger, routes the call, and integrates Stripe for billing + overage. This is
real ongoing infra to run (auth, a database, abuse/rate-limit protection, uptime) — not a
weekend add-on, and a materially bigger commitment than "add a cloud AI call." Worth sizing
honestly against the owner's stated priority ("just want my life to be easy first" —
2026-08-xx) before committing to it.

**Before picking a number**: instrument real token/$ cost per action on whatever the app
already does (this session's own MCP tool-calling pattern is a decent proxy) against current
retail API pricing. That tells you whether $20/mo is in the right ballpark or whether it
needs to be higher, or credit-based with no flat tier at all — don't guess a price first.

## fal.ai specifically — checked live, 2026-09-02

fal is a strong fit for §1/§2's "serverless, autoscale-to-zero GPU" piece, and this repo
already has `FAL_KEY`/`fal_client` wired in (videoAgent's Dozy Wonders pipeline, this repo's
own `mcp__fal-ai__*` tools) — same account, same trust already established.

- **fal Serverless** (`fal.App`, `machine_type = "GPU-H100"` etc., `fal deploy`) is exactly
  the "deploy your own custom Python/GPU code, scale from zero" pattern — real, documented,
  not hypothetical. Billing is strictly per-second of runner-alive time (setup, idle
  `keep_alive`, active processing, draining) — **not** billed for pending time or image
  pulls, and with `min_concurrency` left at its default there's no warm runner sitting
  around costing money when there's no traffic. GPUs available: RTX 4090/5090, A100, L40,
  H100, H200, B200.
- **The catch**: deploying a *custom* app (as opposed to calling their marketplace models,
  which is what this repo already does today) is flagged in fal's own docs as an
  **Enterprise Feature requiring requesting access** — separate from a normal pay-as-you-go
  API account with existing credits. Request access via fal's "Serverless Get Started" page
  before assuming this is unlocked by credits alone.
- **fal Compute** (dedicated GPU, SSH, hourly fixed rate) is the *other* fal product — this
  is the "always-on, real ongoing cost" trap from the cost-breakdown discussion above. Not
  the right tool for a pre-revenue, zero-traffic stage; that's what Serverless is for.
- No confirmed live $/GPU-second rate was found in indexed docs — check `fal.ai/pricing` or
  the dashboard for the current number before this becomes a real cost estimate, don't reuse
  a guessed figure.

## Zero-user idle cost, if built correctly

The whole point of "serverless everything" is that idle cost approaches zero without users
to justify real spend:

| Piece | Correctly-architected (serverless/free-tier) | The trap (always-on) |
|---|---|---|
| LLM API calls | $0 — pure pay-per-token | n/a, never fixed-cost |
| Auth/metering gateway | $0–6/mo (serverless or a $5 VM) | — |
| Database (credits/auth) | $0 (Supabase/Neon/Railway free tier) | — |
| AI sidecar GPU | $0 (fal Serverless / RunPod Serverless / Modal, scales to zero) | $220–360+/mo (an always-on dedicated GPU instance, doing nothing) |

**Realistic total, built correctly, zero users: $0–15/month.** The one decision that
actually matters is never touching an always-on GPU instance before there's traffic data to
justify it — that single choice is the difference between ~$0 and hundreds of dollars a
month for doing nothing.

## Status

Nothing here is scheduled. Revisit when the local-first v1 (still the active priority per
`docs/02-scope.md`) is far enough along that "last stage: go cloud" is a real next step, not
a distraction from it.
