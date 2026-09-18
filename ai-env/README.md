# `ai-env/` — the one Python environment both AI sidecars run from (D-314)

**What it is:** the shared virtual environment for Apelles' two Python sidecars,
`ai/` and `ai-media/`, plus the compiled lock file that pins it.

**What it is NOT:** a sidecar. There is no `server.py` here and nothing in this
directory is ever launched. `ai/` and `ai-media/` are still **two separate
processes** on two separate ports, supervised independently — D-189's
process-isolation reasoning (crash isolation) and D-084's independent idle-unload
are untouched by D-314. All that changed is that the two processes now share one
interpreter and one `site-packages` instead of duplicating ~1.1 GB of identical
PyTorch/OpenCV/NumPy/SciPy wheels across two venvs.

```
ai-env/
  requirements.lock.txt   ← the compiled union: every package, exactly pinned
  setup.sh                ← create/repair .venv from the lock  (or --relock)
  verify.py               ← "is this environment usable?" — shared with the app
  python.sh               ← which interpreter a sidecar should run from
  .venv/                  ← the shared environment (gitignored)
```

## Using it

**Usually: nothing.** Since **D-315** the app builds this environment itself, in the
background, starting at launch — using a bundled `uv` that fetches its own
self-contained CPython, so it works even on a machine with no Python. Open Apelles and
watch the "AI Environment" card in Settings. See `docs/notes/ai-env-bootstrap.md`.

To build it by hand anyway (a headless checkout, or you would rather not wait):

```sh
./ai-env/setup.sh          # create or repair .venv from requirements.lock.txt
```

**One model is never fetched by either route (B-172/D-354).**
`ai-media/video_understand.py`'s VLM subprocess runs `HF_HUB_OFFLINE=1`
unconditionally — correct per this repo's local-first rule, but it means
nothing ever populates the HF cache for it either. Run this once, with network
access, before the first `/understand_video` call on a fresh machine:

```sh
./ai-env/setup.sh --fetch-models   # one-time ~2.9 GB download, network on for
                                    # this step only; every real call after
                                    # this stays fully offline
```

Skipping it is not silently dangerous: `/understand_video` fails fast with a
message naming this exact command, rather than an opaque subprocess dump.

Both routes produce the same `.venv` in the same place from the same lock file, and
both finish by running the same `verify.py`, so they cannot disagree about whether the
environment is usable. `CHROMA_AI_ENV_NO_BOOTSTRAP=1` tells the app not to build it. The app finds `ai-env/.venv`
on its own (`apelles_ai::sidecar`'s interpreter ladder — see
`docs/notes/sidecar-lifecycle.md`), so both sidecars start against it with no
env vars set.

## Where the dependencies are declared

Three files, and the split is deliberate:

| file | role | edited by |
|---|---|---|
| `ai/requirements.txt` | what the `ai/` sidecar directly needs | a human |
| `ai-media/requirements.txt` | what the `ai-media/` sidecar directly needs | a human |
| `ai-env/requirements.lock.txt` | the resolved union, full transitive closure | `setup.sh --relock` |

The two sidecar files stay the human-edited source of truth — they record which
sidecar actually needs what, which is the fact you want when a dependency has to
change (and the fact a future packaging pass will need). The lock file is
generated: it is what gets installed, and it is the thing that makes the
environment reproducible.

This is the ordinary pip `requirements.in` → compiled-`requirements.txt` split,
with the two sidecar files playing the `.in` role. There is deliberately **no**
third hand-written "shared base" file: the packages the two sidecars share are
overwhelmingly *transitive* (torch, opencv, numpy, scipy, sympy, tokenizers,
huggingface-hub), so a hand-maintained shared-direct-deps file would have held
about three entries and invented a split that does not match reality.

## Exact pins are the point, not pedantry

Every version in every one of those three files is `==`, never `>=`. That is a
guard against a specific failure this stack has already hit once: a prototype had
`mlx-vlm` silently upgrade `transformers` / `tokenizers` / `numpy` / `mlx-metal`
out from under `mlx-audiocraft` in a shared venv (see `ai-media/requirements.txt`
for the original note). Ranges are how that broke. A float here has a real
downside and no upside — nothing in this repo benefits from picking up a new
torch on a random Tuesday.

The same discipline is why D-314 is safe to make at all: the two-venv split
existed because `ai/` pinned `transformers>=4.40,<5` defensively for ViTMatte,
and that pin was never re-tested after it was set. It no longer held.

## Changing a dependency

1. Edit `ai/requirements.txt` or `ai-media/requirements.txt` — the exact pin.
2. `./ai-env/setup.sh --relock` — re-resolves both files together into a fresh
   venv and rewrites `requirements.lock.txt`.
3. Run the real verification, do not assume: both sidecars' full import graphs,
   and the capability that dependency actually serves. D-314's own verification
   run is the worked example of what "real" means here.
4. Commit the lock file with the change.

Resolving both sidecar files in **one** pip invocation is required, not a
convenience — that is what makes pip reconcile the two sidecars' constraints
against each other instead of letting the second install silently move what the
first one pinned.

## Per-sidecar venvs still work

`apelles_ai::sidecar` checks `<sidecar dir>/.venv` *before* `ai-env/.venv`, so a
deliberate `ai/.venv` still wins for that one sidecar. That is there for
debugging one sidecar against a different dependency set, and it means the D-314
change breaks no existing checkout — an install with the old two venvs keeps
working exactly as before, it just gets none of the disk saving until those are
removed. The app logs which interpreter it picked and why, and warns when a
per-sidecar venv is shadowing this shared one.
