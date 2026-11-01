# Monetization plan: Apelles Pro (proposed, 2026-11-01)

Status: **proposal for owner approval** (D-438). Nothing here is built yet. Prices quoted from third-party sources are marked "verify". Re-check them on each provider's own pricing page before committing to anything.

## 1. The model in one line

**Everything that runs on the user's Mac stays free and open (AGPL). Pro charges for what costs us money or saves the user setup: hosted AI, cloud compute, publishing.**

There are two reasons:

- **The licence.** Apelles is AGPL-3.0, inherited from RapidRAW. Anyone can build the app from source, so a paywall on a local feature is unenforceable and would read as hostile to the open-source audience.
- **Cost.** A hosted model, a cloud GPU and a publishing integration are real recurring costs, and creators already pay for exactly these: Descript, Opus Clip, CapCut Pro.

## 2. Plans and pricing

| Plan | Price | Who it's for |
|---|---|---|
| **Free (open source)** | $0 | Everyone. The full editor, local AI, MCP for your own agent, BYOK or local-model chat. |
| **Pro** | **$20 / month** or **$192 / year** ($16 / month) | Creators who want the built-in AI editor to just work, plus cloud extras. |
| **Credits** | top-up packs, e.g. **$10** | Heavy months and premium models. Never a surprise bill: Pro stops at the allowance until topped up. |
| **Team** (later) | ~$40 / seat / month | Agencies: shared brand kits, seats, admin. |

- **Regional pricing:** e.g. India around ₹999 / month. The merchant of record (section 6) handles localised prices and tax.
- **The Pro allowance** is metered in **AI credits**, not raw tokens, so pricing survives model price changes. Start with an allowance worth about **$6 of model cost a month**, roughly 30% of revenue, leaving margin for the payment fee (about 5%), cloud costs and heavy users. The plan says "about N full-video edits a month" in plain words.

## 3. Rough unit economics (estimates; verify the token counts with the bake-off)

| Item | Assumption | Cost |
|---|---|---|
| One AI edit session (a 10-minute video: cleanup + shorts + captions) | 1–3 M input tokens (mostly cacheable transcript and timeline context) + 50–150 k output | **$0.10–0.80** on a cheap open model; **$2–8** on a Claude Sonnet-class model |
| Pro user, typical month | 10–25 sessions on the default model | **$2–10** |
| Payment fee (merchant of record) | ~5% + $0.50 | ~$1.50 on $20 |
| Backend (Cloudflare Workers + D1 + R2) | first thousands of users | near $0–25 / month total |

**Conclusion:** $20 holds a healthy margin if the default is a cheap open model and premium models go through credits. The bake-off (section 9, step 1) replaces these guesses with measured numbers.

## 4. Do we need a backend? Yes, a thin one

**The agent loop runs inside the app.** The app holds the 269 MCP tools, the skills and the project, and it calls the model. **Media never leaves the Mac**; only text does (the transcript, timeline state, tool calls). That keeps the local-first promise, and any cloud call is opt-in (CLAUDE.md).

The backend exists only for what the app cannot do safely:

| Piece | What it does | Built on |
|---|---|---|
| **Auth** | sign-in (email magic link + Google/Apple), short-lived session tokens | Cloudflare Worker; Resend for email (already set up for the waitlist) |
| **Model proxy** `/v1/chat` | an OpenAI-compatible, streaming endpoint; holds our provider keys; routes to a model per tier; **meters usage** per user; enforces the allowance | Cloudflare Worker |
| **Entitlements and usage ledger** | plan, credits, monthly usage | Cloudflare D1 (same stack as the waitlist) |
| **Rate limits / abuse** | per-user and per-IP limits | Durable Objects or KV |
| **Billing webhook** | the merchant of record tells us about subscribed / renewed / cancelled, and we update entitlements | Worker endpoint |
| **Later: temp upload host** | Instagram publishing needs a hosted video URL; cloud renders | Cloudflare R2, short-lived signed URLs, auto-delete |
| **Later: cloud GPU jobs** | high-accuracy transcription, cloud 4K / Motion renders | serverless GPU (Modal / RunPod / Replicate). Only when a feature needs it. |

**Not on the backend:** the user's media, projects, and the agent's reasoning loop.

## 5. Where keys and tokens are stored

| Secret | Where it lives | Never |
|---|---|---|
| **Our provider keys** (DeepInfra / Fireworks / Anthropic …) | **Cloudflare Worker secrets only** (`wrangler secret put`, run by the owner, as today) | in the app binary, repo, logs or client |
| **The user's Apelles session** | a short-lived access token (~1 h) plus a refresh token, in the **macOS Keychain** via a Rust keychain crate behind a Tauri command | in project files, `localStorage` or plain settings JSON |
| **BYOK keys** (free tier: the user's own Claude / OpenAI / DeepSeek key) | the **macOS Keychain**; calls go **straight from the app to the provider**, not through our backend | sent to our servers |
| **Local models** | none needed (Ollama / MLX on the Mac) | — |
| **Social accounts** (later: YouTube / Instagram / TikTok OAuth) | refresh tokens in the **Keychain**; for Instagram's hosted-URL flow, the backend gets a one-time token per upload | stored long-term server-side unless required |

The app never sees our provider keys. The backend never sees the user's media. A stolen session token expires in about an hour and can be revoked from the backend.

## 6. Payments: a merchant of record, not raw Stripe

**Recommended: Paddle** as merchant of record (MoR).

- It is the legal seller: it collects and remits **VAT / GST / sales tax worldwide**, handles chargebacks and refunds, supports subscriptions plus one-off credit packs, does localised pricing, and pays out to India.
- It remains independent (Lemon Squeezy is now owned by Stripe).
- Fees are around 5% + $0.50 per transaction (verify).

| Option | Verdict |
|---|---|
| **Paddle** (MoR) | ✅ the best fit for a solo founder in India selling globally |
| **Lemon Squeezy** (MoR, Stripe-owned) | fine alternative, similar fees; reportedly an extra charge on international sales (verify) |
| **Dodo Payments** (India-focused MoR) | worth a look for India payouts and pricing; less established |
| **Stripe** directly | ❌ not an MoR: we would owe tax compliance in every country; Stripe India reportedly invite-only (verify) |
| **Razorpay** | only if we later sell INR-domestic plans separately |

**Before choosing, verify directly with Paddle:** India payouts and FX, approval for a desktop app with a hosted AI service, and the fee schedule.

## 7. What stays free vs what is Pro

### Free and open (AGPL; runs locally)
- **The whole editor**: Edit, Motion, Colorist; the redesigned timeline; the Inspector.
- **All local AI**: Parakeet transcription, retakes and silence cleanup, masks and depth, opt-in video understanding, beats, loudness.
- **Export** (all formats and presets), the safe-area guides, captions.
- **The MCP server**: use Apelles with Claude Code or any agent you bring.
- **Built-in AI chat with your own key or a local model** (BYOK / Ollama / MLX).
- **Basic Motion templates** and the brand kit (local).

### Pro ($20 / month)
- **The built-in AI editor, zero setup**: hosted models with a monthly allowance; premium models (Claude) through credits.
- **One-click Shorts autopilot**: Clipper → captioned 9:16 shorts, ready to post.
- **Direct publishing** to YouTube, Instagram and TikTok (roadmap 00d), with scheduling.
- **Cloud extras**: high-accuracy cloud transcription (the Nemotron idea), and cloud 4K / Motion renders that keep the Mac free.
- **Sync**: brand kits, presets and templates across devices.
- **Premium Motion templates**, and later a marketplace with a revenue share (Motion is the moat, v0.4).
- **Priority support.**

**Rule for future features:** if it runs entirely on the user's Mac with no recurring cost to us, it's free. If it needs our servers, a paid API or a platform integration we maintain, it can be Pro.

## 8. Models: the cheap default and alternatives (choose by bake-off, not by blog)

Prices are $ / M tokens (input / output) from third-party aggregators, mid-2026. **Verify all of them.**

| Model | Indicative price | Notes |
|---|---|---|
| **DeepSeek V3.2 / V4** (open weights) | ~$0.14–0.44 / $0.28–1.10 | the budget leader for agents; strong cache discounts for repeated tool definitions. **Use US-hosted weights** (DeepInfra / Fireworks / Together), not DeepSeek's own API: data-residency concerns for many creators and companies |
| **Kimi K2** (open weights) | verify | known for strong agentic tool use; a bake-off candidate |
| **Qwen3** (235B / Coder) | verify | strong and cheap; a bake-off candidate |
| **GLM-4.6 / 5.x** | ~$1.40 / $4.40 (GLM-5.2) | pricier; good at agentic coding |
| **MiniMax M3** | ~$0.30 / $1.20 | a cheap alternative |
| **GPT-OSS-120B / 20B** (open weights, US-origin) | very cheap (20B ~$0.07 blended) | good tool calling; the trust story is simpler; great for small tasks |
| **Claude Haiku / Sonnet** | premium | the reliability ceiling for hard multi-step edits: **the credits tier** |

**Routing plan:**
- default "Apelles Fast" = the bake-off winner among the cheap open models;
- small tasks (titles, descriptions, glossary fixes) = GPT-OSS-20B or a Haiku class model;
- "Apelles Pro brain" for hard edits = Claude Sonnet, on credits.

During the bake-off, use **OpenRouter** for one API across all candidates, then go **direct to the chosen host** for price and latency in production.

**Making cheap models reliable on 269 tools:**
- send only the tools relevant to the current tab or task (tool subsets);
- use the skills as system prompts;
- cache the tool definitions and project context;
- validate the model's tool arguments against the schemas and let it retry once on error.

## 9. Rollout, month by month (from when credits are back; after v0.3.0)

| Month | Deliverable |
|---|---|
| **1** | **The model bake-off**: 10 real editing tasks (silence and retake cleanup, 4 shorts with captions, music bed and ducking, a roll/ripple-heavy edit…) through 5–6 models via OpenRouter, measuring task success with the UI harness and MCP state, tool errors, latency and cost per task. **Built-in chat MVP** in the app with BYOK + local models (free tier; proves the experience). D-438 updated with the chosen default. |
| **2** | **Backend v1**: auth, the model proxy with metering, D1 ledger, Keychain storage in the app. **Paddle** integration (Pro subscription + credit packs, webhooks to entitlements). **Private Pro beta** for the waitlist (34 people so far). |
| **3** | **Public launch of Pro** alongside **v0.4.0 "the Motion release"**. Pricing page on apelles.studio, privacy policy and terms (what text is sent to models, retention), refund policy. |
| **4+** | **Direct publishing** (00d), cloud transcription, cloud renders, sync, then the Motion template marketplace and the Team plan. |

## 10. Legal and policy checklist (not legal advice; confirm with a lawyer)

- **AGPL:** the app stays AGPL with its source public. The backend can stay closed **as a separate service talking over an API**, not derived from AGPL code.
- **Model hosts' terms:** confirm that reselling access inside an app is allowed (it's standard for API products). Anthropic's commercial terms apply to Claude use.
- **Privacy:** state exactly what leaves the Mac (text only, not media), retention (none or short), and that providers don't train on it (pick hosts with no-retention options).
- **Payments:** the MoR handles tax. We still need terms, a refund policy and an export-control check for AI features.
- **Brand:** "Apelles Pro" naming, and trademark checks.

## 11. Open questions for the owner

1. $20 / month with about $6 of included model cost: right, or a lower $12 "Creator" tier too?
2. Launch Pro with v0.4.0 (Motion), or earlier with v0.3.0?
3. Paddle as MoR: OK to start the verification (India payouts)?
4. Should BYOK chat be free forever? (Recommended: yes. It costs us nothing and grows adoption.)

---
Sources (third-party price and payment guides, mid-2026; verify on the providers' own pages):
- DeepSeek V3 pricing: <https://deploybase.ai/articles/deepseek-v3-pricing>, <https://www.llmreference.com/model/deepseek-v3/deepinfra>
- Cheap agent models: <https://www.betterclaw.io/blog/cheapest-ai-models-for-agents>, <https://remoteopenclaw.com/blog/best-cheap-models-for-hermes>
- MoR comparison: <https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/>, <https://dev.to/devtoolpicks/lemon-squeezy-vs-stripe-vs-paddle-which-should-solo-devs-use-in-2026-2jm9>
- Claude subscriber API credits: <https://platform.claude.com/docs/about-claude/api-credits-for-subscribers>
