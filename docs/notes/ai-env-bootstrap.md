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
  lying.

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
