# Pre-launch plan — monetization, cloud AI, and distribution

Owner, 2026-09-08: four things to plan now and build **last, right before launch** —
explicitly not now, not blocking the Edit-tab build-out in progress. This note is the
research-and-scope pass; none of the four below has been built. Revisit this note
before starting any of them, rather than re-deriving the landscape from scratch.

**Sequencing, per the owner's own framing:** all four are launch-adjacent
infrastructure, not editor features. They belong in the roadmap's "Then" tier
(`docs/04-roadmap.md`), after the Resolve-parity backlog (roadmap 27) is
substantially done, not interleaved with it.

---

## 0. The one thing to resolve before any of the other three — licensing

**This is the load-bearing decision, and it was already flagged, unresolved, in
`docs/08-decisions.md`'s D-002 before tonight:**

> D-002 — Chroma's own license: **open** (undecided). Leaning: AGPL-3.0 for the
> whole project... **Blocks a closed SaaS**; does not block an open project,
> sponsorships, or paid support. **Decide before: first public push.**

Items 2 and 3 below (a paid-credits backend, a cloud AI sidecar) are exactly the
"closed SaaS" shape D-002's own leaning flags as blocked by a straight AGPL
posture on the whole codebase. This repo vendors RapidRAW at `app/` under
AGPL-3.0 (D-003) — that part of the binary is AGPL regardless of what Chroma's
own code is licensed as, since it's a hard fork, not a separate program.

**The real fork in the road, stated plainly, not resolved here:**
- **Ship everything AGPL**, including any hosted backend. AGPL's own network-use
  clause means anyone who can reach that hosted service as a network user is
  entitled to the complete corresponding source of the service they're using —
  compatible with charging money (paid hosting, paid support are both fine under
  AGPL), but *not* compatible with a backend whose source you want to keep
  closed.
- **Keep the desktop app (the AGPL fork) exactly as is**, and build the NEW
  pieces — the credits/auth/payment backend, and any cloud-AI-sidecar service —
  as **architecturally separate programs** that the desktop app talks to over a
  plain HTTP API, never linked into or derived from the AGPL codebase. This is
  the standard "AGPL app + separate proprietary cloud service" pattern several
  real open-source-desktop-app-plus-paid-cloud-companion products use. It can
  work, but it is a real legal question (what counts as a "combined work" under
  AGPL is about linkage/derivation, not just "runs on a different machine") and
  needs actual legal review before committing to it — not something to assume
  settled from this note.

**Decide before:** starting item 2 or item 3 below. Item 1 (fal.ai) and item 4
(website) don't depend on this — a cloud media-gen call and a marketing site
carry no comparable AGPL exposure either way.

---

## 1. fal.ai — AI media generation, auto-added to the timeline

**What it is.** A unified inference API (REST + WebSocket) fronting 500+
third-party generative models (Kling, Veo, Wan, Hailuo, Flux, Seedream, and
more) behind one interface, near-zero cold starts. Pay-per-successful-output,
prepaid credits, no subscription tier: images roughly $0.02–0.03 each; video
roughly $0.05/sec (Wan 2.5) up to $0.40/sec (Veo 3); raw GPU-second billing is
also available (H100 $1.89/hr, A100 $0.99/hr) for anyone wanting to run their
own model behind fal's infra instead.

**Integration shape.** Every model supports a synchronous call plus an async
queue (submit → poll or webhook) — a real text-to-video job is 10–60s+ and
**must** go through the queue+webhook path, not a blocking sync call. Official
SDKs: Python, JS/TS, Swift, Kotlin/Java, Dart — **no Rust SDK**, but it's plain
HTTP+webhooks, so Rust could call it directly via `reqwest` if that's ever
wanted. The better architectural fit for THIS repo specifically: the existing
Python sidecar layer (already the home for CLIP embeddings, the relight
normal-map model, and mlx-audiocraft SFX generation) is the natural place for
a fal.ai client to live — same process boundary, same "Rust talks to a local
Python service over HTTP" pattern already established, no new architecture.
The async queue+webhook shape also matches how `editor_analyze_video`/
`editor_get_transcript` already do long-running-job polling in this codebase
— reuse that pattern rather than inventing a second one.

**UX precedent.** Runway is the model to follow, not a generic "generate, then
download, then import" flow: generation and editing share one window — a clip
you generate lands directly on the timeline, ready to trim/stack/grade like
any other clip. The practical shape here: a "Generate" panel or an
empty-timeline-slot affordance that, on completion, calls the SAME
`editor_add_clip`/`editor_import_media` machinery a human's drag-and-drop or
an agent's own MCP call already uses — not a parallel "generated clips" system.

**The flag, not resolved:** a fal.ai call is inherently a cloud call — direct
tension with CLAUDE.md's own "local-first... any cloud call is an explicit
opt-in fallback, never a default" rule. Build it behind an explicit,
visible opt-in, clearly walled off from the core local grade/edit path (which
must keep working with zero network calls, exactly as today), never as
something that fires by default.

---

## 2. Lightweight backend — sign-in, credits, payment, usage tracking

**Depends on item 0 above being resolved first.**

**Auth + backend.** **Supabase** (Postgres + auth + edge functions) is the
concrete recommendation — real, documented Tauri-desktop integration precedent
exists (a Tauri 2.0 + Google OAuth + deep-links guide; a working
`tauri-oauth-supabase` reference project), one vendor covers auth + database +
serverless functions with minimal glue code, generous free tier, and it's
self-hostable later if that ever matters. The desktop-native auth flow: open
the OAuth provider in the **system browser** (not the embedded webview, in
production), catch the callback via a deep link or a local callback server —
the standard native-app substitute for a website's normal redirect flow.
Clerk is auth-only and would need pairing with a separate DB; note its own
Supabase integration was deprecated April 2025, so if Supabase is the DB
choice, use Supabase Auth directly rather than routing through Clerk.

**Payment/credits.** Stripe is the standard choice. Stripe shipped native
Credit Grants (Feb 2025) — a real ledger primitive, but API-only: no
customer-facing balance UI, no auto-top-up flow, no dashboard, so the
enforcement/UI layer is still real work. The desktop-specific wrinkle: there
is no server-side web session, so the desktop app authenticates to **your own**
backend (via the Supabase token above), and only your backend ever talks to
Stripe — the desktop binary never holds a Stripe key. For a solo/indie team,
Paddle or Lemon Squeezy (merchant-of-record — they handle global tax/VAT
compliance) are commonly the better starting choice over raw Stripe, until
volume justifies the fee difference and the extra compliance work of handling
it yourself.

**Usage tracking.** PostHog is the open-source default but is genuinely heavy
to self-host (ClickHouse + Kafka + Redis + Postgres) — either use PostHog
Cloud's free tier, or a lighter self-hosted option: OpenPanel (2.3KB SDK, free
unlimited self-hosted events) or Plausible (sub-1KB script, privacy/GDPR-
first).

**Architecture, confirmed not assumed:** the "lightweight backend" is a
separate small hosted service, not anything embedded in the Tauri/Rust binary
— the desktop app calls it over HTTPS with a stored token. This is the
standard pattern for this class of app, not something unusual to invent.

---

## 3. AI sidecar on a remote GPU pod — opt-in cloud fallback

**Depends on item 0 above being resolved first** (same "closed SaaS" shape).

**Why:** this repo's AI features already run entirely locally via Python
sidecars — CLIP embeddings/matte generation, an image-relighting normal-map
model, mlx-audiocraft for SFX. A remote-GPU option would let users without
capable local hardware (or on non-Mac hardware — see the MLX blocker below)
opt into a cloud-run equivalent instead.

**Providers, for bursty/occasional inference (not training):**
- **RunPod Serverless** — cheapest per-GPU-second for high-concurrency custom
  deployments on A100/H100; sub-200ms cold starts for roughly half of requests
  via FlashBoot. Takes any Docker container as-is — a thin handler wrapper
  around an existing model, not a rewrite. Best fit here for full
  custom-container freedom.
- **Modal** — code-first (a Python function + a container image); fastest
  *warm* restarts via full GPU-memory snapshots (~1.8s). Same custom-container
  freedom as RunPod, different developer experience (Python decorators vs. a
  Dockerfile).
- **Replicate** — best for using models you don't own (a huge public catalog,
  one-line API); a weaker fit for hosting Chroma's own fine-tuned/custom
  models as a first-class deploy.
- **Baseten** — production-grade (SLAs, monitoring, TensorRT-LLM/vLLM
  backends); more overhead than an indie sidecar workload needs until usage is
  real enough to justify it.

All four scale to zero and bill per-second — no idle GPU cost between uses,
which matches sporadic, user-triggered usage (one relight pass, one SFX
generation) rather than an always-on warm service.

**The MLX blocker is real, not hand-wavy.** `mlx-audiocraft` runs on Apple's
Metal via MLX. Metal has **no GPU passthrough in containers** (confirmed by
Docker's own Feb-2026 `vllm-metal` announcement, which runs natively on the
host precisely because containerized Metal access doesn't exist) — none of
RunPod/Modal/Baseten (all CUDA-on-Linux) can run the existing MLX build as-is.
The fix is not "port the container" — it's a **second, separate build target**
for that one sidecar: a CUDA-native equivalent (the original Meta AudioCraft
is PyTorch/CUDA-based, so a cloud-side variant can likely be built from that
rather than from the Mac-only MLX port).

**Architecture shape.** The sidecar calls are already local HTTP to a spawned
Python process (`mcp/server.py`'s own pattern) — swapping the host from
`localhost:PORT` to a remote HTTPS endpoint is mechanically simple, but two
real things are missing today and need adding: an auth token per request (the
local version has none, trusting the local loopback), and either a
blocking-with-timeout or a real job-queue pattern for a cold-starting pod
(RunPod/Modal both have async job-submission APIs for exactly this).

**The flag, same as item 1:** this is exactly the shape CLAUDE.md's own
"local-first... any cloud call is an explicit opt-in fallback, never a
default" rule anticipates. Build it as a toggle the user turns on, local path
staying the default — never a replacement for local sidecars once it exists.

---

## 4. Website

Not deeply researched (lower-risk, well-understood category) — scoped from
this project's own existing positioning docs (`docs/00-vision.md`,
`docs/02-scope.md`) rather than external research. Minimum real scope for a
launch:
- A landing page stating what Chroma actually is (the AI-native local
  video/color tool, 3-tab Edit/Motion/Colorist framing per D-039) and who
  it's for — pull real language from `docs/00-vision.md` rather than
  rewriting the pitch from scratch.
- Download links (once real installers exist — out of this note's scope).
- If item 2 (accounts/credits) ships, the site is also where sign-up/billing
  management naturally lives (Supabase/Stripe both have hosted-checkout and
  customer-portal options that need very little custom UI).
- Docs/changelog surface for users, separate from this repo's own internal
  `docs/` (which is written for contributors/agents, not end users) — a real
  "what's new" page belongs here, not a dump of `CHANGELOG.md`.
- License/AGPL notice and source-code link, required regardless of how item 0
  resolves, since the desktop app itself is AGPL either way (D-002/D-003).

No hosting/framework research done yet — a static site (whatever this team's
own comfort level already is: Astro, plain HTML, a hosted site builder) is
almost certainly sufficient; this doesn't need the same rigor as the backend
items above.
