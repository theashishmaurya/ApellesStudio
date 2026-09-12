# The AI-env bootstrap (D-315)

How Apelles builds the 1.6 GB Python environment its two AI sidecars need, on a
machine that may have no Python at all, without putting any of it in the installer.

Phase 4 of `docs/notes/sidecar-lifecycle.md`, for the *environment* half. Code:
`crates/apelles-ai/src/ai_env.rs` (state machine, all logic, all tests) +
`app/src-tauri/src/chroma/ai_env.rs` (Tauri commands, event, path resolution) +
`app/src-tauri/build.rs` (fetches and stages the `uv` binary).

---

## The shape of the problem

D-314 got both sidecars onto one shared venv, `ai-env/.venv`, built from a committed
lock file by `ai-env/setup.sh` — and left the venv **1.6 GB** and the install a manual
step that assumes a system Python. Neither is acceptable in a shipped app:

- **A human running `setup.sh` is not a thing an end user does.** It is not even
  reachable from a `.app` bundle, which has no workspace next to it.
- **Bundling the venv into the installer is not the fix.** A ~2 GB download is the
  problem D-314 just spent 1.7 GB reducing; re-inflating it in the installer trades the
  disk saving away and gets nothing for it.
- **"First-run bootstrap that shells out to `python3 -m venv`" does not work.** A clean
  macOS install has no `python3` that is usable for this, and on a machine that *does*,
  we would be silently at the mercy of whichever interpreter answers — the exact failure
  D-314 already caught once in `resolve_shared_python`, where canonicalising a venv
  symlink yielded the system Python and a working-looking sidecar on unpinned packages.

So: keep the installer small, and ship a Python **toolchain** rather than a Python
environment.

## The design

Bundle [`uv`](https://github.com/astral-sh/uv) — one static binary — and let it do all
three jobs on first launch:

```
uv python install 3.11.15          fetch a self-contained python-build-standalone CPython
uv venv --python 3.11.15 <root>/.venv
uv pip install --python <venv>/bin/python -r requirements.lock.txt
```

`UV_PYTHON_PREFERENCE=only-managed` is set on every invocation and is what makes the
first step a guarantee rather than a hope: without it, `--python 3.11.15` happily
matches a system interpreter that merely reports that version. With it, the venv's
`sys.base_prefix` is always under uv's own managed-Python directory. There is a test
that asserts exactly this (`uv_builds_a_venv_on_a_self_contained_interpreter_not_the_system_one`),
because it is the single assumption the whole "works with zero Python installed" claim
rests on.

### When it runs

At **app launch**, on its own thread, next to the three sidecar supervisors in
`lib.rs` `.setup()` — not on the first AI-feature click. The environment is usually
already built by the time anyone reaches for a mask or a transcript, and if it is not,
the UI says so specifically (below) rather than failing with a connection error.

It never blocks startup or any non-AI feature. Edit, Motion, Colorist, grading, export
all work throughout, including when the bootstrap has failed permanently.

### Where things live

The dev checkout and a signed bundle differ, and they have to:

| | dev checkout | packaged `.app` |
|---|---|---|
| `requirements.lock.txt`, `verify.py` | `<workspace>/ai-env/` | `Contents/Resources/resources/ai-env/` |
| `.venv` | `<workspace>/ai-env/.venv` | `<app data>/ai-env/.venv` |
| `uv` | `target/<profile>/uv` | `Contents/MacOS/uv` |

The lock file and the venv are allowed to be in different places because a `.app`
bundle is **code-signed** — writing 1.6 GB into it would invalidate the signature. In a
dev checkout they stay together deliberately, so the app and a hand-run
`ai-env/setup.sh` build and share exactly one environment, which is what D-314 set up.

Which of the two layouts is used is decided by **`tauri::is_dev()`**, not by "does the
workspace directory exist". That distinction matters: the dev fallback keys off
`CARGO_MANIFEST_DIR`, a **build-machine** path baked in at compile time, and on the
machine that built the release that path still exists. An existence check would therefore
have let a packaged `.app` adopt the developer's workspace, write a venv into their
checkout, and take a code path no end user ever takes — the class of bug where the
developer's own build is the only one that behaves differently, and so the only one
nobody catches.

`uv` is found by the same rule as every other bundled binary (D-313's `resolve_bin`):
beside our own executable first, which is `target/<profile>/` in a dev run and the
bundle's binary directory in a packaged one. One rule, both cases.

## The state machine

`Phase`, serialized `camelCase`, is what the Settings card, every AI-feature entry
point and the `ai_env_status` MCP tool all branch on:

```
unknown ──► checking ──► ready                     (the common path, every launch after the first)
                │
                └──► installingPython ──► creatingVenv ──► installingPackages ──► checking
                                                                                     │
                                              ┌──────────────────────────────────────┤
                                              ▼                                      ▼
                                          repairing ──► (wipe + rebuild) ──► ready  ready
                                              │
                                              ▼
                                           failed ──(backoff 5s→15→45→2m→5m→15m)──► checking
```

Two terminal-ish states that a UI must not confuse:

- **`failed`** — an attempt failed and another is scheduled. Carries `retryInSecs`.
  Almost always "no internet".
- **`unavailable`** — cannot be attempted at all (no bundled `uv`, no lock file, or
  `CHROMA_AI_ENV_NO_BOOTSTRAP` is set). **Not** retried on a timer, because nothing
  about waiting would change it, and a UI promising an automatic retry there would be
  lying. It is also the one phase `retry_now()` refuses (B-180): `supervise` has
  *returned* by then, so there is no thread left to wake and a manual "Retry now" would
  be the same lie told by hand. Note that is the opposite call from `ready`, which
  `retry_now()` deliberately *accepts* as a re-verify — the two are opposite for opposite
  reasons: `ready` is a cached answer worth invalidating, `unavailable` is a standing
  fact about the machine with nothing listening for the request.

`Phase::is_working()` is the single predicate that decides whether a surface says
"still setting up, hang on" or "this is broken, here is a retry".

## Retry, resume, heal — what was actually verified

These are the three failure modes the design is required to survive, and each was
measured on a real run (`uv` 0.12.13, the real 90-package lock, this machine) rather
than assumed.

### 1. Retry — transient network failure

Capped backoff `5s → 15 → 45 → 2m → 5m → 15m`, holding at 15 minutes. Deliberately much
slower than the sidecar supervisor's `2s → 30s` ladder: a sidecar that will not start is
usually a code problem a fast retry surfaces, whereas the overwhelmingly likely reason
*this* fails is no internet, and hammering a download that cannot succeed helps nobody.
A "Retry now" button and the `ai_env_retry` MCP tool both interrupt the backoff
immediately (a `Condvar`, not a polling sleep, so it is instant even 15 minutes deep).

### 2. Resume — re-running the same command *is* the resume

**Verified, not assumed.** A cold `uv pip install -r requirements.lock.txt` was
`SIGKILL`ed 45 seconds in. At that point:

- uv's global cache held **1.6 GB** of already-downloaded wheels
- the venv's `site-packages` had only **3** packages actually unpacked

Re-running the **identical command** completed in **25 seconds**, `rc=0`, and all nine
key imports then loaded. So uv's wheel cache is the resume mechanism, at package
granularity, for free — there is nothing for Apelles to implement, and deliberately
nothing implemented. Re-running is the recovery.

A third, fully-satisfied run took **1 second** (`Resolved 91 packages in 315ms, Checked
91 packages in 2ms`), which is what makes the launch-time `checking` phase cheap enough
to run unconditionally on every start.

### 3. Heal — a torn venv

A process killed mid-install leaves an interpreter that starts perfectly over a
`site-packages` that is missing things. Every cheap check ("does `.venv/bin/python`
exist") passes on that. So the health check **actually imports** what each sidecar
needs, through the venv's own interpreter, by running `ai-env/verify.py`:

- `ai/` — `torch`, `ultralytics`, `cv2`, `scipy`, `utils3d_moge`, and ViTMatte
  (`from transformers import VitMatteForImageMatting`, not a bare `import transformers`
  — D-314 turned on exactly that class surviving into `transformers` 5.x)
- `ai-media/` — `mlx`, `mlx_vlm`, `mlx_whisper`

`verify.py` is the **same file** `ai-env/setup.sh` runs at the end of a human install.
That is the point: a Rust-side copy of the module list would drift from the bash-side
one, and drift here means the app reporting `ready` for an environment a sidecar then
dies importing from.

**A verdict is required before anything is destroyed (B-179).** `health()` distinguishes
*"`verify.py` ran and said `torch` will not import"* from *"`verify.py` never returned a
verdict"* — killed by a signal, or exited without the JSON it always writes when it really
runs. Only the first can trigger the wipe. The second fails the attempt and lets the
ordinary backoff re-ask the question, destroying nothing.

That distinction is not hypothetical: D-315's own end-to-end run killed processes by a
path pattern that also matched `verify.py` running through the venv, and the first version
of this code responded by deleting a complete, working, fully-verified 1.6 GB environment
and rebuilding it. The log line could not even say why — the verifier had been killed
before it could write a reason, and that empty reason was exactly the signal being thrown
away. A check whose failure path is destructive has to tell "the answer was no" apart from
"I could not ask".

Healing is **staged**, because the two repairs cost very different amounts:

1. Re-install over the top. On a torn venv this is the 25-second cache-backed path and
   it fixes the common case.
2. Only if it *still* does not verify: wipe `.venv` and rebuild from scratch.

`uv venv` needs `--clear` to replace an existing environment (`error: A virtual
environment already exists at ...`, exit 2). Without it a torn venv could never be
rebuilt and the bootstrap would retry the same failing command forever. This was a real
bug in the first draft, caught by
`a_damaged_environment_is_healed_rather_than_reported_ready` — which is precisely why
that test drives a real `uv` instead of a mock.

## Stalls

`uv` is killed if it produces **no output at all for 15 minutes** (`UV_STALL_TIMEOUT`).

Deliberately a stall timeout and not a cap on total runtime: the honest worst case is a
multi-gigabyte download on a bad connection, which can legitimately run a very long time
but emits a line every few seconds while it does. A total-runtime cap would kill a
slow-but-working install and convert it into an infinite retry loop; a silence timeout
only catches what is genuinely stuck, such as a dead TCP connection that never times out.

This also dictated the shape of `run_uv`. The obvious implementation — drain the child's
output to EOF, then wait for it — cannot ever fire the timeout, because draining blocks
until the child closes its pipes, which a wedged child never does. So the loop polls the
output channel with a short timeout and checks for exit and for a stall in between,
then drains whatever is still queued once the child is gone (the last lines before exit
include the `Installed N packages` that snaps progress to its total).

## Progress reporting

`packagesDone` / `packagesTotal` are parsed from uv's own output, whose real format is:

```
Resolved 91 packages in 4.36s
Downloading torch (121.4MiB)
 Downloaded torch
Prepared 91 packages in 1m 12s
Installed 91 packages in 402ms
```

Total from `Resolved`; progress from counting `Downloaded` lines; `Prepared`/`Installed`
snap the count to its true value at the end, because **a package already in the wheel
cache is never announced as downloaded** — on a fast re-run that is all of them, and a
`Downloaded`-only count would leave the bar stuck near zero on a run that is actually
finishing. The parser is unit-tested against that block of output transcribed verbatim
from a genuine run.

## The GUI surface

The contract above is what an agent sees. What a *person* sees is a Settings card and,
at every control that depends on the environment, a line saying it is still being built
and how far it has got. All of it reads one store.

**It complements `explain_unreachable`; it does not duplicate it.** That function is
reactive by design (see above) — it decorates a call that already failed. It therefore
cannot do the one thing this section exists for: put the state on screen *before* anyone
clicks. Equally, this half deliberately does **not** refuse anything, for exactly the
reason the reactive design was chosen — a sidecar someone started by hand, or a
`CHROMA_SIDECAR_PYTHON` override, answers perfectly well while the bootstrap reports
`installingPackages`, and a pre-flight gate would break those setups. Every control here
stays enabled. The rule is: *say what is happening, refuse nothing, and let the call site
explain a real failure.*

### One store, `@apelles/bridge`'s `aiEnv.ts`

`packages/bridge/src/aiEnv.ts` holds the whole frontend view: the `AiEnvStatus` type, a
zustand store, the `useAiEnv()` hook, and the pure functions that turn a status into
words (`aiEnvHeadline`, `aiEnvNotice`, `aiEnvProgressLabel`, `aiEnvWarning`,
`aiEnvIsBuilding`).

Why `@apelles/bridge` and not `app/src/hooks/`: the consumers are split across the
layer boundary. Masking, relight and Settings live in `app/src`; captions live in
`packages/editor`, which cannot import from `app/` (D-039's one-way rule). `bridge` —
the frontend↔backend seam — is the one layer both can read.

Why a store rather than the `invoke` + `listen` pair written out four times: **Tauri
events are not buffered** (`chroma/control.rs`'s module doc), so every consumer has to
read `chroma_ai_env_status` once on mount *and* subscribe to `ai-env-status`. Written
once, reference-counted, torn down with `safeUnlisten` when the last consumer unmounts.
(`safeUnlisten` itself moved into `bridge` in the same pass — B-032/B-034/D-112's fix had
already been hand-copied into two packages because `app/src/utils` is above them in the
layer order.)

It also **polls at 1 Hz**, but only while somebody is watching and only while the phase
is still moving. Two fields change with no event to announce them: `elapsedSecs` is
written by the supervisor's own 250 ms ticker *under the lock* without a notify, and
`retryInSecs` is written once when an attempt fails and never decremented. So a
purely event-driven card would show a frozen "0s so far" through a five-minute download
and a countdown stuck at 45. The tick re-reads the snapshot during a working phase (a
mutex read on the Rust side) and counts the retry down locally while `failed`; it does
nothing at all once the phase is `ready`, `unavailable` or `unknown`.

### The Settings card

`AiEnvStatusCard` in `app/src/components/panel/SettingsPanel.tsx`, directly after the
two `SidecarStatusCard`s and sharing their shell and colour precedent (green healthy /
amber in-flight-or-degraded / red down). A sibling component rather than a third entry
in `SIDECAR_CARDS` because the shapes genuinely differ: a sidecar is up or down, this is
a one-time build with phases, a package count, a retry schedule and two distinct
not-working states. It shows the headline, the backend's own `detail` sentence, a
progress bar and "142 of 163 packages · 3m 04s so far" during `installingPackages`,
`lastError` plus a live countdown plus **Retry now** on `failed`, a **Re-check** button
on `ready` (the GUI face of `retry_now`'s "a cached answer needs an invalidation"), and
the venv path throughout. `unavailable` gets the manual route (`./ai-env/setup.sh`) and
**no** button, because `retry_now` declines there (B-174) and offering one would lie.

### What each phase looks like

| phase | AI controls | what the user sees |
|---|---|---|
| `checking` … `repairing` | enabled | an inline line at the control: "Track subject needs the AI environment, which is still setting up — 47 of 91 packages…" |
| `failed` | enabled | the same line, naming the failure and pointing at Settings' Retry now |
| `unavailable` | enabled | a tooltip only: automatic setup is off here, so AI works only if the venv was built by hand |
| `ready`, `unknown` | enabled | nothing |

`unknown` says nothing on purpose: it only means the supervisor thread has not reported
yet, which is true for the first milliseconds of every launch, and a "setting up" flash
in front of every AI control at startup would be noise.

### Every surface

| surface | controls |
|---|---|
| `app/src/components/panel/right/MasksPanel.tsx` | Track subject, Finalize matte, Track depth — notice inline under the buttons, and in their `title` |
| `app/src/components/chroma/RelightPanel.tsx` | Bake Normals (initial and re-bake) and Track Depth (full video) — notice in the tooltip and in the existing status line |
| `packages/editor/src/CaptionsFromTranscriptButton.tsx` | Captions from Transcript — notice inline beside the button |

**Deliberately carrying no notice:** Bake Depth. It is the in-process ONNX
Depth-Anything-V2 path, needs no Python at all, and RelightPanel's auto-fire effect
depends on it to stop a positional light rendering as a silent no-op. Nothing outside the
sidecars is touched: Edit, Motion, Colorist, grading and export are unaffected throughout.

**Tested where it can regress.** `packages/bridge/src/aiEnv.test.ts` pins the phase rules
and the wording, including a check that no message ever calls a feature blocked, refused
or disabled. `packages/editor/src/CaptionsFromTranscriptButton.dom.test.tsx` asserts the
same thing against the real rendered component: mid-build it shows "47 of 91 packages",
the button stays `disabled === false`, a cached transcript still generates captions, and
`unknown` renders no notice at all. "Advisory, never disabling" is one `disabled={…}` away
from being silently undone, which is why it is a test and not a comment.

## Measured timings and sizes

Real numbers from this machine (M-series, ~200 Mbit), `uv` 0.12.13:

| step | cold | warm cache |
|---|---|---|
| `uv python install 3.11.15` | **12.4 s** (19.1 MiB download) | < 1 s |
| `uv venv` | < 1 s | < 1 s |
| `uv pip install -r requirements.lock.txt` (90 pkgs) | several minutes, dominated by ~1.6 GB of wheels | **25 s** after a kill; **1 s** fully satisfied |
| resulting `.venv` | **1.6 GB** | — |

The `uv` binary itself is **36,449,104 bytes (34.8 MiB)** — notably larger than uv's
reputation for "~15 MB", worth knowing since it is paid in the installer.

## The agent-facing surface: two tools, and one distinguishable failure

`CLAUDE.md`: every feature is built for a human AND an AI. The human half is the
Settings card and the per-feature "still setting up" state. This is the other half.

### `ai_env_status` / `ai_env_retry`

Two MCP tools, in both servers — `mcp/server.py` and
`crates/apelles-mcp/src/tools/ai_env.rs`, byte-identical descriptions, gated by D-312's
parity harness.
`ai_env_status` returns the [`AiEnvStatus`](#the-state-machine) snapshot above verbatim;
`ai_env_retry` returns the same snapshot plus `started` — `false` when there was nothing
to trigger, which is a normal answer and not a failure.

**They are answered by `control.rs` in Rust, natively — no frontend round trip.** That
is the D-210 `native_op` path, and these are its first *shipped* members (the two debug
ops there stay `#[cfg(debug_assertions)]`). The bar for joining that list is unchanged:
*the answer is a fact about this process, not about the store.* The bootstrap qualifies
twice over —

- there is no store copy of the phase to consult, so forwarding would only be a longer
  route to the same `apelles_ai::ai_env::status_snapshot()` call, and
- the moment the answer is most wanted is *during* startup, which is exactly when a
  forwarded op cannot be answered at all (B-071's `BridgeErr::NotReady`). A status tool
  that goes dark precisely while the thing it reports on is running would be useless.

The two ops therefore need **no frontend op-registry entry**, in either registry.

### The "still bootstrapping" contract

Before D-315, calling `add_subject_mask`, `track_subject`, `depth_track`,
`editor_get_transcript` or `editor_analyze_video` on a machine whose environment was
still being built produced a bare connection error. An agent could not tell three very
different situations apart — *wait, this will work in a minute*; *the sidecar crashed*;
*your arguments were wrong* — and the advice for each is opposite.

The fix has two halves.

**1. A stable machine token.** `apelles_ai::ai_env::NOT_READY_CODE` — the literal string
`ai_env_not_ready` — begins every such message, followed by the phase, the package
counts, the attempt number and the elapsed seconds, and then the caller's own underlying
error verbatim:

```
ai_env_not_ready: the shared Python environment both AI sidecars run from is not ready
— phase 'installingPackages', installing packages (47 of 91) (attempt 1, 63s elapsed).
This is the one-time environment build (D-315), not a crash and not a bad request. Call
`ai_env_status` for the live state, or `ai_env_retry` to force an attempt now.
Underlying error: Apelles AI sidecar unreachable (…)
```

It is a **normal `{ok: false, error}` envelope**, never an exception — the precedent
`control.rs`'s 503/504 and `apelles-mcp`'s `OpError` both set deliberately, because
raising is what once reduced a real explanation to a bare "Error executing tool `<name>`"
(B-153). `ai_env_status` is the structured read that goes with the token, which is why
the message names it.

**2. It is generated app-side, at the sidecar boundary — `ai_env::explain_unreachable`.**
Every place the app fails to reach a Python sidecar routes its own diagnosis through that
one function, which *prepends* the not-ready explanation when the environment is not
`ready` and returns the diagnosis untouched when it is.

Why there and nowhere else:

| candidate | why not |
|---|---|
| each MCP tool | two servers to keep in sync, and the GUI would still get the old bare error |
| `control.rs`, keyed on op name | breaks that server's "knows no op list" boundary (D-020) — *and it would be wrong*: `add_subject_mask` on a **still image** runs ONNX SAM in-process and needs no Python at all, so an op-name gate would refuse a call that works fine |
| each frontend op handler | five handlers across two registries, duplicated, and every future AI feature has to remember |
| **the sidecar call site (chosen)** | fires exactly when a Python sidecar was genuinely needed and genuinely missing; one place; every AI feature, GUI click or MCP call, present or future, gets it with no further work |

The check is **reactive, not pre-emptive** — it decorates a connection that actually
failed rather than refusing up front. That is deliberate: a sidecar started by hand, an
external one on the port, or a `CHROMA_SIDECAR_PYTHON` override all keep working
regardless of what the bootstrap thinks, and a pre-flight gate would break them. On
loopback a refused connection is immediate, so nothing is paid for the ordering.

### Three defects this surfaced

- **B-180** — `retry_now()` returned `true` for `Phase::Unavailable`, but `supervise`
  has already *returned* by then, so there was no thread left to wake. It now returns
  `false`, matching what this note already said about `unavailable`: nothing about
  trying again changes the answer, and that has to hold for the manual retry too.
- **B-175** — `handleGenerateAiMask` / `handleTrackSubject` swallowed a failed AI call
  into a `toast.error`, so `add_subject_mask` and `track_subject` reported `ok: true`
  for work that never happened. Both now return `{ error }` the way `handleTrackDepth`
  already did, and their op handlers propagate it — without which neither of those two
  tools could surface the message above at all.
- **B-177** — `build.rs` staged `requirements.lock.txt` / `verify.py` into
  `resources/ai-env/` with an unconditional `fs::copy`, which bumps the mtime even when
  the bytes match. `tauri dev` watches `src-tauri/`, so staging the resource invalidated
  the build that staged it and `npm run tauri:dev` rebuild-looped forever in any checkout
  where those files were not already current. It now writes only on a real difference —
  the same "already valid, skip it" shape the ONNX and `uv` downloads in that file use.

## Configuration

| env var | what |
|---|---|
| `CHROMA_AI_ENV_NO_BOOTSTRAP` | don't bootstrap at all; reports `unavailable`. For devs who run `ai-env/setup.sh` themselves |
| `CHROMA_UV_BIN` | use a specific `uv` instead of the bundled one |
| `UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR` | uv's own, passed through — redirect the managed interpreters / wheel cache |

`CHROMA_SIDECAR_PYTHON` (D-314) still overrides the interpreter for both sidecars and
takes precedence over anything built here — the bootstrap creates the venv, it does not
change the ladder that chooses one.

## What this deliberately does NOT do

- **Download models.** Unchanged: they pull from the HF cache on first `/segment`,
  `/transcribe`, etc. Not in the installer, not in this bootstrap.
- **Install ffmpeg.** A hard `ai-media/` requirement, not pip-installable, and not
  something this can fix. Still a real gap for a packaged app — see
  `docs/notes/sidecar-lifecycle.md`.
- **Ship the sidecar *source*.** `ai/server.py` and `ai-media/server.py` are still
  resolved from a dev-layout path. This note covers the *environment* half of Phase 4;
  the code half is still open and is tracked in `sidecar-lifecycle.md`.
- **Verify versions against the lock.** The health check asks "can both sidecars
  import what they need", not "is every pin exact". `uv pip install -r <lock>` is what
  makes the versions right; re-checking them on every launch would cost more than it
  is worth.
