# Agent chat: an in-app panel driving the user's own Claude Code / Codex CLI

**What this is.** The design for roadmap item **00h** — a chat panel inside Apelles that
drives the user's **own installed, officially logged-in** agent CLI (Claude Code or OpenAI
Codex), pointed at Apelles' own MCP server, so the ~275 MCP tools this app already exposes
become reachable without a terminal. Proposed as **D-460**.

**What it does.** Answers the eight questions the roadmap item left open: how the CLI is
driven, how it is detected, how permissions reach the user, how the chat reaches the same
ops the GUI uses, what the panel looks like, what leaves the machine, the phase plan, and
the open questions for the owner.

**What it does NOT do.** It is not an implementation, and no product code was written for
it. It does not design the **BYOK / hosted** chat of D-438 and
`docs/notes/cloud-agent-architecture.md` §3 — that is a different front door to the same
contract, and §10 below states how the two relate. It does not settle the vendor-terms
question (§9, open question 1), which is the owner's to settle and is a gate on shipping,
not a detail. It does not design background/headless operation (roadmap 00f) or the
REST/WS split (00i), though §4 is built so neither has to be redone.

**Status: PROPOSED.** Nothing here is decided. `docs/08-decisions.md`'s D-460 is marked
proposed and awaiting the owner.

---

## 0. Why this is worth building

Today Apelles' AI-native tagline costs a user: install Node, install Claude Code, open a
terminal, register an MCP server, keep the app running, and learn that the tools exist at
all. `ConnectMcpDialog.tsx` (D-313) is as far as the product can take them — by its own
doc comment it "performs no setup and makes no connection itself." Everything past that
dialog is the user's problem.

Three facts make an in-app panel cheap:

1. **The app already runs the MCP server.** `apelles-mcp --http --port 19790` is a
   supervised sidecar (D-313, `app/src-tauri/src/chroma/sidecar.rs`), with
   `chroma_mcp_port` and `chroma_mcp_status` commands already exposed. There is nothing to
   spawn and no path to resolve — a client needs a URL.
2. **The agent's edits are already reviewable.** Every mutating MCP op runs the same store
   action a GUI click does (D-020, D-140), is stamped `source: 'agent'` on the shared
   `@apelles/history` stack (D-298) and shows in the Agent activity feed (D-032/D-435)
   with per-row undo for Colorist and global Cmd+Z for Edit and Motion.
3. **Inference costs us nothing.** The user's own CLI, the user's own subscription, no
   backend, no keys in our process, no Keychain code (this repo has none today).

What is genuinely missing is a *host*: something that spawns the CLI, gives it Apelles'
MCP config and Apelles' own skills, renders its stream, and puts its permission prompts in
front of the user. That is this design.

**A fourth fact, which is itself an argument.** The seven `apelles-*` skills that teach an
agent how to edit in this app (`apelles-explainer-edit`, `apelles-sound-design`,
`apelles-voiceover-cleanup`, `apelles-retake-review`, `apelles-auto-clip`,
`apelles-brand`, `apelles-youtube-package`) live in **this repo's** `.claude/skills/`. A
user running Claude Code in their own footage folder gets none of them. The in-app panel
can ship them (§4.4) — so it is not only a nicer front door to the same capability, it is
the only way most users would get the good version of it.

---

## 1. How the CLI is actually driven

Everything in this section is marked **[verified]** (run on this machine, 2026-11-14, or
read on the vendor's own current docs), or **[inferred]**.

Versions on the development machine, 2026-11-14: Claude Code **2.1.322**, Codex CLI
**0.166.0** [verified: `claude --version`, `codex --version`].

### 1.1 Claude Code — headless (`-p`) vs the Agent SDK

**The flags that matter exist, with these exact spellings** [verified:
`claude --help` on 2.1.322; cross-checked against
<https://code.claude.com/docs/en/cli-reference.md>]:

| Flag | What it gives this design |
|---|---|
| `-p` / `--print` | non-interactive; the only mode the stream flags work in |
| `--output-format stream-json` | newline-delimited JSON events, one per line, last line is `result` |
| `--input-format stream-json` | **multiple user turns into one long-lived process over stdin** |
| `--include-partial-messages` | `stream_event` lines carrying raw `content_block_delta`s — token-by-token text |
| `--replay-user-messages` | our own submitted turns echoed back, so the UI can ack a queued turn |
| `--session-id <uuid>` | **we choose the id**, so a conversation is ours to key on |
| `-r` / `--resume [id]`, `--fork-session` | reopen a conversation later; fork instead of appending |
| `--mcp-config <json-or-file>`, `--strict-mcp-config` | point it at Apelles only, ignore the user's own MCP servers |
| `--restricted` | **removes Bash / PowerShell / the code-running tools and WebFetch**, ignores user/project/local settings, confines file tools to the working dirs, refuses `bypassPermissions` |
| `--tools ""`, `--disallowedTools`, `--allowedTools` | the built-in tool set; `--allowedTools` *auto-approves*, it does not restrict |
| `--permission-mode <acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan>` | the session's default answer |
| `--permission-prompts <host\|none>` | who answers a prompt: the host, or nobody (auto-deny) |
| `--permission-prompt-tool <mcp__server__tool>` | route prompts to an MCP tool we serve |
| `--plugin-dir <path>` | **load a plugin (skills) for this session only** — how Apelles ships its own skills |
| `--system-prompt` / `--append-system-prompt` (+ `-file` variants) | the app's own framing |
| `--add-dir <dirs...>` | the project's media directory |
| `--max-budget-usd <amount>`, `--max-turns <n>` | a hard client-side stop |
| `--no-session-persistence` | do not write a transcript to disk |
| `--settings <file-or-json>`, `--setting-sources user,project,local` | which of the user's settings files apply |
| `--agents <json-or-file>` | custom subagents, defined by us |
| `--json-schema <schema>` | structured output, if a turn should return data |

Two documented traps [verified, <https://code.claude.com/docs/en/headless.md>]: `-p`
**skips the workspace-trust dialog**, so a working directory must be one the user chose;
and a settings file that fails validation is **silently ignored** in `-p` mode.
`--bare` is the wrong flag here — it reads only `ANTHROPIC_API_KEY`/`apiKeyHelper` and
never the keychain or OAuth, i.e. it cannot use the subscription at all [verified,
`claude --help`].

**The event stream, captured first-hand.** A real `-p --output-format stream-json
--verbose --restricted --tools "" --no-session-persistence --strict-mcp-config` run on
this machine produced exactly four lines [verified]:

1. `{"type":"system","subtype":"init", …}` — `session_id`, `cwd`, `tools`, `mcp_servers`,
   `model`, `permissionMode`, `apiKeySource`, `claude_code_version`, `slash_commands`,
   `skills`, `plugins`, `agents`, and a `capabilities` array (which on 2.1.322 includes
   `interrupt_receipt_v1`, `mcp_call_check_permissions_v1`, `ui_surface_v1`).
2. `{"type":"assistant","message":{…}}` — one per **completed content block**, so text and
   each `tool_use` arrive as separate assistant lines sharing a `message.id`; carries
   `parent_tool_use_id` (`null` on the main thread, set for a subagent) and per-message
   `usage`.
3. `{"type":"rate_limit_event", …}` — `status`, `resetsAt`, and `unifiedWindows` with
   `five_hour` / `seven_day` utilization. **A GUI can show the user their own remaining
   quota from this**, which no terminal does well.
4. `{"type":"result", …}` — `is_error`, `subtype`, `result`, `num_turns`,
   `total_cost_usd`, `usage`, `modelUsage` (per-model, whole tree), `permission_denials`,
   `terminal_reason`, `stop_reason`, `duration_ms`, `ttft_ms`, and
   `credential_expires_at`.

Tool calls appear as `tool_use` blocks (`{id, name, input}`) on an `assistant` line and
their results as `tool_result` blocks (`{tool_use_id, content}`) on a `user` line
[inferred — this follows the Messages API and the SDK types; no live tool call was
captured]. With `--include-partial-messages`, `stream_event` lines carry the raw
`message_start` / `content_block_start` / `content_block_delta` (`text_delta`,
`input_json_delta`) / `content_block_stop` / `message_stop` events
[verified: <https://code.claude.com/docs/en/agent-sdk/streaming-output.md>].

**`subtype` is not the error check.** On a logged-out run the result line was
`is_error: true`, `terminal_reason: "api_error"`, `result: "Not logged in · Please run
/login"` — with `subtype: "success"` [verified]. A parser that switches on `subtype`
reports a failure as a success. This repo has shipped that class of bug three times
(B-399's bare `.catch(() => {})`, B-402's unlaunched binary); the parser must branch on
`is_error`.

**Multi-turn over one process works.** With `--input-format stream-json`, each user turn
is one line of `{"type":"user","message":{"role":"user","content":"…"},
"parent_tool_use_id":null}`; the process stays alive while stdin is open, a turn submitted
mid-turn is queued and run next, and closing stdin ends the run after outstanding work
[verified: the line shape is accepted by the local CLI; the queueing and
stdin-lifetime behaviour is documented at
<https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md> and
<https://code.claude.com/docs/en/headless.md>]. `content` may be an array of blocks,
including base64 images — which is the hook for "here is the frame I am looking at"
(§7, phase 4).

**Interruption.** `SIGINT` ends the turn in progress and the run continues; `SIGTERM`
exits 143, kills Bash process trees, and the in-flight turn gets no `result` line
[verified: <https://code.claude.com/docs/en/headless.md>]. So **Stop = SIGINT**, and the
UI must synthesise the "turn ended" state itself rather than wait for a `result` that will
not come. The SDK's `interrupt()` is the same thing with a receipt; the raw stdin
`control_request` protocol the SDKs use internally is **not** a public contract and this
design does not depend on it.

**Sessions.** `session_id` is ours to set (`--session-id <uuid>`), appears in `init` and
`result`, and `-p --resume <id>` works headlessly from any directory. Transcripts are
JSONL under `<config-dir>/projects/<slugified-cwd>/<session-id>.jsonl`, and the docs say
**do not parse them** — the line format is internal. `--resume` does **not** restore
`--mcp-config`, `--settings`, `--add-dir` or `--plugin-dir`: pass them again every time
[verified: <https://code.claude.com/docs/en/sessions.md>]. That is a real constraint —
it means the launch arguments are part of *our* persisted session record, not the CLI's.

### 1.2 Claude Code — CLI or the Agent SDK?

| | headless CLI (spawned from Rust) | Agent SDK (Node sidecar) |
|---|---|---|
| Language fit | spawn from `app/src-tauri` like every other sidecar | needs a Node runtime bundled and supervised |
| Streaming | we parse `stream-json` (a day's work, fully specified above) | typed messages, no parser |
| Interrupt | `SIGINT`, documented | `interrupt()` with a receipt |
| **Permission dialog** | `--permission-prompt-tool` (**I/O shape undocumented**) or a `PermissionRequest` hook | **`canUseTool` callback — the officially documented way to surface an approval to a user** |
| Version | the user's own binary | the SDK ships a pinned per-platform binary; `pathToClaudeCodeExecutable` overrides it |
| Rust support | native | none — there is no Rust SDK; the docs tell other languages to run the CLI with `-p` |

[all verified: <https://code.claude.com/docs/en/agent-sdk/overview.md>,
<https://code.claude.com/docs/en/agent-sdk/user-input.md>, and the published
`sdk.d.ts`. `canUseTool`'s signature is
`(toolName, input, {signal, suggestions?, blockedPath?, toolUseID, requestId, …}) =>
Promise<PermissionResult | null>`, returning `{behavior:'allow', updatedInput?,
updatedPermissions?}` or `{behavior:'deny', message, interrupt?}`.]

**Recommendation: the headless CLI, spawned from Rust, and permissions by allowlist
rather than by prompt-routing** (§3). The SDK's one real advantage is `canUseTool`, and
taking it costs a bundled Node runtime plus a second supervised process — which is a
large tax on a Tauri app whose whole architecture is "thin shell, fat core"
(`architecture-lock.md`). §3 reaches the same safety property without it, by deciding
*in Apelles* which tools may run unattended and running the rest through Apelles' own
confirmation instead of the CLI's. Revisit if phase 2 shows a case that genuinely needs
a mid-turn prompt the allowlist cannot express.

### 1.3 OpenAI Codex CLI

Verified first-hand on 0.166.0 — `--help` on `codex`, `codex exec` and `codex
app-server`; `codex login status`; `codex doctor --json`; the protocol schema generated
from the binary itself (`codex app-server generate-json-schema`); the shipped
`@openai/codex-sdk` 0.169.0 `.d.ts`; and live `exec --json` and app-server runs including
a real interrupt. Note the docs moved during this pass:
`developers.openai.com/codex/*` now 308-redirects to `learn.chatgpt.com/docs/*`.

**The headline, because it inverts the obvious choice: `codex exec` is the wrong
surface, and its failure mode is silent.** The two programmatic surfaces are not
equivalent:

| | `codex exec --json` | `codex app-server` |
|---|---|---|
| process | one turn, then exits | long-lived, many threads and turns |
| streaming | **item-level only** — no text deltas | **token-level deltas** (`item/agentMessage/delta`) |
| multi-turn | re-invoke `exec resume` | `turn/start` repeatedly |
| interrupt | kill the process | `turn/interrupt` → `status: "interrupted"` |
| **intercept an approval** | **impossible** | **yes — a JSON-RPC request you answer** |

A live run under `--sandbox read-only` with `-c approval_policy="on-request"`, asked to
write a file, emitted **no approval event at all** and reported `turn.completed` — with
the file not created and an agent message explaining that write approval was disabled
[verified]. A host driving `exec` would show the user a successful turn that quietly did
nothing. That is the exact class of defect this repo keeps logging (B-399, B-402), and it
rules `exec` out for an interactive panel. `codex exec` also rejects `-a` /
`--ask-for-approval` outright (that flag is top-level only), and `--full-auto` has been
removed [both verified].

- **`codex exec [PROMPT]`** (alias `codex e`) remains right for automation: `--json` →
  JSONL of `thread.started` / `turn.started` / `item.started|updated|completed` /
  `turn.completed|failed` / `error`, with item types `agent_message`, `reasoning`,
  `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`
  — tool calls fully visible, but agent text only as a completed item [verified from a
  captured run and the SDK types].
- **`codex app-server`** is documented as "the interface Codex uses to power rich
  clients, such as the VS Code extension", for teams building "a deep integration inside
  your own product". stdio by default (newline-delimited JSON), also a unix socket;
  `initialize` → `initialized`, with several methods behind
  `capabilities.experimentalApi`. Its schema generated from the installed binary has 106
  client requests, 10 server→client requests and 85 notifications [verified].
- **Approvals, and they map almost exactly onto §3's tiers.** The server asks
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `item/tool/requestUserInput`,
  `mcpServer/elicitation/request`), and the decisions are `accept`, **`acceptForSession`**,
  `{acceptWithExecpolicyAmendment: …}` (persist a rule), `decline` (the turn continues) and
  `cancel` (the turn is interrupted) [verified in the generated schema]. The request
  carries `threadId`, `turnId`, `reason`, and — notably — `commandActions`, "best-effort
  parsed command actions for friendly display". Codex pre-parses the action so a host can
  render it in human terms; we would do the same thing for an `editor_*` call.
- **Interrupt and steer, verified live:** `turn/interrupt` after 9 deltas produced
  `turn/completed` with `status: "interrupted"` (294 deltas uninterrupted); `turn/steer`
  injects into the active turn behind an `expectedTurnId` precondition. `turnId` is not on
  `turn/started` — read it from the delta params.
- **MCP injection without touching the user's machine, verified:** there is **no
  `--mcp-config`**, but `-c 'mcp_servers.apelles.url="…"'` (plus
  `enabled_tools` — "tool allow list" — and `disabled_tools`, applied after) works at
  invocation time and wrote no `config.toml`. `app-server` takes `-c` too, and
  `ThreadStartParams.config` takes a per-thread config object. `--ignore-user-config`
  loads none of the user's config while still using `CODEX_HOME` for auth. Per-server
  `startup_timeout_sec` (10) and `tool_timeout_sec` (60) defaults are worth knowing — a
  slow Apelles op would hit the latter.
- **`codex mcp serve` is gone** (`unrecognized subcommand`): `codex mcp` now only manages
  *external* MCP servers. Codex cannot be used as an MCP server any more.
- **Sessions:** `exec resume <id|--last>`, `exec fork`, `codex resume`, `codex queue`,
  `archive`/`delete`, `--ephemeral`. Rollouts were JSONL under
  `~/.codex/sessions/YYYY/MM/DD/`, but newer versions migrate to
  `~/.codex/thread_history_1.sqlite` (hence `codex migrate-rollouts`) — **do not treat
  either store as canonical**; read sessions through `thread/list` / `thread/items/list`.
  `thread/revert` and `thread/fork` are the checkpoint primitives.
- **Detection, with two verified traps.** `codex doctor --json` is the best offline
  report — `schemaVersion`, `overallStatus`, `codexVersion`, and a `checks` map whose
  `auth.credentials` gives the auth file, `auth storage mode`, `stored API key`, `stored
  ChatGPT tokens`, `stored auth mode: chatgpt`; it also reports the sandbox policy, MCP
  servers and whether the daemon is running. From a live panel, `account/read` returns
  `{account: {type, email, planType, workspaceName}, requiresOpenaiAuth, …}` and
  `account/updated` pushes changes. The traps: **(1) `codex login status` exits 0 whether
  or not you are logged in** — parse stdout, never `$?`; **(2) an env-var API key reads as
  "Not logged in" yet `exec` works**, so "not logged in" is not the same as "cannot run".
- **An unauthenticated headless run is actively user-hostile** [verified]: with an empty
  `CODEX_HOME`, `exec --json` emits `thread.started`, then grinds through five WebSocket
  retries, falls back to HTTPS, grinds five more, and fails after about 40 seconds with a
  401 and exit 1. **Check auth before starting a turn**, or the user watches a plausible
  session die slowly. This is §2's rule, confirmed on a second CLI.
- **Sandbox:** `-s/--sandbox read-only` (the default) | `workspace-write` |
  `danger-full-access`, enforced by Seatbelt on macOS. The approval policy is the
  orthogonal axis (`on-request` | `never`; `untrusted` and `on-failure` are retired by the
  CLI **but still present in the app-server schema and the SDK's own types** — stale
  types, a trap for a generated binding). `--approve-for-me` routes approvals to an
  automatic reviewer rather than to a human; `approvals_reviewer = auto_review` is the
  config form, and it "uses extra model calls".
- **Also useful:** `-C/--cd`, `--add-dir`, `--skip-git-repo-check` (**Codex expects a git
  repo and a footage folder is not one**), `--output-schema`, `-o/--output-last-message`,
  `-m/--model`, `permissionProfile/list` (returns `:read-only`, `:workspace`,
  `:danger-full-access`, each with an `allowed` flag, so a forbidden profile can be
  greyed out), and `--oss` + `--local-provider lmstudio|ollama` — a genuine
  **local-model** path, relevant to §6 and to D-438's free tier.
- **The SDK is not an option for this.** `@openai/codex-sdk` wraps `codex exec` over
  JSONL and its type surface has **no approval callback anywhere**, so it inherits every
  limit above. The docs draw the same line: the SDK is "to automate coding tasks,
  including jobs in CI", the app-server is "to build custom clients that handle
  authentication, conversation history, approvals, and streamed agent events".

**So Codex is a real second provider, and a bigger phase than it first looked.** Not
because it is less capable — the app-server is in several ways a *better* host surface
than Claude Code's headless mode (token deltas, a typed approval request with a
pre-parsed human-readable action, a real steer, 19 typed thread item types to render) —
but because it is a JSON-RPC client to write rather than a line parser, parts of it are
experimental, and its schema drifts between versions. Two rules for phase 5, both learned
the hard way above: **generate the bindings from the installed binary**, never from the
docs or the SDK types (the `untrusted`/`on-failure` drift is proof), and **check auth
before the first turn**. And its own terms sentence is a second gate — see §9 question 1.

### 1.4 The shape this design assumes

One long-lived child process per conversation, owned by Rust:

```
claude -p
  --input-format stream-json  --output-format stream-json  --verbose
  --include-partial-messages  --replay-user-messages
  --session-id <our uuid>
  --restricted                       # no Bash, no WebFetch, no user settings
  --tools "Read,Glob,Grep"           # see §3.3
  --strict-mcp-config --mcp-config '{"mcpServers":{"apelles":{"type":"http","url":"http://127.0.0.1:<chroma_mcp_port>/mcp"}}}'
  --plugin-dir <bundled apelles skills>
  --append-system-prompt-file <bundled apelles preamble>
  --add-dir <project media dir>
  --permission-prompts none          # phase 1; see §3
  --max-budget-usd <setting>  --max-turns <setting>
```

stdin: one JSON line per user turn. stdout: the event stream. SIGINT: stop the turn.

---

## 2. Detection and setup — the failure states first

The happy path is three lines of code. The failure states are the feature, and this repo
has the scars to prove it: B-402 shipped a build that could not start because nothing ever
launched the binary; B-399 spun a thumbnail forever behind a bare `.catch(() => {})`. So:

**The probe runs the CLI and reads its answer. It never infers.**

### 2.1 What the probe does

`chroma_agent_cli_probe` (Rust, in `app/src-tauri`), reached from the frontend only
through `@apelles/bridge` (D-447). For the selected provider:

1. **Resolve the binary.** `which`-style lookup over an explicit `PATH`, plus the known
   install locations (`~/.local/bin/claude`, the npm global bin, Homebrew's bin). A
   user-set absolute path in settings always wins.
   **This is a real trap, not a theoretical one:** on this very machine `claude` is a
   **zsh function** that sets `CLAUDE_CONFIG_DIR=~/.claude-personal` before calling the
   real binary [verified]. A GUI-spawned process does not run the user's shell functions
   or aliases, so it would resolve a different binary (or none) and a different config
   directory, and would then report "not logged in" about an account that is in fact
   logged in. The probe therefore reports the resolved **absolute path** and the
   **effective config directory** in the UI, and the setting that overrides either is
   first-class, not advanced.
2. **Version.** `claude --version` → `2.1.322 (Claude Code)` [verified]; `codex
   --version` → `codex-cli 0.166.0` [verified]. Parse the leading semver; compare against
   a **floor** we pin and bump deliberately (`AGENT_CLI_MIN_VERSION`), not against
   "latest".
3. **Login.** `claude auth status` (JSON by default) → `{loggedIn, authMethod,
   apiProvider, configDirectory, loginExpiresAt, email, subscriptionType, planTier}`
   [verified first-hand: it reported `authMethod: "claude.ai"`, `subscriptionType:
   "max"`, `planTier: "max_5x"`, and an expiry]. Codex: `codex doctor --json` →
   `checks["auth.credentials"].details["stored auth mode"]` [verified]. Both are exactly
   the machine-readable check this needs; no transcript or credential file is ever read.
4. **The MCP server.** `chroma_mcp_status` (already exists) — `managed`, `healthy`,
   `stale`, `lastError`. A chat that cannot reach Apelles' own tools is a broken chat, and
   this is the one check that is about us rather than them.

The probe result is cached per app run and re-run on a Retry, on opening the panel after a
failure, and when the panel is opened and the cached `loginExpiresAt` has passed.

### 2.2 The states, and what the panel says

| State | What the user sees |
|---|---|
| **Ready** | the composer, plus a one-line footer: provider, model, `max_5x`, and the five-hour / seven-day utilization from `rate_limit_event` |
| **No CLI found** | "Apelles couldn't find the Claude Code CLI." The install command, a **Choose the binary…** file picker, a **Check again** button. Never a silent empty panel. |
| **Found but not logged in** | "Claude Code is installed but not signed in." The **exact command** to run (`claude auth login` — ours is a copy button, not a spawned terminal, for the same reason `ConnectMcpDialog` only ever gives the command), and the config directory it would sign into, because that is the thing that goes wrong. |
| **Logged in, wrong account/dir** | the resolved path and `configDirectory` from `auth status`, side by side with the override setting. This is the zsh-function case above. |
| **Version below the floor** | the found version, the floor, the upgrade command. Offer **Try anyway** — refusing to run a 2.1.300 because we pinned 2.1.322 is worse than a clear warning. |
| **Credential expired** | `loginExpiresAt` in the past, or a turn whose `result` says so: a banner with the re-login command, the conversation kept. |
| **Apelles' MCP server unhealthy** | the `chroma_mcp_status` reason and a Retry, pointing at the existing Settings sidecar card. A chat is not offered while this is red. |
| **Rate-limited / out of credits** | from `rate_limit_event` (`status`, `overageStatus`, `resetsAt`) and the `result` line: what ran out and when it resets. |
| **Turn failed** | `is_error` + `result` text + `terminal_reason`, verbatim, in the thread, with a Retry. Never swallowed, never rewritten into "something went wrong". |
| **Process died mid-turn** | exit code and the last stderr lines, in the thread. A non-zero exit with no `result` line is reported as a crash, not as a finished turn. |

Everything the probe learned is also a read-only MCP tool, `agent_chat_status`, per
CLAUDE.md's human-and-AI rule — an agent debugging a user's setup should be able to read
it (§8).

### 2.3 Setup is a real screen, once

First open: a short panel — provider (Claude Code / Codex), the probe result per provider
with its remedy, the model, and the two safety settings from §3 (what may run unattended,
and the budget cap). No wizard, no account creation, nothing to type but a path if the
probe guessed wrong. Reachable afterwards from the panel's own header menu and from
Settings.

---

## 3. Permissions

Two permission models are in play and conflating them is the mistake to avoid. The CLI has
one (it decides whether *the agent* may run a tool). Apelles has an interest the CLI knows
nothing about (**which of our 275 tools are reversible**). The design puts Apelles'
judgement first and uses the CLI's model to enforce it.

### 3.1 The fact that makes this tractable

Apelles already journals agent edits. Every mutating op goes through the same store action
a GUI click does (D-020, D-140), is stamped `source: 'agent'` on the `@apelles/history`
stack by one `runAsAgent` wrapper per tab's dispatcher (D-298), and appears in the Agent
activity feed with a diff (Colorist) or a label (Edit, Motion). Cmd+Z undoes it. So **an
agent editing a timeline, a grade or a Motion scene is already safe**: it is visible and
it is reversible, by design, today.

What is *not* reversible is anything that leaves the document: a file written, a file
deleted, a process started that costs money or time.

### 3.2 The three tiers

**Tier 1 — reversible, auto-approved.** Every `editor_*` / `motion_*` / Colorist mutation
that only changes the open document, and every read. These are the overwhelming majority
of the surface, they land on the undo stack, and they show in the activity feed. Asking
the user to approve `editor_trim_clip` 40 times is how a feature becomes unusable — the
approval that matters is reviewing the *result*, which the feed and Cmd+Z already give.

**Tier 2 — always confirmed, never auto-approvable.** The irreversible or
outside-the-document ops. From the current surface:

- `editor_export`, `editor_export_fcpxml`, `editor_export_subtitles`, `export` — write a
  file and burn minutes of GPU. (`editor_export` never overwrites an existing file
  [verified in its own docstring], which limits the damage but does not make it
  reversible.)
- `motion_render` — minutes of Remotion rendering, and the repo's own standing rule is
  that edits during a render break it (B-263..B-265).
- `editor_remove_media`, `editor_delete_timeline`, `motion_delete_component`,
  `motion_delete_layer_preset`, `motion_delete_template`, `motion_delete_theme`,
  `brand_delete_kit` — destroy something the undo stack does not hold.
- `motion_write_component`, `motion_save_manifest`, `motion_import_asset`,
  `brand_import_asset`, `editor_save_export_preset` — write files on disk.
- `motion_install_runtime`, `motion_remove_runtime` — install software.
- `save_project`, `save_grade`, `close_project` — commit or discard the user's work.
- `debug_record_video` and the rest of the `debug_*` family — already
  `#[cfg(debug_assertions)]`-gated out of release (CLAUDE.md), so in a shipped build they
  are not reachable at all; listed so the gate is not mistaken for an oversight.

The list lives in **one place in Rust**, beside the tool surface it describes, with a test
asserting every tool name in it exists and that a tool whose name matches
`delete|remove|export|render|install|save|close` is either in the list or explicitly,
visibly exempted. A new tool that is irreversible and not listed is a bug the test
catches, not a surprise in production.

**Tier 3 — never offered.** The CLI's own built-in tools. `--restricted` removes
Bash/PowerShell/the code-running tools and WebFetch [verified, `claude --help`]; `--tools
"Read,Glob,Grep"` keeps a narrow read-only set so the agent can look at a script or a
subtitle file the user points it at; `--strict-mcp-config` means the user's own MCP
servers (their GitHub token, their database) are not in this session. **An in-app video
editor's chat has no business running shell commands.** If a future feature needs one, it
gets its own tier-2 MCP tool with its own confirmation, not a general Bash.

### 3.3 How a confirmation actually reaches the user

Phase 1, and the recommendation: **`--permission-prompts none` plus an Apelles-side
confirmation.** The CLI is launched with tier 1 auto-approved — `--allowedTools` listing the tier-1
`mcp__apelles__<tool>` names explicitly, generated from the same registry the tier-2 list
comes from, rather than relying on a whole-server or wildcard form whose exact spelling
this pass did not verify — and `--permission-prompts none`, so anything that would prompt
is denied by the CLI rather than hanging. Tier 2 is enforced **by us, in the MCP server**: a
tier-2 op returns, instead of doing the work, a structured `needs_confirmation` answer
naming what it would do. The panel renders that as a real approve/deny card; on approve,
the chat re-issues the call with a one-shot token the server minted for exactly that call
and that exact argument set.

Why this and not `--permission-prompt-tool`: that flag's input/output shape is
**undocumented** [verified — the docs define it only as "an MCP tool to handle permission
prompts in non-interactive mode"; the shapes circulating are third-party]. Building the
one safety-critical path in this feature on an unspecified contract is precisely the
"no shortcuts" rule's failure mode. The approach above uses only documented behaviour,
keeps the decision in Apelles where the reversibility knowledge lives, and has a property
`--permission-prompt-tool` does not: **the confirmation card can show the user the real
consequence** ("export 7:44 at 4K to ~/Movies/… — about 4 minutes") because it is rendered
by the app that knows.

Costs, stated honestly: the agent sees a tool "fail" and must be told to wait for the
human, which is a system-prompt instruction (and `request_human` already exists as the
tool for the inverse case). And the one-shot token has to be real — bound to the op, the
exact arguments and a short expiry — or it is theatre.

**Never auto-approvable, under any setting:** every tier-2 op. There is no "allow all" for
exports, deletes, installs or renders; the per-call card is the only path. A **"don't ask
again for this kind, this session"** is offered for the two that recur in a real working
session (`motion_render`, `editor_export`), scoped to the conversation and shown in the
footer while it is active, with one click to revoke — the Zed/Copilot "always allow for
this session" convention (§5), not a persisted global.

### 3.4 What a stop means

Stop is `SIGINT` [verified]. A turn interrupted mid-edit leaves the document wherever the
last completed op left it — that is already true of a Cmd+Z-able op sequence, and the
activity feed shows exactly which ops landed. The thread shows "Stopped — N edits applied"
with a link that opens the feed, and **not** an automatic rollback: silently reverting
work the user watched happen is the worse surprise, and the per-row undo / Cmd+Z is right
there. An export or render in flight is cancelled through its own existing cancel op
(`editor_cancel_export`, the Motion job's own control), not by killing the CLI.

---

## 4. The seam — how the chat reaches the same ops the GUI does

### 4.1 It does not get a new action API

Apelles has exactly one MCP server and one control bridge
(`docs/notes/mcp-architecture.md`: "There is exactly ONE MCP server for this whole app").
The in-app chat is **an MCP client**, the same as Claude Code in a terminal, and it adds
no op registry, no port and no second path to the store. This is the single most important
constraint in this section, and `mcp-architecture.md` records what happens when it is
missed (D-183's first draft built a second server before finding the first).

```
Chat panel (@apelles/agent-chat, React)
      │  @apelles/bridge bindings only (D-447) — no @tauri-apps/* import
      ▼
chroma::agent_chat (Rust)  ── spawns ──▶  claude -p --input-format stream-json
      │  ▲                                      │
      │  └── stdout events ──────────────────────┘
      │
      │   the child's only route back into the app:
      ▼
http://127.0.0.1:<chroma_mcp_port>/mcp   (apelles-mcp --http, already running, D-313)
      │  POST /op {op, args, timeout_ms}
      ▼
chroma::control (D-020)  →  chroma_control_respond  →  useXControl.ts  →  the real store action
```

Every arrow below `apelles-mcp` already exists and does not change. The new code is one
Rust module that owns a child process and one frontend package that renders a stream.

### 4.2 Port and handshake

No new port, no new handshake, no discovery. The app already resolves the MCP port
(`chroma_mcp_port`: `CHROMA_MCP_PORT`, else 19790) and already health-checks the server
(`chroma_mcp_status`). `chroma::agent_chat` reads the same resolved port and writes it
into the `--mcp-config` JSON it hands the child **on every launch and every resume**
(`--resume` does not restore `--mcp-config` [verified]). So:

- The port is resolved **at spawn time**, never cached across app runs.
- `--strict-mcp-config` means our entry is the only one, so a stale `~/.claude.json`
  entry from a previous manual setup cannot shadow it.
- If `chroma_mcp_status` is not healthy, the spawn does not happen and the panel says why
  (§2.2) — rather than spawning a CLI that will spend the user's tokens discovering it
  has no tools.
- The server stays unauthenticated on loopback, as D-313 decided. The child is a local
  process we spawned; this adds no new exposure. Worth revisiting only with 00f's
  background mode, where "the app is running but no window is open" changes who might be
  on that socket.

**`init` is the proof, and it is checked.** The first event carries `mcp_servers` with a
status per server and `tools` [verified]. If `apelles` is not connected there, or its tool
count is zero, the panel reports a setup failure on turn one instead of letting the model
discover it. This is the B-402 lesson applied: verify the thing actually started.

### 4.3 The bridge boundary (D-447)

The frontend never imports `@tauri-apps/*`. `@apelles/bridge` gains one module,
`agentChat.ts`, with typed bindings: `probeAgentCli`, `startConversation`, `sendTurn`,
`interruptTurn`, `approveToolCall`, `endConversation`, `listConversations`,
`resumeConversation`. The event stream comes back as a Tauri **`ipc::Channel`** opened by
`startConversation` — not an event, not a poll. D-455's rule is "page → Rust is a command;
Rust → page notifications may be events", and a channel is the narrower form of the same
thing: it is created by the command that needs it, delivers in order to exactly one
consumer, and has no global listener registry to race (which is the whole of B-386). The
repo does not use `ipc::Channel` anywhere yet; this is its first use and the D records it.

**The conversation is backend state, like the Motion render job (D-398).** The child
process, the transcript we render, the pending approval and the launch arguments live in
Rust and are persisted; the page is a view. A webview reload — the thing that silently
killed Motion renders until D-398 moved the loop into the backend (B-265) — reconnects to
a running conversation instead of orphaning a child process holding the user's tokens. A
conversation whose worker is gone reads `interrupted`, never `running`, the same guard
D-398 uses.

New edit logic stays as plain functions over data (CLAUDE.md): the stream parser is a pure
`parseStreamEvent(line) -> ChatEvent` in a new crate-or-module with unit tests over
recorded fixtures (the four lines captured in §1.1 are the first fixtures), and the
reducer that turns `ChatEvent`s into the rendered thread is a pure function too. Neither
touches Tauri, so both move with 00i.

### 4.4 What the child is told

Three pieces of context, all bundled with the app, all passed on every launch:

1. **`--mcp-config`** — Apelles only, `--strict-mcp-config`.
2. **`--plugin-dir <bundled>`** — Apelles' own skills. The seven `apelles-*` skills
   currently in `.claude/skills/` are what make an agent good at this app rather than
   merely able to call its tools, and today they reach nobody outside this checkout. They
   get packaged as a plugin directory staged into the bundle (the same `build.rs`
   staging pattern `stage_mcp` already uses for the MCP binary, D-390/B-254), and
   `--plugin-dir` loads them for that session only, without touching the user's own
   installation. **The skills become a shipped product asset**, which also means they
   need the same "is this accurate" discipline as `docs/` — a drifted skill is now a
   user-visible defect.
3. **`--append-system-prompt-file <bundled>`** — a short preamble: you are inside Apelles,
   the project is already open, call `editor_get_capabilities` once before transforms and
   exports (it is static, no round trip), `motion_list_primitives` once before adding
   layers, times in Motion are seconds within a scene, measure before claiming a grade
   result, a tier-2 tool may answer `needs_confirmation` and that means wait for the
   human, and `request_human` exists for a creative call. Most of this is already written
   in `mcp/server.py`'s server instructions — the preamble should **reference** that
   surface rather than restate it, so there is one copy to keep right.

`--add-dir` gets the project's media directory, so the read-only `Read`/`Glob`/`Grep` set
can see a subtitle file or a script the user mentions, and nothing else.

### 4.5 Attribution

Edits arrive through the control bridge and are already stamped `source: 'agent'` by each
tab's `runForRequest` wrapper, so they land in the activity feed with no new code
(D-298). The control request envelope already carries a `source` field whose only honoured
non-default value is `'harness'`; a later, optional refinement is a `conversationId` on
the envelope so a feed row can link back to the turn that caused it. Not phase 1 — the
feed is already correct without it.

---

## 5. UI shape

CLAUDE.md requires looking at how real tools solve this before designing it, from the
product's own pages rather than an impression. This is that pass.

### 5.1 What was read

| Source | Fetched | What it answered |
|---|---|---|
| <https://zed.dev/docs/ai/agent-panel> | 2026-11-14 | panel placement, thread list, queued messages, Steer / Send Now, the review accordion, follow mode, token usage, compaction banner |
| <https://zed.dev/docs/ai/tool-permissions> | 2026-11-14 | **the best permission model of the four** — per-tool `allow`/`deny`/`confirm`, pattern rules, the precedence order, and the confirmation card's own options |
| <https://zed.dev/docs/ai/tools> | 2026-11-14 | profiles vs permissions as two separate axes |
| <https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode> | 2026-11-14 | tool pills, Compact / Verbose / Conversation view modes, "Completed N steps", the working set with Keep / Undo, the Send dropdown (Add to Queue / Steer with Message / Stop and Send), checkpoints |
| <https://code.visualstudio.com/docs/copilot/security> | 2026-11-14 | approval scopes (session / workspace / user), the permission presets, per-glob approval for sensitive files, enterprise policy overrides |
| <https://cursor.com/docs/agent/review> | 2026-11-14 | watch the diff as it happens, **Stop** (Cmd Shift Backspace), revert-and-retry, post-hoc **Review → Find Issues** |
| <https://cursor.com/docs/agent/modes> | 2026-11-14 | Plan Mode as a first-class mode, Shift+Tab to switch |
| <https://docs.devin.ai/desktop/cascade/cascade> (Windsurf Cascade; now redirects here) | 2026-11-14 | the in-thread Todo list, **named checkpoints and revert-to-step**, queued messages (Enter to queue, Enter again to send now), invocation cap with a Continue button |
| <https://cursor.com/docs/agent/overview>, `/agent/security`, `/agent/security/run-modes`, `/agent/tools/terminal`, `/models-and-pricing>` | 2026-11-14 | the "Worked" fold with a duration, optimistic tool rows, **Always Run → `terminalAllowlist`**, the three Run Modes (Auto-review / Allowlist / Run Everything) with the stated warning that "Auto-review is not a security boundary", File-Deletion Protection, the draggable queue, **checkpoint preview then Restore Checkpoint — files only, messages stay** |
| <https://code.visualstudio.com/docs/agents/run/approvals>, `/run/tools`, `/run/review-code-edits`, `/reference/ai-settings`, updates v1.103–v1.107 | 2026-11-14 | the grant ladder's exact labels and **scopes**, **no deny button** (a `false` rule "requires approval. It does not block the command"), **skip**, per-sub-command evaluation, the default-denied command list, "Chat: Reset Tool Confirmations", the working set's three Keep/Undo levels, **Restore Checkpoint removes later turns** |
| <https://zed.dev/docs/ai/agent-profiles>, `/reference/all-settings` | 2026-11-14 | profiles (Write / Ask / Minimal) decide which tools *exist*, permissions decide whether a call needs a click; `expand_edit_card` / `expand_terminal_card` default **true**; chained commands split and checked per sub-command; the non-overridable blocks on recursive deletion of `/`, `~`, `$HOME`; a **"Test Your Rules"** pattern checker |
| <https://docs.devin.ai/desktop/devin-local/permissions>, `/devin-local/modes` | 2026-11-14 | **Allow / Ask / Deny** with precedence Deny > Ask > Allow, `Exec(git status)`-style syntax, org rules overriding even Bypass, and the two standouts: **click the command in the card to edit it before approving**, and a wand that rewrites it from plain language for review |

Two doc sets moved or died during this pass, which is worth recording so the citations
are not re-chased: **Cursor** moved from `docs.cursor.com/en/*` to `cursor.com/docs`
(sitemap `cursor.com/llms.txt`), and **Windsurf Cascade is deprecated** — the docs now
call it "the legacy agent in Devin Desktop", removed from the agent selector in v3.9.19
(Sep 2026), with Devin Local as the successor. VS Code also restructured to
`/docs/agents/*` and no longer frames things as ask/edit/agent.

Not answered by any of them, and therefore not designed from a citation: exactly how a
tool call is drawn frame by frame while running (Zed says only that streaming "shows
which tools the model is using"; Cursor only that rows "show as started while the agent is
still writing them"), and **whether VS Code's tool confirmation is a floating modal or
inline in the thread** — its docs rely on a screenshot. The design below takes Copilot's
documented tool-pill-and-expand pattern and Zed's explicitly-in-thread card placement.

### 5.2 The conventions worth copying, and why

1. **The thread is the log.** All four put tool calls inline in the conversation, not in a
   side console. One scrollback, read top to bottom.
2. **A tool call is a collapsed pill that expands.** Copilot's default **Compact** view
   "previews tool calls as they run and collapses finished groups", labelling a finished
   group "Completed N steps", with **Verbose** to keep them open. That is the right
   default for us: 30 `editor_trim_clip` calls must not fill the panel, and one of them
   must be inspectable.
3. **Approval is a card in the thread, not a modal.** Zed's permission request "appears in
   the thread view" with its own menu. A modal over a video editor blocks the one thing
   the user wants to look at — the picture — and loses its place in the history.
4. **"Always allow" is a real need, and it is scoped.** Zed offers **Allow once** /
   **Deny once**, **Always for \<tool\>**, and **Always for \<pattern\>**; Copilot scopes
   approvals to session, workspace or user, with session-level ones "temporary and
   [they] don't persist beyond the current session". §3.3's session-scoped allowance for
   render and export is that convention, kept to its narrowest form.
5. **Some things are not negotiable, and the product says so.** Zed's precedence list puts
   "built-in security rules (terminal only, not overridable)" **above** every user
   setting, and hardcodes a block on recursive deletion of `/`, `~` and `$HOME` that
   `"allow"` cannot bypass. VS Code evaluates a compound command **per sub-command** and a
   `false` rule beats both a `true` rule *and* a session approval. Devin's org-level deny
   overrides even its Bypass mode. That is exactly tier 2's "never auto-approvable", and
   it is reassuring that the three most thought-through permission models all landed on
   the same shape independently. **For Apelles the irreducible deny is anything that
   overwrites user media or a project file.**
6. **Stop is prominent and its honesty is documented.** Copilot: "Stopping a request
   doesn't undo file edits, terminal commands, or other actions that already completed."
   §3.4 says the same thing in Apelles' vocabulary, in the thread, rather than leaving the
   user to infer it.
7. **A message typed mid-turn is queued, not lost.** Copilot's Send dropdown (**Add to
   Queue** / **Steer with Message** / **Stop and Send**), Zed's **Steer** / **Send Now**,
   Cascade's Enter-to-queue-Enter-again-to-send. Phase 4 takes the simple two of these:
   queue by default, a **Send now** affordance that interrupts.
8. **The change set gets its own summary bar above the composer.** Zed shows how many
   files and lines were edited with a **Review Changes** button; Copilot's working set
   lists each edit with **Keep** / **Undo**. Apelles' equivalent is "12 edits this turn"
   opening the existing Agent activity feed — we already have the reviewable log, it is
   just not currently one click from the place the edits were requested.
9. **Named checkpoints are what a real revert needs.** Cascade lets a user "create a named
   snapshot from within the conversation and revert to it later", and warns the revert is
   irreversible. We have per-op undo and Cmd+Z but no snapshot; that is roadmap 00f's
   "named timeline snapshots agents can create", and it is open question 7.
10. **A plan step before acting is a mode, not a prompt trick.** Cursor's **Plan Mode**
    ("the agent asks clarifying questions, researches your codebase, and creates a plan",
    Shift+Tab to switch) maps directly onto Claude Code's own `--permission-mode plan`
    [verified, `claude --help`]. A "Plan first" toggle on the composer is nearly free and
    is the right default for a destructive-sounding instruction.
11. **Usage is shown, quietly, on the composer — with an escape hatch near the limit.**
    Zed puts token usage "near the profile selector in the message editor" and, under an
    80,000-token window, shows a banner with **Start New Thread** / **New From Summary**;
    Cursor surfaces usage past 50% of quota and offers **Switch Model** beside **Buy
    Credits**; Devin shows per-token pricing in the model picker. We get better numbers
    than any of them for free — `rate_limit_event`'s five-hour and seven-day utilization,
    and `total_cost_usd` — and the footer is the place for them.
12. **Let the user edit the proposed action before approving it.** Devin is the standout:
    click the command in the approval card to edit it, plus a wand that rewrites it from a
    plain-language instruction for review. This maps directly and valuably onto our case
    — an agent proposing `editor_export` at the wrong size, or `editor_remove_media` on
    one file too many. The approval card's fields are editable before Approve, and the
    one-shot token is minted against the **edited** arguments (§3.3), which is also what
    keeps the token honest.
13. **Say out loud what the review surface does NOT cover.** VS Code: the working set
    "doesn't track terminal and script changes", and Restore Checkpoint "doesn't reverse
    terminal commands, network requests, or deployments". Cursor: "Auto-review is not a
    security boundary". Devin: "Reverts are currently irreversible, so be careful!". Our
    version of that line is about a render or export the agent already started, and it
    belongs in the UI, not only in this note (§3.4).
14. **An undo ladder, named — and the two products disagree about messages, so we must
    choose.** VS Code has three explicit tiers (working-set Undo → edit a previous request
    → Restore Checkpoint) and its restore **removes the later turns**; Cursor's restore
    "reverts files only. Messages stay in the conversation." Apelles' first two rungs
    exist already (Cmd+Z, the activity feed's per-row undo); the third is a named
    pre-turn snapshot, which we do not have (open question 7). **Choose Cursor's
    semantics** — the conversation is the record of what was asked and should not be
    rewritten by a revert — and say so in the UI.
15. **Read-only is a mode, not a permission tweak.** Zed's Write / Ask / Minimal profiles,
    Devin's Code / Smart / Ask / Plan / Bypass, Cursor's Agent / Ask / Plan / Debug. Zed
    states the hygiene rule outright: **the mode decides which tools exist; permissions
    decide whether a call needs a click.** Our §3 tiers are the permission axis; the
    composer's **Plan first** and phase 2's read-only build are the mode axis, and the two
    must not be collapsed into one control.

**One thing deliberately not copied.** All four are code editors, so their review surface
is a **diff**. Apelles' is not: the reviewable artifact is the timeline, the grade and the
picture, and the user is already looking at them. So there is no diff view in this design
— the "diff" is that the timeline visibly moved, the activity feed holds the before/after,
and Cmd+Z reverses it. Inventing a textual diff of a timeline would be the bespoke
pattern CLAUDE.md's UI rule warns against.

### 5.3 Placement

A **shell-level right-hand column**, a sibling of the Sources column, not inside a tab.
`Shell.tsx` is already a horizontal `ResizablePanelGroup` with Sources on the left and the
tab content in the middle (D-046/D-116); the chat is a third `ResizablePanel` on the
right, injected by the composition root through a `chatPanel` prop exactly as
`sourcesPanel` and `launcher` are, so `@apelles/shell` never imports the chat package and
the dependency direction holds. Default 360 px, min 300, max 560 — a real
`ResizablePanel`, per the standing rule, never a fixed width.

Shell-level because an instruction spans tabs ("cut the silences, then grade it warmer,
then build the title card"), which is the same reasoning D-298 used to move the agent
activity feed out of `App.tsx` and into the shell. Opened from a chrome-bar button beside
the existing Agent activity and Connect-to-MCP openers, with its own `useShellStore`
flag (`chatPanelOpen`, session-only, closed by default — like `sourcesPanelOpen`), so
`debug_ui_state` can read it and a `debug_set_chat_panel` op can drive it for the harness
and for screenshots (D-219's named-op shape, not a generic setter).

### 5.4 Wireframe

```
┌ chrome 38 ─ ⬤⬤⬤  ‹ Projects · Black October ·· [Edit|Motion|Colorist] ·· Export ⌨ ⚡ 💬 ┐
├────────────┬──────────────────────────────────┬──────────────┬──────────────────────────┤
│ Sources    │ Viewer                           │ Inspector    │ ASSISTANT          ⋯  ✕  │
│ 280        │                                  │ 300          │ 360 (300–560)            │
│            │                                  │              ├──────────────────────────┤
│            │                                  │              │ ⌃ Claude · Opus · max_5x │
│            │                                  │              ├──────────────────────────┤
│            │                                  │              │ you                      │
│            │                                  │              │  cut the silences on A1  │
│            │                                  │              │  and tighten the gaps    │
│            │                                  │              │                          │
│            │                                  │              │ ▸ Completed 3 steps      │
│            │                                  │              │ ▾ editor_detect_silences │
│            │                                  │              │     track 1 · 0.4 s min  │
│            │                                  │              │     → 31 ranges          │
│            │                                  │              │ Found 31 silences over   │
│            │                                  │              │ 0.4 s. Cutting the 24    │
│            │                                  │              │ that are not breaths…▍   │
│            │                                  │              │ ▸ editor_ripple_delete…  │
│            │                                  │              │                          │
│            │                                  │              │ ┌ needs your approval ─┐ │
│            │                                  │              │ │ ⚠ Export             │ │
│            │                                  │              │ │ Black October.mp4    │ │
│            │                                  │              │ │ 3840×2160 · 7:44     │ │
│            │                                  │              │ │ ~4 min · −14 LUFS    │ │
│            │                                  │              │ │ ~/Movies/Black Oct…  │ │
│            │                                  │              │ │ [Export] [Don't]  ⌄  │ │  ⌄ = "don't ask again
│            │                                  │              │ └──────────────────────┘ │      this conversation"
├────────────┴──────────────────────────────────┴──────────────┤                          │
│ Timeline toolbar · track headers · lanes …                   │ 24 edits this turn ›     │ ← opens the activity feed
│                                                              ├──────────────────────────┤
│                                                              │ ┌ Ask or instruct… ────┐ │
│                                                              │ │                      │ │
│                                                              │ └──────────────────────┘ │
│                                                              │ ⊕ ▢ Plan first   [Stop]  │
│                                                              ├──────────────────────────┤
│                                                              │ 5h 22% · 7d 10% · $0.31  │
└──────────────────────────────────────────────────────────────┴──────────────────────────┘
```

Reading the parts:

- **Header** — "Assistant", a `⋯` menu (new conversation, conversation list, settings,
  copy transcript, end conversation) and a close. Below it one quiet line: provider,
  model, plan tier. This is the permanent "you are talking to a vendor" statement §6
  requires; it is never ambiguous and never a surprise.
- **Thread** — `@apelles/ui`'s `ScrollArea`. User turns plain. Assistant text streams
  into a markdown block (`--text-sm`, the `text-primary` token) with a caret while a
  block is open. Finished tool groups collapse to "Completed N steps"; the call in flight
  is expanded, showing the tool name, the arguments that matter, and the result in one
  line. Each pill is a `Collapsible`. Phosphor icons only (CLAUDE.md): a kind glyph per
  surface, never a hand-drawn one.
- **The approval card** — the one visually loud element in the panel, inline where it
  happened, stating the real consequence in the user's units (size, duration, loudness,
  destination) because Apelles knows them and the CLI does not. Two buttons, plus the
  session-scoped "don't ask again" on the two recurring ops only. Tier 2 is never
  pre-approved, so this card cannot be configured away.
- **The edit-count bar** — "24 edits this turn ›", above the composer, opening the
  existing activity-feed popover. The Zed/Copilot change-set convention, pointed at the
  review surface we already have.
- **Composer** — `Textarea`, Enter sends, Shift+Enter newlines, Cmd+Enter sends while
  a turn runs (queue by default). `⊕` attaches context (the selection, the playhead
  frame, the selected clip — frames only if §6's setting is on). **Plan first** maps to
  `--permission-mode plan`. The Send button becomes **Stop** during a turn (SIGINT).
- **Footer** — the five-hour and seven-day utilization and the session cost, straight off
  `rate_limit_event` and `result.total_cost_usd`. Read from the stream, never persisted.

### 5.5 Performance

CLAUDE.md's priority order is performance, then stability, then speed of shipping, and a
panel that janks is a defect. The two real risks here are both token-rate problems:

- **Streaming deltas must not re-render the thread.** `--include-partial-messages`
  produces `text_delta`s faster than React should reconcile a list. The in-flight block
  is its own leaf component fed by a ref, coalesced to one commit per
  `requestAnimationFrame` (the same shape the number scrubber already uses, D-432 §4.10),
  and nothing above it re-renders until the block closes.
- **A long thread must stay cheap.** Finished turns are immutable; they memoise on turn
  id, and the list virtualises past a few hundred rows (the Sources grid's own rule).

Both get a harness scenario with a frame budget, alongside the existing `perf-300` suite,
rather than being asserted here.

---

## 6. Local-first — what leaves the machine, when, and what the user is told

CLAUDE.md: zero network calls in the grade path; any cloud call is explicit opt-in, never
a default, and documented as such. This feature talks to a vendor by definition, so the
rule is met by being precise rather than by pretending otherwise.

**Nothing leaves the machine until the user sends a turn.** The panel is closed by default
and no process is spawned until it is opened; detection (§2) runs local binaries only and
makes no network call of its own. Opening the panel spawns nothing; typing spawns nothing;
**pressing send is the opt-in**, every time, and it is the user's own action.

**What leaves, when a turn is sent:** the text the user typed; the system preamble and
skills we bundled; the MCP tool definitions; and the tool calls and tool results of that
turn. Tool results are the honest part of this — they are Apelles' own state, and they
contain real content: clip names, file **paths** and names, marker and timeline names,
the project name, transcript text (`editor_get_transcript`, `editor_get_word_transcript`),
OCR text, measured scope numbers, brand-kit values.

**What does not leave, in the design as scoped:** no frames, no audio, no media file
bytes. Apelles' mutating Colorist tools return a rendered frame to their caller — that is
the agent's eyes (doc 07, rule 2). Over this seam that frame would go to the vendor. For
phase 1 the host **strips image content from tool results** and the panel says so; the
agent grades by the numbers, which is the house rule anyway (`inspect_color`, scopes,
`sample_region`). Sending frames is a **separate, named, off-by-default setting** with its
own one-time explanation ("Let the assistant see the picture — frames of your footage are
sent to Anthropic when it looks"), because it is a materially different disclosure from
sending text, and it is the one that the owner should decide rather than inherit.

**Where it goes, and under whose account.** To Anthropic or OpenAI, over the user's own
CLI, under the user's own subscription. Apelles never sees, stores, proxies or transmits a
credential; there is no Apelles backend in this path and nothing to add to the Keychain
(this repo has no Keychain code today, and this feature adds none). The CLI writes its own
transcript under its own config directory unless `--no-session-persistence` is passed; the
setting is exposed, defaulting to persistence **on** so `--resume` works, with the path
shown.

**What the user is told, where.** A one-time sheet on first use, in plain language: which
provider, that it uses their own subscription and quota, the three bullets above (text
yes, frames no, media never), where the transcript is written, and a link to the setting
page. Then a permanent, quiet line in the panel footer naming the provider and model, so
it is never ambiguous which thread is talking to a vendor. The repo's own
`ai_set_video_understanding` / D-433 pattern is the precedent: opt-in, default off, gated
once, visible in Settings.

**Telemetry: none.** No Apelles-side logging of prompts, completions, costs or usage. The
numbers the panel shows come from the CLI's own `result` and `rate_limit_event` lines and
are not persisted beyond the conversation record on the user's disk.

---

## 7. Phases

Each phase is independently shippable and leaves the app better than it found it. Sizes
are rough, in the units this repo's roadmap uses.

**Phase 1 — detection and the honest empty state.** _Small (1 session)._
`chroma_agent_cli_probe` + `@apelles/bridge`'s `probeAgentCli` + a panel that renders every
state in §2.2 and no chat at all. The `agent_chat_status` MCP tool. Ships as a Settings
card plus a chrome-bar entry point. Done = each of the ten states reproduced by hand
(no CLI on `PATH`, a logged-out config dir, an old version pinned by the floor, the MCP
server stopped with `CHROMA_MCP_NO_SPAWN`) and each one showing its real remedy.
**Value on its own:** it replaces "paste this URL into your client and hope" with a page
that tells the user exactly what is wrong with their setup.

**Phase 2 — one turn, streamed, read-only.** _Medium (2–3 sessions)._
`chroma::agent_chat` spawns the child, the pure parser, the `ipc::Channel`, the thread UI
with streaming text and tool-call rows. Tools restricted to the **read-only** MCP surface
(`get_state`, `editor_get_*`, `motion_get_*`, `inspect_color`, …) plus
`Read`/`Glob`/`Grep`; no mutation at all. Stop via SIGINT. Done = "what is on my timeline
and where are the gaps" answered in the panel, with every tool call visible, plus the
parser's fixture tests and a deliberately-failed turn rendering its real error.

**Phase 3 — mutation, with the three tiers.** _Medium–large (3–4 sessions)._ Tier 1
auto-approved; the tier-2 registry and its test; `needs_confirmation` + the one-shot token
in `apelles-mcp` **and** `mcp/server.py` (the parity harness makes that one commit, not
two); the approval card; the activity-feed link; the session-scoped "don't ask again" for
render and export. Done = a real edit instruction carried out end to end, visible in the
feed, undone with Cmd+Z; an export approved from the card; an export denied; a turn
stopped mid-edit reporting what landed.

**Phase 4 — the conversation as a real thing.** _Medium (2 sessions)._ Multi-turn over one
process, queued turns while a turn runs, persisted conversations with `--session-id` /
`--resume` (re-passing every non-restored argument), reconnect after a webview reload,
the usage/quota footer from `rate_limit_event`, `--max-budget-usd` as a setting, the
image/frame opt-in setting (§6) and attachment of a frame or a selection as turn context.

**Phase 5 — Codex.** _Large (3–4 sessions, revised up by §1.3's findings)._ A provider
trait behind the same panel. **Against `codex app-server` over stdio, not `codex exec`** —
`exec` cannot surface an approval at all and reports a silently-no-op turn as a success.
So this phase is a JSON-RPC client, not a line parser: `initialize` → `thread/start` →
`turn/start`, the delta notifications, `turn/interrupt` and `turn/steer`, and the five
approval requests mapped onto the same card §3.3 already renders (its decision enum —
`accept` / `acceptForSession` / `acceptWithExecpolicyAmendment` / `decline` / `cancel` —
is close enough to our tiers to be a near-mechanical mapping). Bindings **generated from
the user's installed binary** (`codex app-server generate-json-schema`), never from the
docs or the SDK types, which still carry retired enum values. Detection via
`codex doctor --json` and `account/read`, with auth checked **before** the first turn
because an unauthenticated run grinds for ~40 s and then 401s. MCP via
`-c mcp_servers.apelles.*` + `enabled_tools`, which leaves the user's `config.toml`
untouched. Plus `--sandbox read-only` and `--skip-git-repo-check`, and its own fixture
corpus.

**Not in scope here, named so it is not assumed:** the BYOK/hosted chat (§10), background
operation without a window (00f), and anything that would make this chat a paid feature.

---

## 8. Human and AI parity

CLAUDE.md requires both interfaces in the same pass. The chat is *itself* the AI
interface to every existing tool, so parity here is about the chat's **own** surface:

- `agent_chat_status` — the probe result, the provider, the model, the tier-2 registry and
  the current conversation's state. Read-only. Phase 1.
- `agent_chat_send(text)` / `agent_chat_get_transcript(conversation_id?)` — so an external
  agent (or the UI harness) can drive and read the panel the way a human does. Phase 2–3.
- **Deliberately asymmetric, and recorded as such:** there is no MCP tool to *approve* a
  tier-2 call. An approval is the human's, by definition; a tool that let an agent approve
  its own export would dissolve the whole of §3. This is the same kind of chosen
  asymmetry `mcp-tool-coverage.md` records for `editor_scrub`, and it belongs in that doc
  next to it.

---

## 9. Open questions for the owner

1. **Vendor terms — this is a gate, not a detail.** Anthropic's own legal page says
   OAuth/subscription auth "is intended exclusively for purchasers of … subscription
   plans … to support ordinary use of Claude Code and other native Anthropic
   applications", that third-party developers "should use API key authentication", and
   that Anthropic "does not permit third-party developers to offer Claude.ai login into
   their own applications, or to route requests through Free, Pro, Max, or Ultra plan
   credentials on behalf of their users" — while also stating that this does not "prevent
   an end user from signing in to the unmodified Claude Code binary with their own Claude
   subscription, including where a platform hosts Claude Code", subject to "the Claude
   Code binary must not be modified" and "each end user must authenticate with their own …
   credentials" [verified:
   <https://code.claude.com/docs/en/legal-and-compliance.md>; the Agent SDK overview says
   the same about SDK-built products]. This design sits in the carve-out as far as it goes
   — the user's own unmodified binary, the user's own login, no credential ever touching
   Apelles — and no published text addresses a third-party GUI that spawns it. **Ask
   Anthropic in writing before building past phase 2**, and ask OpenAI the equivalent
   about ChatGPT-subscription Codex. Also note the branding rule: we may say Apelles "runs
   Claude Code" in plain text, but not use the name or logo as a product name.
   **OpenAI's is sharper and more specific**, and it is about exactly the surface phase 5
   would use: the app-server page states that **"App-server authentication has never been
   permitted for commercial or hosted services"**, while saying that "if you've built a
   local or open-source application using Codex app-server authentication, you can
   continue using it" and recommending migration to **Sign in with ChatGPT** (the
   sanctioned route, button label "Continue with ChatGPT", currently limited to selected
   commercial partners plus all open-source partners) [verified:
   <https://learn.chatgpt.com/docs/app-server>,
   <https://developers.openai.com/siwc/quickstart>]. An AGPL, local, open-source desktop
   app that spawns the user's own installed `codex` reads as permitted **as that sentence
   is written** — and the moment any part of Apelles becomes a hosted or commercial
   service, app-server auth is out and Sign in with ChatGPT (with approval) is the only
   path. That makes the terms question **load-bearing on D-438's Pro tier**, not just on
   this feature.
   *Recommendation:* get the written answer from both vendors, keep an API-key mode (which
   is unambiguously permitted) as the fallback the feature degrades to, and treat "the
   free tier runs on your own login, the paid tier never does" as a design constraint
   rather than a pricing choice.
2. **Claude Code only for v0.4.0, or both CLIs?** This pass **changed its own
   recommendation here.** Codex's app-server is in several respects the *better* host
   surface (token-level deltas, typed approval requests with a pre-parsed human-readable
   action, a real steer, 19 typed item types), but it is a JSON-RPC client to write rather
   than a line parser, parts of it are experimental, its schema drifts between versions,
   and its terms sentence is the more specific of the two. *Recommendation unchanged in
   conclusion, strengthened in reasoning:* ship Claude Code first, Codex as phase 5 — but
   budget phase 5 as large, not medium.
3. **Does the agent get to see the picture?** §6's frame question. It costs nothing
   technically and changes the disclosure materially. *Recommendation:* ship with frames
   off and the agent grading by the numbers; add the opt-in in phase 4.
4. **Is "no Bash, ever" right?** §3.3 removes the CLI's shell and web tools entirely. It
   is the safe default and it closes off "ffmpeg this for me". *Recommendation:* yes, keep
   it closed; add capabilities as real MCP tools instead.
5. **Who ships the skills?** Bundling `.claude/skills/` as a plugin makes them a product
   asset with a product asset's maintenance burden. *Recommendation:* yes, bundle them —
   they are most of the quality difference — and add them to the docs discipline.
6. **Where does the panel live?** §5's recommendation is a shell-level right-hand panel,
   because an instruction can span all three tabs. The alternative is per-tab. The
   activity feed already made this call once (D-298, shell-level).
7. **How much does an interrupted turn owe the user?** §3.4 chooses "report what landed,
   do not auto-revert". A named timeline snapshot before each turn would make it a true
   checkpoint — that is roadmap 00f's "named snapshots agents can create", and **all four
   reference products have one** (§5.2 conventions 9 and 14), which is the strongest
   single signal from the research pass that we are missing something. Is it worth pulling
   forward? *Recommendation:* yes, for phase 3 or 4, with Cursor's semantics (restore the
   files, keep the conversation).
8. **Does this stay free?** D-438 puts BYOK/your-own-login chat in the free tier forever.
   This feature costs us no inference, so the recommendation is yes — but it is the
   strongest single reason to install Apelles, and that is a positioning call, not an
   engineering one.

---

## 10. How this relates to the BYOK / hosted chat (D-438, cloud-agent-architecture §3)

Two front doors, one contract, in a deliberate order.

`docs/notes/cloud-agent-architecture.md` §3 and `docs/notes/monetization-plan.md` scope an
agent loop **inside** Apelles: our own tool-calling loop against the user's API key or a
hosted model. That design is right and nothing here contradicts it — both reach the app
only through the MCP/control contract, and §3's own rule is "don't build a second action
API."

The CLI-driven panel is first because it is strictly cheaper: no agent loop of our own to
write and keep correct, no provider-schema translation, no key handling, no Keychain, no
backend, no inference cost, and the user's harness (skills, subagents, compaction,
permissions) comes for free. Its limits are equally clear: it needs a CLI installed, it
depends on the vendor's terms (open question 1), and we do not control the loop.

The BYOK loop answers exactly those limits, for the user who has no CLI and for the Pro
tier that sells a hosted model. **Both plug into the same panel.** §7 phase 5's provider
trait is the seam that makes "Claude Code", "Codex" and "your own key / a hosted model"
three implementations behind one UI — which is why the panel, the thread model, the tier
registry and the approval card are designed here as provider-agnostic, and why none of
this work is thrown away when D-438's chat arrives.
